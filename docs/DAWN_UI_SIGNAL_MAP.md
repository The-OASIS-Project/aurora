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
| `silent_observation` | `ts`, `category`, `note`, `filter_match` | A quieter rail-icon / peek primitive. WebUI-only; satellites never get it. |
| `context_injection` | `conversation_id`, `turn_id`, `items[]` (each `source_id`, `source_type` ∈ internal \| external \| user-content, `text`, score breakdown) | What DAWN pulled into context for a turn. Rich, for a "why did it say that" surface. |
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
| `session` | Token + auth state. Sent on connect/reconnect. |
| `config` | WebUI config (`audio_chunk_ms`). Sent after `session`. |
| `force_logout` | Server revoked your session. Reason in payload. |
| `conversation_reset` | Context was reset via a tool. |
| `image_url` | A rehydrated image reference in a message (vision). |

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

---

## 5. Panel feasibility — what you can actually build today

This is the payoff. For each ambient panel the hero UI scaffolds, what does the
current WebSocket actually support?

| Panel | Event trigger (Tier A) | Content feed (Tier B) | Verdict |
|-------|------------------------|-----------------------|---------|
| **Music (now-playing)** | `music_state` / `music_position` push | `music_library` etc. | ✅ **Fully wireable now.** Rich push, complete state. |
| **Subsystems / health** | `metrics_update` push | `get_metrics` snapshot | ✅ **Fully wireable now.** |
| **Home Assistant** | *(none — no push)* | `ha_list_entities` (real states) | ✅ **Wireable now — built.** Hero UI's HA board (`src/homeassistant/`) polls `ha_refresh_entities` on a 30s interval (+ manual refresh), groups by `area`, lights active states and dims idle ones, and diffs poll-to-poll to briefly spike a changed row (poll-granularity today; upgrades to real-time when the §9 #3 push lands, no client rework). Read-only. |
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
(`create_user`, `delete_user`, ...), memory deletes, `set_tts_enabled`. The one
soft exception is the conversation console's `text` submit, which the hero UI
already treats as an explicit user-initiated action, not ambient control.

The binary audio path (`AUDIO_IN 0x01`, `AUDIO_OUT 0x11`, Opus encode/decode) is
its own phase and is deferred; the reactor's FFT bars run on a state-scaled
stand-in until that lands.

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
| 3 | Home Assistant `state_changed` push | ⏸ **Deferred** — SAGE P1/P2 (`PROACTIVE_ALERTS_SCOPE.md`). HA board polls + diffs meanwhile (30s); the push turns that real-time with no client rework |
| 4 | Calendar / email content feeds | ✅ **Calendar shipped + consumed** — hero UI's calendar card reads `calendar_upcoming_events` (today's window in the user's tz) + `calendar_list_my_calendars` for the color map, and refetches on the `calendar_events_changed` push. §9.1g. **Email pull still deferred**; calendar *proactive* push (vs. this refetch nudge) is still SAGE |
| 7 | Rich HA entity attributes in `ha_entities_response` | ✅ **SHIPPED (backend)** — per-entity `attributes` object, **domain-switched** (only the keys relevant to the entity's domain, not a flat superset): `brightness` (light), `percentage` (fan), `current_position` (cover), `hvac_mode`/`hvac_modes`/`current_temperature`/`temperature` (climate), `unit_of_measurement`/`device_class` (sensor). Emitted on all three `ha_entities_response` sources (list/refresh/reconcile). Additive; absent ⇒ on/off fallback. Exact per-domain shape in §9.4 |
| 8 | HA entity control verb — `ha_call_service` | ✅ **SHIPPED (backend)** — admin-only general verb (`entity_id`/`domain`/`service`/`data`). Server enforces a **write allowlist** (only the board's widget services; anything else ⇒ `"Service not permitted"`) and does **server-authoritative reconcile** (re-polls HA on success and broadcasts a fresh `ha_entities_response` — the UI just renders it, no client re-poll). `data` passed verbatim to HA. UI can flip its stubbed `send()` to live. Full contract + error strings + allowlist in §9.4. **NB:** adding a controllable domain to the UI requires extending the server allowlist (`HA_BOARD_SERVICES[]`) in the same change |

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

**State reconciliation — DONE server-side (option b); the UI does NOT re-poll.** On a
successful call the server re-polls HA and **broadcasts a fresh `ha_entities_response`**
(the same frame shape as a poll, full entity list) to the acting admin's browser sessions.
So the loop closes on its own: keep the optimistic widget flip for snappiness if you like,
but the authoritative truth arrives as an unsolicited `ha_entities_response` you already
handle — **just render it**. No client-orchestrated `ha_refresh_entities` follow-up is
needed. (The reconcile is entity-only server-side, so it's cheap; the deferred `#3`
`ha_state_changed` per-entity push would later replace the full-list broadcast with a
targeted delta, with no UI rework.)

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
server-authoritative reconcile broadcast). The interactive HA board is buildable now — flip
the stubbed `send()`. Still deferred: #3 HA `ha_state_changed` push (SAGE) and the WS
Origin/CSRF check that would harden the allowlisted `lock`/`cover` writes against a
cross-origin admin-cookie ride.*
