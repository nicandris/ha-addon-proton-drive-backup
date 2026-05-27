/**
 * Manages the Proton session and its persistence in ${DATA_DIR}/session.json.
 *
 * On startup we try to rebuild a previously persisted session. If none exists
 * (or it can no longer be refreshed) we perform a full SRP login using the
 * configured email/password. If the account has two-factor authentication
 * enabled, the login pauses: we keep the partially-authenticated session in
 * memory and surface a `needsTwoFactor` state. The user then enters a live
 * 6-digit code in the web UI, which `submitTwoFactorCode` uses to complete the
 * login. We deliberately do NOT store the TOTP seed — only the resulting
 * session tokens and key password are persisted, and rotated tokens from the
 * HttpClient's refresh flow are written back so the session survives restarts
 * without re-entering a code.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

import { computeKeyPassword } from '@protontech/crypto/srp';

import { HttpClient, srpAuth } from './httpClient.mjs';
import { buildAccount } from './account.mjs';
import { initClient, listBackups } from './protonClient.mjs';

let httpClient = null;
let account = null;
let sessionState = null; // { uid, accessToken, refreshToken, keyPassword, email }
let connected = false;
let needsTwoFactor = false;
let pendingSession = null; // { uid, accessToken, refreshToken } awaiting a 2FA code

function dataDir() {
    return process.env.DATA_DIR || '/data';
}

function sessionPath() {
    return join(dataDir(), 'session.json');
}

function needsTwoFactorError() {
    return Object.assign(
        new Error('Two-factor code required — enter a code in the web UI to connect.'),
        { code: 'NEEDS_2FA' },
    );
}

// The persisted session is encrypted at rest with AES-256-GCM. The key is
// derived (scrypt) from the Proton password at runtime and never written to
// disk, so session.json holds no readable credentials. NOTE: this is
// defense-in-depth, not a strong boundary — the Proton password itself lives in
// the add-on options (options.json) in plaintext, outside our control, so an
// attacker with full host access can still re-derive this key.
function encryptionKey(salt) {
    return scryptSync(process.env.PROTON_PASSWORD || '', salt, 32);
}

function encryptSession(state) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey(salt), iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
    return JSON.stringify({
        v: 1,
        alg: 'aes-256-gcm',
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ct: ct.toString('base64'),
    });
}

function decryptSession(env) {
    const decipher = createDecipheriv(
        'aes-256-gcm',
        encryptionKey(Buffer.from(env.salt, 'base64')),
        Buffer.from(env.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
    const pt = Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]);
    return JSON.parse(pt.toString('utf8'));
}

async function persistSession() {
    if (!sessionState) return;
    await mkdir(dirname(sessionPath()), { recursive: true });
    await writeFile(sessionPath(), encryptSession(sessionState), 'utf8');
}

function onRefresh({ accessToken, refreshToken }) {
    if (!sessionState) return;
    sessionState = { ...sessionState, accessToken, refreshToken };
    persistSession().catch((err) => {
        console.error(`[protonAuth] Failed to persist refreshed session: ${err.message}`);
    });
}

async function loadPersistedSession() {
    try {
        const raw = await readFile(sessionPath(), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.ct && parsed.iv && parsed.salt) {
            try {
                return decryptSession(parsed);
            } catch (err) {
                // Wrong key (password changed) or tampered file — force re-auth.
                console.error(`[protonAuth] Could not decrypt persisted session: ${err.message}`);
                return null;
            }
        }
        // Legacy plaintext session — will be re-written encrypted on next persist.
        return parsed;
    } catch {
        return null;
    }
}

/**
 * Finish login once the session is fully authenticated (2FA already cleared if
 * the account requires it): derive the key password, build the account, init
 * the Drive client and persist. The login password lives in the environment,
 * so we re-read it here rather than holding it in memory.
 */
async function completeLogin(session) {
    const email = process.env.PROTON_EMAIL;
    const password = process.env.PROTON_PASSWORD;

    const salts = await httpClient.authGet('core/v4/keys/salts');
    const salt = (salts.KeySalts || []).find((s) => s.KeySalt);
    if (!salt) throw new Error('No key salt found for account');
    const keyPassword = await computeKeyPassword(password, salt.KeySalt);

    account = await buildAccount(httpClient, keyPassword);
    initClient(httpClient, account);

    sessionState = {
        uid: session.uid,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        keyPassword,
        email,
    };
    await persistSession();
    connected = true;
    needsTwoFactor = false;
    pendingSession = null;
    return sessionState;
}

/**
 * Start a full SRP login. Completes immediately if the account has no 2FA;
 * otherwise records `needsTwoFactor` and throws NEEDS_2FA so callers stop until
 * a code is supplied via submitTwoFactorCode().
 */
async function beginAuth() {
    const email = process.env.PROTON_EMAIL;
    const password = process.env.PROTON_PASSWORD;
    if (!email || !password) {
        throw new Error('PROTON_EMAIL and PROTON_PASSWORD must be set');
    }

    const { session, twoFactor } = await srpAuth(email, password);
    httpClient = new HttpClient(session, onRefresh);

    if (twoFactor?.Enabled) {
        needsTwoFactor = true;
        pendingSession = session;
        throw needsTwoFactorError();
    }

    return completeLogin(session);
}

/**
 * Complete a pending 2FA login with a live code from the user's authenticator.
 */
export async function submitTwoFactorCode(code) {
    if (!needsTwoFactor || !httpClient || !pendingSession) {
        throw new Error('Not awaiting a two-factor code');
    }
    const trimmed = String(code).trim();
    if (!trimmed) throw new Error('A two-factor code is required');

    await httpClient.authPost('auth/v4/2fa', { TwoFactorCode: trimmed });
    return completeLogin(pendingSession);
}

/**
 * Restore a persisted session without re-running SRP. Throws if it cannot be
 * rebuilt or verified.
 */
async function restorePersistedSession(persisted) {
    httpClient = new HttpClient(
        { uid: persisted.uid, accessToken: persisted.accessToken, refreshToken: persisted.refreshToken },
        onRefresh,
    );
    account = await buildAccount(httpClient, persisted.keyPassword);
    initClient(httpClient, account);

    sessionState = { ...persisted };
    // Cheap verification call — exercises the Drive API and triggers a token
    // refresh if needed. If it throws we fall back to a full re-auth.
    await listBackups(process.env.DRIVE_FOLDER || '');
    connected = true;
    needsTwoFactor = false;
    pendingSession = null;
}

/**
 * Ensure we have a working session. Tries to restore from disk first, falling
 * back to a full login. May throw NEEDS_2FA when a 2FA account has no usable
 * persisted session and a code has not yet been entered.
 */
export async function ensureSession() {
    if (connected) return sessionState;

    const persisted = await loadPersistedSession();
    if (persisted && persisted.uid && persisted.keyPassword) {
        try {
            await restorePersistedSession(persisted);
            return sessionState;
        } catch (err) {
            console.error(`[protonAuth] Session restore failed, re-authenticating: ${err.message}`);
            connected = false;
        }
    }

    return beginAuth();
}

export function getAuthState() {
    return {
        connected,
        needsTwoFactor,
        email: sessionState?.email || process.env.PROTON_EMAIL || null,
    };
}
