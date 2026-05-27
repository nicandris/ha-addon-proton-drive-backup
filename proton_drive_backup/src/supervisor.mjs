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
    return json.data;
}

export async function listBackups() {
    const data = await supervisorJson('GET', '/backups');
    return data.backups || [];
}

export async function getBackupInfo(slug) {
    return supervisorJson('GET', `/backups/${slug}/info`);
}

export async function createBackup({ name, password, full = true } = {}) {
    const body = { name, compressed: true, background: false };
    if (password) body.password = password;
    let data;
    if (full) {
        data = await supervisorJson('POST', '/backups/new/full', body);
    } else {
        data = await supervisorJson('POST', '/backups/new/partial', {
            ...body,
            homeassistant: true,
        });
    }
    return data.slug;
}

export async function downloadBackup(slug, destPath) {
    const resp = await fetch(`${BASE_URL}/backups/${slug}/download`, {
        method: 'GET',
        headers: authHeaders(),
    });
    if (!resp.ok || !resp.body) {
        throw new Error(`Supervisor download ${slug} failed: HTTP ${resp.status}`);
    }
    await pipeline(Readable.fromWeb(resp.body), createWriteStream(destPath));
}

export async function uploadBackup(srcPath) {
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
    return json.data.slug;
}

export async function deleteBackup(slug) {
    await supervisorJson('DELETE', `/backups/${slug}`);
}

export async function restoreBackup(slug, password) {
    const body = { background: false };
    if (password) body.password = password;
    return supervisorJson('POST', `/backups/${slug}/restore/full`, body);
}
