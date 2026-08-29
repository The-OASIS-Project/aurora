# DAWN UI Signal Map

**What a UI can consume from DAWN over WebSocket, today.**

This is the consumer-facing companion to DAWN's canonical
[`WEBSOCKET_PROTOCOL.md`](../../dawn/docs/WEBSOCKET_PROTOCOL.md). That document is
the exhaustive, bidirectional wire reference (every request, every admin verb,
every satellite frame). This one answers a narrower, more useful question for
building dashboards:

> *If I am a mostly read-only client, what signals does DAWN hand me, which ones
> arrive on their own, which ones I have to ask for, and what can I actually
> build with each?*

Everything below was read out of `dawn/src/webui/` (primarily
`webui_broadcasts.c`, `webui_server.c`, and the per-domain handlers) as of
2026-07-28. Where this disagrees with the canonical doc, this one was checked
against source and the canonical doc has a gap (noted inline).

---

## 1. The one thing to understand first

DAWN's WebSocket surface divides into three tiers from a UI's point of view:

| Tier | You do... | Arrives... | Use it for |
|------|-----------|------------|------------|
| **A. Pushed signals** | Nothing (just connect) | On connect + whenever an event fires | The live, ambient heartbeat: reactor state, notices, jobs, alarms, music, phone |
| **B. Poll (request/response)** | Send a request | Only when you ask | Filling a panel's *contents* (Home Assistant states, memory, metrics snapshots) |
| **C. Control / mutation** | Send a command | Ack only | Not for a read-mostly UI. Listed here so you know what to *not* wire. |

A read-mostly dashboard is built almost entirely on **Tier A**, dips into
**Tier B** to populate a few panels, and deliberately ignores **Tier C**.

The subtlety that drives the whole design: **an event and its content often
arrive on different tiers.** A background job *finishing* is pushed (Tier A);
the job *history* is polled (Tier B). Home Assistant does not push at all; you
poll it (Tier B). Some panels have a push trigger but no content feed, and some
have neither. Section 5 spells out exactly which.

---

## 2. Connecting and auth

Same handshake as the existing WebUI. This answers the open wiring question:
**the hero client authenticates exactly like the admin WebUI does. There is no
separate token scheme to reuse. It logs in and rides the resulting cookie.**

1. `GET /api/auth/csrf` -> CSRF token
2. `POST /api/auth/login` (username/password + CSRF) -> sets an HTTP session cookie
3. Open the WebSocket to the same origin. The cookie authenticates it.
4. **Subprotocol `dawn-1.0` is mandatory and fails silently.** libwebsockets routes
   a client that negotiates no subprotocol to the *HTTP* handler: the socket opens,
   `send()` succeeds, and every frame is dropped with no error and no log line. In
   the browser: `new WebSocket(url, "dawn-1.0")`.
5. TLS is required when `[webui] ssl_cert_path` is set, so use `wss://`.

On connect the server sends, unprompted, in order: `session` (your token + auth
state), `config` (e.g. `audio_chunk_ms`), and `state` (current machine state).
After that you are live.

To watch a specific background conversation/job, send `attach_conversation`
(`{conversation_id, last_seq}`, `last_seq: 0` replays everything) and the server
replays history then streams live. This is the entry point for any observe client.

---

## 3. Tier A — pushed signals (the ambient stream)

These land without a request. This is the material a JARVIS-style dashboard is
made of. Grouped by what they feed.

### 3.1 Reactor / conversation core

The center visualization and the conversation console live on these.

| Frame | Payload (key fields) | Fires when |
|-------|----------------------|------------|
| `state` | `state` ∈ idle \| listening \| thinking \| speaking \| summarizing \| error; `detail?`; `tools?[]` | The assistant changes what it is doing. **Directly drives the reactor state machine.** |
| `metrics_update` | `state`, `ttft_ms`, `token_rate` (tokens/sec), `context_percent` | During generation, per session. **This is the throughput-gauge feed.** `context_percent` is often `-1` (not populated on that path). |
| `context` | `current`, `max`, `usage` (%), `threshold` | Token budget changes. Feeds a context-fill gauge. |
| `context_compacted` | `tokens_before`, `tokens_after`, `messages_summarized`, `summary` | Auto-compaction ran. |
| `transcript` | `role` (user \| assistant \| satellite_response), `text`, `replay?` | A complete (non-streamed or replayed) message. |
| `stream_start` / `stream_delta` / `stream_end` | `stream_id`, `delta`, `reason` | Live token stream of the assistant's reply. |
| `thinking_start` / `thinking_delta` / `thinking_end` | `stream_id`, `delta`, `provider`, `has_content` | Extended-thinking (reasoning) stream, when the model exposes it. |
| `reasoning_summary` | `stream_id`, `reasoning_tokens` | OpenAI o-series: count only, content withheld. |
| `llm_state_update` | `type`, `provider`, `model`, `*_available` flags | Session LLM config changed. Feeds a "brain" status readout. |
| `error` | `code`, `message`, `recoverable` | Something failed. Drives the reactor error state. |

> **Note on `metrics_update`:** it is sent to the session that is generating, not
> broadcast to every tab. A dashboard that is its own session sees the metrics for
> *its own* turns. To visualize another session's generation you would attach to
> that conversation and read its `conversation_event` stream instead.

### 3.2 Proactive attention (SAGE) — the ambient-notice heart

This is the system purpose-built for exactly what the hero UI does: surface a
thing, briefly, without being asked. It is wired and live in
`src/core/attention/attention_core.c`.

| Frame | Payload | Meaning |
|-------|---------|---------|
| `attention_alert` | `summary` (text), `level` ∈ **alert \| ambient** | The banner channel. `alert` = needs you; `ambient` = ambient FYI. **Maps 1:1 onto the dashboard's importance/tone.** Its own channel so it never triggers the scheduler chime. |
| `silent_observation` | `ts`, `category`, `note`, `filter_match` | A quieter FYI/peek primitive (surfaced as a low-importance notice card). WebUI-only; satellites never get it. |
| `context_injection` | `conversation_id`, `turn_id`, `items[]` (each `source_id`, **`item_id`**, `source_type` ∈ internal \| external \| user-content, `text`, `score`, `score_breakdown{semantic,recency,importance,source}`) | What DAWN pulled into context for a turn. **Consumed by the Context panel (§9.6); FLAT AT THE ROOT (no `payload` wrapper).** A paired `context_citations` frame lights up the rows the model actually cited. |
| `memory_extraction_notice` | `level`, `message` | DAWN learned/stored something. |
| `memory_proposals_changed` | `count` | Pending memory proposals count changed. |

`attention_alert.level` is the cleanest mapping you will find: `alert` -> your
`alert` importance/tone, `ambient` -> your `ambient`/`notice` tone. The
spike-forward-then-recede behavior the dashboard already does is exactly the
intended presentation.

### 3.3 Scheduler (alarms / timers / reminders)

| Frame | Payload | Fires when |
|-------|---------|------------|
| `scheduler_notification` | `event_id`, `event_type` ∈ alarm \| timer \| reminder \| task, `status` ∈ ringing \| dismissed \| snoozed \| cancelled \| fired, `name`, `message`, `fire_at`, `tts_routed` | A scheduled event fires or changes state. Broadcast to all the user's clients (system events, `user_id 0`, go to everyone). |
| `scheduler_events_changed` | *(empty)* | The event queue changed. Signal to refetch (Tier B `scheduler_events` request). |

`ringing` is the actionable state (would show dismiss/snooze). `tts_routed` tells
you DAWN is already speaking the alert, so a silent client should not also chime.

### 3.4 Background jobs

A whole observe protocol. See the canonical doc §"Background-Job" for the full
attach/replay contract; the pushed frames a passive UI cares about:

