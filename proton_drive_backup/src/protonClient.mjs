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

export function initClient(httpClient, account) {
    // The SDK's SRPModule adapts @protontech/crypto's SRP helpers. Only
    // computeKeyPassword is exercised by the backup flow; getSrp and
    // getSrpVerifier are used by public-link sharing (unused here but must be
    // correct so they don't blow up if the SDK ever calls them).
    //
    // getSrpVerifier needs a fresh modulus from the API (to get ModulusID) and
    // the account's primary email, so it lives in the initClient closure where
    // both httpClient and account are available.
    const srpModule = {
        getSrp: async (version, modulus, serverEphemeral, salt, password) => {
            const primary = await account.getOwnPrimaryAddress();
            console.debug(`[protonDrive] srpModule.getSrp called (version=${version}, email=${primary.email})`);
            return getSrp(
                { Version: version, Modulus: modulus, ServerEphemeral: serverEphemeral, Salt: salt },
                { username: primary.email, password },
                version,
            );
        },
        getSrpVerifier: async (password) => {
            const primary = await account.getOwnPrimaryAddress();
            console.debug(`[protonDrive] srpModule.getSrpVerifier called (email=${primary.email}), fetching modulus...`);
            const modulusResp = await httpClient.authGet('core/v4/auth/modulus');
            const { Modulus, ModulusID } = modulusResp;
            const result = await getRandomSrpVerifier(
                { Modulus },
                { username: primary.email, password },
            );
            console.debug(`[protonDrive] SRP verifier generated (modulusId=${ModulusID})`);
            return { modulusId: ModulusID, version: result.version, salt: result.salt, verifier: result.verifier };
        },
        computeKeyPassword,
        generateKeySalt,
    };

    client = new ProtonDriveClient({
        httpClient,
        account,
        entitiesCache: new MemoryCache(),
        cryptoCache: new MemoryCache(),
        openPGPCryptoModule: new OpenPGPCryptoWithCryptoProxy(CryptoProxy),
        srpModule,
        featureFlagProvider: new NullFeatureFlagProvider(),
    });
    console.debug('[protonDrive] Drive client initialized');
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
    console.debug(`[protonDrive] resolveFolder: root uid=${currentUid.slice(0, 8)}...`);

    for (const part of (folderPath || '').split('/').filter(Boolean)) {
        let childUid = null;
        for await (const child of client.iterateFolderChildren(currentUid, { type: NodeType.Folder })) {
            if (nodeName(child) === part) {
                childUid = getUid(child);
                break;
            }
        }
        if (!childUid) {
            console.debug(`[protonDrive] resolveFolder: creating folder segment "${part}"`);
            childUid = getUid(await client.createFolder(currentUid, part));
            console.debug(`[protonDrive] resolveFolder: created "${part}" uid=${childUid.slice(0, 8)}...`);
        } else {
            console.debug(`[protonDrive] resolveFolder: found "${part}" uid=${childUid.slice(0, 8)}...`);
        }
        currentUid = childUid;
    }
    return currentUid;
}

export async function listBackups(folderPath) {
    ensureClient();
    console.debug(`[protonDrive] listBackups: resolving folder "${folderPath}"`);
    const folderUid = await resolveFolder(folderPath);
    const results = [];

    for await (const child of client.iterateFolderChildren(folderUid, { type: NodeType.File })) {
        if (!child.ok) {
            console.debug('[protonDrive] listBackups: skipping degraded node');
            continue;
        }
        const node = child.value;
        const metadata = node.activeRevision?.claimedAdditionalMetadata?.[METADATA_KEY];
        if (metadata) {
            console.debug(`[protonDrive] listBackups: found backup "${metadata.name ?? metadata.slug}" (linkId=${node.uid.slice(0, 8)}...)`);
            results.push({ linkId: node.uid, metadata });
        }
    }
    console.debug(`[protonDrive] listBackups: ${results.length} backup(s) found in Drive`);
    return results;
}

export async function uploadBackup(filePath, backupName, haMetadata, folderPath) {
    ensureClient();
    const { size } = await stat(filePath);
    console.debug(`[protonDrive] uploadBackup: "${backupName}" (${(size / 1024 / 1024).toFixed(1)} MB) → "${folderPath}"`);
    const folderUid = await resolveFolder(folderPath);

    const uploader = await client.getFileUploader(folderUid, backupName, {
        mediaType: 'application/octet-stream',
        expectedSize: size,
        additionalMetadata: { [METADATA_KEY]: haMetadata },
    });

    console.debug('[protonDrive] uploadBackup: streaming file to Drive...');
    const stream = Readable.toWeb(createReadStream(filePath));
    const controller = await uploader.uploadFromStream(stream, []);
    const { nodeUid } = await controller.completion();
    console.debug(`[protonDrive] uploadBackup: complete, linkId=${nodeUid.slice(0, 8)}...`);
    return { linkId: nodeUid };
}

export async function downloadBackup(linkId, outputPath) {
    ensureClient();
    console.debug(`[protonDrive] downloadBackup: linkId=${linkId.slice(0, 8)}... → ${outputPath}`);
    const downloader = await client.getFileDownloader(linkId);
    const writable = Writable.toWeb(createWriteStream(outputPath));
    const controller = downloader.downloadToStream(writable);
    await controller.completion();
    console.debug('[protonDrive] downloadBackup: complete');
}

export async function deleteBackup(linkId) {
    ensureClient();
    console.debug(`[protonDrive] deleteBackup: trashing linkId=${linkId.slice(0, 8)}...`);
    for await (const result of client.trashNodes([linkId])) {
        if (!result.ok) throw new Error(result.error || `Failed to delete ${result.uid}`);
    }
    console.debug('[protonDrive] deleteBackup: moved to trash');
}
