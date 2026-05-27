/**
 * Minimal ingress HTTP server for the add-on UI.
 *
 * Home Assistant ingress handles authentication, so this server is unauthenticated.
 * It serves a small self-contained HTML page plus a handful of JSON endpoints
 * that the page calls to show status and trigger sync / restore / delete.
 */

import { createServer } from 'node:http';

import * as proton from './protonClient.mjs';
import * as orchestrator from './orchestrator.mjs';
import { getAuthState, submitTwoFactorCode } from './protonAuth.mjs';

function driveFolder() {
    return process.env.DRIVE_FOLDER || 'Home Assistant Backups';
}

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
    if (hours <= 0) return 'Automatic backups disabled';
    return `Every ${hours} hour${hours === 1 ? '' : 's'}`;
}

async function buildStatus() {
    const auth = getAuthState();
    const status = orchestrator.getStatus();
    let backups = [];
    let backupsError = null;
    // Only the connected client can list backups; skip the call (and its
    // inevitable error) while we're waiting for a 2FA code or disconnected.
    if (auth.connected) {
        try {
            const raw = await proton.listBackups(driveFolder());
            backups = raw.map((b) => ({ linkId: b.linkId, ...b.metadata }));
        } catch (err) {
            backupsError = err.message;
        }
    }
    return {
        status: auth.connected ? 'connected' : auth.needsTwoFactor ? 'needs 2FA' : 'disconnected',
        needsTwoFactor: auth.needsTwoFactor,
        email: auth.email,
        schedule: scheduleSummary(),
        lastSync: status.lastSync,
        lastError: status.lastError || backupsError,
        nextSyncEpoch: status.nextSyncEpoch,
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
  .row { display: flex; justify-content: space-between; padding: .25rem 0; }
  .row span:first-child { color: #666; }
  .ok { color: #2e7d32; font-weight: 600; }
  .bad { color: #c62828; font-weight: 600; }
  button { cursor: pointer; border: none; border-radius: 6px; padding: .45rem .8rem; font-size: .85rem; }
  .primary { background: #6d4aff; color: #fff; }
  .restore { background: #1976d2; color: #fff; }
  .delete { background: #c62828; color: #fff; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .5rem .4rem; border-bottom: 1px solid #eee; font-size: .9rem; }
  .err { color: #c62828; white-space: pre-wrap; }
  .actions button { margin-right: .35rem; }
</style>
</head>
<body>
<h1>Proton Drive Backup</h1>
<div class="card" id="statusCard">Loading…</div>
<div class="card" id="twoFactorCard" style="display:none">
  <h2 style="font-size:1.1rem">Two-factor authentication</h2>
  <p style="color:#666;margin:.25rem 0 .75rem">Enter the current 6-digit code from your authenticator app to connect.</p>
  <input id="twoFactorCode" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="123456" style="padding:.45rem;font-size:1rem;width:7rem;letter-spacing:.2em;border:1px solid #ccc;border-radius:6px;">
  <button class="primary" id="twoFactorSubmit">Connect</button>
  <div class="err" id="twoFactorError" style="margin-top:.5rem"></div>
</div>
<div class="card">
  <button class="primary" id="backupNow">Back up now</button>
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
  // HA reports size in MB (float) for backups; show as-is if small, else bytes.
  if (n < 10000) return n.toFixed(1) + ' MB';
  var units = ['B','KB','MB','GB','TB']; var i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + ' ' + units[i];
}
async function refresh() {
  try {
    var r = await fetch('api/status');
    var s = await r.json();
    var next = s.nextSyncEpoch ? new Date(s.nextSyncEpoch).toLocaleString() : '—';
    document.getElementById('statusCard').innerHTML =
      '<div class="row"><span>Connection</span><span class="' + (s.status === 'connected' ? 'ok' : 'bad') + '">' + s.status + (s.email ? ' (' + s.email + ')' : '') + '</span></div>' +
      '<div class="row"><span>Schedule</span><span>' + (s.schedule || '') + '</span></div>' +
      '<div class="row"><span>Last sync</span><span>' + (s.lastSync ? new Date(s.lastSync).toLocaleString() : 'never') + '</span></div>' +
      '<div class="row"><span>Next sync</span><span>' + next + '</span></div>' +
      (s.lastError ? '<div class="row"><span>Last error</span><span class="err">' + s.lastError + '</span></div>' : '');
    document.getElementById('twoFactorCard').style.display = s.needsTwoFactor ? 'block' : 'none';
    var rows = (s.backups || []).slice().sort(function(a,b){ return new Date(b.date||0) - new Date(a.date||0); });
    var tbody = document.getElementById('backupRows');
    if (rows.length === 0) { tbody.innerHTML = '<tr><td colspan="4">No backups in Proton Drive</td></tr>'; return; }
    tbody.innerHTML = rows.map(function(b){
      return '<tr><td>' + (b.date ? new Date(b.date).toLocaleString() : '') + '</td>' +
        '<td>' + (b.name || '') + '</td>' +
        '<td>' + fmtSize(b.size) + '</td>' +
        '<td class="actions">' +
          '<button class="restore" data-id="' + b.linkId + '">Restore</button>' +
          '<button class="delete" data-id="' + b.linkId + '">Delete</button>' +
        '</td></tr>';
    }).join('');
    tbody.querySelectorAll('.restore').forEach(function(btn){ btn.onclick = function(){ act('api/restore', btn.dataset.id, 'Restore this backup to Home Assistant?'); }; });
    tbody.querySelectorAll('.delete').forEach(function(btn){ btn.onclick = function(){ act('api/delete', btn.dataset.id, 'Delete this backup from Proton Drive?'); }; });
  } catch (e) {
    document.getElementById('statusCard').innerHTML = '<span class="err">Failed to load status: ' + e + '</span>';
  }
}
async function act(path, linkId, confirmMsg) {
  if (confirmMsg && !confirm(confirmMsg)) return;
  try {
    var r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ linkId: linkId }) });
    var j = await r.json();
    if (!j.ok) alert('Error: ' + (j.error || 'unknown'));
  } catch (e) { alert('Error: ' + e); }
  refresh();
}
document.getElementById('backupNow').onclick = function(){ act('api/backup-now', null, 'Start a backup now?'); };
document.getElementById('twoFactorSubmit').onclick = async function(){
  var code = document.getElementById('twoFactorCode').value.trim();
  var errEl = document.getElementById('twoFactorError');
  errEl.textContent = '';
  if (!code) { errEl.textContent = 'Enter the 6-digit code.'; return; }
  try {
    var r = await fetch('api/2fa', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code }) });
    var j = await r.json();
    if (!j.ok) { errEl.textContent = j.error || 'Failed'; return; }
    document.getElementById('twoFactorCode').value = '';
  } catch (e) { errEl.textContent = String(e); return; }
  refresh();
};
document.getElementById('twoFactorCode').addEventListener('keydown', function(e){ if (e.key === 'Enter') document.getElementById('twoFactorSubmit').click(); });
refresh();
setInterval(refresh, 10000);
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

    if (method === 'GET' && path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderPage());
        return;
    }

    if (method === 'GET' && path === '/api/status') {
        sendJson(res, 200, await buildStatus());
        return;
    }

    if (method === 'POST' && path === '/api/2fa') {
        const body = await readBody(req);
        const code = (body.code || '').toString().trim();
        if (!code) return sendJson(res, 400, { ok: false, error: 'code required' });
        try {
            await submitTwoFactorCode(code);
            // Now connected — kick off a sync without blocking the response.
            orchestrator.runSync().catch((err) => console.error(`[ingress] post-2fa sync: ${err.message}`));
            sendJson(res, 200, { ok: true });
        } catch (err) {
            sendJson(res, 500, { ok: false, error: err.message });
        }
        return;
    }

    if (method === 'POST' && path === '/api/backup-now') {
        // Kick off but don't block the response on full completion.
        orchestrator.runSync().catch((err) => console.error(`[ingress] backup-now: ${err.message}`));
        sendJson(res, 200, { ok: true });
        return;
    }

    if (method === 'POST' && path === '/api/restore') {
        const body = await readBody(req);
        if (!body.linkId) return sendJson(res, 400, { ok: false, error: 'linkId required' });
        try {
            const result = await orchestrator.restoreToHA(body.linkId);
            sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
            sendJson(res, 500, { ok: false, error: err.message });
        }
        return;
    }

    if (method === 'POST' && path === '/api/delete') {
        const body = await readBody(req);
        if (!body.linkId) return sendJson(res, 400, { ok: false, error: 'linkId required' });
        try {
            await proton.deleteBackup(body.linkId);
            sendJson(res, 200, { ok: true });
        } catch (err) {
            sendJson(res, 500, { ok: false, error: err.message });
        }
        return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
}