| Frame | Payload | Meaning |
|-------|---------|---------|
| `job_notification` | `text`, `conv_id`, `running` (active count) | A job finished. Silent completion toast. Browsers only. |
| `job_update` | `job{...}` (conversation_id, title, status, spawn_mode, timestamps, ...) | One job's lifecycle transition. **Upsert by `conversation_id`, drop on terminal status.** `resumed: true` marks a job moving back out of terminal. |
| `jobs_snapshot` | `jobs[]`, `truncated` | The complete active set. Reply to `jobs_request`; also on connect. Replaces your whole active set. |
| `conversation_event` | `conversation_id`, `seq`, `kind` ∈ status \| tool_call \| tool_result \| spawn \| complete, `payload` (opaque pre-redacted JSON string) | One step of a running job, live. Dedup against replay by `seq`. |
| `conversation_events` | batch of the above, ASC by `seq` | Durable replay on attach. |
| `message_appended` | `conversation_id`, `message_id`, `role`, `text` | A persisted assistant message, with body. The route by which a job's *answer* reaches you live. |
| `conversation_messages_appended` | `conversation_id` | Signal-only "refetch"; less useful than `message_appended`. |
| `conversation_renamed` | `conversation_id`, `title` | Title changed. |
| `jobs_invalidate` | *(refetch signal)* | Ask for a fresh `jobs_snapshot`. |

`status` ∈ queued \| running \| done \| failed \| interrupted \| cancelled. Only
the first two are active; treat everything else as terminal.

### 3.5 Music

| Frame | Payload | Fires when |
|-------|---------|------------|
| `music_state` | `playing`, `paused`, `track{title, artist, album, duration_sec, path}`, `position_sec`, `queue_length`, `queue_index`, `quality`, `bitrate`, ... | On subscribe, on any control action, on track change. **Everything a now-playing panel needs.** |
| `music_position` | `position_sec`, `duration_sec` | Periodic progress tick. |
| `music_error` | `code`, `message` | Playback error. |

Requires one setup message: `music_subscribe` (`{quality, audio_codecs}`). After
that the three frames above flow on their own. The binary `MUSIC_DATA` audio
chunks (`0x20`) are a separate concern you can ignore for a display-only panel.

### 3.6 Phone

| Frame | Payload | Fires when |
|-------|---------|------------|
| `phone_call_notification` | (call state: number, direction, status) | An inbound/outbound call changes state. Good for a transient "incoming call" spike. |

### 3.7 Session / lifecycle

| Frame | Meaning |
|-------|---------|
| `session` | Token + auth state, plus (authenticated frame) **`reconnected: true\|false`** + `session_id`. `reconnected:false` = a FRESH session (restart / idle-expiry / evicted-to-fresh) with an empty LLM history -> issue a full `load_conversation` to rebuild context; `true` = adopted your own live session, a lightweight `set_active_conversation` re-anchor suffices. Sent on connect/reconnect. |
| `config` | WebUI config (`audio_chunk_ms`, `music_enabled`/`music_port`). Sent after `session`. |
| `force_logout` | Server revoked your session. Reason in payload. |
| `session_superseded` | Another connection took over this session (one-connection-per-session). Sent to the evicted connection **just before a WS close code `4001`**; the frame is the reliable signal since the dev proxy strips the `4001` code to `1006`. Back off, show the takeover, reconnect only on a user gesture. See §6 / CLAUDE.md gotcha. |
| `conversation_reset` | Context was reset via a tool. |
| `image_url` | NOT a browser frame - it is an internal LLM content-part type. Attached images reach the client as inline `[IMAGE:img_id]` markers in a message's text (fetched from `GET /api/images/:id`); documents as `[ATTACHED DOCUMENT: … blob:id]…[END DOCUMENT]` marker blocks. See §9.6. |

---

## 4. Tier B — poll (request/response)

No push. Send the request, get the `*_response`. Use these to fill panel bodies.
Convention: every response is `{type: "<request>_response", payload: {success, error?, ...}}`.

| Concern | Request | Response | What you get |
|---------|---------|----------|--------------|
| **Home Assistant** | `ha_list_entities` | `ha_entities_response` | **Live entity states**. Each entity is `{entity_id, friendly_name, domain, state, area?}` — the `domain` (light/lock/climate/sensor…) and the optional `area` (room; present only when assigned in HA) are real fields the earlier docs omitted; verified in `serialize_entity_list()` (`webui_homeassistant.c`). `state` is a bare string with no units/attributes. `ha_refresh_entities` bypasses DAWN's 5-min cache and forces a live re-poll (returns the same shape). Cap 512, server-filtered to supported domains. **Admin-only** (all `ha_*` verbs call `conn_require_admin`). |
| **System metrics** | `get_metrics` | `get_metrics_response` | Uptime, sessions, last/avg TTFT, etc. Snapshot to pair with the live `metrics_update` stream. |
| **Scheduler queue** | `scheduler_events` | `scheduler_events_response` | The pending alarm/timer/reminder list. Refetch on `scheduler_events_changed`. |
| **Attention watches** | `watch_list` | `watch_list_response` | The user's SAGE watch rules (what DAWN is proactively watching for). |
| **Jobs (active)** | `jobs_request` | `jobs_snapshot` | Complete active set (bounded, countable). |
| **Jobs (history)** | `list_jobs` | `list_jobs_response` | Paginated terminal jobs (keyset cursor). |
| **Memory** | `get_memory_stats`, `list_memory_facts`, `search_memory` | matching `*_response` | Fact/preference/summary counts and lists. |
| **Conversation history** | `list_conversations`, `load_conversation`, `search_conversations` | matching `*_response` | Saved conversations, full transcripts. |
| **Music library** | `music_search`, `music_library`, `music_queue` | matching `*_response` | Search, browse, queue contents. |
| **Document library** | `doc_library_list` | `doc_library_list_response` | Notes + documents (paginated; optional `query` = BM25 search). **A NOTE carries its full body inline** (`text`, ≤4KB); a DOCUMENT is metadata only over the WS (see §9.5). Feeds the Library panel. |

---

## 5. Panel feasibility — what you can actually build today

This is the payoff. For each ambient panel the hero UI scaffolds, what does the
current WebSocket actually support?

| Panel | Event trigger (Tier A) | Content feed (Tier B) | Verdict |
|-------|------------------------|-----------------------|---------|
| **Music (now-playing)** | `music_state` / `music_position` push | `music_library` etc. | ✅ **Fully wireable now.** Rich push, complete state. |
| **Subsystems / health** | `metrics_update` push | `get_metrics` snapshot | ✅ **Fully wireable now.** |
| **Home Assistant** | `ha_state_changed` delta push (§9.4 #3) + reconcile broadcast on control | `ha_list_entities` (real states) | ✅ **Built + interactive.** Hero UI's HA board (`src/homeassistant/`) merges the realtime `ha_state_changed` delta by `entity_id` (30s `ha_refresh_entities` poll retained as a backstop), groups by `area`, and diffs each update to briefly spike a changed row. Dims a row only when the entity is **offline** (unavailable/unknown); on/off is carried by the widget + dot. Interactive widgets write via `ha_call_service` (§9.4 #8), a deliberate user action. |
| **Background jobs / tasks** | `job_notification`, `job_update` push | `jobs_request`, `list_jobs` | ✅ **Fully wireable now.** Best-supported observe surface in DAWN. |
| **Alarms / timers / reminders** | `scheduler_notification` push | `scheduler_events` | ✅ **Fully wireable now.** |
| **Ambient notices / attention** | `attention_alert`, `silent_observation` push | `watch_list` for config | ✅ **Fully wireable now.** This is the ambient-spike engine. `level` maps to tone. |
| **Calendar** | `calendar_events_changed` push | `calendar_upcoming_events` + `calendar_list_my_calendars` | ✅ **Wireable now — built.** Hero UI's calendar card consumes it (today's window, per-event color, refetch on the push). §9.1g. |
| **Email** | *(none)* | *(none — WS exposes only account management, not an inbox/message feed)* | ⚠️ **Not wireable as an inbox today.** See gap below. |

### The two gaps (important for the wiring plan)

