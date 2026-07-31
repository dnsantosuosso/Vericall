// ---------------------------------------------------------------------------
// Browser host helper — capture raw bytes from a MediaStream.
//
// Uses <video> + <canvas>, which are browser-only APIs, so this deliberately
// lives in the extension host layer, NOT in core/. It hands Core plain bytes;
// Core does the hashing and signing. Any web-based adapter can reuse this.
// ---------------------------------------------------------------------------

const CAPTURE_W = 160;
const CAPTURE_H = 120;

export class FrameCapturer {
  private readonly video = document.createElement('video');
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private ready = false;

  constructor(stream: MediaStream) {
    this.canvas.width = CAPTURE_W;
    this.canvas.height = CAPTURE_H;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;

    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = stream;
    void this.video.play().then(() => {
      this.ready = true;
    });
  }

  /**
   * Grab the current frame as raw RGBA bytes. Returns null if the video isn't
   * ready yet (caller should just skip that tick).
   */
  capture(): Uint8Array | null {
    if (!this.ready || this.video.videoWidth === 0) return null;
    this.ctx.drawImage(this.video, 0, 0, CAPTURE_W, CAPTURE_H);
    return new Uint8Array(this.ctx.getImageData(0, 0, CAPTURE_W, CAPTURE_H).data.buffer);
  }

  stop(): void {
    this.video.pause();
    this.video.srcObject = null;
    // Note: we do NOT stop the stream's tracks — we may not own them (the
    // stream can belong to Meet's own self-view).
  }
}
