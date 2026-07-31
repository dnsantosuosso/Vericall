import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VerificationTracker } from '../verificationState.js';
import {
  exportPublicKey,
  generateKeyPair,
  signPayload,
} from '../crypto.js';
import type { SignedFrameMessage } from '../types.js';

const FROM = 'peer-1';

/** Build a signed-frame message from a keypair, with controllable fields. */
async function makeFrame(
  priv: CryptoKey,
  opts: { counter: number; timestamp: number; hash?: string; signature?: string },
): Promise<SignedFrameMessage> {
  const hash = opts.hash ?? 'framehash';
  const signature =
    opts.signature ??
    (await signPayload(priv, { counter: opts.counter, timestamp: opts.timestamp, hash }));
  return { type: 'signed-frame', from: FROM, counter: opts.counter, timestamp: opts.timestamp, hash, signature };
}

test('a fresh, valid, increasing frame becomes verified and emits once', async () => {
  const clock = { t: 10_000 };
  const tracker = new VerificationTracker({ freshnessMs: 3000, now: () => clock.t });
  const kp = await generateKeyPair();
  await tracker.setPublicKey(FROM, await exportPublicKey(kp.publicKey));

  const events: string[] = [];
  tracker.on('state-change', (s) => events.push(s.state));

  const status = await tracker.ingestFrame(await makeFrame(kp.privateKey, { counter: 1, timestamp: 10_000 }));
  assert.equal(status.state, 'verified');
  assert.equal(status.signatureCount, 1);
  assert.deepEqual(events, ['verified']);
});

test('state-change only fires when the state actually changes', async () => {
  const clock = { t: 10_000 };
  const tracker = new VerificationTracker({ freshnessMs: 3000, now: () => clock.t });
  const kp = await generateKeyPair();
  await tracker.setPublicKey(FROM, await exportPublicKey(kp.publicKey));

  const events: string[] = [];
  tracker.on('state-change', (s) => events.push(s.state));

  await tracker.ingestFrame(await makeFrame(kp.privateKey, { counter: 1, timestamp: 10_000 }));
  await tracker.ingestFrame(await makeFrame(kp.privateKey, { counter: 2, timestamp: 10_000 }));
  // Two verified frames, but only one state transition into 'verified'.
  assert.deepEqual(events, ['verified']);
});

test('a bad signature is rejected as unverified', async () => {
  const tracker = new VerificationTracker({ freshnessMs: 3000, now: () => 10_000 });
  const kp = await generateKeyPair();
  await tracker.setPublicKey(FROM, await exportPublicKey(kp.publicKey));

  const good = await makeFrame(kp.privateKey, { counter: 1, timestamp: 10_000 });
  const tampered = { ...good, hash: 'different-hash-so-sig-mismatches' };
  const status = await tracker.ingestFrame(tampered);
  assert.equal(status.state, 'unverified');
  assert.match(status.reason ?? '', /signature/);
});

test('replayed / non-increasing counter is rejected', async () => {
  const tracker = new VerificationTracker({ freshnessMs: 3000, now: () => 10_000 });
  const kp = await generateKeyPair();
  await tracker.setPublicKey(FROM, await exportPublicKey(kp.publicKey));

  await tracker.ingestFrame(await makeFrame(kp.privateKey, { counter: 5, timestamp: 10_000 }));
  // Replay the same counter with a perfectly valid signature.
  const replay = await tracker.ingestFrame(await makeFrame(kp.privateKey, { counter: 5, timestamp: 10_000 }));
  assert.equal(replay.state, 'unverified');
  assert.match(replay.reason ?? '', /counter/);
});

test('an old (stale-timestamp) but validly-signed frame is rejected as replay', async () => {
  const clock = { t: 20_000 };
  const tracker = new VerificationTracker({ freshnessMs: 3000, now: () => clock.t });
  const kp = await generateKeyPair();
  await tracker.setPublicKey(FROM, await exportPublicKey(kp.publicKey));

  // Timestamp is 10s old, freshness window is 3s.
  const old = await makeFrame(kp.privateKey, { counter: 1, timestamp: 10_000 });
  const status = await tracker.ingestFrame(old);
  assert.equal(status.state, 'unverified');
  assert.match(status.reason ?? '', /stale|replay/);
});

test('a future timestamp is rejected', async () => {
  const tracker = new VerificationTracker({ freshnessMs: 3000, now: () => 10_000 });
  const kp = await generateKeyPair();
  await tracker.setPublicKey(FROM, await exportPublicKey(kp.publicKey));
  const future = await makeFrame(kp.privateKey, { counter: 1, timestamp: 999_999 });
  const status = await tracker.ingestFrame(future);
  assert.equal(status.state, 'unverified');
});

test('frames before a public key is known are "unknown"', async () => {
  const tracker = new VerificationTracker({ now: () => 10_000 });
  const kp = await generateKeyPair();
  const frame = await makeFrame(kp.privateKey, { counter: 1, timestamp: 10_000 });
  const status = await tracker.ingestFrame(frame);
  assert.equal(status.state, 'unknown');
});

test('tick() marks a previously-verified participant stale after freshness window', async () => {
  const clock = { t: 10_000 };
  const tracker = new VerificationTracker({ freshnessMs: 3000, now: () => clock.t });
  const kp = await generateKeyPair();
  await tracker.setPublicKey(FROM, await exportPublicKey(kp.publicKey));

  const events: string[] = [];
  tracker.on('state-change', (s) => events.push(s.state));

  await tracker.ingestFrame(await makeFrame(kp.privateKey, { counter: 1, timestamp: 10_000 }));
  // Advance 4s with no new frames.
  clock.t = 14_000;
  tracker.tick();
  assert.equal(tracker.getStatus(FROM)?.state, 'stale');
  assert.deepEqual(events, ['verified', 'stale']);
});

test('remove() forgets a participant', async () => {
  const tracker = new VerificationTracker({ now: () => 10_000 });
  const kp = await generateKeyPair();
  await tracker.setPublicKey(FROM, await exportPublicKey(kp.publicKey));
  await tracker.ingestFrame(await makeFrame(kp.privateKey, { counter: 1, timestamp: 10_000 }));
  tracker.remove(FROM);
  assert.equal(tracker.getStatus(FROM), undefined);
  assert.equal(tracker.all().length, 0);
});
