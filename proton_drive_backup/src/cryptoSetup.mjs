/**
 * One-time initialization of Proton's CryptoProxy for use in Node.js.
 *
 * The Drive SDK delegates all OpenPGP work to a `CryptoApiInterface`
 * (CryptoProxy) provided by @protontech/crypto. In the browser this runs in a
 * Web Worker; in Node we set the endpoint to a direct in-process Api instance.
 */

import '@protontech/crypto/polyfill';
import { webcrypto } from 'node:crypto';
import { CryptoProxy } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';

let initialized = false;

export async function setupCrypto() {
    if (initialized) return;
    if (!globalThis.crypto) globalThis.crypto = webcrypto;
    await CryptoApi.init?.({});
    CryptoProxy.setEndpoint(new CryptoApi());
    initialized = true;
}

export { CryptoProxy };
