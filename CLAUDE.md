# CLAUDE.md

Guidance for AI assistants working in the Aurora repository. Personality and
global working style come from the user's own configuration; this file is the
project-specific technical direction.

## Project overview

Aurora is a calm, read-mostly, JARVIS-style ambient dashboard for D.A.W.N. (part
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
  `set_tts_enabled` (a per-connection "mute my socket's voice" preference; it also
  stops DAWN pacing the reply to synthesis speed, so muting client-side alone is not
  enough), `scheduler_action` dismiss, `new_conversation` plus the UI's own message
  persistence, music transport via `music_subscribe` / `music_control` plus the
  `music_buffer` flow-control report, which is solicited telemetry the server clamps,
  not a control verb, and voice input: the mic sends `AUDIO_IN` / `AUDIO_IN_END` binary
  frames for push-to-talk, and continuous listening sends `always_on_enable` /
  `always_on_disable` to arm/disarm DAWN's server-side VAD + wake word - all user-initiated
  conversation input, the same sanctioned class as chat submit), and the conversation
  picker's management verbs (`rename_conversation`, `set_pinned`, and the confirm-gated
  **`delete_conversation`**), and the **Watches panel**'s `watch_set_enabled` (a benign
  per-watch enable/disable flip, same class as `set_pinned`) plus its CRUD (`watch_add` /
  `watch_update` from the edit modal, and the confirm-gated **`watch_remove`**) - per-user
  proactive rules, deliberate actions like the picker verbs. The SAGE **global attention
  flag is display-only** in Aurora - toggling it is a `set_config` (admin/global), over the
  read-mostly line. Rename and pin are benign metadata flips like `set_private`;
  **delete is the one write that permanently destroys DAWN-side data** (it cascade-deletes
  the conversation's images + child background jobs and refuses on a running job), so it is
  gated behind a named, cascade-explicit confirm dialog and only ever reachable from a
  deliberate user gesture, never a frame handler. **Conversation attachments** are the same
  sanctioned conversation-input class as chat submit: the composer uploads a document
  (`POST /api/documents`, inlined into the turn text as an `[ATTACHED DOCUMENT]` marker) or a
  client-compressed image (`POST /api/images`, sent as `payload.images[]` base64 plus the
  MANDATORY order-matched `payload.image_ids[]` so the daemon persists `[IMAGE:id]` markers -
  image attach is gated on a vision-capable model). The **session-continuity** writes are
  `set_active_conversation`/`load_conversation` re-anchors on reconnect and the takeover
  reclaim (see the reconnect gotcha below). If a new feature needs to write to DAWN, flag it
  and confirm first.
- **Three-space indentation. No em dashes in prose.**
- **Views are user-arrangeable, not glued to a corner.** The standalone interactive views
  (music player, calendar, HA board) and the notification cards (`src/notify/`) are
  grab-to-move with a persisted position via `makeMovable` (`src/render/movable.ts`), all
  sharing one snap set with a central dead zone around the reactor. **The clock and the
  telemetry readout are now movable + toggleable too** (grab-to-move + a Panels-menu
  show/hide, wired in `hud.ts`), so the only remaining fixed HUD chrome is the frame corners
  and the reticle. Top-band menu chrome (the menubar and the conversation picker, a peer of
  the menubar) still gets a fixed screen position. Store-backed ambient
  panels dock to the rails through `PanelDrag` instead - but that path is stub-only today
  (see the notification note below).
- **Colors and feel only from `src/design/tokens.ts`.** Never hardcode a color in a
  component; use or add a token (it is mirrored to CSS custom properties).
- **Feedback before implementation.** For a question or a design choice, give analysis,
  trade-offs, and a recommendation first; wait for a clear go-ahead before coding.
- **Review before handoff.** Any change worth reviewing gets a code-review pass BEFORE it is
  handed over for verification. Build + tsc + browser-verify is not enough on its own. Sequence:
  build/tsc -> code review -> fix what's real -> hand over -> verify in browser -> commit only on
  confirmation. Launch the specialist review set in parallel via the Agent tool, scoped to the
  diff (`git diff <last-reviewed-ref>`): `render-seam-architect` (seam/architecture),
  `correctness-reviewer` (logic), `web-frontend-security-reviewer` (XSS + read-mostly charter),
  `browser-runtime-reviewer` (leaks/lifecycle). Scale the SET to the change (a small focused fix
  may need only the one or two relevant lenses), but running SOMETHING is the default - only
  genuinely trivial edits (a comment, a token rename, a copy tweak) skip it.
- **Commit only when asked.** The user runs their own git; do not commit or push unless
  told to.
- **Verify against DAWN source.** DAWN lives at `../dawn`. Its
  `docs/WEBSOCKET_PROTOCOL.md` is the canonical wire reference; the UI-consumer view is
  `docs/DAWN_UI_SIGNAL_MAP.md`. Read the actual C source when a payload shape matters,
  the docs have had gaps.

## Build & run

```
npm install
npm run dev      # https://localhost:5273 (Vite dev server, HTTPS + DAWN proxy)
npm run build    # tsc typecheck + static bundle in dist/
```

The dev server is HTTPS (self-signed via `@vitejs/plugin-basic-ssl`) because the music
player needs a secure context (WebCodecs / AudioWorklet); a plain-http network origin
cannot decode audio. Accept the self-signed cert once per browser.

Run `npx tsc --noEmit` (or `npm run build`) after changes; strict TypeScript is how the
seam is enforced. Browser verification uses the claude-in-chrome MCP against the running
dev server. The user keeps a tab open for this repo, so use or confirm it rather than
spawning new tabs.

## Architecture in one paragraph

`ingest -> state -> choreography -> render`, downward dependencies only. `Ingest`
(`src/ingest/`) is the single DAWN boundary; it feeds the four seam sinks (store, reactor,
conversation, telemetry) plus the self-owned view sinks (music, calendar, ha,
notifications, conversation list). `DawnIngest` is the real WebSocket client and
`StubIngest` is fake data, swapped in one line in `main.ts`. The `Store` holds importance;
`spike()` / `tick()` are the spike-then-recede, and the choreographer maps importance to
depth - but this seam is exercised only by `StubIngest` now (see the notification note
below). The CSS-3D renderer is the only pixel code; Three.js lives only in the anchor
(the center reactor) and never crosses the seam.

**Notifications are NOT store-backed** (as of 2026-08-13). Notices - proactive alerts,
alarms, job/observation toasts, and the sticky jobs card - are self-owned movable cards in
`src/notify/`, fed by the `notifications` ingest sink, snapping like the instruments
(`makeMovable` + central dead zone). Their spike/recede/contention/engagement-dim/60s-toast
lifecycle is a per-frame importance model inside that layer (ticked from the frame loop,
orthogonal to `makeMovable`: X/Y is placement, Z/blur/opacity is the model), NOT the
store/choreographer. `spikeNotice` / `renderJobs` route to that sink. In the live DAWN path
nothing writes the store, so the whole store/choreography/rail/`PanelDrag` pipeline is
stub-only - kept as the render seam and the extension point for future store-backed panels.

## Non-obvious gotchas (these cost real time)

- **`dawn-1.0` subprotocol is mandatory and fails silently.** Omit it on the WebSocket
  and libwebsockets routes you to the HTTP handler: the socket opens, sends succeed, and
  every frame is dropped with no error and no server log.
- **Session reuse.** Every `init` mints a new session and DAWN caps at 8. Store the
  `session` frame's token and send `reconnect` (not `init`) on later connects. On page
  load, `GET /api/auth/status`; if authenticated, resume without re-login.
- **One connection per session, and the takeover is signalled TWO ways.** DAWN binds one
  live connection per session; a second tab reconnecting evicts the first. Without a
  client backoff this used to storm (each evicted tab's watchdog re-stole the session). The
  fix (Tier-1): the daemon sends a **`session_superseded` frame then a WS close code `4001`**;
  the client backs off (no auto-reconnect) and shows the "Use DAWN here" takeover
  (`src/auth/login-panel.ts`), reconnecting only on that gesture. **The frame is load-bearing
  because the Vite dev proxy STRIPS the `4001` close code down to a generic `1006`** - so
  `onclose` backs off on `ev.code === 4001 || superseded` (the frame set `superseded`). Also:
  a stale old socket's late close must not act (guard `if (this.ws && this.ws !== ws)`), and a
  reclaim does a **full re-rendering `load_conversation`** (not the lightweight re-anchor) so
  the transcript catches up to turns another tab added while this one was backed off.
- **A fresh session loses the LLM context; the `session` frame's `reconnected` flag tells you.**
  Sessions are in-memory, so a daemon restart / idle-expiry / eviction lands the client on a
  FRESH session with an EMPTY LLM history - the lightweight `set_active_conversation` re-anchor
  only sets a pointer, so the model forgets the conversation (and its images). On
  `reconnected:false` issue a full `load_conversation` (rebuilds the server-side history via
  `webui_restore_conversation_context`); on `true` the re-anchor is fine.
- **The cookie needs a same-origin proxy.** The dev server proxies `/api` and `/ws` to
  DAWN so the HttpOnly `dawn_session` cookie rides the `/ws` handshake. Cross-origin
  does not work; that is why the proxy exists in `vite.config.ts`.
- **The WS upgrade is Origin-checked, and a mismatch fails silently.** DAWN validates the
  `Origin` on the WebSocket handshake against `[webui] allowed_origins`. Dev works only
  because `https://localhost:5273` is already in that list. In production the HUD must be
  served **same-origin with DAWN** (a reverse proxy in front of `:3000`) or its real
  origin added to `allowed_origins`; otherwise the WS never connects and the only clue is
  a `CSRF: Origin mismatch` line in DAWN's log.
- **`llm_state_update` only fires on a `switch_llm` tool call, never on connect.** Read
  the current model / provider from `get_config`'s `payload.llm_runtime` (provider names
  are capitalized there). Reasoning and effort now come from that same `llm_runtime`
  (`thinking_mode` / `reasoning_effort`, the session's resolved values; signal-map §9.1a),
  so there is no client-side persistence: read them on connect and reflect the
  `set_session_llm_response` echo after a change (native Claude clamps a mid-conversation
  thinking-disable back on, §9.2). Fall back to the config default (`llm.thinking`) only
  for older servers that omit the runtime fields.
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
- **Music is Opus, not PCM (unlike TTS).** `music_subscribe`'s `audio_codecs` is accepted
  but never read; music is always Opus (48kHz stereo, 20ms/960-sample frames), so the
  browser must decode it (`src/audio/music.ts` uses WebCodecs `AudioDecoder` -> a worklet
  ring buffer). WebCodecs and AudioWorklet are **secure-context only**: `localhost` is
  fine over http, but a network origin (`http://<ip>:5273`) is not, so music silently
  will not decode there. The dev server therefore runs HTTPS (basicSsl). TTS is
  unaffected (it uses plain `AudioContext`, which is not secure-context-gated). The
  **dedicated `dawn-music` socket is the SOLE music transport** (port main+1, subprotocol
  `dawn-music`, `{type:auth,token}` handshake with the session token): DAWN removed the
  legacy main-socket music path, so if this socket never attaches there is no audio at
  all (not a silent degrade) - `DawnIngest` surfaces "Music stream unavailable" after it
  exhausts retries, and a later `music_control` re-arms them. Each frame still carries the
  `0x20` opcode there: the daemon prepends `WS_BIN_MUSIC_DATA`, so the payload is
  `[0x20][uint16-LE len][opus]` and `DawnIngest` MUST strip the leading opcode byte before
  handing `[len][opus]` to the decoder (feeding the opcode into the length parser
  misframes every packet -> WebCodecs "Decoding error", silent playback). In dev it is
  proxied at **`/music-ws`** — NOT `/ws-music`, which the broader `/ws` proxy prefix would
  capture and misroute to the main server (which has no `dawn-music` protocol and no HTTP
  fallback, so the upgrade just hangs up).
- **Music uses closed-loop buffer flow control.** DAWN paces music to hold a ~2s cushion
  on the client (so a TTS CPU burst can't drain it to a stutter), but only if the client
  reports its buffered depth back up the music socket as `{type:"music_buffer",
  buffered_ms}` (~32ms cadence). Report worklet-ring depth PLUS the WebCodecs
  `decodeQueueSize * 20ms` backlog, else the server reads "empty" and floods the decoder.
  Stop reporting and the server falls back to real-time pacing (the old stutter). A natural
  end-of-track advance is tagged `advance:"auto"` on `music_state` and is gapless (do NOT
  flush; user skips/seeks are untagged and DO flush). The server's reported position runs
  ~2s ahead of audible, so subtract the buffered depth for the progress bar.
- **Music `volume` is server-stored only.** `music_control volume` sets a value DAWN
  echoes in `music_state` but never applies to the audio, so real gain/mute is a
  client-side Web Audio `GainNode` (the player owns it). `repeat_mode` is an int (0/1/2);
  `track` is null when the queue is empty.

## Backend requests

Small DAWN-side additions the UI would benefit from are collected in
`docs/DAWN_UI_SIGNAL_MAP.md` (section 9). The larger backend proactive-alert system is
scoped in `../dawn/docs/PROACTIVE_ALERTS_SCOPE.md` (extend SAGE). Do not start backend
work without being asked.
