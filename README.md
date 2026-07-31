# VeriCall

A demo-grade prototype that proves a video-call participant is a **real, live
human** — not a deepfake, a pre-recorded clip, or an AI-generated face — using
**real, working cryptography**. It runs as a Chrome extension on **Google
Meet** and draws a live **Verified live / Unverified** badge on the other
participant's video tile.

---

## ⚠️ What this is, and what it is NOT

This MVP is a **software-only simulation** of the real product.

The eventual real product uses a hardware **secure element** chip inside a USB
dongle to sign video *as it is captured*, so that even a fully compromised
laptop cannot forge the signal. **That hardware does not exist yet.** This MVP
fakes the *hardware* part but uses genuine cryptography (ECDSA P-256 over the
Web Crypto API) for signing and verification.

**Therefore, honestly:**

- ✅ It proves: "the video frames I'm receiving were signed, in real time, by
  the holder of a specific key, and haven't been replayed or altered in transit."
- ❌ It does **not** protect against a genuinely malicious or compromised
  computer. The private key lives in ordinary browser memory, not in a hardware
  chip, so software on that machine could read the key or feed a fake camera.

Do not present this build as a hardened security product. It exists to test the
**product concept** and the **sales pitch**, with cryptography honest enough
that the demo proves exactly what it claims — no more, no less.

---

## How it works (one paragraph)

Two people join the same Google Meet call, each with this extension installed.
Each extension generates an ECDSA keypair in memory, exchanges public keys with
the other participant through a lightweight WebSocket **relay server** (matched
by a short **session code** the two of them share out-of-band, like a Meet
link), then continuously hashes and signs ~1 snapshot/second of its local
outgoing video. Those signed messages stream to the other participant over the
relay. Each extension verifies incoming messages — checking the **signature**,
that the **counter** strictly increases (anti-replay), and that the
**timestamp** is fresh (within 3s) — and overlays a badge on that person's tile:
green **"Verified live"** while signatures check out, red **"Unverified"** if a
check fails or frames go stale.

---

## Architecture — three cleanly separated layers

The single most important design goal is **"build once, add platforms later."**
Adding Zoom's web client, Teams' web client, or a standalone app must mean
writing one small new *adapter*, **without touching `core/`.**

```
vericall/
  core/                      # Layer 1 — platform-agnostic. NO DOM/Chrome APIs.
    crypto.ts                #   keygen, signing, verification, hashing
    frameSigner.ts           #   owns keypair + counter + tamper switch
    verificationState.ts     #   per-participant state machine + events
    relayClient.ts           #   talks to the relay server
    emitter.ts / types.ts    #   tiny event emitter, shared wire protocol
  adapters/
    platformAdapter.ts       # Layer 2 — THE extensibility contract (interface)
    meet/
      meetAdapter.ts         #   Google Meet implementation of that interface
      badgeOverlay.ts        #   pure-DOM badge rendering
    # zoom/, teams/, standaloneApp/  <- future adapters: same interface, no core changes
  extension/                 # Chrome MV3 shell (wires an adapter + core together)
    manifest.json
    background.ts            #   service worker — owns the relay WebSocket
    backgroundRelaySocket.ts #   WebSocket-shaped proxy: content script → worker
    contentScript.ts        #   runtime home of the live session
    controller.ts           #   Layer-5 glue: core + injected adapter
    statusHud.ts            #   always-visible on-page HUD (demo safety net)
    frameCapture.ts         #   browser-only MediaStream -> bytes helper
    popup/                  #   session code UI + "simulate tampering" + diagnostics
  server/                    # Layer 3 — relay server (pairs + forwards, crypto-blind)
    index.ts                 #   ws + /health endpoint
    Dockerfile / fly.toml    #   deploy the relay for the 2-machine demo
  render.yaml                # one-click relay deploy on Render
```

### Layer 1 — Core (`core/`)
Pure TypeScript, zero knowledge of Chrome/DOM/any platform. Keygen, signing,
verification, the per-participant verification state machine, and the relay
client all live here and are covered by unit tests that need **no browser**.

