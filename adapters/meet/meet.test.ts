// DOM-layer tests for the Meet adapter and badge overlay, run under jsdom so
// no real browser is needed. Proves the injection logic works: tiles are
// discovered, the self tile is excluded, badges render/update/remove, and tile
// removal is detected.
//
// Run: npm run test:dom
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// Install a jsdom environment as globals BEFORE importing the adapter modules.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://meet.google.com/abc-defg-hij',
});
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.location = dom.window.location;
g.MutationObserver = dom.window.MutationObserver;
g.getComputedStyle = dom.window.getComputedStyle;
g.HTMLElement = dom.window.HTMLElement;

const { MeetAdapter } = await import('./meetAdapter.js');
const { renderBadge, removeBadge } = await import('./badgeOverlay.js');

/** Build a participant tile with an "active" video element. */
function makeTile(id: string, opts: { self?: boolean; name?: string } = {}): HTMLElement {
  const tile = document.createElement('div');
  tile.setAttribute('data-participant-id', id);
  if (opts.name) {
    const label = document.createElement('span');
    label.textContent = opts.self ? `${opts.name} (You)` : opts.name;
    tile.appendChild(label);
  }
  if (opts.self) {
    const marker = document.createElement('div');
    marker.setAttribute('data-self-name', opts.name ?? 'me');
    tile.appendChild(marker);
  }
  const video = document.createElement('video');
  // jsdom videos are inert; fake an active stream so discoverTiles accepts it.
  Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
  Object.defineProperty(video, 'srcObject', { value: {}, configurable: true });
  tile.appendChild(video);
  return tile;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

test('renderBadge injects a badge with the right label and updates in place', () => {
  const tile = document.createElement('div');
  document.body.appendChild(tile);

  renderBadge(tile, 'verified', { signatureCount: 3 });
  let badge = tile.querySelector('[data-vericall-badge]')!;
  assert.ok(badge, 'badge exists');
  assert.equal(badge.getAttribute('data-state'), 'verified');
  assert.match(badge.textContent ?? '', /Verified live/);

  // Updating reuses the same node (no duplicate badges).
  renderBadge(tile, 'unverified', { reason: 'bad signature' });
  assert.equal(tile.querySelectorAll('[data-vericall-badge]').length, 1);
  badge = tile.querySelector('[data-vericall-badge]')!;
  assert.equal(badge.getAttribute('data-state'), 'unverified');
  assert.match(badge.textContent ?? '', /Unverified/);

  removeBadge(tile);
  assert.equal(tile.querySelector('[data-vericall-badge]'), null);
});

test('adapter reports remote tiles and excludes the local self tile', () => {
  document.body.appendChild(makeTile('remote-1', { name: 'Sam' }));
  document.body.appendChild(makeTile('me-99', { self: true, name: 'Me' }));

  const adapter = new MeetAdapter();
  assert.equal(adapter.isActive(), true);

  const seen: string[] = [];
  adapter.onRemoteTileAdded((t) => seen.push(t.participantId));

  assert.deepEqual(seen, ['remote-1'], 'only the remote tile is surfaced');
  adapter.destroy();
});

test('adapter fires removal when a tile disappears', async () => {
  const remote = makeTile('remote-2', { name: 'Alex' });
  document.body.appendChild(remote);

  const adapter = new MeetAdapter();
  const added: string[] = [];
  const removed: string[] = [];
  adapter.onRemoteTileAdded((t) => added.push(t.participantId));
  adapter.onRemoteTileRemoved((id) => removed.push(id));
  assert.deepEqual(added, ['remote-2']);

  remote.remove();
  // Trigger a rescan the way the MutationObserver would.
  adapter.onRemoteTileAdded(() => {}); // no-op subscribe re-runs scan()
  assert.deepEqual(removed, ['remote-2']);
  adapter.destroy();
});

test('adapter renders a badge onto the discovered tile element', () => {
  const remote = makeTile('remote-3', { name: 'Kai' });
  document.body.appendChild(remote);

  const adapter = new MeetAdapter();
  let captured: HTMLElement | null = null;
  adapter.onRemoteTileAdded((t) => {
    captured = t.element;
    adapter.renderBadge(t, 'verified');
  });
  assert.ok(captured);
  assert.ok(remote.querySelector('[data-vericall-badge]'), 'badge is on the tile');
  adapter.destroy();
});