DAWN's calendar and email integrations are exposed on the WebSocket almost
entirely as **configuration management** (`calendar_list_accounts`,
`calendar_add_account`, `email_list_accounts`, `email_add_account`, enable/toggle,
etc.). There is **no request that returns "today's calendar events" or "recent
email"**, and neither pushes content frames. The actual calendar/email data
reaches the user through the AI conversation and the proactive-attention system
(a `attention_alert` like "meeting in 15 min", or the assistant answering "what's
on my calendar"), not through a dedicated panel feed.

**Implications for the two scaffolded calendar/email panels:**

1. **Surface them through attention, not a feed.** Drive them off
   `attention_alert` / `silent_observation` by category. This fits the read-mostly,
   spike-and-recede model and needs no DAWN changes.
2. **Or add a content request to DAWN** (e.g. `calendar_upcoming_events`,
   `email_recent`) if you want a persistent always-populated panel. That is a DAWN
   server change, out of scope for the UI, but worth a ticket.
3. **Or drop them from v1** and let the six feed-backed panels carry the dashboard.

Recommend (1) for now: it keeps the UI honest about what DAWN actually knows to
tell you, and defers the server work.

---

## 6. Tier C — control / mutation (deliberately NOT wired here)

Listed so a read-mostly client knows the boundary. These mutate DAWN or depower
it, which the hero UI's charter forbids. Includes: `text` / `cancel` (drive the
assistant), `music_control`, `scheduler_action`, `job_action`, all `set_*` /
`get_config` / `set_config` / `set_secrets` / `restart`, user management
(`create_user`, `delete_user`, ...), memory deletes. The one
soft exception is the conversation console's `text` submit, which the hero UI
already treats as an explicit user-initiated action, not ambient control.

**`set_tts_enabled` is a sanctioned exception, NOT a forbidden write** (in the
`text` submit / `set_private` benign class). It is a per-connection preference -
"don't synthesize voice for MY socket" - that touches no global state and depowers
nothing. It matters beyond a local audio drop: while `tts_enabled` is true DAWN
synthesizes each sentence **synchronously on the LLM-token worker thread**
(`webui_text_processing.c:485`, `session_manager_llm.c`), so the whole reply - text
included - is paced to synthesis speed. Muting only client-side leaves that pacing in
place; sending `set_tts_enabled {enabled:false}` is what lets the reply stream at line
speed. DAWN captures the flag once at turn start, so a toggle takes effect from the next
turn. The UI sends it on toggle (`DawnIngest.setTtsEnabled`) and also rides `tts_enabled`
on the init/reconnect handshake for the connect-already-muted case.

The conversation picker (`src/conversation-picker/`) adds three more sanctioned,
user-initiated exceptions in the same class as `text` submit / `set_private`:
`rename_conversation` and `set_pinned` (benign metadata flips), and
**`delete_conversation`** — the one write in the whole UI that permanently destroys
DAWN-side data. Per `webui_history.c`, delete cascade-deletes the conversation's images
and child background jobs and refuses with `"Cancel the background job before deleting it."`
while a job is running; if the deleted conversation was active, DAWN clears the session
server-side. The UI therefore gates it behind a named, cascade-explicit confirm dialog,
surfaces the running-job refusal as a notice, and only ever fires it from a deliberate row
gesture, never a frame handler. Reads used by the picker (`list_conversations`,
`search_conversations`, `load_conversation`) and `new_conversation` remain Tier A/B and the
already-sanctioned open path.

The binary audio path is now wired. Outbound, the mic streams `AUDIO_IN` (`0x01`) +
`AUDIO_IN_END` (`0x02`) for push-to-talk. Continuous listening toggles DAWN's server-side
VAD/wake via `always_on_enable` / `always_on_disable` (`always_on_state` comes back, and
enable failures arrive as ordinary `error` frames). Voice input is a deliberate, user-initiated write (the
same sanctioned class as the `text` submit above), not ambient control. Inbound,
`AUDIO_OUT` (`0x11`) TTS drives the reactor's FFT bars with DAWN's real voice, and the
mic's own analyser drives them while the user speaks (no more state-scaled stand-in).

---

## 7. Suggested wiring order

Ordered by signal richness and independence, so each step is verifiable alone:

1. **`state` -> reactor state machine.** Smallest, highest-value. The center
   visualization comes alive on one frame type.
2. **`metrics_update` + `context` -> reactor gauges.** Throughput arc and context
   fill. Real numbers into the existing hooks.
3. **`attention_alert` / `silent_observation` -> ambient panel spikes.** The heart
   of the dashboard. Wire `level` to tone.
4. **`scheduler_notification` -> alarms/timers panel.** Clean, self-contained push.
5. **`job_notification` / `job_update` -> tasks panel.** Upsert-by-id set logic.
6. **`music_state` -> pinned music panel.** One `music_subscribe`, then it flows.
7. **`ha_list_entities` (poll) -> Home Assistant panel.** First Tier-B panel.
8. **Decide calendar/email** per §5 (recommend: attention-driven, or defer).
9. **Audio/FFT phase** later (port mic capture + TTS playback Web Audio pipeline).

Every one of steps 1 to 7 is implementable against the *current* DAWN with no
server changes. Only calendar/email need a decision, and audio needs a new phase.

---

## 8. Source of truth

| Area | File |
|------|------|
| Push broadcasts (attention, jobs, scheduler, memory, silent-observation, context-injection) | `dawn/src/webui/webui_broadcasts.c` |
| State, metrics, context, streaming | `dawn/src/webui/webui_server.c`, `dawn/src/core/session_manager_llm.c` |
| Proactive attention engine | `dawn/src/core/attention/attention_core.c`, `dawn/src/webui/webui_attention.c` |
| Message dispatch (incoming request routing) | `dawn/src/webui/webui_message_dispatch.c` |
| Home Assistant | `dawn/src/webui/webui_homeassistant.c` |
| Scheduler | `dawn/src/webui/webui_scheduler.c` |
| Music | `dawn/src/webui/webui_music*.c` |
| Phone | `dawn/src/webui/webui_phone.c` |
| Canonical, exhaustive wire reference | `dawn/docs/WEBSOCKET_PROTOCOL.md` |

## 9. Backend additions the UIs want (DAWN-side TODO)

Small emit/expose gaps found while wiring the hero UI. Each makes *every* front-end
better, so they belong in the backend. Ordered roughly by effort.

**Status (updated 2026-07-30, DAWN side).** All four actionable items landed in DAWN
(implemented + live-verified on the wire, committed); the two remaining are proactive-alert
work parked under SAGE. **Read §9.1 for the exact shapes you can now consume and §9.2 for
behaviour you must handle** — several of these changed the wire contract.

