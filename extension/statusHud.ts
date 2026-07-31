// ---------------------------------------------------------------------------
// Extension shell — On-page status HUD (live-demo safety net).
//
// WHY: The per-tile badge depends on correctly locating a participant's tile in
// Meet's obfuscated, changeable DOM. If that ever misfires during a live
// investor demo, the whole point (green → red on tamper) would be invisible.
//
// This HUD is a fixed, draggable panel injected once into the page. It renders
// the SAME verification state independent of any tile lookup, so the demo's
// money moment is always on screen even in the worst DOM case. It also shows
// live diagnostics (relay, tiles found, frames sent/verified) so the operator
// can confirm everything is wired during rehearsal.
//
// Pure DOM. No crypto, no relay — it only renders a SessionSummary it's given.
// ---------------------------------------------------------------------------

import type { SessionSummary } from './controller.js';
import type { VerificationState } from '../core/index.js';

const HUD_ID = 'vericall-hud';
const STYLE_ID = 'vericall-hud-style';

const LABELS: Record<VerificationState | 'waiting', { text: string; cls: string; icon: string }> = {
  verified: { text: 'Verified live', cls: 'ok', icon: '🛡️' },
  unverified: { text: 'Unverified', cls: 'bad', icon: '⚠️' },
  stale: { text: 'Unverified — no live frames', cls: 'bad', icon: '⚠️' },
  unknown: { text: 'Waiting for signatures…', cls: 'wait', icon: '⏳' },
  waiting: { text: 'Waiting for the other participant…', cls: 'wait', icon: '⏳' },
};

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${HUD_ID} {
      position: fixed; top: 76px; right: 20px; z-index: 2147483000;
      width: 268px; border-radius: 14px; overflow: hidden;
      background: rgba(15,23,42,0.97); color: #e2e8f0;
      font: 13px/1.45 'Google Sans', Roboto, system-ui, sans-serif;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5); border: 1px solid rgba(148,163,184,0.2);
      backdrop-filter: blur(6px); user-select: none;
    }
    #${HUD_ID} .vc-hud-head {
      display:flex; align-items:center; gap:8px; padding:10px 12px; cursor:move;
      background: linear-gradient(135deg,#0d9488,#0f766e); color:#fff; font-weight:700;
    }
    #${HUD_ID} .vc-hud-head .sp { flex:1; }
    #${HUD_ID} .vc-hud-head button {
      all:unset; cursor:pointer; opacity:.85; font-size:14px; padding:0 4px; line-height:1;
    }
    #${HUD_ID} .vc-hud-head button:hover { opacity:1; }
    #${HUD_ID} .vc-hud-body { padding: 14px 12px; }
    #${HUD_ID}.min .vc-hud-body { display:none; }
    #${HUD_ID} .vc-state {
      display:flex; align-items:center; gap:10px; padding:12px; border-radius:10px;
      font-weight:800; font-size:15px; letter-spacing:.01em; transition: background .25s, color .25s;
    }
    #${HUD_ID} .vc-state .em { font-size:20px; }
    #${HUD_ID} .vc-state.ok  { background:#064e3b; color:#6ee7b7; }
    #${HUD_ID} .vc-state.bad { background:#7f1d1d; color:#fecaca; animation: vc-flash .6s ease; }
    #${HUD_ID} .vc-state.wait{ background:#1e293b; color:#cbd5e1; }
    @keyframes vc-flash { 0%{ background:#dc2626; } 100%{ background:#7f1d1d; } }
    #${HUD_ID} .vc-sub { margin-top:8px; font-size:11.5px; color:#94a3b8; }
    #${HUD_ID} .vc-sub b { color:#e2e8f0; font-weight:600; }
    #${HUD_ID} .vc-tamper {
      margin-top:10px; padding:8px 10px; border-radius:8px; font-size:11.5px; font-weight:700;
      background:#7c2d12; color:#fed7aa;
    }
    #${HUD_ID} .vc-diag {
      margin-top:10px; border-top:1px solid rgba(148,163,184,0.18); padding-top:8px;
      font-size:11px; color:#94a3b8;
    }
    #${HUD_ID} .vc-diag .row { display:flex; justify-content:space-between; gap:8px; padding:1px 0; }
    #${HUD_ID} .vc-diag .row b { color:#cbd5e1; font-weight:600; }
    #${HUD_ID} .vc-diag .warn { color:#fca5a5; }
    #${HUD_ID} .dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
    #${HUD_ID} .dot.on { background:#34d399; } #${HUD_ID} .dot.off { background:#f87171; }
  `;
  document.head.appendChild(style);
}

let dragCleanup: (() => void) | null = null;

export function mountHud(): void {
  ensureStyles();
  if (document.getElementById(HUD_ID)) return;

  const hud = document.createElement('div');
  hud.id = HUD_ID;
  hud.innerHTML = `
    <div class="vc-hud-head">
      <span>🛡️ VeriCall</span><span class="sp"></span>
      <button data-act="min" title="Minimise">▁</button>
      <button data-act="close" title="Hide">✕</button>
    </div>
    <div class="vc-hud-body">
      <div class="vc-state wait"><span class="em">⏳</span><span class="txt">Starting…</span></div>
      <div class="vc-sub"></div>
      <div class="vc-tamper" style="display:none"></div>
      <div class="vc-diag"></div>
    </div>`;
  document.body.appendChild(hud);

  hud.querySelector('[data-act="min"]')!.addEventListener('click', () => hud.classList.toggle('min'));
  hud.querySelector('[data-act="close"]')!.addEventListener('click', () => hud.remove());
  makeDraggable(hud, hud.querySelector('.vc-hud-head')!);
}

export function updateHud(summary: SessionSummary | null): void {
  const hud = document.getElementById(HUD_ID);
  if (!hud || !summary) return;

  // In a 1:1 call there is a single remote; show its state (or "waiting").
  const remote = summary.participants[0];
  const key = (remote?.state ?? 'waiting') as VerificationState | 'waiting';
  const look = LABELS[key];

  const stateEl = hud.querySelector('.vc-state') as HTMLElement;
  const prevCls = stateEl.className;
  stateEl.className = `vc-state ${look.cls}`;
  // Re-trigger the flash animation only on an actual change into "bad".
  if (look.cls === 'bad' && !prevCls.includes('bad')) {
    stateEl.style.animation = 'none';
    void stateEl.offsetWidth;
    stateEl.style.animation = '';
  }
  (stateEl.querySelector('.em') as HTMLElement).textContent = look.icon;
  (stateEl.querySelector('.txt') as HTMLElement).textContent = look.text;

  const sub = hud.querySelector('.vc-sub') as HTMLElement;
  sub.innerHTML = remote?.reason ? `Note: ${escapeHtml(remote.reason)}` : `Session <b>${escapeHtml(summary.session)}</b>`;

  const tamper = hud.querySelector('.vc-tamper') as HTMLElement;
  if (summary.tamperMode !== 'off') {
    tamper.style.display = '';
    tamper.textContent = `⚠️ You are simulating tampering (${summary.tamperMode}) — the other side should see red.`;
  } else {
    tamper.style.display = 'none';
  }

  hud.querySelector('.vc-diag')!.innerHTML = renderDiag(summary);
}

function renderDiag(s: SessionSummary): string {
  const d = s.adapter;
  const tiles = d?.remoteTilesFound ?? 0;
  const verified = s.participants.reduce((n, p) => n + p.signatureCount, 0);
  const streamOk = d && d.localStreamSource !== 'none' && d.localStreamSource !== 'unknown';
  const rows = [
    row('Relay', `<span class="dot ${s.connected ? 'on' : 'off'}"></span> ${s.connected ? 'connected' : 'reconnecting'}`, !s.connected),
    row('Remote tiles found', String(tiles), tiles === 0),
    row('Local video', d?.localStreamSource ?? 'unknown', !streamOk),
    row('Frames sent', String(s.framesSent)),
    row('Sigs verified', String(verified)),
    row('Your key', s.localFingerprint ? `<code>${s.localFingerprint}</code>` : '—'),
  ];
  return rows.join('');
}

function row(label: string, value: string, warn = false): string {
  return `<div class="row"><span>${label}</span><b class="${warn ? 'warn' : ''}">${value}</b></div>`;
}

export function unmountHud(): void {
  document.getElementById(HUD_ID)?.remove();
  dragCleanup?.();
  dragCleanup = null;
}

function makeDraggable(el: HTMLElement, handle: HTMLElement): void {
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  const down = (e: MouseEvent) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    dragging = true;
    const r = el.getBoundingClientRect();
    ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
    el.style.right = 'auto';
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };
  const move = (e: MouseEvent) => {
    if (!dragging) return;
    el.style.left = `${ox + e.clientX - sx}px`;
    el.style.top = `${Math.max(0, oy + e.clientY - sy)}px`;
  };
  const up = () => {
    dragging = false;
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
  };
  handle.addEventListener('mousedown', down);
  dragCleanup = () => handle.removeEventListener('mousedown', down);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
