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
async function load({ ha = [], remote = [], fail = {}, trashBefore = {} } = {}) {
    const calls = { uploads: [], trashed: [], deleted: [], downloads: [], created: [], restored: [], purged: [], purgeKeep: [], notified: [], dismissed: 0 };
    const staging = await mkdtemp(join(tmpdir(), 'pdb-flow-'));

    const supervisor = {
        listBackups: async () => { if (fail.listBackups) throw fail.listBackups; return ha; },
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
        notify: async (id, title, message) => { calls.notified.push(message); },
        dismissNotification: async () => { calls.dismissed++; },
    };
    const cli = {
        isConnected: async () => {
            calls.connectChecks = (calls.connectChecks || 0) + 1;
            if (fail.connectGate) await fail.connectGate; // hold a sync open
            return fail.notConnected !== true;
        },
        ensureFolder: async () => FOLDER,
        list: async () => remote,
        listStrict: async () => { if (fail.listStrict) throw fail.listStrict; return remote; },
        uploadFile: async (local, parent) => {
            calls.uploads.push(local.split('/').pop());
            if (fail.upload) throw fail.upload;
        },
        downloadPath: async () => {},
        trash: async (p) => { calls.trashed.push(p.replace(FOLDER + '/', '')); },
        trashedUids: async (name) => (trashBefore[name] || []),
        deleteFromTrash: async (name, opts) => { calls.purged.push(name); calls.purgeKeep.push(opts?.keep ?? null); return 1; },
    };

    mock.module('../src/supervisor.mjs', { namedExports: supervisor });
    mock.module('../src/protonCli.mjs', { namedExports: cli });

    process.env.STAGING_DIR = staging;
    process.env.DATA_DIR = staging; // backup-dates.json
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
    await o.runSync();
    assert.deepEqual(calls.uploads, ['Automatic backup 2 (s2).tar']);
    assert.deepEqual(calls.downloads, ['s2']);
    assert.equal(o.getStatus().lastError, null);
});

test('runSync NEVER creates a backup (mirror model)', async () => {
    process.env.BACKUP_INTERVAL_HOURS = '24';
    const { o, calls } = await load({ ha: [backup('s1', 'Automatic backup 1', '2026-07-01T00:00:00.000Z')] });
    await o.runSync();
    assert.deepEqual(calls.created, [], 'runSync must not create backups');
});

test('runSync skips a backup HA lists but no longer serves (404) without erroring', async () => {
    const notFound = Object.assign(new Error('Supervisor download s1 failed: HTTP 404'), { status: 404 });
    const { o, calls } = await load({
        ha: [backup('s1', 'Automatic backup ghost', '2026-07-01T00:00:00.000Z'),
             backup('s2', 'Automatic backup good', '2026-07-02T00:00:00.000Z')],
        fail: { download: { s1: notFound } },
    });
    await o.runSync();
    assert.deepEqual(calls.uploads, ['Automatic backup good (s2).tar'], 'the good one still uploads');
    assert.equal(o.getStatus().lastError, null, '404 must not surface as an error');
});

test('runSync records a real upload failure but keeps going', async () => {
    const { o } = await load({
        ha: [backup('s1', 'Automatic backup 1', '2026-07-01T00:00:00.000Z')],
        fail: { upload: new Error('quota exceeded') },
    });
    await o.runSync();
    assert.match(o.getStatus().lastError, /quota exceeded/);
    assert.equal(o.getStatus().errors.length, 1);
    // P10: a sync whose uploads failed is not a successful sync.
    assert.equal(o.getStatus().lastSync, null);
});

test('P10: lastSync is set only by a sync without errors', async () => {
    const { o } = await load({ ha: [backup('s1', 'Automatic backup 1', '2026-07-01T00:00:00.000Z')] });
    await o.runSync();
    assert.equal(o.getStatus().lastError, null);
    assert.ok(o.getStatus().lastSync, 'a clean sync records lastSync');
});

