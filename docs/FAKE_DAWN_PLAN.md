# A fake DAWN for tests and offline development

Status: plan (2026-11-02), revised after a plan review. Phases 1 and 2a built; 2b and 3 follow.

## Why

Aurora needs to run without a real DAWN in two places: a **smoke test in CI** (does the bundle that
ships start and stand up?) and **offline UI work** (developing a panel without a daemon). Today the
only offline path is `StubIngest` (`src/ingest/stub.ts`), a second implementation of the DAWN client
that emits canned data into the sinks. It has rotted: `main.ts` now calls about 25 `DawnIngest`
methods, 21 of which the stub doesn't have, so the "one-line swap" in DEVELOPING.md no longer
compiles.

That drift is structural, not an accident. A hand-written second client has to be kept in step with
the real one by hand, forever, and nothing enforces it. Worse, UI built against it never exercises
the real client (login, resume, reconnect, frame parsing, feature flags), which is where most of
Aurora's bugs have been.

## Decision

Replace the second client with **one fake DAWN at the protocol level**: canned HTTP replies and
WebSocket frames, in DAWN's own wire format, served to the **real** `DawnIngest`. One implementation
of the DAWN boundary exists (the real one); the fake stands in for the daemon, not for Aurora.

- It stays honest: the fixtures are DAWN frames, checkable against `WEBSOCKET_PROTOCOL.md` and the
  signal map, and each one is round-tripped through the real client in a unit test.
- One fake serves every use: a transport-agnostic core with thin adapters (Playwright for the smoke
  test, a Node server for offline dev).

## Design

### Layout

The fake lives outside `src/`, so Vitest, coverage, `check-source` and the app's ESLint layer rules
never mistake it for app code:

```
tests/
  fake-dawn/        the core: scenarios, fixtures, request manifest (no Playwright, no Node APIs)
  smoke/            Playwright specs + the Playwright adapter
playwright.config.ts
```

`tests/tsconfig.json` types `tests/**` (Node plus the DOM, for code that runs in the page), the root
`npm run typecheck` includes it, and ESLint lints it with the repo rules (no app layer rules).

### The core (`FakeDawn`)

A scenario is data plus small handlers, independent of transport:

- **HTTP**: replies by **pathname** (only `/api/auth/status` in phase 1), never a glob, because
  `?app=aurora` tags every URL. Each request is checked for the tag: present when the scenario
  advertises `app_logins`, absent otherwise (only the first status ask may go untagged, since it
  learns the flags). With `app_logins` the untagged status answer is the WebUI's login, which the
  scenarios leave signed out, and the socket may open only after a tagged ask, so a client that
  trusts the wrong answer fails. An `/api/*` path with no reply fails the test.
- **WebSocket**: the fake waits for the client's `init`/`reconnect`, then sends DAWN's real connect order: `session` → `config` → `server_features` →
  `state`. Every later client frame is classified by the **request manifest**:
  - **answered**: the scenario has a reply (the core boot verbs: `get_config`, `get_my_settings`,
    `list_llm_models`, `list_conversations`, `load_conversation` / `set_active_conversation`,
    `jobs_request`, `music_subscribe`, `get_metrics`, `ping` → `pong {seq}`, and the always-built
    `watch_list`, `watch_readings_subscribe` and `doc_library_list`, answered empty);
  - **silent**: taken without a reply, as DAWN does (`phone_status` with no call live);
  - **optional**: the exact verbs of a subsystem DAWN can be built without (Home Assistant and the
    calendar in phase 1); answered with DAWN's real `error UNKNOWN_TYPE` echoing `request_type` and
    the payload's `req` (when short, clean text, as DAWN does), which the client handles quietly;
  - **unexpected**: anything else fails the test, so a new client request forces a decision.

  An `UNKNOWN_TYPE` for a core verb would put a visible "This DAWN doesn't handle..." card on
  screen, which is why core verbs are answered, never defaulted.
- **Subprotocol**: the socket route passes the subprotocols the page asked for, and the fake checks
  that `/ws` asked for `dawn-1.0`.
- **Frame log**: every frame in and out, attached to the test report.
- **Fixture provenance**: each fixture records the DAWN source or doc it was copied from and the
  date. Dates inside fixtures are computed relative to now, so "today" views stay populated.

### Scenarios (phase 1)

- `signedOut`: status `authenticated:false` with `protocol` and `features`; no socket. Expect the
  login card.
- `signedIn`: status `authenticated:true`; localStorage seeded via `addInitScript` with
  `dawn.hero.lastUser` (so no first-login wipe-and-reload) and `dawn.hero.convId` (so the
  transcript is requested: the F5-resume path). Expect the Linked chip, the menubar, the
  transcript with rendered markdown (heading text, a link with its `href`, a code block), and the
  reactor.
- `legacyDawn`: an older DAWN, no `features` anywhere. Expect the signed-in shell with no request
  tagged `?app=aurora`.
