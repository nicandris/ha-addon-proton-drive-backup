/**
 * HTTP layer for the Proton Drive bridge.
 *
 * Provides two things:
 *   1. `HttpClient` — implements the SDK's `ProtonDriveHTTPClient` interface
 *      (`fetchJson` / `fetchBlob`) and adds Proton auth headers + 401 refresh.
 *      It also exposes `authGet` / `authPost` helpers for the core auth API,
 *      which the SDK does not cover (login, key salts, addresses, 2FA).
 *   2. `srpAuth` — the SRP login flow, using @protontech/crypto's SRP.
 */

import { getSrp, getAuthVersionWithFallback } from '@protontech/crypto/srp';

// Proton's account/auth + core API host. Note `api.proton.me` does NOT exist
// (NXDOMAIN); the real hosts follow the `<service>-api.proton.me` pattern, the
// same as the SDK's `drive-api.proton.me`.
const AUTH_API = 'https://account-api.proton.me';
const DRIVE_HOST = 'drive-api.proton.me';

// Identify this build honestly per the SDK's third-party guidelines: the name
// is THIS third-party project, not "home_assistant" — we must not present the
// request as coming from the Home Assistant project (or from Proton). The
// version is injected from package.json at build time (see build.mjs) so it
// always matches the actual build; the fallback is only for unbundled dev runs.
export const APP_VERSION =
    typeof __APP_VERSION__ !== 'undefined'
        ? __APP_VERSION__
        : 'external-drive-ha_addon_proton_drive_backup@0.0.0-dev';

// Honest, non-spoofing User-Agent. Some WAFs reject requests without one.
const USER_AGENT = 'ha-addon-proton-drive-backup/0.1.x (+https://github.com/nicandris/ha-addon-proton-drive-backup)';

const JSON_HEADERS = {
    'Content-Type': 'application/json',
    'x-pm-appversion': APP_VERSION,
    'User-Agent': USER_AGENT,
};

// Build a readable description of a non-OK Proton API response: which endpoint,
// the human message, Proton's Code, the HTTP status, and any Details (e.g. a
// human-verification challenge), so failures can be diagnosed from the log/UI.
function formatProtonError(path, json, status) {
    let msg = json.Error || `${path} failed`;
    msg += ` [${path} Code=${json.Code} HTTP=${status}]`;
    if (json.Details && Object.keys(json.Details).length) {
        msg += ` Details=${JSON.stringify(json.Details)}`;
    }
    return msg;
}

function authError(message) {
    return Object.assign(new Error(message), { code: 'AUTH_ERROR' });
}

export class HttpClient {
    constructor(session, onRefresh = null, onSessionExpired = null) {
        // session: { uid, accessToken, refreshToken }
        this.session = session;
        this.onRefresh = onRefresh;
        this.onSessionExpired = onSessionExpired;
    }

    updateSession(patch) {
        this.session = { ...this.session, ...patch };
    }

    // ── SDK ProtonDriveHTTPClient interface ─────────────────────────────────

    async fetchJson(request) {
        return this._fetch(request, true);
    }

    async fetchBlob(request) {
        return this._fetch(request, false);
    }

    async _fetch(request, isJson) {
        const url = request.url.startsWith('http') ? request.url : `https://${request.url}`;
        const headers = new Headers(request.headers || {});
        headers.set('x-pm-appversion', APP_VERSION);
        headers.set('User-Agent', USER_AGENT);

        const isDriveApi = url.includes(DRIVE_HOST);
        if (isDriveApi) {
            headers.set('x-pm-uid', this.session.uid);
            headers.set('Authorization', `Bearer ${this.session.accessToken}`);
        }

        let body = request.body;
        if (isJson && request.json !== undefined) {
            headers.set('Content-Type', 'application/json');
            body = JSON.stringify(request.json);
        }

        const send = () =>
            fetch(url, { method: request.method, headers, body, signal: request.signal });

        console.debug(`[httpClient] Drive API ${request.method} ${url.replace(/^https:\/\/[^/]+/, '')}`);
        let response = await send();
        if (response.status === 401 && isDriveApi && this.session.refreshToken) {
            console.debug('[httpClient] Drive API 401, refreshing token...');
            await this._refresh();
            headers.set('Authorization', `Bearer ${this.session.accessToken}`);
            response = await send();
        }
        console.debug(`[httpClient] Drive API response: HTTP ${response.status}`);
        return response;
    }

