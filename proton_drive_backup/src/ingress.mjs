/**
 * Minimal ingress HTTP server for the add-on UI.
 *
 * Home Assistant ingress handles authentication, so this server is unauthenticated.
 * It serves a small self-contained HTML page plus a handful of JSON endpoints
 * that the page calls to show status and drive connect / sync / restore / delete.
 *
 * Authentication is a browser sign-in: POST /api/connect starts the CLI's
 * `auth login`, which prints a sign-in URL; the UI surfaces that URL as a
 * clickable link the user opens on any device, and the connection flips to
 * "connected" once the CLI completes sign-in in the background.
 */

import { createServer } from 'node:http';

import * as cli from './protonCli.mjs';
import * as orchestrator from './orchestrator.mjs';
import * as supervisor from './supervisor.mjs';
import { getLogLevel, setLogLevel } from './logger.mjs';

// UI-facing login state. connected is refreshed from the CLI on each status poll.
const state = {
    loginUrl: null, // sign-in URL from the CLI, shown to the user
    loginInProgress: false, // an auth login child is running
    loginError: null, // last sign-in failure text
    connected: false, // last-observed CLI session state
};

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length === 0) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        return {};
    }
}

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
}

function scheduleSummary() {
    const hours = parseInt(process.env.BACKUP_INTERVAL_HOURS || '0', 10) || 0;
    if (hours <= 0) return 'On boot + manual only';
    return `Every ${hours} hour${hours === 1 ? '' : 's'} (+ boot)`;
}

async function buildStatus() {
    const status = orchestrator.getStatus();
    const connected = await cli.isConnected();
    state.connected = connected;
    if (connected) {
        state.loginUrl = null;
        state.loginError = null;
    }

    let backups = [];
    let backupsError = null;
    if (connected) {
        try {
            backups = await orchestrator.listProtonBackups();
        } catch (err) {
            backupsError = err.message;
        }
    }

    // Backup statistics (best-effort — never let a stats failure break status).
    // Mirror model: "In Home Assistant" counts ALL HA backups; "In Proton Drive"
    // counts the mirrored ones.
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
        stats = {
            haCount: haBackups.length,
            haSizeBytes: Math.round(haSizeMB * 1024 * 1024),
            protonCount: (backups || []).length,
            protonSizeBytes,
            hostDiskFreeBytes: gb(host?.disk_free),
            hostDiskTotalBytes: gb(host?.disk_total),
            lastBackup: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
        };
    } catch (err) {
        console.debug(`[ingress] stats: ${err.message}`);
    }

    const statusLabel = connected
        ? 'connected'
        : (state.loginInProgress || state.loginUrl)
          ? 'awaiting sign-in'
          : 'disconnected';

    return {
        status: statusLabel,
        connected,
        needsLogin: !connected,
        loginUrl: state.loginUrl,
        loginInProgress: state.loginInProgress,
        loginError: state.loginError,
        logLevel: getLogLevel(),
        schedule: scheduleSummary(),
        backupsInHA: parseInt(process.env.BACKUPS_IN_HA || '0', 10) || 0,
        lastSync: status.lastSync,
        lastError: status.lastError || backupsError,
        nextSyncEpoch: status.nextSyncEpoch,
        syncing: status.syncing,
        activity: status.activity,
        progress: status.progress,
        stats,
        backups,
    };
}

