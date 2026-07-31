import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  exportPublicKey,
  fingerprint,
  generateKeyPair,
  hashBytes,
  importPublicKey,
  signPayload,
  verifyPayload,
} from '../crypto.js';
import type { SignedPayload } from '../types.js';

const payload: SignedPayload = { counter: 1, timestamp: 1_700_000_000_000, hash: 'abc123' };

test('sign then verify succeeds', async () => {
  const kp = await generateKeyPair();
  const pub = await importPublicKey(await exportPublicKey(kp.publicKey));
  const sig = await signPayload(kp.privateKey, payload);
  assert.equal(await verifyPayload(pub, payload, sig), true);
});

test('tampering with the payload makes verification fail', async () => {
  const kp = await generateKeyPair();
  const pub = await importPublicKey(await exportPublicKey(kp.publicKey));
  const sig = await signPayload(kp.privateKey, payload);

  // Change the hash -> signature must no longer match.
  assert.equal(await verifyPayload(pub, { ...payload, hash: 'deadbeef' }, sig), false);
  // Change the counter.
  assert.equal(await verifyPayload(pub, { ...payload, counter: 2 }, sig), false);
  // Change the timestamp.
  assert.equal(await verifyPayload(pub, { ...payload, timestamp: 0 }, sig), false);
});

test('a corrupted signature fails verification', async () => {
  const kp = await generateKeyPair();
  const pub = await importPublicKey(await exportPublicKey(kp.publicKey));
  const sig = await signPayload(kp.privateKey, payload);
  const broken = sig.slice(0, -2) + (sig.endsWith('A') ? 'B' : 'A') + sig.slice(-1);
  assert.equal(await verifyPayload(pub, payload, broken), false);
});

test('garbage signature input returns false, never throws', async () => {
  const kp = await generateKeyPair();
  const pub = await importPublicKey(await exportPublicKey(kp.publicKey));
  assert.equal(await verifyPayload(pub, payload, 'not-base64-!!!'), false);
});

test("a different key's signature does not verify", async () => {
  const a = await generateKeyPair();
  const b = await generateKeyPair();
  const pubB = await importPublicKey(await exportPublicKey(b.publicKey));
  const sig = await signPayload(a.privateKey, payload);
  assert.equal(await verifyPayload(pubB, payload, sig), false);
});

test('hashBytes is stable and differs for different input', async () => {
  const h1 = await hashBytes(new Uint8Array([1, 2, 3]));
  const h2 = await hashBytes(new Uint8Array([1, 2, 3]));
  const h3 = await hashBytes(new Uint8Array([1, 2, 4]));
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test('fingerprint is deterministic and colon-formatted', async () => {
  const kp = await generateKeyPair();
  const jwk = await exportPublicKey(kp.publicKey);
  const f1 = await fingerprint(jwk);
  const f2 = await fingerprint(jwk);
  assert.equal(f1, f2);
  assert.match(f1, /^([0-9a-f]{2}:){7}[0-9a-f]{2}$/);
});
