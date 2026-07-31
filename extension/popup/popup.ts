// ---------------------------------------------------------------------------
// Extension shell — Popup UI logic.
//
// Pure UI + messaging. It sends commands to the content script (which owns all
// the real work) and renders whatever status it broadcasts back. No crypto or
// relay logic lives here.
// ---------------------------------------------------------------------------

import type { SessionSummary } from '../controller.js';
import type { ContentReply, PopupToContent, StatusBroadcast } from '../messages.js';
import type { TamperMode } from '../../core/index.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  notMeet: $('notMeet'),
  controls: $<HTMLElement>('controls'),
  session: $<HTMLInputElement>('session'),
  dice: $<HTMLButtonElement>('dice'),
  start: $<HTMLButtonElement>('start'),
  stop: $<HTMLButtonElement>('stop'),
  status: $('status'),
  connDot: $('connDot'),
  connText: $('connText'),
  fpr: $('fpr'),
  participants: $<HTMLUListElement>('participants'),
  empty: $('empty'),
  tamper: $('tamper'),
  tamperBtn: $<HTMLButtonElement>('tamperBtn'),
  restoreBtn: $<HTMLButtonElement>('restoreBtn'),
  tamperState: $('tamperState'),
  dTiles: $('dTiles'),
  dStream: $('dStream'),
  dSent: $('dSent'),
  dVerified: $('dVerified'),
  dNote: $('dNote'),
};

const WORDS = ['otter', 'blue', 'maple', 'nova', 'quartz', 'lark', 'ember', 'reef', 'juno', 'sage'];
function randomCode(): string {
  const a = WORDS[Math.floor(Math.random() * WORDS.length)];
  const b = WORDS[Math.floor(Math.random() * WORDS.length)];
  const n = Math.floor(Math.random() * 90) + 10;
  return `${a}-${b}-${n}`;
}

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function sendCmd(msg: PopupToContent): Promise<ContentReply | null> {
  const tabId = await activeTabId();
  if (tabId == null) return null;
  try {
    return (await chrome.tabs.sendMessage(tabId, msg)) as ContentReply;
  } catch {
    // No content script on this tab (not a Meet page, or not yet injected).
    return null;
  }
}

function render(reply: ContentReply | null): void {
  const onMeet = reply?.onMeet ?? false;
  el.notMeet.classList.toggle('vc-hidden', onMeet);

  const running = reply?.running ?? false;
  el.stop.classList.toggle('vc-hidden', !running);
  el.start.classList.toggle('vc-hidden', running);
  el.status.classList.toggle('vc-hidden', !running);
  el.tamper.classList.toggle('vc-hidden', !running);
  el.session.disabled = running;
  el.dice.disabled = running;

  if (reply?.summary) renderSummary(reply.summary);
}

function renderSummary(s: SessionSummary): void {
  el.connDot.className = 'vc-dot ' + (s.connected ? 'on' : 'off');
  el.connText.textContent = s.connected ? `Connected · ${s.session}` : 'Reconnecting…';
  el.fpr.textContent = s.localFingerprint ?? '—';

  el.participants.innerHTML = '';
  const remotes = s.participants;
  el.empty.classList.toggle('vc-hidden', remotes.length > 0);
  for (const p of remotes) {
    const li = document.createElement('li');
    const left = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'vc-pname';
    name.textContent = shortId(p.participantId);
    const meta = document.createElement('div');
    meta.className = 'vc-pmeta';
    meta.textContent = `${p.signatureCount} sig${p.signatureCount === 1 ? '' : 's'}${p.reason ? ' · ' + p.reason : ''}`;
    left.append(name, meta);

    const pill = document.createElement('span');
    pill.className = 'vc-pill ' + p.state;
    pill.textContent = p.state === 'stale' ? 'unverified' : p.state;

    li.append(left, pill);
    el.participants.appendChild(li);
  }

  // Diagnostics (rehearsal aid).
  const tiles = s.adapter?.remoteTilesFound ?? 0;
  const verified = s.participants.reduce((n, p) => n + p.signatureCount, 0);
  el.dTiles.textContent = String(tiles);
  el.dTiles.className = tiles === 0 ? 'warn' : '';
  const streamSrc = s.adapter?.localStreamSource ?? 'unknown';
  el.dStream.textContent = streamSrc;
  el.dStream.className = streamSrc === 'none' || streamSrc === 'unknown' ? 'warn' : '';
  el.dSent.textContent = String(s.framesSent);
  el.dVerified.textContent = String(verified);
  el.dNote.textContent = s.adapter?.note ?? '';

  const armed = s.tamperMode !== 'off';
  el.tamperBtn.classList.toggle('vc-hidden', armed);
  el.restoreBtn.classList.toggle('vc-hidden', !armed);
  el.tamperState.className = 'vc-tamper-state' + (armed ? ' armed' : '');
  el.tamperState.textContent = armed
    ? `Tampering active (${s.tamperMode}). The other side should see red.`
    : '';
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + '…' : id;
}

// --- wire up events --------------------------------------------------------

el.dice.addEventListener('click', () => {
  el.session.value = randomCode();
});

el.start.addEventListener('click', async () => {
  const session = el.session.value.trim();
  if (!session) {
    el.session.focus();
    return;
  }
  await chrome.storage.local.set({ vericallSession: session });
  const reply = await sendCmd({ type: 'vericall-cmd', cmd: 'start', session });
  render(reply);
});

el.stop.addEventListener('click', async () => {
  const reply = await sendCmd({ type: 'vericall-cmd', cmd: 'stop' });
  render(reply);
});

async function setTamper(mode: TamperMode): Promise<void> {
  const reply = await sendCmd({ type: 'vericall-cmd', cmd: 'setTamper', mode });
  render(reply);
}
el.tamperBtn.addEventListener('click', () => void setTamper('bad-signature'));
el.restoreBtn.addEventListener('click', () => void setTamper('off'));

// Live status pushes from the content script.
chrome.runtime.onMessage.addListener((raw) => {
  const msg = raw as StatusBroadcast;
  if (msg?.type === 'vericall-status') {
    render({ ok: true, onMeet: true, running: msg.running, summary: msg.summary });
  }
});

// Initial paint.
(async () => {
  const stored = await chrome.storage.local.get('vericallSession');
  if (stored.vericallSession) el.session.value = stored.vericallSession;
  else el.session.value = randomCode();
  const reply = await sendCmd({ type: 'vericall-cmd', cmd: 'getStatus' });
  render(reply);
})();
