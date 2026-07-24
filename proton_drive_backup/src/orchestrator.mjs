/**
 * Core sync logic: creates HA backups, uploads them to Proton Drive via the
 * official `proton-drive` CLI, mirrors what exists where, and enforces retention
 * on both sides.
 *
 * The CLI has NO metadata API, so backups are identified purely by FILENAME.
 * The add-on names its HA backups `Proton Drive Backup <ISO timestamp>`; the
 * remote file is `<name>.tar`, which sorts chronologically for retention.
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

const ADDON_BACKUP_PREFIX = 'Proton Drive Backup';

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
// (startup, the scheduler, post-login, and "back up now"); two at once make HA
// reject the second createBackup with "system is not running - freeze" and race
// on retention. Only one sync runs at a time.
let syncing = false;

function cfg() {
    return {
        driveFolder: process.env.DRIVE_FOLDER || 'Home Assistant Backups',
        intervalHours: parseInt(process.env.BACKUP_INTERVAL_HOURS || '0', 10) || 0,
        backupsInProton: parseInt(process.env.BACKUPS_IN_PROTON || '0', 10) || 0,
        backupsInHA: parseInt(process.env.BACKUPS_IN_HA || '0', 10) || 0,
        fullBackup: (process.env.FULL_BACKUP || 'true').toLowerCase() !== 'false',
        backupPassword: process.env.BACKUP_PASSWORD || undefined,
        dataDir: process.env.DATA_DIR || '/data',
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

/** Our remote files: `<name>.tar` where name starts with the add-on prefix. */
export function isOurRemoteFile(name) {
    return typeof name === 'string'
        && name.startsWith(ADDON_BACKUP_PREFIX)
        && name.endsWith('.tar');
}

/** Is this HA backup one this add-on created? */
export function isOurHABackup(b) {
    return (b?.name || '').startsWith(ADDON_BACKUP_PREFIX);
}

/** The remote filename for an HA backup (`<name>.tar`). */
export function remoteNameFor(backup) {
    return `${backup.name}.tar`;
}

/** Derive an ISO date string from `Proton Drive Backup <ISO>.tar` (best effort). */
export function dateFromRemoteName(name) {
    const stamp = name.slice(ADDON_BACKUP_PREFIX.length, -'.tar'.length).trim();
    const d = new Date(stamp);
    return isNaN(d.getTime()) ? null : d.toISOString();
}

// --- Pure decision logic (no I/O) — unit-tested in test/orchestrator.test.mjs ---

/**
 * Which of our HA backups are not yet in Proton? Dedup by remote filename.
 * @param {Array<{slug:string,name:string}>} haBackups
 * @param {Array<{name:string}>} remoteEntries
 * @returns {Array<{slug:string, name:string, remoteName:string}>}
 */
export function selectToUpload(haBackups, remoteEntries) {
    const present = new Set((remoteEntries || []).map((e) => e.name));
    return (haBackups || [])
        .filter(isOurHABackup)
        .map((b) => ({ slug: b.slug, name: b.name, remoteName: remoteNameFor(b) }))
        .filter((x) => !present.has(x.remoteName));
}

/**
 * Which remote files to trash to satisfy retention. Our files only, oldest
 * first (name embeds an ISO timestamp so a lexical sort is chronological).
 * @param {Array<{name:string}>} entries
 * @param {number} keep - 0/negative = keep everything.
 * @returns {string[]} remote filenames to trash.
 */
export function selectProtonToPrune(entries, keep) {
    if (!keep || keep <= 0) return [];
    const ours = (entries || [])
        .filter((e) => isOurRemoteFile(e.name))
        .sort((a, b) => a.name.localeCompare(b.name));
    const excess = ours.length - keep;
    return excess > 0 ? ours.slice(0, excess).map((e) => e.name) : [];
}

/**
 * Which HA backups to delete to satisfy retention. Our backups only, oldest
 * first by date.
 * @param {Array<{slug:string,name:string,date?:string}>} haBackups
 * @param {number} keep - 0/negative = keep everything.
 * @returns {string[]} slugs to delete.
 */