test('P10: createBackupNow does not record a sync whose upload failed', async () => {
    const { o } = await load({ ha: [backup('s1', 'Automatic backup 1', '2026-07-01T00:00:00.000Z')], fail: { upload: new Error('quota exceeded') } });
    await o.createBackupNow();
    assert.equal(o.getStatus().lastSync, null);
    assert.match(o.getStatus().lastError, /quota exceeded/);
});

test('runSync leaves no staged archive behind', async () => {
    const { o, staging } = await load({ ha: [backup('s1', 'Automatic backup 1', '2026-07-01T00:00:00.000Z')] });
    await o.runSync();
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
    await o.runSync();
    assert.deepEqual(calls.uploads, [], 'must not upload off a failed listing');
    assert.match(o.getStatus().lastError, /login/);
});

test('runSync does nothing but report when not connected', async () => {
    const { o, calls } = await load({
        ha: [backup('s1', 'Automatic backup 1', '2026-07-01T00:00:00.000Z')],
        fail: { notConnected: true },
    });
    await o.runSync();
    assert.deepEqual(calls.uploads, []);
    assert.equal(o.getStatus().needsLogin, true);
});

test('overlapping syncs are serialised — the second trigger is skipped', async () => {
    const { o, calls } = await load({
        ha: [backup('s1', 'Automatic backup 1', '2026-07-01T00:00:00.000Z')],
    });
    await Promise.all([o.runSync(), o.runSync()]);
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
    assert.deepEqual(calls.purged, [], 'permanently_delete defaults off');
});

test('pruneProton with permanently_delete also purges the trashed copy', async () => {
    process.env.KEEP_AUTOMATIC_IN_PROTON = '1';
    process.env.KEEP_APP_IN_PROTON = '0';
    process.env.PERMANENTLY_DELETE = 'true';
    const { o, calls } = await load({
        remote: [
            entry('Automatic backup old (a1).tar', 1048576, '2026-07-01T00:00:00.000Z'),
            entry('Automatic backup new (a2).tar', 1048576, '2026-07-03T00:00:00.000Z'),
        ],
    });
    await o.pruneProton();
    assert.deepEqual(calls.trashed, ['Automatic backup old (a1).tar']);
    assert.deepEqual(calls.purged, ['Automatic backup old (a1).tar']);
});