| # | Item | Status |
|---|------|--------|
| 1 | `llm_runtime` reasoning fields | ✅ **Shipped + consumed** — hero UI reads `thinking_mode`/`reasoning_effort` from `llm_runtime` on connect and reflects the `set_session_llm_response` echo; the old localStorage reasoning/effort workaround is deleted. §9.1a/d/e |
| 2 | `error` frame severity | ✅ **Shipped + consumed** — hero UI routes on `severity` (INFO_ prefix kept as older-server fallback); info notices surface as an ambient spike, never a reactor flash. §9.1b |
| 5 | Advertise music port | ✅ **Shipped + consumed** — hero UI skips the dedicated music socket when `music_enabled:false`; opens it from the `config` frame. `music_port` is informational (the UI reaches DAWN through the `/music-ws` dev proxy). §9.1c |
| 6 | `music_control` bare `play` starts a stopped session | ✅ **Shipped** — a bare `play` on a stopped-with-queue session now starts the current queue track; the `play_index`-from-stopped workaround is no longer required (harmless to keep). §9.1f |
| 3 | Home Assistant `state_changed` push | ✅ **SHIPPED (backend, 2026-08-01)** — DAWN now subscribes to HA's own `/api/websocket` `state_changed` stream and pushes a coalesced **`ha_state_changed` delta** (only changed entities) to admin browsers. Real-time board updates, no poll. **Needs a small client merge-by-`entity_id`** (delta shape in §9.4). The 30s poll stays as a backstop. Realtime defaults ON (requires an admin HA token; falls back to REST poll if the WS can't connect). *(The SAGE proactive-alert side of #3 is still deferred — this is the board-push half.)* |
| 4 | Calendar / email content feeds | ✅ **Calendar shipped + consumed** — hero UI's calendar card reads `calendar_upcoming_events` (today's window in the user's tz) + `calendar_list_my_calendars` for the color map, and refetches on the `calendar_events_changed` push. §9.1g. **Email pull still deferred**; calendar *proactive* push (vs. this refetch nudge) is still SAGE |
| 7 | Rich HA entity attributes in `ha_entities_response` | ✅ **SHIPPED (backend)** — per-entity `attributes` object, **domain-switched** (only the keys relevant to the entity's domain, not a flat superset): `brightness` (light), `percentage` (fan), `current_position` (cover), `hvac_mode`/`hvac_modes`/`current_temperature`/`temperature` (climate), `unit_of_measurement`/`device_class` (sensor). Emitted on all three `ha_entities_response` sources (list/refresh/reconcile). Additive; absent ⇒ on/off fallback. Exact per-domain shape in §9.4 |
| 8 | HA entity control verb — `ha_call_service` | ✅ **SHIPPED (backend)** — admin-only general verb (`entity_id`/`domain`/`service`/`data`). Server enforces a **write allowlist** (only the board's widget services; anything else ⇒ `"Service not permitted"`) and does **server-authoritative reconcile** (re-polls HA on success and broadcasts a fresh `ha_entities_response` — the UI just renders it, no client re-poll). `data` passed verbatim to HA. UI can flip its stubbed `send()` to live. Full contract + error strings + allowlist in §9.4. **NB:** adding a controllable domain to the UI requires extending the server allowlist (`HA_BOARD_SERVICES[]`) in the same change |
| 9 | Make documents readable over the WS + a real size (Library panel) | ✅ **SHIPPED (backend + consumed, 2026-08-13)** — (a) **`original_blob_id` + `has_original`** now on each `doc_library_list` document row → txt/md **uploads** render inline (via `GET /api/documents/original/<blob_id>`), any type downloads; (b) **`doc_library_get {id}`** full-text verb (owner-scoped, v63+ stored full text) → DAWN-**generated** docs (research reports etc) read inline. Aurora consumes both (blob-id map in `dawn-ws.ts`, promise-correlated get for the reader). ⏳ **still deferred: (c) `size_bytes`** — the panel shows `num_chunks` ("N parts") as a proxy; a real byte size needs a schema migration, held out of this change. Detail in §9.5 |

(Original item write-ups #1–#6 with source cites are preserved below the two new
subsections for reference.)

### 9.1 What shipped — new/changed wire contracts

All additive and back-compat (older servers just omit the fields; keep your fallbacks).

**a. `get_config_response.payload.llm_runtime` now carries the session's *effective*
reasoning state.** Two new fields alongside the existing `type`/`provider`/`model`/
`*_available`/`context_max`:
```json
"llm_runtime": { …, "thinking_mode": "disabled", "reasoning_effort": "low" }
```
`thinking_mode` ∈ `disabled | auto | enabled`; `reasoning_effort` ∈ `none | low | medium |
high | xhigh`. These are the resolved session values, not the config default — a fresh
connection can now show the real Reasoning/Effort state. (Previously unavailable except
after a `switch_llm` tool call.)

**b. The `error` frame now has a real `severity`.** Route on it; stop sniffing the
`INFO_` prefix (kept only as a fallback for older servers):
```json
"payload": { "code": "…", "message": "…", "severity": "info|warning|error", "recoverable": true }
```
`severity:"info"` = benign notice — do **not** flash the reactor red. Known info codes:
`INFO_THINKING_DISABLED`, `INFO_THINKING_KEPT_ON` (both about reasoning — see §9.2).
`recoverable` is retained but frozen `true`; treat it as legacy, prefer `severity`. Absent
`severity` ⇒ treat as `error`.

**c. The `config` frame (on-connect) now advertises the music-stream server:**
```json
"payload": { "audio_chunk_ms": 100, "music_enabled": true, "music_port": 3001 }
```
Use `music_port` for the `dawn-music` socket instead of assuming `main+1`; skip the socket
entirely when `music_enabled` is `false`. (Fall back to `main+1` only for older servers.)

**d. The `set_session_llm` response now echoes effective `thinking_mode` +
`reasoning_effort`** (alongside `type`/`provider`/`model`). If your UI lets the user change
reasoning, **reflect the value the server *returns*, not the one the user picked** — the
server may clamp it (see §9.2). This is the authoritative post-change state.

**e. Per-conversation LLM settings are never NULL.** `load_conversation`'s `llm_settings`
object and `get_config`'s `llm_runtime` always carry concrete `thinking_mode` /
`reasoning_effort` / `model` (effective defaults are substituted server-side for legacy
rows that predate this). You can trust these fields are populated — no more empty strings
to special-case.

**f. `music_control {action:"play"}` with no `path`/`query` now restarts a *stopped*
session.** Previously a bare `play` only resumed a pause; on a stopped session (after
`stop`) it silently echoed state, so a "press play" button looked dead until the client
sent `play_index`. Now, if the shared queue is non-empty, a bare `play` starts the current
`queue_index` track (clamped into range) and you get the normal `music_state` + audio
stream. No wire-shape change — same request, same `music_state` response; only the stopped
case behaves. An empty queue still just echoes state. **You can drop the
`play_index`-from-stopped workaround** (keeping it is harmless — `play_index` still works).

**g. Calendar panel: pull + live refetch.** Two new surfaces for a calendar/agenda board:

- **Pull** — request `calendar_upcoming_events`, response `calendar_upcoming_events_response`:
  ```json
  { "type": "calendar_upcoming_events", "payload": { "days": 7, "calendar_name": "Work" } }
  ```
  `days` (default 7, clamp 1–90) **or** explicit `start`/`end` epoch (span ≤ 366 days; providing exactly
  one, or `start>=end`, is a `success:false` error). `calendar_name` optional. Response payload:
  `{ success, start, end, truncated, events:[…] }`; each event carries
  `{ id, calendar_id, uid, summary, location, start, end, all_day, start_date, end_date, cancelled,
  is_override }`. Includes **all-day** events (holidays/PTO), ordered by start, capped at 256 with
  `truncated:true` when the cap trips (show a "+N more" affordance). Reads the offline cache — no network.
  - **`calendar_id`** is the per-event grouping/coloring key you asked for. The response intentionally does
    **not** carry the calendar *name* (that needs an extra join); `calendar_id` is the stable key (names
    change/collide).
- **The id→{name,color} map is now one call — `calendar_list_my_calendars`** (no payload), response
  `{ success, calendars:[{ id, account_id, name, color }] }`. This is your grouping map — no more two-hop
  `calendar_list_accounts` + per-account `calendar_list_calendars` bootstrap. Returns **active** calendars
  only, which is exactly the set the pull emits events from (every `calendar_id` you'll see is in the map).
  Fetch once on connect; re-fetch on `calendar_events_changed` (a newly-synced calendar can appear).
- **Push** — `calendar_events_changed` (empty payload, browsers-only, owner-scoped): a background CalDAV
  sync pulled changes; **refetch** via the pull. Signal-only, no event data on the wire. This is a UI-sync
  nudge, **not** a proactive "your standup moved" notice (that stays SAGE, on `silent_observation`/
  `attention_alert`).
- **Empty-vs-error (on record, per your note):** a transient CalDAV read failure returns an empty window,
  not an error. Rendering "Nothing scheduled" and letting the next `calendar_events_changed` self-heal is
  the intended contract.

### 9.2 Behaviour your reasoning controls must handle

DAWN now allows changing Reasoning **mode** and **effort** mid-conversation (only *tool
mode* stays frozen after the first message). Two server-authoritative behaviours follow —
your control should **display the effective value, not the picked one**:

- **Effort** is freely changeable mid-conversation on every provider; it never errors.
- **Thinking mode is a one-way ratchet on Claude.** Once a conversation contains reasoning,
  Claude's API rejects turning thinking *off* ("assistant message cannot contain thinking").
  So if the user picks **Disabled** on such a Claude conversation, the server **keeps thinking
  on**, returns `thinking_mode:"enabled"` in the `set_session_llm` response (§9.1d), and emits
  an `INFO_THINKING_KEPT_ON` `severity:"info"` notice. **Reflect the returned `enabled` and
  surface the info toast; don't hard-block the control.** The inverse (`INFO_THINKING_DISABLED`)
  fires when enabling thinking is incompatible with prior-provider history — same pattern,
  opposite direction. Both are Claude-only; other providers accept either direction freely.

### 9.3 Validation tool

`dawn/scripts/ws_observer.py` — a read-only client that logs in like the WebUI (CSRF →
login → cookie), opens the `dawn-1.0` socket, and dumps every pushed frame. Use it to see
the exact shapes above:
```
DAWN_OBSERVER_PASSWORD=… python3 dawn/scripts/ws_observer.py \
    --get-config --only config,get_config_response,error
```
Password via `$DAWN_OBSERVER_PASSWORD` or a prompt; `--only`/`--attach`/`--compact` flags.
Note it caught a real gotcha we relied on: the `config` frame is emitted from
`queue_init_messages` on connect (a former `send_config_impl` was dead code) — so `config`
is a Tier-A on-connect push, exactly as §3.7 lists it.

### 9.4 Interactive HA board — control verb (#8) + rich attributes (#7) — ✅ SHIPPED (backend)

**Status: both landed on the DAWN backend (`src/webui/webui_homeassistant.c`, `src/tools/homeassistant_service.c`).** The write verb, the rich attributes, and a server-authoritative reconcile are live. The UI can flip its stubbed `send()` to a live one and consume the frames below as specified. Everything is additive/back-compat — an older server just omits `attributes` and rejects the verb.

This section is the **as-built contract**. Where it differs from the original request, the delta is called out inline.

#### #8 — `ha_call_service` (the write path) ✅

One general verb, Admin-only (`conn_require_admin`), same gate as the read verbs.

**Request** — unchanged from the original spec:
```json
{ "type": "ha_call_service",
  "payload": {
     "entity_id": "light.kitchen_table",
     "domain": "light",          // optional; server derives it from the entity_id prefix
     "service": "turn_on",       // required
     "data": { "brightness": 180 }   // optional; passed VERBATIM to HA (see note)
  } }
```

**Response** — `ha_call_service_response`:
```json
{ "success": true, "entity_id": "light.kitchen_table", "error": null }
```
On failure: `{ "success": false, "entity_id": "...", "error": "<reason>" }` (the
`entity_id` field is present on every response except the missing-required-fields one).
`error` is JSON `null` on success, a string on failure. **The exact `error` strings** (so
the UI can branch or surface them):

| `error` string | Cause |
|---|---|
| `"entity_id and service are required"` | one of the two required fields missing/empty (no `entity_id` echoed) |
| `"Not connected"` | HA not reachable (`homeassistant_is_connected()` false) |
| `"Service not permitted"` | the `(domain, service)` pair is not in the server allowlist (see below) |
| `"Invalid service data"` | the `data` object failed to parse server-side (rare; malformed payload) |
| an HA error string | HA itself rejected the call (transport/entity/HA-side failure) |

**`data` is passed to HA verbatim — use HA's own data keys.** The server does not remap;
whatever you put in `data` becomes the HA service body. So send `{ "position": 40 }` for
`cover.set_cover_position`, `{ "brightness": 180 }` for `light.turn_on`, `{ "percentage":
60 }` for `fan.set_percentage`, `{ "hvac_mode": "heat" }` / `{ "temperature": 72 }` for
climate. (`entity_id` is added server-side — don't put it in `data`.)

**⚠️ Server-side write allowlist — the UI can ONLY invoke these `(domain, service)`
pairs.** Anything else HA exposes (`shell_command.*`, `python_script.*`, arbitrary
`automation.trigger`, …) is refused with `error: "Service not permitted"` before any call.
This is a deliberate blast-radius control (a compromised admin session can drive the board
but not run arbitrary HA services). The permitted set **exactly matches the widget map
below** — if you add a controllable domain/service to the UI, the server table
(`HA_BOARD_SERVICES[]` in `webui_homeassistant.c`) **must be extended in the same change**,
or the new widget's `send()` will come back `"Service not permitted"`. Coordinate that edit.

Permitted pairs: `light.turn_on/turn_off`, `switch.turn_on/turn_off`,
`input_boolean.turn_on/turn_off`, `fan.turn_on/turn_off/set_percentage`,
`lock.lock/unlock`, `cover.open_cover/close_cover/set_cover_position`,
`climate.set_hvac_mode/set_temperature`, `media_player.media_play/media_pause`.

**State reconciliation — DONE server-side; the UI does NOT re-poll.** The server closes
the loop on its own. **When realtime (#3) is live (default), a control action produces a
`ha_state_changed` delta** (below) for the changed entity — the same push that reflects an
*external* HA change — so nothing extra is sent on the reconcile path. When realtime is
off/disconnected, the server instead re-polls HA and broadcasts a fresh full
`ha_entities_response`. Either way: keep the optimistic widget flip for snappiness if you
like, but the authoritative truth arrives unsolicited — **just render it**; no
client-orchestrated `ha_refresh_entities` follow-up.

#### Realtime deltas — `ha_state_changed` (#3, SHIPPED backend)

When realtime is on, DAWN pushes an **unsolicited** `ha_state_changed` frame to admin
browsers whenever HA state changes (from any source — a control action, a physical switch,
an HA automation), coalesced (~200 ms) so a scene flip of many entities is **one** frame:

```json
{ "type": "ha_state_changed",
  "payload": { "entities": [
     { "entity_id": "light.kitchen_table", "friendly_name": "Kitchen Table Light",
       "domain": "light", "state": "on", "area": "Kitchen",
       "attributes": { "brightness": 180 } },          // same per-domain shape as #7
     { "entity_id": "sensor.old_thing", "removed": true }  // entity dropped from HA
  ] } }
```

- **Merge by `entity_id`** into your existing entity model: each element is either a full
  entity (same fields + domain-switched `attributes` as an `ha_entities_response` element)
  or `{ entity_id, removed: true }` (drop it).
- **Admin-only**, browsers only (satellites never receive it). Feature-detect the frame
  `type`; a client that ignores it still stays correct via the retained poll backstop.
- **⚠ Bind every string via `textContent` / escaped templating, never `innerHTML`.** These
  fields (`friendly_name`, `state`, `area`, attribute values) are HA-controlled and now
  arrive **unsolicited** (auto-push, no admin gesture) — the daemon JSON-escapes the frame,
  but a hostile HA entity name is still attacker-influenceable text on your DOM.

**Widget map (what the UI sends), by domain:**

| Domain | Widget | `service` | `data` |
|--------|--------|-----------|--------|
| `light` | toggle (+ brightness slider) | `turn_on` / `turn_off` | `{ brightness: 0-255 }` on a slider change |
| `switch`, `input_boolean` | toggle | `turn_on` / `turn_off` | — |
| `fan` | toggle (+ % slider) | `turn_on` / `turn_off` / `set_percentage` | `{ percentage: 0-100 }` |
| `lock` | toggle | `lock` / `unlock` | — |
| `cover` | open/close (+ position slider) | `open_cover` / `close_cover` / `set_cover_position` | `{ position: 0-100 }` |
| `climate` | mode dropdown (+ target temp) | `set_hvac_mode` / `set_temperature` | `{ hvac_mode }` / `{ temperature }` |
| `media_player` | play/pause | `media_play` / `media_pause` | — |
| `sensor`, `binary_sensor`, `weather` | none (display-only) | — | — |

#### #7 — rich `attributes` on `ha_entities_response` ✅

Every `ha_entities_response` entity (from `ha_list_entities`, `ha_refresh_entities`, AND
the reconcile broadcast) now carries a per-entity `attributes` object — **but only the keys
relevant to that entity's domain**, not the flat superset the original spec sketched. If
the whole `attributes` object is absent, render a plain on/off toggle or display row.

**What actually gets emitted, by domain** (this is the real shape — code it against this,
not the original all-keys-in-one-object example):

| Domain | `attributes` emitted | Notes |
|--------|----------------------|-------|
| `light` | `{ "brightness": 0-255 }` | always present for lights. (color_temp/rgb are parsed server-side but **not** emitted yet — brightness only) |
| `fan` | `{ "percentage": 0-100 }` | always present for fans |
| `cover` | `{ "current_position": 0-100 }` | always present for covers |
| `climate` | `{ "hvac_mode"?, "hvac_modes"?: string[], "current_temperature": number, "temperature": number }` | `hvac_mode` omitted if empty; `hvac_modes` (the dropdown options) omitted if none, **capped at 12 entries**; the two temps are always present (doubles) |
| `sensor`, `binary_sensor` | `{ "unit_of_measurement"?, "device_class"? }` | the whole `attributes` object is present **only if at least one** is set; each key omitted individually if empty |
| everything else (`switch`, `input_boolean`, `lock`, `media_player`, `weather`, `scene`, …) | *(no `attributes` key)* | plain toggle / display |

Example (a climate entity):
```json
{ "entity_id": "climate.living_room", "friendly_name": "Living Room",
  "domain": "climate", "state": "heat", "area": "Living Room",
  "attributes": {
     "hvac_mode": "heat",
     "hvac_modes": ["off","heat","cool","auto"],
     "current_temperature": 71,
     "temperature": 72
  } }
```

Treat every `attributes` key as optional and feature-detect — presence is domain- and
value-dependent per the table. An older server omits `attributes` entirely (falls back to
the on/off board).

---

### 9.5 Document library — the Library panel (#9) — consumer contract + backend ask

> ⚠️ **Undocumented family.** The entire `doc_library_*` request family is implemented in
> DAWN (`src/webui/webui_doc_library.c`, dispatch `webui_message_dispatch.c`) but is **absent
> from `WEBSOCKET_PROTOCOL.md`**. Everything below was read from that C source, not the
> protocol doc — flag the gap to whoever owns the protocol doc.

The Library panel (`src/library/`) consumes exactly one verb, **read-only**:

**Request** `doc_library_list` — `{ limit?, offset?, scope?, query? }`. Omitting `scope`
returns notes + documents together; `query` runs a BM25 label/body search. (The panel omits
`show_all`, the admin-only all-users extension.) The panel does **not** wire any of the
library WRITE verbs (`doc_library_note_save`/`note_update`, `doc_library_delete`,
`doc_library_index`, `doc_library_toggle_global`, `doc_library_version_restore`).

**Response** `doc_library_list_response` — `{ success, count, has_more, documents[] }`. Each
`documents[]` row (as read from the serializer):

| Field | Meaning |
|---|---|
| `id` | int64 document/note id |
| `filename` | note label, or the document's filename |
| `filetype` | `"note"` for notes, else the extension (`pdf`/`txt`/`md`/`docx`/…) |
| `is_note` | bool |
| `text` | **notes only** — the full note body inline (single chunk, ≤4096 B). Absent for documents. |
| `num_chunks` | int |
| `is_global` | bool (shared) |
| `created_at` | int64 epoch seconds |

So **notes read fully today** (body inline → rendered as markdown). A **document's body is
not on the wire**: the row is metadata only. The original file *is* served over HTTP at
`GET /api/documents/original/<blob_id>` (a plain read; `Content-Disposition: attachment` +
`nosniff` govern a browser *navigation*, not a `fetch()`), but the list response **never
carries the blob id**, so the client cannot construct that URL.

**Size:** the row carries `num_chunks` but **no byte size**. The panel shows `num_chunks`
as a rough proxy (e.g. "28 parts") for documents and the exact body byte size for notes. A
real per-row **`size_bytes`** is still deferred (it needs a schema migration) — the two
readability pieces below shipped without it.

**Shipped (#9a/#9b, additive + read-only, 2026-08-13):**
- **`original_blob_id` + `has_original`** on each document row of `doc_library_list_response`
  (`webui_doc_library.c` reads it via `document_db_get_original_blob_id()`, an isolated query
  that leaves the shared `row_to_document`/list SELECTs untouched). **Emitted only for docs
  the requester owns** — the blob download (`doc_can_read`) is owner-only, so advertising it on
  a listed *global* doc would offer a download the server always refuses.
- **`doc_library_get {id}`** → `doc_library_get_response` `{ success, id, filename, filetype,
  text }`; owner-scoped and requires stored full text (v63+). A missing, non-owned/global, or
  legacy doc returns one generic `success:false` `error:"Document unavailable"` (id echoed on
  every branch for correlation) — deliberately indistinguishable, so the verb is not a
  document-existence oracle. A payload-less frame gets `"Missing document id"` (never silently
  dropped).

With those, the reader opens a document by priority:
1. a **txt/md upload** → fetch `original_blob_id` via the same-origin `/api` proxy, render inline (exact original);
2. **otherwise** → `doc_library_get` reassembled full text, rendered as markdown (covers generated docs + extracted pdf/docx text); if a binary original also exists, a download is offered alongside;
3. **binary with no readable text** → download the original;
4. **nothing readable** (no full text, no original) → a metadata-only "No preview available" state.

Both reads route through the ingest boundary (`Ingest.fetchDocumentOriginal` over HTTP,
`Ingest.getDocumentText` promise-correlated over the WS), never issued from the view, so the
single-DAWN-boundary rule holds. Bind every row string via `textContent`; fetched/reassembled
text is untrusted (markdown → `renderMarkdown`/DOMPurify, plain text → `textContent`).

**Why both shipped (live finding, 2026-08-13).** Verified against a real library: the bulk of
documents are DAWN-*generated* text (research reports, agendas) with **no uploaded original**, so
`original_blob_id` alone would leave them metadata-only — `doc_library_get` (reassembled full
text) is what makes them readable. `original_blob_id`/`has_original` covers uploaded files (exact
original: txt/md render, any-type download). Together they cover both classes.

---

### 9.6 Consumed this session (Context panel, attachments, session-continuity) — 2026-08-21

Three consumer surfaces wired against DAWN, all verified live.

**a. Context panel (`src/context/`) — the "why did it say that" surface.** Consumes the pushed
`context_injection` frame (§3.2), which is **FLAT AT THE ROOT** (no `payload` wrapper - the earlier
doc implied one; verified in `webui_broadcasts.c`). Scoped server-side to the connection's active
conversation, so it only ever shows the conversation on screen. Each item's unique key is
**`item_id`** (`"fact:8502"`), NOT `source_id` (that is the adapter's per-CATEGORY static string,
not unique per row). **Cited-row gold:** a paired **`context_citations`** frame (also flat at root:
`{conversation_id, turn_id, cited_item_ids[]}`), emitted at turn END, golds the rows the model
actually cited. Match on **`turn_id` alone** (`last_user_msg_id`, globally unique) - the two frames
can derive `conversation_id` from different fields and disagree in a ~47ms fresh-chat window.
DAWN also added: `item_id` on each `context_injection` row, and a `<cited>` streaming leak-fix.

**b. Conversation attachments (upload + display).** No structured attachment field and NO `image_url`
frame - attachments ride the message text as inline markers.
- **Documents:** `POST /api/documents` (multipart field `document`) -> `{filename, content
  (extracted text), size, type, original_blob_id?}`; inline into `payload.text` as
  `[ATTACHED DOCUMENT: name (N bytes) blob:id]\n<content>\n[END DOCUMENT]`. Daemon persists it as
  ordinary text (`vision_image_count==0`).
- **Images:** `POST /api/images` (multipart field `image`, client-compressed to ≤1024px JPEG) ->
  `{id, mime_type, size}`. On the turn frame send `payload.images[]` (base64, for the live LLM) PLUS
  the **MANDATORY order-matched `payload.image_ids[]`** (map off the (base64,id) upload pairs, never
  a display view). Daemon persists `\n[IMAGE:<id>]` markers per id and rehydrates them into the LLM
  on reload. **Gate image attach on a vision-capable model** (`get_config` `llm.cloud/local.vision_enabled`,
  resolved by active mode). Fails SAFE-and-silent on a bad id (persists text-only) - the tell is the
  daemon log `WebUI: ignoring invalid image_id in turn frame`.
- **Display:** parse `[IMAGE:img_id]` (fetch `GET /api/images/:id`) + `[ATTACHED DOCUMENT: … blob:id]`
  markers out of message text (`src/conversation/attachments.ts`); images render inline (lightbox),
  documents as chips (download original or view extracted text). All strings via `textContent`.

**c. Session-continuity (Tier-1 one-connection-per-session).** DAWN binds one live connection per
session; a second tab evicts the first with a **`session_superseded` frame then WS close `4001`**
(§3.7). The dev proxy strips the `4001` code to `1006`, so the FRAME is the reliable takeover signal.
Client: back off on `session_superseded`/`4001` (no auto-reconnect), show "Use DAWN here", reclaim
only on the gesture; a reclaim does a full re-rendering `load_conversation` to catch the transcript
up. The `session` frame's **`reconnected`** flag drives fresh-session context restore (§3.7). Daemon
side: a close-handler ownership guard + clean reconnect-eviction + pong-to-the-pinging-socket.

---

### 9.7 OpenRouter as a first-class per-session provider (MODEL panel, 2026-08-23)

DAWN promoted OpenRouter from a global gateway to a **first-class per-session provider**, and Aurora
now consumes it as a 4th peer alongside OpenAI / Claude / Gemini. Coordinated with the DAWN-side
agent; verified live end to end.

**What changed on the wire (all additive, back-compat):**
- **`openrouter_available`** now ships from all four runtime builders: `get_config`'s `llm_runtime`,
  `llm_state_update`, and both `set_session_llm` response builders (alongside the existing
  `openai/claude/gemini_available`).
- The curated model list is on the wire in the on-connect config block:
  **`config.llm.cloud.openrouter_models`** (a string[]) + **`openrouter_default_model_idx`** (int).
  It is operator-curated in `dawn.toml`; DAWN deliberately does NOT enumerate OpenRouter's full
  catalog.
- **The `use_openrouter` gateway bool is RETIRED.** DAWN folds a legacy `use_openrouter=true` into
  `provider="openrouter"` via a load-time `config_migrate()`; the resolve predicate now keys on the
  `CLOUD_PROVIDER_OPENROUTER` enum. **Do NOT read `use_openrouter`** (Aurora never did); the enum is
  the single source of truth for "are we on OpenRouter?"

**What Aurora consumes (MODEL panel, `src/model/`, `src/ingest/dawn-ws.ts`, `src/menu/`):**
- `openrouter` is a value of `LlmProvider`; an `isLlmProvider()` guard replaced the old silent
  coerce-unknown-provider-to-`claude` in every intake path (get_config, llm_state_update,
  set_session_llm_response echo, load_conversation). An unknown provider is rejected loudly, never
  mislabeled.
- Reads `openrouter_available` + `openrouter_models` + `openrouter_default_model_idx`; switches via
  `set_session_llm {provider:"openrouter"}` and snaps to the operator's configured default index on
  switch (parity with the old WebUI).
- **Model strings are kept verbatim.** OpenRouter models are vendor-slugs (`openai/gpt-5.5`) and are
  never rewritten for display or on the wire. `effortOptionsForModel()` strips the vendor prefix
  **detection-only** to pick the right gpt-5.x effort tiers. DAWN keeps a permanent bare-id→slug remap
  on its request path for legacy stored bare ids.
- On conversation restore, the conversation is authoritative about its own stored provider:
  `applyConvLlmSettings()` reads `cloud_provider`/`model`/reasoning out of
  `load_conversation_response`'s `llm_settings` and reflects them (this also fixed the earlier
  "stale connect-time snapshot" bug where the panel showed the connect default instead of the loaded
  conversation's real provider/model).

**Charter note (why there is no editor here):** Aurora surfaces + selects OpenRouter models (a
per-session `set_session_llm`, a sanctioned write). It does **not** build a model-list *editor*,
because curating `openrouter_models` in `dawn.toml` is a config write, an admin function that is over
Aurora's read-mostly line; that editor lives in the old WebUI (DAWN's admin panel).

---

**Original item write-ups (source cites preserved):**

1. **`llm_runtime` should include `thinking_mode` and `reasoning_effort`.** ✅ Done (§9.1a).
   `get_config`'s `payload.llm_runtime` (`webui_config.c`) carried the session's resolved
   `type` / `provider` / `model` / `*_available` / `context_max`, but NOT the two reasoning
   fields — so a UI could only show the *config default*. Now serialized from the resolved
   config.

2. **A Home Assistant state-change push** (e.g. an `ha_state_changed` broadcast). ⏸ Deferred
   (SAGE). HA is request/response only today (`ha_list_entities`), so an HA panel must
   poll + diff. DAWN does not subscribe to HA's own `state_changed` stream; rebroadcasting it
   would give crisp, low-latency ambient spikes. See the alerts scope below.

3. **Calendar / email content feeds.** ✅ **Calendar done** (§9.1g) — `calendar_upcoming_events`
   pull + `calendar_events_changed` refetch push; a live calendar/agenda panel is buildable now.
   **Email pull still deferred** (`email_recent`-style request not yet added); calendar *proactive*
   notices (vs. the refetch nudge) remain SAGE. §5.

4. **The `error` frame needs a real severity.** ✅ Done via option (b) — added a `severity`
   field (§9.1b). DAWN sent purely informational notices as `error` frames with hardcoded
   `recoverable: true`; the hero UI had to sniff the `INFO_` code prefix. Now `severity` ∈
   `info | warning | error`; `recoverable` retained for back-compat.

5. **Advertise the dedicated music-stream port.** ✅ Done (§9.1c). The `dawn-music` server
   listens on `webui_server_get_port() + 1`, never announced; the `config` frame now carries
   `music_port` + `music_enabled`.

6. **`music_control` bare `play` should start a stopped session.** ✅ Done (§9.1f). A bare
   `play` used to only resume a pause (`webui_music_handlers.c` ~L334-343); on a stopped
   session it silently echoed state, so a "press play" button looked dead until the client
   sent `play_index`. Now a bare `play` on a stopped-with-non-empty-queue session starts the
   current `queue_index` track (clamped into range), following the same queue→state lock
   discipline as `next`/`previous`. Empty queue still echoes state.

The broad version of #2/#3 — a backend proactive-alert system feeding one alert
channel — is scoped in `dawn/docs/PROACTIVE_ALERTS_SCOPE.md` (extend SAGE).

### 9.8 Watches panel (SAGE watch rules) - consumed 2026-08-24 (Phase 1)

The Watches board (`src/watches/`) parallels the HA board over the SAGE watch API. Verified
against `dawn/src/webui/webui_attention.c` + `attention_catalog.c`.

- **Read (poll):** `{type:"watch_list"}` → `watch_list_response` `{success, error?,
  attention_enabled, watches[], catalog[]}`. **Poll-only - no push**; a watch *firing* arrives
  via `attention_alert` / `silent_observation` (already consumed). Each `watches[]` row carries
  `id/name/metric/label/unit/rule_type/direction/threshold?/absence_after_sec/notify/enabled/
  source/has_current/current?` - `threshold`/`current` are omitted when non-finite (read
  independently of `has_current`); `unit` is literal UTF-8 (`°C`). A **failed** list carries
  `{success:false, error}` ONLY (no watches/catalog/attention_enabled) - the panel keeps the
  last rows + shows the error, never an empty state. `catalog[]` is `{key,label,unit}` only (no
  `rule_type`/defaults - a Phase-2 gap; see below). Ingest polls it on connect + a 30s backstop.
- **Write (Phase 1):** `watch_set_enabled {id, enabled}` → `watch_set_enabled_response
  {success, error?}`. A **benign per-watch flip** (sanctioned deliberate-user-action class, like
  `set_pinned`); gated on link-liveness, and the ingest re-lists on the response to reconcile
  (server-authoritative). Grouped in the panel by **metric family** (the `metric` key prefix:
  `stat.*`/`suit.*`/`component.*` → System/Suit/Components), NOT the watch `source` tag (that is
  provenance - seed/other).
- **Display-only:** `attention_enabled` = DAWN's GLOBAL `g_config.attention.enabled`. The panel
  surfaces a disarmed note ("enable in DAWN settings") but never toggles it - that is a
  `set_config`, over the read-mostly line. (Matches the backend author's intent, per the
  `webui_attention.c` comment.)
- **Phase 2 (shipped):** `watch_add {metric}` (one-watch-per-metric upsert; DAWN templates the
  catalog defaults), `watch_update {id, direction?, threshold?, notify?}` (the edit modal sends
  the FULL field state to avoid clobbering catalog-default resets), and confirm-gated
  `watch_remove {id}`. Chosen the **no-backend add-then-edit flow** (the wire catalog is
  `{key,label,unit}` only - no `rule_type`/defaults): add sends just `metric`, then the panel
  opens the fresh row's edit form (which carries the resolved `rule_type`/values) so the user
  can set the threshold. `absence` watches take a `threshold` override that maps to
  `absence_after_sec` (0..604800) - the edit form shows a "silent for N seconds" field for them.
  Enums: `direction` ∈ above|below|rising, `notify` ∈ alert|ambient|digest. Max 64 watches/user
  (`SAGE_MAX_WATCHES_PER_USER`). *(Optional future polish: a catalog-defaults backend ask would
  enable a one-step add form instead of add-then-edit.)*
- **Backend-doc gap:** the whole `watch_*` family is **absent from `WEBSOCKET_PROTOCOL.md`**
  (same class as the `doc_library_*` gap in §9.5) - flag to the protocol-doc owner.

### 9.9 Living tool pills (`tool_step` + reload rehydration) - consumed 2026-08-29

The conversation surface (`src/conversation/`, driven by `src/ingest/dawn-ws.ts`) renders tool use
as an ordered run of per-call **expandable pills**, consistent across three paths: live own-turn,
live bystander, and reload. Verified against `dawn/src/webui/webui_broadcasts.c`
(`webui_broadcast_tool_step`), `event_payload.c`, `webui_history.c`, `llm_tool_loop.c`.

- **Live push - `tool_step` (Tier A):** `{conversation_id, stream_id, kind:"tool_call"|"tool_result",
  payload}`. `payload` is an **opaque, redacted JSON string** (same redaction as the jobs
  observe-stream - untrusted, bind via `textContent`) carrying `{tool, tool_call_id, iter, args}`
  (tool_call) or `{tool, tool_call_id, result}` (tool_result). `tool_call_id` lives INSIDE the
  payload (byte-identical to `load_conversation`'s key); `iter` is the 0-based tool-loop iteration
  index (present when ≥0, omitted otherwise). `stream_id` is informational - key nothing on it.
- **Origin inclusion is capability-gated.** By default the origin is EXCLUDED (`tool_step` is for a
  bystander watching a conversation it did not start). A client that advertises **`tool_step_origin:
  true`** on its `init`/`reconnect` handshake (a flat bool, sibling to `tts_enabled`/`use_opus`) also
  receives its OWN turn's `tool_step`. Aurora sets it - it has no stream-derived tool render, so this
  is its only live tool signal. Stock www leaves it off (it renders tools inline from its stream) to
  avoid a double-render. This is a benign RECEIVE-capability hint (asks for more inbound data), not a
  control write - within the read-mostly charter, same class as `tts_enabled`.
- **Reload rehydration:** `load_conversation` assistant rows carry a SEPARATE **`tool_calls`** field
  (OpenAI array `[{id, type, function:{name, arguments}}]`), NOT inside `content`; `role:"tool"` rows
  carry `tool_call_id` + `content` (the result). Aurora's `parseToolCalls` builds ordered `ToolCall[]`
  and correlates results by `tool_call_id` - the SAME key as the live path, so ONE pairing
  implementation covers both. (interpretMessage's content-block `tool_use` is now a legacy, name-only
  fallback - the current daemon puts tools in `tool_calls`.)
- **Grouping:** one pill group per tool-loop iteration. Live seals a group when `iter` changes (in
  addition to the existing `stream_start` seal); reload seals per assistant message. A tool-loop
  iteration maps 1:1 to one persisted assistant message (`persist_appended_tool_turn` runs once per
  iteration), so live per-iter and reload per-message grouping agree.
- **View:** ordered per-call pills, **collapse-when-many** to an "N tools" summary, **click-to-expand**
  each pill to colour-coded CALL (args, teal `--accent`) / RESULT (cool-blue `--cool`) sections. Every
  tool string reaches the DOM via `textContent`; detail capped at 4KB.
- **No tool success/error status on the wire (green/red PARKED).** `tool_result` is an opaque string;
  DAWN does not structurally distinguish a failed tool from a success (both are strings), and a text
  heuristic would mislabel. Both clients render a single NEUTRAL "done" tone. Real green/red needs a
  daemon-plumbed status (bool/enum on `tool_result` AND persisted on the `role:tool` row so reload
  agrees); parked pending a backend greenlight. A CSS rail is staged on both clients for when it lands.
- **Backend doc:** the `tool_step` frame is now written up in DAWN's `WEBSOCKET_PROTOCOL.md`.

*Last mapped against source: 2026-07-28. Backend-TODO added 2026-07-30; music items
(#5, #6) added 2026-07-30 while wiring the dedicated audio socket. §9.1–9.3 added
2026-07-30 recording items #1/#2/#5 shipped + the reasoning-control behaviour and
validation tool. Hero UI consumed #1/#2/#5 (verified against `webui_config.c` /
`webui_send.c` / `webui_message_dispatch.c`) 2026-07-30. Item #6 shipped 2026-07-30
(commit on `background-jobs-p2-observe`); §9.1f added. **#4 calendar pull + push shipped
2026-07-31** (§9.1g; `calendar_upcoming_events` + `calendar_events_changed`, per-event
`calendar_id` added at the consumer's request); email pull + #3 HA push remain deferred.
**#7 rich HA attributes + #8 `ha_call_service` shipped 2026-08-01** (§9.4; domain-switched
`attributes`, admin-only write verb with a server-side `(domain,service)` allowlist +
server-authoritative reconcile broadcast). **#3 HA `ha_state_changed` realtime push shipped
2026-08-01** (§9.4; live delta, merge-by-`entity_id`, admin-only). **WS Origin/CSRF check
shipped 2026-08-01** — the WS upgrade is same-origin-checked, closing the cross-origin
admin-cookie ride into the allowlisted `lock`/`cover` writes (browser-shaped origins matched
vs Host; `null`/opaque rejected; native no-Origin clients allowed). The HA board is fully
real-time + hardened. Still deferred: the SAGE *proactive-alert* side of #2/#3 (vs the board
push, which shipped). **Library panel wired 2026-08-13** (§4 + §9.5; consumes the
undocumented `doc_library_list` — notes read inline, documents list as metadata; **#9
requested**: add `original_blob_id`/`has_original` so document bodies render/download).*
**Context panel + cited-gold, conversation attachments (image/document upload + inline
display), and the Tier-1 one-connection-per-session takeover + fresh-session context restore
all shipped 2026-08-21 (§9.6; coordinated with the DAWN + in-repo-WebUI changes: `item_id` +
`context_citations` + `<cited>` leak-fix, `payload.image_ids[]` persistence, and the
`session_superseded` frame / `reconnected` flag / `4001` eviction).*
**OpenRouter promoted to a first-class per-session provider consumed 2026-08-23 (§9.7; coordinated
with the DAWN 2a-0→2a→2b arc: `openrouter_available` on all four runtime builders, curated
`config.llm.cloud.openrouter_models` + `openrouter_default_model_idx`, the `use_openrouter` gateway
retired via `config_migrate()` so the `CLOUD_PROVIDER_OPENROUTER` enum is the sole authority; Aurora
treats it as a 4th provider with verbatim vendor-slug model strings; picker only, no config editor).*
**Living tool pills consumed 2026-08-29 (§9.9; the `tool_step` push - `tool_call`/`tool_result` with an
opaque payload carrying `tool`/`tool_call_id`/`iter`/`args`/`result` - plus the `tool_step_origin`
handshake opt-in for origin inclusion, and reload rehydration from the `tool_calls` column +
`role:tool` rows paired on `tool_call_id`; ordered per-call expandable pills, collapse-when-many,
per-iteration grouping. Coordinated with the DAWN + stock-www halves; both clients at parity. Green/red
tool status deferred pending a daemon-plumbed signal.)*
