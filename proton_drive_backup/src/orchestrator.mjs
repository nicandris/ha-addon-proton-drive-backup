/**
 * Core sync logic: mirrors Home Assistant's OWN backups to Proton Drive via the
 * official `proton-drive` CLI (like the Google Drive backup add-on). It does NOT
 * create backups — it uploads whatever backups already exist in Home Assistant
 * (automatic + manual), skipping any already present in Proton.
 *
 * The CLI has NO metadata API, so remote backups are identified purely by
 * FILENAME. Each HA backup is stored remotely as `<sanitizedName> (<slug>).tar`;
 * the `(slug)` suffix is the HA backup's stable, unique id, which drives dedup.
 *
 * Retention (split into two independent buckets — AUTOMATIC vs APP — so a burst
 * of small per-add-on "app" backups can never evict the important scheduled
 * "Automatic backup" ones; buckets are decided BY NAME via isAutomaticBackup):
 *  - Proton side is enforced automatically each sync
 *    (`keep_automatic_in_proton` / `keep_app_in_proton`), sorting each bucket by
 *    the Proton entry's date (names are no longer time-sortable).
 *  - HA side is MANUAL ONLY (the "Clean up local backups" button →
 *    `pruneHALocalNow`, `keep_automatic_in_ha` / `keep_app_in_ha`) and NEVER
 *    deletes a backup that isn't confirmed offsite.
 *
 * Authentication is owned entirely by the CLI (browser sign-in). This module
 * never handles credentials — it only reports a `needsLogin` flag when the CLI
 * has no usable session; the UI drives the actual sign-in.
 *
 * Resilient by design: per-backup errors are caught and logged, lastError is
 * recorded, and runSync never throws out (so it can't crash the scheduler or
 * the ingress server).
 */

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import * as supervisor from './supervisor.mjs';
import * as cli from './protonCli.mjs';

// Errors may carry the real cause on err.cause — surface it so failures are
// actually diagnosable.
function describeError(err) {
    let msg = err?.message || String(err);
    const cause = err?.cause;
    if (cause) {
        const detail = cause.code || cause.message || (typeof cause === 'string' ? cause : '');
        if (detail && !msg.includes(detail)) msg += ` (cause: ${detail})`;
    }
    return msg;
}

const state = {
    lastSync: null, // ISO string of last successful sync
    lastError: null, // string
    nextSyncEpoch: null, // ms epoch of next scheduled sync
    needsLogin: false, // true when the CLI has no usable session
    activity: null, // human-readable current step while syncing (null = idle)
    progress: null, // { index, total } during multi-item uploads, else null
};

/** Update the live activity/progress shown in the UI while a sync runs. */
function setActivity(activity, progress = null) {
    state.activity = activity;
    state.progress = progress;
}

// Cache of the resolved remote folder path, keyed by drive_folder, so we don't
// re-run ensureFolder's CLI calls on every status poll.
let cachedFolderKey = null;
let cachedFolderPath = null;

// Guards against overlapping syncs. runSync is triggered from several places
// (startup, the scheduler, post-login, and "Sync now"); overlapping runs race
// on retention and re-upload. Only one sync runs at a time.
let syncing = false;

function cfg() {
    return {
        driveFolder: process.env.DRIVE_FOLDER || 'Home Assistant Backups',
        intervalHours: parseInt(process.env.BACKUP_INTERVAL_HOURS || '0', 10) || 0,
        keepAutomaticInProton: parseInt(process.env.KEEP_AUTOMATIC_IN_PROTON || '0', 10) || 0,
        keepAppInProton: parseInt(process.env.KEEP_APP_IN_PROTON || '0', 10) || 0,
        keepAutomaticInHA: parseInt(process.env.KEEP_AUTOMATIC_IN_HA || '0', 10) || 0,
        keepAppInHA: parseInt(process.env.KEEP_APP_IN_HA || '0', 10) || 0,
        backupPassword: process.env.BACKUP_PASSWORD || undefined,
        dataDir: process.env.DATA_DIR || '/data',
    };
}

/**
 * Effective config for display in the Web UI. The backup password is NEVER
 * exposed — only a boolean saying whether one is set.
 */
