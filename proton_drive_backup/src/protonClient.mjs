/**
 * Thin wrapper around the official ProtonDriveClient for HA backup operations.
 *
 * The HA backup metadata (AgentBackup.as_dict()) is stored in the file's
 * extended attributes via the SDK's `additionalMetadata`, wrapped under a
 * `HomeAssistant` key (the SDK reserves the top-level `Common` key). It is read
 * back from `node.activeRevision.claimedAdditionalMetadata`.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';

import {
    MemoryCache,
    NodeType,
    NullFeatureFlagProvider,
    OpenPGPCryptoWithCryptoProxy,
    ProtonDriveClient,
    getUid,
} from '@protontech/drive-sdk';
import {
    computeKeyPassword,
    generateKeySalt,
    getRandomSrpVerifier,
    getSrp,
} from '@protontech/crypto/srp';

import { CryptoProxy } from './cryptoSetup.mjs';

const METADATA_KEY = 'HomeAssistant';

let client = null;

// The SDK's SRPModule shape adapts to @protontech/crypto's SRP helpers. Only
// computeKeyPassword is exercised by the backup flow; the rest cover sharing.
const srpModule = {
    getSrp: (version, modulus, serverEphemeral, salt, password) =>
        getSrp(
            { Version: version, Modulus: modulus, ServerEphemeral: serverEphemeral, Salt: salt },
            { password },
            version,
        ),
    getSrpVerifier: (password) => getRandomSrpVerifier({ password }),
    computeKeyPassword,
    generateKeySalt,
};

export function initClient(httpClient, account) {
    client = new ProtonDriveClient({
        httpClient,
        account,
        entitiesCache: new MemoryCache(),
        cryptoCache: new MemoryCache(),
        openPGPCryptoModule: new OpenPGPCryptoWithCryptoProxy(CryptoProxy),
        srpModule,
        featureFlagProvider: new NullFeatureFlagProvider(),
    });
}

function ensureClient() {
    if (!client) throw Object.assign(new Error('Drive client not initialized'), { code: 'NOT_INITIALIZED' });
}

// Extract a human-readable name from a MaybeNode (healthy or degraded).
function nodeName(maybeNode) {
    if (maybeNode.ok) return maybeNode.value.name;
    const name = maybeNode.error?.name;
    return name?.ok ? name.value : null;
}

async function resolveFolder(folderPath) {
    const root = await client.getMyFilesRootFolder();
    let currentUid = getUid(root);

    for (const part of (folderPath || '').split('/').filter(Boolean)) {
        let childUid = null;
        for await (const child of client.iterateFolderChildren(currentUid, { type: NodeType.Folder })) {
            if (nodeName(child) === part) {
                childUid = getUid(child);
                break;
            }
        }
        if (!childUid) {
            childUid = getUid(await client.createFolder(currentUid, part));
        }
        currentUid = childUid;
    }
    return currentUid;
}

export async function listBackups(folderPath) {
    ensureClient();
    const folderUid = await resolveFolder(folderPath);
    const results = [];

    for await (const child of client.iterateFolderChildren(folderUid, { type: NodeType.File })) {
        if (!child.ok) continue;
        const node = child.value;
        const metadata = node.activeRevision?.claimedAdditionalMetadata?.[METADATA_KEY];
        if (metadata) results.push({ linkId: node.uid, metadata });
    }
    return results;
}

export async function uploadBackup(filePath, backupName, haMetadata, folderPath) {
    ensureClient();
    const folderUid = await resolveFolder(folderPath);
    const { size } = await stat(filePath);

    const uploader = await client.getFileUploader(folderUid, backupName, {
        mediaType: 'application/octet-stream',
        expectedSize: size,
        additionalMetadata: { [METADATA_KEY]: haMetadata },
    });

    const stream = Readable.toWeb(createReadStream(filePath));
    const controller = await uploader.uploadFromStream(stream, []);
    const { nodeUid } = await controller.completion();
    return { linkId: nodeUid };
}

export async function downloadBackup(linkId, outputPath) {
    ensureClient();
    const downloader = await client.getFileDownloader(linkId);
    const writable = Writable.toWeb(createWriteStream(outputPath));
    const controller = downloader.downloadToStream(writable);
    await controller.completion();
}

export async function deleteBackup(linkId) {
    ensureClient();
    for await (const result of client.trashNodes([linkId])) {
        if (!result.ok) throw new Error(result.error || `Failed to delete ${result.uid}`);
    }
}
