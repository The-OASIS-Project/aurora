/*
 * The ingest boundary (brief S7.4). This is the ONE seam between DAWN and the
 * whole UI. Everything DAWN pushes fans out to exactly four sinks:
 *
 *   store        -> ambient panel elements (calendar, email, HA, subsystems, ...)
 *   reactor      -> the center anchor's state + signals (voice/throughput/etc)
 *   conversation -> the living response
 *   telemetry    -> the HUD readout
 *
 * The point: the fake StubIngest and the real DAWN WebSocket client are two
 * implementations of the SAME `Ingest` interface writing to the SAME sinks, so
 * wiring DAWN is dropping in one file, not editing four. Nothing above ingest
 * knows whether the data is real.
 */

import type { ReactorState } from "../anchor/anchor.ts";
import type { Store } from "../state/store.ts";

/* Voice-input control surface, re-exported through the ingest boundary so consumers bind
   to one seam (getMicControl returns a MicControl) rather than reaching into src/audio. */
export type { MicControl, MicCaptureState } from "../audio/mic.ts";

/* What ingest can drive on the center reactor (the Anchor satisfies this). */
export interface ReactorSink {
   setState(state: ReactorState): void;
   setLevels(bins: Float32Array | null): void;
   setStrain(load: number): void;
   setHesitation(load: number): void;
}

/* What DAWN is doing right now, distilled from the `state` frame for the activity
   chip. `tone: "alert"` is the warm/needs-you channel (errors); everything else is
   the cool nominal channel. `detail` carries the specifics (e.g. the tool name). */
export interface ActivityStatus {
   label: string;
   detail?: string;
   tone?: "alert";
}

/* One entry in a loaded transcript: a text turn, a tool-use chip, or both (a turn
   that spoke and then called a tool). `tools` is the tool names invoked, rendered as
   compact chips instead of the raw tool_use JSON DAWN persists in history. */
export interface ConversationItem {
   role: "user" | "assistant";
   text?: string;
   tools?: string[];
}

/* What ingest can push to the conversation console (a passive view). Streaming
   replies arrive as startReply -> appendDelta* -> endReply; a complete message
   (non-streamed or replayed history) arrives as showReply. */
export interface ConversationSink {
   setThinking(thinking: boolean): void;
   startReply(): void;
   appendDelta(delta: string): void;
   endReply(): void;
   showReply(text: string): void;
   /* A user turn from DAWN (a voice transcript). Typed turns are appended locally on
      submit, so this is only for spoken input echoed back by the daemon. */
   showUser(text: string): void;
   /* A tool call surfaced as a compact chip (the tool names), not raw tool_use JSON. */
   showToolUse(tools: string[]): void;
   /* The configured assistant display name (ai_name), for the reply header. */
   setAssistantName(name: string): void;
   /* Replace the transcript with a loaded conversation's history (oldest first). */
   loadHistory(items: ConversationItem[]): void;
   /* A tool reset the conversation — empty the surface. */
   clear(): void;
   /* Current activity (thinking / using tools / ...) or null to clear it. */
   setStatus(status: ActivityStatus | null): void;
}

/* One conversation's metadata for the picker list (a camelCased mirror of DAWN's
   conversation object from list_conversations / search_conversations). `id` is a DB
   AUTOINCREMENT integer (small, monotonic - never near 2^53, so a JS number is exact;
   the write verbs assume this). `origin` ∈ webui | voice | briefing | messaging:<provider>. */
export interface ConversationMeta {
   id: number;
   title: string;
   createdAt: number; // epoch seconds
   updatedAt: number; // epoch seconds
   messageCount: number;
   isArchived: boolean;
   isPrivate: boolean;
   isPinned: boolean;
   origin: string;
}

/* What ingest can push to the conversation picker (a request/response panel, like the
   calendar/HA boards - it is NOT ambient store state). `setList` replaces or appends a
   page; `searching` marks a search result set (vs the plain list) so the panel can guard
   a stale late response. `setActive` reflects which conversation the transcript is showing
   and clears that row's unread mark. The mark* methods are driven by DAWN pushes. */
export interface ConversationListSink {
   setList(
      items: ConversationMeta[],
      opts: { total?: number; append: boolean; searching: boolean }
   ): void;
   setActive(id: number): void;
   markRenamed(id: number, title: string): void; // tolerate an unknown id (no-op)
   markAppended(id: number): void; // a non-active conversation got a new message -> unread
   /* The user's IANA tz (from DAWN), so date grouping matches the clock, not the box. */
   setTimezone(tz: string): void;
}

