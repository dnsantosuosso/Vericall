// ---------------------------------------------------------------------------
// Extension shell — Background service worker.
//
// Owns the actual relay WebSocket(s). Google Meet's HTTPS page can't open our
// ws:// relay from a content script (mixed content), so the content script's
// relay socket is a proxy (see backgroundRelaySocket.ts) that pipes through a
// Port to a real WebSocket opened here, in the extension context.
//
// The service worker stays alive while a call is active because the Port stays
// connected and frames flow ~once per second; Chrome resets the idle timer on
// that activity. Everything else (keys, signing, verification, orchestration)
// still lives in the content script.
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  console.log('[VeriCall] installed. Open a Google Meet call and click the toolbar icon.');
});

interface OpenMsg { type: 'open'; url: string }
interface SendMsg { type: 'send'; data: string }
interface CloseMsg { type: 'close' }
type PortMsg = OpenMsg | SendMsg | CloseMsg;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'vericall-relay') return;

  let ws: WebSocket | null = null;

  const safePost = (msg: unknown) => {
    try {
      port.postMessage(msg);
    } catch {
      /* content side went away */
    }
  };

  port.onMessage.addListener((raw) => {
    const msg = raw as PortMsg;
    if (msg.type === 'open') {
      try {
        ws = new WebSocket(msg.url);
      } catch {
        safePost({ type: 'error' });
        return;
      }
      ws.onopen = () => safePost({ type: 'open' });
      ws.onmessage = (ev) =>
        safePost({ type: 'message', data: typeof ev.data === 'string' ? ev.data : String(ev.data) });
      ws.onclose = () => safePost({ type: 'close' });
      ws.onerror = () => safePost({ type: 'error' });
    } else if (msg.type === 'send') {
      if (ws?.readyState === WebSocket.OPEN) ws.send(msg.data);
    } else if (msg.type === 'close') {
      ws?.close();
      ws = null;
    }
  });

  port.onDisconnect.addListener(() => {
    ws?.close();
    ws = null;
  });
});