test('P13: permanently_delete purges only the copy it just trashed', async () => {
    process.env.PERMANENTLY_DELETE = 'true';
    const { o, calls } = await load({ trashBefore: { 'Automatic backup 1 (a1).tar': ['v~earlier'] } });
    await o.deleteProtonBackup('Automatic backup 1 (a1).tar');
    assert.deepEqual(calls.purgeKeep, [['v~earlier']], 'the earlier-trashed copy must be kept');
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
    await o.runSync();
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

// --- retention ordering & counting (P3, P4, P5, P9) --------------------------

test('P3: a backup deleted from HA keeps its real date — the newest is not trashed', async () => {
    // X is old but was uploaded late (backlog), so its Proton date is the newest.
    const ha = [
        backup('x', 'Automatic backup X', '2026-01-01T00:00:00.000Z'),
        backup('y', 'Automatic backup Y', '2026-07-05T00:00:00.000Z'),
    ];
    const remote = [
        entry('Automatic backup X (x).tar', 1048576, '2026-07-10T00:00:00.000Z'),
        entry('Automatic backup Y (y).tar', 1048576, '2026-07-05T00:00:00.000Z'),
    ];
    const { o, calls } = await load({ ha, remote });
    await o.runSync(); // retention off (keep all): both dates are seen
    ha.splice(0, 1); // the user deletes X from HA
    process.env.KEEP_AUTOMATIC_IN_PROTON = '1';
    await o.pruneProton();
    assert.deepEqual(calls.trashed, ['Automatic backup X (x).tar'], 'the really-oldest goes, not Y');
});

test('runSync does not upload a backup only to trash it (no upload/prune loop)', async () => {
    process.env.KEEP_AUTOMATIC_IN_PROTON = '2';
    const { o, calls } = await load({
        ha: [backup('a1', 'Automatic backup 1', '2026-07-01T00:00:00.000Z'),
             backup('a2', 'Automatic backup 2', '2026-07-02T00:00:00.000Z'),
             backup('a3', 'Automatic backup 3', '2026-07-03T00:00:00.000Z')],
    });
    await o.runSync();
    assert.deepEqual(calls.uploads.sort(), ['Automatic backup 2 (a2).tar', 'Automatic backup 3 (a3).tar']);
    assert.deepEqual(calls.trashed, []);
});

test('P5: a truncated copy does not take a keep slot from a good one', async () => {
    process.env.KEEP_AUTOMATIC_IN_PROTON = '2';
    const { o, calls } = await load({
        ha: [backup('s1', 'Automatic backup 1', '2026-07-01T00:00:00.000Z'),
             backup('s2', 'Automatic backup 2', '2026-07-02T00:00:00.000Z'),
             backup('s3', 'Automatic backup 3', '2026-07-03T00:00:00.000Z', 100)],
        remote: [entry('Automatic backup 1 (s1).tar'),
                 entry('Automatic backup 2 (s2).tar'),
                 entry('Automatic backup 3 (s3).tar', 1024)], // truncated upload of the newest
    });
    await o.pruneProton();
    assert.deepEqual(calls.trashed, [], 'the oldest GOOD copy must survive');
});

test('P9: pruneProton refuses to prune when the HA listing fails', async () => {
    process.env.KEEP_AUTOMATIC_IN_PROTON = '1';
    const { o, calls } = await load({
        remote: [entry('Automatic backup 1 (a1).tar', 1048576, '2026-07-01T00:00:00.000Z'),
                 entry('Automatic backup 2 (a2).tar', 1048576, '2026-07-03T00:00:00.000Z')],
        fail: { listBackups: new Error('Supervisor unreachable') },
    });
    await assert.rejects(() => o.pruneProton(), /Supervisor unreachable/);
    assert.deepEqual(calls.trashed, []);
});

// --- scheduling (P6, P7) -----------------------------------------------------

const HOUR = 3600 * 1000;
/** Let the runSync started by a fired timer finish (it does real fs I/O). */
async function settle(o) {
    for (let i = 0; i < 200 && o.getStatus().syncing; i++) await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

test('P6: an interval beyond the timer limit never turns into back-to-back syncs', async () => {
    process.env.BACKUP_INTERVAL_HOURS = '1000'; // > 596 h: setInterval fired every 1 ms
    const { o, calls } = await load({});
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    try {
        o.scheduleNextSync();
        assert.ok(o.getStatus().nextSyncEpoch <= 2 ** 31 - 1, 'clamped to the timer limit');
        mock.timers.tick(1000);
        await settle(o);
        assert.equal(calls.connectChecks || 0, 0, 'no sync may fire early');
    } finally {
        mock.timers.reset();
    }
});

test('P6/P7: each sync schedules the next one interval after it finished', async () => {
    process.env.BACKUP_INTERVAL_HOURS = '6';
    const { o, calls } = await load({});
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    try {
        o.scheduleNextSync(5000);
        assert.equal(o.getStatus().nextSyncEpoch, 5000);
        mock.timers.tick(5000);
        await settle(o);
        assert.equal(calls.connectChecks, 1, 'the first sync ran');
        assert.equal(o.getStatus().nextSyncEpoch, 5000 + 6 * HOUR);
        mock.timers.tick(6 * HOUR);
        await settle(o);
        assert.equal(calls.connectChecks, 2, 'and the next one, an interval later');
    } finally {
        mock.timers.reset();
    }
});

test('P7: changing the interval in the panel reschedules the timer', async () => {
    process.env.BACKUP_INTERVAL_HOURS = '24';
    const { o, calls } = await load({});
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    try {
        o.scheduleNextSync();
        assert.equal(o.getStatus().nextSyncEpoch, 24 * HOUR);
        await o.applySettings({ intervalHours: 2 });
        assert.equal(o.getStatus().nextSyncEpoch, 2 * HOUR);
        mock.timers.tick(2 * HOUR);
        await settle(o);
        assert.equal(calls.connectChecks, 1, 'the sync ran on the NEW interval');
        await o.applySettings({ intervalHours: 0 });
        assert.equal(o.getStatus().nextSyncEpoch, null, 'interval 0 = no scheduled sync');
    } finally {
        mock.timers.reset();
    }
});

test('P8: pruneProton never trashes the user\'s own .tar files in the folder', async () => {
    process.env.KEEP_AUTOMATIC_IN_PROTON = '1';
    process.env.KEEP_APP_IN_PROTON = '1';
    const { o, calls } = await load({
        remote: [
            entry('Automatic backup new (a2).tar', 1048576, '2026-07-03T00:00:00.000Z'),
            entry('Matter Server (m1).tar', 1048576, '2026-07-03T00:00:00.000Z'),
            entry('my-photos.tar', 1048576, '2026-07-01T00:00:00.000Z'),
        ],
    });
    await o.pruneProton();
    assert.deepEqual(calls.trashed, []);
});

// --- the single operation lock (P14) -----------------------------------------

test('P14: delete and local clean-up refuse to run during a sync', async () => {
    process.env.KEEP_AUTOMATIC_IN_HA = '1';
    let release;
    const { o, calls } = await load({
        ha: [backup('a1', 'Automatic backup 1', '2026-07-01T00:00:00.000Z'),
             backup('a2', 'Automatic backup 2', '2026-07-02T00:00:00.000Z')],
        remote: [entry('Automatic backup 1 (a1).tar')],
        fail: { connectGate: new Promise((r) => { release = r; }) },
    });
    const sync = o.runSync();
    await assert.rejects(() => o.deleteProtonBackup('Automatic backup 1 (a1).tar'), (err) => err.busy === true);
    await assert.rejects(() => o.pruneHALocalNow(), (err) => err.busy === true);
    release();
    await sync;
    assert.deepEqual(calls.trashed, []);
    assert.deepEqual(calls.deleted, []);
    // ...and once the sync is done they run normally.
    assert.equal((await o.pruneHALocalNow()).deleted, 1);
});

test('P14: the restore route answers 409 (not started:true) while busy', async () => {
    let release;
    await load({ fail: { connectGate: new Promise((r) => { release = r; }) } });
    process.env.PORT = '0';
    const ingress = await import(`../src/ingress.mjs?t=${Math.random().toString(36).slice(2)}`);
    const server = ingress.startIngressServer();
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (path, body) => fetch(`${base}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
    });
    try {
        await post('/api/sync-now'); // takes the lock, held by connectGate
        for (const [path, body] of [['/api/restore', { name: 'x (s1).tar' }], ['/api/delete', { name: 'x (s1).tar' }], ['/api/prune-ha']]) {
            const r = await post(path, body);
            assert.equal(r.status, 409, path);
            assert.equal((await r.json()).ok, false, path);
        }
    } finally {
        release();
        server.closeAllConnections?.();
        server.close();
    }
});

// --- Home Assistant alerting (P15) ---------------------------------------------

test('P15: a failed sync raises one HA notification, a good sync clears it', async () => {
    const fail = { upload: new Error('quota exceeded') };
    const { o, calls } = await load({ ha: [backup('s1', 'Automatic backup 1', '2026-07-01T00:00:00.000Z')], fail });
    await o.runSync();
    assert.equal(calls.notified.length, 1);
    assert.match(calls.notified[0], /quota exceeded/);
    await o.runSync(); // same failure again: not re-sent
    assert.equal(calls.notified.length, 1);
    delete fail.upload;
    await o.runSync();
    assert.equal(calls.dismissed, 1, 'the notification is cleared once a sync succeeds');
});

test('P15: needing a sign-in raises an HA notification', async () => {
    const { o, calls } = await load({ fail: { notConnected: true } });
    await o.runSync();
    assert.equal(calls.notified.length, 1);
    assert.match(calls.notified[0], /Connect/);
});
