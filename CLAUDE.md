# CLAUDE.md

Guidance for AI assistants working in the DAWN Hero UI repository. Personality and
global working style come from the user's own configuration; this file is the
project-specific technical direction.

## Project overview

DAWN Hero UI is a calm, read-mostly, JARVIS-style ambient dashboard for D.A.W.N. (part
of The OASIS Project). Vanilla TypeScript + Vite, no web framework. It consumes DAWN's
WebSocket broadcast streams and reflects state; it is not DAWN's admin panel. It runs on
a PC or laptop, not the Jetson.

See @ARCHITECTURE.md for the four-layer design and the render seam, and
@docs/DAWN_UI_SIGNAL_MAP.md for which DAWN signals the UI consumes.

## Critical rules

- **Never breach the render seam.** Logic (ingest / state / choreography) writes
  abstract coordinates through `RenderNode`; only `src/render/` knows pixels or CSS. If
  a state or choreography type grows a visual property, the seam is broken. This is the
  spine of the whole design.
- **Read-mostly.** Do not add control paths that could depower DAWN. Writes are limited
  to deliberate user actions (chat submit, `set_session_llm`, `set_private`,
  `scheduler_action` dismiss, `new_conversation` plus the UI's own message
  persistence). If a new feature needs to write to DAWN, flag it and confirm first.
- **Three-space indentation. No em dashes in prose.**
- **Colors and feel only from `src/design/tokens.ts`.** Never hardcode a color in a
  component; use or add a token (it is mirrored to CSS custom properties).
- **Feedback before implementation.** For a question or a design choice, give analysis,
  trade-offs, and a recommendation first; wait for a clear go-ahead before coding.
- **Commit only when asked.** The user runs their own git; do not commit or push unless
  told to.
- **Verify against DAWN source.** DAWN lives at `../dawn`. Its
  `docs/WEBSOCKET_PROTOCOL.md` is the canonical wire reference; the UI-consumer view is
  `docs/DAWN_UI_SIGNAL_MAP.md`. Read the actual C source when a payload shape matters,
  the docs have had gaps.

## Build & run

```
npm install
npm run dev      # http://localhost:5273 (Vite dev server + DAWN proxy)
npm run build    # tsc typecheck + static bundle in dist/
```

Run `npx tsc --noEmit` (or `npm run build`) after changes; strict TypeScript is how the
seam is enforced. Browser verification uses the claude-in-chrome MCP against the running
dev server. The user keeps a tab open for this repo, so use or confirm it rather than
spawning new tabs.

## Architecture in one paragraph

`ingest -> state -> choreography -> render`, downward dependencies only. `Ingest`
(`src/ingest/`) is the single DAWN boundary with four sinks (store, reactor,
conversation, telemetry); `DawnIngest` is the real WebSocket client and `StubIngest` is
fake data, swapped in one line in `main.ts`. The `Store` holds importance;
`spike()` / `tick()` are the spike-then-recede. The choreographer maps importance to
depth. The CSS-3D renderer is the only pixel code; Three.js lives only in the anchor
(the center reactor) and never crosses the seam.

## Non-obvious gotchas (these cost real time)

- **`dawn-1.0` subprotocol is mandatory and fails silently.** Omit it on the WebSocket
  and libwebsockets routes you to the HTTP handler: the socket opens, sends succeed, and
  every frame is dropped with no error and no server log.
- **Session reuse.** Every `init` mints a new session and DAWN caps at 8. Store the
  `session` frame's token and send `reconnect` (not `init`) on later connects. On page
  load, `GET /api/auth/status`; if authenticated, resume without re-login.
- **The cookie needs a same-origin proxy.** The dev server proxies `/api` and `/ws` to
  DAWN so the HttpOnly `dawn_session` cookie rides the `/ws` handshake. Cross-origin
  does not work; that is why the proxy exists in `vite.config.ts`.
- **`llm_state_update` only fires on a `switch_llm` tool call, never on connect.** Read
  the current model / provider from `get_config`'s `payload.llm_runtime` (provider names
  are capitalized there). Reasoning and effort are not per-session at all; seed them
  from the config default (`llm.thinking`).
- **Message persistence is split.** With an active conversation the daemon persists the
  USER turn itself; the client persists only the FINAL ANSWER (on the `state: idle`
  transition). Saving the user turn too produces duplicate rows.
- **A background job's answer arrives as `message_appended`,** not a stream. Handle it,
  or the result never appears in the UI.
- **The bloom pass outputs opaque black** (no alpha), so the ground token is pure black
  on purpose; a transparent canvas would still show a black rectangle over the page.
- **TTS is raw PCM.** The client advertises only the `pcm` codec, so DAWN sends 48kHz
  PCM and no Opus decoder is needed. Binary frames: `0x11` = audio chunk, `0x12` = play
  the segment.

## Backend requests

Small DAWN-side additions the UI would benefit from are collected in
`docs/DAWN_UI_SIGNAL_MAP.md` (section 9). The larger backend proactive-alert system is
scoped in `../dawn/docs/PROACTIVE_ALERTS_SCOPE.md` (extend SAGE). Do not start backend
work without being asked.
