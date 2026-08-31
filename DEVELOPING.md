# Developing Aurora

The developer guide: how to build, run, and work on Aurora. The
[README](README.md) is the user-facing tour of what Aurora does; this file is for
people editing the code. For the design and the rules that keep it coherent, read
[ARCHITECTURE.md](ARCHITECTURE.md) after this.

Aurora is a single-page, vanilla-TypeScript + Vite app. There is no framework and no
build magic beyond Vite: `tsc` typechecks, Vite bundles, and that is the whole
toolchain.

## Prerequisites

- **Node.js.** Use the version in [`.nvmrc`](.nvmrc) (Node 22). With
  [nvm](https://github.com/nvm-sh/nvm): `nvm use` in the repo root. The `engines`
  field in `package.json` accepts Node 18 / 20 / 22 (the versions Vite 5 supports),
  but 22 is what development happens on.
- **npm** (ships with Node). No global tooling to install.
- **A browser.** Chrome or Edge. Aurora leans on modern web APIs (WebCodecs,
  AudioWorklet, CSS 3D); it is not tested on Firefox/Safari.
- **A running DAWN** to connect to, OR nothing at all if you develop against the
  built-in fake data (see [Develop without DAWN](#develop-without-a-live-dawn)).

## Getting started

```
nvm use            # or make sure you are on Node 22
npm install
npm run dev        # https://localhost:5273
```

Open `https://localhost:5273` and accept the self-signed certificate once (see
[Certificates and secure context](#certificates-and-secure-context) for why it is
HTTPS). Log in with your DAWN username and password.

## The dev loop

| Command | What it does |
|---------|--------------|
| `npm run dev` | Vite dev server with hot-module reload at `https://localhost:5273`. Edit a file, the browser updates. |
| `npm run typecheck` | `tsc --noEmit`. The fast correctness check. Run this constantly. |
| `npm run build` | `tsc` (full typecheck) then `vite build` to a static bundle in `dist/`. |
| `npm run preview` | Serve the built `dist/` bundle locally to sanity-check a production build. |

There is **no unit-test suite**. The safety net is two things, and you are expected
to use both:

1. **Strict TypeScript.** `tsconfig.json` runs `strict`, `noUnusedLocals`, and
   `noUnusedParameters`. This is not incidental: the render seam (see
   ARCHITECTURE.md) is *enforced by the type system*. "Logic touched a pixel" is a
   compile error, not a code-review nit. Run `npm run typecheck` after every change;
   a green typecheck is the first gate.
2. **Browser verification.** Because there are no tests, you verify behavior by
   running it. Keep `npm run dev` open and exercise the actual feature in the
   browser. For anything touching audio, the reactor, or layout, a visual check is
   the only check.

If you add a real test runner later, wire it into a `test` script and update this
list.

## Develop without a live DAWN

The single most useful fact for UI work: Aurora can run against **fake data** with no
DAWN at all.

`ingest` is the only boundary to DAWN. `DawnIngest` (`src/ingest/dawn-ws.ts`) is the
real WebSocket client; `StubIngest` (`src/ingest/stub.ts`) emits canned data into the
same sinks. They are interchangeable, so swapping is one line in
[`src/main.ts`](src/main.ts):

```
// import { DawnIngest } from "./ingest/dawn-ws.ts";
import { StubIngest } from "./ingest/stub.ts";

// const dawn = new DawnIngest();
const dawn = new StubIngest();
```

With `StubIngest` you get the reactor, the store-backed ambient panels, and the
choreography seam driven by fake spikes, with no login and no daemon. It is the
fastest way to work on rendering, the seam, and the store/choreography path (which
the live DAWN path does not even exercise; see the notification note in
ARCHITECTURE.md). **Revert the swap before committing.**

## Pointing at a DAWN instance

The dev server proxies `/api`, `/ws`, and `/music-ws` to DAWN so the browser talks to
a single origin (`localhost:5273`). This is not a convenience; it is required, so the
HttpOnly `dawn_session` cookie rides the `/ws` handshake (cross-origin does not work).

Point it at your daemon by editing **`DAWN_TARGET`** in
[`vite.config.ts`](vite.config.ts) (default `https://localhost:3000`). The dedicated
music-stream target is derived from it (main port + 1), so there is one place to
edit. Accept DAWN's own self-signed cert once by visiting `https://localhost:3000`
directly.

DAWN is the canonical wire reference. Its `docs/WEBSOCKET_PROTOCOL.md` (and the
consumer-facing [`docs/DAWN_UI_SIGNAL_MAP.md`](docs/DAWN_UI_SIGNAL_MAP.md) here)
describe every frame. When a payload shape matters, read the actual DAWN C source in
`../dawn`; the docs have had gaps.

## Certificates and secure context

The dev server runs over **HTTPS** with an auto-generated self-signed cert
(`@vitejs/plugin-basic-ssl`). This is load-bearing, not cosmetic: the music player
decodes audio with WebCodecs + AudioWorklet, which browsers only allow in a **secure
context**. `localhost` counts as secure over plain http, but a network origin
(`http://<ip>:5273`) does not, so music silently fails to decode there. HTTPS fixes
it everywhere.

- Accept the self-signed cert **once per browser** for both Aurora (`:5273`) and DAWN
  (`:3000`).
- Testing from another machine (a wall display, a laptop): use the `https://<ip>:5273`
  URL, not `http://`, or music will not play.
- If you drive the browser with automation tooling, load Aurora from the machine's
  **LAN IP**, not `localhost` (a `localhost` cert interstitial can block the
  extension).

## Gotchas that cost real time

The full list lives in [CLAUDE.md](CLAUDE.md) ("Non-obvious gotchas"). The ones a
developer hits first:

- **The `dawn-1.0` subprotocol is mandatory and fails silently.** Omit it on the
  WebSocket and libwebsockets routes you to the HTTP handler: the socket opens, sends
  succeed, and every frame is dropped with no error and no log. `DawnIngest` already
  sets it; do not remove it.
- **The WS upgrade is Origin-checked.** Dev works only because `https://localhost:5273`
  is in DAWN's `[webui] allowed_origins`. In production Aurora must be served
  **same-origin with DAWN** (a reverse proxy in front of `:3000`) or its real origin
  added to `allowed_origins`, or the WebSocket never connects (the only clue is a
  `CSRF: Origin mismatch` line in DAWN's log).
- **Music proxies at `/music-ws`, not `/ws-music`.** The broader `/ws` proxy prefix
  would capture `/ws-music` and misroute it to the main server, which does not speak
  the `dawn-music` protocol.
- **Session reuse.** Every `init` mints a new session and DAWN caps at 8. The client
  stores the session token and reconnects rather than re-initing. Do not "simplify"
  that away.

## Project layout

`ingest -> state -> choreography -> render`, downward dependencies only. Read
[ARCHITECTURE.md](ARCHITECTURE.md) for the four layers and the render seam; that is
the document that explains *why* the code is shaped the way it is. In brief:

```
src/
  main.ts          composition root: wires the layers, runs the one frame loop
  design/tokens.ts palette + feel + type scale (single source of truth for color)
  ingest/          the DAWN boundary (Ingest, DawnIngest, StubIngest, sinks)
  state/           Store + ElementState (importance; spike-then-recede)
  choreography/    importance -> depth / presence
  render/          the css3d renderer, the RenderNode contract, makeMovable
  anchor/          the Three.js reactor (the only WebGL)
  conversation/    the chat surface, tool pills, attachments, composer
  ...              per-view directories (music, calendar, homeassistant, watches, ...)
```

## Conventions (follow these; they are enforced or expected)

- **Three-space indentation.** Everywhere.
- **No em dashes in prose.** Use hyphens or restructure.
- **Colors come only from `src/design/tokens.ts`.** Never hardcode a color in a
  component; use or add a token (it is mirrored to CSS custom properties). This is a
  hard rule, not a preference.
- **Never breach the render seam.** Logic (ingest / state / choreography) writes
  abstract coordinates through `RenderNode`; only `src/render/` knows pixels or CSS.
  A visual property on a state or choreography type breaks the spine of the design
  (and strict `tsc` will usually catch it).
- **Read-mostly.** Aurora reflects DAWN; it does not add control paths that could
  depower the daemon. Writes are limited to a specific sanctioned set (chat submit,
  model selection, music transport, voice input, the conversation-picker and watch
  verbs, ...). If a feature needs a new write to DAWN, that is a deliberate design
  decision, not a casual addition; see the charter in CLAUDE.md / ARCHITECTURE.md.

## Where to read next

- [ARCHITECTURE.md](ARCHITECTURE.md) - the four-layer design and the render seam. Read
  this before making structural changes.
- [docs/DAWN_UI_SIGNAL_MAP.md](docs/DAWN_UI_SIGNAL_MAP.md) - which DAWN signals the UI
  consumes and what each drives.
- [CLAUDE.md](CLAUDE.md) - the project's technical direction and the full gotcha list
  (written for AI assistants, but every human contributor should skim it).
- [README.md](README.md) - the user-facing overview.