function renderPage() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proton Drive Backup</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 1.5rem; background: #f5f6f8; color: #1c1c1c; }
  h1 { font-size: 1.4rem; }
  .card { background: #fff; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; align-items: start; }
  .grid > .card { margin-bottom: 0; }
  @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
  .row { display: flex; justify-content: space-between; padding: .25rem 0; }
  .row span:first-child { color: #666; }
  .ok { color: #2e7d32; font-weight: 600; }
  .bad { color: #c62828; font-weight: 600; }
  button { cursor: pointer; border: none; border-radius: 6px; padding: .45rem .8rem; font-size: .85rem; }
  .primary { background: #6d4aff; color: #fff; }
  .restore { background: #1976d2; color: #fff; }
  .delete { background: #c62828; color: #fff; }
  .ghost { background: #eee; color: #333; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .5rem .4rem; border-bottom: 1px solid #eee; font-size: .9rem; word-break: break-all; }
  .err { color: #c62828; white-space: pre-wrap; }
  .actions button { margin-right: .35rem; }
  select { font-size: .85rem; border: 1px solid #ccc; border-radius: 4px; padding: .15rem .35rem; background: #fff; cursor: pointer; }
  .signin-link { display: inline-block; margin: .5rem 0; padding: .6rem .9rem; background: #6d4aff; color: #fff; border-radius: 6px; text-decoration: none; font-weight: 600; word-break: break-all; }
  .hint { color: #666; margin: .25rem 0 .5rem; }
  .statusline { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin-bottom: .6rem; }
  .badge { display: inline-flex; align-items: center; gap: .35rem; padding: .25rem .65rem; border-radius: 999px; font-size: .8rem; font-weight: 600; }
  .badge-ok { background: #e6f4ea; color: #2e7d32; }
  .badge-bad { background: #fdecea; color: #c62828; }
  .badge-sync { background: #ede7ff; color: #6d4aff; }
  .badge-idle { background: #eee; color: #666; }
  .dot { width: .55rem; height: .55rem; border-radius: 50%; background: currentColor; display: inline-block; }
  .spinner { width: .8rem; height: .8rem; border: 2px solid rgba(109,74,255,.3); border-top-color: #6d4aff; border-radius: 50%; display: inline-block; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .progress { height: .5rem; background: #eee; border-radius: 999px; overflow: hidden; margin: 0 0 .6rem; }
  .progress-bar { height: 100%; background: #6d4aff; border-radius: 999px; transition: width .3s ease; }
  .progress-indet { width: 40%; animation: indet 1.2s ease-in-out infinite; }
  @keyframes indet { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1c1e; color: #e3e3e3; }
    .card { background: #242628; box-shadow: 0 1px 3px rgba(0,0,0,.4); }
    .row span:first-child, .hint { color: #9aa0a6; }
    .ok { color: #5bd075; }
    .bad, .err { color: #ff6b6b; }
    .ghost { background: #37393c; color: #e3e3e3; }
    th, td { border-bottom-color: #37393c; }
    select { background: #2c2e30; color: #e3e3e3; border-color: #4a4d50; }
    .badge-ok { background: #12341c; color: #5bd075; }
    .badge-bad { background: #3a1414; color: #ff6b6b; }
    .badge-sync { background: #2a2350; color: #b3a4ff; }
    .badge-idle { background: #333; color: #aaa; }
    .progress { background: #37393c; }
  }
</style>
</head>
<body>
<h1>Proton Drive Backup</h1>
<div class="grid">
  <div class="card" id="statusCard">Loading…</div>
  <div class="card" id="statsCard" style="display:none"></div>
</div>
<div class="card" id="connectCard" style="display:none">
  <h2 style="font-size:1.1rem">Connect to Proton Drive</h2>
  <p class="hint" id="connectHint">Sign in to Proton Drive to start backing up. No password is stored here — you sign in through Proton in your browser.</p>
  <button class="primary" id="connectBtn">Connect</button>
  <div id="signinBox" style="display:none">
    <p class="hint">Open this link on any device (phone or PC) to sign in. Keep this page open — it will switch to "Connected" automatically once you finish.</p>
    <a class="signin-link" id="signinLink" href="#" target="_blank" rel="noopener">Open on any device to sign in</a>
  </div>
  <div class="err" id="connectError" style="margin-top:.5rem"></div>
</div>
<div class="card" id="connectedCard" style="display:none">
  <button class="ghost" id="disconnectBtn">Disconnect</button>
</div>
<div class="card">
  <button class="primary" id="createBackup" style="margin-right:.35rem">Create backup</button>
  <button class="primary" id="syncNow">Sync now</button>
  <button class="ghost" id="pruneHA" style="margin-left:.35rem">Clean up local backups</button>
  <p class="hint" id="createHint" style="margin:.5rem 0 0">Create backup makes a new Home Assistant backup now and uploads it. Sync now just uploads existing HA backups.</p>
  <p class="hint" id="pruneHint" style="margin:.5rem 0 0"></p>
</div>
<div class="card">
  <h2 style="font-size:1.1rem">Proton backups</h2>
  <table>
    <thead><tr><th>Date</th><th>Name</th><th>Size</th><th>Actions</th></tr></thead>
    <tbody id="backupRows"><tr><td colspan="4">Loading…</td></tr></tbody>
  </table>
</div>
<script>
function fmtSize(bytes) {
  if (bytes == null) return '';
  var n = Number(bytes);
  if (!isFinite(n)) return String(bytes);
  var units = ['B','KB','MB','GB','TB']; var i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + ' ' + units[i];
}
var backupsInHA = 0;
async function refresh() {
  try {
    var r = await fetch('api/status');
    var s = await r.json();
    var next = s.nextSyncEpoch ? new Date(s.nextSyncEpoch).toLocaleString() : '—';
    var syncing = !!s.syncing;
    var activity = s.activity || (syncing ? 'Syncing…' : 'Idle');
    var pct = (s.progress && s.progress.total) ? Math.round(s.progress.index / s.progress.total * 100) : null;
    var progressHtml = '';
    if (syncing) {
      progressHtml = '<div class="progress">' +
        (pct != null ? '<div class="progress-bar" style="width:' + pct + '%"></div>'
                     : '<div class="progress-bar progress-indet"></div>') +
        '</div>';
    }
    document.getElementById('statusCard').innerHTML =
      '<div class="statusline">' +
        '<span class="badge ' + (s.connected ? 'badge-ok' : 'badge-bad') + '"><span class="dot"></span>' + s.status + '</span>' +
        '<span class="badge ' + (syncing ? 'badge-sync' : 'badge-idle') + '">' + (syncing ? '<span class="spinner"></span>' : '') + activity + '</span>' +
      '</div>' +
      progressHtml +
      '<div class="row"><span>Schedule</span><span>' + (s.schedule || '') + '</span></div>' +
      '<div class="row"><span>Last sync</span><span>' + (s.lastSync ? new Date(s.lastSync).toLocaleString() : 'never') + '</span></div>' +
      '<div class="row"><span>Next sync</span><span>' + next + '</span></div>' +
      '<div class="row"><span>Log level</span><span>' +
        '<select id="logLevel" onchange="changeLogLevel(this.value)">' +
        ['error','warning','info','debug'].map(function(l){ return '<option value="'+l+'"'+(s.logLevel===l?' selected':'')+'>'+l+'</option>'; }).join('') +
        '</select>' +
      '</span></div>' +
      (s.lastError ? '<div class="row"><span>Last error</span><span class="err">' + s.lastError + '</span></div>' : '');

    var syncBtn = document.getElementById('syncNow');
    syncBtn.disabled = syncing;
    syncBtn.textContent = syncing ? 'Syncing…' : 'Sync now';

    var createBtn = document.getElementById('createBackup');
    createBtn.disabled = syncing || !s.connected;
    createBtn.textContent = syncing ? 'Working…' : 'Create backup';

    backupsInHA = s.backupsInHA || 0;
    var retentionOff = backupsInHA <= 0;
    var pruneBtn = document.getElementById('pruneHA');
    pruneBtn.disabled = syncing || retentionOff;
    document.getElementById('pruneHint').textContent = retentionOff
      ? 'Local clean-up is off (backups_in_ha = 0). Set it to keep only the newest N in Home Assistant.'
      : 'Deletes local HA backups beyond the newest ' + backupsInHA + ' — only ones already copied to Proton.';

    var statsCard = document.getElementById('statsCard');
    if (s.stats) {
      var st = s.stats;
      statsCard.style.display = 'block';
      statsCard.innerHTML =
        '<h2 style="font-size:1.1rem;margin-top:0">Backup statistics</h2>' +
        '<div class="row"><span>In Home Assistant</span><span>' + st.haCount + ' (' + fmtSize(st.haSizeBytes) + ')</span></div>' +
        '<div class="row"><span>In Proton Drive</span><span>' + st.protonCount + ' (' + fmtSize(st.protonSizeBytes) + ')</span></div>' +
        (st.hostDiskFreeBytes != null
          ? '<div class="row"><span>Host disk free</span><span>' + fmtSize(st.hostDiskFreeBytes) +
            (st.hostDiskTotalBytes ? ' / ' + fmtSize(st.hostDiskTotalBytes) : '') + '</span></div>'
          : '') +
        '<div class="row"><span>Last backup</span><span>' + (st.lastBackup ? new Date(st.lastBackup).toLocaleString() : '—') + '</span></div>' +
        '<div class="row"><span>Next sync</span><span>' + next + '</span></div>';
    } else {
      statsCard.style.display = 'none';
    }

    // Connect / Connected cards.
    document.getElementById('connectedCard').style.display = s.connected ? 'block' : 'none';
    document.getElementById('connectCard').style.display = s.connected ? 'none' : 'block';
    var signinBox = document.getElementById('signinBox');
    var signinLink = document.getElementById('signinLink');
    var connectErr = document.getElementById('connectError');
    connectErr.textContent = s.loginError || '';
    if (!s.connected && s.loginUrl) {
      signinBox.style.display = 'block';
      if (signinLink.getAttribute('href') !== s.loginUrl) signinLink.setAttribute('href', s.loginUrl);
    } else {
      signinBox.style.display = 'none';
      signinLink.setAttribute('href', '#');
    }
    var connectBtn = document.getElementById('connectBtn');
    connectBtn.disabled = !!s.loginInProgress;
    connectBtn.textContent = s.loginInProgress ? 'Waiting for sign-in…' : (s.loginUrl ? 'Restart sign-in' : 'Connect');

    var rows = (s.backups || []).slice().sort(function(a,b){ return (new Date(b.date || 0)) - (new Date(a.date || 0)); });
    var tbody = document.getElementById('backupRows');
    if (rows.length === 0) { tbody.innerHTML = '<tr><td colspan="4">No backups in Proton Drive</td></tr>'; return; }
    tbody.innerHTML = rows.map(function(b){
      return '<tr><td>' + (b.date ? new Date(b.date).toLocaleString() : '') + '</td>' +
        '<td>' + (b.name || '') + '</td>' +
        '<td>' + fmtSize(b.size) + '</td>' +
        '<td class="actions">' +
          '<button class="restore" data-name="' + encodeURIComponent(b.name) + '">Restore</button>' +
          '<button class="delete" data-name="' + encodeURIComponent(b.name) + '">Delete</button>' +
        '</td></tr>';
    }).join('');
    tbody.querySelectorAll('.restore').forEach(function(btn){ btn.onclick = function(){ act('api/restore', decodeURIComponent(btn.dataset.name), 'Restore this backup to Home Assistant?'); }; });
    tbody.querySelectorAll('.delete').forEach(function(btn){ btn.onclick = function(){ act('api/delete', decodeURIComponent(btn.dataset.name), 'Delete this backup from Proton Drive?'); }; });
  } catch (e) {
    document.getElementById('statusCard').innerHTML = '<span class="err">Failed to load status: ' + e + '</span>';
  }
}
async function act(path, name, confirmMsg) {
  if (confirmMsg && !confirm(confirmMsg)) return;
  try {
    var r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) });
    var j = await r.json();
    if (!j.ok) alert('Error: ' + (j.error || 'unknown'));
  } catch (e) { alert('Error: ' + e); }
  refresh();
}
document.getElementById('syncNow').onclick = async function(){
  var btn = this; btn.disabled = true; btn.textContent = 'Syncing…';
  try {
    await fetch('api/sync-now', { method: 'POST' });
  } catch (e) { alert('Error: ' + e); }
  refresh();
};
document.getElementById('createBackup').onclick = async function(){
  if (!confirm('Create a new Home Assistant backup now and upload it to Proton?')) return;
  var btn = this; btn.disabled = true; btn.textContent = 'Working…';
  try {
    await fetch('api/create-backup', { method: 'POST' });
  } catch (e) { alert('Error: ' + e); }
  refresh();
};
document.getElementById('pruneHA').onclick = async function(){
  if (!confirm('Delete local HA backups beyond the newest ' + backupsInHA + ' that are already copied to Proton?')) return;
  var btn = this; btn.disabled = true;
  try {
    var r = await fetch('api/prune-ha', { method: 'POST' });
    var j = await r.json();
    if (!j.ok) alert('Error: ' + (j.error || 'unknown'));
    else alert('Deleted ' + j.deleted + ', skipped ' + j.skippedNotInProton + ' not yet in Proton');
  } catch (e) { alert('Error: ' + e); }
  refresh();
};
document.getElementById('connectBtn').onclick = async function(){
  var btn = this; btn.disabled = true;
  document.getElementById('connectError').textContent = '';
  try {
    var r = await fetch('api/connect', { method: 'POST' });
    var j = await r.json();
    if (!j.started && j.error) document.getElementById('connectError').textContent = j.error;
  } catch (e) { document.getElementById('connectError').textContent = String(e); }
  refresh();
};
document.getElementById('disconnectBtn').onclick = async function(){
  if (!confirm('Disconnect from Proton Drive?')) return;
  try {
    await fetch('api/disconnect', { method: 'POST' });
  } catch (e) { alert('Error: ' + e); }
  refresh();
};
async function changeLogLevel(level) {
  try {
    await fetch('api/log-level', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: level }),
    });
  } catch (e) { /* level resets on next refresh if this fails */ }
}
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
}

export function startIngressServer() {
    const port = parseInt(process.env.PORT || '8099', 10);

    const server = createServer((req, res) => {
        handle(req, res).catch((err) => {
            console.error(`[ingress] Unhandled error: ${err.message}`);
            if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message });
        });
    });

    server.listen(port, () => {
        console.log(`[ingress] Listening on port ${port}`);
    });
    return server;
}

async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method || 'GET';
    console.debug(`[ingress] ${method} ${path}`);

    if (method === 'GET' && path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderPage());
        return;
    }

    if (method === 'GET' && path === '/api/status') {
        sendJson(res, 200, await buildStatus());
        return;
    }

    if (method === 'GET' && path === '/api/log-level') {
        sendJson(res, 200, { level: getLogLevel() });
        return;
    }

    if (method === 'POST' && path === '/api/log-level') {
        const body = await readBody(req);
        try {
            setLogLevel(body.level);
            sendJson(res, 200, { ok: true, level: getLogLevel() });
        } catch (err) {
            sendJson(res, 400, { ok: false, error: err.message });
        }
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
                    state.connected = true;
                    console.log('[ingress] Sign-in complete — connected');
                    orchestrator.runSync().catch((err) => console.error(`[ingress] post-login sync: ${err.message}`));
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
        state.connected = false;
        state.loginUrl = null;
        state.loginInProgress = false;
        state.loginError = null;
        sendJson(res, 200, { ok: true });
        return;
    }

    if (method === 'POST' && path === '/api/create-backup') {
        orchestrator.createBackupNow().catch((err) => console.error(`[ingress] create-backup: ${err.message}`));
        sendJson(res, 200, { started: true });
        return;
    }

    if (method === 'POST' && path === '/api/sync-now') {
        // Upload existing HA backups now. Kick off but don't block the response
        // on full completion.
        orchestrator.runSync(true).catch((err) => console.error(`[ingress] sync-now: ${err.message}`));
        sendJson(res, 200, { ok: true });
        return;
    }

    if (method === 'POST' && path === '/api/prune-ha') {
        // Manual local clean-up: delete local HA backups beyond the newest N,
        // but only ones confirmed present in Proton. Await so the UI can report.
        try {
            const result = await orchestrator.pruneHALocalNow();
            sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
            sendJson(res, 500, { ok: false, error: err.message });
        }
        return;
    }

    if (method === 'POST' && path === '/api/restore') {
        const body = await readBody(req);
        if (!body.name) return sendJson(res, 400, { ok: false, error: 'name required' });
        try {
            const result = await orchestrator.restoreToHA(body.name);
            sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
            sendJson(res, 500, { ok: false, error: err.message });
        }
        return;
    }

    if (method === 'POST' && path === '/api/delete') {
        const body = await readBody(req);
        if (!body.name) return sendJson(res, 400, { ok: false, error: 'name required' });
        try {
            await orchestrator.deleteProtonBackup(body.name);
            sendJson(res, 200, { ok: true });
        } catch (err) {
            sendJson(res, 500, { ok: false, error: err.message });
        }
        return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
}
