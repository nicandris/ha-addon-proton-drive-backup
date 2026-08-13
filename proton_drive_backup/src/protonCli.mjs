/**
 * Wrapper around Proton's official first-party `proton-drive` CLI.
 *
 * The CLI owns authentication end-to-end: `auth login` prints a browser sign-in
 * URL and blocks until the user completes sign-in on any device, then persists
 * the session itself under $XDG_DATA_HOME/proton-drive-cli/. This module never
 * touches credentials — it only shells out to the binary and parses its output.
 *
 * Failure detection: the CLI signals errors by EXIT CODE (1) + plain-text
 * stderr, even with -j/--json. We therefore never rely on JSON to detect
 * failures — only exit code + stderr text.
 *
 * run() NEVER rejects on a nonzero exit: it resolves with {code, stdout, stderr}
 * so callers decide what an error means. The child gets a FILTERED environment
 * (only what the CLI needs) — never the add-on's full env, which carries
 * BACKUP_PASSWORD and SUPERVISOR_TOKEN.
 */

import { spawn } from 'node:child_process';
import { chmod, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Absolute path (or bare name on $PATH) of the proton-drive binary. */
const BIN = process.env.PROTON_DRIVE_BIN || 'proton-drive';


/**
 * Append to a captured stream buffer, keeping only the head and tail. A long
 * upload (no timeout) or a 5-minute login can emit unbounded progress output;
 * the only consumers are exit-code checks, a short debug line and error text.
 */
const CAP_BYTES = 64 * 1024;
function capped(existing, chunk) {
    const next = existing + chunk;
    if (next.length <= CAP_BYTES * 2) return next;
    return `${next.slice(0, CAP_BYTES)}\n…[output truncated]…\n${next.slice(-CAP_BYTES)}`;
}

/**
 * Where the CLI keeps its sign-in session (`$XDG_DATA_HOME/proton-drive-cli`,
 * i.e. `/data/proton-drive-cli` in the add-on).
 */
export function sessionStoreDir() {
    return join(process.env.XDG_DATA_HOME || '/data', 'proton-drive-cli');
}

/**
 * Restrict the session store to the add-on's own user.
 *
 * The CLI creates its files world-readable (0644) in a 0755 directory. The
 * session is a bearer credential for the whole Proton Drive account, so it is
 * narrowed to 0600 in a 0700 directory. Called at boot and again after each
 * sign-in, because a fresh login rewrites the files with the default mode.
 *
 * Best-effort: never throws — a permissions failure must not stop the add-on.
 * @returns {Promise<{dir:string, files:number, changed:number}>}
 */
export async function secureSessionStore() {
    const dir = sessionStoreDir();
    let files = 0;
    let changed = 0;
    try {
        await mkdir(dir, { recursive: true });
        await chmod(dir, 0o700);
        for (const name of await readdir(dir)) {
            const p = join(dir, name);
            try {
                const st = await stat(p);
                if (!st.isFile()) continue;
                files++;
                // Only touch it if it's actually looser than 0600.
                if ((st.mode & 0o177) !== 0) {
                    await chmod(p, 0o600);
                    changed++;
                }
            } catch { /* file vanished mid-loop (the CLI rewrites these) */ }
        }
        if (changed) console.log(`[protonCli] Restricted ${changed} session file(s) in ${dir} to 0600`);
    } catch (err) {
        console.warn(`[protonCli] Could not restrict the session store (${err.message}) — continuing`);
    }
    return { dir, files, changed };
}

/** The user's Proton Drive root section that holds their own files. */
const MY_FILES = '/my-files';

/**
 * Error text from a finished run.
 *
 * Uses BOTH streams: the CLI prints a `====` banner line on stderr and the
 * actual reason on stdout, so the old `stderr || stdout` reported nothing but
 * the banner (0.4.9 — a `filesystem list` failure was undiagnosable). ANSI
 * codes are stripped and `\r` becomes `\n`, because the CLI redraws lines and
 * a lone `\r` hides everything before it in the add-on log.
 *
 * @param {{stdout:string, stderr:string}} res
 * @param {string} [fallback] - used when both streams are empty.
 */
function errText(res, fallback = 'no output') {
    // eslint-disable-next-line no-control-regex
    const clean = (s) => String(s || '').replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '\n').trim();
    return [clean(res.stderr), clean(res.stdout)].filter(Boolean).join('\n') || fallback;
}

