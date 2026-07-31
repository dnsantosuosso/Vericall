// ---------------------------------------------------------------------------
// Layer 5 wiring — VeriCallController.
//
// The glue that ties the three layers together for a running session:
//   Core (FrameSigner + VerificationTracker + RelayClient)
//     ⟶ signs the local stream, verifies remote frames, tracks state
//   PlatformAdapter (injected)
//     ⟶ supplies the local stream & remote tiles, draws the badge
//
// It is itself platform-agnostic: it receives a PlatformAdapter through its
// constructor, so pointing VeriCall at Zoom/Teams/standalone later means
// passing a different adapter here — nothing in this file changes.
// ---------------------------------------------------------------------------

import {
  FrameSigner,
  RelayClient,
  VerificationTracker,
  fingerprint,
  type ParticipantStatus,
  type TamperMode,
} from '../core/index.js';
import type {
  AdapterDiagnostics,
  PlatformAdapter,
  RemoteTile,
} from '../adapters/platformAdapter.js';
import { FrameCapturer } from './frameCapture.js';

export interface ControllerConfig {
  relayUrl: string;
  session: string;
  participantId: string;
  /** How often to capture+sign a frame. Default 1000ms. */
  signIntervalMs?: number;
  /**
   * WebSocket implementation for the relay. In the extension this is the
   * background-proxy socket (Meet's HTTPS page can't open ws:// directly);
   * defaults to the global WebSocket when unset (e.g. tests / standalone app).
   */
  relaySocketImpl?: typeof WebSocket;
  onStatus?: (summary: SessionSummary) => void;
}

export interface SessionSummary {
  session: string;
  connected: boolean;
  tamperMode: TamperMode;
  localFingerprint: string | null;
  participants: ParticipantStatus[];
  /** Count of frames we've signed and sent, for rehearsal diagnostics. */
  framesSent: number;
  /** Adapter self-report (tiles found, local stream source), if provided. */
  adapter?: AdapterDiagnostics;
}

export class VeriCallController {
  private readonly signer = new FrameSigner();
  private readonly tracker = new VerificationTracker({ freshnessMs: 3000 });
  private readonly relay: RelayClient;
  private capturer: FrameCapturer | null = null;
  private signTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private localFingerprint: string | null = null;
  private framesSent = 0;
  private readonly tiles = new Map<string, RemoteTile>();
  private unsubscribes: Array<() => void> = [];
  private stopped = false;

  constructor(
    private readonly adapter: PlatformAdapter,
    private readonly config: ControllerConfig,
  ) {
    this.relay = new RelayClient({
      url: config.relayUrl,
      session: config.session,
      participantId: config.participantId,
      WebSocketImpl: config.relaySocketImpl,
    });
  }

  async start(): Promise<void> {
    const publicKeyJwk = await this.signer.init();
    this.localFingerprint = await fingerprint(publicKeyJwk);

    this.wireRelay(publicKeyJwk);
    this.wireTracker();
    this.wireTiles();

    this.relay.connect();

    // Start capturing + signing the local outgoing video.
    try {
      const stream = await this.adapter.getLocalVideoStream();
      this.capturer = new FrameCapturer(stream);
    } catch (err) {
      console.warn('[VeriCall] could not get local video stream:', err);
    }

    const interval = this.config.signIntervalMs ?? 1000;
    this.signTimer = setInterval(() => void this.signAndSend(), interval);
    // Independent tick so remote tiles go 'stale' even if nothing arrives, and
    // so the HUD/popup diagnostics (frames sent, tiles found) refresh live.
    this.tickTimer = setInterval(() => {
      this.tracker.tick();
      this.emitStatus();
    }, 1000);

    this.emitStatus();
  }

  private wireRelay(publicKeyJwk: JsonWebKey): void {
    // Announce our key on connect and whenever a new peer joins.
    this.relay.on('open', () => this.emitStatus());
    this.relay.on('joined', () => this.relay.sendPublicKey(publicKeyJwk));
    this.relay.on('peer-joined', () => this.relay.sendPublicKey(publicKeyJwk));

    this.relay.on('pubkey', (msg) => {
      void this.tracker.setPublicKey(msg.from, msg.publicKeyJwk);
    });

    this.relay.on('signed-frame', (msg) => {
      void this.tracker.ingestFrame(msg);
    });

    this.relay.on('peer-left', (msg) => {
      this.tracker.remove(msg.participantId);
      const tile = this.tiles.get(msg.participantId);
      if (tile) this.adapter.removeBadge(tile);
      this.emitStatus();
    });

    this.relay.on('close', () => this.emitStatus());
  }

  private wireTracker(): void {
    this.tracker.on('state-change', (status) => {
      this.paintTile(status);
      this.emitStatus();
    });
  }

  private wireTiles(): void {
    this.unsubscribes.push(
      this.adapter.onRemoteTileAdded((tile) => {
        this.tiles.set(tile.participantId, tile);
        // Show an initial "waiting" badge until frames verify.
        const status = this.tracker.getStatus(tile.participantId);
        this.adapter.renderBadge(tile, status?.state ?? 'unknown', {
          reason: status?.reason,
        });
      }),
    );
    this.unsubscribes.push(
      this.adapter.onRemoteTileRemoved((participantId) => {
        this.tiles.delete(participantId);
      }),
    );
  }

  /**
   * NOTE ON IDENTITY: the platform's tile id and the relay participant id are
   * two different namespaces. In this 1:1 MVP each side has exactly one remote,
   * so we badge every known remote tile with the (single) remote crypto status.
   * A multi-party build would map tile-id ⟷ crypto-id explicitly.
   */
  private paintTile(status: ParticipantStatus): void {
    void (async () => {
      const detail = {
        reason: status.reason,
        lastVerifiedAt: status.lastVerifiedAt,
        signatureCount: status.signatureCount,
        fingerprint: status.publicKeyJwk ? await fingerprint(status.publicKeyJwk) : undefined,
      };
      for (const tile of this.tiles.values()) {
        this.adapter.renderBadge(tile, status.state, detail);
      }
    })();
  }

  private async signAndSend(): Promise<void> {
    if (!this.capturer) return;
    const bytes = this.capturer.capture();
    if (!bytes) return;
    const frame = await this.signer.signFrame(bytes);
    if (frame) {
      this.relay.sendSignedFrame(frame);
      this.framesSent += 1;
    }
  }

  /** Core demo control — flips the OTHER participant's badge. */
  setTamperMode(mode: TamperMode): void {
    this.signer.setTamperMode(mode);
    this.emitStatus();
  }

  getTamperMode(): TamperMode {
    return this.signer.getTamperMode();
  }

  private emitStatus(): void {
    if (this.stopped) return;
    this.config.onStatus?.({
      session: this.config.session,
      connected: this.relay.connected,
      tamperMode: this.signer.getTamperMode(),
      localFingerprint: this.localFingerprint,
      participants: this.tracker.all(),
      framesSent: this.framesSent,
      adapter: this.adapter.getDiagnostics?.(),
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.signTimer) clearInterval(this.signTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.unsubscribes.forEach((u) => u());
    this.unsubscribes = [];
    this.capturer?.stop();
    this.capturer = null;
    for (const tile of this.tiles.values()) this.adapter.removeBadge(tile);
    this.tiles.clear();
    this.relay.close();
  }
}
