/**
 * Core sync logic: creates HA backups, uploads them to Proton Drive, mirrors
 * what exists where, and enforces retention on both sides.
 *
 * Resilient by design: per-backup errors are caught and logged, lastError is
 * recorded, and runSync never throws out (so it can't crash the scheduler or
 * the ingress server).
 */

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import * as supervisor from './supervisor.mjs';
import * as proton from './protonClient.mjs';
import { ensureSession } from './protonAuth.mjs';

const ADDON_BACKUP_PREFIX = 'Proton Drive Backup';

// Node's fetch throws a bare "fetch failed" and stashes the real network error
// (DNS, connection refused, TLS, etc.) on err.cause — surface it so failures
// are actually diagnosable.
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
};

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
    return join(cfg().dataDir, 'tmp');
}

export function setNextSyncEpoch(epoch) {
    state.nextSyncEpoch = epoch;
}

export function getStatus() {
    return {
        lastSync: state.lastSync,
        lastError: state.lastError,
        nextSyncEpoch: state.nextSyncEpoch,
    };
}

async function syncBackupsToProton() {
    const { driveFolder, dataDir } = cfg();
    console.debug('[orchestrator] syncBackupsToProton: listing HA and Proton backups...');
    const [haBackups, protonBackups] = await Promise.all([
        supervisor.listBackups(),
        proton.listBackups(driveFolder),
    ]);
    console.debug(`[orchestrator] HA backups: ${haBackups.length}, Proton backups: ${protonBackups.length}`);

    const presentSlugs = new Set(
        protonBackups.map((b) => b.metadata?.slug).filter(Boolean),
    );
    console.debug(`[orchestrator] Slugs already in Proton: ${[...presentSlugs].join(', ') || '(none)'}`);

    await mkdir(tmpDir(), { recursive: true });

    let uploaded = 0;
    for (const ha of haBackups) {
        if (presentSlugs.has(ha.slug)) {
            console.debug(`[orchestrator] Skipping ${ha.slug} — already in Proton`);
            continue;
        }
        const tmpPath = join(tmpDir(), `${ha.slug}.tar`);
        try {
            console.log(`[orchestrator] Uploading HA backup ${ha.slug} (${ha.name}) to Proton`);
            console.debug(`[orchestrator] Downloading from Supervisor → ${tmpPath}`);
            await supervisor.downloadBackup(ha.slug, tmpPath);
            console.debug(`[orchestrator] Uploading ${ha.slug} to Drive folder "${driveFolder}"...`);
            await proton.uploadBackup(
                tmpPath,
                `${ha.name}.tar`,
                {
                    slug: ha.slug,
                    date: ha.date,
                    name: ha.name,
                    size: ha.size,
                    type: ha.type,
                },
                driveFolder,
            );
            uploaded++;
            console.debug(`[orchestrator] Upload of ${ha.slug} complete`);
        } catch (err) {
            state.lastError = `Upload of ${ha.slug} failed: ${describeError(err)}`;
            console.error(`[orchestrator] ${state.lastError}`);
        } finally {
            await rm(tmpPath, { force: true }).catch(() => {});
        }
    }
    console.debug(`[orchestrator] syncBackupsToProton done: ${uploaded} uploaded, ${haBackups.length - uploaded - (haBackups.length - presentSlugs.size - uploaded < 0 ? 0 : haBackups.length - presentSlugs.size - uploaded)} errors`);
}

export async function pruneProton() {
    const { driveFolder, backupsInProton } = cfg();
    if (backupsInProton <= 0) {
        console.debug('[orchestrator] pruneProton: retention disabled, skipping');
        return;
    }

    const backups = await proton.listBackups(driveFolder);
    const sorted = [...backups].sort(
        (a, b) => new Date(a.metadata?.date || 0) - new Date(b.metadata?.date || 0),
    );
    const excess = sorted.length - backupsInProton;
    console.debug(`[orchestrator] pruneProton: retention=${backupsInProton} current=${sorted.length} to_prune=${Math.max(0, excess)}`);
    for (let i = 0; i < excess; i++) {
        const b = sorted[i];
        try {
            console.log(`[orchestrator] Pruning Proton backup ${b.metadata?.slug || b.linkId}`);
            await proton.deleteBackup(b.linkId);
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
    // Only ever touch backups this add-on created.
    const ours = haBackups.filter((b) => (b.name || '').startsWith(ADDON_BACKUP_PREFIX));
    const sorted = ours.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    const excess = sorted.length - backupsInHA;
    console.debug(`[orchestrator] pruneHA: retention=${backupsInHA} ours=${ours.length} total_ha=${haBackups.length} to_prune=${Math.max(0, excess)}`);
    for (let i = 0; i < excess; i++) {
        const b = sorted[i];
        try {
            console.log(`[orchestrator] Pruning HA backup ${b.slug} (${b.name})`);
            await supervisor.deleteBackup(b.slug);
        } catch (err) {
            state.lastError = `HA prune failed: ${describeError(err)}`;
            console.error(`[orchestrator] ${state.lastError}`);
        }
    }
}

export async function runSync() {
    console.debug('[orchestrator] runSync: started');
    try {
        state.lastError = null;
        console.debug('[orchestrator] runSync: ensuring session...');
        await ensureSession();
        console.debug('[orchestrator] runSync: session ready');

        const { intervalHours, backupPassword, fullBackup } = cfg();
        if (intervalHours > 0) {
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
        await syncBackupsToProton();
        console.debug('[orchestrator] runSync: pruning Proton...');
        await pruneProton();
        console.debug('[orchestrator] runSync: pruning HA...');
        await pruneHA();

        state.lastSync = new Date().toISOString();
        console.log(`[orchestrator] Sync complete at ${state.lastSync}`);
        console.debug('[orchestrator] runSync: finished successfully');
    } catch (err) {
        state.lastError = describeError(err);
        console.error(`[orchestrator] Sync failed: ${state.lastError}`);
    }
}

export async function restoreToHA(linkId) {
    const { dataDir, backupPassword } = cfg();
    console.debug(`[orchestrator] restoreToHA: linkId=${linkId}`);
    await mkdir(tmpDir(), { recursive: true });
    const tmpPath = join(tmpDir(), 'restore.tar');
    try {
        await ensureSession();
        console.log(`[orchestrator] Restoring Proton backup ${linkId}`);
        console.debug('[orchestrator] restoreToHA: downloading from Drive...');
        await proton.downloadBackup(linkId, tmpPath);
        console.debug('[orchestrator] restoreToHA: uploading to Supervisor...');
        const slug = await supervisor.uploadBackup(tmpPath);
        console.debug(`[orchestrator] restoreToHA: starting HA restore for slug=${slug}...`);
        await supervisor.restoreBackup(slug, backupPassword);
        console.log(`[orchestrator] Restore of ${linkId} started (slug ${slug})`);
        return { slug };
    } finally {
        await rm(tmpPath, { force: true }).catch(() => {});
    }
}
