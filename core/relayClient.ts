// ---------------------------------------------------------------------------
// Layer 1 (Core) — Relay client.
//
// Thin wrapper around a WebSocket that speaks the VeriCall wire protocol
// (see types.ts). Uses the global `WebSocket`, which exists in browsers,
// service workers, and Node 22+. No Chrome/DOM specifics — an adapter for any
// platform, or a standalone app, reuses this unchanged.
// ---------------------------------------------------------------------------

import { Emitter } from './emitter.js';
import type {
  JoinedMessage,
  PeerJoinedMessage,
  PeerLeftMessage,
  PublicKeyMessage,
  ServerMessage,
  SignedFrameMessage,
} from './types.js';

type Events = {
  open: void;
  joined: JoinedMessage;
  'peer-joined': PeerJoinedMessage;
  'peer-left': PeerLeftMessage;
  pubkey: PublicKeyMessage;
  'signed-frame': SignedFrameMessage;
  error: string;
  close: void;
};

export interface RelayClientOptions {
  url: string;
  session: string;
  participantId: string;
  /** Auto-reconnect on unexpected close. Default true. */
  reconnect?: boolean;
  /** Injectable WebSocket ctor for tests. Defaults to global WebSocket. */
  WebSocketImpl?: typeof WebSocket;
}

export class RelayClient extends Emitter<Events> {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly WS: typeof WebSocket;

  constructor(private readonly opts: RelayClientOptions) {
    super();
    const impl = opts.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!impl) throw new Error('No WebSocket implementation available');
    this.WS = impl;
  }

  connect(): void {
    this.closedByUser = false;
    const ws = new this.WS(this.opts.url);
    this.ws = ws;

    ws.onopen = () => {
      this.emit('open', undefined);
      this.send({
        type: 'join',
        session: this.opts.session,
        participantId: this.opts.participantId,
      });
    };

    ws.onmessage = (ev: MessageEvent) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      this.dispatch(msg);
    };

    ws.onerror = () => this.emit('error', 'websocket error');

    ws.onclose = () => {
      this.emit('close', undefined);
      if (!this.closedByUser && this.opts.reconnect !== false) {
        this.reconnectTimer = setTimeout(() => this.connect(), 1000);
      }
    };
  }

  private dispatch(msg: ServerMessage): void {
    switch (msg.type) {
      case 'joined':
        return this.emit('joined', msg);
      case 'peer-joined':
        return this.emit('peer-joined', msg);
      case 'peer-left':
        return this.emit('peer-left', msg);
      case 'pubkey':
        return this.emit('pubkey', msg);
      case 'signed-frame':
        return this.emit('signed-frame', msg);
      case 'error':
        return this.emit('error', msg.message);
    }
  }

  /** Broadcast this participant's public key to the session. */
  sendPublicKey(publicKeyJwk: JsonWebKey): void {
    this.send({ type: 'pubkey', from: this.opts.participantId, publicKeyJwk });
  }

  /** Send a signed video frame to the session. */
  sendSignedFrame(frame: Omit<SignedFrameMessage, 'type' | 'from'>): void {
    this.send({ type: 'signed-frame', from: this.opts.participantId, ...frame });
  }

  get connected(): boolean {
    return this.ws?.readyState === 1; // WebSocket.OPEN
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
