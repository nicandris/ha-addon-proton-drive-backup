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
    const haBackups = await supervisor.listBackups();
    const protonBackups = await proton.listBackups(driveFolder);

    const presentSlugs = new Set(
        protonBackups.map((b) => b.metadata?.slug).filter(Boolean),
    );

    await mkdir(tmpDir(), { recursive: true });

    for (const ha of haBackups) {
        if (presentSlugs.has(ha.slug)) continue;
        const tmpPath = join(tmpDir(), `${ha.slug}.tar`);
        try {
            console.log(`[orchestrator] Uploading HA backup ${ha.slug} (${ha.name}) to Proton`);
            await supervisor.downloadBackup(ha.slug, tmpPath);
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
        } catch (err) {
            state.lastError = `Upload of ${ha.slug} failed: ${describeError(err)}`;
            console.error(`[orchestrator] ${state.lastError}`);
        } finally {
            await rm(tmpPath, { force: true }).catch(() => {});
        }
    }
}

export async function pruneProton() {
    const { driveFolder, backupsInProton } = cfg();
    if (backupsInProton <= 0) return;

    const backups = await proton.listBackups(driveFolder);
    const sorted = [...backups].sort(
        (a, b) => new Date(a.metadata?.date || 0) - new Date(b.metadata?.date || 0),
    );
    const excess = sorted.length - backupsInProton;
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
    if (backupsInHA <= 0) return;

    const haBackups = await supervisor.listBackups();
    // Only ever touch backups this add-on created.
    const ours = haBackups.filter((b) => (b.name || '').startsWith(ADDON_BACKUP_PREFIX));
    const sorted = ours.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    const excess = sorted.length - backupsInHA;
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
    try {
        state.lastError = null;
        await ensureSession();

        const { intervalHours, backupPassword, fullBackup } = cfg();
        if (intervalHours > 0) {
            const name = `${ADDON_BACKUP_PREFIX} ${new Date().toISOString()}`;
            console.log(`[orchestrator] Creating new HA backup "${name}"`);
            try {
                await supervisor.createBackup({ name, password: backupPassword, full: fullBackup });
            } catch (err) {
                state.lastError = `Backup creation failed: ${describeError(err)}`;
                console.error(`[orchestrator] ${state.lastError}`);
            }
        }

        await syncBackupsToProton();
        await pruneProton();
        await pruneHA();

        state.lastSync = new Date().toISOString();
        console.log(`[orchestrator] Sync complete at ${state.lastSync}`);
    } catch (err) {
        state.lastError = describeError(err);
        console.error(`[orchestrator] Sync failed: ${state.lastError}`);
    }
}

export async function restoreToHA(linkId) {
    const { dataDir, backupPassword } = cfg();
    await mkdir(tmpDir(), { recursive: true });
    const tmpPath = join(tmpDir(), 'restore.tar');
    try {
        await ensureSession();
        console.log(`[orchestrator] Restoring Proton backup ${linkId}`);
        await proton.downloadBackup(linkId, tmpPath);
        const slug = await supervisor.uploadBackup(tmpPath);
        await supervisor.restoreBackup(slug, backupPassword);
        console.log(`[orchestrator] Restore of ${linkId} started (slug ${slug})`);
        return { slug };
    } finally {
        await rm(tmpPath, { force: true }).catch(() => {});
    }
}
