/**
 * Client for the Home Assistant Supervisor backup API.
 *
 * Base URL is `http://supervisor`, authenticated with the SUPERVISOR_TOKEN
 * bearer token. Every JSON response is wrapped as
 *   { result: 'ok'|'error', data: {...}, message: '...' }
 * so we always check `result` and unwrap `data`.
 */

import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const BASE_URL = 'http://supervisor';

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

export async function uploadBackup(srcPath) {
    console.debug(`[supervisor] uploadBackup: ${srcPath}`);
    const buf = await readFile(srcPath);
    const form = new FormData();
    form.append(
        'file',
        new Blob([buf], { type: 'application/octet-stream' }),
        basename(srcPath),
    );
    const resp = await fetch(`${BASE_URL}/backups/new/upload`, {
        method: 'POST',
        headers: authHeaders(),
        body: form,
    });
    let json;
    try {
        json = await resp.json();
    } catch {
        throw new Error(`Supervisor upload returned non-JSON (HTTP ${resp.status})`);
    }
    if (json.result === 'error' || !resp.ok) {
        throw new Error(`Supervisor upload failed: ${json.message || resp.statusText}`);
    }
    console.debug(`[supervisor] uploadBackup: slug=${json.data.slug}`);
    return json.data.slug;
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
