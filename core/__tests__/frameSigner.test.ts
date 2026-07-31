import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameSigner } from '../frameSigner.js';
import { importPublicKey, verifyPayload } from '../crypto.js';

const frame = new Uint8Array([9, 8, 7, 6, 5]);

test('signed frames verify and the counter strictly increases', async () => {
  const signer = new FrameSigner();
  const pub = await importPublicKey(await signer.init());

  const a = await signer.signFrame(frame);
  const b = await signer.signFrame(frame);
  assert.ok(a && b);
  assert.equal(b!.counter, a!.counter + 1);

  assert.equal(
    await verifyPayload(pub, { counter: a!.counter, timestamp: a!.timestamp, hash: a!.hash }, a!.signature),
    true,
  );
});

test("tamper 'bad-signature' produces a message that fails verification", async () => {
  const signer = new FrameSigner();
  const pub = await importPublicKey(await signer.init());
  signer.setTamperMode('bad-signature');

  const f = await signer.signFrame(frame);
  assert.ok(f);
  assert.equal(
    await verifyPayload(pub, { counter: f!.counter, timestamp: f!.timestamp, hash: f!.hash }, f!.signature),
    false,
  );
});

test("tamper 'silent' emits no frames", async () => {
  const signer = new FrameSigner();
  await signer.init();
  signer.setTamperMode('silent');
  assert.equal(await signer.signFrame(frame), null);
});

test('restoring honest mode signs validly again', async () => {
  const signer = new FrameSigner();
  const pub = await importPublicKey(await signer.init());
  signer.setTamperMode('bad-signature');
  await signer.signFrame(frame);
  signer.setTamperMode('off');

  const f = await signer.signFrame(frame);
  assert.ok(f);
  assert.equal(
    await verifyPayload(pub, { counter: f!.counter, timestamp: f!.timestamp, hash: f!.hash }, f!.signature),
    true,
  );
});

test('signFrame before init throws', async () => {
  const signer = new FrameSigner();
  await assert.rejects(() => signer.signFrame(frame));
});
