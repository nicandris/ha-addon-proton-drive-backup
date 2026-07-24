/**
 * Tests for the orchestrator's pure decision logic (no I/O): which backups to
 * upload (dedup), and which to prune on each side (retention). These are the
 * highest-risk bits of the CLI migration since the CLI has no metadata API and
 * everything is matched by filename.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

console.debug = () => {};

const o = await import('../src/orchestrator.mjs');

const PFX = 'Proton Drive Backup';

test('remoteNameFor appends .tar to the backup name', () => {
    assert.equal(o.remoteNameFor({ name: `${PFX} 2026-07-24T10:00:00.000Z` }),
        `${PFX} 2026-07-24T10:00:00.000Z.tar`);
});

test('isOurRemoteFile matches our prefix + .tar only', () => {
    assert.equal(o.isOurRemoteFile(`${PFX} 2026-07-24T10:00:00.000Z.tar`), true);
    assert.equal(o.isOurRemoteFile('Some Other Backup.tar'), false);
    assert.equal(o.isOurRemoteFile(`${PFX} 2026-07-24T10:00:00.000Z`), false); // no .tar
});

test('isOurRemoteFile is false for non-string input (regression: name.startsWith crash)', () => {
    assert.equal(o.isOurRemoteFile(123), false);
    assert.equal(o.isOurRemoteFile(null), false);
    assert.equal(o.isOurRemoteFile(undefined), false);
    assert.equal(o.isOurRemoteFile({ name: 'x' }), false);
});

test('isOurHABackup matches our prefix and tolerates missing name', () => {
    assert.equal(o.isOurHABackup({ name: `${PFX} x` }), true);
    assert.equal(o.isOurHABackup({ name: 'Manual snapshot' }), false);
    assert.equal(o.isOurHABackup({}), false);
    assert.equal(o.isOurHABackup(null), false);
});

test('dateFromRemoteName extracts an ISO date, null on garbage', () => {
    assert.equal(o.dateFromRemoteName(`${PFX} 2026-07-24T10:00:00.000Z.tar`),
        '2026-07-24T10:00:00.000Z');
    assert.equal(o.dateFromRemoteName(`${PFX} not-a-date.tar`), null);
});

test('isNotFoundError is true only for a 404-tagged error', () => {
    assert.equal(o.isNotFoundError(Object.assign(new Error('x'), { status: 404 })), true);
    assert.equal(o.isNotFoundError(Object.assign(new Error('x'), { status: 500 })), false);
    assert.equal(o.isNotFoundError(new Error('plain')), false);
    assert.equal(o.isNotFoundError(null), false);
});

test('selectToUpload returns only our backups missing from Proton', () => {
    const ha = [
        { slug: 's1', name: `${PFX} 2026-07-24T01:00:00.000Z` }, // missing → upload
        { slug: 's2', name: `${PFX} 2026-07-24T02:00:00.000Z` }, // present → skip
        { slug: 's3', name: 'Manual snapshot' },                  // not ours → skip
    ];
    const remote = [{ name: `${PFX} 2026-07-24T02:00:00.000Z.tar` }];
    const out = o.selectToUpload(ha, remote);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], {
        slug: 's1',
        name: `${PFX} 2026-07-24T01:00:00.000Z`,
        remoteName: `${PFX} 2026-07-24T01:00:00.000Z.tar`,
    });
});

test('selectToUpload handles empty/nullish inputs', () => {
    assert.deepEqual(o.selectToUpload([], []), []);
    assert.deepEqual(o.selectToUpload(null, null), []);
    assert.equal(o.selectToUpload([{ slug: 's', name: `${PFX} a` }], null).length, 1);
});

test('selectProtonToPrune trashes oldest-first beyond the keep count', () => {
    const entries = [
        { name: `${PFX} 2026-07-24T03:00:00.000Z.tar` },
        { name: `${PFX} 2026-07-24T01:00:00.000Z.tar` }, // oldest
        { name: `${PFX} 2026-07-24T02:00:00.000Z.tar` },
        { name: 'Unrelated.tar' }, // not ours → never pruned
    ];
    const prune = o.selectProtonToPrune(entries, 1); // keep 1 newest → prune 2 oldest
    assert.deepEqual(prune, [
        `${PFX} 2026-07-24T01:00:00.000Z.tar`,
        `${PFX} 2026-07-24T02:00:00.000Z.tar`,
    ]);
});

test('selectProtonToPrune: retention 0/negative keeps everything', () => {
    const entries = [{ name: `${PFX} 2026-07-24T01:00:00.000Z.tar` }];
    assert.deepEqual(o.selectProtonToPrune(entries, 0), []);
    assert.deepEqual(o.selectProtonToPrune(entries, -1), []);
});

test('selectProtonToPrune keeps all when count <= retention', () => {
    const entries = [
        { name: `${PFX} 2026-07-24T01:00:00.000Z.tar` },
        { name: `${PFX} 2026-07-24T02:00:00.000Z.tar` },
    ];
    assert.deepEqual(o.selectProtonToPrune(entries, 5), []);
});

test('selectHAToPrune deletes oldest-by-date slugs beyond keep, ours only', () => {
    const ha = [
        { slug: 'newest', name: `${PFX} a`, date: '2026-07-24T03:00:00.000Z' },
        { slug: 'oldest', name: `${PFX} b`, date: '2026-07-24T01:00:00.000Z' },
        { slug: 'mid', name: `${PFX} c`, date: '2026-07-24T02:00:00.000Z' },
        { slug: 'manual', name: 'Manual', date: '2020-01-01T00:00:00.000Z' }, // not ours
    ];
    const prune = o.selectHAToPrune(ha, 1); // keep 1 newest of ours → delete 2 oldest
    assert.deepEqual(prune, ['oldest', 'mid']);
});

test('selectHAToPrune: retention 0 keeps everything', () => {
    const ha = [{ slug: 's', name: `${PFX} a`, date: '2026-07-24T01:00:00.000Z' }];
    assert.deepEqual(o.selectHAToPrune(ha, 0), []);
});
