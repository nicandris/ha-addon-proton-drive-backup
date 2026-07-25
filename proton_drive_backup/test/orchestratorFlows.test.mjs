/**
 * Tests for the orchestrator's async I/O flows — previously the biggest coverage
 * gap: `runSync`, `pruneProton`, `pruneHALocalNow`, `createBackupNow` and
 * `restoreToHA` had no tests at all, so the 404-skip branch, the temp-file
 * cleanup, the single-operation guard and the HA-busy mapping were unexercised.
 *
 * `./supervisor.mjs` and `./protonCli.mjs` are replaced with in-memory doubles via
 * `mock.module`, which needs `--experimental-test-module-mocks` (set in the npm
 * test script). If a future Node changes that API these tests fail loudly —
 * production code is unaffected.
 */
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FOLDER = '/my-files/Home Assistant Backups';

/** Fresh doubles + a fresh module registry for each test. */
async function load({ ha = [], remote = [], fail = {} } = {}) {
    const calls = { uploads: [], trashed: [], deleted: [], downloads: [], created: [], restored: [] };
    const staging = await mkdtemp(join(tmpdir(), 'pdb-flow-'));

    const supervisor = {
        listBackups: async () => ha,
        hostInfo: async () => ({ disk_free: 100, disk_total: 200 }),
        downloadBackup: async (slug, dest) => {
            calls.downloads.push(slug);
            if (fail.download?.[slug]) throw fail.download[slug];
            await writeFile(dest, 'x'); // the staged archive the upload would send
        },
        deleteBackup: async (slug) => {
            calls.deleted.push(slug);
            if (fail.deleteBackup?.[slug]) throw fail.deleteBackup[slug];
        },
        createBackup: async ({ name }) => {
            calls.created.push(name);
            if (fail.createBackup) throw fail.createBackup;
            return 'new-slug';
        },
        uploadBackup: async (p) => { calls.restored.push(p); return 'restored-slug'; },
        restoreBackup: async (slug) => ({ slug }),
        setSelfOptions: async () => ({}),
    };
    const cli = {
        isConnected: async () => fail.notConnected !== true,
        ensureFolder: async () => FOLDER,
        list: async () => remote,
        listStrict: async () => { if (fail.listStrict) throw fail.listStrict; return remote; },
        uploadFile: async (local, parent) => {
            calls.uploads.push(local.split('/').pop());
            if (fail.upload) throw fail.upload;
        },
        downloadPath: async () => {},
        trash: async (p) => { calls.trashed.push(p.replace(FOLDER + '/', '')); },
    };

    mock.module('../src/supervisor.mjs', { namedExports: supervisor });
    mock.module('../src/protonCli.mjs', { namedExports: cli });

    process.env.STAGING_DIR = staging;
    // Cache-bust so each test gets fresh module state (the sync guard is module-level).
    const o = await import(`../src/orchestrator.mjs?t=${Math.random().toString(36).slice(2)}`);
    return { o, calls, staging };
}

const envSnapshot = { ...process.env };
beforeEach(() => { console.debug = () => {}; console.log = () => {}; console.warn = () => {}; });
afterEach(async () => {
    mock.reset();
    for (const k of Object.keys(process.env)) if (!(k in envSnapshot)) delete process.env[k];
    Object.assign(process.env, envSnapshot);
});

const backup = (slug, name, date, sizeMB = 1) => ({ slug, name, date, size: sizeMB });
const entry = (name, bytes = 1 * 1048576, date = '2026-07-01T00:00:00.000Z') => ({
    name, size: bytes, date, type: 'file',
});

test('runSync uploads only HA backups missing from Proton', async () => {
    const { o, calls } = await load({
        ha: [backup('s1', 'Automatic backup 1', '2026-07-01T00:00:00.000Z'),
             backup('s2', 'Automatic backup 2', '2026-07-02T00:00:00.000Z')],
        remote: [entry('Automatic backup 1 (s1).tar')],
    });
    await o.runSync(true);
    assert.deepEqual(calls.uploads, ['Automatic backup 2 (s2).tar']);
    assert.deepEqual(calls.downloads, ['s2']);
    assert.equal(o.getStatus().lastError, null);
});

