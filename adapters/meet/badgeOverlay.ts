// ---------------------------------------------------------------------------
// Layer 2 (Meet adapter) — Badge overlay rendering.
//
// Pure DOM: given a tile element and a verification state, draw/update a small
// badge pinned to the corner of the tile. No crypto, no relay — just pixels.
// Kept separate from meetAdapter.ts so the "how the badge looks" concern is
// isolated and easy to restyle.
// ---------------------------------------------------------------------------

import type { VerificationState } from '../../core/types.js';
import type { BadgeDetail } from '../platformAdapter.js';

const BADGE_ATTR = 'data-vericall-badge';
const STYLE_ID = 'vericall-badge-style';

interface BadgeLook {
  label: string;
  bg: string;
  fg: string;
  icon: string; // inline SVG
}

const SHIELD_CHECK = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>`;
const WARNING = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.6L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.6a2 2 0 00-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
const QUESTION = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 015 0c0 1.7-2.5 2-2.5 4"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

const LOOKS: Record<VerificationState, BadgeLook> = {
  verified: { label: 'Verified live', bg: 'rgba(6,95,70,0.95)', fg: '#d1fae5', icon: SHIELD_CHECK },
  unverified: { label: 'Unverified', bg: 'rgba(127,29,29,0.95)', fg: '#fee2e2', icon: WARNING },
  stale: { label: 'Unverified', bg: 'rgba(127,29,29,0.95)', fg: '#fee2e2', icon: WARNING },
  unknown: { label: 'Waiting…', bg: 'rgba(30,41,59,0.9)', fg: '#e2e8f0', icon: QUESTION },
};

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [${BADGE_ATTR}] {
      position: absolute; top: 8px; left: 8px; z-index: 2147483000;
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 9px; border-radius: 9999px;
      font: 600 12px/1 'Google Sans', Roboto, system-ui, sans-serif;
      color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.35);
      cursor: pointer; user-select: none; pointer-events: auto;
      backdrop-filter: blur(2px); transition: background .2s ease;
    }
    [${BADGE_ATTR}] .vc-dot { width:7px; height:7px; border-radius:50%; background: currentColor; }
    [${BADGE_ATTR}][data-state="verified"] .vc-dot { animation: vc-pulse 1.6s ease-in-out infinite; }
    @keyframes vc-pulse { 0%,100%{opacity:1;} 50%{opacity:.35;} }
    [${BADGE_ATTR}] .vc-panel {
      position:absolute; top: calc(100% + 6px); left:0; min-width: 210px;
      background: rgba(17,24,39,0.98); color:#e5e7eb; border-radius:10px;
      padding:10px 12px; font-weight:500; line-height:1.5;
      box-shadow:0 8px 24px rgba(0,0,0,.5); display:none; cursor:default;
    }
    [${BADGE_ATTR}].vc-open .vc-panel { display:block; }
    [${BADGE_ATTR}] .vc-panel b { color:#fff; font-weight:600; }
    [${BADGE_ATTR}] .vc-panel code { font-family: ui-monospace, monospace; font-size:11px; word-break:break-all; }
  `;
  document.head.appendChild(style);
}

/** The tile must be a positioning context so the absolute badge anchors to it. */
function ensurePositioned(tile: HTMLElement): void {
  const pos = getComputedStyle(tile).position;
  if (pos === 'static' || pos === '') tile.style.position = 'relative';
}

export function renderBadge(
  tile: HTMLElement,
  state: VerificationState,
  detail: BadgeDetail = {},
): void {
  ensureStyles();
  ensurePositioned(tile);

  let badge = tile.querySelector<HTMLElement>(`:scope > [${BADGE_ATTR}]`);
  if (!badge) {
    badge = document.createElement('div');
    badge.setAttribute(BADGE_ATTR, '');
    badge.addEventListener('click', (e) => {
      // Toggle the detail panel (nice-to-have #7), but not when clicking inside it.
      if ((e.target as HTMLElement).closest('.vc-panel')) return;
      badge!.classList.toggle('vc-open');
    });
    tile.appendChild(badge);
  }

  const look = LOOKS[state];
  badge.dataset.state = state;
  badge.style.background = look.bg;
  badge.style.color = look.fg;

  const panel = renderPanel(state, detail);
  badge.innerHTML =
    `<span class="vc-dot"></span>${look.icon}<span class="vc-label">${look.label}</span>` + panel;
}

function renderPanel(state: VerificationState, detail: BadgeDetail): string {
  const rows: string[] = [];
  if (detail.displayName) rows.push(`<div><b>${escapeHtml(detail.displayName)}</b></div>`);
  rows.push(`<div>Status: <b>${state}</b></div>`);
  if (detail.reason) rows.push(`<div>Note: ${escapeHtml(detail.reason)}</div>`);
  if (detail.fingerprint) rows.push(`<div>Key: <code>${escapeHtml(detail.fingerprint)}</code></div>`);
  if (typeof detail.signatureCount === 'number')
    rows.push(`<div>Signatures verified: <b>${detail.signatureCount}</b></div>`);
  if (detail.lastVerifiedAt)
    rows.push(`<div>Last verified: ${new Date(detail.lastVerifiedAt).toLocaleTimeString()}</div>`);
  return `<div class="vc-panel">${rows.join('')}</div>`;
}

export function removeBadge(tile: HTMLElement): void {
  tile.querySelector(`:scope > [${BADGE_ATTR}]`)?.remove();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
