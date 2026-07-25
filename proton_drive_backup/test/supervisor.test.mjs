/**
 * Supervisor client tests against a real local HTTP fixture server (BASE_URL is
 * overridable via SUPERVISOR_URL, read once at import — so the server must be
 * listening before the dynamic import below).
 *
 * Focus: the shared `{result,data,message}` envelope handling, and that the two
 * long-running calls (`createBackup` / `restoreBackup`) go over `node:http`
 * rather than global fetch — undici imposes a ~300 s headers timeout that made a
 * multi-GB backup "fail" (`UND_ERR_HEADERS_TIMEOUT`) while HA kept working.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, globalAgent } from 'node:http';

console.debug = () => {};

// Per-path canned responses: { status, body, delayMs } — set by each test.
const routes = new Map();
const seen = [];

const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const key = `${req.method} ${req.url}`;
        const route = routes.get(key) || { status: 404, body: { result: 'error', message: 'no fixture' } };
        const raw = Buffer.concat(chunks);
        // Only JSON bodies get parsed. uploadBackup sends multipart/form-data —
        // JSON.parse-ing that threw inside this handler, so the response was never
        // sent and the upload waited forever (hanging the whole test file).
        const isJson = (req.headers['content-type'] || '').includes('application/json');
        seen.push({
            key,
            body: isJson && raw.length ? JSON.parse(raw.toString('utf8')) : null,
            rawBytes: raw.length,
            contentType: req.headers['content-type'] || null,
            // Node lowercases header names.
            ua: req.headers['user-agent'] || null,
            auth: req.headers.authorization || null,
        });
        const send = () => {
            res.writeHead(route.status, { 'Content-Type': 'application/json' });
            res.end(typeof route.body === 'string' ? route.body : JSON.stringify(route.body));
        };
        if (route.delayMs) setTimeout(send, route.delayMs); else send();
    });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.SUPERVISOR_URL = `http://127.0.0.1:${server.address().port}`;
process.env.SUPERVISOR_TOKEN = 'test-token';

const supervisor = await import('../src/supervisor.mjs');

after(() => {
    // undici (global fetch) keeps its sockets alive, so a plain close() would
    // wait forever for them and hang the test process. node:http's global agent
    // also pools keep-alive client sockets (keepAlive defaults to true since
    // Node 19) — those live in this same process, so destroy them too.
    globalAgent.destroy();
    server.closeAllConnections();
    server.close();
});

test('listBackups unwraps data.backups', async () => {
    routes.set('GET /backups', { status: 200, body: { result: 'ok', data: { backups: [{ slug: 's1', size: 12.5 }] } } });
    const backups = await supervisor.listBackups();
    assert.deepEqual(backups, [{ slug: 's1', size: 12.5 }]);
});

test('a Supervisor error envelope becomes a thrown Error with the message', async () => {
    routes.set('GET /backups', { status: 200, body: { result: 'error', message: 'not authorized' } });
    await assert.rejects(() => supervisor.listBackups(), /not authorized/);
});

test('createBackup posts to /backups/new/full over node:http and returns the slug', async () => {
    routes.set('POST /backups/new/full', {
        status: 200,
        // A short delay proves the response is awaited, not raced.
        delayMs: 50,
        body: { result: 'ok', data: { slug: 'newslug' } },
    });
    const slug = await supervisor.createBackup({ name: 'Manual backup X', password: 'pw' });
    assert.equal(slug, 'newslug');
    const call = seen.findLast((c) => c.key === 'POST /backups/new/full');
    assert.deepEqual(call.body, { name: 'Manual backup X', compressed: true, background: false, password: 'pw' });
    assert.equal(call.auth, 'Bearer test-token');
});

test('createBackup surfaces the Supervisor busy/error message', async () => {
    routes.set('POST /backups/new/full', {
        status: 400,
        body: { result: 'error', message: 'system is not running - freeze' },
    });
    await assert.rejects(() => supervisor.createBackup({ name: 'X' }), /freeze/);
});

test('createBackup rejects clearly on a non-JSON body', async () => {
    routes.set('POST /backups/new/full', { status: 502, body: '<html>bad gateway</html>' });
    await assert.rejects(() => supervisor.createBackup({ name: 'X' }), /returned non-JSON/);
});

test('restoreBackup posts background:false (+ password) and resolves on ok', async () => {
    routes.set('POST /backups/abc/restore/full', { status: 200, body: { result: 'ok', data: { job_id: 'j1' } } });
    const data = await supervisor.restoreBackup('abc', 'pw');
    assert.deepEqual(data, { job_id: 'j1' });
    const call = seen.findLast((c) => c.key === 'POST /backups/abc/restore/full');
    assert.deepEqual(call.body, { background: false, password: 'pw' });
});

test('restoreBackup omits the password when none is set', async () => {
    routes.set('POST /backups/abc/restore/full', { status: 200, body: { result: 'ok', data: {} } });
    await supervisor.restoreBackup('abc');
    assert.deepEqual(seen.findLast((c) => c.key === 'POST /backups/abc/restore/full').body, { background: false });
});

test('deleteBackup uses the short (fetch) path and honours the envelope', async () => {
    routes.set('DELETE /backups/gone', { status: 200, body: { result: 'ok', data: null } });
    await supervisor.deleteBackup('gone');
    routes.set('DELETE /backups/gone', { status: 200, body: { result: 'error', message: 'backup not found' } });
    await assert.rejects(() => supervisor.deleteBackup('gone'), /backup not found/);
});

test('uploadBackup streams a multipart body and returns the new slug', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'pdb-test-'));
    const file = join(dir, 'Backup (s9).tar');
    await writeFile(file, Buffer.alloc(4096, 7));
    try {
        routes.set('POST /backups/new/upload', { status: 200, body: { result: 'ok', data: { slug: 'uploaded' } } });
        assert.equal(await supervisor.uploadBackup(file), 'uploaded');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
