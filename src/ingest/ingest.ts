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

/* One tool invocation, rendered as an ordered, expandable pill. `id` is DAWN's
   `tool_call_id` (the same key live `tool_step` frames and reloaded `tool_calls` / `role:tool`
   rows share), used to pair a result to its call and to update a pill idempotently; "" when a
   server predates it. `args`/`result` are the opaque, redacted detail shown on expand. */
export interface ToolCall {
   id: string;
   name: string;
   args?: string;
   result?: string;
   /* Tool-loop iteration index (0-based) from the live tool_step frame. The view seals a pill
      group when this changes, so a prose-less tool-only iteration still starts its own group
      (live grouping then matches reload's per-message split). Absent on the reload path (which
      seals per message) and on older daemons (which fall back to stream-boundary sealing). */
   iter?: number;
   /* Confirmed tool failure -> the pill reds; absent means success OR unknown (deliberately
      neutral, no green - fail-safe). Dual-source: set live from the `tool_step` frame's `error`,
      and on reload from the persisted `is_error` DB column (v81). Absent in both directions. */
   error?: boolean;
}

/* One entry in a loaded transcript: a text turn, a run of tool calls, or both (a turn
   that spoke and then called tools). `tools` is the ordered invocations, rendered as
   compact expandable pills instead of the raw tool_use JSON DAWN persists in history. */
export interface ConversationItem {
   role: "user" | "assistant";
   text?: string;
   tools?: ToolCall[];
   id?: number; // server DB message id, stamped for message_appended dedup (absent on older servers)
}

/* What ingest can push to the conversation console (a passive view). Streaming
   replies arrive as startReply -> appendDelta* -> endReply; a complete message
   (non-streamed or replayed history) arrives as showReply. */