export function selectHAToPrune(haBackups, keep) {
    if (!keep || keep <= 0) return [];
    const ours = (haBackups || [])
        .filter(isOurHABackup)
        .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    const excess = ours.length - keep;
    return excess > 0 ? ours.slice(0, excess).map((b) => b.slug) : [];
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
 * List our backups currently in Proton Drive (for the UI). Returns
 * [{ name, size?, date? }] where `name` is the remote filename (the id used by
 * restore/delete). Returns [] if not connected or the folder is empty.
 */
export async function listProtonBackups() {
    const folder = await remoteFolder();
    const entries = await cli.list(folder);
    return entries
        .filter((e) => isOurRemoteFile(e.name))
        .map((e) => ({ name: e.name, size: e.size, date: dateFromRemoteName(e.name) }));
}

/** Delete (trash) one of our remote backups by its remote filename. */
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

    // Dedup by remote filename — only backups this add-on created, not yet in Proton.
    const toUpload = selectToUpload(haBackups, remoteEntries);
    console.debug(`[orchestrator] HA files: ${haBackups.length}, Proton files: ${remoteEntries.length}, to upload: ${toUpload.length}`);

    await mkdir(tmpDir(), { recursive: true });

    let uploaded = 0;
    let errors = 0;
    let skipped = 0;
    for (const [i, item] of toUpload.entries()) {
        setActivity(`Uploading ${i + 1} of ${toUpload.length}: ${item.name}`, { index: i + 1, total: toUpload.length });
        // Stage the local file under its final remote name so the CLI upload
        // (which derives the remote name from the local basename) produces
        // `<name>.tar` remotely.
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
    const { backupsInProton } = cfg();
    if (backupsInProton <= 0) {
        console.debug('[orchestrator] pruneProton: retention disabled, skipping');
        return;
    }

    const folder = await remoteFolder();
    const entries = await cli.list(folder);
    const toPrune = selectProtonToPrune(entries, backupsInProton);
    console.debug(`[orchestrator] pruneProton: retention=${backupsInProton} to_prune=${toPrune.length}`);
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

export async function pruneHA() {
    const { backupsInHA } = cfg();
    if (backupsInHA <= 0) {
        console.debug('[orchestrator] pruneHA: retention disabled, skipping');
        return;
    }

    const haBackups = await supervisor.listBackups();
    const toPrune = selectHAToPrune(haBackups, backupsInHA);
    console.debug(`[orchestrator] pruneHA: retention=${backupsInHA} total_ha=${haBackups.length} to_prune=${toPrune.length}`);
    for (const slug of toPrune) {
        try {
            console.log(`[orchestrator] Pruning HA backup ${slug}`);
            await supervisor.deleteBackup(slug);
        } catch (err) {
            state.lastError = `HA prune failed: ${describeError(err)}`;
            console.error(`[orchestrator] ${state.lastError}`);
        }
    }
}

export async function runSync() {
    if (syncing) {
        console.warn('[orchestrator] runSync: a sync is already running — skipping this trigger');
        return;
    }
    syncing = true;
    console.debug('[orchestrator] runSync: started');
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

        const { intervalHours, backupPassword, fullBackup } = cfg();
        if (intervalHours > 0) {
            setActivity('Creating Home Assistant backup…');
            const name = `${ADDON_BACKUP_PREFIX} ${new Date().toISOString()}`;
            console.log(`[orchestrator] Creating new HA backup "${name}"`);
            console.debug(`[orchestrator] Backup params: full=${fullBackup} password=${backupPassword ? 'set' : 'none'}`);
            try {
                await supervisor.createBackup({ name, password: backupPassword, full: fullBackup });
                console.debug('[orchestrator] HA backup created successfully');
            } catch (err) {
                state.lastError = `Backup creation failed: ${describeError(err)}`;
                console.error(`[orchestrator] ${state.lastError}`);
            }
        } else {
            console.debug('[orchestrator] runSync: interval=0, skipping backup creation (upload-only mode)');
        }

        console.debug('[orchestrator] runSync: syncing to Proton...');
        setActivity('Checking Proton Drive…');
        await syncBackupsToProton();
        console.debug('[orchestrator] runSync: pruning Proton...');
        setActivity('Pruning old backups…');
        await pruneProton();
        console.debug('[orchestrator] runSync: pruning HA...');
        await pruneHA();

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