/* What ingest can push to the HUD telemetry readout. */
export interface TelemetrySink {
   update(values: Record<string, string>): void;
   /* The user's IANA timezone (from DAWN), so the clock shows their local time. */
   setTimezone(tz: string): void;
}

/* One track's metadata, from music_state.track (null when the queue is empty). */
export interface MusicTrack {
   path: string;
   title: string;
   artist: string;
   album: string;
   durationSec: number;
}

/* DAWN's music playback state, distilled from a music_state frame. */
export interface MusicState {
   playing: boolean;
   paused: boolean;
   track: MusicTrack | null;
   positionSec: number;
   durationSec: number;
   queueLength: number;
   queueIndex: number;
   shuffle: boolean;
   repeatMode: number; // 0 none | 1 all | 2 one
   volume: number; // server-stored hint; real gain is client-side
   quality: string;
   bitrate: number; // Opus target bits/sec
   sourceFormat: string;
   sourceRate: number;
}

/* What ingest can push to the music player view (a passive view; transport is
   sent back out via Ingest.musicControl). */
export interface MusicSink {
   setState(state: MusicState): void;
   setPosition(positionSec: number, durationSec: number): void;
   setError(message: string): void;
}

/* One of the user's active calendars (calendar_list_my_calendars): the id->{name,
   color} map a panel needs to group/color events. `color` is a raw CalDAV value
   (e.g. "#3b82f6"); the view validates it before using it as a color. */
export interface CalendarInfo {
   id: number;
   name: string;
   color: string;
}

/* One occurrence from calendar_upcoming_events. `start`/`end` are epoch seconds
   (timed events); for all-day events read `startDate`/`endDate` (YYYY-MM-DD).
   `calendarId` maps to a CalendarInfo for the color dot. */
export interface CalendarEvent {
   id: number;
   calendarId: number;
   summary: string;
   location: string;
   start: number;
   end: number;
   allDay: boolean;
   startDate: string;
   endDate: string;
   cancelled: boolean;
   isOverride: boolean;
}

/* What ingest can push to the calendar panel (a passive view). The calendar map
   and the event list arrive separately (two requests) and refresh together on the
   calendar_events_changed push. */
export interface CalendarSink {
   setCalendars(calendars: CalendarInfo[]): void;
   setEvents(events: CalendarEvent[], truncated: boolean): void;
   /* The user's IANA timezone (from DAWN), so event times render in the user's local
      time to match the clock, not the browser box's timezone (which may be UTC). */
   setTimezone(tz: string): void;
}

/* Per-entity attributes that drive the richer widgets (brightness slider, climate
   dropdown, etc). All optional: DAWN emits only the keys relevant to the entity's
   domain, and older servers omit `attributes` entirely, in which case the board falls
   back to a plain on/off toggle. See signal-map §9.4 (#7). */
export interface HAAttributes {
   brightness?: number; // light, 0-255
   percentage?: number; // fan, 0-100
   position?: number; // cover, 0-100 (from current_position)
   hvacMode?: string; // climate, current mode
   hvacModes?: string[]; // climate, the dropdown's options
   currentTemp?: number; // climate, reading
   targetTemp?: number; // climate, target
   unit?: string; // sensor, unit_of_measurement (for the readout)
   deviceClass?: string; // sensor/binary_sensor
}

/* One Home Assistant entity from ha_list_entities. `domain` (light | switch |
   climate | lock | sensor | ...) drives grouping / the widget kind; `area` is the
   room name ("" when the entity isn't assigned to an area in HA). `state` is a raw
   string ("on" / "off" / "locked" / a bare number). `attributes` is present once
   DAWN ships §9.4 (#7); absent it, the board stays on/off toggles. */
export interface HAEntity {
   entityId: string;
   name: string;
   domain: string;
   area: string;
   state: string;
   attributes?: HAAttributes;
}

/* A control intent from an HA widget: mirrors HA's own service model. Sent by the
   board's toggles/sliders/dropdowns; `data` carries service params (brightness,
   hvac_mode, position, ...). See signal-map §9.4 (#8). This is a deliberate,
   user-initiated Tier-C write, like music transport - not ambient control. */
export interface HAServiceCall {
   entityId: string;
   domain: string;
   service: string;
   data?: Record<string, unknown>;
}

/* Connection status for the board's header (ha_status, or inferred from a failed
   poll). `configured` false => HA isn't set up at all; `connected` false with
   `configured` true => set up but the daemon can't reach it right now. */
export interface HAStatus {
   configured: boolean;
   connected: boolean;
   error?: string;
}