    async _refresh() {
        const shortUid = this.session.uid?.slice(0, 8) ?? '?';
        console.debug(`[httpClient] Refreshing access token (uid prefix: ${shortUid})`);
        const resp = await fetch(`${AUTH_API}/core/v4/auth/refresh`, {
            method: 'POST',
            headers: { 'x-pm-uid': this.session.uid, ...JSON_HEADERS },
            body: JSON.stringify({
                ResponseType: 'token',
                GrantType: 'refresh_token',
                RefreshToken: this.session.refreshToken,
                RedirectURI: 'https://proton.me',
            }),
            signal: AbortSignal.timeout(30_000),
        });
        if (!resp.ok) {
            console.debug(`[httpClient] Token refresh failed: HTTP ${resp.status}`);
            this.onSessionExpired?.();
            throw authError('Session expired');
        }
        const data = await resp.json();
        this.updateSession({ accessToken: data.AccessToken, refreshToken: data.RefreshToken });
        console.debug('[httpClient] Token refreshed successfully');
        if (this.onRefresh) {
            this.onRefresh({ accessToken: data.AccessToken, refreshToken: data.RefreshToken });
        }
    }

    // ── Core auth API helpers (not covered by the SDK) ──────────────────────

    _baseHeaders() {
        return {
            'x-pm-uid': this.session.uid,
            Authorization: `Bearer ${this.session.accessToken}`,
            ...JSON_HEADERS,
        };
    }

    async _authApi(method, path, body = null) {
        console.debug(`[httpClient] Auth API ${method} ${path}`);
        const opts = () => ({
            method,
            headers: this._baseHeaders(),
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(30_000),
        });
        let resp = await fetch(`${AUTH_API}/${path}`, opts());
        if (resp.status === 401 && this.session.refreshToken) {
            console.debug(`[httpClient] Auth API 401 on ${path}, refreshing token...`);
            await this._refresh();
            resp = await fetch(`${AUTH_API}/${path}`, opts());
        }
        const json = await resp.json();
        if (!resp.ok || (json.Code !== 1000 && json.Code !== 1001)) {
            console.debug(`[httpClient] Auth API error: ${path} Code=${json.Code} HTTP=${resp.status}`);
            throw Object.assign(new Error(formatProtonError(path, json, resp.status)), {
                protonCode: json.Code,
                httpStatus: resp.status,
                details: json.Details,
            });
        }
        console.debug(`[httpClient] Auth API ${method} ${path} → Code=${json.Code}`);
        return json;
    }

    authGet(path) {
        return this._authApi('GET', path);
    }

    authPost(path, body) {
        return this._authApi('POST', path, body);
    }
}

/**
 * Build an Error representing a HumanVerification (Code 9001) challenge so the
 * caller can pause, prompt the user to solve it, and retry with the resulting
 * token via the `hv` argument to srpAuth.
 */
function hvRequiredError(stage, json, status) {
    return Object.assign(authError(formatProtonError(stage, json, status)), {
        code: 'HV_REQUIRED',
        protonCode: 9001,
        httpStatus: status,
        details: json.Details || {},
    });
}

/**
 * Perform the SRP login flow and return a session + the account's 2FA info.
 *
 * For modern accounts (Version >= 1) this is a single SRP exchange. For legacy
 * Version=0 accounts getAuthVersionWithFallback drives a retry loop through
 * versions 2 → 1 → 0 until the server accepts a proof.
 *
 * @param {string} email
 * @param {string} password
 * @param {?{token:string,type:string}} hv - optional HumanVerification headers
 *   to send on retry after the user solves a Code 9001 challenge.
 * @returns {{ session: {uid,accessToken,refreshToken}, twoFactor: object }}
 */
