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

// Identify this build honestly per the SDK's third-party guidelines.
export const APP_VERSION = 'external-drive-home_assistant@0.1.0-alpha';

const JSON_HEADERS = {
    'Content-Type': 'application/json',
    'x-pm-appversion': APP_VERSION,
};

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
            throw new Error(`${method} ${path} failed: ${json.Error || resp.statusText} (${json.Code})`);
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
    if (info.Code !== 1000) throw authError(info.Error || 'Auth info failed');

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
    if (auth.Code !== 1000) throw new Error(auth.Error || 'Authentication failed');
    if (auth.ServerProof !== srp.expectedServerProof) {
        throw authError('Server proof verification failed');
    }

    return {
        session: { uid: auth.UID, accessToken: auth.AccessToken, refreshToken: auth.RefreshToken },
        twoFactor: auth['2FA'] || {},
    };
}
