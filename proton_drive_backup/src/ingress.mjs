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
import { getLogLevel, logLevels, setLogLevelStrict } from './logger.mjs';

// UI-facing login state. The live connection state is not kept here — it comes
// from the cached snapshot (cli.isConnected()) on every status poll.
const state = {
    loginUrl: null, // sign-in URL from the CLI, shown to the user
    loginInProgress: false, // an auth login child is running
    loginError: null, // last sign-in failure text
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

async function getSnapshot() {
    if (snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS) return snapshot;
    if (snapshotInFlight) return snapshotInFlight;
    snapshotInFlight = buildSnapshot()
        .then((s) => { snapshot = s; return s; })
        .finally(() => { snapshotInFlight = null; });
    return snapshotInFlight;
}

async function buildStatus() {
    const status = orchestrator.getStatus();
    const snap = await getSnapshot();
    const { connected, backups, backupsError, stats } = snap;
    if (connected) {
        state.loginUrl = null;
        state.loginError = null;
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
        backups,
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
  <div class="card" id="settingsCard" style="display:none"></div>
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
// EVERY piece of server-provided text goes through esc() before it reaches
// innerHTML: backup names, CLI stderr in lastError, and exception text are all
// attacker-influencable (a backup literally named "<img src=x onerror=…>" used
// to execute in this iframe on every poll).
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function(c){
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function fmtSize(bytes) {
  if (bytes == null) return '';
  var n = Number(bytes);
  if (!isFinite(n)) return String(bytes);
  var units = ['B','KB','MB','GB','TB']; var i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + ' ' + units[i];
}
var keepAutomaticInHA = 0;
var keepAppInHA = 0;
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
        '<span class="badge ' + (s.connected ? 'badge-ok' : 'badge-bad') + '"><span class="dot"></span>' + esc(s.status) + '</span>' +
        '<span class="badge ' + (syncing ? 'badge-sync' : 'badge-idle') + '">' + (syncing ? '<span class="spinner"></span>' : '') + esc(activity) + '</span>' +
      '</div>' +
      progressHtml +
      '<div class="row"><span>Schedule</span><span>' + esc(s.schedule || '') + '</span></div>' +
      '<div class="row"><span>Last sync</span><span>' + esc(s.lastSync ? new Date(s.lastSync).toLocaleString() : 'never') + '</span></div>' +
      '<div class="row"><span>Next sync</span><span>' + esc(next) + '</span></div>' +
      '<div class="row"><span>Log level</span><span>' +
        '<select id="logLevel" onchange="changeLogLevel(this.value)">' +
        (s.logLevels || ['error','warning','info','debug']).map(function(l){ return '<option value="'+esc(l)+'"'+(s.logLevel===l?' selected':'')+'>'+esc(l)+'</option>'; }).join('') +
        '</select>' +
      '</span></div>' +
      (s.lastError ? '<div class="row"><span>Last error</span><span class="err">' + esc(s.lastError) + ' <button class="ghost" style="padding:.1rem .5rem;font-size:.75rem" onclick="clearErr()">Clear</button></span></div>' : '');

    var syncBtn = document.getElementById('syncNow');
    syncBtn.disabled = syncing;
    syncBtn.textContent = syncing ? 'Syncing…' : 'Sync now';

    var createBtn = document.getElementById('createBackup');
    createBtn.disabled = syncing || !s.connected;
    createBtn.textContent = syncing ? 'Working…' : 'Create backup';

    keepAutomaticInHA = (s.settings && s.settings.keepAutomaticInHA) || 0;
    keepAppInHA = (s.settings && s.settings.keepAppInHA) || 0;
    var retentionOff = keepAutomaticInHA <= 0 && keepAppInHA <= 0;
    var pruneBtn = document.getElementById('pruneHA');
    pruneBtn.disabled = syncing || retentionOff;
    document.getElementById('pruneHint').textContent = retentionOff
      ? 'Local clean-up is off (keep_automatic_in_ha and keep_app_in_ha are both 0). Set one to keep only the newest N in Home Assistant.'
      : 'Deletes local HA backups beyond the newest ' + keepAutomaticInHA + ' automatic / ' + keepAppInHA + ' app — only ones already copied to Proton.';

    var statsCard = document.getElementById('statsCard');
    if (s.stats) {
      var st = s.stats;
      var bucketLine = function(auto, app){
        if (auto == null || app == null) return '';
        return auto + ' automatic, ' + app + ' app';
      };
      var haBuckets = bucketLine(st.haAutomaticCount, st.haAppCount);
      var protonBuckets = bucketLine(st.protonAutomaticCount, st.protonAppCount);
      statsCard.style.display = 'block';
      statsCard.innerHTML =
        '<h2 style="font-size:1.1rem;margin-top:0">Backup statistics</h2>' +
        '<div class="row"><span>In Home Assistant</span><span>' + esc(haBuckets || st.haCount) + ' (' + esc(fmtSize(st.haSizeBytes)) + ')</span></div>' +
        '<div class="row"><span>In Proton Drive</span><span>' + esc(protonBuckets || st.protonCount) + ' (' + esc(fmtSize(st.protonSizeBytes)) + ')</span></div>' +
        (st.hostDiskFreeBytes != null
          ? '<div class="row"><span>Host disk free</span><span>' + esc(fmtSize(st.hostDiskFreeBytes)) +
            (st.hostDiskTotalBytes ? ' / ' + esc(fmtSize(st.hostDiskTotalBytes)) : '') + '</span></div>'
          : '') +
        '<div class="row"><span>Last backup</span><span>' + esc(st.lastBackup ? new Date(st.lastBackup).toLocaleString() : '—') + '</span></div>' +
        '<div class="row"><span>Next sync</span><span>' + esc(next) + '</span></div>';
    } else {
      statsCard.style.display = 'none';
    }

    var settingsCard = document.getElementById('settingsCard');
    var cfg = s.settings;
    if (cfg) {
      var protonKeep = function(n){ return (n && n > 0) ? String(n) : 'all'; };
      var haKeep = function(n){ return (n && n > 0) ? String(n) : 'off'; };
      settingsCard.style.display = 'block';
      settingsCard.innerHTML =
        '<h2 style="font-size:1.1rem;margin-top:0">Settings</h2>' +
        '<div class="row"><span>Drive folder</span><span>' + esc(cfg.driveFolder || '') + '</span></div>' +
        '<div class="row"><span>Sync interval</span><span>' + esc(s.schedule || '') + '</span></div>' +
        '<div class="row"><span>Keep automatic in Proton</span><span>' + esc(protonKeep(cfg.keepAutomaticInProton)) + '</span></div>' +
        '<div class="row"><span>Keep app in Proton</span><span>' + esc(protonKeep(cfg.keepAppInProton)) + '</span></div>' +
        '<div class="row"><span>Keep automatic in HA (manual cleanup)</span><span>' + esc(haKeep(cfg.keepAutomaticInHA)) + '</span></div>' +
        '<div class="row"><span>Keep app in HA (manual cleanup)</span><span>' + esc(haKeep(cfg.keepAppInHA)) + '</span></div>' +
        '<div class="row"><span>Backup password</span><span>' + (cfg.backupPasswordSet ? 'Set' : 'Not set') + '</span></div>' +
        (cfg.stagingDir ? '<div class="row"><span>Staging dir (STAGING_DIR env override)</span><span>' + esc(cfg.stagingDir) + '</span></div>' : '');
    } else {
      settingsCard.style.display = 'none';
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
      return '<tr><td>' + esc(b.date ? new Date(b.date).toLocaleString() : '') + '</td>' +
        '<td>' + esc(b.name || '') + '</td>' +
        '<td>' + esc(fmtSize(b.size)) + '</td>' +
        '<td class="actions">' +
          '<button class="restore" data-name="' + encodeURIComponent(b.name) + '">Restore</button>' +
          '<button class="delete" data-name="' + encodeURIComponent(b.name) + '">Delete</button>' +
        '</td></tr>';
    }).join('');
    tbody.querySelectorAll('.restore').forEach(function(btn){ btn.onclick = function(){ act('api/restore', decodeURIComponent(btn.dataset.name),
      'Restore this backup to Home Assistant?\n\nThe download + restore runs in the background and can take a long time; progress and any error appear in the status card above.',
      'Restore started. Watch the status card above for progress; Home Assistant will restart when it finishes.'); }; });
    tbody.querySelectorAll('.delete').forEach(function(btn){ btn.onclick = function(){ act('api/delete', decodeURIComponent(btn.dataset.name), 'Delete this backup from Proton Drive?'); }; });
    scheduleNextPoll(s);
  } catch (e) {
    document.getElementById('statusCard').innerHTML = '<span class="err">Failed to load status: ' + esc(e && e.message ? e.message : e) + '</span>';
    scheduleNextPoll(null);
  }
}
// Poll fast only while something is actually happening; the server caches the
// expensive lookups anyway, so idle tabs shouldn't hammer it.
var pollTimer = null;
function scheduleNextPoll(s) {
  var busy = !!(s && (s.syncing || s.loginInProgress || s.loginUrl));
  var delay = document.hidden ? 60000 : (busy ? 5000 : 20000);
  clearTimeout(pollTimer);
  pollTimer = setTimeout(refresh, delay);
}
document.addEventListener('visibilitychange', function(){ if (!document.hidden) refresh(); });
async function act(path, name, confirmMsg, startedMsg) {
  if (confirmMsg && !confirm(confirmMsg)) return;
  try {
    var r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) });
    var j = await r.json();
    if (!j.ok) alert('Error: ' + (j.error || 'unknown'));
    else if (startedMsg) alert(startedMsg);
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
  if (!confirm('Delete local HA backups beyond the newest ' + keepAutomaticInHA + ' automatic / ' + keepAppInHA + ' app that are already copied to Proton?')) return;
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
async function clearErr() {
  try { await fetch('api/clear-error', { method: 'POST' }); } catch (e) { /* refresh will re-show if it failed */ }
  refresh();
}
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
            // Strict here (unlike boot): garbage from the API is a 400, not a
            // silent fallback to info.
            setLogLevelStrict(body.level);
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
                    console.log('[ingress] Sign-in complete — connected');
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
        invalidateSnapshot();
        orchestrator.createBackupNow()
            .catch((err) => console.error(`[ingress] create-backup: ${err.message}`))
            .finally(invalidateSnapshot);
        sendJson(res, 200, { started: true });
        return;
    }

    if (method === 'POST' && path === '/api/clear-error') {
        orchestrator.clearError();
        sendJson(res, 200, { ok: true });
        return;
    }

    if (method === 'POST' && path === '/api/sync-now') {
        // Upload existing HA backups now. Kick off but don't block the response
        // on full completion.
        invalidateSnapshot();
        orchestrator.runSync(true)
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
            sendJson(res, 500, { ok: false, error: err.message });
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
        // should wait. Progress/errors surface via /api/status.
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
            sendJson(res, 500, { ok: false, error: err.message });
        }
        return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
}
