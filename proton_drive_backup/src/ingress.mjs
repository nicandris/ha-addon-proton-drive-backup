/**
 * Minimal ingress HTTP server for the add-on UI.
 *
 * Home Assistant ingress handles authentication, so this server has none of its
 * own — which is only safe because it answers nothing but HA's ingress proxy
 * (`isAllowedClient`): the hassio network is shared with every other add-on. It
 * serves a small self-contained HTML page plus a handful of JSON endpoints
 * that the page calls to show status and drive connect / sync / restore / delete.
 *
 * Authentication is a browser sign-in: POST /api/connect starts the CLI's
 * `auth login`, which prints a sign-in URL; the UI surfaces that URL as a
 * clickable link the user opens on any device, and the connection flips to
 * "connected" once the CLI completes sign-in in the background.
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

import * as cli from './protonCli.mjs';
import * as orchestrator from './orchestrator.mjs';
import * as supervisor from './supervisor.mjs';
import { getLogLevel, logLevels, setLogLevelStrict } from './logger.mjs';

// UI-facing login state. The live connection state is not kept here — it comes
// from the cached snapshot (cli.isConnected()) on every status poll.
const state = {
    loginUrl: null, // sign-in URL from the CLI, shown to the user
    loginInProgress: false, // an auth login child is running
    loginError: null, // last sign-in failure text
};

/** Every body this API takes is a few hundred bytes of JSON. */
const MAX_BODY_BYTES = 64 * 1024;

async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        // Unbounded, any caller could make us buffer an arbitrary amount of memory.
        if (size > MAX_BODY_BYTES) throw Object.assign(new Error('request body too large'), { status: 413 });
        chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        return {};
    }
}

/**
 * Home Assistant's ingress proxy — the only legitimate caller. The port is also
 * reachable from every other container on the hassio network, and without this
 * check any of them could restore/delete backups or bind its own Proton account
 * via /api/connect + loginUrl. Loopback is allowed: nothing outside this
 * container can use it.
 */
const INGRESS_PROXY_IP = '172.30.32.2';
export function isAllowedClient(remoteAddress) {
    const ip = String(remoteAddress || '').replace(/^::ffff:/, '');
    return ip === INGRESS_PROXY_IP || ip === '127.0.0.1' || ip === '::1';
}

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
}

function sendBusy(res) {
    sendJson(res, 409, { ok: false, error: 'A sync, backup or restore is already running — try again when it finishes.' });
}

function scheduleSummary() {
    const hours = orchestrator.getConfig().intervalHours;
    if (hours <= 0) return 'On boot + manual only';
    return `Every ${hours} hour${hours === 1 ? '' : 's'} (+ boot)`;
}

// --- Expensive-lookup cache -------------------------------------------------
// Each /api/status poll used to spawn the ~110 MB `proton-drive` binary TWICE
// (isConnected + list) and hit the Supervisor twice — every 5 s, per open browser
// tab. Those results barely change, and the churn competed with running uploads
// and risked Proton rate-limiting. They're now cached behind a short TTL, while
// the live bits (syncing/activity/progress/lastError) always come from memory so
// the progress indicator stays responsive. Any action invalidates the cache.
const SNAPSHOT_TTL_MS = 30000;
let snapshot = null; // { at, connected, backups, backupsError, stats }
let snapshotInFlight = null; // dedupes concurrent polls (e.g. two tabs at once)

/** Drop the cache so the next poll re-reads live state (call after any action). */
function invalidateSnapshot() {
    snapshot = null;
}

async function buildSnapshot() {
    const connected = await cli.isConnected();

    let backups = [];
    let backupsError = null;
    if (connected) {
        try {
            backups = await orchestrator.listProtonBackups();
        } catch (err) {
            backupsError = err.message;
        }
    }
    const stats = await buildStats(backups);
    return { at: Date.now(), connected, backups, backupsError, stats };
}

function snapshotIsFresh() {
    return !!snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS;
}

/** Kick off (or join) a snapshot refresh. Never rejects. */
function refreshSnapshot() {
    if (snapshotInFlight) return snapshotInFlight;
    snapshotInFlight = buildSnapshot()
        .then((s) => { snapshot = s; return s; })
        .catch((err) => { console.debug(`[ingress] snapshot refresh: ${err.message}`); return null; })
        .finally(() => { snapshotInFlight = null; });
    return snapshotInFlight;
}

