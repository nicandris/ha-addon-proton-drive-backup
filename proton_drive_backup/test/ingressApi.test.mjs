/**
 * Ingress HTTP endpoint tests — previously untested entirely, so the traversal
 * rejections, the settings validation and the status shape were only ever verified
 * by hand.
 *
 * The server is started on port 0 (`PORT=0`) and driven with real HTTP. `/api/status`
 * is answered from the cache without blocking (stale-while-revalidate, 0.4.7), so
 * these tests don't need the Proton CLI or a Supervisor to be reachable.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

console.debug = () => {};
console.log = () => {};
console.warn = () => {};
console.error = () => {};

process.env.PORT = '0';
process.env.DATA_DIR = '/tmp';
process.env.PROTON_DRIVE_BIN = '/nonexistent-proton-drive'; // never resolves; must not hang a request
process.env.SUPERVISOR_URL = 'http://127.0.0.1:1';          // refused; must not hang a request

const { startIngressServer } = await import('../src/ingress.mjs');

let base;
let server;

before(async () => {
    server = startIngressServer();
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.closeAllConnections?.(); server.close(); });

const post = (path, body) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
});

test('GET / serves the page', async () => {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    const html = await r.text();
    assert.ok(html.includes('Proton Drive Backup'));
});

test('GET /api/status answers immediately with the documented shape', async () => {
    const t0 = Date.now();
    const r = await fetch(`${base}/api/status`);
    const elapsed = Date.now() - t0;
    assert.equal(r.status, 200);
    const s = await r.json();
    // Must not block on the CLI/Supervisor (both unreachable here).
    assert.ok(elapsed < 1000, `status took ${elapsed}ms — it must not block`);
    for (const k of ['status', 'pending', 'connected', 'needsLogin', 'logLevel', 'schedule',
                     'settings', 'lastSync', 'nextSyncEpoch', 'syncing', 'backups']) {
        assert.ok(k in s, `missing key ${k}`);
    }
    assert.ok(Array.isArray(s.backups));
    // The password must never leave the process.
    assert.equal('backupPassword' in s.settings, false);
    assert.equal(typeof s.settings.backupPasswordSet, 'boolean');
});

test('unknown routes 404 as JSON', async () => {
    const r = await fetch(`${base}/api/nope`);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).ok, false);
});

test('delete/restore require a name', async () => {
    for (const p of ['/api/delete', '/api/restore']) {
        const r = await post(p, {});
        assert.equal(r.status, 400, p);
        assert.match((await r.json()).error, /name required/i);
    }
});

test('delete/restore reject traversal and non-.tar names', async () => {
    const payloads = ['../../etc/passwd.tar', 'a/b.tar', '..', 'x.txt', '/abs/path.tar', './x.tar'];
    for (const p of ['/api/delete', '/api/restore']) {
        for (const name of payloads) {
            const r = await post(p, { name });
            assert.equal(r.status, 400, `${p} accepted ${name}`);
            assert.match((await r.json()).error, /invalid backup name/i, `${p} ${name}`);
        }
    }
});

test('POST /api/settings rejects invalid values and the backup password', async () => {
    const cases = [
        [{ keepAppInProton: -1 }, /whole number/],
        [{ keepAppInProton: 1.5 }, /whole number/],
        [{ backupPassword: 'secret' }, /not an editable setting/],
        [{ driveFolder: '' }, /must not be empty/],
        [{ driveFolder: '../escape' }, /relative path/],
        [{}, /no settings supplied/],
    ];
    for (const [body, re] of cases) {
        const r = await post('/api/settings', body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.match((await r.json()).error, re, JSON.stringify(body));
    }
});

test('POST /api/log-level validates, and a good value takes effect', async () => {
    const bad = await post('/api/log-level', { level: 'bogus' });
    assert.equal(bad.status, 400);
    const ok = await post('/api/log-level', { level: 'debug' });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).level, 'debug');
    // Every level HA offers must be accepted here too (0.4.1 crash-loop lesson).
    for (const level of ['trace', 'notice', 'fatal', 'warning', 'error', 'info']) {
        const r = await post('/api/log-level', { level });
        assert.equal(r.status, 200, `HA level ${level} rejected`);
    }
    await post('/api/log-level', { level: 'error' }); // quiet again
});

test('POST /api/clear-error is accepted and clears', async () => {
    const r = await post('/api/clear-error');
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
    const s = await (await fetch(`${base}/api/status`)).json();
    assert.equal(s.lastError, null);
});

test('sync-now / create-backup return immediately rather than blocking on the CLI', async () => {
    for (const p of ['/api/sync-now', '/api/create-backup']) {
        const t0 = Date.now();
        const r = await post(p);
        assert.equal(r.status, 200, p);
        assert.ok(Date.now() - t0 < 1000, `${p} blocked`);
    }
});
