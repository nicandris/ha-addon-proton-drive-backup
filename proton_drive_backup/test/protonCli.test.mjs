/**
 * Tests for the proton-drive CLI wrapper. We point PROTON_DRIVE_BIN at a fake
 * binary (test/fixtures/fake-proton-drive.mjs) and drive scenarios via FAKE_*
 * env vars, so these exercise the REAL spawn/parse code paths — no mocking.
 *
 * protonCli reads its binary path once at import, so env must be set before the
 * dynamic import below, and per-test behaviour comes from env vars that
 * run()/login() pass through to the child process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chmodSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fixtures', 'fake-proton-drive.mjs');
chmodSync(FAKE, 0o755); // ensure executable regardless of checkout perms

process.env.PROTON_DRIVE_BIN = FAKE;
// Silence the module's debug/warn chatter during tests.
console.debug = () => {};
console.warn = () => {};

const cli = await import('../src/protonCli.mjs');

// Reset the FAKE_* knobs between tests so they don't leak.
function clearFake() {
    for (const k of Object.keys(process.env)) if (k.startsWith('FAKE_')) delete process.env[k];
}

test('run() resolves (never rejects) on a nonzero exit', async () => {
    clearFake();
    process.env.FAKE_EXIT = '3';
    process.env.FAKE_STDERR = 'boom';
    const res = await cli.run(['whatever']);
    assert.equal(res.code, 3);
    assert.match(res.stderr, /boom/);
});

test('run() returns 124 when it times out (SIGKILL)', async () => {
    clearFake();
    process.env.FAKE_SLEEP_MS = '5000'; // fake hangs 5s
    const res = await cli.run(['slow'], { timeoutMs: 200 });
    assert.equal(res.code, 124);
    assert.match(res.stderr, /timeout/);
});

test('run() with timeoutMs<=0 disables the timer', async () => {
    clearFake();
    process.env.FAKE_EXIT = '0';
    const res = await cli.run(['noop'], { timeoutMs: 0 });
    assert.equal(res.code, 0);
});

test('isConnected() true on info exit 0, false otherwise', async () => {
    clearFake();
    process.env.FAKE_INFO_CODE = '0';
    assert.equal(await cli.isConnected(), true);
    process.env.FAKE_INFO_CODE = '1';
    assert.equal(await cli.isConnected(), false);
});

test('login() surfaces the sign-in URL and resolves ok on exit 0', async () => {
    clearFake();
    const url = 'https://account.proton.me/desktop/login?app=drive#payload=abc123:cli-drive';
    process.env.FAKE_LOGIN_URL = url;
    process.env.FAKE_LOGIN_CODE = '0';
    let seen = null;
    const res = await cli.login({ onUrl: (u) => { seen = u; }, timeoutMs: 10000 });
    assert.deepEqual(res, { ok: true });
    assert.equal(seen, url);
});

test('login() resolves {ok:false, error} on nonzero exit', async () => {
    clearFake();
    process.env.FAKE_LOGIN_URL = ''; // no URL emitted
    process.env.FAKE_LOGIN_CODE = '7';
    process.env.FAKE_LOGIN_STDERR = 'sign-in rejected';
    const res = await cli.login({ onUrl: () => {}, timeoutMs: 10000 });
    assert.equal(res.ok, false);
    assert.match(res.error, /sign-in rejected|7/);
});

// --- list(): the explicitly-unverified JSON shape. Parse defensively. ---

test('list() parses a bare array', async () => {
    clearFake();
    process.env.FAKE_LIST_JSON = JSON.stringify([
        { name: 'a.tar', type: 'file', uid: 'U1', size: 10 },
        { name: 'sub', type: 'folder' },
    ]);
    const r = await cli.list('/my-files/x');
    assert.equal(r.length, 2);
    assert.deepEqual(r[0], { name: 'a.tar', type: 'file', uid: 'U1', size: 10 });
});

test('list() tolerates a nested array under items/entries/data/children', async () => {
    for (const key of ['items', 'entries', 'data', 'children']) {
        clearFake();
        process.env.FAKE_LIST_JSON = JSON.stringify({ [key]: [{ name: `${key}.tar` }] });
        const r = await cli.list('/my-files/x');
        assert.equal(r.length, 1, `key=${key}`);
        assert.equal(r[0].name, `${key}.tar`, `key=${key}`);
    }
});

test('list() tolerates capitalised field names', async () => {
    clearFake();
    process.env.FAKE_LIST_JSON = JSON.stringify([{ Name: 'B.tar', Type: 'file', Size: 5 }]);
    const r = await cli.list('/my-files/x');
    assert.equal(r[0].name, 'B.tar');
    assert.equal(r[0].size, 5);
});

test('list() finds the first array value in an unknown-shaped object', async () => {
    clearFake();
    process.env.FAKE_LIST_JSON = JSON.stringify({ meta: 1, nodes: [{ name: 'C.tar' }] });
    const r = await cli.list('/my-files/x');
    assert.equal(r[0].name, 'C.tar');
});

test('list() drops entries without a name', async () => {
    clearFake();
    process.env.FAKE_LIST_JSON = JSON.stringify([{ name: 'ok.tar' }, { type: 'file' }, {}]);
    const r = await cli.list('/my-files/x');
    assert.deepEqual(r.map((e) => e.name), ['ok.tar']);
});

test('list() returns [] on invalid JSON', async () => {
    clearFake();
    process.env.FAKE_LIST_JSON = 'not json at all {';
    assert.deepEqual(await cli.list('/my-files/x'), []);
});

test('list() returns [] on a nonzero exit (e.g. not logged in)', async () => {
    clearFake();
    process.env.FAKE_LIST_CODE = '1';
    assert.deepEqual(await cli.list('/my-files/x'), []);
});

// --- upload/download/trash throw on failure, resolve on success ---

test('uploadFile/downloadPath/trash throw with stderr on nonzero exit', async () => {
    clearFake();
    process.env.FAKE_FS_CODE = '1';
    process.env.FAKE_FS_MSG = 'quota exceeded';
    await assert.rejects(() => cli.uploadFile('/tmp/x.tar', '/my-files/f'), /quota exceeded/);
    await assert.rejects(() => cli.downloadPath('/my-files/f/x.tar', '/tmp'), /quota exceeded/);
    await assert.rejects(() => cli.trash('/my-files/f/x.tar'), /quota exceeded/);
});

test('uploadFile/downloadPath/trash resolve on success', async () => {
    clearFake();
    process.env.FAKE_FS_CODE = '0';
    await cli.uploadFile('/tmp/x.tar', '/my-files/f');
    await cli.downloadPath('/my-files/f/x.tar', '/tmp');
    await cli.trash('/my-files/f/x.tar');
});
