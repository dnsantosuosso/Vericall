// ---------------------------------------------------------------------------
// Layer 2 (Meet adapter) — Google Meet implementation of PlatformAdapter.
//
// Responsibilities (and ONLY these):
//   1. getLocalVideoStream() — hand Core the local camera stream to snapshot.
//   2. onRemoteTileAdded / onRemoteTileRemoved — surface remote video tiles.
//   3. renderBadge / removeBadge — draw the overlay (delegated to badgeOverlay).
//
// There is deliberately NO crypto, relay, or verification logic in this file.
//
// ⚠️ Google Meet ships an obfuscated, frequently-changing DOM. The selectors
// below are best-effort and centralised in SELECTORS so that when Meet changes
// its markup you only edit one place. The strategy is: prefer Meet's
// `data-participant-id` attribute; fall back to wrapping raw <video> elements.
// ---------------------------------------------------------------------------

import type {
  AdapterDiagnostics,
  BadgeDetail,
  PlatformAdapter,
  RemoteTile,
} from '../platformAdapter.js';
import type { VerificationState } from '../../core/types.js';
import { removeBadge as removeBadgeEl, renderBadge as renderBadgeEl } from './badgeOverlay.js';

const SELECTORS = {
  // Meet wraps each participant in an element carrying their participant id.
  participantTile: '[data-participant-id]',
  // Heuristics for identifying the LOCAL user's own tile (to skip badging it).
  selfMarkers: ['[data-self-name]', '[data-is-local-participant]'],
};

let tileCounter = 0;

export class MeetAdapter implements PlatformAdapter {
  readonly platformName = 'Google Meet';

  private observer: MutationObserver | null = null;
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private localStreamSource: AdapterDiagnostics['localStreamSource'] = 'unknown';
  private readonly addedCbs = new Set<(tile: RemoteTile) => void>();
  private readonly removedCbs = new Set<(participantId: string) => void>();

  /** element -> tracked RemoteTile, so we can diff appear/disappear. */
  private readonly tracked = new WeakMap<HTMLElement, RemoteTile>();
  private readonly liveIds = new Set<string>();
  private readonly idToElement = new Map<string, HTMLElement>();

  isActive(): boolean {
    return location.hostname === 'meet.google.com';
  }

  // --- Local stream --------------------------------------------------------

