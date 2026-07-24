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

test('selectProtonToPrune trashes by DATE (newest kept) beyond the keep count', () => {
    const entries = [
        { name: 'C (s3).tar', date: '2026-07-24T03:00:00.000Z' }, // newest
        { name: 'A (s1).tar', date: '2026-07-24T01:00:00.000Z' }, // oldest
        { name: 'B (s2).tar', date: '2026-07-24T02:00:00.000Z' },
    ];
    const prune = o.selectProtonToPrune(entries, 1); // keep 1 newest → prune 2 oldest
    assert.deepEqual(prune.sort(), ['A (s1).tar', 'B (s2).tar']);
});

test('selectProtonToPrune: retention 0/negative keeps everything', () => {
    const entries = [{ name: 'A (s1).tar', date: '2026-07-24T01:00:00.000Z' }];
    assert.deepEqual(o.selectProtonToPrune(entries, 0), []);
    assert.deepEqual(o.selectProtonToPrune(entries, -1), []);
});

test('selectProtonToPrune keeps all when count <= retention', () => {
    const entries = [
        { name: 'A (s1).tar', date: '2026-07-24T01:00:00.000Z' },
        { name: 'B (s2).tar', date: '2026-07-24T02:00:00.000Z' },
    ];
    assert.deepEqual(o.selectProtonToPrune(entries, 5), []);
});

test('selectHALocalToPrune deletes oldest-first beyond keep — ONLY slugs in Proton', () => {
    const ha = [
        { slug: 'newest', date: '2026-07-24T04:00:00.000Z' },
        { slug: 'oldest', date: '2026-07-24T01:00:00.000Z' },
        { slug: 'mid1', date: '2026-07-24T02:00:00.000Z' },
        { slug: 'mid2', date: '2026-07-24T03:00:00.000Z' },
    ];
    // keep newest 1 → candidates are oldest, mid1, mid2. All in Proton → all deleted.
    const proton = new Set(['oldest', 'mid1', 'mid2', 'newest']);
    assert.deepEqual(o.selectHALocalToPrune(ha, proton, 1), ['oldest', 'mid1', 'mid2']);
});

test('SAFETY: selectHALocalToPrune NEVER returns a slug not present in Proton', () => {
    const ha = [
        { slug: 'newest', date: '2026-07-24T04:00:00.000Z' },
        { slug: 'oldest', date: '2026-07-24T01:00:00.000Z' }, // NOT in Proton
        { slug: 'mid', date: '2026-07-24T02:00:00.000Z' },     // in Proton
    ];
    const proton = new Set(['mid', 'newest']); // 'oldest' deliberately absent
    const del = o.selectHALocalToPrune(ha, proton, 1);
    // 'oldest' is the oldest and beyond keep, but it is NOT mirrored → must be kept.
    assert.deepEqual(del, ['mid']);
    assert.ok(!del.includes('oldest'), 'must never delete an un-mirrored backup');
    // With nothing mirrored, nothing is ever deletable regardless of age/count.
    assert.deepEqual(o.selectHALocalToPrune(ha, new Set(), 1), []);
    assert.deepEqual(o.selectHALocalToPrune(ha, [], 1), []);
});

test('selectHALocalToPrune: keep<=0 deletes nothing; accepts a Set or array', () => {
    const ha = [
        { slug: 'a', date: '2026-07-24T01:00:00.000Z' },
        { slug: 'b', date: '2026-07-24T02:00:00.000Z' },
    ];
    assert.deepEqual(o.selectHALocalToPrune(ha, ['a', 'b'], 0), []);
    assert.deepEqual(o.selectHALocalToPrune(ha, ['a', 'b'], -3), []);
    // array form works the same as a Set
    assert.deepEqual(o.selectHALocalToPrune(ha, ['a'], 1), ['a']);
});

test('selectHALocalToPrune keeps everything when count <= keep', () => {
    const ha = [
        { slug: 'a', date: '2026-07-24T01:00:00.000Z' },
        { slug: 'b', date: '2026-07-24T02:00:00.000Z' },
    ];
    assert.deepEqual(o.selectHALocalToPrune(ha, ['a', 'b'], 5), []);
});