export interface ConversationSink {
   setThinking(thinking: boolean): void;
   /* DAWN is speaking (TTS). Holds the window upright across the gaps between spoken
      sentences so it does not recede-then-raise (bounce) while waiting on the next text. */
   setSpeaking(speaking: boolean): void;
   startReply(): void;
   appendDelta(delta: string): void;
   endReply(): void;
   showReply(text: string, messageId?: number): void;
   /* A user turn from DAWN (a voice transcript). Typed turns are appended locally on
      submit, so this is only for spoken input echoed back by the daemon. */
   showUser(text: string, messageId?: number): void;
   /* Phase-0 user fan-out helpers: `noteMessageId` records a DB id for a locally-rendered typed
      user turn (so the server echo/fan-out dedups); `hasMessage` reports whether a message id is
      already in the transcript (so the two user frames, arriving in any order, don't both act). */
   noteMessageId(messageId: number): void;
   hasMessage(messageId: number): boolean;
   /* A red system error line in the transcript (a failed turn or a server error), shown
      in-context rather than only as a fleeting notice. */
   showError(text: string): void;
   /* Live tool use, surfaced as ordered expandable pills (one per invocation), NOT raw
      tool_use JSON. `toolCall` appends/updates a pill (idempotent by `id`); `toolResult`
      attaches the result to the pill with the matching `tool_call_id` for the expand panel.
      A subsequent text turn closes the current run so the next tools start a fresh group. */
   toolCall(call: ToolCall): void;
   toolResult(id: string, result: string, error?: boolean): void;
   /* The configured assistant display name (ai_name), for the reply header. */
   setAssistantName(name: string): void;
   /* Replace the transcript with a loaded conversation's history (oldest first). */
   loadHistory(items: ConversationItem[]): void;
   /* Server-authoritative-persistence (Phase 0) cross-viewer correlation. `linkStream`
      registers the just-finalized streamed bubble under (conv, streamId); `adoptId` stamps the
      DB id onto it when the matching `message_appended` arrives (returns true if it was ours);
      `renderAppended` renders a `message_appended` we did NOT stream, deduped on message id. */
   linkStream(convId: number, streamId: number): void;
   adoptId(convId: number, streamId: number, messageId: number): boolean;
   renderAppended(item: { role: "user" | "assistant"; text: string; messageId: number }): void;
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

/* One SAGE watch (a proactive-alert rule), a camelCased mirror of DAWN's watch_list
   watch object, enriched with the catalog label/unit and a live reading. `ruleType` is
   left a plain string (DAWN can emit threshold|slope|absence|match; only two are used
   today) so an unknown kind renders generically. `current` is guarded independently of
   `hasCurrent` (DAWN omits it when the reading is non-finite even if hasCurrent). */
export interface WatchItem {
   id: number;
   name: string;
   metric: string;
   label: string; // catalog label, e.g. "system temperature"
   unit: string; // literal UTF-8 on the wire ("°C", "%", "ppm", "" for counts)
   ruleType: string; // "threshold" | "slope" | "absence" | ...
   direction: string; // threshold: "above" | "below"; slope: "rising" | "falling"
   threshold?: number; // threshold rule: metric units. Omitted when non-finite / on a slope row.
   slopePerMin?: number; // slope rule: rate trigger, positive magnitude, canonical units/MINUTE
   slopeWindowSec?: number; // slope rule: averaging window (seconds); omitted when absent
   absenceAfterSec: number;
   notify: string; // "alert" | "ambient" (digest is DAWN-P0 log-only, not offered in the UI)
   enabled: boolean;
   /* true = user-named (authoritative; shown as the row title, spoken in alerts). false = a
      system auto-name (server owns it, regenerates it on a condition edit). Feature-detected:
      absent on older servers -> treat as false (auto). */
   named?: boolean;
   source: string; // source_tag, the group key: "stat" | "suit" | "component" | ...
   hasCurrent: boolean;
   current?: number;
   /* Authoritative "condition currently met" from DAWN (hysteresis-aware). Optional/
      feature-detected: absent on older servers -> no breach tint. */
   breaching?: boolean;
}

/* The mutable dials of a watch, sent by the edit modal (the FULL field state - a partial
   send would reset omitted fields to catalog defaults server-side). Rule-type-specific:
   DAWN rejects cross-vocabulary (above/below only on threshold, rising/falling only on
   slope). `ruleType` drives an in-place kind switch (threshold <-> slope); omit to keep the
   current kind (absence is not switchable). The trigger key follows the kind: `threshold`
   for a threshold rule (or seconds of silence for absence), `slopePerMin` (+ optional
   `slopeWindowSec`) for a slope rule. Per-minute is canonical on the wire. */
export interface WatchFields {
   name?: string; // user-facing watch name; sent only when non-empty (empty keeps the current/auto name)
   ruleType?: string; // "threshold" | "slope"
   direction?: string; // threshold: "above"|"below"; slope: "rising"|"falling"
   threshold?: number; // threshold: metric units; absence: seconds of silence
   slopePerMin?: number; // slope: positive magnitude, units/MINUTE (sign comes from direction)
   slopeWindowSec?: number; // slope: averaging window in seconds (optional)
   notify?: string; // "alert" | "ambient"
}

/* A watchable metric (powers the add modal). Newer servers also carry the metric's natural
   rule shape + seed values (feature-detected; absent on older servers). */
export interface WatchCatalogEntry {
   key: string;
   label: string;
   unit: string;
   ruleType?: string; // the metric's natural kind: "threshold" | "slope" | "absence"
   defaultDirection?: string; // seed direction for a fresh add
   defaultThreshold?: number; // seed threshold for a fresh add
}

/* List outcome, so the panel shows a real "couldn't list" state instead of an empty one
   (a failed watch_list_response carries no watches/catalog/attention_enabled), and the
   display-only armed/disarmed flag. */
export interface WatchesStatus {
   ok: boolean; // the last watch_list succeeded
   attentionEnabled: boolean; // global SAGE attention flag - DISPLAY ONLY (not togglable here)
   error?: string;
}

/* One live reading from the ~1 Hz watch_readings stream: just the volatile value, keyed by
   watch id. `current` omitted when non-finite/absent (hasCurrent:false). */
export interface WatchReading {
   id: number;
   hasCurrent: boolean;
   current?: number;
   breaching?: boolean; // authoritative breach state, ticks with the value (feature-detected)
}

export interface WatchesSink {
   /* Full watch set + the metric catalog (success path). */
   setWatches(watches: WatchItem[], catalog: WatchCatalogEntry[]): void;
   /* List status + armed/disarmed; on failure keeps the last rows and shows the error. */
   setStatus(status: WatchesStatus): void;
   /* Patch just the live readings (from the watch_readings stream) onto the existing rows -
      updates the numbers in place, no re-render of the rule structure. */
   setReadings(readings: WatchReading[]): void;
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

/* One item from DAWN's document library (doc_library_list). A NOTE carries its full body
   inline (`text`, ≤4KB, single-chunk); an uploaded DOCUMENT carries metadata only over the
   WebSocket. `filetype` is "note" for notes, else the file extension (pdf/txt/md/docx/...).
   `originalBlobId`/`hasOriginal` gate reading a document's body: the original file is fetched
   separately via Ingest.fetchDocumentOriginal, but only once DAWN exposes the blob id on the
   list response (signal-map §9 backend ask). Until then a document is a metadata-only row. */
export interface LibraryItem {
   id: number;
   filename: string; // note label, or the document's filename
   filetype: string; // "note" | "pdf" | "txt" | "md" | "docx" | ...
   isNote: boolean;
   text?: string; // note body (notes only; documents have no body over the WS)
   numChunks: number;
   isGlobal: boolean;
   createdAt: number; // epoch seconds
   originalBlobId?: string; // present once DAWN ships the field; else no fetch/download
   hasOriginal?: boolean; // an original file is stored (best-effort server-side)
}

/* What ingest can push to the library panel (a passive, read-only view; a poll like the
   calendar/HA boards, not ambient store state). `setItems` replaces (`append:false`) or
   appends a page; `searching` marks a search result set so the panel can guard a stale late
   response after the query was cleared; `hasMore` drives the load-more affordance. */
export interface LibrarySink {
   setItems(items: LibraryItem[], opts: { append: boolean; searching: boolean; hasMore: boolean }): void;
}

/* One item DAWN pulled into context for a turn (a focus-block candidate). Read off the
   pushed `context_injection` frame - which is FLAT AT THE ROOT, not under `payload` (the
   signal map §3.2 implies a payload wrapper; verified against DAWN webui_broadcasts.c that
   there is none). `text` (and `sourceId`) are memory/model-sourced, so the panel is
   untrusted-input territory: bind every string via textContent. */
export interface ContextItem {
   /* Unique per-row key ("fact:8502"); "" for non-citeable rows (calendar/document/etc).
      This is what the `context_citations` frame references - NOT sourceId, which is the
      adapter's per-CATEGORY static string ("memory_fact") and not unique per row. */
   itemId: string;
   sourceId: string;
   sourceType: string; // "internal" | "external" | "user-content"
   text: string;
   score: number; // the final blended score
   breakdown: { semantic: number; recency: number; importance: number; source: number };
   appliedSourceWeight: number;
   provenance?: { conversationId: number; msgIdStart: number; msgIdEnd: number };
}

/* One turn's injected context: what DAWN retrieved (and what it filtered out) to answer.
   DAWN scopes the frame server-side to the connection's ACTIVE conversation, so the panel
   only ever sees traces for the conversation on screen - it shows the latest turn. */
export interface ContextTrace {
   conversationId: number;
   turnId: number;
   items: ContextItem[];
   rejections: Array<{ sourceId: string; count: number }>;
}

/* What ingest pushes to the Context panel (a passive, read-only view fed by the pushed
   `context_injection` frame - no request, the "why did it say that" surface). `show`
   replaces the panel with the latest turn's trace; `clear` empties it when the conversation
   changes (new / reset / switch) so a stale trace never lingers. */
export interface ContextSink {
   show(trace: ContextTrace): void;
   clear(): void;
   /* A turn's citations arrived: the model cited these injected rows (by `item_id`) in its
      answer. Scoped to (conversationId, turnId) so a stale frame for a different/old turn is
      ignored. Arrives AFTER show() for the same turn (turn end vs turn start), so the panel
      treats it as a late gold overlay on already-rendered rows. */
   applyCitations(conversationId: number, turnId: number, citedItemIds: string[]): void;
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
   watches: WatchesSink;
   library: LibrarySink;
   context: ContextSink;
   notifications: NotificationsSink;
   conversationList: ConversationListSink;
}

/* A document uploaded via POST /api/documents: DAWN extracts its text server-side and
   optionally stores the original. The composer holds this as a pending attachment and, on
   send, inlines it into the outgoing turn's text as an [ATTACHED DOCUMENT] marker (which the
   daemon persists and the LLM reads - documents ride the message text, not a separate field). */
export interface UploadedDoc {
   filename: string;
   content: string; // extracted text
   size: number; // original size in bytes
   type: string; // extension (pdf/txt/md/...)
   blobId?: string; // present -> the original file is stored and downloadable
}

/* An image uploaded via POST /api/images (client-compressed first). `id` is the server
   reference used BOTH to attach the image to a turn (payload.image_ids, which the daemon
   persists as an [IMAGE:id] marker) and to rehydrate it on reload (/api/images/:id). */
export interface UploadedImage {
   id: string;
   mimeType: string;
   size: number;
}

/* One image on an outgoing turn frame: base64 (no data: prefix) for the live LLM call. The
   paired id rides `image_ids` separately (persistence). Ordered identically. */
export interface OutImage {
   data: string;
   mime_type: string;
}

/*
 * A source of DAWN data. `start` binds the sinks and begins feeding them; the
 * two inbound-from-user hooks (`submit`, `setEngaged`) let the UI push user
 * intent back toward DAWN. `stop` tears everything down.
 */
export interface Ingest {
   start(sinks: IngestSinks): void;
   /* User submitted a turn. `attachments.images` (base64) rides the frame for the live LLM
      call; `attachments.imageIds` (from the /api/images upload, order-matched) is MANDATORY
      whenever images are present - the daemon persists it as [IMAGE:id] markers so images
      survive a reload (hard cut-over, no fallback). Documents are inlined into `text` by the
      caller, so they need nothing here. */
   submit(text: string, attachments?: { images?: OutImage[]; imageIds?: string[] }): void;
   /* Upload a document to DAWN (POST /api/documents, multipart) so the composer can attach
      it to the next turn. A sanctioned conversation-input write, same class as chat submit.
      Returns the extracted text + metadata; rejects on failure. */
   uploadDocument(file: File): Promise<UploadedDoc>;
   /* Upload a (client-compressed) image to DAWN (POST /api/images, multipart). A sanctioned
      conversation-input write. Returns the server id used to attach + rehydrate it. */
   uploadImage(image: Blob): Promise<UploadedImage>;
   /* Whether the active model can see images (from get_config's llm.cloud/local.vision_enabled,
      resolved against the current mode). The composer gates image attach on this. */
   isVisionCapable(): boolean;
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
   /* Re-request the SAGE watch list (watch_list). Poll-only - there is no push; a watch
      FIRING arrives via the attention_alert / silent_observation notices instead. */
   requestWatches(): void;
   /* Enable/disable one watch (watch_set_enabled): a benign per-watch flip, the sanctioned
      deliberate-user-action class (like set_pinned). The server reconciles via a re-list.
      Blocked (with a notice) on a dead link, like haControl. */
   setWatchEnabled(id: number, enabled: boolean): void;
   /* Opt into (or out of) the ~1 Hz watch_readings live-gauge stream. Driven off Watches
      panel visibility: subscribe when shown, unsubscribe when hidden - so DAWN only pushes
      readings when a client is actually looking. Re-subscribed on reconnect if still wanted. */
   watchReadingsSubscribe(enabled: boolean): void;
   /* Phase-2 watch CRUD - per-user proactive rules, deliberate user actions (same class as
      the conversation picker's verbs). `addWatch` CREATES a new watch on a metric (a metric can
      hold several named watches now, so add never dedups); `fields` carries the name + condition
      the create modal collected, so nothing is written until Save. `updateWatch` sends the FULL
      field state (partial sends would reset omitted fields to defaults). `removeWatch` is only
      ever called from a confirm-gated gesture. All server-reconciled via a re-list. */
   addWatch(metric: string, fields?: WatchFields): void;
   updateWatch(id: number, fields: WatchFields): void;
   removeWatch(id: number): void;
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
   /* --- Library (document + notes viewer). All reads: doc_library_list (list/search/
      paginate) plus an original-file fetch. No write verbs are wired (read-mostly). ---
      refreshLibrary re-lists the first page; searchLibrary runs the BM25 label/body search;
      loadMoreLibrary pages the plain list (server offset = current loaded count). */
   refreshLibrary(): void;
   searchLibrary(query: string, opts?: { limit?: number; offset?: number }): void;
   loadMoreLibrary(offset: number): void;
   /* Fetch a document's original file (txt/md rendered inline; binary types downloaded). A
      read, same class as the calendar/HA polls; routed through ingest so the view never
      touches the DAWN HTTP boundary directly. Returns the raw bytes + content type - the
      view decodes text itself and object-URLs binaries for download. Rejects on failure. */
   fetchDocumentOriginal(blobId: string): Promise<{ blob: Blob; contentType: string }>;
   /* Fetch an attached image's bytes over the same-origin /api proxy (GET /api/images/<id>),
      the cookie riding it - mirrors fetchDocumentOriginal. The conversation view object-URLs
      the blob into an <img>. A read; routed through ingest so the view never touches the
      DAWN HTTP boundary directly. Rejects on failure. */
   fetchImage(id: string): Promise<{ blob: Blob; contentType: string }>;
   /* Fetch a document's reassembled full text (doc_library_get) - the readable body of a
      document with no uploaded original (e.g. a generated research report), or the
      extracted text of one that has. Resolves with the text + metadata, or null when
      unavailable (owner-scoped, requires stored full text). A read, over the WS. */
   getDocumentText(id: number): Promise<{ text: string; filename: string; filetype: string } | null>;
   /* Stop the live session (disconnect); in-session, audio contexts are kept for reuse. */
   stop(): void;
   /* Final teardown (HMR/unmount): stop AND release the audio graphs. Distinct from stop()
      so an in-session reconnect can reuse the AudioContexts instead of stacking new ones. */
   dispose(): void;
}