/** Env names passed through verbatim to the CLI (plus the PROTON_DRIVE_* set). */
const ENV_ALLOW = ['PATH', 'HOME', 'TMPDIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME'];

/**
 * The environment handed to the third-party binary: the CLI's own settings
 * (`PROTON_DRIVE_*`, incl. the credentials store) plus the few generic vars it
 * needs. Everything else is withheld — the add-on's env contains the HA backup
 * password and the Supervisor token, which the CLI has no business seeing.
 * (`FAKE_*` is forwarded so the test fixture binary can be driven by env.)
 */
function childEnv() {
    const env = {};
    for (const name of ENV_ALLOW) {
        if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    for (const [k, v] of Object.entries(process.env)) {
        if (k.startsWith('PROTON_DRIVE_') || k.startsWith('FAKE_')) env[k] = v;
    }
    return env;
}

/**
 * Run the CLI with the given argv. Never rejects on a nonzero exit code.
 *
 * @param {string[]} args - CLI arguments (no binary name).
 * @param {{timeoutMs?:number, cwd?:string}} [opts] - timeoutMs<=0 disables the
 *   timeout (use for large uploads/downloads).
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function run(args, { timeoutMs = 120000, cwd } = {}) {
    return new Promise((resolve, reject) => {
        console.debug(`[protonCli] run: ${BIN} ${args.join(' ')}`);
        const child = spawn(BIN, args, {
            cwd,
            env: childEnv(), // filtered: CLI settings only, no add-on secrets
        });

        let stdout = '';
        let stderr = '';
        let timer = null;
        let killedByTimeout = false;

        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                killedByTimeout = true;
                child.kill('SIGKILL');
            }, timeoutMs);
        }

        child.stdout.on('data', (d) => { stdout = capped(stdout, d.toString()); });
        child.stderr.on('data', (d) => { stderr = capped(stderr, d.toString()); });

        child.on('error', (err) => {
            if (timer) clearTimeout(timer);
            reject(err); // binary missing / not executable — a real failure
        });

        child.on('close', (code, signal) => {
            if (timer) clearTimeout(timer);
            // A signal-killed child reports code=null. Mapping that straight to 1
            // made an OOM kill indistinguishable from an ordinary CLI error —
            // the output just stopped mid-line and the caller reported "exit 1".
            const exitCode = killedByTimeout ? 124 : (code ?? (signal ? 128 : 1));
            if (killedByTimeout) stderr += `\n[protonCli] killed after ${timeoutMs}ms timeout`;
            else if (signal) stderr += `\n[protonCli] killed by ${signal}`
                + (signal === 'SIGKILL' ? ' — most likely the out-of-memory killer, not a Proton error' : '');
            console.debug(`[protonCli] exit ${exitCode} (${BIN} ${args[0] || ''} ${args[1] || ''})`);
            resolve({ code: exitCode, stdout, stderr });
        });
    });
}

/**
 * Is there a usable, logged-in session? Probes the user's root folder.
 * @returns {Promise<boolean>}
 */
export async function isConnected() {
    const { code } = await run(['filesystem', 'info', MY_FILES]);
    return code === 0;
}

/**
 * Start an interactive browser sign-in. Spawns `auth login`, which prints a
 * sign-in URL then blocks until the user completes sign-in in a browser on any
 * device; the CLI persists the session on success.
 *
 * @param {{onUrl:(url:string)=>void, timeoutMs?:number}} opts - onUrl is called
 *   once with the sign-in URL as soon as it is seen on stdout.
 * @returns {Promise<{ok:true}|{ok:false, error:string}>}
 */
export function login({ onUrl, timeoutMs = 300000 } = {}) {
    return new Promise((resolve) => {
        console.debug('[protonCli] login: spawning auth login');
        const child = spawn(BIN, ['auth', 'login'], { env: childEnv() });

        let stdout = '';
        let stderr = '';
        let urlSent = false;
        let settled = false;
        const urlRe = /https:\/\/account\.proton\.me\/\S+/;

        const timer = timeoutMs > 0 ? setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGKILL');
            resolve({ ok: false, error: `Sign-in timed out after ${Math.round(timeoutMs / 1000)}s` });
        }, timeoutMs) : null;

        const scan = (chunk) => {
            if (urlSent) return;
            const m = chunk.match(urlRe) || (stdout + stderr).match(urlRe);
            if (m) {
                urlSent = true;
                console.debug('[protonCli] login: sign-in URL captured');
                try { onUrl && onUrl(m[0]); } catch { /* UI store failure must not break login */ }
            }
        };

        child.stdout.on('data', (d) => { const s = d.toString(); stdout = capped(stdout, s); scan(s); });
        child.stderr.on('data', (d) => { const s = d.toString(); stderr = capped(stderr, s); scan(s); });

        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve({ ok: false, error: err.message });
        });

        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (code === 0) {
                console.debug('[protonCli] login: completed OK');
                resolve({ ok: true });
            } else {
                const error = errText({ stdout, stderr }, `auth login exited ${code}`);
                console.debug(`[protonCli] login: failed — ${error}`);
                resolve({ ok: false, error });
            }
        });
    });
}

