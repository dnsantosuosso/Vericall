// ---------------------------------------------------------------------------
// Extension shell — Background relay socket (WebSocket proxy).
//
// WHY THIS EXISTS: Google Meet is served over HTTPS. A content script running
// in that page CANNOT open our `ws://localhost:8787` relay connection — it is
// blocked as mixed content (and content-script cross-origin requests are
// subject to the page). Only the extension's background service worker (an
// chrome-extension:// context) may open the socket.
//
// So we keep ALL orchestration + crypto in the content script (hashing/signing
// are local compute, not network — no CSP problem) and move ONLY the socket to
// the background. This class presents the exact WebSocket surface that
// core/RelayClient expects, but forwards every operation to the background over
// a long-lived Port. RelayClient is constructed with this as its WebSocketImpl,
// so Core stays completely unaware of the split.
// ---------------------------------------------------------------------------

/** Messages content → background over the port. */
type ToBg =
  | { type: 'open'; url: string }
  | { type: 'send'; data: string }
  | { type: 'close' };

/** Messages background → content over the port. */
type FromBg =
  | { type: 'open' }
  | { type: 'message'; data: string }
  | { type: 'close' }
  | { type: 'error' };

export class BackgroundRelaySocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = BackgroundRelaySocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  private readonly port: chrome.runtime.Port;

  constructor(url: string) {
    this.port = chrome.runtime.connect({ name: 'vericall-relay' });

    this.port.onMessage.addListener((raw) => {
      const msg = raw as FromBg;
      switch (msg.type) {
        case 'open':
          this.readyState = BackgroundRelaySocket.OPEN;
          this.onopen?.();
          break;
        case 'message':
          this.onmessage?.({ data: msg.data });
          break;
        case 'close':
          this.markClosed();
          break;
        case 'error':
          this.onerror?.();
          break;
      }
    });

    this.port.onDisconnect.addListener(() => this.markClosed());
    this.post({ type: 'open', url });
  }

  send(data: string): void {
    this.post({ type: 'send', data });
  }

  close(): void {
    this.post({ type: 'close' });
    try {
      this.port.disconnect();
    } catch {
      /* already gone */
    }
    this.markClosed();
  }

  private markClosed(): void {
    if (this.readyState === BackgroundRelaySocket.CLOSED) return;
    this.readyState = BackgroundRelaySocket.CLOSED;
    this.onclose?.();
  }

  private post(msg: ToBg): void {
    try {
      this.port.postMessage(msg);
    } catch {
      this.onerror?.();
    }
  }
}
