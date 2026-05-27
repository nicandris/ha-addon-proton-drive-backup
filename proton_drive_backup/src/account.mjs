/**
 * Builds the SDK's `ProtonDriveAccount` from the user's Proton address keys.
 *
 * The SDK has no notion of login/session/addresses — the host app must supply
 * an account that can hand back decrypted address private keys (for signing and
 * decrypting node keys) and public keys (for sharing, unused here).
 */

import { CryptoProxy } from './cryptoSetup.mjs';

class Account {
    constructor(addresses) {
        this._addresses = addresses; // ProtonDriveAccountAddress[]
    }

    async getOwnPrimaryAddress() {
        const addr = this._addresses[0];
        if (!addr) throw new Error('No primary address');
        return addr;
    }

    async getOwnAddresses() {
        return this._addresses;
    }

    async getOwnAddress(emailOrAddressId) {
        const addr = this._addresses.find(
            (a) => a.email === emailOrAddressId || a.addressId === emailOrAddressId,
        );
        if (!addr) throw new Error(`No address for ${emailOrAddressId}`);
        return addr;
    }

    async getPublicKeys(email) {
        const addr = this._addresses.find((a) => a.email === email);
        if (!addr) return [];
        const pubs = [];
        for (const { key } of addr.keys) {
            const armored = await CryptoProxy.exportPublicKey({ key });
            pubs.push(await CryptoProxy.importPublicKey({ armoredKey: armored }));
        }
        return pubs;
    }

    async hasProtonAccount(email) {
        return this._addresses.some((a) => a.email === email);
    }
}

/**
 * Fetch the user's addresses and import their private keys with the key
 * password, producing an account ready for the SDK.
 *
 * @param {import('./httpClient.mjs').HttpClient} httpClient
 * @param {string} keyPassword - passphrase that unlocks the address keys
 */
export async function buildAccount(httpClient, keyPassword) {
    const body = await httpClient.authGet('core/v4/addresses');
    const addresses = [];

    for (const addr of body.Addresses || []) {
        if (addr.Status !== 1) continue; // 1 = enabled
        const keys = [];
        for (const k of addr.Keys || []) {
            if (!k.PrivateKey) continue;
            try {
                const key = await CryptoProxy.importPrivateKey({
                    armoredKey: k.PrivateKey,
                    passphrase: keyPassword,
                });
                keys.push({ id: k.ID, key });
            } catch {
                // Key not unlockable with this password — skip it
            }
        }
        if (keys.length === 0) continue;

        const primaryKeyIndex = Math.max(
            0,
            (addr.Keys || []).filter((k) => k.PrivateKey).findIndex((k) => k.Primary === 1),
        );
        addresses.push({ email: addr.Email, addressId: addr.ID, primaryKeyIndex, keys });
    }

    if (addresses.length === 0) throw new Error('No usable Proton address keys');
    return new Account(addresses);
}