/* What ingest can push to the Home Assistant board (a passive, read-only view).
   HA has no push feed yet (SAGE item #3), so ingest polls and hands over the whole
   entity set each update; the panel diffs it to briefly emphasise changed rows. A
   future ha_state_changed push merges upstream into the same snapshot, so this sink
   never changes. Status arrives separately so "offline" is distinct from "no
   entities on". */
export interface HASink {
   setEntities(entities: HAEntity[]): void;
   setStatus(status: HAStatus): void;
}

/* A transient attention card: a proactive alert, a ringing alarm, a job/observation
   toast. `tone:"attention"` is the warm needs-you channel. `persist` marks a needs-you
   notice that settles to a quiet float instead of auto-dismissing when left unsnapped.
   `hold` is seconds fully visible before an unsnapped toast begins to fade. `x`/`y` are
   the abstract default spot (-1..1) the card first appears at, until the user moves or
   snaps it (after which its own persisted position wins). */
export interface Notice {
   id: string;
   kind: string;
   summary: string;
   detail?: string;
   /* A list body (e.g. the active-jobs card's job titles), rendered under the summary. */
   items?: string[];
   tone?: "nominal" | "attention";
   persist?: boolean;
   hold?: number;
   /* A persistent status widget (the jobs card), not a transient toast: always full
      presence, never fades or auto-dismisses, and has no close control - it is shown
      while relevant and removed via `remove` when not. Still movable/snappable like the
      instruments. `persist`/`hold`/`tone` transient fields are ignored when sticky. */
   sticky?: boolean;
   x: number;
   y: number;
}

/* What ingest can push to the notification layer. Notices are self-owned movable cards
   (they snap exactly like the music/calendar/HA instruments); the layer owns their
   lifecycle, so this sink is just add/replace (`notify`, keyed by id) and `remove`. */
export interface NotificationsSink {
   notify(notice: Notice): void;
   remove(id: string): void;
}

/* The sinks ingest fans out to. */
export interface IngestSinks {
   store: Store;
   reactor: ReactorSink;
   conversation: ConversationSink;
   telemetry: TelemetrySink;
   music: MusicSink;
   calendar: CalendarSink;
   ha: HASink;
   notifications: NotificationsSink;
   conversationList: ConversationListSink;
}

/*
 * A source of DAWN data. `start` binds the sinks and begins feeding them; the
 * two inbound-from-user hooks (`submit`, `setEngaged`) let the UI push user
 * intent back toward DAWN. `stop` tears everything down.
 */
export interface Ingest {
   start(sinks: IngestSinks): void;
   /* User submitted text (later: send to DAWN's conversation path). */
   submit(text: string): void;
   /* User dismissed a transient notice; the source may propagate it to DAWN (e.g.
      a ringing alarm needs scheduler_action{dismiss} to actually stop). */
   dismiss(id: string): void;
   /* User engaged/left the input (focus), which affects the listening state. */
   setEngaged(engaged: boolean): void;
   /* Music transport (a deliberate Tier-C write, like chat submit): a music_control
      action verb plus its params, e.g. musicControl("seek", { position_sec: 42 }). */
   musicControl(action: string, params?: Record<string, unknown>): void;
   /* User asked the HA board for fresh state now (force a live re-poll instead of
      waiting for the interval). A read, like the other calendar/HA polls. */
   refreshHA(): void;
   /* A deliberate user action from an HA widget (toggle/slider/dropdown): sends
      ha_call_service to DAWN (signal-map §9.4 #8), a Tier-C write treated like music
      transport. The server reconciles by broadcasting fresh state. See DawnIngest.haControl. */
   haControl(call: HAServiceCall): void;
   /* --- Conversation picker (request/response). listConversations paginates; searchConversations
      filters (title, or message content when `content`). loadConversation / newConversation are
      the already-sanctioned reads/opens. rename / delete / setPinned are deliberate, user-initiated
      Tier-C writes (like set_private / music transport): delete is DESTRUCTIVE (cascades images +
      child jobs server-side) and MUST be confirm-gated by the caller. --- */
   listConversations(opts: { limit: number; offset: number }): void;
   searchConversations(query: string, content: boolean, opts?: { limit?: number; offset?: number }): void;
   loadConversation(id: number): void;
   newConversation(): void;
   renameConversation(id: number, title: string): void;
   deleteConversation(id: number): void;
   setPinned(id: number, pinned: boolean): void;
   /* Stop the live session (disconnect); in-session, audio contexts are kept for reuse. */
   stop(): void;
   /* Final teardown (HMR/unmount): stop AND release the audio graphs. Distinct from stop()
      so an in-session reconnect can reuse the AudioContexts instead of stacking new ones. */
   dispose(): void;
}
