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
// HumanVerification (Code 9001) challenge waiting for the user to solve.
// methods e.g. ['captcha','email','sms']; webUrl is what the UI embeds.
let needsHumanVerification = false;
let pendingHvChallenge = null; // { methods:string[], token, webUrl, expiresAt }

// Login halt. We do NOT auto-retry failed logins: repeatedly retrying SRP (e.g.
// on every restart or schedule tick) can make Proton flag the account for
// "unusual activity" and lock it. After any login failure we halt and stop
// attempting until the user explicitly clicks "Retry connection". The halt is
// persisted to disk so a restart/watchdog loop can't bypass it and keep hitting
// Proton. (A 2FA / HumanVerification prompt is NOT a failure and does not halt.)
let authHalt = { halted: false, hardStop: false, protonCode: null, lastError: null };
let haltLoaded = false;

function dataDir() {
    return process.env.DATA_DIR || '/data';
}

function sessionPath() {
    return join(dataDir(), 'session.json');
}

function haltPath() {
    return join(dataDir(), 'auth_halt.json');
}

async function loadHalt() {
    try {
        authHalt = JSON.parse(await readFile(haltPath(), 'utf8'));
        console.debug(`[protonAuth] Halt state loaded: halted=${authHalt.halted} hardStop=${authHalt.hardStop} protonCode=${authHalt.protonCode}`);
    } catch {
        // no file yet — keep defaults
        console.debug('[protonAuth] No halt file found, starting fresh');
    }
}

async function persistHalt() {
    try {
        await mkdir(dirname(haltPath()), { recursive: true });
        await writeFile(haltPath(), JSON.stringify(authHalt), 'utf8');
        console.debug('[protonAuth] Halt state persisted');
    } catch (err) {
        console.error(`[protonAuth] Failed to persist halt state: ${err.message}`);
    }
}

async function clearHalt() {
    console.debug('[protonAuth] Clearing auth halt');
    authHalt = { halted: false, hardStop: false, protonCode: null, lastError: null };
    await persistHalt();
}

// Human-readable action text matched to the actual Proton response code. The
// 2028 path (Sentinel "potentially abusive traffic") does NOT issue a
// verification challenge — no in-web "verify" button clears it, contrary to
// what earlier copy implied.
function buildHaltAdvice(halt) {
    if (!halt.halted) return null;
    const isSentinel =
        halt.protonCode === 2028 || /\bCode=2028\b/.test(halt.lastError || '');
    if (isSentinel) {
        return (
            'Proton has Sentinel-blocked this account/IP (Code 2028). ' +
            'There is no in-web verification that clears this. Options: wait ' +
            'a few hours and try again, attempt from a different network ' +
            '(e.g. phone hotspot) to confirm IP-based blocking, or file an ' +
            'appeal at https://proton.me/support/appeal-abuse. Leave the app ' +
            'stopped while you wait — every retry can extend the block.'
        );
    }
    if (halt.hardStop) {
        return (
            'Proton temporarily limited the account. Sign in at ' +
            'https://account.proton.me — if a banner, CAPTCHA, or ' +
            '"Confirm it\'s you" step appears, complete it; then click ' +
            '"Retry connection". Otherwise wait and retry later.'
        );
    }
    return 'Fix the underlying issue (for example wrong credentials), then click "Retry connection".';
}

// A rate-limit / abuse-protection response from Proton — worth calling out so
// the user knows to verify the account before retrying.
function isRateLimited(err) {
    if (err?.httpStatus === 429) return true;
    const m = (err?.message || '').toLowerCase();
    return (
        m.includes('temporarily limited') ||
        m.includes('unusual activity') ||
        m.includes('too many')
    );
}

async function haltOnAuthFailure(err) {
    authHalt = {
        halted: true,
        hardStop: isRateLimited(err),
        protonCode: typeof err.protonCode === 'number' ? err.protonCode : null,
        lastError: err.message,
    };
    console.debug(`[protonAuth] Auth halted — protonCode=${authHalt.protonCode} hardStop=${authHalt.hardStop} error="${authHalt.lastError}"`);
    await persistHalt();
}

