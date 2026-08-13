#!/usr/bin/env node
/**
 * Fake `proton-drive` binary for tests. Behaviour is driven by FAKE_* env vars
 * so a single fixture can stand in for many scenarios (protonCli reads its
 * binary path once at import, so per-test behaviour must come from the env,
 * which run()/login() pass through to the child).
 */
import fs from 'node:fs';

const a = process.argv.slice(2);
const env = process.env;
const out = (s) => process.stdout.write(s + '\n');
const err = (s) => process.stderr.write(s + '\n');
const code = (name, dflt) => parseInt(env[name] ?? String(dflt), 10);

if (a[0] === 'version') { out('Proton Drive CLI cli-drive@fake@0.0.0'); process.exit(0); }

if (a[0] === 'auth' && a[1] === 'login') {
    const url = env.FAKE_LOGIN_URL ??
        'https://account.proton.me/desktop/login?app=drive&pv=3#payload=deadbeef:cli-drive';
    out('Sign in in your browser. Keep the terminal open...');
    if (url) out('Open following URL manually (can be on another device):');
    if (url) out(url);
    if (env.FAKE_LOGIN_STDERR) err(env.FAKE_LOGIN_STDERR);
    process.exit(code('FAKE_LOGIN_CODE', 0));
}

if (a[0] === 'auth' && a[1] === 'logout') { process.exit(code('FAKE_LOGOUT_CODE', 0)); }

if (a[0] === 'filesystem') {
    const sub = a[1];
    if (sub === 'info') { process.exit(code('FAKE_INFO_CODE', 0)); }
    if (sub === 'list') {
        // Print a banner, then die by signal — what an OOM-killed CLI looks like.
        if (env.FAKE_LIST_SIGKILL) {
            fs.writeSync(2, '===============================================\n'); // sync: no time to flush
            process.kill(process.pid, 'SIGKILL');
        }
        const c = code('FAKE_LIST_CODE', 0);
        if (c !== 0) {
            err(env.FAKE_LIST_STDERR ?? 'You need to login first');
            if (env.FAKE_LIST_STDOUT) out(env.FAKE_LIST_STDOUT);
            process.exit(c);
        }
        out(env.FAKE_LIST_JSON ?? '[]');
        process.exit(0);
    }
    if (sub === 'create-folder') {
        const c = code('FAKE_CREATE_CODE', 0);
        if (c !== 0) err(env.FAKE_CREATE_MSG ?? 'create failed');
        process.exit(c);
    }
    // CLI 0.8.0 renamed the conflict-strategy flag from -c to -f and rejects the
    // old one. Reject it here too, so a regression fails the suite.
    if (sub === 'upload' && a.includes('-c')) {
        err("Unknown option '-c'.");
        process.exit(1);
    }
    if (sub === 'upload' || sub === 'download' || sub === 'trash') {
        const c = code('FAKE_FS_CODE', 0);
        if (c !== 0) err(env.FAKE_FS_MSG ?? `${sub} failed`);
        process.exit(c);
    }
}

// Print the env var NAMES we were given, one per line (env-filtering test).
if (env.FAKE_DUMP_ENV) {
    out(Object.keys(env).join('\n'));
    process.exit(0);
}

// Emit FAKE_BIG_STDOUT bytes of chatter — simulates the real CLI's progress
// output on a long upload, which used to accumulate unbounded in memory.
if (env.FAKE_BIG_STDOUT) {
    const total = parseInt(env.FAKE_BIG_STDOUT, 10);
    const chunk = 'progress '.repeat(1000);
    let sent = 0;
    while (sent < total) { process.stdout.write(chunk); sent += chunk.length; }
    process.exit(code('FAKE_EXIT', 0));
}

// Generic escape hatch for run()-level tests.
if (env.FAKE_STDOUT) out(env.FAKE_STDOUT);
if (env.FAKE_STDERR) err(env.FAKE_STDERR);
const sleepMs = code('FAKE_SLEEP_MS', 0);
if (sleepMs > 0) {
    // Hang so a caller's timeout can fire (run() SIGKILLs us → exit code 124).
    setTimeout(() => process.exit(code('FAKE_EXIT', 0)), sleepMs);
} else {
    process.exit(code('FAKE_EXIT', 0));
}
