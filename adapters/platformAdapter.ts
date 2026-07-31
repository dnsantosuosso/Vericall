// ---------------------------------------------------------------------------
// Layer 2 (Platform adapter) — THE EXTENSIBILITY CONTRACT.
//
// This interface is the single seam between VeriCall's platform-agnostic Core
// and any specific calling surface. The Meet adapter in ./meet implements it.
// To support a new platform later you write ONE new file that implements this
// interface — you do not touch core/ and you do not touch the extension wiring
// that consumes it.
//
//   adapters/meet/meetAdapter.ts       <- this build
//   adapters/zoom/zoomAdapter.ts       <- future: same interface, Zoom's DOM
//   adapters/teams/teamsAdapter.ts     <- future: same interface, Teams' DOM
//   adapters/standaloneApp/...         <- future: same interface, own UI
//
// An adapter's ONLY responsibilities are:
//   1. Provide the local outgoing camera stream (to be snapshotted + signed).
//   2. Notify when a remote participant's video tile appears / disappears.
//   3. Draw / update / remove the verification badge on a given tile.
//
// An adapter MUST NOT know anything about signing, verifying, key exchange,
// counters, timestamps, or the relay. That all lives in core/.
// ---------------------------------------------------------------------------

import type { VerificationState } from '../core/types.js';

/** A remote participant's video tile as discovered on the call surface. */
export interface RemoteTile {
  /**
   * A stable-per-session id for this participant. It only needs to be unique
   * within the call and consistent for the life of the tile; it is NOT tied to
   * the crypto identity (that is the exchanged public key).
   */
  participantId: string;
  /** The platform-specific DOM element to overlay the badge onto. */
  element: HTMLElement;
  /** Optional display name, if the platform exposes one. */
  displayName?: string;
}

/** Extra data the host may pass to enrich the badge / detail panel. */
export interface BadgeDetail {
  reason?: string;
  fingerprint?: string;
  lastVerifiedAt?: number | null;
  signatureCount?: number;
  displayName?: string;
}

/**
 * Optional self-reported health from an adapter, surfaced in the on-page HUD
 * and popup so a live demo can be validated at a glance during rehearsal.
 */
export interface AdapterDiagnostics {
  /** How many remote tiles the adapter currently sees. */
  remoteTilesFound: number;
  /** Where the local outgoing stream came from. */
  localStreamSource: 'meet-self-view' | 'camera' | 'none' | 'unknown';
  /** Free-form note for the operator (e.g. "self tile excluded"). */
  note?: string;
}

export interface PlatformAdapter {
  /** Human-readable platform name, for logs/UI (e.g. "Google Meet"). */
  readonly platformName: string;

  /** True if the current page is this platform (used to pick an adapter). */
  isActive(): boolean;

  /**
   * Resolve the local outgoing camera MediaStream so Core can snapshot and sign
   * it. May wait until the user's camera is live.
   */
  getLocalVideoStream(): Promise<MediaStream>;

  /**
   * Subscribe to remote participant tiles appearing. The callback fires once
   * per tile that shows up (including tiles already present at subscribe time).
   * Returns an unsubscribe function.
   */
  onRemoteTileAdded(cb: (tile: RemoteTile) => void): () => void;

  /**
   * Subscribe to remote tiles being removed (participant left / tile recycled).
   * Returns an unsubscribe function.
   */
  onRemoteTileRemoved(cb: (participantId: string) => void): () => void;

  /** Create/update the badge overlay on a tile to reflect `state`. */
  renderBadge(tile: RemoteTile, state: VerificationState, detail?: BadgeDetail): void;

  /** Remove the badge overlay from a tile. */
  removeBadge(tile: RemoteTile): void;

  /** Optional: self-reported health for the HUD / rehearsal diagnostics. */
  getDiagnostics?(): AdapterDiagnostics;

  /** Tear down all observers and overlays. */
  destroy(): void;
}