test('runSync NEVER creates a backup (mirror model)', async () => {
    process.env.BACKUP_INTERVAL_HOURS = '24';
    const { o, calls } = await load({ ha: [backup('s1', 'Automatic backup 1', '2026-07-01T00:00:00.000Z')] });
    await o.runSync(true);
    assert.deepEqual(calls.created, [], 'runSync must not create backups');
});

test('runSync skips a backup HA lists but no longer serves (404) without erroring', async () => {
    const notFound = Object.assign(new Error('Supervisor download s1 failed: HTTP 404'), { status: 404 });
    const { o, calls } = await load({
        ha: [backup('s1', 'Automatic backup ghost', '2026-07-01T00:00:00.000Z'),
             backup('s2', 'Automatic backup good', '2026-07-02T00:00:00.000Z')],
        fail: { download: { s1: notFound } },
    });
    await o.runSync(true);
    assert.deepEqual(calls.uploads, ['Automatic backup good (s2).tar'], 'the good one still uploads');
    assert.equal(o.getStatus().lastError, null, '404 must not surface as an error');
});

test('runSync records a real upload failure but keeps going', async () => {
    const { o } = await load({
        ha: [backup('s1', 'Automatic backup 1', '2026-07-01T00:00:00.000Z')],
        fail: { upload: new Error('quota exceeded') },
    });
    await o.runSync(true);
    assert.match(o.getStatus().lastError, /quota exceeded/);
    assert.equal(o.getStatus().errors.length, 1);
});

test('runSync leaves no staged archive behind', async () => {
    const { o, staging } = await load({ ha: [backup('s1', 'Automatic backup 1', '2026-07-01T00:00:00.000Z')] });
    await o.runSync(true);
    assert.deepEqual((await readdir(staging)).filter((f) => f.endsWith('.tar')), []);
    await rm(staging, { recursive: true, force: true });
});

test('runSync aborts instead of re-uploading everything when the listing fails', async () => {
    // The 0.4.1 regression: a failed listing used to look like "empty folder".
    const { o, calls } = await load({
        ha: [backup('s1', 'Automatic backup 1', '2026-07-01T00:00:00.000Z')],
        remote: [entry('Automatic backup 1 (s1).tar')],
        fail: { listStrict: new Error('You need to login first') },
    });
    await o.runSync(true);
    assert.deepEqual(calls.uploads, [], 'must not upload off a failed listing');
    assert.match(o.getStatus().lastError, /login/);
});

test('runSync does nothing but report when not connected', async () => {
    const { o, calls } = await load({
        ha: [backup('s1', 'Automatic backup 1', '2026-07-01T00:00:00.000Z')],
        fail: { notConnected: true },
    });
    await o.runSync(true);
    assert.deepEqual(calls.uploads, []);
    assert.equal(o.getStatus().needsLogin, true);
});

test('overlapping syncs are serialised — the second trigger is skipped', async () => {
    const { o, calls } = await load({
        ha: [backup('s1', 'Automatic backup 1', '2026-07-01T00:00:00.000Z')],
    });
    await Promise.all([o.runSync(true), o.runSync(true)]);
    assert.equal(calls.uploads.length, 1, 'the same backup must not upload twice');
});

test('pruneProton trashes past the per-bucket limits, newest kept', async () => {
    process.env.KEEP_AUTOMATIC_IN_PROTON = '1';
    process.env.KEEP_APP_IN_PROTON = '0'; // keep all app backups
    const { o, calls } = await load({
        remote: [
            entry('Automatic backup old (a1).tar', 1048576, '2026-07-01T00:00:00.000Z'),
            entry('Automatic backup new (a2).tar', 1048576, '2026-07-03T00:00:00.000Z'),
            entry('Matter Server (m1).tar', 1048576, '2026-07-01T00:00:00.000Z'),
        ],
    });
    await o.pruneProton();
    assert.deepEqual(calls.trashed, ['Automatic backup old (a1).tar']);
});

