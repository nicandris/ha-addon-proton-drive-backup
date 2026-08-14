/**
 * Tests for the orchestrator's pure decision logic (no I/O) in the MIRROR model:
 * the remote-filename ↔ slug helpers, which HA backups to upload (dedup by
 * slug), and which to prune on each side (retention). These are the highest-risk
 * bits since the CLI has no metadata API and everything is matched by filename.
 *
 * The single most safety-critical invariant is that HA-local clean-up can NEVER
 * select a backup that isn't already mirrored in Proton — covered explicitly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

console.debug = () => {};
console.warn = () => {}; // mirroredSlugs warns about unverified remote copies

const o = await import('../src/orchestrator.mjs');

test('remoteNameFor builds "<name> (<slug>).tar"', () => {
    assert.equal(
        o.remoteNameFor({ name: 'Automatic backup 2026.7.3', slug: 'a1b2c3d4' }),
        'Automatic backup 2026.7.3 (a1b2c3d4).tar',
    );
});

test('remoteNameFor never produces a nameless " (slug).tar"', () => {
    // A backup job that died mid-creation leaves an HA backup with no name.
    for (const name of ['', '   ', null, undefined]) {
        const remote = o.remoteNameFor({ name, slug: 'e4bb4388' });
        assert.equal(remote, 'Unnamed backup (e4bb4388).tar');
        assert.equal(o.slugFromRemoteName(remote), 'e4bb4388'); // still round-trips
    }
});

test('slugFromRemoteName extracts the trailing (slug), null when absent', () => {
    assert.equal(o.slugFromRemoteName('Automatic backup 2026.7.3 (a1b2c3d4).tar'), 'a1b2c3d4');
    assert.equal(o.slugFromRemoteName('Core 2026.7 (dead-beef).tar'), 'dead-beef');
    assert.equal(o.slugFromRemoteName('no-slug-here.tar'), null);
    assert.equal(o.slugFromRemoteName('Automatic backup (a1b2c3d4).zip'), null); // wrong ext
    assert.equal(o.slugFromRemoteName(123), null);
    assert.equal(o.slugFromRemoteName(null), null);
});

test('remoteNameFor ↔ slugFromRemoteName round-trip (incl. spaces & dots in name)', () => {
    for (const b of [
        { name: 'Automatic backup 2026.7.3', slug: 'a1b2c3d4' },
        { name: 'My   weird / name.with.dots', slug: 'ffff0000' },
        { name: 'Full Snapshot v1.2.3', slug: 'abcd1234' },
    ]) {
        assert.equal(o.slugFromRemoteName(o.remoteNameFor(b)), b.slug);
    }
});

test('sanitizeName replaces slashes/control chars, collapses whitespace, trims', () => {
    assert.equal(o.sanitizeName('  a/b   c '), 'a_b c');
    assert.equal(o.sanitizeName('line\nbreak\ttab'), 'line_break_tab');
    assert.equal(o.sanitizeName(undefined), '');
    // A slash in the name must never leak into the remote filename.
    assert.ok(!o.remoteNameFor({ name: 'a/b', slug: 's1' }).includes('a/b'));
});

test('isOurRemoteFile is true for any .tar, false otherwise / non-string', () => {
    assert.equal(o.isOurRemoteFile('Anything (s).tar'), true);
    assert.equal(o.isOurRemoteFile('Manual snapshot.tar'), true);
    assert.equal(o.isOurRemoteFile('notes.txt'), false);
    assert.equal(o.isOurRemoteFile(123), false);
    assert.equal(o.isOurRemoteFile(null), false);
    assert.equal(o.isOurRemoteFile({ name: 'x.tar' }), false);
});

test('getStatus exposes idle sync fields by default', () => {
    const s = o.getStatus();
    assert.equal(s.syncing, false);
    assert.equal(s.activity, null);
    assert.equal(s.progress, null);
    assert.ok('lastSync' in s && 'lastError' in s && 'needsLogin' in s);
});

test('isNotFoundError is true only for a 404-tagged error', () => {
    assert.equal(o.isNotFoundError(Object.assign(new Error('x'), { status: 404 })), true);
    assert.equal(o.isNotFoundError(Object.assign(new Error('x'), { status: 500 })), false);
    assert.equal(o.isNotFoundError(new Error('plain')), false);
    assert.equal(o.isNotFoundError(null), false);
});

// HA reports `size` in MB; Proton reports bytes. Helper for readable fixtures.
const MB = 1024 * 1024;

test('selectToUpload returns ALL HA backups (auto + manual) whose slug is missing from Proton', () => {
    const ha = [
        { slug: 's1', name: 'Automatic backup 2026.7.1', size: 100 }, // missing → upload
        { slug: 's2', name: 'Automatic backup 2026.7.2', size: 100 }, // present + size OK → skip
        { slug: 's3', name: 'Manual snapshot', size: 50 },            // manual, missing → upload
    ];
    // Proton has s2 already (matched by the slug parsed from its filename).
    const remote = [{ name: 'Automatic backup 2026.7.2 (s2).tar', size: 100 * MB }];
    const out = o.selectToUpload(ha, remote);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((x) => x.slug).sort(), ['s1', 's3']);
    assert.equal(out.find((x) => x.slug === 's3').remoteName, 'Manual snapshot (s3).tar');
    // The HA size is carried through in bytes (used for the free-space check).
    assert.equal(out.find((x) => x.slug === 's3').sizeBytes, 50 * MB);
});

test('selectToUpload handles empty/nullish inputs and drops slug-less backups', () => {
    assert.deepEqual(o.selectToUpload([], []), []);
    assert.deepEqual(o.selectToUpload(null, null), []);
    assert.equal(o.selectToUpload([{ slug: 's', name: 'a' }], null).length, 1);
    assert.deepEqual(o.selectToUpload([{ name: 'no-slug' }], []), []);
});

// --- H4: a remote file is only "mirrored" if its SIZE matches too ------------

test('haBackupSizeBytes prefers size_bytes, falls back to MB→bytes, else null', () => {
    assert.equal(o.haBackupSizeBytes({ size_bytes: 12345 }), 12345);
    assert.equal(o.haBackupSizeBytes({ size: 2.5 }), Math.round(2.5 * MB));
    // size_bytes wins when both are present.
    assert.equal(o.haBackupSizeBytes({ size: 1, size_bytes: 999 }), 999);
    assert.equal(o.haBackupSizeBytes({}), null);
    assert.equal(o.haBackupSizeBytes({ size: 0 }), null);
    assert.equal(o.haBackupSizeBytes({ size: 'big' }), null);
    assert.equal(o.haBackupSizeBytes(null), null);
});

test('sizesMatch tolerates HA MB rounding but rejects a truncated file', () => {
    const exact = 4096 * MB;
    assert.equal(o.sizesMatch(exact, exact), true);
    assert.equal(o.sizesMatch(exact, exact + 5000), true);        // 2-dp MB rounding
    assert.equal(o.sizesMatch(exact, Math.round(exact * 0.5)), false); // half-written
    assert.equal(o.sizesMatch(exact, 0), false);
    assert.equal(o.sizesMatch(exact, NaN), false);
    assert.equal(o.sizesMatch(null, exact), false);
    // Small file: the absolute floor applies rather than the 1% term.
    assert.equal(o.sizesMatch(1024, 1024 + 4096), true);
});

test('mirroredSlugs: size match → mirrored; mismatch/missing size → NOT mirrored', () => {
    const ha = [
        { slug: 'ok', name: 'Automatic backup 1', size: 100 },
        { slug: 'partial', name: 'Automatic backup 2', size: 100 },
        { slug: 'nosize', name: 'Automatic backup 3', size: 100 },
        { slug: 'noha', name: 'Automatic backup 4' }, // HA didn't report a size
        { slug: 'absent', name: 'Automatic backup 5', size: 100 },
    ];
    const remote = [
        { name: 'Automatic backup 1 (ok).tar', size: 100 * MB },
        { name: 'Automatic backup 2 (partial).tar', size: 3 * MB }, // interrupted upload
        { name: 'Automatic backup 3 (nosize).tar' },                // no size reported
        { name: 'Automatic backup 4 (noha).tar', size: 100 * MB },
    ];
    const set = o.mirroredSlugs(ha, remote);
    assert.deepEqual([...set], ['ok']);
    for (const slug of ['partial', 'nosize', 'noha', 'absent']) {
        assert.ok(!set.has(slug), `${slug} must not count as mirrored`);
    }
    assert.deepEqual([...o.mirroredSlugs(null, null)], []);
});

test('H4: a size-mismatched remote copy is RE-UPLOADED and is NOT deletable locally', () => {
    const ha = [
        { slug: 'good', name: 'Automatic backup new', date: '2026-07-24T05:00:00.000Z', size: 100 },
        { slug: 'partial', name: 'Automatic backup old', date: '2026-07-24T01:00:00.000Z', size: 100 },
    ];
    const remote = [
        { name: 'Automatic backup new (good).tar', size: 100 * MB, date: '2026-07-24T05:00:00.000Z' },
        { name: 'Automatic backup old (partial).tar', size: 1 * MB, date: '2026-07-24T01:00:00.000Z' },
    ];
    // (1) re-uploaded
    assert.deepEqual(o.selectToUpload(ha, remote).map((x) => x.slug), ['partial']);
    // (2) never accepted as justification to delete the local copy
    const verified = o.mirroredSlugs(ha, remote);
    assert.deepEqual(o.selectHALocalToPrune(ha, verified, 1, 1), []);
    // Sanity: with a full-size remote copy the same backup IS prunable.
    const fixed = [remote[0], { ...remote[1], size: 100 * MB }];
    assert.deepEqual(o.selectHALocalToPrune(ha, o.mirroredSlugs(ha, fixed), 1, 1), ['partial']);
});

// --- M2: path-traversal guard on the remote name ---------------------------

test('isValidRemoteName accepts a bare .tar filename and rejects traversal payloads', () => {
    assert.equal(o.isValidRemoteName('Automatic backup 2026.7.3 (a1b2c3d4).tar'), true);
    assert.equal(o.isValidRemoteName('x.tar'), true);
    for (const bad of [
        '../x.tar', '../../etc/passwd', 'a/b.tar', 'a\\b.tar', '..', '.', '',
        '/etc/shadow.tar', '/x.tar', './x.tar', 'x.txt', 'x.tar.gz', 'x',
        'sub/../x.tar', 'bad\u0000.tar', 'nl\n.tar', 'x'.repeat(300) + '.tar',
        null, undefined, 123, {}, ['x.tar'],
    ]) {
        assert.equal(o.isValidRemoteName(bad), false, `must reject ${JSON.stringify(bad)}`);
    }
});

test('deleteProtonBackup/restoreToHA reject a traversing name before any I/O', async () => {
    await assert.rejects(() => o.deleteProtonBackup('../../x.tar'), /Invalid backup name/);
    await assert.rejects(() => o.restoreToHA('../../x.tar'), /Invalid backup name/);
    await assert.rejects(() => o.restoreToHA('notatar'), /Invalid backup name/);
});

test('isAutomaticBackup matches "Automatic backup …" on names AND remote filenames', () => {
    assert.equal(o.isAutomaticBackup('Automatic backup 2026.7.3'), true);
    assert.equal(o.isAutomaticBackup('Automatic backup 2026.7.3 (a1b2c3d4).tar'), true);
    assert.equal(o.isAutomaticBackup('automatic backup lower-case'), true); // case-insensitive
    assert.equal(o.isAutomaticBackup('Matter Server 8.0.0 (x).tar'), false);
    assert.equal(o.isAutomaticBackup('Manual backup 2026-07-24'), false);
    assert.equal(o.isAutomaticBackup('Full Snapshot v1.2.3 (s).tar'), false);
    assert.equal(o.isAutomaticBackup(undefined), false);
    assert.equal(o.isAutomaticBackup(null), false);
    // Consistent classification across an HA name and its Proton remote filename.
    const b = { name: 'Automatic backup 2026.7.3', slug: 'a1b2c3d4' };
    assert.equal(o.isAutomaticBackup(b.name), o.isAutomaticBackup(o.remoteNameFor(b)));
});

test('selectProtonToPrune prunes each bucket by DATE independently (newest kept)', () => {
    const entries = [
        { name: 'Automatic backup C (s3).tar', date: '2026-07-24T03:00:00.000Z' }, // auto newest
        { name: 'Automatic backup A (s1).tar', date: '2026-07-24T01:00:00.000Z' }, // auto oldest
        { name: 'Automatic backup B (s2).tar', date: '2026-07-24T02:00:00.000Z' }, // auto mid
        { name: 'Matter Server (m1).tar', date: '2026-07-24T05:00:00.000Z' },      // app newest
        { name: 'Core Add-on (m2).tar', date: '2026-07-24T04:00:00.000Z' },        // app oldest
    ];
    // keep 1 automatic + 1 app → prune 2 oldest automatic + 1 oldest app.
    const prune = o.selectProtonToPrune(entries, 1, 1);
    assert.deepEqual(prune.sort(), [
        'Automatic backup A (s1).tar',
        'Automatic backup B (s2).tar',
        'Core Add-on (m2).tar',
    ]);
});

test('selectProtonToPrune: an app-backup burst does NOT evict automatic backups', () => {
    const entries = [
        { name: 'Automatic backup 1 (a1).tar', date: '2026-07-20T00:00:00.000Z' },
        { name: 'Automatic backup 2 (a2).tar', date: '2026-07-21T00:00:00.000Z' },
        // A burst of many recent app backups.
        { name: 'Add-on X (b1).tar', date: '2026-07-22T00:00:00.000Z' },
        { name: 'Add-on Y (b2).tar', date: '2026-07-23T00:00:00.000Z' },
        { name: 'Add-on Z (b3).tar', date: '2026-07-24T00:00:00.000Z' },
    ];
    // Keep all automatic (0), keep 1 app → only app backups are pruned; both
    // automatic survive despite being older than the app burst.
    const prune = o.selectProtonToPrune(entries, 0, 1);
    assert.deepEqual(prune.sort(), ['Add-on X (b1).tar', 'Add-on Y (b2).tar']);
    assert.ok(!prune.some((n) => o.isAutomaticBackup(n)), 'automatic bucket untouched');
});

test('selectProtonToPrune: 0/negative keep per bucket keeps that bucket entirely', () => {
    const entries = [
        { name: 'Automatic backup A (s1).tar', date: '2026-07-24T01:00:00.000Z' },
        { name: 'App B (s2).tar', date: '2026-07-24T02:00:00.000Z' },
    ];
    assert.deepEqual(o.selectProtonToPrune(entries, 0, 0), []);
    assert.deepEqual(o.selectProtonToPrune(entries, -1, -1), []);
});

test('selectProtonToPrune keeps all when each bucket count <= its keep', () => {
    const entries = [
        { name: 'Automatic backup A (s1).tar', date: '2026-07-24T01:00:00.000Z' },
        { name: 'App B (s2).tar', date: '2026-07-24T02:00:00.000Z' },
    ];
    assert.deepEqual(o.selectProtonToPrune(entries, 5, 5), []);
});

test('selectHALocalToPrune deletes oldest-first beyond keep, per bucket — ONLY slugs in Proton', () => {
    const ha = [
        { slug: 'auto-new', name: 'Automatic backup 4', date: '2026-07-24T04:00:00.000Z' },
        { slug: 'auto-old', name: 'Automatic backup 1', date: '2026-07-24T01:00:00.000Z' },
        { slug: 'auto-mid', name: 'Automatic backup 2', date: '2026-07-24T02:00:00.000Z' },
        { slug: 'app-new', name: 'Add-on B', date: '2026-07-24T05:00:00.000Z' },
        { slug: 'app-old', name: 'Add-on A', date: '2026-07-24T03:00:00.000Z' },
    ];
    const proton = new Set(['auto-new', 'auto-old', 'auto-mid', 'app-new', 'app-old']);
    // keep newest 1 automatic + 1 app → delete 2 oldest automatic + 1 oldest app.
    assert.deepEqual(
        o.selectHALocalToPrune(ha, proton, 1, 1).sort(),
        ['app-old', 'auto-mid', 'auto-old'],
    );
});

test('SAFETY: selectHALocalToPrune NEVER returns an un-mirrored slug, in EITHER bucket', () => {
    const ha = [
        { slug: 'auto-new', name: 'Automatic backup 3', date: '2026-07-24T04:00:00.000Z' },
        { slug: 'auto-old', name: 'Automatic backup 1', date: '2026-07-24T01:00:00.000Z' }, // NOT in Proton
        { slug: 'auto-mid', name: 'Automatic backup 2', date: '2026-07-24T02:00:00.000Z' }, // in Proton
        { slug: 'app-new', name: 'Add-on B', date: '2026-07-24T05:00:00.000Z' },
        { slug: 'app-old', name: 'Add-on A', date: '2026-07-24T03:00:00.000Z' },            // NOT in Proton
    ];
    // 'auto-old' and 'app-old' are the oldest in their buckets & beyond keep, but
    // neither is mirrored → both must be kept.
    const proton = new Set(['auto-mid', 'auto-new', 'app-new']);
    const del = o.selectHALocalToPrune(ha, proton, 1, 1);
    assert.deepEqual(del.sort(), ['auto-mid']);
    assert.ok(!del.includes('auto-old'), 'must never delete an un-mirrored automatic backup');
    assert.ok(!del.includes('app-old'), 'must never delete an un-mirrored app backup');
    // With nothing mirrored, nothing is ever deletable in either bucket.
    assert.deepEqual(o.selectHALocalToPrune(ha, new Set(), 1, 1), []);
    assert.deepEqual(o.selectHALocalToPrune(ha, [], 1, 1), []);
});

test('selectHALocalToPrune: keep<=0 per bucket deletes nothing there; accepts a Set or array', () => {
    const ha = [
        { slug: 'auto', name: 'Automatic backup 1', date: '2026-07-24T01:00:00.000Z' },
        { slug: 'app', name: 'Add-on A', date: '2026-07-24T02:00:00.000Z' },
    ];
    assert.deepEqual(o.selectHALocalToPrune(ha, ['auto', 'app'], 0, 0), []);
    assert.deepEqual(o.selectHALocalToPrune(ha, ['auto', 'app'], -3, -3), []);
    // keep app bucket off (0) but prune the (single) automatic beyond keep... none beyond keep 0? keep<=0=none.
    // With keepAutomatic=0 nothing in automatic bucket is deletable; array form still honoured for app.
    assert.deepEqual(o.selectHALocalToPrune(
        [{ slug: 'app', name: 'Add-on A', date: '1' }, { slug: 'app2', name: 'Add-on B', date: '2' }],
        ['app', 'app2'], 0, 1,
    ), ['app']);
});

test('selectHALocalToPrune keeps everything when each bucket count <= its keep', () => {
    const ha = [
        { slug: 'auto', name: 'Automatic backup 1', date: '2026-07-24T01:00:00.000Z' },
        { slug: 'app', name: 'Add-on A', date: '2026-07-24T02:00:00.000Z' },
    ];
    assert.deepEqual(o.selectHALocalToPrune(ha, ['auto', 'app'], 5, 5), []);
});

test('getConfig returns effective config with password only as a boolean', async () => {
    const saved = { ...process.env };
    try {
        process.env.DRIVE_FOLDER = 'My Backups';
        process.env.BACKUP_INTERVAL_HOURS = '12';
        process.env.KEEP_AUTOMATIC_IN_PROTON = '7';
        process.env.KEEP_APP_IN_PROTON = '3';
        process.env.KEEP_AUTOMATIC_IN_HA = '2';
        process.env.KEEP_APP_IN_HA = '0';
        process.env.AUTOMATIC_NAME_PREFIX = 'Automatic backup';
        process.env.BACKUP_PASSWORD = 'super-secret';
        delete process.env.STAGING_DIR;
        const c = o.getConfig();
        assert.deepEqual(c, {
            driveFolder: 'My Backups',
            intervalHours: 12,
            keepAutomaticInProton: 7,
            keepAppInProton: 3,
            keepAutomaticInHA: 2,
            keepAppInHA: 0,
            automaticNamePrefix: 'Automatic backup',
            backupPasswordSet: true,
            stagingDir: null,
        });
        // The password value itself must never appear anywhere in the output.
        assert.ok(!JSON.stringify(c).includes('super-secret'));
        // No password set → boolean false.
        delete process.env.BACKUP_PASSWORD;
        assert.equal(o.getConfig().backupPasswordSet, false);
    } finally {
        for (const k of ['DRIVE_FOLDER', 'BACKUP_INTERVAL_HOURS', 'KEEP_AUTOMATIC_IN_PROTON', 'KEEP_APP_IN_PROTON', 'KEEP_AUTOMATIC_IN_HA', 'KEEP_APP_IN_HA', 'AUTOMATIC_NAME_PREFIX', 'BACKUP_PASSWORD', 'STAGING_DIR']) {
            if (k in saved) process.env[k] = saved[k]; else delete process.env[k];
        }
    }
});

// --- validateSettingsPatch (editable Web UI settings) -----------------------

test('validateSettingsPatch maps keys to option + env names', () => {
    const { options, env } = o.validateSettingsPatch({
        driveFolder: 'backups/HA', intervalHours: '12', keepAutomaticInProton: 5,
    });
    assert.deepEqual(options, {
        drive_folder: 'backups/HA', backup_interval_hours: 12, keep_automatic_in_proton: 5,
    });
    assert.deepEqual(env, {
        DRIVE_FOLDER: 'backups/HA', BACKUP_INTERVAL_HOURS: '12', KEEP_AUTOMATIC_IN_PROTON: '5',
    });
});

test('validateSettingsPatch accepts 0 for every count', () => {
    const { options } = o.validateSettingsPatch({
        keepAutomaticInProton: 0, keepAppInProton: 0, keepAutomaticInHA: 0, keepAppInHA: 0, intervalHours: 0,
    });
    assert.deepEqual(Object.values(options), [0, 0, 0, 0, 0]);
});

test('validateSettingsPatch refuses the backup password and unknown keys', () => {
    assert.throws(() => o.validateSettingsPatch({ backupPassword: 'x' }), /not an editable setting/);
    assert.throws(() => o.validateSettingsPatch({ backup_password: 'x' }), /not an editable setting/);
    assert.throws(() => o.validateSettingsPatch({ stagingDir: '/tmp' }), /not an editable setting/);
});

test('validateSettingsPatch rejects bad numbers', () => {
    for (const bad of [-1, 1.5, 'abc', '', null]) {
        assert.throws(() => o.validateSettingsPatch({ keepAppInProton: bad }), /whole number/, `value ${bad}`);
    }
});

test('validateSettingsPatch rejects an empty or traversing drive folder', () => {
    assert.throws(() => o.validateSettingsPatch({ driveFolder: '   ' }), /must not be empty/);
    assert.throws(() => o.validateSettingsPatch({ driveFolder: '/abs/path' }), /relative path/);
    assert.throws(() => o.validateSettingsPatch({ driveFolder: 'a/../../b' }), /relative path/);
});

test('validateSettingsPatch rejects a non-object or empty patch', () => {
    assert.throws(() => o.validateSettingsPatch(null), /must be an object/);
    assert.throws(() => o.validateSettingsPatch([]), /must be an object/);
    assert.throws(() => o.validateSettingsPatch({}), /no settings supplied/);
});

// --- 0.4.3: date resolution, bucket counts, prune planning ------------------

test('withResolvedDates prefers the HA date, keeps the Proton date otherwise', () => {
    const entries = [
        { name: 'Automatic backup 1 (s1).tar', date: '2020-01-01T00:00:00.000Z' },
        { name: 'Automatic backup 2 (s2).tar' },
        { name: 'Stray file (sX).tar', date: '2021-05-05T00:00:00.000Z' },
    ];
    const ha = [{ slug: 's1', date: '2026-07-01T00:00:00.000Z' }, { slug: 's2', date: '2026-07-02T00:00:00.000Z' }];
    const out = o.withResolvedDates(entries, ha);
    assert.equal(out[0].date, '2026-07-01T00:00:00.000Z'); // HA wins
    assert.equal(out[1].date, '2026-07-02T00:00:00.000Z'); // filled in
    assert.equal(out[2].date, '2021-05-05T00:00:00.000Z'); // untouched
});

test('selectProtonToPrune never prunes entries with no usable date', () => {
    const entries = [
        { name: 'Automatic backup a (s1).tar' },                                  // undated
        { name: 'Automatic backup b (s2).tar', date: '2026-07-01T00:00:00.000Z' },
        { name: 'Automatic backup c (s3).tar', date: '2026-07-02T00:00:00.000Z' },
    ];
    // keep 1: the undated one occupies the slot, so only the OLDER dated one goes.
    const pruned = o.selectProtonToPrune(entries, 1, 0);
    assert.ok(!pruned.includes('Automatic backup a (s1).tar'), 'undated must never be pruned');
    assert.deepEqual(pruned.sort(), ['Automatic backup b (s2).tar', 'Automatic backup c (s3).tar']);
});

test('selectProtonToPrune with all-undated entries prunes nothing', () => {
    const entries = [{ name: 'Automatic backup a (s1).tar' }, { name: 'Automatic backup b (s2).tar' }];
    assert.deepEqual(o.selectProtonToPrune(entries, 1, 1), []);
});

test('bucketCounts splits by the automatic prefix', () => {
    const ha = [
        { slug: 'a', name: 'Automatic backup 2026.7.3' },
        { slug: 'b', name: 'Matter Server 8.0.0' },
        { slug: 'c', name: 'Automatic backup 2026.7.2' },
    ];
    assert.deepEqual(o.bucketCounts(ha), { automatic: 2, app: 1, total: 3 });
    assert.deepEqual(o.bucketCounts([]), { automatic: 0, app: 0, total: 0 });
});

test('isAutomaticBackup honours a custom prefix (non-English HA)', () => {
    assert.equal(o.isAutomaticBackup('Automatische Sicherung 1', 'Automatische Sicherung'), true);
    assert.equal(o.isAutomaticBackup('Automatic backup 1', 'Automatische Sicherung'), false);
    assert.equal(o.isAutomaticBackup('anything', ''), false); // empty prefix matches nothing
});

test('planHALocalPrune reports candidates, deletions and skips consistently', () => {
    const ha = [
        { slug: 'auto-old', name: 'Automatic backup 1', date: '2026-07-01T00:00:00.000Z' },
        { slug: 'auto-mid', name: 'Automatic backup 2', date: '2026-07-02T00:00:00.000Z' },
        { slug: 'auto-new', name: 'Automatic backup 3', date: '2026-07-03T00:00:00.000Z' },
    ];
    const plan = o.planHALocalPrune(ha, new Set(['auto-mid']), 1, 0);
    assert.deepEqual(plan.candidates.map((b) => b.slug), ['auto-old', 'auto-mid']);
    assert.deepEqual(plan.toDelete, ['auto-mid']); // auto-old isn't mirrored
    assert.equal(plan.skippedNotInProton, 1);
    // selectHALocalToPrune must stay consistent with the planner.
    assert.deepEqual(o.selectHALocalToPrune(ha, new Set(['auto-mid']), 1, 0), plan.toDelete);
});
