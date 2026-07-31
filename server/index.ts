// ---------------------------------------------------------------------------
// Layer 3 — Relay server.
//
// Does exactly two things:
//   1. Pairs extension instances that enter the same session code.
//   2. Forwards messages (public keys, then signed frames) between the
//      participants in that session.
//
// It is intentionally platform-agnostic and crypto-blind: it never inspects or
// validates signatures, and has no idea whether a client is on Meet, Zoom, or a
// standalone app. All verification happens in each client's Core layer.
//
// Run locally:  npm run server   (listens on ws://localhost:8787)
// ---------------------------------------------------------------------------

import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  ClientMessage,
  JoinedMessage,
  PeerJoinedMessage,
  PeerLeftMessage,
  ServerMessage,
} from '../core/types.js';

const PORT = Number(process.env.PORT ?? 8787);
/** Demo cap: keep sessions to two participants, like a 1:1 call. */
const MAX_PER_SESSION = Number(process.env.VERICALL_MAX_PER_SESSION ?? 2);

interface Client {
  socket: WebSocket;
  session: string;
  participantId: string;
}

/** session code -> set of clients currently in it. */
const sessions = new Map<string, Set<Client>>();

// Plain HTTP server so hosting platforms (Render/Fly) get a health endpoint,
// with the WebSocket server sharing the same port. WebSocket upgrades and
// health GETs both work on one URL.
const httpServer = createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`VeriCall relay OK — ${sessions.size} active session(s)`);
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

/** Send `msg` to everyone in the session except `exclude`. */
function broadcast(session: string, msg: ServerMessage, exclude?: Client): void {
  const peers = sessions.get(session);
  if (!peers) return;
  for (const peer of peers) {
    if (peer !== exclude) send(peer.socket, msg);
  }
}

wss.on('connection', (socket) => {
  let client: Client | null = null;

  socket.on('message', (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // ignore malformed frames
    }

    if (msg.type === 'join') {
      client = handleJoin(socket, msg.session, msg.participantId);
      return;
    }

    // All other message types are opaquely forwarded to the rest of the session.
    if (!client) return; // must join first
    if (msg.type === 'pubkey' || msg.type === 'signed-frame') {
      broadcast(client.session, msg, client);
    }
  });

  socket.on('close', () => {
    if (!client) return;
    const peers = sessions.get(client.session);
    peers?.delete(client);
    const left: PeerLeftMessage = { type: 'peer-left', participantId: client.participantId };
    broadcast(client.session, left, client);
    if (peers && peers.size === 0) sessions.delete(client.session);
    log(`− ${client.participantId} left ${client.session} (${peers?.size ?? 0} remain)`);
  });
});

function handleJoin(socket: WebSocket, session: string, participantId: string): Client | null {
  const peers = sessions.get(session) ?? new Set<Client>();

  if (peers.size >= MAX_PER_SESSION) {
    send(socket, { type: 'error', message: `Session "${session}" is full (${MAX_PER_SESSION} max)` });
    return null;
  }

  const client: Client = { socket, session, participantId };
  peers.add(client);
  sessions.set(session, peers);

  // Tell the joiner who is already here.
  const existing = [...peers].filter((p) => p !== client).map((p) => p.participantId);
  const joined: JoinedMessage = { type: 'joined', session, peers: existing };
  send(socket, joined);

  // Tell everyone else the joiner arrived.
  const announce: PeerJoinedMessage = { type: 'peer-joined', participantId };
  broadcast(session, announce, client);

  log(`+ ${participantId} joined ${session} (${peers.size} present)`);
  return client;
}

function log(line: string): void {
  console.log(`[relay ${new Date().toISOString()}] ${line}`);
}

httpServer.listen(PORT, () => {
  console.log(
    `[relay] VeriCall relay listening on ws://localhost:${PORT} ` +
      `(health: http://localhost:${PORT}/health, max ${MAX_PER_SESSION}/session)`,
  );
});

// Exported for tests / programmatic shutdown.
export { wss, httpServer, sessions };