export function getConfig() {
    const c = cfg();
    return {
        driveFolder: c.driveFolder,
        intervalHours: c.intervalHours,
        keepAutomaticInProton: c.keepAutomaticInProton,
        keepAppInProton: c.keepAppInProton,
        keepAutomaticInHA: c.keepAutomaticInHA,
        keepAppInHA: c.keepAppInHA,
        backupPasswordSet: !!c.backupPassword,
        stagingDir: process.env.STAGING_DIR || null,
    };
}

function tmpDir() {
    // Stage downloads OUTSIDE /data. HA full-backups include the add-on's /data
    // volume, so a backup created while a temp `.tar` sat in /data/tmp would
    // swallow it (observed: a 4.87 GB backup ballooning to 9.74 GB). The
    // container's tmpdir is ephemeral and is never part of an HA backup.
    return process.env.STAGING_DIR || join(tmpdir(), 'proton-drive-backup');
}

/** A download error for a backup HA lists but no longer serves (stale/phantom). */
export function isNotFoundError(err) {
    return err?.status === 404;
}

/** Resolve (and create if needed) the remote backup folder under /my-files. */
async function remoteFolder() {
    const { driveFolder } = cfg();
    if (cachedFolderKey === driveFolder && cachedFolderPath) return cachedFolderPath;
    const path = await cli.ensureFolder(`/my-files/${driveFolder}`);
    cachedFolderKey = driveFolder;
    cachedFolderPath = path;
    return path;
}

/** Any `.tar` in the configured folder is treated as a mirrored HA backup. */
export function isOurRemoteFile(name) {
    return typeof name === 'string' && name.endsWith('.tar');
}

/**
 * Classify a backup by NAME into the "automatic" bucket vs the "app" bucket.
 * Home Assistant names its scheduled full backups "Automatic backup <version>";
 * per-add-on and manual backups get other names. Works on BOTH an HA backup's
 * `name` and a Proton remote filename (`<sanitizedName> (<slug>).tar`) — the
 * ` (slug).tar` suffix can't affect a `^`-anchored prefix match, and
 * sanitizeName preserves the leading "Automatic backup" text.
 * @returns {boolean} true = automatic bucket; false = app bucket.
 */
export function isAutomaticBackup(name) {
    return /^Automatic backup/i.test(String(name ?? ''));
}

/**
 * Sanitise an HA backup name for use in a remote filename: replace `/` and any
 * control chars with `_`, collapse whitespace, and trim.
 */