/**
 * Stale-while-revalidate: returns immediately with whatever we have (fresh, stale,
 * or nothing) and refreshes in the background.
 *
 * The first status request used to AWAIT two `proton-drive` spawns plus two
 * Supervisor calls — several seconds during which the whole page sat on
 * "Loading…". Now the page renders at once and the slow parts fill themselves in.
 */
function getSnapshotNonBlocking() {
    if (!snapshotIsFresh()) refreshSnapshot();
    return snapshot; // may be stale, or null on the very first request
}

/** Warm the cache at boot so an early visitor doesn't wait for a cold read. */
export function primeSnapshot() {
    refreshSnapshot();
}

async function buildStatus() {
    const status = orchestrator.getStatus();
    const snap = getSnapshotNonBlocking();
    // `pending` = nothing known yet; the UI shows a spinner rather than guessing.
    const pending = !snap;
    const { connected, backups, backupsError, stats } =
        snap || { connected: null, backups: null, backupsError: null, stats: null };
    if (connected) {
        state.loginUrl = null;
        state.loginError = null;
    }

    const statusLabel = pending
        ? 'checking…'
        : connected
          ? 'connected'
          : (state.loginInProgress || state.loginUrl)
            ? 'awaiting sign-in'
            : 'disconnected';

    return {
        status: statusLabel,
        pending,
        connected: !!connected,
        // Don't claim a login is needed before we've actually looked.
        needsLogin: !pending && !connected,
        loginUrl: state.loginUrl,
        loginInProgress: state.loginInProgress,
        loginError: state.loginError,
        logLevel: getLogLevel(),
        logLevels: logLevels(), // the internal levels the dropdown offers
        schedule: scheduleSummary(),
        settings: orchestrator.getConfig(),
        lastSync: status.lastSync,
        lastError: status.lastError || backupsError,
        nextSyncEpoch: status.nextSyncEpoch,
        syncing: status.syncing,
        activity: status.activity,
        progress: status.progress,
        stats,
        backups: backups || [],
    };
}

/**
 * Backup statistics (best-effort — never let a stats failure break status).
 * Mirror model: "In Home Assistant" counts ALL HA backups; "In Proton Drive"
 * counts the mirrored ones. Part of the cached snapshot (hits the Supervisor).
 */
async function buildStats(backups) {
    let stats = null;
    try {
        const haBackups = await supervisor.listBackups();
        const haSizeMB = haBackups.reduce((s, b) => s + (Number(b.size) || 0), 0);
        const protonSizeBytes = (backups || []).reduce((s, b) => s + (Number(b.size) || 0), 0);
        let host = null;
        try { host = await supervisor.hostInfo(); } catch { /* disk stats optional */ }
        const gb = (v) => (typeof v === 'number' ? Math.round(v * 1024 * 1024 * 1024) : null);
        const dates = [...(backups || []).map((b) => b.date), ...haBackups.map((b) => b.date)]
            .filter(Boolean).map((d) => new Date(d).getTime()).filter((n) => !isNaN(n));
        // Split each side into automatic vs app buckets (classified BY NAME).
        const haAuto = haBackups.filter((b) => orchestrator.isAutomaticBackup(b.name)).length;
        const protonAuto = (backups || []).filter((b) => orchestrator.isAutomaticBackup(b.name)).length;
        stats = {
            haCount: haBackups.length,
            haAutomaticCount: haAuto,
            haAppCount: haBackups.length - haAuto,
            haSizeBytes: Math.round(haSizeMB * 1024 * 1024),
            protonCount: (backups || []).length,
            protonAutomaticCount: protonAuto,
            protonAppCount: (backups || []).length - protonAuto,
            protonSizeBytes,
            hostDiskFreeBytes: gb(host?.disk_free),
            hostDiskTotalBytes: gb(host?.disk_total),
            lastBackup: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
        };
    } catch (err) {
        console.debug(`[ingress] stats: ${err.message}`);
    }
    return stats;
}

/**
 * Home Assistant's stock DARK values. Interpolated into the page twice — once
 * under `@media (prefers-color-scheme: dark)` for "Auto", and once under
 * `:root[data-theme="dark"]` for an explicit choice — so the two can never drift.
 */
