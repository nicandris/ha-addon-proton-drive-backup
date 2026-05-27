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

import { getSrp } from '@protontech/crypto/srp';

// Proton's account/auth + core API host. Note `api.proton.me` does NOT exist
// (NXDOMAIN); the real hosts follow the `<service>-api.proton.me` pattern, the
// same as the SDK's `drive-api.proton.me`.
const AUTH_API = 'https://account-api.proton.me';
const DRIVE_HOST = 'drive-api.proton.me';

// Identify this build honestly per the SDK's third-party guidelines: the name
// is THIS third-party project, not "home_assistant" — we must not present the
// request as coming from the Home Assistant project (or from Proton).
export const APP_VERSION = 'external-drive-ha_addon_proton_drive_backup@0.1.0-alpha';

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
    constructor(session, onRefresh = null) {
        // session: { uid, accessToken, refreshToken }
        this.session = session;
        this.onRefresh = onRefresh;
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

        let response = await send();
        if (response.status === 401 && isDriveApi && this.session.refreshToken) {
            await this._refresh();
            headers.set('Authorization', `Bearer ${this.session.accessToken}`);
            response = await send();
        }
        return response;
    }

    async _refresh() {
        const resp = await fetch(`${AUTH_API}/auth/v4/refresh`, {
            method: 'POST',
            headers: { 'x-pm-uid': this.session.uid, ...JSON_HEADERS },
            body: JSON.stringify({
                ResponseType: 'token',
                GrantType: 'refresh_token',
                RefreshToken: this.session.refreshToken,
                RedirectURI: 'https://protonmail.ch',
            }),
        });
        if (!resp.ok) throw authError('Session expired');
        const data = await resp.json();
        this.updateSession({ accessToken: data.AccessToken, refreshToken: data.RefreshToken });
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
        let resp = await fetch(`${AUTH_API}/${path}`, {
            method,
            headers: this._baseHeaders(),
            body: body ? JSON.stringify(body) : undefined,
        });
        if (resp.status === 401 && this.session.refreshToken) {
            await this._refresh();
            resp = await fetch(`${AUTH_API}/${path}`, {
                method,
                headers: this._baseHeaders(),
                body: body ? JSON.stringify(body) : undefined,
            });
        }
        const json = await resp.json();
        if (!resp.ok || (json.Code !== 1000 && json.Code !== 1001)) {
            throw Object.assign(new Error(formatProtonError(path, json, resp.status)), {
                protonCode: json.Code,
                httpStatus: resp.status,
                details: json.Details,
            });
        }
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
 * Perform the SRP login flow and return a session + the account's 2FA info.
 *
 * @returns {{ session: {uid,accessToken,refreshToken}, twoFactor: object }}
 */
export async function srpAuth(email, password) {
    const infoResp = await fetch(`${AUTH_API}/auth/v4/info`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ Username: email }),
    });
    const info = await infoResp.json();
    if (info.Code !== 1000) {
        throw Object.assign(authError(formatProtonError('auth/v4/info', info, infoResp.status)), {
            protonCode: info.Code,
            httpStatus: infoResp.status,
            details: info.Details,
        });
    }

    const srp = await getSrp(
        {
            Version: info.Version,
            Modulus: info.Modulus,
            ServerEphemeral: info.ServerEphemeral,
            Username: email,
            Salt: info.Salt,
        },
        { username: email, password },
    );

    const authResp = await fetch(`${AUTH_API}/auth/v4`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
            Username: email,
            ClientEphemeral: srp.clientEphemeral,
            ClientProof: srp.clientProof,
            SRPSession: info.SRPSession,
        }),
    });
    const auth = await authResp.json();

    if (auth.Code === 8002 || auth.Code === 10013) throw authError('Invalid credentials');
    if (auth.Code !== 1000) {
        throw Object.assign(new Error(formatProtonError('auth/v4', auth, authResp.status)), {
            protonCode: auth.Code,
            httpStatus: authResp.status,
            details: auth.Details,
        });
    }
    if (auth.ServerProof !== srp.expectedServerProof) {
        throw authError('Server proof verification failed');
    }

    return {
        session: { uid: auth.UID, accessToken: auth.AccessToken, refreshToken: auth.RefreshToken },
        twoFactor: auth['2FA'] || {},
    };
}