/**
 * Sign out and drop the persisted session.
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function logout() {
    return run(['auth', 'logout']);
}

/**
 * Does this nonzero result look like an "already exists"/conflict (which
 * create-folder treats as success), rather than a real error?
 *
 * Deliberately narrow: a bare /exist/ match also matched "does not exist" and
 * "no such file", turning a genuine failure into a silent success (fixed 0.4.1).
 */
function isExistsConflict(res) {
    const t = `${res.stdout} ${res.stderr}`.toLowerCase();
    // A negated existence phrase ("does not exist", "no such folder") is never a
    // conflict — it means the opposite, so it must stay a hard error.
    if (/\b(?:not|no|never|cannot|can't|couldn't|unable|non-?existent|missing)\b[^.\n]{0,24}exist/.test(t)) return false;
    if (/\b(?:no such|not found|nonexistent)\b/.test(t)) return false;
    return /\balready (?:exist|present|there)|\bfile exists\b|\bduplicate\b|\bconflict/.test(t);
}

/**
 * Ensure a folder path exists under /my-files, creating each missing segment.
 * An "already exists"/conflict on create is treated as success.
 *
 * @param {string} remotePath - e.g. `/my-files/Home Assistant Backups`.
 * @returns {Promise<string>} the full remote folder path.
 */
export async function ensureFolder(remotePath) {
    // Normalise: work with the segments below /my-files.
    const rel = remotePath.replace(/^\/+/, '').replace(/^my-files\/?/, '');
    const segments = rel.split('/').filter(Boolean);

    let parent = MY_FILES;
    for (const name of segments) {
        const res = await run(['filesystem', 'create-folder', parent, name]);
        if (res.code !== 0 && !isExistsConflict(res)) {
            throw new Error(`create-folder "${name}" in "${parent}" failed: ${errText(res)}`);
        }
        parent = `${parent}/${name}`;
    }

    // Verify final existence (the create may have been a no-op "already exists").
    const info = await run(['filesystem', 'info', parent]);
    if (info.code !== 0) {
        throw new Error(`folder "${parent}" not found after ensureFolder: ${errText(info)}`);
    }
    return parent;
}

/**
 * List the direct children of a remote folder.
 *
 * Two failure modes, chosen by the caller (0.4.1):
 *  - LENIENT (default) — a nonzero exit or unparseable output resolves to `[]`.
 *    Only safe for display (`listProtonBackups`), where "nothing to show" is a
 *    harmless outcome.
 *  - STRICT (`{strict:true}` / `listStrict`) — THROWS instead. The sync path
 *    must use this: a false-empty listing looks like "nothing is mirrored", which
 *    made the orchestrator re-upload every backup with `-c replace` (tens of GB)
 *    and reset every Proton `modificationTime`, destroying retention ordering.
 *
 * The shape below is the CLI's real `filesystem list -j` schema (locked in
 * 0.2.4); the extra tolerance is kept because the CLI is early.
 *
 * @param {string} remotePath
 * @param {{strict?:boolean}} [opts]
 * @returns {Promise<Array<{name:string, type?:string, uid?:string, size?:number, date?:string}>>}
 */
