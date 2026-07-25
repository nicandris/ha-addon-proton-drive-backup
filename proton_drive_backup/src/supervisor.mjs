/**
 * Client for the Home Assistant Supervisor backup API.
 *
 * Base URL is `http://supervisor`, authenticated with the SUPERVISOR_TOKEN
 * bearer token. Every JSON response is wrapped as
 *   { result: 'ok'|'error', data: {...}, message: '...' }
 * so we always check `result` and unwrap `data`.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';

// Overridable so tests can point at a local fixture server.
const BASE_URL = process.env.SUPERVISOR_URL || 'http://supervisor';

function token() {
    return process.env.SUPERVISOR_TOKEN || '';
}

function authHeaders(extra = {}) {
    return { Authorization: `Bearer ${token()}`, ...extra };
}

async function supervisorJson(method, path, body) {
    console.debug(`[supervisor] ${method} ${path}`);
    const headers = authHeaders();
    let payload;
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
    }
    const resp = await fetch(`${BASE_URL}${path}`, { method, headers, body: payload });
    let json;
    try {
        json = await resp.json();
    } catch {
        throw new Error(`Supervisor ${method} ${path} returned non-JSON (HTTP ${resp.status})`);
    }
    if (json.result === 'error' || !resp.ok) {
        throw new Error(`Supervisor ${method} ${path} failed: ${json.message || resp.statusText}`);
    }
    console.debug(`[supervisor] ${method} ${path} → OK`);
    return json.data;
}

export async function listBackups() {
    const data = await supervisorJson('GET', '/backups');
    const backups = data.backups || [];
    console.debug(`[supervisor] listBackups: ${backups.length} backup(s) in HA`);
    return backups;
}

export async function getBackupInfo(slug) {
    return supervisorJson('GET', `/backups/${slug}/info`);
}

/** Host info (disk_total / disk_used / disk_free in GB) for the stats panel. */
export async function hostInfo() {
    return supervisorJson('GET', '/host/info');
}

/** Create a new full Home Assistant backup (blocks until done). Returns the slug. */
export async function createBackup({ name, password } = {}) {
    const body = { name, compressed: true, background: false };
    if (password) body.password = password;
    console.debug(`[supervisor] createBackup: name="${name}" password=${password ? 'set' : 'none'}`);
    const data = await supervisorJson('POST', '/backups/new/full', body);
    console.debug(`[supervisor] createBackup: created slug=${data.slug}`);
    return data.slug;
}

export async function downloadBackup(slug, destPath) {
    console.debug(`[supervisor] downloadBackup: slug=${slug} → ${destPath}`);
    const resp = await fetch(`${BASE_URL}/backups/${slug}/download`, {
        method: 'GET',
        headers: authHeaders(),
    });
    if (!resp.ok || !resp.body) {
        // Attach the HTTP status so callers can treat a 404 (backup listed but no
        // longer downloadable — a stale/phantom entry) as a skip, not a hard error.
        throw Object.assign(
            new Error(`Supervisor download ${slug} failed: HTTP ${resp.status}`),
            { status: resp.status },
        );
    }
    await pipeline(Readable.fromWeb(resp.body), createWriteStream(destPath));
    console.debug(`[supervisor] downloadBackup: ${slug} written to ${destPath}`);
}

/**
 * Upload a backup archive to the Supervisor (the restore path).
 *
 * The file is **streamed** — backups are multi-GB, so reading one into a Buffer
 * (as an earlier version did) allocates gigabytes and gets the add-on
 * OOM-killed. We hand-write the multipart framing and pipe the file straight
 * into the request, so memory stays flat regardless of backup size.
 *
 * @param {string} srcPath
 * @returns {Promise<string>} the new backup's slug
 */
export async function uploadBackup(srcPath) {
    console.debug(`[supervisor] uploadBackup: ${srcPath} (streamed)`);
    const { size } = await stat(srcPath);
    // Quote-escape so a name containing `"` can't break the header.
    const filename = basename(srcPath).replace(/"/g, '_');
    const boundary = `----ProtonDriveBackup${randomBytes(16).toString('hex')}`;
    const head = Buffer.from(
        `--${boundary}\r\n`
        + `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`
        + 'Content-Type: application/octet-stream\r\n\r\n',
        'utf8',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const base = new URL(BASE_URL);

    return new Promise((resolve, reject) => {
        const req = httpRequest(
            {
                protocol: base.protocol,
                hostname: base.hostname,
                port: base.port || 80,
                path: '/backups/new/upload',
                method: 'POST',
                headers: authHeaders({
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    // Known up front (head + file + tail), so no chunked encoding.
                    'Content-Length': String(head.length + size + tail.length),
                }),
            },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8');
                    let json;
                    try {
                        json = JSON.parse(body);
                    } catch {
                        reject(new Error(`Supervisor upload returned non-JSON (HTTP ${res.statusCode})`));
                        return;
                    }
                    if (json.result === 'error' || !res.statusCode || res.statusCode >= 400) {
                        reject(new Error(`Supervisor upload failed: ${json.message || `HTTP ${res.statusCode}`}`));
                        return;
                    }
                    console.debug(`[supervisor] uploadBackup: slug=${json.data?.slug}`);
                    resolve(json.data.slug);
                });
                res.on('error', reject);
            },
        );

        req.on('error', reject);
        req.write(head);

        const file = createReadStream(srcPath);
        file.on('error', (err) => {
            req.destroy();
            reject(err);
        });
        // end:false so we can append the closing boundary after the file.
        file.pipe(req, { end: false });
        file.on('end', () => req.end(tail));
    });
}

export async function deleteBackup(slug) {
    await supervisorJson('DELETE', `/backups/${slug}`);
    console.debug(`[supervisor] deleteBackup: ${slug} deleted`);
}

export async function restoreBackup(slug, password) {
    console.debug(`[supervisor] restoreBackup: slug=${slug} password=${password ? 'set' : 'none'}`);
    const body = { background: false };
    if (password) body.password = password;
    return supervisorJson('POST', `/backups/${slug}/restore/full`, body);
}
