/**
 * Entry point for the Proton Drive Backup add-on.
 *
 * Cleans stale staged archives, starts the ingress server, runs an initial sync
 * shortly after startup, and (if configured) schedules recurring syncs.
 * Authentication is owned by the proton-drive CLI (browser sign-in via the Web
 * UI), so there is no crypto/login setup here. Logs to stdout with timestamps
 * and exits cleanly on SIGTERM.
 */

// Must be first import so console is patched before any other module logs.
import { setLogLevel } from './logger.mjs';

import { startIngressServer } from './ingress.mjs';
import { cleanStagingDir, getRuntimeConfig, runSync, setNextSyncEpoch } from './orchestrator.mjs';
import { secureSessionStore } from './protonCli.mjs';

async function main() {
    // One config source: orchestrator.getRuntimeConfig() (never carries the
    // backup password, so the debug dump below is safe).
    const config = getRuntimeConfig();
    // Non-throwing: HA's log_level dropdown offers values we only alias, and a
    // throw here used to crash-loop the add-on at boot.
    setLogLevel(config.logLevel);

    console.log('Starting Proton Drive Backup add-on');
    console.log(
        `Config: folder="${config.driveFolder}", check interval=${config.intervalHours}h, ` +
            `proton retention=${config.keepAutomaticInProton} automatic/${config.keepAppInProton} app, ` +
            `HA manual retention=${config.keepAutomaticInHA} automatic/${config.keepAppInHA} app`,
    );
    console.debug(`[main] Full config: ${JSON.stringify(config)}`);

    // Reclaim archives left behind by a stop/crash mid-transfer (staging is
    // outside /data and nothing else ever cleans it).
    console.debug(`[main] Staging dir: ${config.effectiveStagingDir}`);
    // Narrow the Proton session files (the CLI writes them world-readable).
    await secureSessionStore();
    await cleanStagingDir().catch((err) => console.warn(`[main] Staging clean-up failed: ${err.message}`));

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
