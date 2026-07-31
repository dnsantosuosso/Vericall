// Integration test for the relay server's pairing + forwarding logic.
// Boots the real server on an ephemeral port and drives it with two real
// Core RelayClients (Node 22 provides a global WebSocket).
//
// Run: npm run test:relay
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
// Pick a port and boot the server BEFORE importing anything that reads it.
process.env.PORT = '8811';
process.env.VERICALL_MAX_PER_SESSION = '2';
const { wss, httpServer } = await import('./index.js');
const { RelayClient } = await import('../core/relayClient.js');

const URL = `ws://localhost:${process.env.PORT}`;

before(async () => {
  if (!httpServer.listening) await new Promise((r) => httpServer.once('listening', r));
});

after(() => {
  wss.close();
  httpServer.close();
});

/** Wait for a specific event on a client, with a timeout. */
function waitFor<T>(client: InstanceType<typeof RelayClient>, event: any, ms = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    client.on(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

test('two clients in the same session are paired and can exchange messages', async () => {
  const session = 'test-session-' + Math.random().toString(36).slice(2, 7);
  const a = new RelayClient({ url: URL, session, participantId: 'alice', reconnect: false });
  const b = new RelayClient({ url: URL, session, participantId: 'bob', reconnect: false });

  const aJoined = waitFor<{ peers: string[] }>(a, 'joined');
  a.connect();
  const aJoinedMsg = await aJoined;
  assert.deepEqual(aJoinedMsg.peers, [], 'alice joins an empty session');

  // Alice should be told when Bob shows up.
  const aSeesPeer = waitFor<{ participantId: string }>(a, 'peer-joined');
  const bJoined = waitFor<{ peers: string[] }>(b, 'joined');
  b.connect();

  const bJoinedMsg = await bJoined;
  assert.deepEqual(bJoinedMsg.peers, ['alice'], 'bob sees alice already present');
  assert.equal((await aSeesPeer).participantId, 'bob');

  // Public key forwarding: Alice -> Bob.
  const bGetsKey = waitFor<{ from: string; publicKeyJwk: JsonWebKey }>(b, 'pubkey');
  a.sendPublicKey({ kty: 'EC', crv: 'P-256', x: 'AAA', y: 'BBB' } as JsonWebKey);
  const key = await bGetsKey;
  assert.equal(key.from, 'alice');
  assert.equal(key.publicKeyJwk.x, 'AAA');

  // Signed-frame forwarding: Bob -> Alice.
  const aGetsFrame = waitFor<{ from: string; counter: number }>(a, 'signed-frame');
  b.sendSignedFrame({ counter: 7, timestamp: Date.now(), hash: 'h', signature: 's' });
  const frame = await aGetsFrame;
  assert.equal(frame.from, 'bob');
  assert.equal(frame.counter, 7);

  // Bob leaving notifies Alice.
  const aSeesLeave = waitFor<{ participantId: string }>(a, 'peer-left');
  b.close();
  assert.equal((await aSeesLeave).participantId, 'bob');

  a.close();
});

test('a third client is rejected when the session is full', async () => {
  const session = 'full-session-' + Math.random().toString(36).slice(2, 7);
  const a = new RelayClient({ url: URL, session, participantId: 'a', reconnect: false });
  const b = new RelayClient({ url: URL, session, participantId: 'b', reconnect: false });
  const c = new RelayClient({ url: URL, session, participantId: 'c', reconnect: false });

  a.connect();
  await waitFor(a, 'joined');
  b.connect();
  await waitFor(b, 'joined');

  const cRejected = waitFor<string>(c, 'error');
  c.connect();
  const errMsg = await cRejected;
  assert.match(errMsg, /full/i);

  a.close();
  b.close();
  c.close();
});

test('messages do not leak between different sessions', async () => {
  const a = new RelayClient({ url: URL, session: 'room-x', participantId: 'ax', reconnect: false });
  const b = new RelayClient({ url: URL, session: 'room-y', participantId: 'by', reconnect: false });
  a.connect();
  await waitFor(a, 'joined');
  b.connect();
  await waitFor(b, 'joined');

  let bGotSomething = false;
  b.on('signed-frame', () => (bGotSomething = true));
  a.sendSignedFrame({ counter: 1, timestamp: Date.now(), hash: 'h', signature: 's' });

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(bGotSomething, false, 'a frame in room-x must not reach room-y');

  a.close();
  b.close();
});