export async function srpAuth(email, password, hv = null) {
    console.debug(`[httpClient] SRP auth starting for ${email}`);
    const headers = { ...JSON_HEADERS };
    if (hv?.token && hv?.type) {
        headers['x-pm-human-verification-token'] = hv.token;
        headers['x-pm-human-verification-token-type'] = hv.type;
        console.debug(`[httpClient] HV token attached (type=${hv.type})`);
    }

    console.debug('[httpClient] Fetching auth info (core/v4/auth/info)');
    const infoResp = await fetch(`${AUTH_API}/core/v4/auth/info`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ Username: email, Intent: 'Proton' }),
        signal: AbortSignal.timeout(30_000),
    });
    const info = await infoResp.json();
    if (info.Code === 9001) throw hvRequiredError('core/v4/auth/info', info, infoResp.status);
    if (info.Code !== 1000) {
        throw Object.assign(authError(formatProtonError('core/v4/auth/info', info, infoResp.status)), {
            protonCode: info.Code,
            httpStatus: infoResp.status,
            details: info.Details,
        });
    }
    console.debug(`[httpClient] Auth info: version=${info.Version} srp_session=${info.SRPSession?.slice(0, 8)}...`);

    // For modern accounts (Version >= 1), getAuthVersionWithFallback returns the
    // server version immediately (done=true, one iteration). For legacy Version=0
    // accounts it sequences through fallback versions (2 → 1 → 0) until the
    // server accepts — each version hashes the password differently.
    let lastVersion;
    for (;;) {
        const { version, done } = getAuthVersionWithFallback({ Version: info.Version }, email, lastVersion);
        console.debug(`[httpClient] SRP attempt: authVersion=${version} done=${done}${lastVersion !== undefined ? ` (fallback from ${lastVersion})` : ''}`);

        const srp = await getSrp(
            {
                Version: info.Version,
                Modulus: info.Modulus,
                ServerEphemeral: info.ServerEphemeral,
                Username: email,
                Salt: info.Salt,
            },
            { username: email, password },
            version,
        );

        console.debug('[httpClient] Submitting SRP proof (core/v4/auth)');
        const authResp = await fetch(`${AUTH_API}/core/v4/auth`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                Username: email,
                ClientEphemeral: srp.clientEphemeral,
                ClientProof: srp.clientProof,
                SRPSession: info.SRPSession,
                PersistentCookies: 0,
            }),
            signal: AbortSignal.timeout(30_000),
        });
        const auth = await authResp.json();
        console.debug(`[httpClient] Auth response: Code=${auth.Code} HTTP=${authResp.status}`);

        if (auth.Code === 9001) throw hvRequiredError('core/v4/auth', auth, authResp.status);
        if (auth.Code === 8002 || auth.Code === 10013) {
            if (done) throw authError('Invalid credentials');
            console.debug(`[httpClient] Auth rejected (Code=${auth.Code}), trying next fallback version`);
            lastVersion = version;
            continue;
        }
        if (auth.Code !== 1000) {
            throw Object.assign(new Error(formatProtonError('core/v4/auth', auth, authResp.status)), {
                protonCode: auth.Code,
                httpStatus: authResp.status,
                details: auth.Details,
            });
        }
        if (auth.ServerProof !== srp.expectedServerProof) {
            if (done) throw authError('Server proof verification failed');
            console.debug('[httpClient] Server proof mismatch, trying next fallback version');
            lastVersion = version;
            continue;
        }

        const twoFactor = auth['2FA'] || {};
        console.debug(`[httpClient] SRP auth successful (uid prefix: ${auth.UID?.slice(0, 8)}, 2FA.Enabled=${twoFactor.Enabled ?? 0})`);
        return {
            session: { uid: auth.UID, accessToken: auth.AccessToken, refreshToken: auth.RefreshToken },
            twoFactor,
        };
    }
}
