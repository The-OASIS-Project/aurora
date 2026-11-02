# Developing Aurora

The developer guide: how to build, run, and work on Aurora. The
[README](README.md) is the user-facing tour of what Aurora does; this file is for
people editing the code. For the design and the rules that keep it coherent, read
[ARCHITECTURE.md](ARCHITECTURE.md) after this.

Aurora is a single-page, vanilla-TypeScript + Vite app. There is no framework and no
build magic beyond Vite: `tsc` typechecks, Vite bundles, and that is the whole
toolchain.

## Prerequisites

- **Node.js.** Use the version in [`.nvmrc`](.nvmrc): the latest Node 22 LTS (`lts/jod`).
  With [nvm](https://github.com/nvm-sh/nvm): `nvm install` then `nvm use` in the repo root.
  The `engines` field asks for Node 22.22.2+, 24.15+ or 26+, what jsdom and Vitest need.
  Avoid Node 22.21.0 in particular: an HTTP/2 regression there crashes the HTTPS dev server
  on its first WebSocket (fixed in 22.21.1).
- **npm** (ships with Node). No global tooling to install.
- **A browser.** Chrome or Edge. Aurora leans on modern web APIs (WebCodecs,
  AudioWorklet, CSS 3D); it is not tested on Firefox/Safari.
- **A running DAWN** to connect to, OR nothing at all if you develop against the
  built-in fake data (see [Develop without DAWN](#develop-without-a-live-dawn)).

## Getting started

```
nvm install        # the Node in .nvmrc (latest 22 LTS), then: nvm use
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
| `npm test` | The unit tests (vitest), once. `npm run test:watch` re-runs them as you edit. |
| `npm run test:coverage` | The tests with V8 coverage: a summary in the terminal, the full report in `coverage/index.html`. |
| `npm run test:smoke` | The smoke test: the production build in headless Chromium against a fake DAWN (`tests/smoke/`). Run `npx playwright install chromium` once first. |
| `npm run lint` | ESLint (`eslint.config.js`): type-aware checks, HTML-sink safety, the architecture's layer rules. |
| `npm run format` | Prettier rewrites the code to the house style (`npm run format:check` only reports). |
| `npm run check:source` | The design rules a linter can't express (`scripts/check-source.mjs`). |
| `npm run check:fixtures` | The smoke test's fake-DAWN fixtures against DAWN itself (local; needs DAWN at `../dawn`). |

The safety net is four things, and you are expected to use all of them:

1. **Strict TypeScript.** `tsconfig.json` runs `strict`, `noUnusedLocals`, and
   `noUnusedParameters`. This is not incidental: the render seam (see
   ARCHITECTURE.md) is *enforced by the type system*. "Logic touched a pixel" is a
   compile error, not a code-review nit. Run `npm run typecheck` after every change;
   a green typecheck is the first gate.
2. **Unit tests.** `npm test` runs the vitest suite (`npm run test:watch` while you
   work). Tests sit next to the code they cover as `*.test.ts`; one that needs a DOM
   starts with `// @vitest-environment jsdom`. Logic with real state (the wire
   handling in `src/ingest/`, the time helpers, the panels' behaviour) gets tests,
   including hostile and edge-case input. Code that reads outside input (markdown,
   mail bodies, a visual's markup, DAWN's frames) also gets property tests
   (`*.property.test.ts`, [fast-check](https://fast-check.dev/)): an invariant that must
   hold for any input, tried against generated input from `src/test/hostile.ts`.
3. **The smoke test.** `npm run test:smoke` builds the production bundle (into `.smoke/`,
   never `dist/`), serves it, and loads it in headless Chromium against a fake DAWN
   (`tests/fake-dawn/`): canned replies in DAWN's own wire format, served to the real
   client. It checks that Aurora starts and stands up signed out, signed in (resuming the
   open conversation), against an older DAWN without feature flags, and against a newer
   protocol, and fails on any uncaught exception, console error, or request the fake
   doesn't expect. A new request the client sends needs a rule in
   `tests/fake-dawn/fake-dawn.ts`; a changed DAWN reply needs its fixture updated in
   `tests/fake-dawn/scenarios.ts`. Two things keep those fixtures honest:
   `src/ingest/fake-dawn-fixtures.test.ts` (part of `npm test`) runs each one through the
   real client and checks what it means there, and `npm run check:fixtures` (local, with
   DAWN checked out at `../dawn`) lists any name DAWN's protocol doc doesn't mention and
   the DAWN commits since the fixtures were last checked. Design:
   [docs/FAKE_DAWN_PLAN.md](docs/FAKE_DAWN_PLAN.md).
4. **Browser verification.** Keep `npm run dev` open and exercise the actual feature
   in the browser. For anything touching audio, the reactor, or layout, a visual
   check is the only check.

CI runs the format check, the typecheck, the lint, the source checks, the tests, the
build and the smoke test on every push and pull request, plus CodeQL and an audit of the runtime
dependencies (`.github/workflows/`). Pushes to `main` also run the tests with coverage:
the summary is on the run's page and the HTML report is an artifact. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how a change gets into `main`.

## Develop without a live DAWN

`ingest` is the only boundary to DAWN, and `DawnIngest` (`src/ingest/dawn-ws.ts`) is the
real WebSocket client. The older way to work without a daemon, swapping in `StubIngest`
(`src/ingest/stub.ts`, a second client that emits canned data), no longer builds: the real
client has long outgrown it. It is being replaced by a fake DAWN that the real client talks
to (`tests/fake-dawn/`), so offline work exercises the same login, resume and frame
handling a real DAWN does. The smoke test uses it today; a dev server on it
(`npm run dev:fake`) is the next step ([docs/FAKE_DAWN_PLAN.md](docs/FAKE_DAWN_PLAN.md)).
Until then, UI work runs against a DAWN instance (below).

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
