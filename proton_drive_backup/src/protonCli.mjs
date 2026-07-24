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
 * so callers decide what an error means. The environment (credentials store +
 * XDG_DATA_HOME, set by run.sh) is always inherited.
 */

import { spawn } from 'node:child_process';

/** Absolute path (or bare name on $PATH) of the proton-drive binary. */
const BIN = process.env.PROTON_DRIVE_BIN || 'proton-drive';

/** The user's Proton Drive root section that holds their own files. */
const MY_FILES = '/my-files';

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
            env: process.env, // carries the store + XDG_DATA_HOME from run.sh
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

        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });

        child.on('error', (err) => {
            if (timer) clearTimeout(timer);
            reject(err); // binary missing / not executable — a real failure
        });

        child.on('close', (code) => {
            if (timer) clearTimeout(timer);
            const exitCode = killedByTimeout ? 124 : (code ?? 1);
            if (killedByTimeout) stderr += `\n[protonCli] killed after ${timeoutMs}ms timeout`;
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
        const child = spawn(BIN, ['auth', 'login'], { env: process.env });

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

        child.stdout.on('data', (d) => { const s = d.toString(); stdout += s; scan(s); });
        child.stderr.on('data', (d) => { const s = d.toString(); stderr += s; scan(s); });

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
                const error = (stderr.trim() || stdout.trim() || `auth login exited ${code}`);
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

/** Does this nonzero result look like an "already exists"/conflict, not a real error? */
function isExistsConflict(res) {
    const t = `${res.stdout} ${res.stderr}`.toLowerCase();
    return /exist|conflict|already/.test(t);
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
            throw new Error(`create-folder "${name}" in "${parent}" failed: ${res.stderr.trim() || res.stdout.trim()}`);
        }
        parent = `${parent}/${name}`;
    }

    // Verify final existence (the create may have been a no-op "already exists").
    const info = await run(['filesystem', 'info', parent]);
    if (info.code !== 0) {
        throw new Error(`folder "${parent}" not found after ensureFolder: ${info.stderr.trim() || info.stdout.trim()}`);
    }
    return parent;
}

/**
 * List the direct children of a remote folder.
 *
 * NOTE: JSON shape unverified against a live account — validate on first real
 * login. We parse defensively: JSON.parse and tolerate either a bare array or
 * an object with a nested array; on ANY parse failure we log and return [].
 *
 * @param {string} remotePath
 * @returns {Promise<Array<{name:string, type?:string, uid?:string, size?:number}>>}
 */
export async function list(remotePath) {
    const res = await run(['filesystem', 'list', remotePath, '-j']);
    if (res.code !== 0) {
        console.debug(`[protonCli] list "${remotePath}" failed: ${res.stderr.trim() || res.stdout.trim()}`);
        return [];
    }
    // Log the raw JSON (truncated) so the real shape can be verified/locked down.
    console.debug(`[protonCli] list "${remotePath}" raw: ${res.stdout.slice(0, 600).replace(/\s+/g, ' ')}`);
    try {
        const parsed = JSON.parse(res.stdout);
        // Tolerate: [ ... ] OR { items:[...] } / { entries:[...] } / { data:[...] } / { children:[...] }.
        let arr = null;
        if (Array.isArray(parsed)) {
            arr = parsed;
        } else if (parsed && typeof parsed === 'object') {
            arr = parsed.items || parsed.entries || parsed.data || parsed.children ||
                Object.values(parsed).find((v) => Array.isArray(v)) || null;
        }
        if (!Array.isArray(arr)) {
            console.warn(`[protonCli] list "${remotePath}": JSON had no recognisable array — returning []`);
            return [];
        }
        return arr.map((e) => {
            // Entries may be plain strings (bare filenames) or objects with a
            // name field under various casings; coerce to a string either way.
            const rawName = (typeof e === 'string') ? e : (e?.name ?? e?.Name ?? e?.fileName);
            return {
                name: typeof rawName === 'string' ? rawName : '',
                type: e?.type ?? e?.Type,
                uid: e?.uid ?? e?.uID ?? e?.id,
                size: e?.size ?? e?.Size,
            };
        }).filter((e) => e.name);
    } catch (err) {
        console.warn(`[protonCli] list "${remotePath}": JSON parse failed (${err.message}) — returning []`);
        return [];
    }
}

/**
 * Upload a local file into a remote parent folder. Uses no timeout (large
 * files). Throws with stderr on a nonzero exit.
 *
 * @param {string} localPath
 * @param {string} remoteParent
 * @param {{conflictStrategy?:('merge'|'keep-both'|'replace'|'skip')}} [opts]
 */
export async function uploadFile(localPath, remoteParent, { conflictStrategy = 'replace' } = {}) {
    const res = await run(
        ['filesystem', 'upload', '-c', conflictStrategy, localPath, remoteParent],
        { timeoutMs: 0 },
    );
    if (res.code !== 0) {
        throw new Error(`upload "${localPath}" → "${remoteParent}" failed: ${res.stderr.trim() || res.stdout.trim()}`);
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
        throw new Error(`download "${remotePath}" → "${localFolder}" failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
}

/**
 * Move a remote path to the trash. Throws with stderr on a nonzero exit.
 * @param {string} remotePath
 */
export async function trash(remotePath) {
    const res = await run(['filesystem', 'trash', remotePath]);
    if (res.code !== 0) {
        throw new Error(`trash "${remotePath}" failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
}
