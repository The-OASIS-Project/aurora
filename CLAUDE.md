# CLAUDE.md

Guidance for AI assistants working in the Aurora repository. Personality and
global working style come from the user's own configuration; this file is the
project-specific technical direction.

## Project overview

Aurora is a calm, JARVIS-style ambient interface for D.A.W.N. (part of The OASIS
Project). Vanilla TypeScript + Vite, no web framework. It reflects DAWN's WebSocket state
and lets the user act on their own data and session; it is the **user's** interface, not
DAWN's operator/admin console (that is DAWN's own WebUI). It runs on a PC or laptop, not
the Jetson.

See @ARCHITECTURE.md for the four-layer design and the render seam, and
@docs/DAWN_UI_SIGNAL_MAP.md for which DAWN signals the UI consumes.

## ⚠️ THE PRIME DIRECTIVE: WE ALWAYS DO IT RIGHT. WE DON'T DO STOP-GAPS. ⚠️

**This rule outranks convenience, speed, and scope. It governs every other rule in this file.**

- **Do it right. Don't be lazy.** Every fix is the real fix, designed properly and phased properly.
  There is no "quick fix now, real fix later." Never propose a stop-gap, a band-aid, a workaround
  dressed up as a fix, or a degrade-instead-of-fix path as the plan. If the proper fix is large,
  **phase the proper fix**: every phase must be a piece of the final design, not something to rip
  out later.
- **Aurora is a public project.** Judge correctness against **every user's** accounts, configs,
  platforms, and hardware, never only the developer's. "It works on my setup" or "my account isn't
  affected" is not an argument. Other people run this.
- **Verify, don't assume.** Check claims against the code and against authoritative vendor
  documentation or live behavior, and reproduce a bug before calling it fixed. If you haven't
  verified something, say so plainly.
- **When a real tradeoff exists,** lay the options out honestly, say what each one actually fixes,
  and recommend the proper one even when it's more work. Never quietly pick the easy option.

## Critical rules

- **Never breach the render seam.** Logic (ingest / state / choreography) writes
  abstract coordinates through `RenderNode`; only `src/render/` knows pixels or CSS. If
  a state or choreography type grows a visual property, the seam is broken. This is the
  spine of the whole design.
