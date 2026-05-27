/**
 * Entry point for the Proton Drive Backup add-on.
 *
 * Initializes crypto, ensures the temp directory exists, starts the ingress
 * server, runs an initial sync shortly after startup, and (if configured)
 * schedules recurring syncs. Logs to stdout with timestamps and exits cleanly
 * on SIGTERM.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { setupCrypto } from './cryptoSetup.mjs';
import { startIngressServer } from './ingress.mjs';
import { runSync, setNextSyncEpoch } from './orchestrator.mjs';

const LOG_LEVELS = { error: 0, warning: 1, info: 2, debug: 3 };

function readConfig() {
    return {
        protonEmail: process.env.PROTON_EMAIL || '',
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

function installLogging(level) {
    const threshold = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    const stamp = () => new Date().toISOString();
    const origLog = console.log.bind(console);
    const origErr = console.error.bind(console);
    console.log = (...args) => {
        if (threshold >= LOG_LEVELS.info) origLog(`[${stamp()}]`, ...args);
    };
    console.debug = (...args) => {
        if (threshold >= LOG_LEVELS.debug) origLog(`[${stamp()}] [debug]`, ...args);
    };
    console.error = (...args) => origErr(`[${stamp()}]`, ...args);
}

async function main() {
    const config = readConfig();
    installLogging(config.logLevel);

    console.log('Starting Proton Drive Backup add-on');
    console.log(
        `Config: folder="${config.driveFolder}", interval=${config.intervalHours}h, ` +
            `proton retention=${config.backupsInProton}, HA retention=${config.backupsInHA}, ` +
            `full=${config.fullBackup}`,
    );

    await setupCrypto();
    await mkdir(join(config.dataDir, 'tmp'), { recursive: true });

    startIngressServer();

    if (config.intervalHours > 0) {
        setNextSyncEpoch(Date.now() + 5000);
    }

    // Initial sync shortly after startup. Errors are swallowed by runSync, but
    // guard anyway so a failure never takes down the ingress server.
    setTimeout(() => {
        runSync()
            .then(() => {
                if (config.intervalHours > 0) {
                    setNextSyncEpoch(Date.now() + config.intervalHours * 3600 * 1000);
                }
            })
            .catch((err) => console.error(`Initial sync error: ${err.message}`));
    }, 5000);

    if (config.intervalHours > 0) {
        const intervalMs = config.intervalHours * 3600 * 1000;
        setInterval(() => {
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