test('pruneHALocalNow deletes only size-verified mirrored backups and counts honestly', async () => {
    process.env.KEEP_AUTOMATIC_IN_HA = '1';
    const ha = [
        backup('a1', 'Automatic backup 1', '2026-07-01T00:00:00.000Z', 1), // mirrored → delete
        backup('a2', 'Automatic backup 2', '2026-07-02T00:00:00.000Z', 1), // NOT mirrored → skip
        backup('a3', 'Automatic backup 3', '2026-07-03T00:00:00.000Z', 1), // newest → keep
    ];
    const { o, calls } = await load({
        ha,
        remote: [entry('Automatic backup 1 (a1).tar', 1048576)],
    });
    const res = await o.pruneHALocalNow();
    assert.deepEqual(calls.deleted, ['a1']);
    assert.equal(res.deleted, 1);
    assert.equal(res.skippedNotInProton, 1, 'the un-mirrored one must be reported as skipped');
    assert.equal(res.failed, 0);
});

test('pruneHALocalNow reports a delete failure instead of counting it as deleted', async () => {
    process.env.KEEP_AUTOMATIC_IN_HA = '1';
    const { o } = await load({
        ha: [backup('a1', 'Automatic backup 1', '2026-07-01T00:00:00.000Z'),
             backup('a2', 'Automatic backup 2', '2026-07-02T00:00:00.000Z')],
        remote: [entry('Automatic backup 1 (a1).tar', 1048576)],
        fail: { deleteBackup: { a1: new Error('busy') } },
    });
    const res = await o.pruneHALocalNow();
    assert.equal(res.deleted, 0);
    assert.equal(res.failed, 1);
});

test('pruneHALocalNow refuses to delete a size-MISMATCHED remote copy', async () => {
    process.env.KEEP_AUTOMATIC_IN_HA = '1';
    const { o, calls } = await load({
        ha: [backup('a1', 'Automatic backup 1', '2026-07-01T00:00:00.000Z', 100), // 100 MB in HA
             backup('a2', 'Automatic backup 2', '2026-07-02T00:00:00.000Z', 100)],
        remote: [entry('Automatic backup 1 (a1).tar', 1024)], // truncated upload
    });
    const res = await o.pruneHALocalNow();
    assert.deepEqual(calls.deleted, [], 'a truncated copy is not proof of an offsite backup');
    assert.equal(res.skippedNotInProton, 1);
});

test('createBackupNow creates a backup then mirrors it', async () => {
    const { o, calls } = await load({ ha: [] });
    await o.createBackupNow();
    assert.equal(calls.created.length, 1);
    assert.match(calls.created[0], /^Manual backup /);
});

test('createBackupNow humanises "HA is busy" instead of showing raw Supervisor text', async () => {
    const { o } = await load({
        fail: { createBackup: new Error("'BackupManager.do_backup_full' blocked from execution, system is not running - freeze") },
    });
    await o.createBackupNow();
    assert.match(o.getStatus().lastError, /busy/i);
    assert.doesNotMatch(o.getStatus().lastError, /BackupManager/);
});

test('restoreToHA takes the single-operation lock and reports activity', async () => {
    const { o, calls } = await load({ remote: [entry('Automatic backup 1 (a1).tar')] });
    const p = o.restoreToHA('Automatic backup 1 (a1).tar');
    // While a restore runs, a sync must not start.
    await o.runSync(true);
    await p;
    assert.equal(calls.restored.length, 1);
    assert.deepEqual(calls.uploads, [], 'a sync must not run during a restore');
    assert.equal(o.getStatus().activity, null, 'activity must be cleared afterwards');
});

test('restoreToHA rejects a traversing remote name before touching anything', async () => {
    const { o, calls } = await load({});
    await assert.rejects(() => o.restoreToHA('../../etc/passwd.tar'), /invalid backup name/i);
    assert.deepEqual(calls.restored, []);
});