const DARK_PALETTE = `      --primary-background-color: #111111;
      --card-background-color: #1c1c1c;
      --secondary-background-color: #282828;
      --primary-text-color: #e1e1e1;
      --secondary-text-color: #9b9b9b;
      --disabled-text-color: #6f6f6f;
      --divider-color: rgba(225, 225, 225, 0.12);
      --shadow-color: rgba(0, 0, 0, 0.48);`;

// The page lives in ui.html, not in a template literal here: inside one, a `\n`
// meant for the page's JS became a real newline and broke the whole UI (0.4.3).
// Read once at start-up; the dark palette is spliced in at its two markers.
const PAGE = readFileSync(new URL('./ui.html', import.meta.url), 'utf8')
    .replaceAll('/* DARK_PALETTE */', DARK_PALETTE)
    .replace(/\n$/, '');

export function renderPage() {
    return PAGE;
}

export function startIngressServer() {
    const port = parseInt(process.env.PORT || '8099', 10);

    const server = createServer((req, res) => {
        handle(req, res).catch((err) => {
            console.error(`[ingress] Unhandled error: ${err.message}`);
            if (!res.headersSent) sendJson(res, err.status || 500, { ok: false, error: err.message });
        });
    });

    // Without this, a listen failure surfaces as an unhandled 'error' event that
    // kills the process with a bare stack trace.
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`[ingress] Port ${port} is already in use — another process (or a second copy of this add-on) holds it. The Web UI cannot start.`);
        } else if (err.code === 'EACCES') {
            console.error(`[ingress] Not permitted to bind port ${port} (EACCES). The Web UI cannot start.`);
        } else {
            console.error(`[ingress] HTTP server error (${err.code || 'unknown'}): ${err.message}`);
        }
    });

    server.listen(port, () => {
        console.log(`[ingress] Listening on port ${port}`);
        // Warm the status cache so the first page load is instant.
        primeSnapshot();
    });
    return server;
}

