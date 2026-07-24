/**
 * Entry point for the Proton Drive Backup add-on.
 *
 * Ensures the temp directory exists, starts the ingress server, runs an initial
 * sync shortly after startup, and (if configured) schedules recurring syncs.
 * Authentication is owned by the proton-drive CLI (browser sign-in via the Web
 * UI), so there is no crypto/login setup here. Logs to stdout with timestamps
 * and exits cleanly on SIGTERM.
 */

// Must be first import so console is patched before any other module logs.
import { setLogLevel } from './logger.mjs';

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { startIngressServer } from './ingress.mjs';
import { runSync, setNextSyncEpoch } from './orchestrator.mjs';

function readConfig() {
    return {
        driveFolder: process.env.DRIVE_FOLDER || 'Home Assistant Backups',
        intervalHours: parseInt(process.env.BACKUP_INTERVAL_HOURS || '0', 10) || 0,
        backupsInProton: parseInt(process.env.BACKUPS_IN_PROTON || '0', 10) || 0,
        backupsInHA: parseInt(process.env.BACKUPS_IN_HA || '0', 10) || 0,
        fullBackup: (process.env.FULL_BACKUP || 'true').toLowerCase() !== 'false',
        logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
        port: parseInt(process.env.PORT || '8099', 10),
        dataDir: process.env.DATA_DIR || '/data',
    };
}

async function main() {
    const config = readConfig();
    setLogLevel(config.logLevel);

    console.log('Starting Proton Drive Backup add-on');
    console.log(
        `Config: folder="${config.driveFolder}", interval=${config.intervalHours}h, ` +
            `proton retention=${config.backupsInProton}, HA retention=${config.backupsInHA}, ` +
            `full=${config.fullBackup}`,
    );
    console.debug(`[main] Full config: ${JSON.stringify(config)}`);

    await mkdir(join(config.dataDir, 'tmp'), { recursive: true });
    console.debug(`[main] Temp dir: ${join(config.dataDir, 'tmp')}`);

    startIngressServer();

    if (config.intervalHours > 0) {
        setNextSyncEpoch(Date.now() + 5000);
        console.debug(`[main] Scheduler: first sync in 5 s, then every ${config.intervalHours}h`);
    }

    // Initial sync shortly after startup. Errors are swallowed by runSync, but
    // guard anyway so a failure never takes down the ingress server.
    setTimeout(() => {
        console.debug('[main] Running initial sync');
        runSync()
            .then(() => {
                if (config.intervalHours > 0) {
                    const nextMs = config.intervalHours * 3600 * 1000;
                    setNextSyncEpoch(Date.now() + nextMs);
                }
            })
            .catch((err) => console.error(`Initial sync error: ${err.message}`));
    }, 5000);

    if (config.intervalHours > 0) {
        const intervalMs = config.intervalHours * 3600 * 1000;
        setInterval(() => {
            console.debug('[main] Scheduled sync triggered');
            runSync()
                .then(() => setNextSyncEpoch(Date.now() + intervalMs))
                .catch((err) => console.error(`Scheduled sync error: ${err.message}`));
        }, intervalMs);
    }

    const shutdown = (signal) => {
        console.log(`Received ${signal}, shutting down`);
        process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
    console.error(`Fatal startup error: ${err.message}`);
    process.exit(1);
});
