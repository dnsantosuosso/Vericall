// ---------------------------------------------------------------------------
// Extension shell — Content script (runs inside meet.google.com).
//
// This is the runtime home for the live session: it owns the PlatformAdapter
// and the VeriCallController (which in turn owns all Core crypto + relay). We
// keep this here, rather than in the service worker, because MV3 service
// workers are frequently killed while idle — which would drop a long-lived
// WebSocket and the signing loop mid-call. The content script lives as long as
// the Meet tab is open, so the demo stays reliable. The service worker
// (background.ts) is kept thin on purpose.
//
// It exposes a tiny command surface to the popup via chrome.runtime messaging.
// ---------------------------------------------------------------------------

import { MeetAdapter } from '../adapters/meet/meetAdapter.js';
import { VeriCallController, type SessionSummary } from './controller.js';
import { BackgroundRelaySocket } from './backgroundRelaySocket.js';
import { mountHud, unmountHud, updateHud } from './statusHud.js';
import type { ContentReply, PopupToContent, StatusBroadcast } from './messages.js';

// Build-time relay URL (see build.mjs `define`).
declare const process: { env: { VERICALL_RELAY_URL: string } };
const RELAY_URL = process.env.VERICALL_RELAY_URL;

let controller: VeriCallController | null = null;
let lastSummary: SessionSummary | null = null;

const adapter = new MeetAdapter();

function broadcast(summary: SessionSummary | null): void {
  lastSummary = summary;
  updateHud(summary); // always-visible on-page safety net
  const msg: StatusBroadcast = { type: 'vericall-status', running: !!controller, summary };
  // Popup may be closed; ignore "no receiver" errors.
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function startSession(session: string): Promise<void> {
  if (controller) controller.stop();
  mountHud();
  const participantId =
    (crypto as Crypto).randomUUID?.() ?? `p-${Math.random().toString(36).slice(2)}`;

  controller = new VeriCallController(adapter, {
    relayUrl: RELAY_URL,
    session,
    participantId,
    // Route the socket through the background worker (see backgroundRelaySocket).
    relaySocketImpl: BackgroundRelaySocket as unknown as typeof WebSocket,
    onStatus: (summary) => broadcast(summary),
  });
  await controller.start();
  await chrome.storage.local.set({ vericallSession: session, vericallRunning: true });
}

function stopSession(): void {
  controller?.stop();
  controller = null;
  unmountHud();
  void chrome.storage.local.set({ vericallRunning: false });
  broadcast(null);
}

function currentReply(ok: boolean, error?: string): ContentReply {
  return {
    ok,
    onMeet: adapter.isActive(),
    running: !!controller,
    summary: lastSummary,
    error,
  };
}

chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  const msg = raw as PopupToContent;
  if (msg?.type !== 'vericall-cmd') return;

  (async () => {
    try {
      switch (msg.cmd) {
        case 'start':
          await startSession(msg.session);
          break;
        case 'stop':
          stopSession();
          break;
        case 'setTamper':
          controller?.setTamperMode(msg.mode);
          break;
        case 'getStatus':
          break;
      }
      sendResponse(currentReply(true));
    } catch (err) {
      sendResponse(currentReply(false, err instanceof Error ? err.message : String(err)));
    }
  })();

  return true; // keep the message channel open for the async response
});

console.log('[VeriCall] content script ready on', location.host, '(relay', RELAY_URL + ')');