export function sanitizeName(name) {
    return String(name ?? '')
        .replace(/[/\x00-\x1f\x7f]/g, '_') // slash + control chars
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * The remote filename for an HA backup: `<sanitizedName> (<slug>).tar`. The
 * `(slug)` suffix guarantees uniqueness and enables dedup on the next sync.
 */
export function remoteNameFor(backup) {
    return `${sanitizeName(backup?.name)} (${backup?.slug}).tar`;
}

/**
 * Extract the HA backup slug from a remote filename produced by remoteNameFor,
 * i.e. the trailing `(slug).tar`. Returns null if there is no such suffix.
 */
export function slugFromRemoteName(remoteName) {
    if (typeof remoteName !== 'string') return null;
    const m = remoteName.match(/\(([^()]+)\)\.tar$/);
    return m ? m[1] : null;
}

/** Build a Set of the HA backup slugs currently mirrored in Proton. */
function protonSlugSet(remoteEntries) {
    const set = new Set();
    for (const e of remoteEntries || []) {
        const slug = slugFromRemoteName(e?.name);
        if (slug) set.add(slug);
    }
    return set;
}

// --- Pure decision logic (no I/O) — unit-tested in test/orchestrator.test.mjs ---

/**
 * Which HA backups are not yet mirrored in Proton? Dedup by the HA backup slug
 * (parsed from each Proton entry's filename). Uploads ALL HA backups — automatic
 * and manual — whose slug is absent from Proton.
 * @param {Array<{slug:string,name:string}>} haBackups
 * @param {Array<{name:string}>} remoteEntries - Proton folder entries.
 * @returns {Array<{slug:string, name:string, remoteName:string}>}
 */
export function selectToUpload(haBackups, remoteEntries) {
    const present = protonSlugSet(remoteEntries);
    return (haBackups || [])
        .filter((b) => b && b.slug)
        .map((b) => ({ slug: b.slug, name: b.name, remoteName: remoteNameFor(b) }))
        .filter((x) => !present.has(x.slug));
}

/**
 * Which remote files to trash to satisfy Proton retention. Retention is split
 * into two INDEPENDENT buckets by name (isAutomaticBackup): the automatic bucket
 * keeps the newest `keepAutomatic`, the app bucket the newest `keepApp`. Within
 * each bucket, sort by DATE (newest first, from the Proton entry) and return
 * everything beyond that bucket's keep. keep<=0 for a bucket keeps ALL of it, so
 * an app-backup burst can never evict the automatic backups. Any `.tar` in the
 * folder is treated as a mirrored backup.
 * @param {Array<{name:string,date?:string}>} entries
 * @param {number} keepAutomatic - newest automatic backups to keep; <=0 = keep all.
 * @param {number} keepApp - newest app backups to keep; <=0 = keep all.
 * @returns {string[]} remote filenames to trash (from both buckets).
 */
export function selectProtonToPrune(entries, keepAutomatic, keepApp) {
    const ours = (entries || []).filter((e) => isOurRemoteFile(e.name));
    const byDateDesc = (a, b) => new Date(b.date || 0) - new Date(a.date || 0); // newest first
    const pruneBucket = (bucket, keep) => {
        if (!keep || keep <= 0) return [];
        return bucket.slice().sort(byDateDesc).slice(keep).map((e) => e.name);
    };
    const automatic = ours.filter((e) => isAutomaticBackup(e.name));
    const app = ours.filter((e) => !isAutomaticBackup(e.name));
    return [...pruneBucket(automatic, keepAutomatic), ...pruneBucket(app, keepApp)];
}

/**
 * Which local HA backups to delete to satisfy the manual HA retention limits.
 * Split into two INDEPENDENT buckets by name (isAutomaticBackup): keep the
 * newest `keepAutomatic` automatic backups and the newest `keepApp` app backups;
 * per bucket, candidates are the oldest ones beyond that keep (keep<=0 for a
 * bucket = delete NONE of it).
 *
 * SAFETY: only ever returns slugs that are CONFIRMED present in Proton
 * (`protonSlugs`), in EITHER bucket. A backup that has not been mirrored offsite
 * is NEVER returned, no matter how old — this function cannot select an
 * un-mirrored backup for deletion.
 *
 * @param {Array<{slug:string,name?:string,date?:string}>} haBackups
 * @param {Set<string>|string[]} protonSlugs - slugs confirmed present in Proton.
 * @param {number} keepAutomatic - newest automatic backups to keep; <=0 = delete none.
 * @param {number} keepApp - newest app backups to keep; <=0 = delete none.
 * @returns {string[]} slugs to delete (all of which are in protonSlugs).
 */
export function selectHALocalToPrune(haBackups, protonSlugs, keepAutomatic, keepApp) {
    const inProton = protonSlugs instanceof Set ? protonSlugs : new Set(protonSlugs || []);
    const ours = (haBackups || []).filter((b) => b && b.slug);
    const byDateAsc = (a, b) => new Date(a.date || 0) - new Date(b.date || 0); // oldest first
    const pruneBucket = (bucket, keep) => {
        if (!keep || keep <= 0) return [];
        const sorted = bucket.slice().sort(byDateAsc);
        const excess = sorted.length - keep;
        if (excess <= 0) return [];
        // Oldest beyond the newest `keep`; of those delete ONLY ones in Proton.
        return sorted.slice(0, excess)
            .filter((b) => inProton.has(b.slug))
            .map((b) => b.slug);
    };
    const automatic = ours.filter((b) => isAutomaticBackup(b.name));
    const app = ours.filter((b) => !isAutomaticBackup(b.name));
    return [...pruneBucket(automatic, keepAutomatic), ...pruneBucket(app, keepApp)];
}

/** Clear the last error shown in the UI. */
export function clearError() {
    state.lastError = null;
}

export function setNextSyncEpoch(epoch) {
    state.nextSyncEpoch = epoch;
}

export function getStatus() {
    return {
        lastSync: state.lastSync,
        lastError: state.lastError,
        nextSyncEpoch: state.nextSyncEpoch,
        needsLogin: state.needsLogin,
        syncing,
        activity: state.activity,
        progress: state.progress,
    };
}

/**
 * List the mirrored backups currently in Proton Drive (for the UI). Returns
 * [{ name, size?, date? }] where `name` is the remote filename (the id used by
 * restore/delete) and `date` comes from the Proton entry. Returns [] if not
 * connected or the folder is empty.
 */
export async function listProtonBackups() {
    const folder = await remoteFolder();
    const entries = await cli.list(folder);
    return entries
        .filter((e) => isOurRemoteFile(e.name))
        .map((e) => ({ name: e.name, size: e.size, date: e.date }));
}

/** Delete (trash) one mirrored backup by its remote filename. */
export async function deleteProtonBackup(remoteName) {
    const folder = await remoteFolder();
    // Remote names don't contain '/', so no escaping is needed here.
    await cli.trash(`${folder}/${remoteName}`);
}

/**
 * Ensure we have a working CLI session. Does NOT auto-login — the UI drives
 * sign-in. Sets state.needsLogin when disconnected and returns false; clears it
 * and returns true when connected.
 */
export async function ensureSession() {
    const connected = await cli.isConnected();
    state.needsLogin = !connected;
    if (!connected) {
        console.debug('[orchestrator] ensureSession: not logged in (needsLogin=true)');
    } else {
        console.debug('[orchestrator] ensureSession: session OK');
    }
    return connected;
}

async function syncBackupsToProton() {
    const folder = await remoteFolder();
    console.debug('[orchestrator] syncBackupsToProton: listing HA and Proton backups...');
    const [haBackups, remoteEntries] = await Promise.all([
        supervisor.listBackups(),
        cli.list(folder),
    ]);

    // Dedup by HA slug — every HA backup (automatic + manual) not yet in Proton.
    const toUpload = selectToUpload(haBackups, remoteEntries);
    console.debug(`[orchestrator] HA backups: ${haBackups.length}, Proton files: ${remoteEntries.length}, to upload: ${toUpload.length}`);

    await mkdir(tmpDir(), { recursive: true });

    let uploaded = 0;
    let errors = 0;
    let skipped = 0;
    for (const [i, item] of toUpload.entries()) {
        setActivity(`Uploading ${i + 1} of ${toUpload.length}: ${item.name}`, { index: i + 1, total: toUpload.length });
        // Stage the local file under its final remote name so the CLI upload
        // (which derives the remote name from the local basename) produces
        // `<sanitizedName> (<slug>).tar` remotely.
        const tmpPath = join(tmpDir(), item.remoteName);
        try {
            console.log(`[orchestrator] Uploading HA backup ${item.slug} ("${item.name}") to Proton`);
            console.debug(`[orchestrator] Downloading from Supervisor → ${tmpPath}`);
            await supervisor.downloadBackup(item.slug, tmpPath);
            console.debug(`[orchestrator] Uploading "${item.remoteName}" to Drive folder "${folder}"...`);
            await cli.uploadFile(tmpPath, folder, { conflictStrategy: 'replace' });
            uploaded++;
            console.debug(`[orchestrator] Upload of "${item.remoteName}" complete`);
        } catch (err) {
            if (isNotFoundError(err)) {
                // HA lists this backup but no longer serves it (stale/phantom
                // entry). Nothing we can upload — skip quietly, don't raise a
                // hard error that dominates the UI on every sync.
                skipped++;
                console.warn(`[orchestrator] Skipping ${item.slug} ("${item.name}") — HA no longer serves this backup (404); likely a stale/removed entry, delete it in HA to silence this.`);
            } else {
                errors++;
                state.lastError = `Upload of ${item.slug} failed: ${describeError(err)}`;
                console.error(`[orchestrator] ${state.lastError}`);
            }
        } finally {
            await rm(tmpPath, { force: true }).catch(() => {});
        }
    }
    console.debug(`[orchestrator] syncBackupsToProton done: ${uploaded} uploaded, ${skipped} skipped, ${errors} errors`);
}

export async function pruneProton() {
    const { keepAutomaticInProton, keepAppInProton } = cfg();
    if (keepAutomaticInProton <= 0 && keepAppInProton <= 0) {
        console.debug('[orchestrator] pruneProton: retention disabled (both buckets keep all), skipping');
        return;
    }

    const folder = await remoteFolder();
    const entries = await cli.list(folder);
    const toPrune = selectProtonToPrune(entries, keepAutomaticInProton, keepAppInProton);
    console.debug(`[orchestrator] pruneProton: keep_automatic=${keepAutomaticInProton} keep_app=${keepAppInProton} to_prune=${toPrune.length}`);
    for (const name of toPrune) {
        try {
            console.log(`[orchestrator] Pruning Proton backup "${name}"`);
            await cli.trash(`${folder}/${name}`);
        } catch (err) {
            state.lastError = `Proton prune failed: ${describeError(err)}`;
            console.error(`[orchestrator] ${state.lastError}`);
        }
    }
}

/**
 * Manually delete local HA backups beyond the newest keep-count PER BUCKET
 * (`keep_automatic_in_ha` / `keep_app_in_ha`), but ONLY ones confirmed present
 * in Proton (SAFETY: never delete an un-mirrored backup, in either bucket).
 * Never runs automatically. Returns { deleted, skippedNotInProton }.
 */
export async function pruneHALocalNow() {
    const { keepAutomaticInHA, keepAppInHA } = cfg();
    if (keepAutomaticInHA <= 0 && keepAppInHA <= 0) {
        console.debug('[orchestrator] pruneHALocalNow: HA retention disabled (both buckets 0)');
        return { deleted: 0, skippedNotInProton: 0 };
    }

    const folder = await remoteFolder();
    const [haBackups, remoteEntries] = await Promise.all([
        supervisor.listBackups(),
        cli.list(folder),
    ]);
    const protonSlugs = protonSlugSet(remoteEntries);

    // Candidates per bucket = the oldest backups beyond that bucket's keep (what
    // retention wants gone). Of those, we only actually delete ones in Proton;
    // the difference is reported as "skipped, not yet in Proton".
    const ours = (haBackups || []).filter((b) => b && b.slug);
    const bucketExcess = (bucket, keep) => (!keep || keep <= 0 ? 0 : Math.max(0, bucket.length - keep));
    const automatic = ours.filter((b) => isAutomaticBackup(b.name));
    const app = ours.filter((b) => !isAutomaticBackup(b.name));
    const candidateCount = bucketExcess(automatic, keepAutomaticInHA) + bucketExcess(app, keepAppInHA);
    const toDelete = selectHALocalToPrune(haBackups, protonSlugs, keepAutomaticInHA, keepAppInHA);
    const skippedNotInProton = candidateCount - toDelete.length;

    console.debug(`[orchestrator] pruneHALocalNow: keep_automatic=${keepAutomaticInHA} keep_app=${keepAppInHA} total_ha=${ours.length} candidates=${candidateCount} to_delete=${toDelete.length} skipped_not_in_proton=${skippedNotInProton}`);

    let deleted = 0;
    for (const slug of toDelete) {
        try {
            console.log(`[orchestrator] Deleting local HA backup ${slug} (confirmed present in Proton)`);
            await supervisor.deleteBackup(slug);
            deleted++;
        } catch (err) {
            state.lastError = `HA clean-up failed: ${describeError(err)}`;
            console.error(`[orchestrator] ${state.lastError}`);
        }
    }
    return { deleted, skippedNotInProton };
}

export async function runSync(force = false) {
    if (syncing) {
        console.warn('[orchestrator] runSync: a sync is already running — skipping this trigger');
        return;
    }
    syncing = true;
    console.debug(`[orchestrator] runSync: started (force=${!!force})`);
    try {
        state.lastError = null;
        setActivity('Checking connection…');
        console.debug('[orchestrator] runSync: checking session...');
        const connected = await ensureSession();
        if (!connected) {
            state.lastError = 'Not connected to Proton Drive — sign in from the Web UI.';
            console.warn('[orchestrator] runSync: not connected, skipping (awaiting login)');
            return;
        }
        console.debug('[orchestrator] runSync: session ready');

        console.debug('[orchestrator] runSync: uploading missing HA backups to Proton...');
        setActivity('Checking Proton Drive…');
        await syncBackupsToProton();
        console.debug('[orchestrator] runSync: pruning Proton...');
        setActivity('Pruning old Proton backups…');
        await pruneProton();

        state.lastSync = new Date().toISOString();
        console.log(`[orchestrator] Sync complete at ${state.lastSync}`);
        console.debug('[orchestrator] runSync: finished successfully');
    } catch (err) {
        state.lastError = describeError(err);
        console.error(`[orchestrator] Sync failed: ${state.lastError}`);
    } finally {
        syncing = false;
        setActivity(null);
    }
}

/**
 * Manually create a new full HA backup on demand, then mirror it to Proton.
 * On-demand only (no automatic/scheduled creation). Never throws out — records
 * state.lastError like runSync, and honours the single-sync guard.
 */
export async function createBackupNow() {
    if (syncing) {
        console.warn('[orchestrator] createBackupNow: a sync/backup is already running — skipping');
        return;
    }
    syncing = true;
    try {
        state.lastError = null;
        setActivity('Checking connection…');
        if (!(await ensureSession())) {
            state.lastError = 'Not connected to Proton Drive — sign in from the Web UI.';
            return;
        }
        const { backupPassword } = cfg();
        const name = `Manual backup ${new Date().toISOString()}`;
        setActivity('Creating Home Assistant backup…');
        console.log(`[orchestrator] Creating manual HA backup "${name}"`);
        try {
            await supervisor.createBackup({ name, password: backupPassword });
            console.debug('[orchestrator] Manual backup created');
        } catch (err) {
            const msg = describeError(err);
            state.lastError = /freeze|not running|blocked from execution/i.test(msg)
                ? 'Home Assistant is busy (a backup/operation is already running) — try again shortly.'
                : `Backup creation failed: ${msg}`;
            console.error(`[orchestrator] ${state.lastError}`);
            return;
        }
        // Mirror the just-created backup (and any others) to Proton.
        setActivity('Checking Proton Drive…');
        await syncBackupsToProton();
        setActivity('Pruning old backups…');
        await pruneProton();
        state.lastSync = new Date().toISOString();
        console.log('[orchestrator] Manual backup created and synced');
    } catch (err) {
        state.lastError = describeError(err);
        console.error(`[orchestrator] Manual backup failed: ${state.lastError}`);
    } finally {
        syncing = false;
        setActivity(null);
    }
}

/**
 * Restore a Proton backup (identified by its remote filename) into HA:
 * download it, upload it to the Supervisor, then start a full restore.
 */
export async function restoreToHA(remoteName) {
    const { backupPassword } = cfg();
    console.debug(`[orchestrator] restoreToHA: remoteName="${remoteName}"`);
    const connected = await ensureSession();
    if (!connected) throw new Error('Not connected to Proton Drive — sign in from the Web UI.');

    const folder = await remoteFolder();
    await mkdir(tmpDir(), { recursive: true });
    // CLI downloads INTO a folder, keeping the remote filename.
    const tmpPath = join(tmpDir(), remoteName);
    try {
        console.log(`[orchestrator] Restoring Proton backup "${remoteName}"`);
        console.debug('[orchestrator] restoreToHA: downloading from Drive...');
        await cli.downloadPath(`${folder}/${remoteName}`, tmpDir());
        console.debug('[orchestrator] restoreToHA: uploading to Supervisor...');
        const slug = await supervisor.uploadBackup(tmpPath);
        console.debug(`[orchestrator] restoreToHA: starting HA restore for slug=${slug}...`);
        await supervisor.restoreBackup(slug, backupPassword);
        console.log(`[orchestrator] Restore of "${remoteName}" started (slug ${slug})`);
        return { slug };
    } finally {
        await rm(tmpPath, { force: true }).catch(() => {});
    }
}