  async getLocalVideoStream(): Promise<MediaStream> {
    // Preferred: read the self-view <video>'s existing MediaStream so we sign
    // exactly what Meet is sending. Falls back to opening the camera ourselves
    // (fine for a demo; the OS lets the camera be shared in practice).
    const selfStream = this.findSelfStream();
    if (selfStream) {
      this.localStreamSource = 'meet-self-view';
      return selfStream;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    this.localStreamSource = 'camera';
    return stream;
  }

  private findSelfStream(): MediaStream | null {
    const activeStream = (v: HTMLVideoElement | null | undefined): MediaStream | null => {
      const s = v && (v.srcObject as MediaStream | null);
      return s && s.getVideoTracks?.().length > 0 ? s : null;
    };

    // 1) Explicit self markers → the video inside that tile.
    for (const marker of SELECTORS.selfMarkers) {
      const selfTile = document.querySelector(marker)?.closest(SELECTORS.participantTile);
      const s = activeStream(selfTile?.querySelector('video'));
      if (s) return s;
    }
    // 2) Fallback: Meet mirrors the self-view, so a horizontally-flipped video
    //    is almost always the local one.
    for (const v of document.querySelectorAll('video')) {
      if (this.isMirrored(v)) {
        const s = activeStream(v);
        if (s) return s;
      }
    }
    return null;
  }

  /** True if the video is CSS-mirrored (Meet flips the local self-view). */
  private isMirrored(v: HTMLElement): boolean {
    const t = getComputedStyle(v).transform;
    // matrix(-1, 0, 0, 1, ...) or a scaleX(-1) → negative horizontal scale.
    return /matrix\(\s*-1/.test(t) || /matrix3d\(\s*-1/.test(t);
  }

  // --- Remote tiles --------------------------------------------------------

  onRemoteTileAdded(cb: (tile: RemoteTile) => void): () => void {
    this.addedCbs.add(cb);
    this.ensureWatching();
    // Replay tiles already tracked so late subscribers still get them. This
    // runs BEFORE scan() so a first-time subscriber isn't notified twice for a
    // tile discovered by that same scan.
    for (const el of this.idToElement.values()) {
      const tile = this.tracked.get(el);
      if (tile) cb(tile);
    }
    this.scan();
    return () => this.addedCbs.delete(cb);
  }

  onRemoteTileRemoved(cb: (participantId: string) => void): () => void {
    this.removedCbs.add(cb);
    this.ensureWatching();
    this.scan();
    return () => this.removedCbs.delete(cb);
  }

  private ensureWatching(): void {
    if (this.observer) return;
    this.observer = new MutationObserver(() => this.scan());
    this.observer.observe(document.body, { childList: true, subtree: true });
    // MutationObserver can miss srcObject changes on existing nodes, so also
    // poll on a slow interval as a safety net. The actual scan is driven by the
    // subscribe methods and these triggers, never synchronously here.
    this.scanInterval = setInterval(() => this.scan(), 1500);
  }

  private scan(): void {
    const seen = new Set<string>();

    for (const el of this.discoverTiles()) {
      const participantId = this.participantIdFor(el);
      if (!participantId) continue;
      seen.add(participantId);

      if (!this.tracked.has(el)) {
        const tile: RemoteTile = {
          participantId,
          element: el,
          displayName: this.displayNameFor(el),
        };
        this.tracked.set(el, tile);
        this.idToElement.set(participantId, el);
        this.liveIds.add(participantId);
        this.addedCbs.forEach((cb) => cb(tile));
      }
    }

    // Fire removals for ids that disappeared.
    for (const id of [...this.liveIds]) {
      if (!seen.has(id)) {
        this.liveIds.delete(id);
        this.idToElement.delete(id);
        this.removedCbs.forEach((cb) => cb(id));
      }
    }
  }

  /** Find candidate REMOTE participant tiles (excludes the local self tile). */
  private discoverTiles(): HTMLElement[] {
    const out: HTMLElement[] = [];

    // Primary strategy: Meet's per-participant tile attribute.
    const tiles = document.querySelectorAll<HTMLElement>(SELECTORS.participantTile);
    for (const el of tiles) {
      if (this.isSelfTile(el)) continue;
      const video = el.querySelector('video');
      // Only badge tiles that actually have an active video stream.
      if (video && (video.srcObject || video.readyState >= 2)) out.push(el);
    }
    if (out.length > 0) return out;

    // Fallback strategy: Meet changed its markup and dropped the attribute.
    // Discover by active <video> elements instead, wrapping each in its nearest
    // reasonably-sized container, and skip the mirrored (self) video.
    for (const video of document.querySelectorAll<HTMLVideoElement>('video')) {
      if (this.isMirrored(video)) continue;
      if (!(video.srcObject || video.readyState >= 2)) continue;
      const container = this.tileContainerFor(video);
      if (container && !out.includes(container)) out.push(container);
    }
    return out;
  }

  /** Walk up from a <video> to the nearest sensibly-sized tile container. */
  private tileContainerFor(video: HTMLElement): HTMLElement | null {
    let el: HTMLElement | null = video;
    for (let i = 0; i < 4 && el?.parentElement; i++) {
      el = el.parentElement;
      const r = el.getBoundingClientRect();
      if (r.width >= 120 && r.height >= 90) return el;
    }
    return video.parentElement;
  }

  private isSelfTile(el: HTMLElement): boolean {
    if (SELECTORS.selfMarkers.some((m) => el.querySelector(m))) return true;
    // Meet appends " (You)" to the local participant's name label.
    if (/\(you\)\s*$/i.test(el.textContent ?? '')) return true;
    // The self-view is mirrored; a mirrored video means this is the local tile.
    const video = el.querySelector('video');
    return !!video && this.isMirrored(video);
  }

  private participantIdFor(el: HTMLElement): string {
    const id = el.getAttribute('data-participant-id');
    if (id) return id;
    // Stable synthetic id if the attribute is ever missing.
    let synthetic = el.dataset.vericallId;
    if (!synthetic) {
      synthetic = `tile-${++tileCounter}`;
      el.dataset.vericallId = synthetic;
    }
    return synthetic;
  }

  private displayNameFor(el: HTMLElement): string | undefined {
    const raw = (el.textContent ?? '').replace(/\(you\)\s*$/i, '').trim();
    return raw ? raw.slice(0, 40) : undefined;
  }

  // --- Badge ---------------------------------------------------------------

  renderBadge(tile: RemoteTile, state: VerificationState, detail?: BadgeDetail): void {
    renderBadgeEl(tile.element, state, { displayName: tile.displayName, ...detail });
  }

  removeBadge(tile: RemoteTile): void {
    removeBadgeEl(tile.element);
  }

  // --- Diagnostics ---------------------------------------------------------

  getDiagnostics(): AdapterDiagnostics {
    const total = document.querySelectorAll(SELECTORS.participantTile).length;
    return {
      remoteTilesFound: this.liveIds.size,
      localStreamSource: this.localStreamSource,
      note:
        this.liveIds.size === 0 && total === 0
          ? 'No Meet tiles matched — check SELECTORS or use the HUD state'
          : undefined,
    };
  }

  // --- Teardown ------------------------------------------------------------

  destroy(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.scanInterval) clearInterval(this.scanInterval);
    this.scanInterval = null;
    this.addedCbs.clear();
    this.removedCbs.clear();
    for (const el of this.idToElement.values()) removeBadgeEl(el);
    this.idToElement.clear();
    this.liveIds.clear();
  }
}