### Layer 2 — Platform adapter (`adapters/`)
[`adapters/platformAdapter.ts`](adapters/platformAdapter.ts) defines the only
seam between Core and a calling surface:

```ts
interface PlatformAdapter {
  getLocalVideoStream(): Promise<MediaStream>
  onRemoteTileAdded(cb): () => void
  onRemoteTileRemoved(cb): () => void
  renderBadge(tile, state): void
  // …
}
```

The Meet adapter's *only* jobs are: find the local camera feed, find remote
participant tiles in Meet's DOM, and draw the badge. **No signing, verifying, or
key exchange lives in an adapter.** To add a new platform you implement this one
interface — see the pointer comments in `platformAdapter.ts`.

### Layer 3 — Relay server (`server/`)
A minimal Node.js + `ws` server that does exactly two things: pair two
extensions that enter the same session code, and forward messages between them.
It is **crypto-blind** and platform-agnostic — it never inspects signatures and
has no idea whether a client is on Meet, Zoom, or anything else.

> **Design note — where each piece runs.** All orchestration and crypto
> (key exchange, signing, verification, badge state) live in the **content
> script**, which persists for the life of the Meet tab. But Meet is served over
> **HTTPS**, so a content script *cannot* open our `ws://localhost` relay
> connection — it's blocked as mixed content. So the **background service
> worker** owns the actual WebSocket, and the content script talks to it through
> a thin WebSocket-shaped proxy ([`backgroundRelaySocket.ts`](extension/backgroundRelaySocket.ts))
> over a `chrome.runtime` Port. Core's `RelayClient` is simply handed that proxy
> as its socket implementation, so it stays unaware of the split. Frames flow
> ~once per second, which keeps the worker's idle timer from expiring mid-call.

---

## Setup

Requires **Node 18+** (developed on Node 22).

```bash
npm install
npm run build        # bundles the extension into dist/
```

### 1. Run the relay server

**Local (both participants on the same machine / same LAN):**

```bash
npm run server       # ws://localhost:8787  (health: /health)
```

**Remote (two different machines — the realistic investor setup):** deploy the
relay so both laptops can reach it, then rebuild the extension pointing at it.

- **Render:** push this repo to GitHub → Render → *New → Blueprint* (uses the
  included [`render.yaml`](render.yaml)). You get a `wss://…onrender.com` URL.
- **Fly.io:** `fly launch --no-deploy --dockerfile server/Dockerfile --config server/fly.toml`
  then `fly deploy …` (uses [`server/Dockerfile`](server/Dockerfile) +
  [`server/fly.toml`](server/fly.toml)). You get `wss://<app>.fly.dev`.

Then bake that URL into the build (note **`wss://`**, not `ws://`, for a
deployed relay — the extension pages are secure contexts):

```bash
VERICALL_RELAY_URL=wss://your-relay.example.com npm run build
```

Confirm the relay is up by opening its `/health` URL in a browser — it returns
`VeriCall relay OK`.

### 2. Load the extension in Chrome

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the **`dist/`** folder.

---

## 🎬 Live-demo runbook

Two real participants are needed. Either **two Chrome profiles on one laptop**
(the `👤` menu top-right of Chrome creates/switches profiles) or **two laptops**
(with a deployed relay). Load the unpacked `dist/` extension in **each** Chrome
profile.

### The always-visible HUD (why this demo can't embarrass you)

When you click **Start verifying**, VeriCall injects a small draggable **HUD**
in the top-right of the Meet page showing the remote participant's live state —
big **Verified live** / **Unverified** — plus diagnostics. This is deliberate
insurance: even if Meet changes its DOM and the per-tile badge fails to attach,
**the green→red moment still happens on the HUD.** Present to the HUD and you
are never dependent on Meet's fragile markup.

### Run it

1. Start/point at the relay (see step 1 above).
2. **Profile A:** join a Google Meet call at `meet.google.com`, allow camera.
3. **Profile B:** join the **same** call, allow camera.
4. **Profile A:** click the VeriCall toolbar icon → 🎲 for a code (e.g.
   `otter-blue-42`) → **Start verifying**.