- `protocolMismatch`: `protocol: 2`. Expect the "This DAWN is newer than this Aurora" message and no
  socket.
- `upgradedMidLoad`: status says `protocol: 1`, the config frame `protocol: 2` (DAWN upgraded
  between the page's check and its socket). Expect the same message, from the config frame.

### What fails a run

- any uncaught exception (`pageerror`);
- any `console.error`, and any console warning not on a short allowlist where each entry names its
  reason (today: the client's note that an optional subsystem isn't on this DAWN, which the fake's
  `UNKNOWN_TYPE` answers cause by design, and the browser's own GL driver performance notes);
- any DAWN frame the client logs as unhandled (a stale fixture, or a stale client);
- an unexpected request (manifest) or an unanswered `/api/*` path;
- a missing or wrong core element, asserted by content, not just presence;
- the reactor: the anchor canvas holds a live WebGL2 context with a drawing buffer, not merely a
  `<canvas>` in the DOM.

Before reading the errors, the teardown waits two animation frames, so an error thrown just after
the last assertion still counts; both teardown checks report even when the first fails.

Assertions wait on visible state, never on sleeps. `reducedMotion: "reduce"` skips the boot
animation.

### Runner

Playwright (`@playwright/test` 1.64.1, pinned; headless Chromium) against the **production build**
served by `vite preview` (base `/aurora/`), so it tests what DAWN serves. A `smoke` Vite mode drops
basicSsl and the DAWN proxy: plain http on localhost (a secure context), and nothing ever reaches a
real DAWN. DAWN is replaced in the page with `page.route()` and `page.routeWebSocket()`.

## Phases (each a piece of the final design)

### Phase 1a: core + Playwright adapter + the five scenarios

As above. `npm run test:smoke` builds into `.smoke/` (never `dist/`, which is what DAWN
serves), starts the preview in smoke mode and runs the specs.

### Phase 1b: CI + docs

- A `smoke` job on every push and PR: `npm ci`, `npx playwright install --with-deps chromium`
  (no browser cache), build, run; `workers: 1`, `retries: 0` (flakiness stays visible and gets
  fixed); trace, screenshots and frame logs uploaded when it fails; a 15-minute job timeout. Added to the required checks
  after a few green runs.
- DEVELOPING and CONTRIBUTING describe the smoke test; DEVELOPING's stale stub swap is corrected.

### Phase 1c: drift guards

- Vitest round-trips every fixture through the real `DawnIngest` (with recording sinks) and asserts
  what it produced, so a lenient parser can't hide a stale fixture.
- `npm run check:fixtures` (local only, needs `../dawn`): lists frame and verb names in the fixtures
  that DAWN's `WEBSOCKET_PROTOCOL.md` doesn't mention, and the DAWN commits touching its WebUI or
  protocol doc since `CHECKED_AGAINST` (the commit the fixtures were last checked against), for a
  human to look at.

### Phase 2a: offline development

Built: a Node adapter (`tests/fake-dawn/node-adapter.ts`: http + `ws`) over the same core,
mounted by a Vite plugin under `npm run dev:fake` (port 5274, beside `npm run dev`, which is
unchanged); the scenario comes from `FAKE_DAWN_SCENARIO`. The core now models DAWN's login flow
(CSRF token, login, logout with `force_logout` and a 4002 close, with DAWN's own refusals), so a
signed-out scenario can be signed into, and the smoke test covers that round trip through the
Playwright adapter. A standalone server (no Vite) waits until something needs it: the adapter is
written to be mounted on any Node HTTP server.

### Phase 2b: parity fixtures

Fixtures for what the stub showed (notices, jobs, music state, the panels' data), so nothing is lost
when the stub goes.

### Phase 3: retire StubIngest

- Unit tests for the store/choreography seam (Store spike/tick/decay, Choreographer
  depth/presence/contention, RenderNode output), which only the stub drives today.
- A DEV-only `?seam=demo` seeder so the extension point stays visible, not just tested.
- Delete `src/ingest/stub.ts` and its references; update ARCHITECTURE.md, DEVELOPING.md and
  CLAUDE.md.

### Phase 4 (optional): an end-to-end tier

Interaction flows (send a turn, stream a reply, reconnect) against the fake.

## Risks and answers

- **Fixtures drift from DAWN.** Round-trip tests, content assertions, provenance stamps and the
  local protocol-doc diff (phase 1c); daily use in phase 2.
- **Flakiness** (timing, headless WebGL). State-based waits, reduced motion, one worker, no retries.
- **CI time.** A Chromium install plus a build, about a minute or two.
- **Scope creep in fixtures.** Phase 1 models only the core boot verbs; optional subsystems are
  answered UNKNOWN_TYPE by design, and anything else fails loudly.

## Separate finding

`new THREE.WebGLRenderer` in the anchor (`main.ts` builds it at startup) throws when WebGL2 is
unavailable, which stops everything after it, including the login card. Tracked as its own to-do.
