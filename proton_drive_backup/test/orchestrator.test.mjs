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

const o = await import('../src/orchestrator.mjs');

test('remoteNameFor builds "<name> (<slug>).tar"', () => {
    assert.equal(
        o.remoteNameFor({ name: 'Automatic backup 2026.7.3', slug: 'a1b2c3d4' }),
        'Automatic backup 2026.7.3 (a1b2c3d4).tar',
    );
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

test('selectToUpload returns ALL HA backups (auto + manual) whose slug is missing from Proton', () => {
    const ha = [
        { slug: 's1', name: 'Automatic backup 2026.7.1' }, // missing → upload
        { slug: 's2', name: 'Automatic backup 2026.7.2' }, // present → skip
        { slug: 's3', name: 'Manual snapshot' },           // manual, missing → upload
    ];
    // Proton has s2 already (matched by the slug parsed from its filename).
    const remote = [{ name: 'Automatic backup 2026.7.2 (s2).tar' }];
    const out = o.selectToUpload(ha, remote);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((x) => x.slug).sort(), ['s1', 's3']);
    assert.equal(out.find((x) => x.slug === 's3').remoteName, 'Manual snapshot (s3).tar');
});

test('selectToUpload handles empty/nullish inputs and drops slug-less backups', () => {
    assert.deepEqual(o.selectToUpload([], []), []);
    assert.deepEqual(o.selectToUpload(null, null), []);
    assert.equal(o.selectToUpload([{ slug: 's', name: 'a' }], null).length, 1);
    assert.deepEqual(o.selectToUpload([{ name: 'no-slug' }], []), []);
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
            backupPasswordSet: true,
            stagingDir: null,
        });
        // The password value itself must never appear anywhere in the output.
        assert.ok(!JSON.stringify(c).includes('super-secret'));
        // No password set → boolean false.
        delete process.env.BACKUP_PASSWORD;
        assert.equal(o.getConfig().backupPasswordSet, false);
    } finally {
        for (const k of ['DRIVE_FOLDER', 'BACKUP_INTERVAL_HOURS', 'KEEP_AUTOMATIC_IN_PROTON', 'KEEP_APP_IN_PROTON', 'KEEP_AUTOMATIC_IN_HA', 'KEEP_APP_IN_HA', 'BACKUP_PASSWORD', 'STAGING_DIR']) {
            if (k in saved) process.env[k] = saved[k]; else delete process.env[k];
        }
    }
});