export async function list(remotePath, { strict = false } = {}) {
    const fail = (why) => {
        if (strict) throw new Error(`list "${remotePath}" failed: ${why}`);
        console.warn(`[protonCli] list "${remotePath}": ${why} — returning []`);
        return [];
    };
    const res = await run(['filesystem', 'list', remotePath, '-j']);
    if (res.code !== 0) {
        return fail(`exit ${res.code}: ${errText(res)}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(res.stdout);
    } catch (err) {
        return fail(`JSON parse failed (${err.message})`);
    }
    // Tolerate: [ ... ] OR { items:[...] } / { entries:[...] } / { data:[...] } / { children:[...] }.
    let arr = null;
    if (Array.isArray(parsed)) {
        arr = parsed;
    } else if (parsed && typeof parsed === 'object') {
        arr = parsed.items || parsed.entries || parsed.data || parsed.children ||
            Object.values(parsed).find((v) => Array.isArray(v)) || null;
    }
    if (!Array.isArray(arr)) {
        return fail('JSON had no recognisable array');
    }
    const entries = arr.map((e) => {
        if (typeof e === 'string') return { name: e };
        // Proton's CLI serialises `name` as a Result object
        // ({ ok: true, value: "<filename>" }) — NOT a plain string. Extract
        // the value; also tolerate a plain string / differently-cased key.
        const n = e?.name;
        let name = '';
        if (typeof n === 'string') name = n;
        else if (n && typeof n === 'object' && n.ok && typeof n.value === 'string') name = n.value;
        else if (typeof (e?.Name ?? e?.fileName) === 'string') name = e.Name ?? e.fileName;
        // Size lives on activeRevision (itself a Result), absent for folders.
        const rev = e?.activeRevision;
        const flatSize = e?.size ?? e?.Size;
        const size = (rev && rev.ok && rev.value && typeof rev.value.claimedSize === 'number')
            ? rev.value.claimedSize
            : (typeof flatSize === 'number' ? flatSize : undefined);
        // Timestamps come through as plain ISO strings (not Result-wrapped).
        // Retention now sorts by date, so surface it: prefer modificationTime,
        // else creationTime.
        const modTime = e?.modificationTime ?? e?.ModificationTime;
        const createTime = e?.creationTime ?? e?.CreationTime;
        const date = (typeof modTime === 'string' && modTime)
            ? modTime
            : (typeof createTime === 'string' && createTime ? createTime : undefined);
        return {
            name,
            type: e?.type ?? e?.Type,
            uid: e?.uid ?? e?.id,
            size,
            date,
        };
    }).filter((e) => e.name);

    // Log only the MAPPED fields. The raw NodeEntity payload was logged before
    // 0.4.1 — it carries node ids, revision ids and hashes, and add-on logs get
    // pasted into public issues.
    console.debug(`[protonCli] list "${remotePath}": ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`
        + (entries.length ? ` — ${entries.map((e) => `${e.name}${e.size != null ? ` (${e.size}B)` : ''}`).join(', ')}` : ''));
    return entries;
}

/**
 * Strict `list`: THROWS on a nonzero exit or unparseable output instead of
 * resolving to `[]`. Use this everywhere a false-empty listing would be acted
 * on (sync, retention) — see the note on `list`.
 * @param {string} remotePath
 */
export function listStrict(remotePath) {
    return list(remotePath, { strict: true });
}

/**
 * Upload a local file into a remote parent folder. Uses no timeout (large
 * files). Throws with stderr on a nonzero exit.
 *
 * @param {string} localPath
 * @param {string} remoteParent
 * The strategy flag is `-f` (`--file-conflict-strategy`). CLI 0.8.0 renamed it
 * from `-c`, which now fails the upload outright with "Unknown option '-c'" —
 * `-d` is the folder equivalent and is not used here (we only upload files).
 *
 * @param {{conflictStrategy?:('create-new-revision'|'rename'|'replace'|'skip')}} [opts]
 */
export async function uploadFile(localPath, remoteParent, { conflictStrategy = 'replace' } = {}) {
    const res = await run(
        ['filesystem', 'upload', '-f', conflictStrategy, localPath, remoteParent],
        { timeoutMs: 0 },
    );
    if (res.code !== 0) {
        throw new Error(`upload "${localPath}" → "${remoteParent}" failed: ${errText(res)}`);
    }
}

/**
 * Download a remote path into a local folder. No timeout (large files).
 * Throws with stderr on a nonzero exit.
 *
 * @param {string} remotePath
 * @param {string} localFolder
 */
export async function downloadPath(remotePath, localFolder) {
    const res = await run(
        ['filesystem', 'download', remotePath, localFolder],
        { timeoutMs: 0 },
    );
    if (res.code !== 0) {
        throw new Error(`download "${remotePath}" → "${localFolder}" failed: ${errText(res)}`);
    }
}

/**
 * Move a remote path to the trash. Throws with stderr on a nonzero exit.
 * @param {string} remotePath
 */
export async function trash(remotePath) {
    const res = await run(['filesystem', 'trash', remotePath]);
    if (res.code !== 0) {
        throw new Error(`trash "${remotePath}" failed: ${errText(res)}`);
    }
}