5. **Profile B:** open the popup, type the **same** code → **Start verifying**.
6. Within ~2s, each side shows green **Verified live** — on the other person's
   tile *and* in the HUD. (Click a tile badge for key fingerprint / last
   verified / signature count.)
7. **The money moment:** in **Profile A**, click **⚠️ Simulate tampering**.
   A stops sending valid signatures → **B's badge and HUD flip red
   ("Unverified") within ~2s.**
8. Click **✓ Restore honest signing** in A → B goes green again.

### Rehearse first (do this once before the real pitch)

Meet's DOM is the only fragile part, so validate it ahead of time:

- Open the popup's **Diagnostics** section (or read the HUD's diagnostics). Green
  means ready:
  - **Relay: connected**
  - **Remote tiles found: ≥ 1** — if `0`, the per-tile badge won't attach (the
    HUD still works). See troubleshooting.
  - **Local video: meet-self-view** (ideal) or **camera** (fallback) — not
    `none`.
  - **Frames sent** climbing, **Sigs verified** climbing on the other side.
- Do a full green→red→green cycle end-to-end at least once on the exact machines
  and network you'll use live.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| HUD green but **no badge on the tile** | Tile detection didn't match Meet's current DOM. Diagnostics shows **Remote tiles found: 0**. Present to the HUD; to fix badges, adjust `SELECTORS` at the top of [`meetAdapter.ts`](adapters/meet/meetAdapter.ts). |
| **Relay: reconnecting** | Relay not running / wrong URL. For a deployed relay it must be **`wss://`** and rebuilt into the extension (`VERICALL_RELAY_URL=… npm run build`). Check `/health`. |
| **Local video: none** | Camera not granted or busy. Grant camera in Meet; VeriCall prefers Meet's own self-view stream and falls back to opening the camera. |
| Both sides green but tamper **doesn't turn the other red** | Make sure you clicked tamper in the *other* profile than the screen you're watching — a side's badge reflects the *remote* peer. |
| Nothing happens after Start | Confirm both profiles entered the **same** session code and both are on a `meet.google.com` tab. |

> **The one fragile file:** all Meet-specific selectors live in `SELECTORS` at
> the top of [`adapters/meet/meetAdapter.ts`](adapters/meet/meetAdapter.ts). The
> adapter already tries the `data-participant-id` attribute first, then falls
> back to discovering active `<video>` elements and excluding the mirrored
> self-view. If Meet changes and badges stop attaching, that's the only place to
> look — and the HUD keeps the demo working meanwhile.

---

## Tests

No browser required — Core is tested in isolation, the relay is tested with real
clients, and the Meet adapter's DOM logic is tested under jsdom.

```bash
npm test            # Core: sign/verify, tamper-rejection, replay-rejection, state machine
npm run test:relay  # Relay: pairing, forwarding, session isolation, capacity
npm run test:dom    # Meet adapter + badge overlay under jsdom
npm run test:all    # all of the above
npm run typecheck   # tsc --noEmit
```

What the tests prove (mapping to the brief):

- **Sign then verify succeeds**, and tampering with any signed field fails.
- **Replay is rejected** two ways: a non-increasing counter, and an old (but
  validly signed) timestamp.
- The **state machine** transitions verified → stale on silence, emits
  state-change events only on real changes, and rejects future timestamps.
- The **relay** pairs two clients, forwards public keys and signed frames,
  isolates separate sessions, and caps a session at two participants.

---

## Adding another platform later (the whole point)

1. Create `adapters/zoom/zoomAdapter.ts` implementing `PlatformAdapter`.
2. In the extension shell, instantiate `ZoomAdapter` instead of `MeetAdapter`
   and pass it to `VeriCallController` — **nothing in `core/` changes.**
3. Add Zoom's host to `manifest.json` `content_scripts` / `host_permissions`.

The signing, verification, counter/timestamp anti-replay logic, relay protocol,
and badge state machine are all reused unchanged.
# Vericall
