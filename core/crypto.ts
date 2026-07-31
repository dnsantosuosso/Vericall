// ---------------------------------------------------------------------------
// Layer 1 (Core) — Cryptography.
//
// Real, working cryptography: ECDSA P-256 signatures over the Web Crypto API
// (`crypto.subtle`). Runs unchanged in a browser, a service worker, or Node 18+
// (where `crypto` is a global). No Chrome/DOM APIs are used here.
//
// HONESTY NOTE: In this MVP the private key lives in ordinary JS memory, not in
// a hardware secure element. That means this proves "a live frame was signed by
// the holder of this key" — it does NOT protect against a genuinely compromised
// machine that can read the key or feed a fake camera. That hardware guarantee
// is what the real product adds later; see the README.
// ---------------------------------------------------------------------------

import type { SignedPayload } from './types.js';

const ALGO: EcdsaParams & EcKeyGenParams = {
  name: 'ECDSA',
  namedCurve: 'P-256',
  hash: 'SHA-256',
};

/** Resolve Web Crypto in any environment (browser, worker, or Node global). */
function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) {
    throw new Error('Web Crypto (crypto.subtle) is not available in this runtime');
  }
  return c.subtle;
}

/** Generate a fresh, extractable ECDSA P-256 keypair. */
export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return subtle().generateKey({ name: ALGO.name, namedCurve: ALGO.namedCurve }, true, [
    'sign',
    'verify',
  ]);
}

/** Export a public key to a portable JWK for sending over the relay. */
export async function exportPublicKey(key: CryptoKey): Promise<JsonWebKey> {
  return subtle().exportKey('jwk', key);
}

/** Import a peer's public key JWK into a CryptoKey usable for verification. */
export async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle().importKey(
    'jwk',
    jwk,
    { name: ALGO.name, namedCurve: ALGO.namedCurve },
    true,
    ['verify'],
  );
}

/** SHA-256 of raw bytes, returned as a lowercase hex string. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await subtle().digest('SHA-256', bytes as BufferSource);
  return bufToHex(digest);
}

/**
 * Deterministic serialization of the signed payload. Signer and verifier MUST
 * produce byte-identical output, so the format is fixed and simple:
 *   "<counter>.<timestamp>.<hash>"
 */
export function serializePayload(payload: SignedPayload): Uint8Array {
  const canonical = `${payload.counter}.${payload.timestamp}.${payload.hash}`;
  return new TextEncoder().encode(canonical);
}

/** Sign a payload; returns a base64-encoded raw ECDSA signature. */
export async function signPayload(
  privateKey: CryptoKey,
  payload: SignedPayload,
): Promise<string> {
  const sig = await subtle().sign(ALGO, privateKey, serializePayload(payload) as BufferSource);
  return bufToBase64(sig);
}

/** Verify a base64 signature against a payload and public key. */
export async function verifyPayload(
  publicKey: CryptoKey,
  payload: SignedPayload,
  signatureB64: string,
): Promise<boolean> {
  let sig: Uint8Array;
  try {
    sig = base64ToBuf(signatureB64);
  } catch {
    return false;
  }
  return subtle().verify(ALGO, publicKey, sig as BufferSource, serializePayload(payload) as BufferSource);
}

/**
 * A short, human-readable fingerprint of a public key (SHA-256 of the JWK's
 * x/y coordinates, first 8 bytes as colon-separated hex). Used in the detail
 * panel so a user can eyeball that a key hasn't changed.
 */
export async function fingerprint(jwk: JsonWebKey): Promise<string> {
  const material = `${jwk.x ?? ''}.${jwk.y ?? ''}`;
  const digest = await subtle().digest('SHA-256', new TextEncoder().encode(material));
  const hex = bufToHex(digest.slice(0, 8));
  return (hex.match(/.{2}/g) ?? []).join(':');
}

// --- small, dependency-free byte helpers (work in browser + Node) ----------

function bufToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  // btoa exists in browsers/workers; Buffer is the Node fallback.
  if (typeof btoa === 'function') return btoa(binary);
  return Buffer.from(bytes).toString('base64');
}

function base64ToBuf(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