function needsTwoFactorError() {
    return Object.assign(
        new Error('Two-factor code required — enter a code in the web UI to connect.'),
        { code: 'NEEDS_2FA' },
    );
}

function needsHvError() {
    return Object.assign(
        new Error('Human verification required — solve the challenge in the web UI to connect.'),
        { code: 'NEEDS_HV' },
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
    console.debug('[protonAuth] Session persisted to disk (AES-256-GCM)');
}

function onRefresh({ accessToken, refreshToken }) {
    if (!sessionState) return;
    sessionState = { ...sessionState, accessToken, refreshToken };
    console.debug('[protonAuth] Session tokens refreshed, re-persisting');
    persistSession().catch((err) => {
        console.error(`[protonAuth] Failed to persist refreshed session: ${err.message}`);
    });
}

// Called by HttpClient when a token refresh fails (refresh token revoked or
// expired). Resets `connected` so the next ensureSession() triggers a full
// re-auth rather than returning a stale session.
function onSessionExpired() {
    connected = false;
    console.warn('[protonAuth] Session refresh failed — will re-authenticate on next sync.');
}

async function loadPersistedSession() {
    console.debug('[protonAuth] Looking for persisted session...');
    try {
        const raw = await readFile(sessionPath(), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.ct && parsed.iv && parsed.salt) {
            try {
                const decrypted = decryptSession(parsed);
                console.debug(`[protonAuth] Decrypted v1 session for ${decrypted.email}`);
                return decrypted;
            } catch (err) {
                // Wrong key (password changed) or tampered file — force re-auth.
                console.error(`[protonAuth] Could not decrypt persisted session: ${err.message}`);
                return null;
            }
        }
        // Legacy plaintext session — will be re-written encrypted on next persist.
        console.debug(`[protonAuth] Loaded legacy plaintext session for ${parsed?.email} (will re-encrypt on next persist)`);
        return parsed;
    } catch {
        console.debug('[protonAuth] No persisted session found');
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

    console.debug('[protonAuth] completeLogin: fetching key salts and addresses in parallel');
    // Fetch salts and addresses in parallel; match the salt to the primary
    // address key by ID rather than just taking the first entry — multiple
    // address keys can have different salts (wrong salt → wrong key password).
    const [saltsResp, addressesResp] = await Promise.all([
        httpClient.authGet('core/v4/keys/salts'),
        httpClient.authGet('core/v4/addresses'),
    ]);
    const primaryAddr = (addressesResp.Addresses || []).find((a) => a.Status === 1);
    const primaryKeyId =
        (primaryAddr?.Keys || []).find((k) => k.Primary === 1)?.ID ??
        (primaryAddr?.Keys || [])[0]?.ID;
    const keySalts = saltsResp.KeySalts || [];
    const matchedSalt =
        (primaryKeyId && keySalts.find((s) => s.ID === primaryKeyId && s.KeySalt)) ||
        keySalts.find((s) => s.KeySalt);
    if (!matchedSalt) throw new Error('No key salt found for account');
    console.debug(`[protonAuth] Key salt matched: keyId=${primaryKeyId ?? '(fallback)'} saltId=${matchedSalt.ID}`);

    console.debug('[protonAuth] Deriving key password (bcrypt)...');
    const keyPassword = await computeKeyPassword(password, matchedSalt.KeySalt);
    console.debug('[protonAuth] Key password derived');

    console.debug('[protonAuth] Building account (importing address keys)...');
    account = await buildAccount(httpClient, keyPassword, addressesResp);
    console.debug('[protonAuth] Initializing Drive client...');
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
    await clearHalt();
    console.debug('[protonAuth] Login complete — connected');
    return sessionState;
}

/**
 * Start a full SRP login. May throw NEEDS_2FA (account has 2FA, code needed)
 * or NEEDS_HV (Proton wants HumanVerification, captcha needed); callers should
 * keep running and surface the appropriate UI prompt.
 *
 * @param {?{token:string,type:string}} hv - optional, set on retry after the
 *   user solves the HumanVerification challenge.
 */
async function beginAuth(hv = null) {
    const email = process.env.PROTON_EMAIL;
    const password = process.env.PROTON_PASSWORD;
    if (!email || !password) {
        throw new Error('PROTON_EMAIL and PROTON_PASSWORD must be set');
    }

    console.debug(`[protonAuth] beginAuth: starting SRP for ${email}${hv ? ' (with HV token)' : ''}`);
    let result;
    try {
        result = await srpAuth(email, password, hv);
    } catch (err) {
        if (err.code === 'HV_REQUIRED') {
            const methods = err.details?.HumanVerificationMethods || ['captcha'];
            const expiresAt = err.details?.ExpiresAt;
            console.debug(`[protonAuth] HumanVerification required: methods=${JSON.stringify(methods)} expiresAt=${expiresAt}`);
            needsHumanVerification = true;
            pendingHvChallenge = {
                methods,
                token: err.details?.HumanVerificationToken,
                webUrl: err.details?.WebUrl,
                expiresAt,
            };
            throw needsHvError();
        }
        throw err;
    }

    const { session, twoFactor } = result;
    httpClient = new HttpClient(session, onRefresh, onSessionExpired);

    // Enabled bitmask: 0=none, 1=TOTP, 2=FIDO2 only, 3=both.
    // FIDO2-only accounts cannot supply a TOTP code — surface a clear error
    // rather than displaying a code prompt the user can never complete.
    if (twoFactor?.Enabled === 2) {
        throw new Error(
            'FIDO2-only 2FA is not supported. Enable a TOTP authenticator app in ' +
            'your Proton account settings (account.proton.me → Account → Two-factor ' +
            'authentication), then retry.',
        );
    }
    if (twoFactor?.Enabled === 1 || twoFactor?.Enabled === 3) {
        console.debug(`[protonAuth] 2FA required (Enabled=${twoFactor.Enabled}: ${twoFactor.Enabled === 1 ? 'TOTP' : 'TOTP+FIDO2'})`);
        needsTwoFactor = true;
        pendingSession = session;
        throw needsTwoFactorError();
    }

    return completeLogin(session);
}

/**
 * Complete a pending HumanVerification challenge with the solved token from
 * the embedded verify.proton.me iframe. Re-runs SRP with the HV headers.
 */
export async function submitHumanVerification(solvedToken, type = 'captcha') {
    if (!needsHumanVerification) {
        throw new Error('No human verification pending');
    }
    if (!solvedToken) throw new Error('A verification token is required');

    console.debug(`[protonAuth] Submitting HV token (type=${type})`);
    needsHumanVerification = false;
    pendingHvChallenge = null;
    // beginAuth() will resurface NEEDS_HV if Proton still isn't satisfied (e.g.
    // expired token), and NEEDS_2FA if a 2FA prompt appears next.
    return beginAuth({ token: solvedToken, type });
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

    console.debug('[protonAuth] Submitting 2FA code');
    await httpClient.authPost('core/v4/auth/2fa', { TwoFactorCode: trimmed });
    console.debug('[protonAuth] 2FA accepted, completing login');
    return completeLogin(pendingSession);
}

/**
 * Restore a persisted session without re-running SRP. Throws if it cannot be
 * rebuilt or verified.
 */
async function restorePersistedSession(persisted) {
    console.debug(`[protonAuth] Restoring session for ${persisted.email}`);
    httpClient = new HttpClient(
        { uid: persisted.uid, accessToken: persisted.accessToken, refreshToken: persisted.refreshToken },
        onRefresh,
        onSessionExpired,
    );
    console.debug('[protonAuth] Importing address keys from persisted key password...');
    account = await buildAccount(httpClient, persisted.keyPassword);
    initClient(httpClient, account);

    sessionState = { ...persisted };
    // Cheap verification call — exercises the Drive API and triggers a token
    // refresh if needed. If it throws we fall back to a full re-auth.
    console.debug('[protonAuth] Verifying session with Drive API (listBackups)...');
    await listBackups(process.env.DRIVE_FOLDER || '');
    connected = true;
    needsTwoFactor = false;
    pendingSession = null;
    console.debug('[protonAuth] Session restored and verified');
}

/**
 * Ensure we have a working session. Tries to restore from disk first, falling
 * back to a full login. May throw NEEDS_2FA when a 2FA account has no usable
 * persisted session and a code has not yet been entered.
 */
export async function ensureSession() {
    if (connected) {
        console.debug('[protonAuth] ensureSession: already connected');
        return sessionState;
    }

    // Already waiting for a 2FA code — don't run another SRP login on each sync
    // tick (repeated logins can trip Proton's abuse protection).
    if (needsTwoFactor) throw needsTwoFactorError();
    // Same for a pending HumanVerification challenge.
    if (needsHumanVerification) throw needsHvError();

    if (!haltLoaded) {
        await loadHalt();
        haltLoaded = true;
    }
    // After a prior login failure we do not attempt again automatically; the
    // user must clear the halt via retryNow() ("Retry connection" in the UI).
    // The action text lives in `haltAdvice` (see getAuthState) so we don't
    // bake stale guidance into the error message itself.
    if (authHalt.halted) {
        console.debug(`[protonAuth] ensureSession: auth is halted (protonCode=${authHalt.protonCode})`);
        throw Object.assign(
            new Error(`Login halted: ${authHalt.lastError}`),
            { code: 'AUTH_HALTED' },
        );
    }

    try {
        const persisted = await loadPersistedSession();
        if (persisted && persisted.uid && persisted.keyPassword) {
            console.debug('[protonAuth] ensureSession: attempting session restore');
            try {
                await restorePersistedSession(persisted);
                await clearHalt();
                return sessionState;
            } catch (err) {
                console.error(`[protonAuth] Session restore failed, re-authenticating: ${err.message}`);
                connected = false;
            }
        } else {
            console.debug('[protonAuth] ensureSession: no usable persisted session, starting fresh auth');
        }
        return await beginAuth();
    } catch (err) {
        // A 2FA / HumanVerification prompt is an expected pause, not a failure
        // — keep running so the user can complete it. Everything else halts
        // auto-attempts.
        if (err.code === 'NEEDS_2FA' || err.code === 'NEEDS_HV') throw err;
        await haltOnAuthFailure(err);
        throw err;
    }
}

/**
 * Manually clear a halt and attempt to connect once. Triggered by the user from
 * the web UI after they've fixed credentials or verified the account.
 */
export async function retryNow() {
    console.debug('[protonAuth] retryNow: clearing halt and re-trying');
    await clearHalt();
    haltLoaded = true;
    return ensureSession();
}

export function getAuthState() {
    return {
        connected,
        needsTwoFactor,
        needsHumanVerification,
        // The token itself is embedded in `hvWebUrl`'s query string, which the
        // UI loads in an iframe — we don't pass the raw token to the page JS.
        hvMethods: pendingHvChallenge?.methods || null,
        hvWebUrl: pendingHvChallenge?.webUrl || null,
        hvExpiresAt: pendingHvChallenge?.expiresAt || null,
        halted: authHalt.halted,
        hardStop: authHalt.hardStop,
        protonCode: authHalt.protonCode || null,
        lastError: authHalt.lastError,
        haltAdvice: buildHaltAdvice(authHalt),
        email: sessionState?.email || process.env.PROTON_EMAIL || null,
    };
}