async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method || 'GET';
    console.debug(`[ingress] ${method} ${path}`);

    if (!isAllowedClient(req.socket.remoteAddress)) {
        console.warn(`[ingress] Refused ${method} ${path} from ${req.socket.remoteAddress} (not the HA ingress proxy)`);
        sendJson(res, 403, { ok: false, error: 'Forbidden' });
        return;
    }

    if (method === 'GET' && path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderPage());
        return;
    }

    if (method === 'GET' && path === '/api/status') {
        sendJson(res, 200, await buildStatus());
        return;
    }

    if (method === 'POST' && path === '/api/log-level') {
        const body = await readBody(req);
        try {
            // Strict here (unlike boot): garbage from the API is a 400, not a
            // silent fallback to info.
            setLogLevelStrict(body.level);
        } catch (err) {
            sendJson(res, 400, { ok: false, error: err.message });
            return;
        }
        // Also save it as the add-on's log_level option, or the panel's choice
        // was lost on the next restart. Best-effort: the runtime change stands.
        const level = getLogLevel();
        let persisted = true;
        try {
            await supervisor.setSelfOptions({ log_level: level });
        } catch (err) {
            persisted = false;
            console.warn(`[ingress] log level ${level} applied but not saved: ${err.message}`);
        }
        sendJson(res, 200, { ok: true, level, persisted });
        return;
    }

    if (method === 'POST' && path === '/api/connect') {
        if (state.loginInProgress) {
            sendJson(res, 200, { started: true, alreadyRunning: true });
            return;
        }
        // Start the browser sign-in in the background. The URL surfaces via
        // /api/status (state.loginUrl) as soon as the CLI prints it; the
        // connection flips to "connected" once the CLI completes sign-in.
        state.loginInProgress = true;
        state.loginUrl = null;
        state.loginError = null;
        cli.login({ onUrl: (u) => { state.loginUrl = u; } })
            .then((result) => {
                state.loginInProgress = false;
                state.loginUrl = null;
                if (result.ok) {
                    console.log('[ingress] Sign-in complete — connected');
                    // A fresh login rewrites the session files with the CLI's
                    // default 0644 — narrow them again.
                    cli.secureSessionStore().catch(() => {});
                    invalidateSnapshot();
                    orchestrator.runSync()
                        .catch((err) => console.error(`[ingress] post-login sync: ${err.message}`))
                        .finally(invalidateSnapshot);
                } else {
                    state.loginError = result.error;
                    console.error(`[ingress] Sign-in failed: ${result.error}`);
                }
            })
            .catch((err) => {
                state.loginInProgress = false;
                state.loginUrl = null;
                state.loginError = err.message;
                console.error(`[ingress] Sign-in error: ${err.message}`);
            });
        sendJson(res, 200, { started: true });
        return;
    }

    if (method === 'POST' && path === '/api/disconnect') {
        try {
            await cli.logout();
        } catch (err) {
            console.error(`[ingress] logout: ${err.message}`);
        }
        invalidateSnapshot();
        state.loginUrl = null;
        state.loginInProgress = false;
        state.loginError = null;
        sendJson(res, 200, { ok: true });
        return;
    }

    if (method === 'POST' && path === '/api/create-backup') {
        // Would otherwise answer "started" and then silently skip.
        if (orchestrator.getStatus().syncing) return sendBusy(res);
        invalidateSnapshot();
        orchestrator.createBackupNow()
            .catch((err) => console.error(`[ingress] create-backup: ${err.message}`))
            .finally(invalidateSnapshot);
        sendJson(res, 200, { started: true });
        return;
    }

    if (method === 'POST' && path === '/api/settings') {
        const body = await readBody(req);
        try {
            const settings = await orchestrator.applySettings(body);
            invalidateSnapshot();
            sendJson(res, 200, { ok: true, settings });
        } catch (err) {
            sendJson(res, 400, { ok: false, error: err.message });
        }
        return;
    }

    if (method === 'POST' && path === '/api/clear-error') {
        orchestrator.clearError();
        // These live here, not in the orchestrator — without clearing them the
        // error reappeared on the next poll and the button looked broken.
        state.loginError = null;
        invalidateSnapshot();
        sendJson(res, 200, { ok: true });
        return;
    }

    if (method === 'POST' && path === '/api/sync-now') {
        // Upload existing HA backups now. Kick off but don't block the response
        // on full completion (409 if something is already running).
        if (orchestrator.getStatus().syncing) return sendBusy(res);
        invalidateSnapshot();
        orchestrator.runSync()
            .catch((err) => console.error(`[ingress] sync-now: ${err.message}`))
            .finally(invalidateSnapshot);
        sendJson(res, 200, { ok: true });
        return;
    }

    if (method === 'POST' && path === '/api/prune-ha') {
        // Manual local clean-up: delete local HA backups beyond the newest N,
        // but only ones confirmed present in Proton. Await so the UI can report.
        try {
            const result = await orchestrator.pruneHALocalNow();
            invalidateSnapshot();
            sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
            sendJson(res, err.busy ? 409 : 500, { ok: false, error: err.message });
        }
        return;
    }

    if (method === 'POST' && path === '/api/restore') {
        const body = await readBody(req);
        if (!body.name) return sendJson(res, 400, { ok: false, error: 'name required' });
        if (!orchestrator.isValidRemoteName(body.name)) {
            return sendJson(res, 400, { ok: false, error: 'invalid backup name (must be a plain .tar filename)' });
        }
        // Fire-and-forget like /api/sync-now: a restore downloads a multi-GB
        // archive and blocks HA for minutes, far longer than an HTTP response
        // should wait. Progress/errors surface via /api/status. A busy lock is
        // the one failure we can report now — it used to answer started:true
        // and then silently do nothing.
        if (orchestrator.getStatus().syncing) return sendBusy(res);
        invalidateSnapshot();
        orchestrator.restoreToHA(body.name)
            .catch((err) => console.error(`[ingress] restore: ${err.message}`))
            .finally(invalidateSnapshot);
        sendJson(res, 200, { ok: true, started: true });
        return;
    }

    if (method === 'POST' && path === '/api/delete') {
        const body = await readBody(req);
        if (!body.name) return sendJson(res, 400, { ok: false, error: 'name required' });
        if (!orchestrator.isValidRemoteName(body.name)) {
            return sendJson(res, 400, { ok: false, error: 'invalid backup name (must be a plain .tar filename)' });
        }
        try {
            await orchestrator.deleteProtonBackup(body.name);
            invalidateSnapshot();
            sendJson(res, 200, { ok: true });
        } catch (err) {
            sendJson(res, err.busy ? 409 : 500, { ok: false, error: err.message });
        }
        return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
}
