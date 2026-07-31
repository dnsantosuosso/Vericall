// ---------------------------------------------------------------------------
// Layer 1 (Core) — Per-participant verification state machine.
//
// Tracks, for each remote participant, whether their incoming signed video
// frames are currently trustworthy, and emits an event whenever that changes.
// No DOM, no Chrome, no timers you can't inject — fully unit-testable.
//
// Rules for a frame to be accepted (all must hold):
//   1. Signature verifies against the participant's known public key.
//   2. The counter strictly increases (rejects replay / reorder).
//   3. The timestamp is "fresh" — within `freshnessMs` of now (rejects replay
//      of an old captured-but-valid frame).
// A participant with no fresh valid frame for `freshnessMs` goes 'stale'
// (rendered the same as 'unverified' / red on the badge).
// ---------------------------------------------------------------------------

import { Emitter } from './emitter.js';
import { importPublicKey, verifyPayload } from './crypto.js';
import type { SignedFrameMessage, VerificationState } from './types.js';

export interface VerificationConfig {
  /** Max age of a frame's timestamp to still be considered live. Default 3000ms. */
  freshnessMs?: number;
  /** Clock injection for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface ParticipantStatus {
  participantId: string;
  state: VerificationState;
  lastCounter: number;
  lastVerifiedAt: number | null;
  signatureCount: number;
  publicKeyJwk: JsonWebKey | null;
  /** Set to a short reason when state is unverified, for the detail panel. */
  reason?: string;
}

interface ParticipantRecord extends ParticipantStatus {
  publicKey: CryptoKey | null;
}

type Events = {
  /** Fired only when a participant's state actually changes. */
  'state-change': ParticipantStatus;
};

export class VerificationTracker extends Emitter<Events> {
  private readonly freshnessMs: number;
  private readonly now: () => number;
  private readonly participants = new Map<string, ParticipantRecord>();

  constructor(config: VerificationConfig = {}) {
    super();
    this.freshnessMs = config.freshnessMs ?? 3000;
    this.now = config.now ?? (() => Date.now());
  }

  /** Register (or replace) a participant's public key. Idempotent. */
  async setPublicKey(participantId: string, jwk: JsonWebKey): Promise<void> {
    const rec = this.ensure(participantId);
    rec.publicKeyJwk = jwk;
    rec.publicKey = await importPublicKey(jwk);
  }

  /**
   * Feed an incoming signed frame. Returns the resulting status.
   * Emits 'state-change' only if the state string actually changed.
   */
  async ingestFrame(msg: SignedFrameMessage): Promise<ParticipantStatus> {
    const rec = this.ensure(msg.from);

    if (!rec.publicKey) {
      return this.transition(rec, 'unknown', 'no public key yet');
    }

    const now = this.now();
    if (msg.timestamp > now + this.freshnessMs) {
      return this.transition(rec, 'unverified', 'timestamp from the future');
    }
    if (now - msg.timestamp > this.freshnessMs) {
      return this.transition(rec, 'unverified', 'stale timestamp (replay?)');
    }
    if (msg.counter <= rec.lastCounter) {
      return this.transition(rec, 'unverified', 'counter did not increase (replay?)');
    }

    const ok = await verifyPayload(
      rec.publicKey,
      { counter: msg.counter, timestamp: msg.timestamp, hash: msg.hash },
      msg.signature,
    );
    if (!ok) {
      return this.transition(rec, 'unverified', 'bad signature');
    }

    rec.lastCounter = msg.counter;
    rec.lastVerifiedAt = now;
    rec.signatureCount += 1;
    return this.transition(rec, 'verified', undefined);
  }

  /**
   * Advance time: mark any participant whose last verified frame is older than
   * `freshnessMs` as 'stale'. Call this on a timer (~1s) in the host layer.
   */
  tick(): void {
    const now = this.now();
    for (const rec of this.participants.values()) {
      if (
        rec.state === 'verified' &&
        rec.lastVerifiedAt !== null &&
        now - rec.lastVerifiedAt > this.freshnessMs
      ) {
        this.transition(rec, 'stale', 'no fresh frames');
      }
    }
  }

  /** Remove a participant entirely (e.g. they left the call). */
  remove(participantId: string): void {
    this.participants.delete(participantId);
  }

  getStatus(participantId: string): ParticipantStatus | undefined {
    const rec = this.participants.get(participantId);
    return rec ? this.snapshot(rec) : undefined;
  }

  all(): ParticipantStatus[] {
    return [...this.participants.values()].map((r) => this.snapshot(r));
  }

  // --- internals -----------------------------------------------------------

  private ensure(participantId: string): ParticipantRecord {
    let rec = this.participants.get(participantId);
    if (!rec) {
      rec = {
        participantId,
        state: 'unknown',
        lastCounter: -1,
        lastVerifiedAt: null,
        signatureCount: 0,
        publicKeyJwk: null,
        publicKey: null,
      };
      this.participants.set(participantId, rec);
    }
    return rec;
  }

  private transition(
    rec: ParticipantRecord,
    state: VerificationState,
    reason: string | undefined,
  ): ParticipantStatus {
    const changed = rec.state !== state;
    rec.state = state;
    rec.reason = reason;
    const snap = this.snapshot(rec);
    if (changed) this.emit('state-change', snap);
    return snap;
  }

  private snapshot(rec: ParticipantRecord): ParticipantStatus {
    return {
      participantId: rec.participantId,
      state: rec.state,
      lastCounter: rec.lastCounter,
      lastVerifiedAt: rec.lastVerifiedAt,
      signatureCount: rec.signatureCount,
      publicKeyJwk: rec.publicKeyJwk,
      reason: rec.reason,
    };
  }
}