- **User surface, not operator console.** Aurora is the *user's* ambient interface to DAWN;
  DAWN's own WebUI is the operator/admin console. Aurora writes freely on behalf of deliberate
  user actions over the user's OWN data and session, but never crosses into operator/admin/global
  control or anything that **depowers or reconfigures the daemon**. The test for any new write is
  not "is it a write?" (that line is retired - Aurora long outgrew read-only eye-candy) but
  "**is this the user acting on their own data, or an operator configuring the daemon?**"
  - **Out of bounds - stays in DAWN's WebUI:** `set_config`, `set_secrets`, `restart`, user
    management (`create_user` / `delete_user`, ...), and the SAGE **global attention flag**
    (display-only in Aurora - toggling it is a `set_config`, admin/global). Anything that would
    depower a live capability for the user or others is out.
  - **The user-scoped writes Aurora makes** (all deliberate, user-initiated): chat submit;
    `set_session_llm`; `set_private`; `set_tts_enabled` (a per-connection "mute my socket's voice"
    preference - it also stops DAWN pacing the reply to synthesis speed, so a client-side audio drop
    alone is not enough); `scheduler_action` dismiss / **snooze**; `new_conversation` + the UI's own
    final-answer persistence; music transport (`music_subscribe` / `music_control` + the
    `music_buffer` flow-control report, solicited telemetry the server clamps, not a control verb; the
    player's queue and library section reads `music_queue` list / `music_search` / `music_library` and
    edits the user's own queue through `music_control` add_to_queue / remove_from_queue / clear_queue /
    add_artist / add_album / play / play_index, no confirm since the queue is transient);
    voice input (mic `AUDIO_IN` / `AUDIO_IN_END` for push-to-talk; `always_on_enable` /
    `always_on_disable` to arm/disarm DAWN's server-side VAD + wake word); the conversation picker's
    `rename_conversation` / `set_pinned` / confirm-gated **`delete_conversation`**; the Watches
    panel's `watch_set_enabled` + `watch_add` / `watch_update` / confirm-gated **`watch_remove`**;
    **conversation attachments** (a document via `POST /api/documents`, inlined as an
    `[ATTACHED DOCUMENT]` marker; a client-compressed image via `POST /api/images`, sent as the MANDATORY order-matched
    `payload.image_ids[]` (the daemon reads them, persists `[IMAGE:id]` markers, and with
    `image_turns_by_id` refuses a bad id with `IMAGE_*` and runs nothing; only an older DAWN
    without that flag also gets the base64 `payload.images[]`). A refused turn returns its text +
    attachments to the composer. Image attach is gated on a vision-capable model); the
    **session-continuity** writes (`set_active_conversation` / `load_conversation` re-anchors on
    reconnect + the takeover reclaim, see the reconnect gotcha below); and **memory deletes**
    (`delete_memory_fact` / `_preference` / `_summary` / `_entity` - user-scoped, the user's own
    memory, from the Context panel), plus **`forget_conversation_memories`** (everything one
    conversation and its continuations taught memory: offered after `set_private` from DAWN's
    `conversation_learned` count, or from the picker's per-row Forget), plus **phone calls**
    (`phone_action` answer / reject / hangup on the user's own phone from the call card, and the
    `phone_status` read on connect; DAWN allows only the modem owner; the call audio stays on the
    daemon's hardware), plus the **Mail panel** (`src/email/`, DAWN's `email_client` verbs: the
    reads `email_list` / `email_search` / `email_read` / `email_unread_counts` / `email_list_accounts`,
    and `email_set_flags` read/unread on the user's own mailbox; opening a message marks it read (or
    later / never, per Mail options); `email_archive` / `email_trash` (batched, never re-sent) +
    `email_undo`, one-click with server-side undo, never a permanent delete, with DAWN's `email_changed`
    notice applied from any tab; "Discuss" sends a chat turn with `email_refs` (one email, words
    required, `email_refs` flag; DAWN's model reads the email through its tool, and a row's `email_ref`
    redraws the chip, which opens the message in the Mail panel); account setup stays in DAWN's WebUI).
  - **Destructive writes are gated.** Any write that permanently destroys DAWN-side data -
    `delete_conversation` (cascade-deletes the conversation's images + child background jobs and
    refuses on a running job), `watch_remove`, `delete_memory_*`, `forget_conversation_memories` -
    is gated behind a named confirm and reachable ONLY from a deliberate user gesture, **never a
    frame handler**. Rename/pin/enable flips are benign metadata, no gate.
  - A new user-scoped write is fine; **flag it only if it might cross into operator/admin/global
    territory or could depower the daemon.**
- **Three-space indentation. No em dashes in prose.**
- **Views are user-arrangeable, not glued to a corner.** The standalone interactive views
  (music player, calendar, HA board) and the notification cards (`src/notify/`) are
  grab-to-move with a persisted position via `makeMovable` (`src/render/movable.ts`), all
  sharing one snap set with a central dead zone around the reactor. Every movable view gets a
  position padlock in its top-left corner (`src/render/panel-lock.ts`; locked = no drag, no
  resize; the Panels menu's "Lock all panels" locks them all); notification cards opt out. **The clock and the
  telemetry readout are now movable + toggleable too** (grab-to-move + a Panels-menu
  show/hide, wired in `hud.ts`), so the only remaining fixed HUD chrome is the frame corners
  and the reticle. **The conversation picker is now movable too** (grab its header bar via
  `makeMovable`; it keeps its top-band position until first dragged). The menubar is the only
  fixed top-band chrome left. The Watches board and the read-only **Stocks panel** (`src/stocks/`,
  the user's own Schwab portfolio) are movable + Panels-menu toggleable in the same way; Stocks is
  **default-off** (opt-in), since financial data should not auto-appear. Store-backed ambient
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
conversation, telemetry) plus the self-owned view sinks (music, calendar, ha, watches,
stocks, watchlist, library, context, notifications, conversation list, memory forget). `DawnIngest` is the real WebSocket client and
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
- **Logout must end the login AND wipe the user's browser state (reload).** `DawnIngest.logout()`
  POSTs `/api/auth/logout` with the socket OPEN (DAWN's contract: it frees every session the login
  owns, sends `force_logout`, closes the WS with `4002`, closes music itself; replies 200 with the
  cookie cleared). POST, not a bodyless GET, so Origin rides along through the dev proxy. A `4002`
  close is handled like `force_logout` (the dev proxy delivers 1006, so the frame is the reliable
  signal). Only on success (the 200, or DAWN ending the session meanwhile) it clears the per-user
  localStorage (`src/util/user-state.ts` `USER_KEYS` + the `aurora.notice.*` keys, which embed
  alert text) and reloads, so no panel keeps the previous user's data. A login or resume as a
  different user than the last one (`dawn.hero.lastUser`, exact case-sensitive match), a revoked
  session, and another tab signing in as someone else (a `storage` listener) all wipe + reload.
  `disconnect()` is only a socket close (HMR teardown) - never wire a "log out" to it. DAWN rejects
  a reconnect token owned by another user, so the old leak was purely client-side. Add any new
  per-user localStorage key to `USER_KEYS`.
- **Contract versioning: behaviour changes ride named flags (signal-map §9.15).** DAWN sends
  `protocol` (int) + `features` (string[]) on the `config` frame and `/api/auth/status`; a missing
  `features` = an older DAWN = legacy behaviour. Check a flag (`hasFeature`) only where behaviour
  differs; a new optional FIELD needs no flag (presence detection still works). A `protocol` other
  than `CLIENT_PROTOCOL` stops with a "DAWN is newer/older than this Aurora" message. Aurora sends
  `client: {name, version, protocol}` in init/reconnect. `server_features` (compiled-in subsystems,
  e.g. home_assistant) is a different frame and question - don't mix them.
- **Per-app logins (`app_logins`): every DAWN URL goes through `dawnUrl()`.** With the flag, Aurora
  has its own cookie (`dawn_session_aurora`) and must tag the WS/music URLs and every `/api/*` fetch
  with `?app=aurora` (never a header). An untagged request silently uses the WebUI's login. Any new
  DAWN request must be built with `dawnUrl()` (`src/util/dawn-app.ts` `tagDawnUrl`); rendered
  markdown tags same-origin `/api/` src/href via `tagIfDawnApi` (DAWN's in-frame URLs carry no app).
  The session frame's `username` is cross-checked against the signed-in user as a backstop.
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
  `set_session_llm_response` echo after a change. Fall back to the config default
  (`llm.thinking`) only for older servers that omit the runtime fields.
- **Reasoning options come from DAWN, per model (signal-map §9.13).** Three modes
  (`disabled` / `adaptive` / `enabled`; a legacy `auto` from older servers folds to `enabled`); which ones a model offers, and its efforts, come from
  `reasoning_capabilities`. The panel shows the EFFECTIVE `thinking_mode` / `reasoning_effort`
  (what runs), never the `*_pick` fields (the stored choice, which DAWN re-resolves per
  model). Some models cannot turn reasoning off (Opus 5.5, Fable 5.x). `effortOptionsForModel`
  is only the fallback for an older server that sends no capabilities.
- **DAWN is the sole writer of persisted turns (server-authoritative).** The daemon persists
  BOTH the user turn and the assistant reply itself; the client saves nothing (see
  `dawn-ws.ts` terminal `stream_end`, which only registers the finalized bubble for
  message_appended adoption, it does not persist). This corrects the older "the client
  persists the final answer" model - client-side saving is gone and would duplicate rows.
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
  ~2s ahead of audible, so subtract the buffered depth for the progress bar. An auto state
  (the next track, or the natural end-of-queue stop, also tagged) is HELD for the buffered
  depth so the title/stop lands when the audio does (`src/ingest/music-hold.ts`; a second auto
  state replaces the held one, any other state lands it first; Next/seek/Pause have rules in
  `musicControl`). `loading:true` (Plex fetch) means no audio meanwhile, and the music-socket
  watch (`music-watch.ts`) must not expect frames then or after Aurora sends a track change.
- **Music `volume` is server-stored only.** `music_control volume` sets a value DAWN
  echoes in `music_state` but never applies to the audio, so real gain/mute is a
  client-side Web Audio `GainNode` (the player owns it). `repeat_mode` is an int (0/1/2);
  `track` is null when the queue is empty.

## Backend requests

Small DAWN-side additions the UI would benefit from are collected in
`docs/DAWN_UI_SIGNAL_MAP.md` (section 9). The larger backend proactive-alert system is
scoped on the DAWN side as an extension of SAGE. Do not start backend
work without being asked.
