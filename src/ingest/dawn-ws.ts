/*
 * DawnIngest: the REAL DAWN source. The one file that replaces StubIngest to go
 * from fake data to live. It implements the same `Ingest` interface, writing to
 * the same four sinks, so nothing above this boundary changes (brief S7.4).
 *
 * Two responsibilities:
 *   1. Auth + transport — log in over /api/auth, open the /ws WebSocket with the
 *      mandatory `dawn-1.0` subprotocol, own its lifecycle.
 *   2. Frame routing — translate DAWN's { type, payload } frames into sink calls.
 *
 * SCOPE (slice 1): connection + auth + the reactor's state machine + live reply
 * streaming + a connection status readout. Every frame we do not yet consume is
 * logged once (see UNHANDLED) so the real traffic tells us what to wire next.
 * Panels (attention/scheduler/jobs/music/HA) are later slices.
 *
 * READ-MOSTLY: this client sends nothing that mutates DAWN. On open it sends
 * `init` with tts_enabled:false (no TTS audio streamed to a display). The only
 * outbound that does real work is `text`, and only when the user types a message
 * into the console. Focus/blur (setEngaged) tells DAWN nothing — our reactor
 * reflects DAWN's actual state, never our input focus.
 *
 * Protocol reference: dawn/docs/WEBSOCKET_PROTOCOL.md
 * Consumer map:       docs/DAWN_UI_SIGNAL_MAP.md
 */

import type {
   ActivityStatus,
   CalendarEvent,
   CalendarInfo,
   ContextItem,
   ConversationMeta,
   HAAttributes,
   HAEntity,
   HAServiceCall,
   Ingest,
   IngestSinks,
   LibraryItem,
   MusicState,
   MusicTrack,
   NoticeAction,
   NoticeOpen,
   OutDocument,
   OutImage,
   StockAccount,
   StockAssetType,
   StockExt,
   StockMarket,
   StockPortfolio,
   StockPosition,
   StockSnapshot,
   StockStatus,
   StockWatchlist,
   StockWatchSymbol,
   ConversationItem,
   ToolCall,
   UploadedDoc,
   UploadedImage,
   WatchFields,
   WatchItem
} from "./ingest.ts";
import type { ReactorState } from "../anchor/anchor.ts";
import { TtsPlayback } from "../audio/tts.ts";
import { MusicAudio } from "../audio/music.ts";
import { MicCapture, type MicCaptureState, type MicControl } from "../audio/mic.ts";
import { RecordingDing } from "../audio/ding.ts";
import { AlarmChime } from "../audio/alarm-chime.ts";
import { collectToolNotes } from "./tool-notes.ts";
import type { EmailSource } from "./email.ts";
import { formatCacheState } from "../util/cache-state.ts";
import { PhoneCalls, PHONE_NOTICE_ID } from "./phone-wire.ts";
import { DawnEmail } from "./email-wire.ts";
import { APP_NAME, setAppLogins, tagDawnUrl } from "../util/dawn-app.ts";
import {
   LAST_USER_STORAGE_KEY,
   clearUserState,
   isDifferentUser,
   rememberUser,
   stashEndReason,
   takeEndReason
} from "../util/user-state.ts";
import {
   effortOptionsForModel,
   nearestEffort,
   parseReasoningCaps,
   reasoningNote,
   toReasoning,
   type ReasoningCaps,
   type LlmMode,
   type LlmProvider,
   type LlmState,
   type ModelControl,
   type Reasoning
} from "../model/model.ts";

/* Server -> client binary opcodes (webui_server.h). Every audio frame is a 1-byte
   type prefix then payload. TTS rides the MAIN socket; music rides ONLY the dedicated
   dawn-music socket (the legacy main-socket music path was removed server-side), but
   it still carries the 0x20 opcode there - the daemon prepends WS_BIN_MUSIC_DATA to
   every dedicated-socket frame, so the payload is [0x20][uint16-LE len][opus]. */
const BIN_AUDIO_IN = 0x01; // mic audio to DAWN ([0x01][raw Int16 PCM] or [0x01][len-prefixed opus])
const BIN_AUDIO_IN_END = 0x02; // end of a push-to-talk utterance (no payload); triggers ASR
const TYPED_ECHO_TTL_MS = 15000; // window to match a typed turn's echo before it's stale
const MIC_MUTE_COOLDOWN_MS = 800; // hold the continuous mute this long after DAWN stops speaking
const BIN_AUDIO_OUT = 0x11; // a TTS PCM chunk
const BIN_AUDIO_SEGMENT_END = 0x12; // play the accumulated segment now
const BIN_MUSIC_DATA = 0x20; // a music Opus chunk ([uint16-LE len][opus] after the opcode)
const MUSIC_WS_MAX_FAILS = 5; // give up on the dedicated stream socket after this many
const MUSIC_SEEK_TOLERANCE_SEC = 1.25; // position divergence from projected playback that counts as a seek
const MAIN_WS_MAX_DELAY = 30000; // cap the main-socket reconnect backoff (retries indefinitely)

/* Liveness heartbeat. A half-open socket (TCP alive, but DAWN's session is gone or the
   backend was silently dropped by a proxy) leaves readyState OPEN forever, so onclose never
   fires and the UI would sit falsely "Linked" while every send vanishes. We app-level ping
   (DAWN answers `pong`, gated on a live authed session - a revoked session gets an
   UNAUTHORIZED error and no pong) and force-close the socket after repeated silence, which
   routes into the normal reconnect. Feature-detected: the watchdog only declares death once
   we have seen at least one pong, so an older DAWN that ignores `ping` degrades to the old
   onclose-only behavior instead of a false-dead reconnect loop. */
const PING_IDLE_MS = 8000; // only ping after this much inbound silence (active traffic already proves life)
const PING_INTERVAL_MS = 10000; // heartbeat tick cadence (well under DAWN's 1800s idle expiry)
const PONG_TIMEOUT_MS = 6000; // a ping unanswered this long counts as one miss
const MAX_MISSED_PONGS = 2; // consecutive misses -> the link is dead, force a reconnect
const MAX_UNSUPPORTED_PROBES = 3; // no pong EVER -> assume an older DAWN, stop probing (no false dead)
const CONV_PAGE = 50; // conversation-picker page size (must match the component's PAGE)
/* Forget-what-was-learned (conversation_learned / forget_conversation_memories). DAWN counts
   and forgets one request per user at a time and answers `busy` meanwhile: re-ask the count
   every 5s, up to 12 times (DAWN's own client's limits). A forget waits up to ~120s for an
   in-flight memory save server-side; past 150s with no reply the outcome is unknown. */
const LEARNED_RETRY_MS = 5000;
const LEARNED_RETRY_MAX = 12;
const FORGET_REPLY_TIMEOUT_MS = 150000;
const FORGET_NOTICE_ID = "memory-forget";
/* Per-turn frames that must not render into the view when they belong to a conversation other
   than the one on screen (see isForeignConv). Global/untagged frames are never foreign. */
const FOREIGN_GATED_FRAMES = new Set([
   "state",
   "metrics_update",
   "stream_start",
   "stream_delta",
   "stream_end",
   "transcript",
   "context_injection",
   "context_citations"
]);
const CONV_LIST_DEBOUNCE_MS = 700; // coalesce a turn's >=2 bumped conversation_list_changed frames into one refresh
const CONV_KEY = "dawn.hero.convId"; // the conversation to reopen on next load (resume where you left off)
const REANCHOR_FALLBACK_MS = 3000; // no set_active_conversation_response in this long -> older DAWN, fall back to load_conversation
const LIB_PAGE = 50; // library-panel page size (doc_library_list limit)

/* Narrow a server-provided provider string to the panel's LlmProvider set. DAWN
   sends it capitalized in llm_runtime ("OpenRouter") and lowercase in a
   conversation's llm_settings ("openrouter"), so callers lower-case first. An
   unknown value is rejected rather than coerced, so the panel never mislabels
   one provider as another. */
function isLlmProvider(v: string): v is LlmProvider {
   return v === "openai" || v === "claude" || v === "gemini" || v === "openrouter";
}

/* Display label for the HUD provider readout (the panel's own labels). */
function providerLabel(p: LlmProvider): string {
   switch (p) {
      case "openai":
         return "OpenAI";
      case "claude":
         return "Claude";
      case "gemini":
         return "Gemini";
      case "openrouter":
         return "OpenRouter";
   }
}

const TTS_KEY = "dawn.hero.tts"; // persisted TTS on/off
const ALARM_SOUNDS_KEY = "dawn.hero.alarmSounds"; // persisted "Alarm sounds" (chime/loop) on/off
const KEEPALIVE_KEY = "dawn.hero.sessionKeepalive"; // persisted "Always on (this browser)" session keepalive
/* Context-panel memory delete: item_id prefix -> the user-scoped delete verb + its id field
   (verified in dawn/src/webui/webui_memory.c + memory_focus_adapters.c). Only these prefixes
   have an id-based delete; relation/document_chunk/calendar_occ and preferences do not. Paired
   with the Context panel's DELETABLE_PREFIXES (the display gate) - keep the kinds in sync. */
const MEMORY_DELETE_VERBS: Record<string, { type: string; field: string }> = {
   fact: { type: "delete_memory_fact", field: "fact_id" },
   entity: { type: "delete_memory_entity", field: "entity_id" },
   summary: { type: "delete_memory_summary", field: "summary_id" }
};
/* Exponential moving average of the live token rate: a smooth figure that leans
   toward recent generations. Persisted so it survives a refresh. */
const RATE_EMA_KEY = "dawn.hero.rateEma";
const RATE_EMA_ALPHA = 0.15; // higher = more responsive to the latest samples

/* Cumulative cache accounting for the CACHE / CACHE AVG HUD rows: cached / input / saved token
   sums folded from each idle metrics_update frame, so the average is a token-weighted session
   hit/savings rate. Persisted so it survives a refresh (like the token-rate EMA). */
const CACHE_SUM_KEY = "dawn.hero.cacheSums";

interface JobRow {
   conversation_id?: number;
   title?: string;
   status?: string;
}

function fmtUptime(seconds: number): string {
   const s = Math.max(0, Math.floor(seconds));
   const hh = String(Math.floor(s / 3600)).padStart(2, "0");
   const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
   const ss = String(s % 60).padStart(2, "0");
   return `${hh}:${mm}:${ss}`;
}

export type LinkStatus =
   | "checking" // silently probing a stored session on load — no card shown
   | "idle"
   | "authenticating"
   | "connecting"
   | "connected"
   | "stale" // socket open but a heartbeat ping went unanswered — link unstable, not yet dead
   | "superseded" // another tab took over this session (WS close 4001); we backed off, awaiting reclaim
   | "disconnected"
   | "error";

type StatusHandler = (status: LinkStatus, detail?: string) => void;

/* Persisted so a reload/reconnect RESUMES the same DAWN session instead of
   minting a new one each time. Without this, every connect burns a session slot
   and the daemon hits its per-user cap ("Max sessions reached"). */
const TOKEN_KEY = "dawn.hero.sessionToken";

/* DAWN's conversation state -> our reactor state. DAWN has several states with no
   distinct reactor look; they read as "busy" (thinking). Without folding
   tool_call/processing/summarizing in here they hit the default and the core goes
   dark mid-turn (e.g. during tool use). */
function toReactorState(dawn: string): ReactorState {
   switch (dawn) {
      case "listening":
         return "listening";
      case "thinking":
      case "summarizing":
      case "processing":
      case "tool_call":
         return "thinking";
      case "speaking":
         return "speaking";
      case "error":
         return "error";
      default:
         return "idle";
   }
}

/* DAWN's conversation state (+ its `detail` string) -> the activity chip. Returns
   null for idle/unknown, which clears the chip. tool_call's detail is "Calling
   <name>...", so we lift the tool name out for the chip's secondary text. */
function toActivity(dawn: string, detail?: string): ActivityStatus | null {
   switch (dawn) {
      case "listening":
         return { label: "Listening" };
      case "thinking":
         return { label: "Thinking" };
      case "summarizing":
         return { label: "Summarizing" };
      case "processing":
         return { label: "Working" };
      case "tool_call": {
         const name = detail?.match(/^Calling\s+(.+?)\.{0,3}\s*$/i)?.[1];
         return { label: "Using tools", detail: name };
      }
      case "speaking":
         return { label: "Speaking" };
      case "error":
         return { label: "Error", tone: "alert" };
      default:
         return null;
   }
}

/* A music_state payload -> our MusicState. `track` is null when the queue is
   empty; `repeat_mode` is an int enum (0/1/2); `volume` is a server-stored hint. */
function toMusicState(p: Record<string, unknown>): MusicState {
   const t = p.track as Record<string, unknown> | null | undefined;
   let track: MusicTrack | null = null;
   if (t && typeof t === "object") {
      track = {
         path: String(t.path ?? ""),
         title: String(t.title ?? ""),
         artist: String(t.artist ?? ""),
         album: String(t.album ?? ""),
         durationSec: Number(t.duration_sec ?? 0)
      };
   }
   return {
      playing: p.playing === true,
      paused: p.paused === true,
      track,
      positionSec: Number(p.position_sec ?? 0),
      durationSec: track?.durationSec ?? 0,
      queueLength: Number(p.queue_length ?? 0),
      queueIndex: Number(p.queue_index ?? 0),
      shuffle: p.shuffle === true,
      repeatMode: Number(p.repeat_mode ?? 0),
      volume: Number(p.volume ?? 1),
      quality: String(p.quality ?? ""),
      bitrate: Number(p.bitrate ?? 0),
      sourceFormat: String(p.source_format ?? ""),
      sourceRate: Number(p.source_rate ?? 0)
   };
}

/* Timezone offset (local - UTC, in seconds) for an IANA zone at a given instant. */
function tzOffsetSec(tz: string, at: Date): number {
   const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
   });
   const p: Record<string, string> = {};
   for (const part of dtf.formatToParts(at)) p[part.type] = part.value;
   const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
   return Math.round((asUTC - at.getTime()) / 1000);
}

/* Today's window as epoch seconds [midnight, next midnight) IN THE USER'S timezone
   (from DAWN), so it matches the clock rather than the browser box's zone (which may
   be UTC). An empty tz falls back to the browser's local zone. Recomputed each fetch,
   so an open panel rolls over at midnight. */
function todayWindow(tz: string): { start: number; end: number } {
   if (!tz) {
      const s = new Date();
      s.setHours(0, 0, 0, 0);
      return { start: Math.floor(s.getTime() / 1000), end: Math.floor(s.getTime() / 1000) + 86400 };
   }
   const now = new Date();
   const off = tzOffsetSec(tz, now);
   /* Shift by the offset so the UTC getters read the wall-clock date in `tz`. */
   const wall = new Date(now.getTime() + off * 1000);
   const midnightAsUTC = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), 0, 0, 0);
   let startMs = midnightAsUTC - off * 1000;
   /* Re-correct against the offset AT that midnight (covers a DST edge overnight). */
   const offMidnight = tzOffsetSec(tz, new Date(startMs));
   if (offMidnight !== off) startMs = midnightAsUTC - offMidnight * 1000;
   const start = Math.floor(startMs / 1000);
   return { start, end: start + 86400 };
}

/* A calendar_upcoming_events event -> our CalendarEvent. */
function toCalendarEvent(e: Record<string, unknown>): CalendarEvent {
   return {
      id: Number(e.id ?? 0),
      calendarId: Number(e.calendar_id ?? 0),
      summary: String(e.summary ?? ""),
      location: String(e.location ?? ""),
      start: Number(e.start ?? 0),
      end: Number(e.end ?? 0),
      allDay: e.all_day === true,
      startDate: String(e.start_date ?? ""),
      endDate: String(e.end_date ?? ""),
      cancelled: e.cancelled === true,
      isOverride: e.is_override === true
   };
}

/* A doc_library_list document/note -> our LibraryItem. `text` is present for notes only.
   `original_blob_id`/`has_original` gate a document's readability and are only present once
   DAWN ships the signal-map §9 backend field; absent, hasOriginal falls back to whether a
   blob id came through, and if neither is present the document is a metadata-only row. */
function toLibraryItem(d: Record<string, unknown>): LibraryItem {
   const filetype = String(d.filetype ?? "");
   const blobId = typeof d.original_blob_id === "string" && d.original_blob_id ? d.original_blob_id : undefined;
   return {
      id: Number(d.id ?? 0),
      filename: String(d.filename ?? ""),
      filetype,
      isNote: d.is_note === true || filetype === "note",
      text: typeof d.text === "string" ? d.text : undefined,
      numChunks: Number(d.num_chunks ?? 0),
      isGlobal: d.is_global === true,
      createdAt: Number(d.created_at ?? 0),
      originalBlobId: blobId,
      hasOriginal: d.has_original === true || blobId !== undefined
   };
}

/* Parse one context_injection item (a focus-block candidate). Numbers are read
   defensively; provenance is omitted server-side when unavailable (conv_id 0), so treat its
   absence as "not available". Text stays raw here - the panel binds it via textContent. */
function toContextItem(d: Record<string, unknown>): ContextItem {
   const b = (d.score_breakdown ?? {}) as Record<string, unknown>;
   const item: ContextItem = {
      itemId: String(d.item_id ?? ""), // unique per-row key; "" for non-citeable rows (feature-detected)
      sourceId: String(d.source_id ?? ""),
      sourceType: String(d.source_type ?? ""),
      text: typeof d.text === "string" ? d.text : "",
      score: Number(d.score ?? 0),
      breakdown: {
         semantic: Number(b.semantic ?? 0),
         recency: Number(b.recency ?? 0),
         importance: Number(b.importance ?? 0),
         source: Number(b.source ?? 0)
      },
      appliedSourceWeight: Number(d.applied_source_weight ?? 0)
   };
   const prov = d.provenance as Record<string, unknown> | undefined;
   if (prov && typeof prov === "object") {
      item.provenance = {
         conversationId: Number(prov.conversation_id ?? 0),
         msgIdStart: Number(prov.msg_id_start ?? 0),
         msgIdEnd: Number(prov.msg_id_end ?? 0)
      };
   }
   /* Optional, omitted when the item has none: accept only a finite positive number. */
   const ts = d.item_timestamp;
   if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) item.itemTimestamp = ts;
   return item;
}

/* Parse the optional per-entity `attributes` object (signal-map §9.4 #7). Only present
   once DAWN ships it; absent, the board falls back to on/off toggles. Numbers are read
   defensively (HA sometimes sends strings). */
function toHAAttributes(a: Record<string, unknown> | undefined): HAAttributes | undefined {
   if (!a || typeof a !== "object") return undefined;
   const num = (v: unknown): number | undefined => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
   };
   const attrs: HAAttributes = {};
   if (a.brightness != null) attrs.brightness = num(a.brightness);
   if (a.percentage != null) attrs.percentage = num(a.percentage);
   if (a.current_position != null) attrs.position = num(a.current_position);
   if (typeof a.hvac_mode === "string") attrs.hvacMode = a.hvac_mode;
   if (Array.isArray(a.hvac_modes)) attrs.hvacModes = a.hvac_modes.map(String);
   if (a.current_temperature != null) attrs.currentTemp = num(a.current_temperature);
   if (a.temperature != null) attrs.targetTemp = num(a.temperature);
   if (typeof a.unit_of_measurement === "string") attrs.unit = a.unit_of_measurement;
   if (typeof a.device_class === "string") attrs.deviceClass = a.device_class;
   return Object.keys(attrs).length > 0 ? attrs : undefined;
}

/* A ha_list_entities entity -> our HAEntity. `domain` and `area` are the two fields
   the signal-map docs omit but the source actually sends (`area` only when the
   entity is assigned to a room); friendly_name falls back to the entity_id. */
function toHAEntity(e: Record<string, unknown>): HAEntity {
   const entityId = String(e.entity_id ?? "");
   return {
      entityId,
      name: String(e.friendly_name ?? entityId),
      domain: String(e.domain ?? ""),
      area: String(e.area ?? ""),
      state: String(e.state ?? ""),
      attributes: toHAAttributes(e.attributes as Record<string, unknown> | undefined)
   };
}

/* A watch_list watch object -> our WatchItem. `threshold`/`current` are optional on the wire
   (omitted when non-finite), so read them independently rather than off `has_current`. */
/* WatchFields -> the snake_case wire keys DAWN's apply_overrides() reads (shared by add +
   update). rule_type drives an in-place threshold<->slope switch; the trigger key follows the
   kind (threshold vs slope_per_min, a positive magnitude in units/MINUTE - the sign comes from
   direction). Only defined fields are sent (an omitted field keeps its server value). */
function watchFieldsToWire(fields: WatchFields | undefined): Record<string, unknown> {
   const payload: Record<string, unknown> = {};
   if (!fields) return payload;
   if (fields.name !== undefined) payload.name = fields.name;
   if (fields.ruleType !== undefined) payload.rule_type = fields.ruleType;
   if (fields.direction !== undefined) payload.direction = fields.direction;
   if (fields.threshold !== undefined) payload.threshold = fields.threshold;
   if (fields.slopePerMin !== undefined) payload.slope_per_min = fields.slopePerMin;
   if (fields.slopeWindowSec !== undefined) payload.slope_window_sec = fields.slopeWindowSec;
   if (fields.notify !== undefined) payload.notify = fields.notify;
   return payload;
}

/* Model name for the HUD readout. A local model is often a filesystem PATH (e.g.
   /home/user/models/Qwen3-30B-A3B-Q4_K_M.gguf or C:\models\...\model.gguf) whose directory
   prefix stretches the box; keep just the filename (the meaningful part). Guard the path strip on
   real path signals - an absolute/drive/~ prefix or a model file extension - so a provider slug
   like "openai/gpt-5.5" keeps its vendor. Then cap the length, cutting the FRONT (leading
   ellipsis) so the distinctive tail (a quant suffix / version) survives. Display-only; the raw
   model string is still what we send to DAWN. */
function displayModelName(model: string, max = 26): string {
   let name = model.trim();
   const looksLikePath =
      /[\\/]/.test(name) && (/^([a-zA-Z]:[\\/]|[\\/~])/.test(name) || /\.(gguf|bin|safetensors|pt|onnx)$/i.test(name));
   if (looksLikePath) name = name.split(/[\\/]/).pop() || name;
   if (name.length > max) name = `…${name.slice(name.length - (max - 1))}`;
   return name;
}

/* A conversation title from its first message (mirrors the WebUI's generateTitleFromMessage):
   the first non-empty line, trimmed, capped at 50 chars with an ellipsis. Empty -> "" (which the
   HUD + DAWN both render as the "New conversation" placeholder). */
function titleFromMessage(content: string): string {
   const firstLine = (content.split("\n")[0] ?? "").trim();
   if (!firstLine) return "";
   return firstLine.length <= 50 ? firstLine : `${firstLine.slice(0, 47)}...`;
}

/* Compact a token count for the HUD: 12345 -> "12.3k", 200000 -> "200k", 640 -> "640". */
function abbrevTokens(n: number): string {
   if (n >= 1000) {
      const k = n / 1000;
      // >= 99.95 rounds to a 3-digit k, so drop the decimal (avoids "100.0k").
      return k >= 99.95 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
   }
   return String(Math.round(n));
}

/* The CONTEXT USAGE readout: token counts first, percent last ("12.3k/200k · 45%"). `usagePct`
   comes from the live `context` frame; on a conversation load we only have current/max (stored),
   so it is derived. Falls back to just the percent, then a placeholder, when counts are absent. */
function formatCtx(current: number, max: number, usagePct?: number): string {
   if (!(max > 0)) return usagePct !== undefined ? `${Math.round(usagePct)}%` : "--";
   const pct = usagePct !== undefined ? Math.round(usagePct) : Math.round((current / max) * 100);
   return `${abbrevTokens(current)}/${abbrevTokens(max)} · ${pct}%`;
}

/* Round n/d as a percent; "--" when the denominator is missing. */
function cachePct(n: number, d: number): string {
   return d > 0 ? `${Math.round((n / d) * 100)}%` : "--";
}

/* This turn's CACHE row: hit rate (cached / input prompt tokens) and estimated billing
   savings (saved / input). Savings is a server-side ESTIMATE from provider list prices, so
   it is marked "~"; a local model has no billing, so it reads "n/a". It can be negative on a
   cold cache-WRITE turn (the write is an up-front cost that pays back on later reads) - shown
   honestly. */
function formatCacheTurn(cached: number, input: number, saved: number, local: boolean): string {
   if (input <= 0) return "--";
   const hit = `${cachePct(cached, input)} hit`;
   return local ? `${hit} · n/a` : `${hit} · ~${cachePct(saved, input)} saved`;
}

/* The CACHE AVG row: cumulative session hit rate + estimated savings across turns. Savings is
   always shown (local turns just fold 0 into the sums), so a mixed cloud/local session stays
   honest. */
function formatCacheAvg(s: { cached: number; input: number; saved: number }): string {
   if (s.input <= 0) return "--";
   return `${cachePct(s.cached, s.input)} hit · ~${cachePct(s.saved, s.input)} saved`;
}

function toWatchItem(w: Record<string, unknown>): WatchItem {
   return {
      id: Number(w.id ?? 0),
      name: String(w.name ?? ""),
      metric: String(w.metric ?? ""),
      label: String(w.label ?? w.metric ?? ""),
      unit: String(w.unit ?? ""),
      ruleType: String(w.rule_type ?? "threshold"),
      direction: String(w.direction ?? "above"),
      threshold: typeof w.threshold === "number" ? w.threshold : undefined,
      slopePerMin: typeof w.slope_per_min === "number" ? w.slope_per_min : undefined,
      slopeWindowSec: typeof w.slope_window_sec === "number" ? w.slope_window_sec : undefined,
      absenceAfterSec: Number(w.absence_after_sec ?? 0),
      notify: String(w.notify ?? ""),
      enabled: w.enabled === true,
      named: w.named === true,
      source: String(w.source ?? ""),
      hasCurrent: w.has_current === true,
      current: typeof w.current === "number" ? w.current : undefined,
      breaching: typeof w.breaching === "boolean" ? w.breaching : undefined
   };
}

/* --- stocks_portfolio_update mapping. Every union is passed through an allowlist BEFORE it can
   become a class name downstream, and every number is finite-guarded (an absent field on a
   state-only frame must never coerce to NaN). --- */
const STOCK_STATUSES = new Set<StockStatus>(["ok", "not_connected", "rate_limited", "token_expired", "error"]);
const STOCK_MARKETS = new Set<StockMarket>(["regular", "pre", "post", "closed"]);
const STOCK_ASSET_TYPES = new Set<StockAssetType>(["equity", "etf", "option", "mutual_fund", "cash_equivalent", "other"]);

function asStockStatus(v: unknown): StockStatus {
   return typeof v === "string" && STOCK_STATUSES.has(v as StockStatus) ? (v as StockStatus) : "error";
}
function asStockMarket(v: unknown): StockMarket {
   return typeof v === "string" && STOCK_MARKETS.has(v as StockMarket) ? (v as StockMarket) : "closed";
}
function asStockAssetType(v: unknown): StockAssetType {
   return typeof v === "string" && STOCK_ASSET_TYPES.has(v as StockAssetType) ? (v as StockAssetType) : "other";
}
/* Finite number or 0 - only ever applied to fields inside a real snapshot. */
function finNum(v: unknown): number {
   return typeof v === "number" && isFinite(v) ? v : 0;
}

/* The optional ext-hours overlay: present only when the row carries a real extended price. A finite
   `price` gates it (change/change_pct default to 0); absent/malformed -> undefined (render as today). */
function toStockExt(v: unknown): StockExt | undefined {
   if (!v || typeof v !== "object") return undefined;
   const o = v as Record<string, unknown>;
   if (typeof o.price !== "number" || !isFinite(o.price)) return undefined;
   return { price: o.price, change: finNum(o.change), changePct: finNum(o.change_pct) };
}

/* Optional instrument name: trimmed, length-capped, undefined when absent/empty (an older
   daemon omits it -> no tooltip). Untrusted wire text; the view binds it via the DOM `title`
   property (a plain string set, not an HTML sink). */
function stockDesc(v: unknown): string | undefined {
   if (typeof v !== "string") return undefined;
   const s = v.trim();
   return s ? s.slice(0, 120) : undefined;
}

function toStockPosition(r: Record<string, unknown>): StockPosition {
   return {
      symbol: String(r.symbol ?? ""),
      description: stockDesc(r.description),
      assetType: asStockAssetType(r.asset_type),
      qty: finNum(r.qty),
      price: finNum(r.price),
      value: finNum(r.value),
      unrealizedPl: finNum(r.unrealized_pl),
      unrealizedPlPct: finNum(r.unrealized_pl_pct),
      dayChange: finNum(r.day_change),
      dayChangePct: finNum(r.day_change_pct),
      ext: toStockExt(r.ext)
   };
}
function toStockAccount(a: Record<string, unknown>): StockAccount {
   const positions = a.positions;
   return {
      label: String(a.label ?? ""),
      value: finNum(a.value),
      cash: finNum(a.cash),
      dayChange: finNum(a.day_change),
      unrealizedPl: finNum(a.unrealized_pl),
      unrealizedPlPct: finNum(a.unrealized_pl_pct),
      positions: Array.isArray(positions) ? positions.map((r) => toStockPosition(r as Record<string, unknown>)) : []
   };
}
/* A state-only frame (token_expired / cold not_connected) carries no as_of + no accounts, so
   `snapshot` is undefined and the view shows the matching empty state instead of $NaN. A
   transient error replays the last-known numbers, so those DO build a snapshot (dimmed by the
   status). */
function toStockPortfolio(p: Record<string, unknown>): StockPortfolio {
   const hasSnapshot = typeof p.as_of === "number" && isFinite(p.as_of) && Array.isArray(p.accounts);
   const snapshot: StockSnapshot | undefined = hasSnapshot
      ? {
           asOf: finNum(p.as_of),
           totalValue: finNum(p.total_value),
           totalDayChange: finNum(p.total_day_change),
           totalDayChangePct: finNum(p.total_day_change_pct),
           totalUnrealizedPl: finNum(p.total_unrealized_pl),
           totalUnrealizedPlPct: finNum(p.total_unrealized_pl_pct),
           accounts: (p.accounts as Array<Record<string, unknown>>).map(toStockAccount)
        }
      : undefined;
   /* link_expires_at: emitted only when > 0 (older daemon omits it). Can be in the past
      (a lapsed link) - kept as-is; the view treats a past/near value as "reconnect now". */
   const linkExpiresAt =
      typeof p.link_expires_at === "number" && isFinite(p.link_expires_at) && p.link_expires_at > 0
         ? p.link_expires_at
         : undefined;
   return {
      status: asStockStatus(p.status),
      market: asStockMarket(p.market),
      extHours: p.ext_hours === true,
      linkExpiresAt,
      snapshot
   };
}

/* --- stocks_watch_update mapping. Quote-only rows (no qty/value): a watched symbol is not
   held. Same allowlist + finite guards as the portfolio mapping. --- */
function toStockWatchSymbol(r: Record<string, unknown>): StockWatchSymbol {
   return {
      symbol: String(r.symbol ?? ""),
      description: stockDesc(r.description),
      assetType: asStockAssetType(r.asset_type),
      price: finNum(r.price),
      dayChange: finNum(r.day_change),
      dayChangePct: finNum(r.day_change_pct),
      ext: toStockExt(r.ext),
      quotable: typeof r.quotable === "boolean" ? r.quotable : undefined
   };
}
function toStockWatchlist(p: Record<string, unknown>): StockWatchlist {
   return {
      status: asStockStatus(p.status),
      market: asStockMarket(p.market),
      asOf: typeof p.as_of === "number" && isFinite(p.as_of) ? p.as_of : undefined,
      symbols: Array.isArray(p.symbols)
         ? (p.symbols as Array<Record<string, unknown>>).map(toStockWatchSymbol)
         : []
   };
}

/* stocks_watch_set_response reject reporting (feature-detected: an older daemon omits it).
   Maps a short reason enum to user-facing copy; an unknown reason degrades to a generic line. */
function watchRejectReason(reason: unknown): string {
   switch (reason) {
      case "unknown":
      case "invalid":
         return "not a recognized symbol";
      case "limit":
         return "watchlist full (25 max)";
      case "duplicate":
         return "already watching";
      default:
         return "could not be added";
   }
}
/* Build a single notice for whatever the set rejected, or null if it rejected nothing. Untrusted
   wire strings are length-capped; they reach the DOM only through the notice layer's textContent. */
function watchRejectMessage(rejected: unknown): string | null {
   if (!Array.isArray(rejected) || rejected.length === 0) return null;
   const parts = rejected
      .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : null))
      .map((r) => {
         if (!r) return null;
         const sym = String(r.symbol ?? "")
            .toUpperCase()
            .replace(/[^A-Z0-9.]/g, "")
            .slice(0, 12);
         return sym ? `${sym} (${watchRejectReason(r.reason)})` : null;
      })
      .filter((s): s is string => s !== null);
   return parts.length ? `Couldn't add ${parts.join(", ")}.` : null;
}

/* DAWN's conversation history and transcripts carry raw Anthropic content blocks: a tool
   call is an assistant turn whose `content` is a `[{type:"tool_use",...}]` array (as a JSON
   string), and a tool result is a `user` turn holding `[{type:"tool_result",...}]`. Those
   are protocol plumbing, not prose (DAWN started persisting them for reload-faithful history,
   commit f0b0f23), so the reply surface must not print them verbatim. Interpret one message
   into what the console should show: its human text and/or the tool names it invoked (as
   chips). tool_result blocks are the data returning to the model - nothing to display. Mixed
   turns (a text block beside a tool_use) return both. Returns null when there is nothing to
   show (a pure tool_result, empty); a message that isn't a content-block array is plain text.
   NOTE: the CURRENT DAWN persists tools in a SEPARATE `tool_calls` column (parseToolCalls
   below), not inside content - this block-array path is a legacy fallback (name-only, no id). */
function interpretMessage(raw: string): { text?: string; tools?: ToolCall[] } | null {
   const text = (raw ?? "").trim();
   if (!text) return null;
   /* Only structured content starts with [ or { ; a normal answer is plain text. */
   if (text[0] !== "[" && text[0] !== "{") return { text: raw };
   let parsed: unknown;
   try {
      parsed = JSON.parse(text);
   } catch {
      return { text: raw }; // not JSON, just text that happens to start with a bracket
   }
   const blocks = Array.isArray(parsed) ? parsed : [parsed];
   /* If the elements don't look like content blocks (e.g. the user literally typed a JSON
      array), it isn't tool plumbing - show it verbatim. */
   const looksLikeBlocks = blocks.every(
      (b) => b !== null && typeof b === "object" && typeof (b as { type?: unknown }).type === "string"
   );
   if (!looksLikeBlocks) return { text: raw };
   const textParts: string[] = [];
   const tools: ToolCall[] = [];
   for (const b of blocks as Array<{ type?: string; text?: unknown; name?: unknown; id?: unknown }>) {
      if (b.type === "text" && typeof b.text === "string") textParts.push(b.text);
      else if (b.type === "tool_use") {
         tools.push({ id: typeof b.id === "string" ? b.id : "", name: typeof b.name === "string" && b.name ? b.name : "tool" });
      }
   }
   const joined = textParts.join("").trim();
   if (!joined && !tools.length) return null; // pure tool_result / unknown blocks -> skip
   return { text: joined || undefined, tools: tools.length ? tools : undefined };
}

/* A reloaded tool result, keyed by tool_call_id: its text plus the persisted confirmed-failure
   verdict. NOTE the key-name split - reload carries `is_error` (the DB column), the LIVE tool_step
   frame carries `error`; same concept, two message types. */
interface ReloadedToolResult {
   result: string;
   error: boolean;
}

/* Parse DAWN's persisted `tool_calls` column (an OpenAI-format JSON array:
   [{id, type:"function", function:{name, arguments}}]) into ordered ToolCall pills for reload.
   `results` maps a tool_call_id to its result text + error verdict (from the paired `role:"tool"`
   rows). This is the REAL reload tool source (content-block tool_use in interpretMessage is a
   legacy fallback). Untrusted -> parsed defensively; the view binds every field via textContent. */
function parseToolCalls(raw: unknown, results: Map<string, ReloadedToolResult>): ToolCall[] {
   if (raw == null) return [];
   let arr: unknown = raw;
   if (typeof raw === "string") {
      try {
         arr = JSON.parse(raw);
      } catch {
         return [];
      }
   }
   if (!Array.isArray(arr)) return [];
   const out: ToolCall[] = [];
   for (const el of arr as Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>) {
      if (el == null || typeof el !== "object") continue;
      const id = typeof el.id === "string" ? el.id : "";
      const fn = el.function ?? {};
      const name = typeof fn.name === "string" && fn.name ? fn.name : "tool";
      const args = typeof fn.arguments === "string" ? fn.arguments : undefined;
      const r = id ? results.get(id) : undefined;
      out.push({ id, name, args, result: r?.result, error: r?.error ? true : undefined });
   }
   return out;
}

/* The wire-contract version this client speaks (DAWN's `protocol`, on `config` and
   /api/auth/status). DAWN bumps it only when something is removed or changes incompatibly;
   anything new or changed rides a named flag in `features` instead. */
const CLIENT_PROTOCOL = 1;


/* The message for a DAWN whose `protocol` this client doesn't speak. */
function protocolMismatchText(serverProtocol: number, dawnVersion: string): string {
   const which = dawnVersion ? `DAWN v${dawnVersion}` : "This DAWN";
   return serverProtocol > CLIENT_PROTOCOL
      ? `${which} is newer than this Aurora. Update Aurora to connect.`
      : `${which} is older than this Aurora. Update DAWN to connect.`;
}

/* Reload-loop guard for revokeSession: a revoke reloads the page at most once per 15 s. */
const REVOKE_RELOAD_KEY = "dawn.hero.revokeReloadAt";
function reloadedForRevokeRecently(): boolean {
   try {
      return Date.now() - Number(sessionStorage.getItem(REVOKE_RELOAD_KEY) ?? 0) < 15000;
   } catch {
      return false;
   }
}
/* false when sessionStorage is unavailable: then the guard can't hold, so the caller must not
   reload at all (it just shows the login card in place). */
function markRevokeReload(): boolean {
   try {
      sessionStorage.setItem(REVOKE_RELOAD_KEY, String(Date.now()));
      return true;
   } catch {
      return false;
   }
}

export class DawnIngest implements Ingest {
   private sinks!: IngestSinks;
   private ws: WebSocket | null = null;
   /* Dedicated dawn-music stream socket (main port + 1, proxied at /music-ws). This is
      the SOLE music transport: DAWN removed the legacy main-socket 0x20 fallback, so if
      this socket never attaches there is no audio at all (not a silent degrade). */
   private musicWs: WebSocket | null = null;
   private musicWsTimer = 0;
   private musicWsFails = 0;
   private musicWsAuthed = false; // auth_ok seen -> the socket may carry buffer reports
   private musicUnavailable = false; // surfaced "stream unavailable" after exhausting retries
   private musicWsToken = ""; // token the current music socket is (re)connecting with
   private musicEnabled = true; // config.music_enabled (older servers omit it -> assume on)
   private musicPort = 0; // config.music_port; used for the cross-port prod connect (0 = fall back to main+1)
   private dawnVersion = ""; // daemon version if a frame advertises it (feature-detected; else "")
   private lastStatus: LinkStatus = "disconnected"; // last emitted status, for the Connection dialog
   private lastDetail = "";
   private prevMusicIndex: number | null = null; // last queue index seen (track-change detect)
   private prevMusicPos = 0; // last raw server position seen (from state OR position ticks)
   private prevMusicPosAt = 0; // performance.now() when prevMusicPos was captured
   private prevMusicPlaying = false; // was playback advancing at prevMusicPos (for the projection)
   private status: StatusHandler = () => {};
   private wantConnected = false; // did the user ask to be connected (vs a drop)
   private wsReconnectTimer = 0; // scheduled main-socket reconnect after an unexpected drop
   private wsFails = 0; // consecutive main-socket reconnect attempts (drives the backoff)
   private loadedInitial = false; // guard: load the starting conversation only once
   private resumingStored = false; // the initial load is a resume of the persisted convId (fall back silently on failure)
   private superseded = false; // another tab took over (WS close 4001); we backed off, awaiting a reclaim() gesture
   private reclaiming = false; // this reconnect is a reclaim() takeover -> full reload so the display catches up
   private reanchoring = false; // a reconnect re-anchor in flight (restore server active-conv, do NOT re-render the transcript)
   private reanchorVerbSupported = false; // DAWN answered set_active_conversation at least once (skip the fallback after)
   private reanchorFallbackTimer = 0; // no response -> fall back to the load_conversation re-anchor (older DAWN)
   /* Liveness heartbeat state (see the PING_* constants). */
   private heartbeatTimer = 0;
   private pongTimer = 0;
   private lastInboundAt = 0; // performance.now() of the last received frame, any type
   private pingSeq = 0; // increments per ping
   private pendingPingSeq = 0; // seq of an outstanding ping (0 = none in flight)
   private missedPongs = 0; // consecutive unanswered pings, once pong is known-supported
   private pongSupported = false; // DAWN answered a ping at least once (the watchdog's feature gate)
   private unsupportedProbes = 0; // unanswered pings before any pong (an older DAWN that ignores ping)
   private conversationsLoading = false; // single-flight latch: one list/search request at a time
   private pendingListAppend = false; // the in-flight list request is a load-more (append), not a replace
   private pendingListRefresh = false; // a page-0 refresh queued behind an in-flight request (drained on settle). Invariant: pendingListRefresh => conversationsLoading
   private convListTimer = 0; // debounce for the live conversation_list_changed refresh (coalesce a turn's >=2 bumped frames)
   private pendingDeleteId = 0; // a conversation delete awaiting its (id-less) response
   private convId = 0; // the active conversation id (turns are tagged to it; DAWN persists them)
   /* Vision capability, per provider-type, from get_config (llm.cloud/local.vision_enabled).
      isVisionCapable() picks by the active mode, so it tracks a cloud<->local switch. Gates
      the composer's image attach - images only go to a model that can see them. */
   private cloudVision = false;
   private localVision = false;
   /* Texts submitted from the composer, awaiting DAWN's user-transcript echo. DAWN echoes
      every user turn (typed AND voice); we append typed turns locally on submit, so these
      let us dedupe the echo of our own typing. What is left unmatched is spoken input. Each
      carries a timestamp so a stale entry (echo that never arrived) can't later swallow an
      identical spoken turn. */
   private readonly typedEchoes: Array<{ text: string; at: number; ref?: string }> = [];
   /* When a TURN_QUEUE_FULL arrived (its trailing PROCESSING_ERROR is swallowed). */
   private queueFullAt = 0;
   private readonly jobs = new Map<number, { title: string; running: boolean }>();
   /* Event ids of currently-ringing ALARMS (not reminders/timers, which DAWN auto-dismisses).
      Drives the scheduler_action{dismiss} on user close and the shared ringing-tone loop
      (loop runs while the set is non-empty). Keyed per event so concurrent alarms + a
      reminder don't clobber each other's cards (each notice is `scheduler-<eventId>`). */
   private readonly ringingAlarms = new Set<number>();
   /* Client-side chime/loop for scheduled events (the daemon tone is daemon-local). Initial
      enabled state from the persisted "Alarm sounds" preference; the System-menu toggle flips it. */
   private readonly alarmChime = new AlarmChime(localStorage.getItem(ALARM_SOUNDS_KEY) !== "false");
   /* Phone calls (WebUI parity): the call card + ring tone; see phone-wire.ts. */
   private readonly phone = new PhoneCalls((m) => this.send(m), () => this.sinks.notifications, this.alarmChime);
   private metricsTimer = 0; // polls get_metrics to keep the HUD readout live
   private calendarTimer = 0; // slow refetch of today's events (also handles midnight rollover)
   private calendarDebounce = 0; // debounce a burst of calendar_events_changed pushes
   /* doc_library_list_response is one type for list / search / load-more, so remember
      what the in-flight request was to label the response for the library panel. */
   private pendingLibraryAppend = false;
   private pendingLibrarySearching = false;
   /* In-flight doc_library_get requests, keyed by document id, so an async full-text
      read (the reader overlay) resolves against its own response (or null on error). The
      timeout handle is stored so it can be cleared on response/supersede/dispose (no
      dangling timer firing into a resolved promise or a torn-down instance). */
   private readonly pendingDocGets = new Map<
      number,
      { resolve: (v: { text: string; filename: string; filetype: string } | null) => void; timer: number }
   >();
   /* A single in-flight doc/note EDIT save (doc_library_note_update / _doc_update). Only one
      edit is ever open (single-instance reader + Save disabled while saving), so one slot
      resolved by whichever *_update_response arrives is enough - and it sidesteps note_update
      omitting the id on its error branches (id correlation would miss those). */
   private pendingDocEdit: { resolve: (err: string | null) => void; timer: number } | null = null;
   private haTimer = 0; // polls ha_refresh_entities as the backstop under the realtime push
   private watchTimer = 0; // polls watch_list (no push exists); refreshes the rule structure
   private watchReadingsWanted = false; // Watches panel visible -> subscribe to the 1 Hz gauge stream
   private stocksPortfolioWanted = false; // Stocks panel effectively visible -> subscribe to the portfolio push
   private stocksExtHours = false; // the panel's Extended-Hours choice, re-sent on reconnect
   private stocksWatchWanted = false; // Watchlist panel effectively visible -> subscribe to the watch push
   private stocksWatchExtHours = false; // the Watchlist panel's Extended-Hours choice, re-sent on reconnect
   /* The merged HA entity snapshot, keyed by entity_id. A poll replaces it wholesale; the
      realtime ha_state_changed push (§9.4 #3) merges its delta into this same map and
      re-emits. Keeping the map (vs. re-emitting the raw array) is what makes that a
      drop-in - a single-entity delta updates one row without a full re-poll. */
   private readonly haEntities = new Map<string, HAEntity>();
   private userTz = ""; // user's IANA tz (from get_my_settings); "" => browser-local
   private uptimeTimer = 0; // ticks the uptime display every second between polls
   private uptimeBaseSec = 0; // last authoritative uptime from get_metrics
   private uptimeBaseAt = 0; // performance.now() when that uptime was received
   /* Created at construction (not in start) so its Opus-decode support is probed before
      the handshake advertises a codec, and so the reactor tap is wired once. onLevels
      references sinks, which start() sets before any audio can arrive. */
   private readonly tts = new TtsPlayback({
      onLevels: (bins) => this.sinks.reactor.setLevels(bins),
      /* Echo prevention for continuous listening: onActive tracks real TTS playback (the
         buffered tail included); updateMicMute combines it with DAWN's speaking state so the
         mic stays muted through the whole reply - sentence gaps and tail. No-op outside
         continuous mode, so PTT is unaffected. */
      onActive: () => this.updateMicMute()
   });
   /* Created at construction (not in start) so the player view can bind to it
      before ingest.start() runs. Its AudioContext stays lazy until the first frame. */
   private readonly music = new MusicAudio();
   /* The always-on "ready" ding: a short synthesized tone played on entry into
      always_on_state:recording, replacing DAWN's dropped spoken greeting. Its own lazy,
      isolated AudioContext; purely cosmetic (error-swallowed). */
   private readonly ding = new RecordingDing();
   /* Microphone capture (voice input). Constructed here so the composer's mic button can
      bind to it before ingest.start() runs; its AudioContext stays lazy until first use.
      onLevels feeds the reactor bar ring with the user's voice while speaking (the same
      hook TTS uses), onState drives the button chrome, onFrame/onEnd carry the AUDIO_IN
      payload and the utterance-end marker to DAWN (both gated on the session handshake). */
   private readonly mic = new MicCapture({
      onLevels: (bins) => this.sinks.reactor.setLevels(bins),
      onFrame: (payload) => this.sendAudioIn(payload),
      /* Gate the end marker on the same capsSynced check as the frames, so a reconnect
         mid-utterance can't ship a bare AUDIO_IN_END whose audio was all dropped. */
      onEnd: () => {
         if (this.capsSynced) this.sendBinary(new Uint8Array([BIN_AUDIO_IN_END]));
      },
      onState: (s) => this.emitMicState(s),
      onError: (msg) => {
         console.warn("[mic]", msg);
         /* A mic failure/revoke (acquire denied, wrong rate, unplugged) while continuous is
            latched: disable it server-side instead of leaving DAWN armed with no audio. */
         if (this.continuousOn) {
            this.continuousOn = false;
            this.resumeContinuous = false;
            this.send({ type: "always_on_disable" });
         }
      }
   });
   private micStateListener: (s: MicCaptureState) => void = () => {};
   private lastMicState: MicCaptureState = "idle";
   /* True once DAWN has processed our init/reconnect (the `session` frame confirms it), so
      use_opus is set and it is safe to ship Opus. Reset on close: after a drop, Opus sent
      before the new session frame would be decoded as PCM (garbage). */
   private capsSynced = false;
   /* Continuous-listening (always-on) state. `continuousOn` is the current session's latch;
      `resumeContinuous` survives a reconnect so the always-on mode is re-enabled from the new
      session's handshake (DAWN destroys the always-on context on socket close). */
   private continuousOn = false;
   private resumeContinuous = false;
   private dawnSpeaking = false; // DAWN's `state` is "speaking" (persists across TTS sentence gaps)
   /* DAWN's always-on FSM is in "recording" (capturing the user's command), so the mic must
      stay OPEN here regardless of dawnSpeaking - muting would blank the command window. (DAWN
      dropped the spoken "Hello" greeting that used to play here with a concurrent
      state:speaking; a client-side ding replaces it. The mic-open override remains as the
      command-capture guarantee, and any concurrent TTS is handled AEC-side, not by muting.) */
   private alwaysOnRecording = false;
   private voiceWake: (() => void) | null = null; // fired on a wake-word match (standby wake-on-voice)
   private micMuteCooldown = 0; // timer: reopen the mic a beat after DAWN goes fully quiet
   private ttsEnabled = localStorage.getItem(TTS_KEY) !== "false"; // default on
   /* "Always on (this browser)" session keepalive: the daemon slides this session's login
      expiry forward on heartbeat (capped at 30 days) so the ambient dashboard stays connected
      + signed in for days without a re-login. Consent-gated in the UI (it weakens login expiry).
      Client-persisted; re-asserted after each authed session frame (a fresh session clears the
      server-side DB flag) and advertised on the handshake as a diagnostics hint. */
   private keepaliveOn = localStorage.getItem(KEEPALIVE_KEY) === "1";
   /* Our belief about the server session's keepalive DB flag, so the session-frame re-assert
      converges on a real mismatch instead of blindly re-sending (a blind disable-every-connect
      would spam the daemon's keepalive audit log). Init from the persisted intent: a resumed
      same-token session carries the flag we last set; a fresh session clears it (handled on the
      `reconnected:false` path). */
   private keepaliveServerOn = this.keepaliveOn;
   private rateEma = Number(localStorage.getItem(RATE_EMA_KEY) ?? 0); // 0 = no samples yet
   /* Cumulative cache token sums for the CACHE AVG row, restored across a refresh. Corrupt or
      absent storage starts fresh at zero. */
   /* A turn's stream ended and its cache figures haven't been added to the session sums yet: DAWN
      repeats the last call's figures on every metrics_update (several idle frames can carry the
      same call), so CACHE AVG adds each turn ONCE, on the first idle frame after its stream_end. */
   private cacheTurnPending = false;
   private cacheSum = ((): { cached: number; input: number; saved: number } => {
      try {
         const v = localStorage.getItem(CACHE_SUM_KEY);
         if (v) {
            const o = JSON.parse(v) as Record<string, unknown>;
            return { cached: Number(o.cached) || 0, input: Number(o.input) || 0, saved: Number(o.saved) || 0 };
         }
      } catch {
         /* ignore corrupt persisted sums */
      }
      return { cached: 0, input: 0, saved: 0 };
   })();
   /* Tool-use latch. DAWN pings `tool_call` then flips straight back to `thinking`
      while the tool runs and its results are processed, so the tool_call state alone
      flickers past unseen. We latch "using tools" from the ping until the turn leaves
      the thinking phase (speaking/idle/etc), so even a fast tool call stays visible. */
   private toolActive = false;
   private toolName: string | undefined;
   /* LLM selection state (MODEL panel). All of it is server-authoritative: mode /
      provider / model / availability and now reasoning / effort come from
      get_config's llm_runtime on connect (DAWN reports the session's resolved
      thinking_mode + reasoning_effort as of signal-map §9.1a), and every change is
      echoed back by set_session_llm_response. The defaults below are placeholders
      until that first frame lands. */
   private readonly llm = {
      mode: "cloud" as LlmMode,
      provider: "claude" as LlmProvider,
      model: "",
      reasoning: "enabled" as Reasoning,
      effort: "medium",
      providers: { openai: false, claude: false, gemini: false, openrouter: false } as Record<LlmProvider, boolean>
   };
   /* DAWN's per-model reasoning capabilities (P1.1b). cloudCaps is null until a server sends
      them (an older server never does: the panel then falls back to the name heuristic).
      frameCaps is the caps a per-conversation frame carried for ITS model, which covers a
      loaded conversation's model that isn't in the active list. */
   private cloudCaps: Record<LlmProvider, Record<string, ReasoningCaps>> | null = null;
   private localCaps: Record<string, ReasoningCaps> = {};
   private frameCaps: { mode: LlmMode; provider: LlmProvider; model: string; caps: ReasoningCaps } | null = null;
   /* The stored reasoning pick (thinking_mode_pick / reasoning_effort_pick): what the user chose,
      which can differ from what runs. Display only - the panel shows the EFFECTIVE value and
      explains the difference; DAWN keeps and re-resolves the pick itself. */
   private reasoningPick: { mode: Reasoning | null; effort: string } = { mode: null, effort: "" };
   private readonly cloudModels: Record<LlmProvider, string[]> = {
      openai: [],
      claude: [],
      gemini: [],
      openrouter: []
   };
   /* Which openrouter_models entry to default to when switching onto OpenRouter
      (DAWN's curated default; parity with the old WebUI which snaps to it). */
   private openrouterDefaultIdx = 0;
   /* Set while a MODEL-panel-open refresh get_config is in flight: the response updates the
      model lists + provider availability, but must NOT re-apply the session's llm_runtime
      selection (mode/provider/model/reasoning) - that would revert a loaded conversation's
      provider back to the session default, since DAWN does not switch the session LLM on a
      conversation load (applyConvLlmSettings owns that, client-side). */
   private modelsRefreshOnly = false;
   /* When the last error line was shown, to drop DAWN's generic "Failed to get response"
      LLM_ERROR that trails a specific error for the same failed turn (see the error case). */
   private lastErrorAt = 0;
   private localModels: string[] = [];
   private pendingNewConvTitle = ""; // title derived from the first message, applied on new_conversation_response
   private isPrivate = false;
   /* A private-first new conversation waiting for DAWN to confirm it (newConversation). */
   private privateCreate: { resolve: (ok: boolean) => void; timer: number; promise: Promise<boolean> } | null = null;
   private discardNextCreate = false;
   /* The conversation a tool reset just left, whose in-flight reply still renders here until
      that turn goes idle (see conversation_reset); 0 = none. */
   private resetTurnConv = 0;
   private lastState = "idle"; // last applied DAWN machine state (settleTurnOnSwitch)
   private assistantName = "DAWN"; // config ai_name, for the forget-learned prompt's wording
   /* Busy re-asks of conversation_learned so far, per conversation, and their pending timers. */
   private readonly learnedRetries = new Map<number, number>();
   private readonly learnedRetryTimers = new Set<number>();
   /* The forget THIS client sent and is awaiting (0 = none), its no-reply timer, and the id a
      failure's Retry re-sends (always one this client sent after the user confirmed it). */
   private pendingForgetId = 0;
   private forgetTimer = 0;
   /* A forget that hit the no-reply timeout: its late reply is still the only confirmation of
      what happened, so it is accepted while nothing newer is pending. */
   private timedOutForgetId = 0;
   private forgetRetryId = 0;
   /* Who this page is signed in as ("" until known), and whether a deliberate logout is under way. */
   private signedInAs = "";
   /* DAWN's advertised behaviour flags (config.features); null = an older DAWN that sends none,
      which means legacy behaviour everywhere a flag would matter. */
   private serverFeatures: Set<string> | null = null;
   private configSeen = false; // this connection's config (protocol + features) has arrived
   /* The email boundary (EmailSource): availability follows `email_client`; see email-wire.ts. */
   private readonly email = new DawnEmail();
   /* DAWN supports per-app logins (`app_logins`, learned from /api/auth/status - on load and again
      at login - never mid-connection, so a socket and its later requests always agree on the
      cookie): then every DAWN URL carries ?app=aurora and login sends "app". Sticky for the page;
      false against an older DAWN (shared cookie). */
   private appLogins = false;
   private loggingOut = false;
   private logoutEnded = false; // DAWN ended the session (force_logout / 4002) during logout()
   /* Another tab signed in as someone else (or logged out): this tab still shows the previous
      user's panels and would reconnect with the new user's token, so reload it clean. */
   private readonly onStorage = (e: StorageEvent): void => {
      if (e.key !== LAST_USER_STORAGE_KEY || !this.signedInAs) return;
      if ((e.newValue ?? "").trim() === this.signedInAs) return;
      this.disconnect();
      window.location.reload();
   };
   private readonly llmListeners: Array<() => void> = [];
   private readonly seenUnhandled = new Set<string>();

   /* Bind the sinks. Does NOT connect — the user drives that from the login
      panel via connect(), so credentials never live in the composition root. */
   start(sinks: IngestSinks): void {
      this.sinks = sinks;
      window.addEventListener("storage", this.onStorage);
      /* Surface a fatal music-audio problem (e.g. no secure context) in the player. */
      this.music.setErrorHandler((msg) => this.sinks.music.setError(msg));
      /* Closed-loop flow control: report our buffered depth up the music socket so the
         server can hold its ~2 s cushion (see MusicAudio). No-op until the socket auths. */
      this.music.setBufferReporter((ms) => this.musicReport(ms));
      /* Surface the persisted token-rate EMA immediately (survives refresh). */
      if (this.rateEma > 0) {
         this.sinks.telemetry.update({ rate: `${Math.round(this.rateEma)}/s` });
      }
      /* Stay silent until tryResume() decides — so a successful auto-resume never
         flashes the login card. */
      this.emit("checking");
   }

   /* The login panel calls this. Runs the documented cookie-auth flow, then opens
      the socket. Throws on auth failure so the panel can show the reason. */
   async connect(username: string, password: string): Promise<void> {
      this.wantConnected = true;
      this.emit("authenticating");
      /* Learn DAWN's flags (per-app logins) before logging in, in case the page-load probe failed:
         the login and every URL after it must agree on which cookie they use. */
      /* Unknown flags would mean logging in on the shared cookie, which on a newer DAWN overwrites
         the WebUI's login with this user: stop instead (an older DAWN still answers status). */
      let status: Awaited<ReturnType<DawnIngest["authStatus"]>> = null;
      try {
         status = await this.authStatus();
      } catch {
         status = null;
      }
      if (!status) {
         this.emit("error", "Couldn't reach DAWN");
         throw new Error("Couldn't reach DAWN");
      }

      const csrfRes = await fetch(this.dawnUrl("/api/auth/csrf"), { credentials: "same-origin" });
      if (!csrfRes.ok) throw new Error(`CSRF request failed (${csrfRes.status})`);
      const { csrf_token } = (await csrfRes.json()) as { csrf_token: string };

      const loginRes = await fetch(this.dawnUrl("/api/auth/login"), {
         method: "POST",
         credentials: "same-origin",
         headers: { "Content-Type": "application/json" },
         /* With per-app logins, "app" makes DAWN set this app's own cookie (not the WebUI's). */
         body: JSON.stringify(this.appLogins ? { csrf_token, username, password, app: APP_NAME } : { csrf_token, username, password })
      });
      const login = (await loginRes.json().catch(() => ({}))) as {
         success?: boolean;
         error?: string;
      };
      if (!loginRes.ok || !login.success) {
         this.emit("error", login.error ?? `Login failed (${loginRes.status})`);
         throw new Error(login.error ?? "Login failed");
      }

      /* Signing in as someone other than the last user on this browser: nothing of the previous
         user's may carry over (their resume token, last conversation, HUD cache, keepalive
         consent - or anything still on screen). Clear the stored state and reload: the page comes
         back up on the new login's cookie via tryResume, with every panel empty. */
      /* Also compare against who THIS tab is showing: another tab may have updated the shared
         last-user record while this one still holds the previous user's panels. */
      if (isDifferentUser(username) || (this.signedInAs !== "" && this.signedInAs !== username.trim())) {
         clearUserState();
         rememberUser(username);
         window.location.reload();
         return;
      }
      this.signedInAs = username.trim();
      this.openSocket();
   }

   /* Log out (the Connection dialog / the linked chip). Ends the login server-side, clears the
      user's stored state, and reloads to the login card, so nothing of theirs stays on screen or
      resumes for the next person.
      - With `logout_closes_sockets` advertised, POSTed with the socket OPEN: DAWN deletes the
        login, frees every session it owns (connected or not), sends this socket force_logout,
        closes it with 4002, and closes the music socket itself; the reply is 200
        {"success":true} with the cookie cleared. Without it (an older DAWN), the socket is
        closed first (see below).
      - POST, not a bodyless GET: a GET carries no Origin, and through the dev proxy (Host
        rewritten to DAWN's) a Referer check could reject it; a POST sends Origin.
      - Success is the 200 OR DAWN ending the session (force_logout / 4002) while we wait.
      - If neither happens, nothing is cleared (a reload would just resume the still-valid
        cookie): stay connected and say so. */
   async logout(): Promise<void> {
      if (this.loggingOut) return; // already under way (a double activation)
      this.loggingOut = true; // revokeSession / a 4002 close during this just record the end
      this.logoutEnded = false;
      const resumeContinuous = this.resumeContinuous; // a drop in the window would clear it
      this.wantConnected = false; // DAWN closes the socket on success: don't auto-reconnect
      window.clearTimeout(this.wsReconnectTimer);
      /* An older DAWN (no `logout_closes_sockets`) stalls ~30 s freeing a session a live
         connection still references, then leaks it: close the socket first and wait for it. */
      if (!this.hasFeature("logout_closes_sockets")) {
         const ws = this.ws;
         this.disconnect(true); // silent: no login-card flash while the logout finishes
         if (ws && ws.readyState !== WebSocket.CLOSED) {
            await new Promise<void>((resolve) => {
               const t = window.setTimeout(resolve, 2000);
               ws.addEventListener(
                  "close",
                  () => {
                     window.clearTimeout(t);
                     resolve();
                  },
                  { once: true }
               );
            });
         }
      }
      let ok = false;
      try {
         const res = await fetch(this.dawnUrl("/api/auth/logout"), {
            method: "POST",
            credentials: "same-origin",
            /* A half-open link must not hang the logout forever (feature-detected: older browsers). */
            signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(15000) : undefined
         });
         ok = res.ok;
      } catch {
         ok = false;
      }
      /* No confirmation: ask whether the login is actually gone (an older DAWN deletes it at once
         but answers only after a long stall), before calling it a failure. */
      if (!ok && !this.logoutEnded) ok = await this.loginIsGone();
      if (!ok && !this.logoutEnded) {
         this.loggingOut = false;
         /* Still logged in: resume on the same session token, unless another tab took the session
            over meanwhile (then stay backed off - re-stealing it restarts the takeover fight). */
         if (!this.superseded) {
            this.wantConnected = true;
            this.resumeContinuous = resumeContinuous;
            if (!this.ws) this.openSocket();
         }
         this.notifyUser("Couldn't log out: DAWN didn't confirm. Try again.");
         return;
      }
      this.disconnect(true);
      clearUserState({ forgetUser: true });
      window.location.reload();
   }

   /* On page load, if the auth cookie is still valid, skip the login card and open
      the socket straight away (resuming the stored session). Keeps the user logged
      in across an F5 instead of asking for credentials every reload. */
   async tryResume(): Promise<void> {
      try {
         const s = await this.authStatus();
         if (s) {
            /* A DAWN whose contract this client doesn't speak: say so before opening anything. */
            if (typeof s.protocol === "number" && s.protocol !== CLIENT_PROTOCOL) {
               this.emit("error", protocolMismatchText(s.protocol, this.dawnVersion));
               return;
            }
            if (s.authenticated) {
               takeEndReason(); // a stale reason from an earlier ended session - not this one
               /* The cookie belongs to someone other than the last user here (e.g. they signed in
                  in another tab): drop the previous user's stored state before resuming. This is
                  a fresh page load, so nothing of theirs is in memory. */
               if (typeof s.username === "string" && s.username && isDifferentUser(s.username)) {
                  clearUserState();
                  rememberUser(s.username);
                  /* The previous user's values were already read into memory at startup (the HUD
                     cache, keepalive consent, token-rate stats), so reload to start clean. Only
                     when the new user was actually recorded, or this would reload forever. */
                  if (!isDifferentUser(s.username)) {
                     window.location.reload();
                     return;
                  }
               }
               if (typeof s.username === "string") this.signedInAs = s.username.trim();
               this.wantConnected = true;
               this.openSocket();
               return;
            }
         }
      } catch {
         /* fall through to show the login card */
      }
      /* No valid session — reveal the login card, with why the last one ended if it was revoked. */
      const reason = takeEndReason();
      if (reason) this.emit("error", reason);
      else this.emit("idle");
   }

   private openSocket(): void {
      this.serverFeatures = null; // re-learned from this connection's config (a different build may answer)
      this.configSeen = false;
      this.emit("connecting");
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      /* Same-origin /ws — Vite proxies it to the DAWN daemon. The dawn-1.0
         subprotocol is MANDATORY: omit it and libwebsockets routes us to its
         HTTP handler, the socket "opens", and every frame is silently dropped. */
      const ws = new WebSocket(`${proto}://${window.location.host}${this.dawnUrl("/ws")}`, "dawn-1.0");
      ws.binaryType = "arraybuffer"; // TTS PCM arrives as binary frames
      this.ws = ws;

      ws.onopen = (): void => {
         this.wsFails = 0; // a clean open resets the reconnect backoff
         /* Resume the stored session if we have one, else start a fresh session.
            Resuming is what keeps us from burning a session slot on every reload.
            The `audio_codecs` capability is BIDIRECTIONAL on DAWN (one use_opus flag drives
            both TTS out and mic in), so advertise `opus` only if we can BOTH encode the mic
            AND decode TTS - otherwise DAWN would send Opus TTS we can't play (static). Lock
            both audio paths to the same codec so nothing is misframed. */
         const useOpus = this.mic.opusSupported && this.tts.opusSupported;
         this.mic.setEncoding(useOpus);
         this.tts.setOpus(useOpus);
         const caps = {
            capabilities: { audio_codecs: useOpus ? ["opus", "pcm"] : ["pcm"] },
            tts_enabled: this.ttsEnabled,
            /* Opt in to receiving our OWN turn's tool_step frames (living tool pills). Aurora
               has no stream-derived tool render, so this is its only live tool signal; the server
               keeps the origin EXCLUDED by default (so stock www doesn't double-render). Harmless
               on a daemon that predates the flag - it's simply ignored. */
            tool_step_origin: true,
            /* "Always on" keepalive intent, re-advertised each (re)connect. Diagnostics-only on
               the daemon (it does NOT authorize renewal - the DB flag does, set by the
               session_keepalive_enable we re-send after auth). Ignored by an older daemon. */
            session_keepalive: this.keepaliveOn,
            /* Who is connecting (DAWN logs it once per connection; not enforced). */
            client: { name: "aurora", version: __APP_VERSION__, protocol: CLIENT_PROTOCOL }
         };
         const token = localStorage.getItem(TOKEN_KEY);
         if (token) this.send({ type: "reconnect", payload: { token, ...caps } });
         else this.send({ type: "init", payload: caps });
         /* The active-conversation re-anchor is deferred to the `session` frame handler:
            only there do we learn `reconnected` (did we land on our OWN session, history
            intact, or a FRESH one that needs a full restore). Doing it here would fire
            before we know, and pick the lightweight re-anchor even on a fresh session. */
         /* Ask for the configured ai_name so the reply header reads "Friday", not
            a generic label. Read-only request; ignored gracefully if refused. */
         ws.send(JSON.stringify({ type: "get_config" }));
         /* The user's timezone, so the clock shows their local time (the box running
            Chrome may be UTC). */
         ws.send(JSON.stringify({ type: "get_my_settings" }));
         /* Local model list for the MODEL panel (cloud lists come from get_config). */
         ws.send(JSON.stringify({ type: "list_llm_models" }));
         /* The conversation picker's first page (also feeds the boot auto-load of the
            most recent conversation into the session, so continuing the chat continues
            it). Jobs are hidden from this list server-side. limit matches the picker's
            page size so pagination math starts on a full page. */
         this.conversationsLoading = true;
         this.pendingListAppend = false;
         ws.send(JSON.stringify({ type: "list_conversations", payload: { limit: CONV_PAGE, offset: 0 } }));
         /* The caller's active background jobs, for the jobs panel. */
         ws.send(JSON.stringify({ type: "jobs_request" }));
         /* Subscribe to music: replies with the current music_state and, once a
            track is playing, streams Opus audio as 0x20 binary frames. Subscribe
            alone starts no audio. */
         ws.send(JSON.stringify({ type: "music_subscribe", payload: { quality: "standard" } }));
         /* Calendar: the id->{name,color} map plus today's occurrences, for the
            calendar card. A slow refetch keeps it live between calendar_events_changed
            pushes and rolls the window over at midnight. Both reads, no writes. */
         this.requestCalendar();
         window.clearInterval(this.calendarTimer);
         this.calendarTimer = window.setInterval(() => this.requestCalendar(), 15 * 60 * 1000);
         /* Library: the notes + documents list for the Library panel. A poll (there is no
            push feed); the panel's refresh control re-lists on demand. A read, no writes. */
         this.requestLibrary();
         /* Home Assistant: a read-only status board. There is no push feed yet (SAGE
            item #3), so poll. ha_status reports configured/connected for the header;
            ha_list_entities fills from DAWN's <=5min cache immediately; then a slow
            ha_refresh_entities interval forces a live refetch (bypassing that cache)
            so state stays current. All reads, admin-gated server-side. */
         this.send({ type: "ha_status" });
         this.send({ type: "ha_list_entities" });
         window.clearInterval(this.haTimer);
         this.haTimer = window.setInterval(() => this.send({ type: "ha_refresh_entities" }), 30000);
         /* SAGE watches (the Watches panel): the rule list + live readings. Poll-only (no
            push - a watch FIRING arrives as an attention notice), so re-list on a slow
            backstop to refresh the readings. A read; the panel's toggle is the only write. */
         this.send({ type: "watch_list" });
         window.clearInterval(this.watchTimer);
         this.watchTimer = window.setInterval(() => this.send({ type: "watch_list" }), 30000);
         /* Re-arm the live-gauge stream if the panel wanted it before this (re)connect - the
            subscription is per-connection and lost on reconnect. */
         if (this.watchReadingsWanted) {
            this.send({ type: "watch_readings_subscribe", payload: { enabled: true } });
         }
         /* Same for the portfolio push (per-connection, lost on reconnect). Re-subscribing gets
            an immediate fresh snapshot, so a reconnect / standby-wake has no visible lag. */
         if (this.stocksPortfolioWanted) {
            this.send({ type: "stocks_portfolio_subscribe", payload: { ext_hours: this.stocksExtHours } });
         }
         /* Same for the watchlist push (its own independent per-connection subscription). */
         if (this.stocksWatchWanted) {
            this.send({ type: "stocks_watch_subscribe", payload: { ext_hours: this.stocksWatchExtHours } });
         }
         /* System metrics for the HUD, now and on a slow poll (they are a snapshot,
            not pushed). Cleared on close. */
         ws.send(JSON.stringify({ type: "get_metrics" }));
         window.clearInterval(this.metricsTimer);
         window.clearInterval(this.uptimeTimer);
         this.metricsTimer = window.setInterval(() => this.send({ type: "get_metrics" }), 8000);
         /* Count uptime locally every second; each poll re-syncs the base so it
            never drifts from DAWN. */
         this.uptimeTimer = window.setInterval(() => this.tickUptime(), 1000);
         this.emit("connected");
      };

      ws.onmessage = (ev: MessageEvent): void => {
         /* Any inbound frame proves the link is alive right now, so it resets the
            heartbeat's silence timer (and clears a suspect state). */
         this.lastInboundAt = performance.now();
         /* One malformed frame must not take down the message pump: if a handler throws
            on an unexpected payload, drop that frame and keep processing the stream. */
         try {
            if (ev.data instanceof ArrayBuffer) this.onBinary(ev.data);
            else if (typeof ev.data === "string") this.onFrame(ev.data);
         } catch (err) {
            console.error("[dawn] frame handler threw (frame dropped):", err);
         }
      };

      ws.onclose = (ev: CloseEvent): void => {
         /* Stale-socket guard. On a fast reconnect the server can 4001-evict the OLD socket
            AFTER a newer socket has already opened - the old socket's late close then arrives
            with `this.ws` already pointing at the healthy new one. Acting on it would wipe
            `this.ws` and latch `superseded` on the connection that actually owns the session
            (stuck "another tab active" on the live tab). Only the CURRENT socket's close acts;
            any older socket's close is ignored. Only skip when a DIFFERENT socket is currently
            live (the race); when `this.ws` is null (a deliberate disconnect() that pre-nulled
            it) the cleanup below must still run - so guard on `this.ws && this.ws !== ws`. */
         if (this.ws && this.ws !== ws) return;
         this.ws = null;
         this.capsSynced = false; // a new session must re-confirm before Opus is safe again
         this.stopHeartbeat(); // the socket is gone; the session-frame restarts it on reconnect
         /* Drop any in-flight re-anchor: the fresh reconnect issues its own, so a stale
            fallback timer must not fire a load_conversation for a now-old id. */
         window.clearTimeout(this.reanchorFallbackTimer);
         this.reanchoring = false;
         /* Stop TTS from the dead connection: its buffered tail has nothing to salvage, and
            leaving it playing would echo into a re-armed mic (and double-drive the reactor)
            after the reconnect. disconnect() already does this; the drop path must too. */
         this.tts.stop();
         /* Release the mic on a drop; the session-frame resume re-enables continuous with a
            fresh always-on context. A deliberate disconnect (wantConnected false) clears the
            resume so it does NOT auto-re-arm. */
         if (this.continuousOn) {
            this.continuousOn = false;
            this.mic.continuousStop();
         }
         if (!this.wantConnected) this.resumeContinuous = false;
         /* Silence a ringing-alarm loop on the drop like the other audio producers: the tone
            belongs to the dead connection, and if the alarm is dismissed/times-out during the
            outage that terminal frame is lost (DAWN won't re-broadcast it on reconnect), so it
            would otherwise beep forever. The persistent card carries the state across. */
         this.alarmChime.stopLoop();
         this.ringingAlarms.clear();
         this.phone.reset(); // a call's frames can't arrive on a dead link; a reconnect re-asks
         this.stopMetrics();
         this.closeMusicStream();
         /* Drop the seek-detection baseline: a resume may land at a different track/
            position, and a stale baseline would misread that first music_state as a seek. */
         this.prevMusicIndex = null;
         /* Drop any in-flight list latch: a load-more that never got its response must not
            poison the post-reconnect boot response into an append. Also drop a queued live
            refresh + its debounce: the reconnect boot list (onopen list_conversations) is the
            loss-recovery path (the frame is fire-and-forget, never replayed), so a stale
            pending refetch would just be redundant. */
         this.conversationsLoading = false;
         this.pendingListAppend = false;
         this.pendingListRefresh = false;
         window.clearTimeout(this.convListTimer);
         this.convListTimer = 0;
         this.sinks.reactor.setState("idle");
         /* Superseded: another connection deliberately took over this session server-side. Do
            NOT auto-reconnect - re-stealing it would restart the very fight the eviction exists
            to end. Back off, stop wanting the link, surface the takeover; the user reclaims
            with a gesture (reclaim()). We recognize it two ways: the WS close code `4001` (only
            when it survives - it does NOT through the Vite dev proxy, which delivers 1006), AND
            an already-set `superseded` flag from the `session_superseded` data frame the server
            sends just before the close (frames DO survive the proxy). So the frame is the
            reliable signal; the close code is the same-origin/prod belt-and-suspenders. */
         /* 4002: DAWN ended this login (a logout, a password change, a deleted user, an admin
            revoke). Same as force_logout, which normally arrives just before and is the reliable
            signal (the Vite dev proxy delivers the close as 1006; the code survives same-origin
            only). During our own logout it just confirms the end; logout() finishes. */
         if (ev.code === 4002) {
            this.revokeSession(ev.reason || "Your session ended.");
            return;
         }
         if (ev.code === 4001 || this.superseded) {
            this.wantConnected = false;
            this.superseded = true;
            window.clearTimeout(this.wsReconnectTimer);
            this.emit("superseded", ev.reason || undefined);
            return;
         }
         if (this.wantConnected) {
            /* An unexpected drop while we still want to be connected: auto-reconnect
               with backoff. An always-on dashboard has to heal itself after a network
               blip instead of going dead until a manual refresh (this mirrors the
               dedicated music socket). A deliberate disconnect()/force_logout clears
               wantConnected first, so those never land here. */
            this.scheduleMainReconnect();
         } else if (!this.loggingOut && this.lastStatus !== "error") {
            /* (During a logout the socket closing is expected; logout() reloads to the login card,
               so don't flash it here first. And a deliberate close that already reported an error -
               a protocol mismatch, a revoke shown in place - must keep that message.) */
            this.emit("disconnected", ev.reason || undefined);
         }
      };

      ws.onerror = (): void => {
         /* onclose fires right after and owns both the status and the reconnect; stay
            quiet here so a transient error doesn't blip the login card before the
            reconnect kicks in (same discipline as the music socket). */
      };
   }

   /* Reconnect the main socket after an unexpected close, exponential backoff capped at
      MAIN_WS_MAX_DELAY, retrying indefinitely while the user wants to be connected. The
      "connecting" status keeps the login card hidden during a blip (the connected chip
      just drops); a real revocation comes through force_logout, which stops the loop. */
   private scheduleMainReconnect(): void {
      if (!this.wantConnected) return;
      this.wsFails++;
      const delay = Math.min(MAIN_WS_MAX_DELAY, 1000 * 2 ** (this.wsFails - 1));
      this.emit("connecting", "reconnecting…");
      window.clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = window.setTimeout(() => {
         if (this.wantConnected) this.openSocket();
      }, delay);
   }

   /* Restore DAWN's per-connection active conversation after a reconnect. Prefers the
      lightweight `set_active_conversation` verb (sets the id server-side, no history replay);
      feature-detected, so if the running daemon doesn't answer it we fall back to the
      `load_conversation` re-anchor (heavier - it replays the transcript - but works
      everywhere). Once support is seen, the fallback timer is skipped. Both responses run the
      re-anchor branch that suppresses the transcript re-render (`reanchoring`). */
   private reanchorActiveConversation(): void {
      const id = this.convId;
      this.send({ type: "set_active_conversation", payload: { conversation_id: id } });
      if (this.reanchorVerbSupported) return; // trusted: no fallback needed
      window.clearTimeout(this.reanchorFallbackTimer);
      this.reanchorFallbackTimer = window.setTimeout(() => {
         /* No set_active_conversation_response arrived: assume an older DAWN and use the
            load_conversation re-anchor instead (its response has the same reanchoring branch). */
         if (this.reanchoring) this.send({ type: "load_conversation", payload: { conversation_id: id } });
      }, REANCHOR_FALLBACK_MS);
   }

   /* --- Liveness heartbeat (see the PING_* constants) --------------------- */

   private startHeartbeat(): void {
      this.stopHeartbeat();
      this.lastInboundAt = performance.now();
      this.missedPongs = 0;
      this.pendingPingSeq = 0;
      this.heartbeatTimer = window.setInterval(() => this.heartbeatTick(), PING_INTERVAL_MS);
      /* Probe once now, regardless of idle, so `pongSupported` is established while the link
         is healthy. Otherwise a connection that always carries traffic <PING_IDLE_MS apart
         (e.g. music_position ticks) would never fire the idle-gated ping - so the watchdog
         would never arm, and a LATER half-open (traffic stops) would be misread as an older
         DAWN that ignores ping (the unsupported path) instead of a dead link to reconnect. */
      this.sendPing();
   }

   private stopHeartbeat(): void {
      window.clearInterval(this.heartbeatTimer);
      window.clearTimeout(this.pongTimer);
      this.heartbeatTimer = 0;
      this.pongTimer = 0;
      this.pendingPingSeq = 0;
   }

   private heartbeatTick(): void {
      if (this.pendingPingSeq !== 0) return; // still waiting on a pong; the timeout owns that
      if (performance.now() - this.lastInboundAt < PING_IDLE_MS) return; // recent traffic proves life
      this.sendPing();
   }

   private sendPing(): void {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.pendingPingSeq = ++this.pingSeq;
      this.send({ type: "ping", payload: { seq: this.pendingPingSeq } });
      window.clearTimeout(this.pongTimer);
      this.pongTimer = window.setTimeout(() => this.onPongTimeout(this.pendingPingSeq), PONG_TIMEOUT_MS);
   }

   private onPong(seq: number): void {
      if (seq !== this.pendingPingSeq) return; // stale/duplicate
      const wasSuspect = this.missedPongs > 0; // recovered from a "stale" state
      this.pongSupported = true; // the watchdog's feature gate: DAWN answers pings
      this.unsupportedProbes = 0;
      this.missedPongs = 0;
      this.pendingPingSeq = 0;
      window.clearTimeout(this.pongTimer);
      /* Only re-assert "connected" if we had told the UI the link went stale; a healthy
         heartbeat stays quiet so the chip does not churn every 10s. */
      if (wasSuspect && this.lastStatus === "stale") this.emit("connected");
   }

   private onPongTimeout(seq: number): void {
      if (seq !== this.pendingPingSeq) return; // already answered by a later frame
      this.pendingPingSeq = 0;
      if (!this.pongSupported) {
         /* Never got a pong: likely an older DAWN that ignores `ping`. Stop probing after
            a few tries and fall back to onclose-only liveness, rather than a false-dead loop. */
         if (++this.unsupportedProbes >= MAX_UNSUPPORTED_PROBES) this.stopHeartbeat();
         return;
      }
      if (++this.missedPongs >= MAX_MISSED_PONGS) {
         this.deadLink();
      } else {
         /* First miss: the link is unstable but not yet dead. Tell the UI now (the chip
            goes "unstable") instead of waiting the full ~20s for the watchdog to reconnect. */
         this.emit("stale", "link unstable…");
      }
   }

   private deadLink(): void {
      /* The socket is half-open: DAWN stopped answering though readyState is OPEN. Force it
         closed so onclose runs the normal reconnect+backoff (self-heal) and the status chip
         stops falsely reading "Linked". */
      console.warn("[dawn] link watchdog: no pong, forcing reconnect");
      this.stopHeartbeat();
      this.ws?.close(); // -> onclose -> scheduleMainReconnect (wantConnected is still true)
   }

   /* True only when the link is confirmed usable right now: the socket is open, the handshake
      synced, and no heartbeat ping is currently overdue. User-initiated writes gate on this so
      they surface a notice instead of vanishing into a dead/half-open socket. */
   isLinkLive(): boolean {
      if (this.ws?.readyState !== WebSocket.OPEN || !this.capsSynced) return false;
      if (this.pongSupported && this.missedPongs >= 1) return false; // a ping went unanswered: suspect
      return true;
   }

   /* Surface a transient user-facing notice through the notification layer. */
   notifyUser(message: string): void {
      this.spikeNotice("link-notice", "notice", message, { tone: "attention", hold: 6 });
   }

   /* Session revoked/expired server-side (force_logout, a 4002 close, or an UNAUTHORIZED reply to
      any authed verb incl. the heartbeat). Tears the link down (no auto-reconnect behind the
      revocation), clears the user's stored state and reloads to the login card with the reason
      (at most once per 15 s; otherwise the card shows in place). During our own logout() it only
      records that DAWN ended the session. */
   /* A DAWN URL, tagged with this app when DAWN keeps per-app logins (query param, not a header:
      DAWN's HTTP stack only reads custom headers on some builds). Untouched for an older DAWN. */
   private dawnUrl(path: string): string {
      return tagDawnUrl(path);
   }

   /* /api/auth/status for THIS app. The first ask is untagged, to learn DAWN's flags (an older DAWN
      mustn't get the param); if DAWN keeps per-app logins, ask again tagged, since the untagged
      answer describes the WebUI's login. null on failure. */
   private async authStatus(): Promise<{ authenticated?: boolean; username?: string; protocol?: unknown } | null> {
      const get = async (url: string): Promise<Record<string, unknown> | null> => {
         const res = await fetch(url, { credentials: "same-origin" });
         return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
      };
      let s = await get(this.dawnUrl("/api/auth/status"));
      if (s && !this.appLogins && Array.isArray(s.features) && s.features.includes("app_logins")) {
         this.appLogins = true;
         setAppLogins(true); // shared with the markdown renderer (same-origin /api links in replies)
         s = await get(this.dawnUrl("/api/auth/status"));
      }
      return s as { authenticated?: boolean; username?: string; protocol?: unknown } | null;
   }

   /* Whether DAWN advertised a behaviour flag (false on an older DAWN that sends none). */
   private hasFeature(name: string): boolean {
      return this.serverFeatures?.has(name) === true;
   }

   /* true when /api/auth/status says this browser is no longer logged in. */
   private async loginIsGone(): Promise<boolean> {
      try {
         const s = await this.authStatus();
         return s?.authenticated === false;
      } catch {
         return false;
      }
   }

   private revokeSession(reason?: string): void {
      if (this.loggingOut) {
         this.logoutEnded = true; // our own logout ended the session; logout() wipes + reloads
         return;
      }
      /* Tear down first (socket, metrics, music), so no late frame re-writes a key cleared below
         before the reload commits; the guarded path below then isn't left running either. Silent:
         the reason is emitted (or the page reloads) below. */
      this.disconnect(true);
      /* The session is gone: clear the user's stored state and reload to the login card (the
         reason rides across in sessionStorage), so the revoked user's data doesn't stay on screen
         for whoever signs in next. Skip the clear if another tab has since signed in as someone
         else (the shared storage is theirs now). Guarded against a reload loop: once per 15 s. */
      if (!this.signedInAs || !isDifferentUser(this.signedInAs)) clearUserState();
      else localStorage.removeItem(TOKEN_KEY);
      if (reloadedForRevokeRecently() || !markRevokeReload()) {
         this.emit("error", reason);
         return;
      }
      stashEndReason(reason ?? "Your session ended.");
      window.location.reload();
   }

   private onFrame(raw: string): void {
      let msg: { type?: string; payload?: unknown };
      try {
         msg = JSON.parse(raw);
      } catch {
         return;
      }
      const type = msg.type ?? "";
      const p = (msg.payload ?? {}) as Record<string, unknown>;

      /* A turn can run to completion on a conversation the user has switched away from (DAWN
         keeps it in that conversation's own history). Its live frames are tagged with that
         conversation_id; drop them so they never render into the conversation on screen.
         tool_step and message_appended apply their own conversation checks below. */
      if (FOREIGN_GATED_FRAMES.has(type)) {
         /* context_injection / context_citations are FLAT AT THE ROOT (no payload wrapper). */
         const src = type === "context_injection" || type === "context_citations" ? (msg as Record<string, unknown>) : p;
         /* The llm_state_update smuggled in a transcript is session-wide, not a turn's row. */
         if (!(type === "transcript" && p.role === "__llm_state__") && this.isForeignConv(src)) {
            /* A foreign turn's voice still plays here: DAWN keeps sending the origin a turn's audio
               after it switches away (conn_is_audio_target), so that turn's speaking/idle state
               still drives the echo-mute; only the visuals are skipped. */
            if (type === "state") {
               this.dawnSpeaking = p.state === "speaking";
               this.updateMicMute();
            }
            return;
         }
      }

      switch (type) {
         case "session":
            /* Backstop against the wrong identity: DAWN authenticated this socket from whichever
               cookie the request named. If that isn't who this page is signed in as (e.g. DAWN was
               upgraded or rolled back under an open page, so the tagging no longer matches its
               cookies), treat it as a user switch: wipe and reload onto whoever the cookie says. */
            if (
               p.authenticated === true &&
               typeof p.username === "string" &&
               this.signedInAs !== "" &&
               p.username.trim() !== this.signedInAs
            ) {
               this.disconnect(true);
               clearUserState();
               window.location.reload();
               break;
            }
            /* Store the token so a reload resumes this same session (see TOKEN_KEY).
               The token also authenticates the dedicated music stream socket, but we
               wait for `config` (which follows session on connect) to open it, since
               that frame tells us whether music is even enabled server-side. */
            if (typeof p.token === "string") {
               localStorage.setItem(TOKEN_KEY, p.token);
               this.musicWsFails = 0;
               this.musicUnavailable = false; // fresh connection re-arms the give-up notice
            }
            /* DAWN has processed our handshake (and its audio_codecs): use_opus is set, so
               shipping Opus is now safe. */
            this.capsSynced = true;
            /* Connection confirmed live: (re)start the liveness heartbeat. */
            this.startHeartbeat();
            /* Is a phone call live? (DAWN replies only while one is; it doesn't push it on connect.) */
            this.phone.requestStatus();
            /* Re-announce "connected" now that a send can actually go out (isLinkLive): listeners
               that gate on it (the composer's send control) re-sync past the open->session gap. */
            if (this.lastStatus === "connected") this.emit("connected");
            /* Converge the server's "Always on" keepalive flag with the user's intent. A FRESH
               session (restart / idle-expiry / eviction; reconnected:false) starts with the DB
               flag CLEARED, so an enable must be re-sent (the handshake hint alone does not
               authorize renewal - only the auth-gated verb sets the DB flag the ping renewal
               reads). A same-token reconnect kept the flag. Send a verb ONLY on a real mismatch:
               this both re-enables after a fresh session AND clears a stale enable when the user
               turned keepalive OFF while disconnected (the disable would otherwise be lost) -
               while a user who never touched keepalive emits nothing and doesn't spam the audit log. */
            if ((p as { reconnected?: boolean }).reconnected === false) this.keepaliveServerOn = false;
            if (this.keepaliveOn !== this.keepaliveServerOn) {
               this.send({ type: this.keepaliveOn ? "session_keepalive_enable" : "session_keepalive_disable" });
               this.keepaliveServerOn = this.keepaliveOn;
            }
            /* Re-establish continuous listening after a reconnect: DAWN destroyed the
               always-on context on the drop, so re-enable from HERE (never before the
               handshake, or the enable targets the throwaway connection and is lost). */
            if (this.resumeContinuous && !this.continuousOn) this.startContinuous();
            /* Re-anchor the active conversation. convId is only >0 on a RECONNECT (a fresh
               page load starts at 0 and list_conversations_response resumes via a full
               load_conversation). `reconnected` (added to the session frame server-side) tells
               us which session we landed on:
                 - false -> a FRESH session (daemon restart wiped it, idle-expiry, OR an
                   eviction landed us on a throwaway): its LLM history is EMPTY, so the
                   lightweight set_active only sets a pointer and the model loses the whole
                   conversation (images included). Do a full load_conversation, which rebuilds
                   the server-side session history (webui_restore_conversation_context).
                 - true / absent (older DAWN) -> we reconnected to our OWN session, history
                   intact, so the lightweight re-anchor is correct.
               reanchoring suppresses the transcript re-render either way (we already show it).
               EXCEPT a reclaim (takeover): the other tab may have advanced this conversation
               while we were backed off, so do a FULL load_conversation with reanchoring LEFT
               FALSE - it restores the server context AND re-renders the transcript (loadHistory)
               so the display catches up to the latest turns, not stuck on a stale view. */
            if (this.convId > 0) {
               if (this.reclaiming) {
                  this.reclaiming = false;
                  this.send({ type: "load_conversation", payload: { conversation_id: this.convId } });
               } else {
                  this.reanchoring = true;
                  if ((p as { reconnected?: boolean }).reconnected === false) {
                     this.send({ type: "load_conversation", payload: { conversation_id: this.convId } });
                  } else {
                     this.reanchorActiveConversation();
                  }
               }
            }
            break;

         case "config_changed":
            /* DAWN fans this empty frame to admin browsers on any config save (like
               calendar_events_changed). Re-pull get_config so a backend model-list edit
               shows up live, even with the MODEL panel closed. Feature-detected: older
               daemons never send it, and the MODEL-panel-open refetch still covers them. */
            this.requestConfigRefresh();
            break;

         case "config": {
            /* The contract: DAWN's behaviour flags + its protocol version. A missing `features`
               array is an older DAWN (legacy behaviour). A protocol this client doesn't speak
               stops here with a plain message rather than half-working. */
            if (typeof p.version === "string") this.dawnVersion = p.version; // before a mismatch bail, for the Connection dialog
            this.configSeen = true;
            this.serverFeatures = Array.isArray(p.features)
               ? new Set((p.features as unknown[]).filter((f): f is string => typeof f === "string"))
               : null;
            this.email.setServerSupport(this.hasFeature("email_client"));
            if (typeof p.protocol === "number" && p.protocol !== CLIENT_PROTOCOL) {
               this.disconnect(true);
               this.emit("error", protocolMismatchText(p.protocol, this.dawnVersion));
               break;
            }
            /* On-connect config. Advertises the dedicated music-stream server as of
               signal-map §9.1c: skip the socket entirely when music is disabled, else
               open it now with the token `session` just stored. Older servers omit
               music_enabled -> the field stays true and we open.
               music_port: in a co-located PROD build there is no /music-ws route on
               DAWN's main port (music is a separate lws server on main+1), so we connect
               cross-port to wss://<host>:music_port. In DEV we keep the Vite /music-ws
               proxy (one accepted cert, same origin). See openMusicStream. */
            this.musicEnabled = p.music_enabled !== false;
            /* Range-validate before use: music_port is untrusted server input that becomes
               a WebSocket port. A bad/out-of-range value stays 0 -> the main+1 fallback. */
            if (
               typeof p.music_port === "number" &&
               Number.isInteger(p.music_port) &&
               p.music_port >= 1 &&
               p.music_port <= 65535
            ) {
               this.musicPort = p.music_port;
            }
            /* Mic capture chunks at the server's configured cadence (falls back to a
               default until this arrives). Matches the TTS-out audio_chunk_ms. */
            if (typeof p.audio_chunk_ms === "number") this.mic.setChunkMs(p.audio_chunk_ms);
            const token = localStorage.getItem(TOKEN_KEY);
            if (this.musicEnabled && token) this.openMusicStream(token);
            else if (!this.musicEnabled) this.closeMusicStream();
            break;
         }

         case "server_features":
            /* Handshake acknowledgement. Nothing to render, but pick up the daemon
               version if this server advertises it (feature-detected; older ones omit). */
            if (typeof p.version === "string") this.dawnVersion = p.version;
            break;

         case "pong":
            /* Heartbeat reply (a live, authed session). Confirms the link. */
            this.onPong(typeof p.seq === "number" ? p.seq : 0);
            break;

         case "force_logout":
            /* Session revoked server-side: drop the dead token and surface the login card. */
            this.revokeSession(typeof p.reason === "string" ? p.reason : undefined);
            break;

         case "session_superseded":
            /* Another tab took over this session (Tier-1). The server sends this frame just
               before the eviction close because the `4001` close code does NOT survive the
               dev proxy (browser sees 1006). Back off HERE - stop wanting the link so the
               following close doesn't auto-reconnect - and show the takeover; onclose then
               sees `superseded` and confirms the state instead of reconnecting. The user
               reclaims with a gesture (reclaim()). */
            this.superseded = true;
            this.wantConnected = false;
            window.clearTimeout(this.wsReconnectTimer);
            this.emit("superseded", typeof p.reason === "string" ? p.reason : undefined);
            break;

         case "get_config_response": {
            /* Assistant display name (reply header) + the per-provider cloud model
               lists (MODEL panel). Config may be nested under `config` or flat. */
            const cfg = (p.config ?? p) as {
               general?: { ai_name?: string };
               llm?: {
                  cloud?: {
                     openai_models?: string[];
                     claude_models?: string[];
                     gemini_models?: string[];
                     openrouter_models?: string[];
                     openrouter_default_model_idx?: number;
                     vision_enabled?: boolean;
                  };
                  local?: { vision_enabled?: boolean };
                  thinking?: { mode?: string; reasoning_effort?: string };
               };
            };
            const name = cfg.general?.ai_name;
            if (name) {
               this.assistantName = name.charAt(0).toUpperCase() + name.slice(1);
               this.sinks.conversation.setAssistantName(this.assistantName);
            }
            const c = cfg.llm?.cloud;
            if (c) {
               this.cloudModels.openai = c.openai_models ?? [];
               this.cloudModels.claude = c.claude_models ?? [];
               this.cloudModels.gemini = c.gemini_models ?? [];
               /* OpenRouter's curated model list (operator-managed in dawn.toml).
                  Absent -> [], and modelSelect still shows the live model string. */
               this.cloudModels.openrouter = c.openrouter_models ?? [];
               this.openrouterDefaultIdx =
                  typeof c.openrouter_default_model_idx === "number" ? c.openrouter_default_model_idx : 0;
            }
            /* Per-model reasoning capabilities, keyed exactly like the model lists above. */
            const rc = p.reasoning_capabilities;
            if (rc && typeof rc === "object") {
               const caps: Record<LlmProvider, Record<string, ReasoningCaps>> = { openai: {}, claude: {}, gemini: {}, openrouter: {} };
               for (const [prov, models] of Object.entries(rc as Record<string, unknown>)) {
                  if (!isLlmProvider(prov) || !models || typeof models !== "object") continue;
                  for (const [model, raw] of Object.entries(models as Record<string, unknown>)) {
                     const parsed = parseReasoningCaps(raw);
                     if (parsed) caps[prov][model] = parsed;
                  }
               }
               this.cloudCaps = caps;
            }
            /* Vision capability per provider-type (config flags). isVisionCapable() resolves
               these against the active mode, so it follows a later cloud<->local switch. */
            this.cloudVision = cfg.llm?.cloud?.vision_enabled === true;
            this.localVision = cfg.llm?.local?.vision_enabled === true;
            /* CURRENT session state: llm_runtime (payload level, resolved for this
               session) — the reliable source, since llm_state_update only fires on a
               switch_llm tool call, never on connect. Provider is capitalized here.
               As of signal-map §9.1a it also carries the session's resolved
               thinking_mode + reasoning_effort, so a fresh connection shows the real
               Reasoning/Effort with no client-side persistence. */
            const rt = (p.llm_runtime ?? {}) as {
               type?: string;
               provider?: string;
               model?: string;
               thinking_mode?: string;
               reasoning_effort?: string;
               openai_available?: boolean;
               claude_available?: boolean;
               gemini_available?: boolean;
               openrouter_available?: boolean;
            };
            /* A models-only refresh (MODEL panel open) must not touch the current
               selection - that could revert a loaded conversation's provider/model back to
               the session default. Update only the lists (above) + availability (below). */
            if (!this.modelsRefreshOnly) {
               if (rt.type) this.llm.mode = rt.type === "local" ? "local" : "cloud";
               const prov = (rt.provider ?? "").toLowerCase();
               if (isLlmProvider(prov)) this.llm.provider = prov;
               if (rt.model) this.llm.model = rt.model;
               /* Reasoning/effort: the session's EFFECTIVE runtime values (+ the stored pick and
                  this model's caps); fall back to the global config default only for older
                  servers that omit them from llm_runtime. */
               this.applyReasoningFields(p.llm_runtime, {
                  mode: rt.thinking_mode ?? cfg.llm?.thinking?.mode,
                  effort: rt.reasoning_effort ?? cfg.llm?.thinking?.reasoning_effort
               });
            }
            if (rt.openai_available !== undefined) {
               this.llm.providers = {
                  openai: rt.openai_available === true,
                  claude: rt.claude_available === true,
                  gemini: rt.gemini_available === true,
                  /* llm_runtime does not carry an openrouter_available flag yet;
                     read it if a newer server adds one, else light OpenRouter when
                     it is the resolved provider (it is plainly configured then), so
                     the panel never shows the active provider greyed. */
                  openrouter: rt.openrouter_available === true || this.llm.provider === "openrouter"
               };
            }
            this.modelsRefreshOnly = false;
            this.notifyLlm();
            break;
         }

         case "list_llm_models_response": {
            const models = (p.models ?? []) as Array<{ name?: string; reasoning_capabilities?: unknown }>;
            this.localModels = models.map((m) => m.name ?? "").filter(Boolean);
            this.localCaps = {};
            for (const m of models) {
               const parsed = m.name ? parseReasoningCaps(m.reasoning_capabilities) : null;
               if (m.name && parsed) this.localCaps[m.name] = parsed;
            }
            /* Reconcile in case we are in local mode with a model that predates this list
               (Mode switched to local before it arrived) - picks a valid local model now. */
            this.reconcileModel();
            break;
         }

         case "set_session_llm_response":
            /* Authoritative echo of a set_session_llm change (§9.1d). Reflect the
               value the SERVER resolved, not the one the user picked, across every
               field the response carries (provider / model / *_available /
               thinking_mode / reasoning_effort, which are the EFFECTIVE values): a model
               may not offer the picked mode/effort (P1.1b), and a provider switch resolves a
               new model + availability set the optimistic local state does not know.
               `reasoning_adjusted` = the fields THIS request set were changed to fit the
               model; DAWN sends no text for it, so Aurora words the notice. */
            if (p.success !== false) {
               /* type (local|cloud): a "reset" from New can move the session across it. */
               if (p.type === "local" || p.type === "cloud") this.llm.mode = p.type;
               if (typeof p.provider === "string") {
                  const prov = p.provider.toLowerCase();
                  if (isLlmProvider(prov)) this.llm.provider = prov;
               }
               /* A local session with no named model ("server decides", e.g. after New's reset to a
                  local default) echoes model "". Show "local", as get_config's llm_runtime names it,
                  rather than keeping the previous (cloud) model's name. */
               if (typeof p.model === "string" && p.model) this.llm.model = p.model;
               else if (this.llm.mode === "local" && p.model === "") this.llm.model = "local";
               /* Availability only when the echo actually carries it (both builders
                  do as of Phase 1); absent -> leave the current record untouched. */
               if (p.openai_available !== undefined) {
                  this.llm.providers = {
                     openai: p.openai_available === true,
                     claude: p.claude_available === true,
                     gemini: p.gemini_available === true,
                     openrouter: p.openrouter_available === true || this.llm.provider === "openrouter"
                  };
               }
               this.applyReasoningFields(p);
               if (p.reasoning_adjusted === true) {
                  this.spikeNotice("llm-adjusted", "notice", this.reasoningAdjustedText(), {
                     hold: 6
                  });
               }
               this.notifyLlm();
            } else {
               /* The session LLM change was rejected (e.g. a provider/model DAWN could not
                  select). Surface it instead of failing silently - a control-feedback notice,
                  not a chat line. The session kept its previous LLM. */
               const err = (p as { error?: string }).error;
               console.warn("[dawn] set_session_llm rejected:", err);
               this.spikeNotice("llm-switch-error", "attention", err || "Could not switch model", {
                  tone: "attention",
                  hold: 9
               });
            }
            break;

         case "get_my_settings_response": {
            const tz = (p as { timezone?: string }).timezone;
            if (tz) {
               this.sinks.telemetry.setTimezone(tz);
               /* Same tz drives the calendar: it fixes the displayed times AND which
                  events count as "today", so store it, tell the panel, and refetch
                  with the corrected window (the first fetch used browser-local). */
               this.userTz = tz;
               this.sinks.calendar.setTimezone(tz);
               this.sinks.conversationList.setTimezone(tz); // date grouping in the user's zone
               this.requestCalendar();
            }
            break;
         }

         case "list_conversations_response": {
            const raw = (p.conversations ?? []) as Array<Record<string, unknown>>;
            const append = this.pendingListAppend;
            this.pendingListAppend = false;
            const total = typeof p.total === "number" ? p.total : undefined;
            this.sinks.conversationList.setList(raw.map((c) => this.toMeta(c)), {
               total,
               append,
               searching: false
            });
            /* First list on connect: resume the conversation the user last had open,
               persisted across reloads (see CONV_KEY). Reflect it as the active row and
               load it into the session + transcript. A stale/deleted stored id fails the
               load and falls back silently to a fresh chat (resumingStored). With no
               stored id we start fresh - the picker is now how you reopen an older thread,
               so the old "auto-open the latest" heuristic is gone. */
            if (!this.loadedInitial && !append) {
               this.loadedInitial = true;
               const storedId = Number(localStorage.getItem(CONV_KEY) ?? 0);
               if (storedId > 0) {
                  this.convId = storedId;
                  this.resumingStored = true;
                  this.sinks.conversationList.setActive(storedId);
                  this.send({ type: "load_conversation", payload: { conversation_id: storedId } });
               }
            }
            /* Drain a refresh queued while this list was in flight AFTER the boot
               load_conversation is issued, so a redundant refetch never races it. */
            this.settleListRequest();
            break;
         }

         case "search_conversations_response": {
            this.settleListRequest();
            const raw = (p.conversations ?? []) as Array<Record<string, unknown>>;
            this.sinks.conversationList.setList(raw.map((c) => this.toMeta(c)), {
               append: false,
               searching: true
            });
            break;
         }

         case "load_conversation_response": {
            /* A failed load (e.g. the conversation was deleted from another client) must
               NOT wipe the surface: guard success and leave state untouched. */
            if ((p as { success?: boolean }).success === false) {
               if (this.resumingStored) {
                  /* The persisted conversation is gone or inaccessible: silently fall
                     back to a fresh chat - no error notice for an auto-resume. */
                  this.resumingStored = false;
                  this.settleTurnOnSwitch();
                  this.convId = 0;
                  localStorage.removeItem(CONV_KEY);
                  this.sinks.conversationList.setActive(0);
                  break;
               }
               if (this.reanchoring) {
                  /* The conversation we were in was deleted/inaccessible while we were
                     away: drop to a fresh chat so the next turn opens a new one via the
                     convId===0 path, rather than tagging turns to a dead id. Silent. */
                  this.reanchoring = false;
                  this.settleTurnOnSwitch();
                  this.convId = 0;
                  localStorage.removeItem(CONV_KEY);
                  this.sinks.conversationList.setActive(0);
                  break;
               }
               this.spikeNotice("conv-load", "conversation", "Could not open that conversation", {
                  hold: 4
               });
               break;
            }
            const cid = Number((p as { conversation_id?: number }).conversation_id ?? this.convId);
            if (this.reanchoring) {
               /* Reconnect re-anchor: DAWN's per-connection active conversation is now
                  restored, so the next turn (typed or voice) is tagged correctly. Do NOT
                  touch the transcript - it is already on screen; loadHistory would rebuild
                  it needlessly. Reconcile the cheap server-authoritative bits only. */
               this.reanchoring = false;
               this.convId = cid;
               localStorage.setItem(CONV_KEY, String(cid));
               this.sinks.conversationList.setActive(cid);
               this.isPrivate = Boolean((p as { is_private?: boolean }).is_private);
               this.applyConvLlmSettings((p as { llm_settings?: unknown }).llm_settings);
               this.setActiveTitle(String((p as { title?: string }).title ?? ""));
               this.notifyLlm();
               break;
            }
            /* Switching conversations: the shown context trace belonged to the previous
               one, so clear it now (the next live turn here repopulates it). */
            this.sinks.context.clear();
            const msgs = (p.messages ?? []) as Array<{
               role: string;
               content: string;
               id?: number;
               tool_calls?: unknown; // OpenAI-format array on assistant rows (webui_history.c)
               tool_call_id?: string; // on role:"tool" rows, correlates a result to its call
               is_error?: boolean; // on role:"tool" rows, the persisted confirmed-failure verdict (v81)
            }>;
            /* First pass: map each tool_call_id -> its result text + failure verdict from the
               `role:"tool"` rows, so a reloaded pill can carry its result (for the expand panel) AND
               red on a confirmed failure. These rows are filtered out of the rendered items below;
               they exist only for this correlation. `is_error` (DB column) is the reload twin of the
               live tool_step frame's `error` - same red-only semantics, absent => neutral. */
            const toolResults = new Map<string, ReloadedToolResult>();
            for (const m of msgs) {
               if (m.role === "tool" && typeof m.tool_call_id === "string" && m.tool_call_id) {
                  toolResults.set(m.tool_call_id, { result: m.content ?? "", error: m.is_error === true });
               }
            }
            const rows = msgs.filter((m) => m.role === "user" || m.role === "assistant");
            const items: ConversationItem[] = [];
            const consumedIds: number[] = [];
            for (let i = 0; i < rows.length; i++) {
               const m = rows[i];
               const id = Number(m.id ?? 0) || undefined;
               /* An old voice turn whose tool calls were saved as text notes (DAWN v92/v93): the
                  same pills as a structured turn, from what the notes say, consuming the result
                  notes that follow. Their DB ids are noted (after loadHistory, which resets the
                  set) so a late message_appended can't re-render them. */
               const notes = collectToolNotes(rows, i, String(id ?? `row${i}`));
               if (notes) {
                  items.push({
                     role: "assistant",
                     text: notes.prose.trim() ? notes.prose : undefined,
                     tools: notes.tools,
                     id
                  });
                  for (let k = 1; k <= notes.consumed; k++) consumedIds.push(Number(rows[i + k].id ?? 0));
                  /* A prose-less item isn't stamped by loadHistory (it stamps only text items). */
                  if (!notes.prose.trim() && id) consumedIds.push(id);
                  i += notes.consumed;
                  continue;
               }
               const info = interpretMessage(m.content);
               /* The REAL tool source is the separate `tool_calls` column (ordered,
                  id'd, with args + correlated results); interpretMessage's content-block
                  tools are a legacy fallback. Prefer tool_calls when present. */
               const structured = parseToolCalls(m.tool_calls, toolResults);
               const tools = structured.length ? structured : info?.tools;
               if (!info && !tools) continue;
               /* Stamp the DB id so a late message_appended for a reloaded row can't
                  re-double it (Phase-0 dedup prereq). */
               items.push({ role: m.role as "user" | "assistant", text: info?.text, tools, id });
            }
            this.sinks.conversation.loadHistory(items);
            for (const rid of consumedIds) this.sinks.conversation.noteMessageId(rid);
            this.convId = cid; // authoritative confirm of the optimistic set in loadConversation()
            this.resumingStored = false; // a successful load ends any in-flight resume
            localStorage.setItem(CONV_KEY, String(cid)); // remember it for the next reload
            this.sinks.conversationList.setActive(cid);
            /* Reflect the conversation's server-side privacy so the toggle survives a
               reload/reconnect/switch (DAWN persists it; we only forgot to read it). */
            this.isPrivate = Boolean((p as { is_private?: boolean }).is_private);
            /* And its stamped LLM settings, so the MODEL panel shows what this
               conversation actually runs on rather than the connect-time snapshot. */
            this.applyConvLlmSettings((p as { llm_settings?: unknown }).llm_settings);
            this.setActiveTitle(String((p as { title?: string }).title ?? ""));
            /* Seed CONTEXT USAGE from the conversation's STORED last usage, so an opened
               conversation shows its context fill before the first live `context` frame. */
            const ctxMax = Number((p as { context_max?: number }).context_max ?? 0);
            if (ctxMax > 0) {
               const ctxTokens = Number((p as { context_tokens?: number }).context_tokens ?? 0);
               this.sinks.telemetry.update({ ctx: formatCtx(ctxTokens, ctxMax) });
            }
            this.notifyLlm();
            break;
         }

         case "set_active_conversation_response": {
            /* The lightweight reconnect re-anchor's reply (no history replay). Any response
               proves the verb exists, so cancel the load_conversation fallback and trust it
               on future reconnects. Then run the same re-anchor reconcile as the
               load_conversation path: on success set the active bits without touching the
               transcript; on failure the stored conversation is gone, drop to a fresh chat. */
            window.clearTimeout(this.reanchorFallbackTimer);
            this.reanchorVerbSupported = true;
            if (!this.reanchoring) break; // not our in-flight re-anchor
            this.reanchoring = false;
            if ((p as { success?: boolean }).success === false) {
               this.settleTurnOnSwitch();
               this.convId = 0;
               localStorage.removeItem(CONV_KEY);
               this.sinks.conversationList.setActive(0);
               break;
            }
            const cid = Number((p as { conversation_id?: number }).conversation_id ?? this.convId);
            this.convId = cid;
            localStorage.setItem(CONV_KEY, String(cid));
            this.sinks.conversationList.setActive(cid);
            this.isPrivate = Boolean((p as { is_private?: boolean }).is_private);
            this.notifyLlm();
            break;
         }

         case "rename_conversation_response":
            /* No conversation_id echo, and no conversation_renamed push on a manual
               rename: the panel already patched optimistically. Reconcile on failure by
               refetching the server's truth; on success a debounced refresh closes the window
               where a list refetch already in flight (from a concurrent remote change) would
               otherwise land after and revert the optimistic patch (a rename emits no frame). */
            if ((p as { success?: boolean }).success === false) this.requestConversations();
            else this.scheduleListRefresh();
            break;

         case "set_pinned_response":
            /* Echoes conversation_id + is_pinned; the panel patched optimistically on the
               click, so accept the success and only refetch to correct a failure. On success a
               debounced refresh reconciles against a concurrent in-flight list refetch (same
               revert window as rename). */
            if ((p as { success?: boolean }).success === false) this.requestConversations();
            else this.scheduleListRefresh();
            break;

         case "delete_memory_fact_response":
         case "delete_memory_entity_response":
         case "delete_memory_summary_response": {
            /* The Context panel confirm-gated + optimistically removed the row. On success
               there is nothing to do; a genuine failure surfaces a notice. "Not found" means
               it was already gone (a re-click, or deleted elsewhere), so treat it as success -
               the optimistic removal was correct. No id echo in the response, so nothing to
               reconcile per-row. */
            if ((p as { success?: boolean }).success === false) {
               const err = String((p as { error?: string }).error ?? "");
               if (!/not found/i.test(err)) {
                  this.spikeNotice("memory-delete", "attention", err || "Couldn't delete that memory", {
                     hold: 5,
                     tone: "attention"
                  });
               }
            }
            break;
         }

         case "set_private_response": {
            /* The conversation's privacy is persisted; a private flip also privated its
               continuations (`also_private`). Refetch the picker so every affected row's badge is
               right, rather than patching ids one by one. A failure is surfaced; the toggle keeps
               the user's intent (a later load reflects the server's real value). */
            /* A pending private-first create (newConversation) settles only on the reply for ITS
               conversation (DAWN echoes conversation_id + is_private), never on a stray one. */
            const pp = p as { success?: boolean; conversation_id?: number; is_private?: boolean };
            const forPending = !!this.privateCreate && this.convId > 0 && Number(pp.conversation_id ?? 0) === this.convId;
            if (pp.success === false) {
               if (forPending) this.settlePrivateCreate(false);
               const err = String((p as { error?: string }).error ?? "");
               this.spikeNotice("privacy", "attention", err || "Couldn't change privacy", {
                  hold: 5,
                  tone: "attention"
               });
               break;
            }
            if (forPending && pp.is_private === true) this.settlePrivateCreate(true);
            this.scheduleListRefresh();
            break;
         }

         case "conversation_learned": {
            /* Unsolicited after a set_private{true}: what memory had already learned from the
               conversation. Busy = another count/forget is running for this user -> re-ask. Only
               OFFERS a forget; the delete itself fires solely from the dialog's Forget button. */
            const lp = p as {
               conversation_id?: number;
               success?: boolean;
               busy?: boolean;
               memories?: number;
               outdated?: number;
               relations?: number;
            };
            const cid = Number(lp.conversation_id ?? 0);
            if (!cid) break;
            if (lp.success !== true && lp.busy === true) {
               const tries = (this.learnedRetries.get(cid) ?? 0) + 1;
               if (tries <= LEARNED_RETRY_MAX) {
                  this.learnedRetries.set(cid, tries);
                  const timer = window.setTimeout(() => {
                     this.learnedRetryTimers.delete(timer);
                     /* Link down: the re-ask would be dropped and never answered, so end the chain
                        and drop its count (a later busy chain starts with the full budget). */
                     if (!this.isLinkLive()) {
                        this.learnedRetries.delete(cid);
                        return;
                     }
                     this.send({ type: "conversation_learned_request", payload: { conversation_id: cid } });
                  }, LEARNED_RETRY_MS);
                  this.learnedRetryTimers.add(timer);
                  break;
               }
            }
            this.learnedRetries.delete(cid);
            if (lp.success !== true) {
               /* Fail toward not asking; the user can still forget from the picker. */
               console.warn("[dawn] conversation_learned: could not count learned memories", cid);
               break;
            }
            /* Only for the conversation on screen, and only while it is still private: the
               prompt says "this conversation", so an offer for one the user has since left (or
               made public again) would be ambiguous. The picker's Forget covers those. */
            if (cid !== this.convId || !this.isPrivate) break;
            const counts = {
               memories: Math.max(0, Number(lp.memories ?? 0) || 0),
               outdated: Math.max(0, Number(lp.outdated ?? 0) || 0),
               relations: Math.max(0, Number(lp.relations ?? 0) || 0)
            };
            if (counts.memories + counts.outdated + counts.relations > 0) {
               this.sinks.memoryForget.offerForgetLearned(
                  cid,
                  counts,
                  this.assistantName,
                  () => cid === this.convId && this.isPrivate
               );
            }
            break;
         }

         case "forget_conversation_memories_response": {
            /* The forget's outcome replaces the sticky "Forgetting..." card. DAWN's error strings
               are user-ready (busy, too many continuations, "nothing was changed"). */
            const fp = p as {
               conversation_id?: number;
               success?: boolean;
               error?: string;
               memories?: number;
               outdated?: number;
               relations?: number;
            };
            /* Only the reply to the forget this client is awaiting: a late reply to an older
               request (or one for a forget another tab sent before a takeover) must not clear the
               pending card or arm a Retry for something not confirmed here. */
            const replyId = Number(fp.conversation_id ?? 0);
            const awaited = this.pendingForgetId || this.timedOutForgetId;
            if (!awaited || replyId !== awaited) break;
            this.timedOutForgetId = 0;
            this.clearForgetPending();
            if (fp.success === true) {
               const n = Math.max(0, Number(fp.memories ?? 0) || 0);
               const rest = (Number(fp.outdated ?? 0) || 0) + (Number(fp.relations ?? 0) || 0);
               const summary =
                  n + rest === 0
                     ? "Nothing left to forget"
                     : n > 0
                       ? `Forgot ${n} ${n === 1 ? "memory" : "memories"}`
                       : "Forgot older versions and connections";
               this.spikeNotice(FORGET_NOTICE_ID, "memory", summary, { hold: 5 });
            } else {
               this.forgetFailed(replyId, String(fp.error ?? "") || "Could not forget memories");
            }
            break;
         }

         case "delete_conversation_response": {
            if ((p as { success?: boolean }).success === false) {
               const msg =
                  typeof (p as { error?: string }).error === "string"
                     ? (p as { error?: string }).error
                     : "Could not delete conversation";
               this.spikeNotice("conv-delete", "conversation", String(msg), {
                  hold: 5,
                  tone: "attention"
               });
               this.requestConversations(); // restore the row the panel optimistically removed
               this.pendingDeleteId = 0;
               break;
            }
            /* Deleted the open conversation: DAWN cleared the session server-side, so
               reset our surface + id to a fresh chat so the transcript doesn't strand. */
            if (this.pendingDeleteId > 0 && this.pendingDeleteId === this.convId) {
               this.settleTurnOnSwitch(); // its live turn (if any) is now foreign; don't strand the visuals
               this.convId = 0;
               localStorage.removeItem(CONV_KEY); // the resumed conversation is gone
               this.sinks.conversation.clear();
               this.sinks.context.clear();
               this.setActiveTitle(""); // fresh chat
               this.sinks.conversationList.setActive(0);
            }
            this.pendingDeleteId = 0;
            /* Delete emits no conversation_list_changed; a debounced refresh reconciles the
               list (and closes the same optimistic-revert window as rename/pin). */
            this.scheduleListRefresh();
            break;
         }

         case "conversation_renamed": {
            /* Server auto-title (NOT a manual rename): live-patch the row title. */
            const cid = Number((p as { conversation_id?: number }).conversation_id ?? 0);
            const t = typeof (p as { title?: string }).title === "string" ? (p as { title: string }).title : "";
            if (cid) this.sinks.conversationList.markRenamed(cid, t);
            if (cid === this.convId) this.setActiveTitle(t); // keep the HUD readout current
            break;
         }

         case "conversation_messages_appended": {
            /* Signal-only "a message landed". If it's the conversation we're viewing,
               reload it so an external turn (SMS/Telegram inbound, job reinvoke) renders
               live; otherwise mark that row unread. */
            const cid = Number((p as { conversation_id?: number }).conversation_id ?? 0);
            if (!cid) break;
            if (cid === this.convId) {
               this.send({ type: "load_conversation", payload: { conversation_id: cid } });
               /* An EXTERNAL append to the active conversation (a background job/briefing, an
                  inbound SMS/Telegram) is not our own turn, so no terminal stream_end fires and
                  its `conversation_list_changed {bumped}` is self-echo-filtered - without this the
                  active row's time/order would stay stale. Coalesces with the debounce. */
               this.scheduleListRefresh();
            } else {
               this.sinks.conversationList.markAppended(cid);
            }
            break;
         }

         case "conversation_list_changed": {
            /* A conversation was created or bumped (got a message) by ANY interface - another
               tab, voice, messaging, a background job/briefing. Refresh the picker list so the
               new row / new order shows without a click. Debounced (a turn emits >=2 bumped
               frames) and latch-safe (requestConversations queues rather than racing). This is
               list membership/order only; unread-marking stays on conversation_messages_appended.
               Self-echo: our OWN active conversation's `bumped` is already covered by the
               own-turn refresh at terminal stream_end, so drop it here (else every token-thread
               bump refetches). `created` is NOT filtered on convId - on a fresh chat convId is
               still 0 when DAWN emits `created`, so it could never match; new_conversation_response
               cancels this debounce instead, collapsing the two paths into one fetch. */
            const cid = Number((p as { conversation_id?: number }).conversation_id ?? 0);
            const created = (p as { reason?: string }).reason === "created";
            if (!Number.isInteger(cid) || cid <= 0) break;
            if (!created && cid === this.convId) break; // own active turn -> handled at stream_end
            this.scheduleListRefresh();
            break;
         }

         case "conversation_reset":
            /* A tool (reset_conversation / "start a new conversation") cleared the
               context. Empty the surface and drop our active conversation so the
               NEXT message opens a fresh one (mirrors the old WebUI's startNewChat),
               preserving the previous conversation instead of appending to it. */
            this.sinks.conversation.clear();
            this.sinks.context.clear();
            /* The reset arrives MID-turn (the tool returns and the model still replies), and that
               reply stays tagged with the old conversation. Keep it on screen until the turn
               ends, rather than gating it as foreign and stranding the reactor mid-reply. */
            if (this.convId > 0) this.resetTurnConv = this.convId;
            this.convId = 0;
            this.setActiveTitle(""); // fresh chat -> HUD shows "New conversation"
            localStorage.removeItem(CONV_KEY); // context was reset; the next message opens a fresh one
            this.sinks.conversationList.setActive(0);
            break;

         case "new_conversation_response": {
            /* The fresh conversation the daemon just created — persist to it now. A
               `server_initiated` push is DAWN lazily auto-creating+binding a conversation for a
               voice turn that had none (always-on / push-to-talk); it carries the
               transcript-derived `title` and OWNS the conversation's privacy (public). So on that
               path: reflect the pushed title (no blank flicker), and do NOT replay a pending
               is_private toggle onto it. A normal client-initiated new_conversation has no title
               yet (DAWN auto-titles later via conversation_renamed) and inherits a pending
               privacy intent. Feature-detected: older servers omit the flag -> client path. */
            const np = p as { conversation_id?: number; title?: string; server_initiated?: boolean };
            const serverInitiated = np.server_initiated === true;
            /* A private-first create the user abandoned (they opened another conversation while it
               was in flight): the empty conversation exists server-side, but it must not take over
               the view. */
            if (this.discardNextCreate && !serverInitiated) {
               this.discardNextCreate = false;
               this.scheduleListRefresh();
               break;
            }
            this.sinks.context.clear(); // fresh conversation: no injected context yet
            /* Reflect the real title: a server-initiated (voice) create pushes it; a client
               create derives it from the first message (DAWN doesn't echo it, so we remembered
               it). Without this the HUD shows the "New conversation" placeholder until the
               later auto-title, while the picker already shows the real title. */
            this.setActiveTitle(serverInitiated ? String(np.title ?? "") : this.pendingNewConvTitle);
            this.pendingNewConvTitle = "";
            this.convId = Number(np.conversation_id ?? 0);
            if (this.convId <= 0 && !serverInitiated) this.settlePrivateCreate(false);
            if (this.convId > 0) {
               localStorage.setItem(CONV_KEY, String(this.convId)); // resume this on the next reload
               this.sinks.conversationList.setActive(this.convId);
               /* Our own create also emits a `created` conversation_list_changed (before this
                  response, with convId still 0 so it isn't self-filtered). Cancel that debounced
                  refresh and do the one immediate refetch here, so a fresh chat's first message
                  triggers exactly one list_conversations, not two. */
               window.clearTimeout(this.convListTimer);
               this.convListTimer = 0;
               this.requestConversations(); // the new row now exists — refresh the picker list
               if (!serverInitiated && this.isPrivate) {
                  /* Replay a privacy toggle made while convId was 0 (setPrivate can't send
                     without an id): the new conversation inherits the pending intent. Skipped for
                     a server-initiated voice conv, which is authoritatively public. */
                  this.send({
                     type: "set_private",
                     payload: { conversation_id: this.convId, is_private: true }
                  });
               }
            }
            break;
         }

         case "cache_alert": {
            /* Admin-only: DAWN found a cache bug (e.g. reasoning dropped from the cached prefix).
               Plain-language message; shown as text by the notify layer. */
            const msg = typeof p.message === "string" && p.message ? p.message : "DAWN reported a prompt-cache problem.";
            this.spikeNotice("cache-alert", "cache", msg, { tone: "attention", persist: true, hold: 9 });
            break;
         }

         case "phone_call_notification":
            this.phone.onFrame(p as Record<string, unknown>);
            break;

         case "state":
            this.applyState(String(p.state ?? "idle"), typeof p.detail === "string" ? p.detail : undefined, p.tools);
            break;

         case "error": {
            /* Route on `severity` (§9.1b): info = benign notice, warning/error = a real
               problem. Fall back to the
               `INFO_` code prefix for older servers that don't send severity. Never
               paint the reactor red for an info notice; instead surface it as an
               ambient spike so the user sees why. */
            const code = typeof p.code === "string" ? p.code : "";
            /* The session was revoked/expired server-side (DAWN re-validates the token
               against the DB on every authed verb, including our heartbeat ping, and
               answers a dead session with UNAUTHORIZED instead of a pong). Treat it like
               force_logout: stop resuming a session that no longer exists, surface login. */
            if (code === "UNAUTHORIZED") {
               this.revokeSession(typeof p.message === "string" ? p.message : undefined);
               break;
            }
            /* turn_refs: an error naming one of OUR turns that hasn't echoed yet means that turn never
               ran (refused on receipt, or before it started), whatever the code: give its draft back.
               A ref'd error for a turn that already echoed (LLM_ERROR mid-reply, PERSIST_ERROR after
               it) finds nothing held and falls through to the normal handling below. Info/warning
               frames are never refusals. */
            const errRef = typeof p.client_ref === "string" ? p.client_ref : "";
            const errSeverity = typeof p.severity === "string" ? p.severity : "error";
            const refusalCode =
               code === "IMAGE_UNAVAILABLE" ||
               code === "IMAGE_LIMIT" ||
               code === "IMAGE_ERROR" ||
               code === "EMPTY_MESSAGE" ||
               code === "TURN_QUEUE_FULL" ||
               code === "ATTACHMENT_INVALID";
            const refusalText = (): string =>
               typeof p.message === "string" && p.message ? p.message : code === "TURN_QUEUE_FULL" ? "DAWN is busy. Try again in a moment." : "it couldn't be sent.";
            if (errRef && errSeverity === "error") {
               const refused = this.sinks.conversation.rejectTurn({ ref: errRef }, code === "IMAGE_UNAVAILABLE");
               if (refused !== null) {
                  this.dropTypedEchoRef(errRef); // by ref: two turns can share their text
                  if (this.lastState === "idle") this.sinks.conversation.setThinking(false);
                  this.sinks.conversation.noteRefusal(`Message not sent: ${refusalText()}`);
                  break;
               }
            }
            /* With turn_refs, never GUESS which turn a refusal means: one that names no held turn (its
               hold was dropped by a link loss or a switch, or it's a voice turn's) only gets a notice. */
            if (this.hasFeature("turn_refs") && refusalCode) {
               if (this.lastState === "idle") this.sinks.conversation.setThinking(false);
               this.sinks.conversation.noteRefusal(`A message wasn't sent: ${refusalText()}`);
               break;
            }
            if (code === "INVALID_CLIENT_REF") {
               console.warn("[dawn] DAWN refused this client's turn reference:", p.message);
               this.dropTypedEcho(this.sinks.conversation.rejectTurn("newest", false));
               this.sinks.conversation.noteRefusal("Message not sent - please try again.");
               break;
            }
            /* Always-on enable failures arrive as ordinary error frames (there is no
               always_on_error). Clear the latch and don't flash the reactor red - a second
               tab (ALREADY_ACTIVE), a mid-PTT enable (PTT_ACTIVE), or an init failure just
               means continuous didn't start. */
            if (
               code === "ALREADY_ACTIVE" ||
               code === "PTT_ACTIVE" ||
               code === "INVALID_SAMPLE_RATE" ||
               code === "INIT_FAILED"
            ) {
               console.warn("[dawn] continuous listening rejected:", code, p.message);
               if (this.continuousOn) {
                  this.continuousOn = false;
                  this.resumeContinuous = false;
                  this.mic.continuousStop();
               }
               break;
            }
            /* A turn refused for its images (DAWN image_turns_by_id): it never ran and nothing was
               saved. Give the draft back (text + attachments) and say why; not a reactor error. */
            if (code === "IMAGE_UNAVAILABLE" || code === "IMAGE_LIMIT" || code === "IMAGE_ERROR") {
               const message = typeof p.message === "string" && p.message ? p.message : "The attached images couldn't be sent.";
               /* Only one image turn is ever held, so this names exactly that one. Re-upload its
                  images on IMAGE_UNAVAILABLE (an expired upload), so a retry gets fresh ids. */
               this.dropTypedEcho(this.sinks.conversation.rejectTurn("image", code === "IMAGE_UNAVAILABLE"));
               if (this.lastState === "idle") this.sinks.conversation.setThinking(false); // another turn may still be running
               this.sinks.conversation.noteRefusal(`Message not sent: ${message}`);
               break;
            }
            /* DAWN's turn queue was full and a turn was refused. Which one (a typed turn, push-to-talk,
               or always-on) the frame doesn't say, so no draft is taken back on a guess; say so plainly.
               DAWN follows a refused text turn with a generic PROCESSING_ERROR: swallow that one. */
            if (code === "TURN_QUEUE_FULL") {
               this.queueFullAt = performance.now();
               /* Without turn refs, which turn was refused is unknown and it never echoes: stop holding
                  them all (a held image turn would otherwise block every later image send). With
                  turn_refs a ref-less TURN_QUEUE_FULL is a voice turn's, so typed holds stay. */
               if (!this.hasFeature("turn_refs")) this.sinks.conversation.releaseTurns();
               if (this.lastState === "idle") this.sinks.conversation.setThinking(false);
               this.sinks.conversation.noteRefusal("DAWN is busy - a message wasn't sent. Try again in a moment.");
               break;
            }
            /* (An older DAWN follows a refused text turn's TURN_QUEUE_FULL with this generic error;
               d226e575+ doesn't, so this is a no-op there.) */
            if (code === "PROCESSING_ERROR" && performance.now() - this.queueFullAt < 2000) {
               this.queueFullAt = 0;
               break;
            }
            /* A turn with neither text nor images (`image_only_turns`). Aurora never sends one; if it
               ever does, say so plainly rather than flashing the reactor. */
            if (code === "EMPTY_MESSAGE") {
               /* Refused on receipt, so it names the newest typed turn: give it back. */
               this.dropTypedEcho(this.sinks.conversation.rejectTurn("newest", false));
               if (this.lastState === "idle") this.sinks.conversation.setThinking(false);
               this.sinks.conversation.noteRefusal("Message not sent: it was empty.");
               break;
            }
            /* A push-to-talk hold that exceeds DAWN's ~10s recording cap: the server keeps
               what it buffered and processes it on release, so this is a soft limit, not a
               failure - log it, don't flash the reactor red. */
            if (code === "BUFFER_FULL") {
               console.warn("[dawn] recording too long (server cap):", p.message);
               break;
            }
            const severity =
               typeof p.severity === "string" ? p.severity : code.startsWith("INFO_") ? "info" : "error";
            if (severity === "info") {
               const message = typeof p.message === "string" ? p.message : "";
               console.info("[dawn] notice:", code, message);
               if (message) {
                  this.spikeNotice("llm-notice", "notice", message, {
                     tone: "nominal",
                     hold: 7
                  });
               }
            } else if (severity === "warning") {
               /* A warning is not a failed turn - surface it as an ambient toast, not a
                  chat line. */
               const message = typeof p.message === "string" ? p.message : "";
               console.warn("[dawn] warning frame:", code, message);
               this.spikeNotice("dawn-warning", "attention", message || "Warning", {
                  tone: "attention",
                  hold: 9
               });
            } else {
               /* A real error (e.g. LLM_ERROR "Failed to get response from AI" when an API
                  call fails). Surface the specific message as a red line IN THE TRANSCRIPT -
                  parity with the old WebUI's in-context system 'Error: ...' entry, not a
                  fleeting toast - plus the reactor error state. This is the fix for the
                  silent-failure report: the message now reaches the user. */
               const message = typeof p.message === "string" ? p.message : "";
               console.warn("[dawn] error frame:", severity, code, message);
               this.sinks.reactor.setState("error");
               /* DAWN emits its generic LLM_ERROR ("Failed to get response...") AFTER the
                  provider's specific error for the same failed turn. If we just showed an
                  error, drop the trailing generic one so a single failure is one red line.
                  Current DAWN suppresses this double at the source, so this is inert there;
                  kept as a back-compat safety net for older daemons that still send both. */
               const isGeneric =
                  message === "Failed to get response from AI" || message === "Failed to get response";
               const now = Date.now();
               if (isGeneric && now - this.lastErrorAt < 3000) {
                  console.info("[dawn] suppressed redundant generic error after a specific one");
               } else {
                  this.sinks.conversation.showError(message || "Something went wrong.");
                  this.lastErrorAt = now;
               }
            }
            break;
         }

         case "music_state": {
            const st = toMusicState(p);
            /* Flush the decode buffer on a USER-initiated track change or seek so the new
               audio starts at once instead of after the old lead drains. A natural end-of-
               track advance is tagged advance:"auto" by the server (gapless: the next
               track is already in our buffered lead) - do NOT flush that, or we truncate
               ~2 s of good audio.

               DAWN re-emits an untagged music_state on EVERY control (volume, pause,
               shuffle, repeat, ...) carrying the current position, and sends no music_state
               during steady playback (only music_position ticks). So a real seek can't be
               told from a routine control echo by a raw position delta - that would flush
               good audio on a plain volume nudge. Instead compare the reported position to
               where playback should be by now (last known position projected forward by
               wall-clock while playing); only a genuine jump past a small tolerance is a
               seek. The baseline is refreshed by both state and position frames below. */
            const now = performance.now();
            const elapsedSec = this.prevMusicPlaying ? Math.max(0, (now - this.prevMusicPosAt) / 1000) : 0;
            const projected = this.prevMusicPos + elapsedSec;
            const seen = this.prevMusicIndex !== null;
            const nowPlaying = st.playing && !st.paused;
            const autoAdvance = p.advance === "auto";
            const trackChanged = seen && st.queueIndex !== this.prevMusicIndex;
            const seeked = seen && Math.abs(st.positionSec - projected) > MUSIC_SEEK_TOLERANCE_SEC;
            /* Stop (not pause) resets the server position to 0, so its buffered lead is
               stale - flush it. Pause keeps position, so it is NOT a flush (see below). */
            const stopped = seen && this.prevMusicPlaying && !nowPlaying && !st.paused;
            /* Pause freezes output while KEEPING the buffered lead (seamless resume, no
               ~2 s tail after the press and no ~2 s skip on resume); play resumes it. */
            this.music.setPaused(st.paused === true);
            if (stopped || ((trackChanged || seeked) && !autoAdvance)) this.music.flush();
            this.prevMusicIndex = st.queueIndex;
            this.prevMusicPos = st.positionSec;
            this.prevMusicPosAt = now;
            this.prevMusicPlaying = nowPlaying;
            this.sinks.music.setState({ ...st, positionSec: this.music.audiblePosition(st.positionSec) });
            break;
         }

         case "music_position": {
            const posSec = Number(p.position_sec ?? 0);
            /* Keep the seek-detection baseline fresh: position ticks (~1/s) are the only
               frames during steady playback, so without this the projection above would
               drift a whole track's length between control echoes. */
            this.prevMusicPos = posSec;
            this.prevMusicPosAt = performance.now();
            this.sinks.music.setPosition(this.music.audiblePosition(posSec), Number(p.duration_sec ?? 0));
            break;
         }

         case "music_error":
            this.sinks.music.setError(String(p.message ?? p.code ?? "Music error"));
            console.warn("[dawn] music_error:", p.code, p.message);
            break;

         case "calendar_list_my_calendars_response": {
            /* The id->{name,color} map for the calendar card's color dots. */
            if (p.success === false) break;
            const cals = (p.calendars ?? []) as Array<Record<string, unknown>>;
            const map: CalendarInfo[] = cals.map((c) => ({
               id: Number(c.id ?? 0),
               name: String(c.name ?? ""),
               color: String(c.color ?? "")
            }));
            this.sinks.calendar.setCalendars(map);
            break;
         }

         case "calendar_upcoming_events_response": {
            /* Today's occurrences. success:true with an empty array covers both an
               empty day and a transient read error (same contract as the LLM tool);
               the panel renders "Nothing scheduled" and the next changed-push heals. */
            if (p.success === false) break;
            const evs = (p.events ?? []) as Array<Record<string, unknown>>;
            this.sinks.calendar.setEvents(evs.map(toCalendarEvent), p.truncated === true);
            break;
         }

         case "calendar_events_changed":
            /* A background CalDAV sync changed something. Refetch (debounced, since a
               multi-calendar sync can fire several in a burst). */
            this.scheduleCalendarRefetch();
            break;

         case "doc_library_list_response": {
            /* Notes + documents for the Library panel. success:false (or an empty set)
               renders "Nothing in the library"; the panel labels this response by the
               in-flight request kind (list / search / load-more). */
            if (p.success === false) break;
            const docs = (p.documents ?? []) as Array<Record<string, unknown>>;
            this.sinks.library.setItems(docs.map(toLibraryItem), {
               append: this.pendingLibraryAppend,
               searching: this.pendingLibrarySearching,
               hasMore: p.has_more === true
            });
            break;
         }

         case "doc_library_get_response": {
            /* Resolve the reader's pending full-text request for this id. success:false
               (unavailable) resolves null so the reader can fall back. */
            const id = Number(p.id ?? 0);
            const pending = this.pendingDocGets.get(id);
            if (pending) {
               window.clearTimeout(pending.timer);
               this.pendingDocGets.delete(id);
               if (p.success === true && typeof p.text === "string") {
                  pending.resolve({
                     text: p.text,
                     filename: String(p.filename ?? ""),
                     filetype: String(p.filetype ?? "")
                  });
               } else {
                  pending.resolve(null);
               }
            }
            break;
         }

         case "doc_library_note_update_response":
         case "doc_library_doc_update_response": {
            /* Resolve the single in-flight edit save. success:false carries the reason (a label
               collision, the pre-v63 "re-save to enable editing" reject, ...); surface it
               verbatim. note_update omits the id on its error branches, which is why this uses
               one pending slot rather than id correlation. */
            const pending = this.pendingDocEdit;
            if (pending) {
               window.clearTimeout(pending.timer);
               this.pendingDocEdit = null;
               const err =
                  p.success === true
                     ? null
                     : typeof p.error === "string" && p.error
                       ? p.error
                       : "Save failed.";
               pending.resolve(err);
            }
            break;
         }

         case "ha_status_response":
            /* Configured/connected for the board header. Absent fields => false. */
            this.sinks.ha.setStatus({
               configured: p.configured === true,
               connected: p.connected === true,
               error: typeof p.error === "string" ? p.error : undefined
            });
            break;

         case "ha_entities_response": {
            /* Both ha_list_entities and ha_refresh_entities land here. success:false
               means HA is unreachable (NOT an empty house) - surface offline and keep
               the last snapshot on screen. On success, rebuild the merged map and emit
               the whole set; a future single-entity push merges into this same map. */
            if (p.success === false) {
               this.sinks.ha.setStatus({
                  configured: true,
                  connected: false,
                  error: typeof p.error === "string" ? p.error : undefined
               });
               break;
            }
            const ents = (p.entities ?? []) as Array<Record<string, unknown>>;
            this.haEntities.clear();
            for (const e of ents) {
               const ent = toHAEntity(e);
               if (ent.entityId) this.haEntities.set(ent.entityId, ent);
            }
            this.sinks.ha.setStatus({ configured: true, connected: true });
            this.sinks.ha.setEntities([...this.haEntities.values()]);
            break;
         }

         case "ha_call_service_response": {
            /* Ack for a widget control (§9.4 #8). Success is silent: the server has
               already re-polled HA and will broadcast a fresh ha_entities_response, which
               reconciles the board (the optimistic flip only bridged the round-trip). A
               failure gets no broadcast, so revert the optimistic flip with a live re-poll
               and surface why (allowlist reject, HA offline, HA-side error). */
            if (p.success === false) {
               const err = typeof p.error === "string" && p.error ? p.error : "Home Assistant control failed";
               console.warn("[dawn] ha_call_service failed:", p.entity_id, err);
               this.refreshHA();
               this.spikeNotice("ha-notice", "home", err, {
                  tone: "attention",
                  hold: 7
               });
            }
            break;
         }

         case "ha_state_changed": {
            /* Realtime delta (§9.4 #3): an unsolicited, coalesced (~200ms) push of the
               entities that just changed - from ANY source (a control action, a physical
               switch, an HA automation), so one frame can carry many entities (a scene
               flip). Batch-merge the whole array into the retained map by entity_id -
               each element is either a full entity (toHAEntity handles it) or a
               {entity_id, removed:true} tombstone - then re-emit the full set so the board
               diff-spikes just the changed rows. The 30s poll stays as the backstop, so a
               client that misses or ignores this frame still self-heals. HA strings are
               bound via textContent downstream (they now arrive without an admin gesture). */
            const ents = (p.entities ?? []) as Array<Record<string, unknown>>;
            let touched = false;
            for (const e of ents) {
               const id = String(e.entity_id ?? "");
               if (!id) continue;
               if (e.removed === true) this.haEntities.delete(id);
               else this.haEntities.set(id, toHAEntity(e));
               touched = true;
            }
            if (touched) this.sinks.ha.setEntities([...this.haEntities.values()]);
            break;
         }

         case "watch_list_response": {
            /* The SAGE watch rules + live readings (Watches panel). A FAILED list carries no
               watches/catalog/attention_enabled, so surface a status error and keep the last
               rows rather than rendering an empty list (which would read as "nothing watched").
               Watch strings (label/name/unit/source) are bound via textContent downstream. */
            if ((p as { success?: boolean }).success === false) {
               this.sinks.watches.setStatus({
                  ok: false,
                  attentionEnabled: false,
                  error: typeof (p as { error?: string }).error === "string" ? (p as { error?: string }).error : "Couldn't list watches"
               });
               break;
            }
            const rows = (p.watches ?? []) as Array<Record<string, unknown>>;
            const catalog = ((p.catalog ?? []) as Array<Record<string, unknown>>).map((c) => ({
               key: String(c.key ?? ""),
               label: String(c.label ?? c.key ?? ""),
               unit: String(c.unit ?? ""),
               ruleType: typeof c.rule_type === "string" ? c.rule_type : undefined,
               defaultDirection: typeof c.default_direction === "string" ? c.default_direction : undefined,
               defaultThreshold: typeof c.default_threshold === "number" ? c.default_threshold : undefined
            }));
            this.sinks.watches.setWatches(rows.map(toWatchItem), catalog);
            this.sinks.watches.setStatus({
               ok: true,
               attentionEnabled: (p as { attention_enabled?: boolean }).attention_enabled === true
            });
            break;
         }

         case "watch_set_enabled_response": {
            /* A benign toggle ack. On failure surface the reason; either way re-list so the
               panel reflects the server-authoritative truth (mirrors the HA reconcile). */
            if ((p as { success?: boolean }).success === false) {
               const err = (p as { error?: string }).error;
               console.warn("[dawn] watch_set_enabled failed:", err);
               this.spikeNotice("watch-toggle", "attention", err || "Couldn't update the watch", {
                  tone: "attention",
                  hold: 6
               });
            }
            this.send({ type: "watch_list" });
            break;
         }

         case "watch_readings": {
            /* The ~1 Hz live-gauge stream (only while subscribed + SAGE attention is on).
               Patch just the volatile values onto the existing rows - no re-list, no spike. */
            const readings = (p.readings ?? []) as Array<Record<string, unknown>>;
            this.sinks.watches.setReadings(
               readings.map((r) => ({
                  id: Number(r.id ?? 0),
                  hasCurrent: r.has_current === true,
                  current: typeof r.current === "number" ? r.current : undefined,
                  breaching: typeof r.breaching === "boolean" ? r.breaching : undefined
               }))
            );
            break;
         }

         case "stocks_portfolio_update":
            /* Portfolio push (immediate on subscribe, then on cadence, or a one-shot get). */
            this.sinks.stocks.setPortfolio(toStockPortfolio(p));
            break;

         case "stocks_watch_update":
            /* Watchlist push (immediate on subscribe, on cadence, on a set, or a one-shot get). */
            this.sinks.watchlist.setWatchlist(toStockWatchlist(p));
            break;

         /* Acks for the subscribe/unsubscribe verbs - the data arrives as its own frame, so
            these are no-ops. Present so the default arm does not console.debug the payload. */
         case "stocks_portfolio_subscribe_response":
         case "stocks_portfolio_unsubscribe_response":
         case "stocks_watch_subscribe_response":
         case "stocks_watch_unsubscribe_response":
            break;

         case "stocks_watch_set_response": {
            /* Surface any rejected add (typo / unknown symbol / hit the 25 cap) as a notice, so an
               invalid add is not a silent no-op. Feature-detected: no `rejected` => nothing shown. */
            const msg = watchRejectMessage(p.rejected);
            if (msg) this.notifyUser(msg);
            break;
         }

         case "watch_readings_subscribe_response":
            break; // just an ack; the readings frames are what matter

         case "watch_add_response":
         case "watch_update_response":
         case "watch_remove_response": {
            /* Phase-2 CRUD acks. Surface a failure; re-list either way so the panel reflects
               the server-authoritative truth (add upserts + re-enables, update/remove change
               the row). */
            const r = p as { success?: boolean; error?: string };
            if (r.success === false) {
               console.warn("[dawn] watch mutation failed:", type, r.error);
               this.spikeNotice("watch-mutate", "attention", r.error || "Couldn't update the watch", {
                  tone: "attention",
                  hold: 6
               });
            }
            this.send({ type: "watch_list" });
            break;
         }

         case "jobs_snapshot": {
            /* The complete active set — replace ours wholesale. */
            this.jobs.clear();
            for (const j of (p.jobs ?? []) as JobRow[]) this.trackJob(j);
            this.renderJobs();
            break;
         }

         case "job_update": {
            /* One job's transition. Track by id, drop on any terminal status. A
               newly-appearing active job also fires a brief toast notice, separate from
               the sticky jobs card (which just reflects the active set). */
            const job = (p.job ?? {}) as JobRow;
            const wasActive = job.conversation_id != null && this.jobs.has(job.conversation_id);
            this.trackJob(job);
            const nowActive = job.conversation_id != null && this.jobs.has(job.conversation_id);
            if (!wasActive && nowActive) {
               this.spikeNotice("job-notice", "jobs", `Started: ${job.title || "background job"}`, {
               });
            }
            this.renderJobs();
            break;
         }

         case "jobs_invalidate":
            this.send({ type: "jobs_request" });
            break;

         case "job_notification":
            /* A job finished: spike a transient notice that recedes on its own. */
            this.spikeNotice("job-notice", "jobs", String(p.text ?? "Background job complete"), {
            });
            break;

         case "attention_alert": {
            /* SAGE proactive attention — the signature ambient spike. level=alert
               needs the user (warm + claims the front); level=ambient is an FYI. */
            const alert = String(p.level ?? "ambient") === "alert";
            const summary = String(p.summary ?? "");
            /* Key the notice by its text: distinct alerts get distinct cards (two watches firing
               close together stack instead of one overwriting the other), while an identical
               re-fire coalesces onto the same card and re-spikes - so one flapping watch can't
               crowd the rest out. Content-stable, so it also survives a reload without colliding
               with a per-session counter (which would reset and inherit stale saved positions). */
            this.spikeNotice(`attention:${summary}`, "attention", summary, {
               tone: alert ? "attention" : "nominal",
               hold: alert ? 9 : 6,
               persist: alert, // a "needs you" alert stays until docked or closed; an FYI fades
               urgent: alert, // a needs-you alert peeks the standby screensaver; an ambient FYI does not
               /* Spawn centered, in the reactor's full-height dead strip: docked panels are kept
                  in the left/right columns flanking it, so a centered notice avoids them. */
            });
            break;
         }

         case "silent_observation":
            /* A quieter noticed-something FYI, categorized (calendar/email/…). Keyed by
               category+note so distinct observations stack and identical ones coalesce (see
               attention_alert). */
            const category = String(p.category ?? "note");
            const note = String(p.note ?? "");
            this.spikeNotice(`observation:${category}:${note}`, category, note, {
               hold: 5,
               /* Centered in the dead strip too (see attention_alert), just lower. */
            });
            break;

         case "context_injection": {
            /* What DAWN pulled into context for this turn (the focus block) - the Context
               panel's "why did it say that" feed. This frame is FLAT AT THE ROOT (no
               `payload`; verified in webui_broadcasts.c), and DAWN scopes it server-side to
               our active conversation, so we just push the latest. All item text is
               memory/model-sourced -> the panel binds it via textContent. */
            const root = msg as Record<string, unknown>;
            const items = (root.items ?? []) as Array<Record<string, unknown>>;
            const rej = (root.filter_rejections ?? []) as Array<Record<string, unknown>>;
            this.sinks.context.show({
               conversationId: Number(root.conversation_id ?? 0),
               turnId: Number(root.turn_id ?? 0),
               items: items.map(toContextItem),
               rejections: rej.map((r) => ({
                  sourceId: String(r.source_id ?? ""),
                  count: Number(r.count ?? 0)
               }))
            });
            break;
         }

         case "context_citations": {
            /* At turn END, the rows the model actually cited in its answer (validated
               item_ids). FLAT AT THE ROOT like context_injection. turn_id matches the
               context_injection turn (both last_user_msg_id), so the panel golds the already-
               rendered rows scoped by (conversation_id, turn_id). Only ever memory rows. */
            const root = msg as Record<string, unknown>;
            const ids = (root.cited_item_ids ?? []) as unknown[];
            this.sinks.context.applyCitations(
               Number(root.conversation_id ?? 0),
               Number(root.turn_id ?? 0),
               ids.map((v) => String(v)).filter(Boolean)
            );
            break;
         }

         case "scheduler_notification": {
            /* Alarms/timers/reminders. One movable card per event (`scheduler-<id>`) so
               concurrent events don't clobber each other. Behaviour mirrors DAWN's own WebUI
               (www/js/ui/scheduler.js): a client chime on every live notification (skipped
               for a `missed` replay); a ringing ALARM additionally loops a tone + is tracked
               for the dismiss->scheduler_action path. Reminders/timers auto-dismiss server-
               side after their chime, so they are NOT tracked and their auto-dismiss frame is
               ignored below (else the card would flash and vanish before it can be read). */
            const status = String(p.status ?? "");
            const message = String(p.message ?? "");
            const eventType = String(p.event_type ?? "alarm");
            const eventId = Number(p.event_id ?? 0);
            const missed = p.missed === true;
            const noticeId = `scheduler-${eventId}`;
            /* A morning briefing (event_type "briefing") creates a persistent conversation and
               carries its id here, so its card is click-to-open. Other scheduler events (alarms/
               timers/reminders) omit it -> a non-clickable card. Feature-detected: an older
               daemon or a briefing whose conversation failed to create won't carry it. */
            const convId = Number(p.conversation_id ?? 0);
            const wasRinging = this.ringingAlarms.has(eventId);
            if (status === "ringing" || status === "fired") {
               /* A live ringing alarm is `critical` so the notification layer's persist-cap
                  can't silently evict its card - that would leave the loop beeping with no
                  on-screen control. Reminders/timers and missed replays are ordinary. */
               const ringingAlarm = eventType === "alarm" && status === "ringing" && !missed;
               this.spikeNotice(noticeId, eventType, String(p.name ?? "Alarm"), {
                  tone: "attention",
                  hold: 10,
                  detail: message,
                  persist: true, // stays readable until dismissed or docked (WebUI parity)
                  critical: ringingAlarm,
                  /* A ringing alarm gets Snooze (with a duration dropdown, default 10 = DAWN's
                     default_snooze_minutes) + Dismiss; both silence the tone. Reminders/timers
                     keep the plain close (nothing to stop). */
                  actions: ringingAlarm
                     ? [
                          {
                             id: "snooze",
                             label: "Snooze",
                             options: [
                                { value: "1", label: "1 min" },
                                { value: "5", label: "5 min" },
                                { value: "10", label: "10 min" },
                                { value: "30", label: "30 min" }
                             ],
                             defaultValue: "10"
                          },
                          { id: "dismiss", label: "Dismiss" }
                       ]
                     : undefined,
                  open: convId > 0 ? { kind: "conversation", id: convId } : undefined,
                  /* A live (non-missed) fire wakes the standby screensaver (peek): alarms,
                     timers, reminders, and briefings. A `missed` reconnect replay does not. */
                  urgent: !missed
               });
               /* A live ringing alarm's sound IS the looping tone (started below) - no separate
                  one-shot, which would double over the loop's first beat. A non-alarm live
                  notification gets the one ascending chime (skip a missed replay). Only a live
                  ringing alarm drives the loop AND is tracked for the dismiss->scheduler_action
                  path; a missed replay is neither, so it leaves no phantom set entry that would
                  keep the loop beeping. */
               if (ringingAlarm) {
                  this.ringingAlarms.add(eventId);
                  this.alarmChime.startLoop(); // idempotent on a re-broadcast
               } else if (!missed && !wasRinging) {
                  this.alarmChime.playChime();
               }
            } else {
               /* Non-ringing (dismissed/cancelled/snoozed/timed_out). A ringing alarm's loop
                  stops on ANY non-ringing status. Then: IGNORE a server AUTO-dismiss/timeout
                  (both it and a user dismiss carry status "dismissed", so key on the message
                  prefix / "timed_out" like WebUI, NOT the status) so it can't wipe the card;
                  a real user/other-client dismiss removes it. */
               if (this.ringingAlarms.delete(eventId) && this.ringingAlarms.size === 0) {
                  this.alarmChime.stopLoop();
               }
               const isAuto = status === "timed_out" || message.startsWith("Auto-");
               if (!isAuto) this.sinks.notifications.remove(noticeId);
            }
            break;
         }

         case "metrics_update": {
            /* token_rate -> throughput strain (gauge, live) AND an EMA for the HUD (a
               smooth figure that tracks recent generations, not the fluctuating
               instantaneous rate). Strain normalized against a brisk ~50 tok/s. */
            const rate = Number(p.token_rate ?? 0);
            this.sinks.reactor.setStrain(Math.min(rate / 50, 1));
            /* ttft_ms -> hesitation (the pause before the first token), full at ~2s. Only
               when reported (>0); metrics_update sometimes omits it mid-generation. */
            const ttft = Number(p.ttft_ms ?? 0);
            if (ttft > 0) this.sinks.reactor.setHesitation(Math.min(ttft / 2000, 1));
            if (rate > 0) {
               this.rateEma =
                  this.rateEma > 0 ? this.rateEma + RATE_EMA_ALPHA * (rate - this.rateEma) : rate;
               localStorage.setItem(RATE_EMA_KEY, String(this.rateEma));
               this.sinks.telemetry.update({ rate: `${Math.round(this.rateEma)}/s` });
            }
            /* Cache hit-rate + savings for the CACHE / CACHE AVG rows, sampled off the FINAL/idle
               frame ONLY: the mid-stream "thinking" frames fire before usage is parsed and carry
               the PREVIOUS turn's numbers. On the idle frame input_tokens/cached_tokens are
               always present (a cache-miss turn honestly reports 0); cache_saved_tokens too (may
               be negative on a cold write turn). Gate on a NUMERIC input_tokens (the denominator):
               an older daemon omits it, so the rows stay "--" rather than skewing the session
               sums; the typeof check also rejects a stray null that would fold a 0 denominator. */
            if (p.state === "idle" && typeof p.input_tokens === "number") {
               const cached = Math.max(0, Number(p.cached_tokens ?? 0) || 0);
               const input = Math.max(0, Number(p.input_tokens) || 0);
               const saved = Number(p.cache_saved_tokens ?? 0) || 0; // may be negative
               const local = this.llm.mode === "local"; // local models report no billing savings
               /* Sum each turn once (the first idle after its stream_end); later idle frames repeat
                  the same call's figures, and only refresh the per-turn rows. */
               if (this.cacheTurnPending) {
                  this.cacheTurnPending = false;
                  this.cacheSum = {
                     cached: this.cacheSum.cached + cached,
                     input: this.cacheSum.input + input,
                     saved: this.cacheSum.saved + saved
                  };
                  try {
                     localStorage.setItem(CACHE_SUM_KEY, JSON.stringify(this.cacheSum));
                  } catch {
                     /* storage full/disabled - the rows still update in-memory */
                  }
               }
               /* Why the cache did or didn't hit (DAWN 8ed2552d; absent on an older daemon -> "--"). */
               const cs = formatCacheState((p as { cache_state?: unknown }).cache_state);
               this.sinks.telemetry.update({
                  cache: formatCacheTurn(cached, input, saved, local),
                  cachestate: cs.text,
                  cachestate_flag: cs.flag ? "1" : "",
                  cacheavg: formatCacheAvg(this.cacheSum)
               });
            }
            break;
         }

         case "context": {
            /* Context-window usage, last known (pushed during turns): percent plus the raw
               token counts (current / max) from the same frame. */
            const cp = p as { usage?: number; current?: number; max?: number };
            const usage = cp.usage !== undefined ? Number(cp.usage) : undefined; // let formatCtx derive it if absent
            const cur = Number(cp.current ?? 0);
            const max = Number(cp.max ?? 0);
            this.sinks.telemetry.update({ ctx: formatCtx(cur, max, usage) });
            break;
         }

         case "get_metrics_response": {
            /* HUD: TTFT (time to first token) and LATENCY (full LLM response), both
               averaged for stability; token rate + context usage come from their own
               push frames. */
            const m = p as {
               session?: { uptime_seconds?: number };
               last?: { llm_ttft_ms?: number; llm_total_ms?: number };
               averages?: { llm_ttft_ms?: number; llm_total_ms?: number };
            };
            const ttft = m.averages?.llm_ttft_ms || m.last?.llm_ttft_ms || 0;
            const latency = m.averages?.llm_total_ms || m.last?.llm_total_ms || 0;
            /* Re-sync the uptime base; the 1 Hz ticker carries it between polls. */
            this.uptimeBaseSec = m.session?.uptime_seconds ?? 0;
            this.uptimeBaseAt = performance.now();
            this.sinks.telemetry.update({
               ttft: ttft > 0 ? `${Math.round(ttft)}ms` : "--",
               lat: latency > 0 ? `${Math.round(latency)}ms` : "--"
            });
            this.tickUptime();
            break;
         }

         case "stream_start":
            this.sinks.conversation.startReply();
            break;

         case "stream_delta": {
            this.sinks.conversation.appendDelta(String(p.delta ?? ""));
            break;
         }

         case "stream_end": {
            this.sinks.conversation.endReply();
            /* A tool_iteration end is a mid-turn bubble seal (the tool loop re-issues
               stream_start/end per iteration); only a TERMINAL end carries the final answer. */
            const reason = typeof p.reason === "string" ? p.reason : "";
            if (reason !== "tool_iteration") {
               this.cacheTurnPending = true; // the next idle metrics_update carries this turn's cache figures
               /* DAWN is the sole writer of the turn (server-authoritative persistence): the
                  client no longer saves the reply. Register the finalized bubble under
                  (conv, streamId) so the fanned message_appended adopts onto it instead of
                  re-rendering. A real streamed reply always has streamId > 0; warn if not, since a
                  0 can't correlate the fan-out (it would double-render). Active conversation only. */
               const conv = Number(p.conversation_id ?? this.convId); // wire int64; coerce like the rest of the file
               const streamId = Number(p.stream_id ?? 0);
               if (conv === this.convId) {
                  if (!(streamId > 0)) {
                     console.warn("[dawn] terminal stream_end with no stream_id - fan-out may double-render", conv);
                  }
                  this.sinks.conversation.linkStream(conv, streamId);
               }
               /* Settle the UI to idle when no voice is (or will be) playing. A reinvoke
                  re-engagement drives no state:idle and carries no TTS, so without this the reactor
                  hangs in its last state (thinking/speaking). Guard on dawnSpeaking + the live TTS
                  tail so a NORMAL spoken turn keeps its voice animation until DAWN's real state:idle
                  arrives (which handles the TTS-tail timing). */
               if (!this.dawnSpeaking && !this.tts.isSpeaking()) {
                  this.lastState = "idle";
                  this.resetTurnConv = 0;
                  this.sinks.reactor.setState("idle");
                  this.sinks.conversation.setThinking(false);
                  this.sinks.conversation.setStatus(this.activityFor("idle", undefined, undefined));
               }
               /* Refresh the picker for our OWN just-finished turn: its `bumped` frames are
                  self-echo-filtered in conversation_list_changed, so without this the active row's
                  count/time/position would stay stale until some other interface changed something.
                  Debounced + coalesced with the terminal end (one fetch per turn, not per tool
                  iteration), and invisible while the picker is collapsed. */
               this.scheduleListRefresh();
            }
            break;
         }

         case "tool_step": {
            /* Live tool use, fanned to every viewer of the active conversation - the ORIGIN too,
               since Aurora advertised `tool_step_origin` (it has no stream-derived tool render, so
               this is its ONLY live tool signal; the server includes us). Ephemeral: NOT persisted,
               NOT message_appended-fanned - a reload rebuilds the same pills from the `tool_calls`
               column, so a missed frame loses nothing. Renders ordered per-call pills: a `tool_call`
               opens/updates a pill keyed on `tool_call_id`; a `tool_result` attaches its result to
               that pill. stream_id is informational - key nothing on it. See the frozen contract in
               docs/DAWN_UI_SIGNAL_MAP.md and [[living-tool-pills-plan]]. */
            const conv = Number(p.conversation_id ?? 0);
            if (!conv || conv !== this.convId) break; // not the conversation on screen (or none) -> ignore
            /* The inner `payload` is an opaque, redacted JSON string - untrusted. tool_call_id
               rides INSIDE it (same place `tool` does), byte-identical to load_conversation's key
               so live + reload pair on one implementation; omitted when the provider gave none. All
               fields reach the DOM via textContent (never innerHTML). */
            let obj: { tool?: unknown; args?: unknown; result?: unknown; tool_call_id?: unknown; iter?: unknown; error?: unknown } = {};
            try {
               obj = JSON.parse(String(p.payload ?? "")) as typeof obj;
            } catch {
               /* garbled / non-JSON payload -> treat as empty (generic label, no detail) */
            }
            const id = typeof obj.tool_call_id === "string" ? obj.tool_call_id : "";
            const detailStr = (v: unknown): string | undefined =>
               v == null ? undefined : typeof v === "string" ? v : JSON.stringify(v);
            if (p.kind === "tool_result") {
               const result = detailStr(obj.result);
               /* `error:true` = confirmed hard failure (DAWN derives it at execute time, never from
                  result text, so it's not attacker-forceable); omitted = success or unknown -> neutral. */
               const error = obj.error === true;
               if (id) this.sinks.conversation.toolResult(id, result ?? "", error);
               break;
            }
            /* default: a tool_call (open/update the pill). `iter` seals the group at a tool-loop
               iteration boundary (present when >= 0, omitted otherwise); acted on for tool_call only. */
            const name = typeof obj.tool === "string" && obj.tool ? obj.tool : "tool";
            const iter = typeof obj.iter === "number" ? obj.iter : undefined;
            this.sinks.conversation.toolCall({ id, name, args: detailStr(obj.args), iter });
            break;
         }

         case "transcript":
            /* DAWN smuggles llm_state_update inside a transcript with this role
               (webui_server.c). Intercept it — it is not a message. */
            if (p.role === "__llm_state__" && typeof p.text === "string") {
               this.applyLlmState(p.text);
               break;
            }
            /* A user turn echoed by DAWN. It fires for typed AND voice input; we already
               appended the typed bubble locally (recorded in typedEchoes), so dedupe that
               and display only what has no local counterpart - i.e. spoken input. */
            if (p.role === "user" && typeof p.text === "string") {
               /* Confirm our held turn: by its ref when DAWN echoes one (turn_refs), else the oldest held
                  turn with this text. */
               if (p.replay !== true) {
                  const ref = typeof (p as { client_ref?: unknown }).client_ref === "string" ? (p as { client_ref: string }).client_ref : undefined;
                  if (ref !== undefined || !this.hasFeature("turn_refs")) this.sinks.conversation.confirmTurn(p.text, ref);
               }
               this.handleIncomingUser(
                  p.text.trim(),
                  Number((p as { message_id?: number }).message_id ?? 0),
                  p.replay === true,
                  typeof (p as { client_ref?: unknown }).client_ref === "string" ? (p as { client_ref: string }).client_ref : undefined
               );
               break;
            }
            /* A complete (non-streamed or replayed) assistant message. DAWN persists it itself
               (server-authoritative); the client only renders it, stamping the row's message_id
               so the fanned message_appended dedups against this bubble. A live non-streamed reply
               must carry a message_id (> 0) - warn if not, since a 0 can't dedup the fan-out. */
            if (p.role === "assistant" && typeof p.text === "string") {
               const info = interpretMessage(p.text);
               const messageId = Number((p as { message_id?: number }).message_id ?? 0);
               if (info?.text) {
                  if (p.replay !== true && !(messageId > 0)) {
                     console.warn("[dawn] assistant transcript with no message_id - fan-out may double-render");
                  }
                  this.sinks.conversation.showReply(info.text, messageId);
               }
               if (info?.tools) for (const c of info.tools) this.sinks.conversation.toolCall(c);
            }
            break;

         case "message_appended": {
            const cid = Number((p as { conversation_id?: number }).conversation_id ?? 0);
            /* A NON-active conversation's message: mark its row unread; it renders on open, and a
               job answer also surfaces via its job_notification toast. */
            if (cid && cid !== this.convId) {
               this.sinks.conversationList.markAppended(cid);
               break;
            }
            if (!cid) break;
            /* The ACTIVE conversation (server-authoritative-persistence, Phase 0 cross-viewer
               render). Correlate on (conv, stream_id):
               - our OWN streamed reply's save-echo -> adopt the DB id onto the bubble we already
                 rendered (no duplicate); this also confirms the server persisted it.
               - a turn we did NOT stream (another open viewer's turn, or a server-side turn with
                 stream_id 0) -> render it inline, deduped on message_id. This is what fixes the
                 two-viewers-on-one-conversation gap: the second viewer now sees the reply. */
            const messageId = Number((p as { message_id?: number }).message_id ?? 0);
            const streamId = Number((p as { stream_id?: number }).stream_id ?? 0);
            const role = (p as { role?: string }).role === "user" ? "user" : "assistant";
            if (streamId && this.sinks.conversation.adoptId(cid, streamId, messageId)) break; // our streamed reply's echo
            /* User fan-out (stream_id 0): route through the same order-independent handler as the
               transcript echo, so the origin's optimistic bubble is recognized (dedup) and a
               non-origin viewer renders it as a user bubble. */
            if (role === "user") {
               /* Our own turn's fan-out may carry its client_ref (turn_refs): needed to recognize a
                  structured-attachments turn whose echo was lost, since its server-built text can't
                  match what we sent. */
               const fanRef = typeof (p as { client_ref?: unknown }).client_ref === "string" ? (p as { client_ref: string }).client_ref : undefined;
               this.handleIncomingUser(String((p as { text?: string }).text ?? "").trim(), messageId, false, fanRef);
               break;
            }
            const info = interpretMessage(String((p as { text?: string }).text ?? ""));
            const text = info?.text ?? "";
            if (text) this.sinks.conversation.renderAppended({ role, text, messageId });
            if (info?.tools) for (const c of info.tools) this.sinks.conversation.toolCall(c);
            break;
         }

         case "always_on_state": {
            /* The ONLY always-on push (states: listening | wake_check | wake_pending |
               recording | processing | disabled). These are DAWN's internal VAD
               micro-states; we don't map them to the reactor (they'd thrash the busy
               channel), the normal `state` frames still drive it during an always-on turn. */
            const st = typeof p.state === "string" ? p.state : "";
            /* "recording" = DAWN is capturing the user's command; everything else is not.
               Drives the keep-mic-open override in updateMicMute. `entering` = the once-per-
               wake transition INTO recording, which triggers the ready ding. */
            const enteringRecording = st === "recording" && !this.alwaysOnRecording;
            this.alwaysOnRecording = st === "recording";
            if (st === "disabled") {
               /* Server turned us off (60s no-audio auto-disable, or the echo of our own
                  disable). If our latch is still up it was unsolicited -> tear down + clear
                  the resume so we don't fight it on reconnect. */
               if (this.continuousOn) {
                  this.continuousOn = false;
                  this.resumeContinuous = false;
                  this.mic.continuousStop();
               }
            } else if (this.continuousOn) {
               /* Ready ding: replaces DAWN's dropped spoken greeting. Once per wake (guarded
                  by the transition), and safe to play into the open mic - a pure tone isn't
                  VAD-scored as speech, so it can't re-trigger the echo stall. */
               if (enteringRecording) {
                  this.ding.play();
                  this.voiceWake?.(); // a wake-word match: wake the standby screensaver
               }
               /* Re-evaluate the mute on every micro-state transition: unmute entering
                  "recording" (capture the command), and let the speaking/tail logic re-mute
                  for "processing" + the reply. The cooldown means this can't reopen mid-reply
                  the way a bare unmute would. */
               this.updateMicMute();
            }
            break;
         }

         default:
            /* Log each unseen type ONCE — this is our live map of what to wire
               next (attention_alert, scheduler_notification, job_*, music_*, ...). */
            if (!this.seenUnhandled.has(type)) {
               this.seenUnhandled.add(type);
               console.debug("[dawn] unhandled frame:", type, p);
            }
      }
   }

   /* Resolve the activity chip for a `state` frame, applying the tool-use latch.
      A tool_call ping or a running tool in `tools[]` opens the latch; it holds
      "Using tools" through the thinking frames DAWN emits while the tool runs and
      its results are processed, and closes when the turn leaves the thinking phase
      (speaking / idle / listening / error). Without this a fast tool is invisible. */
   private activityFor(st: string, detail: string | undefined, toolsRaw: unknown): ActivityStatus | null {
      const tools = Array.isArray(toolsRaw)
         ? (toolsRaw as Array<{ name?: string; status?: string }>)
         : [];
      const runningTool = tools.find((t) => t.status === "running");
      const inToolPhase = st === "tool_call" || Boolean(runningTool);

      if (inToolPhase) {
         this.toolActive = true;
         this.toolName =
            runningTool?.name ??
            tools[0]?.name ??
            detail?.match(/^Calling\s+(.+?)\.{0,3}\s*$/i)?.[1] ??
            this.toolName;
      } else if (st !== "thinking" && st !== "summarizing") {
         this.toolActive = false;
         this.toolName = undefined;
      }

      if (this.toolActive) return { label: "Using tools", detail: this.toolName };
      return toActivity(st, detail);
   }

   /* Deterministic "New Chat" (not routed through DAWN's LLM tool): reset the
      daemon's context (clear_session), drop our conversation id so the next message
      opens a fresh one, and wipe the surface. Mirrors the old WebUI's startNewChat. */
   newChat(): void {
      this.send({ type: "clear_session" });
      /* A new chat starts on DAWN's configured default model (dawn.toml), not whatever the last
         conversation ran on: DAWN's "reset" restores the session LLM config to its defaults, and
         the set_session_llm_response echo carries the resulting type/provider/model/reasoning
         for the panel. Sent after clear_session, so no conversation is active to stamp it on. */
      this.send({ type: "set_session_llm", payload: { type: "reset" } });
      this.convId = 0;
      localStorage.removeItem(CONV_KEY); // fresh chat: nothing to resume until a message opens one
      /* Finalize any in-flight streamed bubble before wiping (both the menu New Chat and the
         picker "+ New" arrive here). */
      this.sinks.conversation.endReply();
      this.settleTurnOnSwitch();
      this.sinks.conversation.clear();
      this.sinks.context.clear();
      this.sinks.conversationList.setActive(0);
      this.pendingNewConvTitle = "";
      this.setActiveTitle(""); // reset the HUD readout to the fresh-chat placeholder (was lingering the old title)
   }

   /* Map DAWN's conversation object (list/search) into the picker's ConversationMeta.
      ids are DB AUTOINCREMENT ints, so Number() is exact. */
   private toMeta(c: Record<string, unknown>): ConversationMeta {
      return {
         id: Number(c.id ?? 0),
         title: typeof c.title === "string" ? c.title : "",
         createdAt: Number(c.created_at ?? 0),
         updatedAt: Number(c.updated_at ?? 0),
         messageCount: Number(c.message_count ?? 0),
         isArchived: Boolean(c.is_archived),
         isPrivate: Boolean(c.is_private),
         isPinned: Boolean(c.is_pinned),
         origin: typeof c.origin === "string" ? c.origin : "webui"
      };
   }

   /* Refetch the first page of the list (a replace), reconciling the picker after a
      mutation whose response can't be patched in place (rename/delete failure, a new row) or a
      live conversation_list_changed. Queue-don't-drop: if a list/search request is already in
      flight, mark a pending refresh and let settleListRequest() re-fire it on the response,
      rather than sending a second page-0 that races the in-flight one (which could be consumed
      as an append and duplicate/replace the list). All callers inherit this safety. */
   private requestConversations(): void {
      if (this.conversationsLoading) {
         this.pendingListRefresh = true; // invariant: only set while loading; drained on settle
         return;
      }
      this.pendingListAppend = false;
      this.conversationsLoading = true;
      this.send({ type: "list_conversations", payload: { limit: CONV_PAGE, offset: 0 } });
   }

   /* Clear the single-flight latch on a list/search response, then drain a refresh that was
      queued while it was in flight. Called from BOTH list and search response handlers so a
      queued refresh is never stranded behind a search. */
   private settleListRequest(): void {
      this.conversationsLoading = false;
      if (this.pendingListRefresh) {
         this.pendingListRefresh = false;
         this.requestConversations();
      }
   }

   /* Debounced page-0 refresh for the live conversation_list_changed frame (and the own-turn /
      mutation-success reconciles). Coalesces a turn's >=2 bumped frames into one refetch. */
   private scheduleListRefresh(): void {
      window.clearTimeout(this.convListTimer);
      this.convListTimer = window.setTimeout(() => {
         this.convListTimer = 0;
         this.requestConversations();
      }, CONV_LIST_DEBOUNCE_MS);
   }

   /* --- Conversation picker (Ingest) -------------------------------------- */
   listConversations(opts: { limit: number; offset: number }): void {
      if (this.conversationsLoading) return; // one list/search request in flight at a time
      this.pendingListAppend = opts.offset > 0;
      this.conversationsLoading = true;
      this.send({ type: "list_conversations", payload: { limit: opts.limit, offset: opts.offset } });
   }

   searchConversations(query: string, content: boolean, opts?: { limit?: number; offset?: number }): void {
      this.conversationsLoading = true;
      this.pendingListAppend = false;
      this.send({
         type: "search_conversations",
         payload: {
            query,
            search_content: content,
            limit: opts?.limit ?? CONV_PAGE,
            offset: opts?.offset ?? 0
         }
      });
   }

   loadConversation(id: number): void {
      if (id <= 0) return;
      /* Finalize any in-flight streamed bubble before switching id. Set convId optimistically so
         a text sent before the response is tagged to the right conversation (M2);
         load_conversation_response confirms it. */
      this.sinks.conversation.endReply();
      if (id !== this.convId) this.settleTurnOnSwitch();
      if (this.privateCreate) {
         this.settlePrivateCreate(false);
         this.discardNextCreate = true; // its new_conversation_response must not steal the view
      }
      this.convId = id;
      this.sinks.conversationList.setActive(id);
      this.send({ type: "load_conversation", payload: { conversation_id: id } });
   }

   newConversation(opts: { private?: boolean } = {}): Promise<boolean> {
      /* A second "Discuss privately" while one is in flight joins it (no second conversation). */
      if (opts.private && this.privateCreate) return this.privateCreate.promise;
      /* Lazy creation (Aurora's model): clear the surface + id now; the first message
         opens the conversation via the convId===0 path in submit(). */
      this.newChat();
      if (!opts.private) return Promise.resolve(true);
      /* Private-first (the Mail panel's "Discuss privately"): create the conversation NOW and
         resolve only after DAWN confirms set_private, so the first turn (the one carrying the
         email) can never be saved public. The lazy path would send that turn before the
         replayed set_private lands. */
      this.settlePrivateCreate(false);
      if (!this.isLinkLive()) return Promise.resolve(false);
      this.isPrivate = true;
      this.notifyLlm();
      let resolve!: (ok: boolean) => void;
      const promise = new Promise<boolean>((r) => (resolve = r));
      const timer = window.setTimeout(() => this.settlePrivateCreate(false), 10_000);
      this.privateCreate = { resolve, timer, promise };
      this.discardNextCreate = false;
      this.send({ type: "new_conversation", payload: { save_current: true, title: "" } });
      return promise;
   }

   private settlePrivateCreate(ok: boolean): void {
      const p = this.privateCreate;
      if (!p) return;
      this.privateCreate = null;
      window.clearTimeout(p.timer);
      p.resolve(ok);
   }

   renameConversation(id: number, title: string): void {
      if (id > 0 && title.trim()) {
         this.send({ type: "rename_conversation", payload: { conversation_id: id, title } });
      }
   }

   deleteConversation(id: number): void {
      if (id <= 0) return;
      /* Responses carry no conversation_id, so remember which delete is in flight to
         decide the active-delete reset. Confirm is the caller's responsibility (the
         picker gates it behind a named, cascade-explicit dialog). */
      this.pendingDeleteId = id;
      this.send({ type: "delete_conversation", payload: { conversation_id: id } });
   }

   setPinned(id: number, pinned: boolean): void {
      if (id > 0) this.send({ type: "set_pinned", payload: { conversation_id: id, is_pinned: pinned } });
   }

   /* Forget what a conversation (and its continuations) taught memory. DESTRUCTIVE: reached
      only from a confirm dialog's Forget button (the post-private offer or the picker) or a
      failure card's Retry, never a frame handler. DAWN needs only ownership, not privacy. A
      sticky "Forgetting..." card stands in until the reply (up to ~2 min server-side). */
   forgetConversationMemories(id: number): void {
      if (id <= 0) return;
      /* DAWN runs one forget per user at a time and answers a second with "busy", which would
         be taken as the first one's failure (and drop its real result). Hold it client-side. */
      if (this.pendingForgetId) {
         this.spikeNotice("memory-forget-busy", "memory", "A forget is already running; try again when it finishes", {
            hold: 5
         });
         return;
      }
      this.timedOutForgetId = 0;
      this.clearForgetPending();
      if (!this.isLinkLive()) {
         this.forgetFailed(id, "Cannot forget memories: not connected");
         return;
      }
      this.pendingForgetId = id;
      this.sinks.notifications.notify({
         id: FORGET_NOTICE_ID,
         kind: "memory",
         summary: "Forgetting\u2026",
         sticky: true
      });
      this.forgetTimer = window.setTimeout(() => {
         this.clearForgetPending();
         this.timedOutForgetId = id;
         this.spikeNotice(
            FORGET_NOTICE_ID,
            "memory",
            "No reply to the forget request; check the Memory panel before retrying",
            { tone: "attention", persist: true }
         );
      }, FORGET_REPLY_TIMEOUT_MS);
      this.send({ type: "forget_conversation_memories", payload: { conversation_id: id } });
   }

   /* Drop the in-flight forget's timer and card. The card is removed (not replaced in place)
      because a notice's controls + sticky-ness are fixed at mount. */
   private clearForgetPending(): void {
      window.clearTimeout(this.forgetTimer);
      this.forgetTimer = 0;
      this.pendingForgetId = 0;
      this.forgetRetryId = 0;
      this.sinks.notifications.remove(FORGET_NOTICE_ID);
   }

   /* A forget that didn't happen: show why, with Retry (re-sends for the same conversation). */
   private forgetFailed(id: number, message: string): void {
      this.sinks.notifications.remove(FORGET_NOTICE_ID);
      this.forgetRetryId = id;
      this.spikeNotice(FORGET_NOTICE_ID, "memory", message, {
         tone: "attention",
         persist: true,
         actions:
            id > 0
               ? [
                    { id: "retry", label: "Retry" },
                    { id: "dismiss", label: "Dismiss" }
                 ]
               : undefined
      });
   }

   /* --- Library (Ingest) -------------------------------------------------- */
   refreshLibrary(): void {
      this.requestLibrary();
   }

   searchLibrary(query: string, opts?: { limit?: number; offset?: number }): void {
      this.requestLibrary({ query, offset: opts?.offset ?? 0, searching: true });
   }

   loadMoreLibrary(offset: number): void {
      this.requestLibrary({ offset, append: true });
   }

   /* Fetch a document's original file over the same-origin /api proxy (the cookie rides
      it). A GET read; the view decodes text or object-URLs binaries for download. The
      attachment/nosniff headers on the endpoint don't affect a fetch(). */
   async fetchDocumentOriginal(blobId: string): Promise<{ blob: Blob; contentType: string }> {
      const res = await fetch(this.dawnUrl(`/api/documents/original/${encodeURIComponent(blobId)}`), {
         credentials: "same-origin"
      });
      if (!res.ok) throw new Error(`document fetch failed: ${res.status}`);
      const blob = await res.blob();
      return { blob, contentType: res.headers.get("content-type") ?? "" };
   }

   /* Upload a document (POST /api/documents, multipart) over the same-origin /api proxy - a
      sanctioned conversation-input write. DAWN extracts the text server-side and optionally
      stores the original; the composer inlines the result as an [ATTACHED DOCUMENT] marker. */
   async uploadDocument(file: File): Promise<UploadedDoc> {
      const fd = new FormData();
      fd.append("document", file);
      const res = await fetch(this.dawnUrl("/api/documents"), { method: "POST", credentials: "same-origin", body: fd });
      if (!res.ok) throw new Error(`document upload failed: ${res.status}`);
      const j = (await res.json()) as Record<string, unknown>;
      if (j.success === false) throw new Error(String(j.error ?? "upload failed"));
      const blobId =
         typeof j.original_blob_id === "string" && j.original_blob_id ? j.original_blob_id : undefined;
      return {
         filename: String(j.filename ?? file.name),
         content: typeof j.content === "string" ? j.content : "",
         size: Number(j.size ?? file.size),
         type: String(j.type ?? ""),
         blobId
      };
   }

   /* Upload a (client-compressed) image (POST /api/images, multipart field "image") over the
      same-origin /api proxy - a sanctioned conversation-input write. Returns the server id
      used both to attach the image to the turn (image_ids) and to rehydrate it on reload. */
   async uploadImage(image: Blob): Promise<UploadedImage> {
      const fd = new FormData();
      fd.append("image", image, "image.jpg");
      const res = await fetch(this.dawnUrl("/api/images"), { method: "POST", credentials: "same-origin", body: fd });
      if (!res.ok) throw new Error(`image upload failed: ${res.status}`);
      const j = (await res.json()) as Record<string, unknown>;
      const id = typeof j.id === "string" ? j.id : "";
      if (!id) throw new Error("image upload returned no id");
      return { id, mimeType: String(j.mime_type ?? "image/jpeg"), size: Number(j.size ?? 0) };
   }

   /* Whether the active model can see images (resolved from get_config's cloud/local
      vision_enabled against the current mode, so it follows a cloud<->local switch). */
   isVisionCapable(): boolean {
      return this.llm.mode === "local" ? this.localVision : this.cloudVision;
   }

   /* Fetch an attached image's bytes over the same-origin /api proxy (the cookie rides it).
      A GET read; the conversation view object-URLs the blob into an <img> thumbnail. */
   async fetchImage(id: string): Promise<{ blob: Blob; contentType: string }> {
      const res = await fetch(this.dawnUrl(`/api/images/${encodeURIComponent(id)}`), {
         credentials: "same-origin"
      });
      if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
      const blob = await res.blob();
      return { blob, contentType: res.headers.get("content-type") ?? "" };
   }

   /* doc_library_get over the WS, promise-correlated by id. Resolves null on an error
      response, a superseding request for the same id, or a 15s timeout (a dropped
      response must not leak the promise). */
   getDocumentText(id: number): Promise<{ text: string; filename: string; filetype: string } | null> {
      return new Promise((resolve) => {
         /* Supersede any in-flight request for this id (clear its timer, resolve it null). */
         const prev = this.pendingDocGets.get(id);
         if (prev) {
            window.clearTimeout(prev.timer);
            prev.resolve(null);
         }
         const timer = window.setTimeout(() => {
            if (this.pendingDocGets.get(id)?.resolve === resolve) {
               this.pendingDocGets.delete(id);
               resolve(null);
            }
         }, 15000);
         this.pendingDocGets.set(id, { resolve, timer });
         this.send({ type: "doc_library_get", payload: { id } });
      });
   }

   /* Save an edited note (doc_library_note_update). label is the note's filename. */
   updateNote(id: number, label: string, text: string): Promise<string | null> {
      return this.editSave({ type: "doc_library_note_update", payload: { id, label, text } });
   }

   /* Save an edited document's stored text (doc_library_doc_update; re-chunks + re-embeds). */
   updateDocText(id: number, text: string): Promise<string | null> {
      return this.editSave({ type: "doc_library_doc_update", payload: { id, text } });
   }

   /* Send an edit frame and resolve on the matching *_update_response: null = saved, else a
      human-readable error string (a label collision, a pre-v63 "re-save to enable editing"
      reject, ...). Resolves fast when the link is down; a 15s timeout guards a dropped
      response. One slot - a second save supersedes the first (shouldn't happen: modal-gated). */
   private editSave(frame: { type: string; payload: Record<string, unknown> }): Promise<string | null> {
      return new Promise((resolve) => {
         if (!this.isLinkLive()) {
            resolve("Not connected to DAWN - edit not saved.");
            return;
         }
         if (this.pendingDocEdit) {
            window.clearTimeout(this.pendingDocEdit.timer);
            this.pendingDocEdit.resolve("Superseded by a newer save.");
         }
         const timer = window.setTimeout(() => {
            if (this.pendingDocEdit?.resolve === resolve) {
               this.pendingDocEdit = null;
               resolve("Save timed out.");
            }
         }, 15000);
         this.pendingDocEdit = { resolve, timer };
         this.send(frame);
      });
   }

   /* Binary frame on the MAIN socket: a 1-byte opcode then payload. Only TTS arrives
      here now - chunks accumulate and the segment-end plays them. Music has its own
      dedicated socket (see openMusicStream) and never rides the main socket. */
   private onBinary(buf: ArrayBuffer): void {
      const bytes = new Uint8Array(buf);
      if (bytes.length === 0) return;
      const op = bytes[0];
      /* TTS mute is enforced client-side: if the user muted mid-session, just drop the
         incoming audio rather than telling DAWN to stop synthesizing (a Tier-C write the
         read-mostly charter forbids). The connect-time tts_enabled handshake still lets
         DAWN skip synthesis when we connect already muted. */
      if (op === BIN_AUDIO_OUT) {
         if (this.ttsEnabled) this.tts.queue(bytes.subarray(1));
      } else if (op === BIN_AUDIO_SEGMENT_END) {
         if (this.ttsEnabled) this.tts.play();
      }
   }

   /* Music transport: a music_control write (Tier C, a deliberate user action). */
   musicControl(action: string, params: Record<string, unknown> = {}): void {
      this.send({ type: "music_control", payload: { action, ...params } });
      /* The dedicated socket is the only audio path now, so a control the user issued
         while it's down (retries exhausted) would play silently. Treat the action as
         fresh intent: re-arm the retry counter and reconnect so "press play again"
         recovers. Cheap - openMusicStream is idempotent when a live socket exists. */
      if (this.musicEnabled && !this.musicWs) {
         const token = localStorage.getItem(TOKEN_KEY);
         if (token) {
            this.musicWsFails = 0;
            this.musicUnavailable = false;
            this.openMusicStream(token);
         }
      }
   }

   /* Closed-loop flow-control report up the music socket (from MusicAudio, ~32 ms).
      Only meaningful once auth_ok; the server ignores anything else post-auth. */
   private musicReport(bufferedMs: number): void {
      const ws = this.musicWs;
      if (!ws || !this.musicWsAuthed || ws.readyState !== WebSocket.OPEN) return;
      try {
         ws.send(JSON.stringify({ type: "music_buffer", buffered_ms: Math.round(bufferedMs) }));
      } catch {
         /* socket tearing down; reports are periodic, so dropping one is fine */
      }
   }

   /* Force a live HA re-poll now (the board's manual refresh). ha_refresh_entities
      bypasses DAWN's 5-min cache and returns the fresh list; a read, not a mutation. */
   refreshHA(): void {
      this.send({ type: "ha_refresh_entities" });
   }

   /* HA widget control (signal-map §9.4 #8): the board's write path, a deliberate
      user-initiated action (like music transport), not ambient control. `data` is passed
      VERBATIM to HA - the panel already uses HA's own keys (brightness/percentage/
      position/hvac_mode/temperature). The server allowlists the (domain, service) pairs
      the board can invoke; anything else comes back "Service not permitted".

      On SUCCESS the server re-polls HA and broadcasts a fresh ha_entities_response on its
      own, so the board reconciles without us re-polling; the optimistic flip just bridges
      the round-trip. On FAILURE nothing is broadcast, so ha_call_service_response drives
      the revert + surfaces the error (see the handler). */
   haControl(call: HAServiceCall): void {
      this.send({
         type: "ha_call_service",
         payload: {
            entity_id: call.entityId,
            domain: call.domain,
            service: call.service,
            ...(call.data ? { data: call.data } : {})
         }
      });
   }

   /* Re-list the SAGE watches (Watches panel manual refresh / poll). Read-only. */
   requestWatches(): void {
      this.send({ type: "watch_list" });
   }

   /* Toggle one watch on/off. A benign per-watch flip (the sanctioned deliberate-user-action
      class, like set_pinned); the server reconciles via the re-list in watch_set_enabled_response.
      Blocked on a dead link so the panel doesn't flip a state that never took (like haControl). */
   setWatchEnabled(id: number, enabled: boolean): void {
      if (!this.isLinkLive()) {
         this.notifyUser("Not connected to DAWN - change not sent.");
         return;
      }
      this.send({ type: "watch_set_enabled", payload: { id, enabled } });
   }

   /* Opt into / out of the 1 Hz watch_readings gauge stream (driven off panel visibility).
      Track the intent so a reconnect re-subscribes (the subscription is per-connection); the
      onopen handler replays it. `send` is a no-op when the socket is down, which is fine -
      the intent is remembered and re-sent on connect. */
   watchReadingsSubscribe(enabled: boolean): void {
      this.watchReadingsWanted = enabled;
      this.send({ type: "watch_readings_subscribe", payload: { enabled } });
   }

   /* Phase-2 watch CRUD. Per-user proactive rules (deliberate user actions), gated on link
      liveness; each reconciles via the re-list in its *_response handler. `updateWatch` sends
      the full field state (a partial send would reset omitted fields to catalog defaults).
      `removeWatch` is only ever invoked from the panel's confirm-gated gesture. */
   addWatch(metric: string, fields?: WatchFields): void {
      if (!this.isLinkLive()) {
         this.notifyUser("Not connected to DAWN - not sent.");
         return;
      }
      /* CREATES a new watch (add no longer dedups by metric). The create modal supplies the
         name + condition in `fields`; a bare add falls back to the server's catalog defaults. */
      this.send({ type: "watch_add", payload: { metric, ...watchFieldsToWire(fields) } });
   }
   updateWatch(id: number, fields: WatchFields): void {
      if (!this.isLinkLive()) {
         this.notifyUser("Not connected to DAWN - not sent.");
         return;
      }
      this.send({ type: "watch_update", payload: { id, ...watchFieldsToWire(fields) } });
   }
   removeWatch(id: number): void {
      if (!this.isLinkLive()) {
         this.notifyUser("Not connected to DAWN - not sent.");
         return;
      }
      this.send({ type: "watch_remove", payload: { id } });
   }

   /* Opt into / out of the portfolio push, gated on the panel's effective visibility (mirror of
      watchReadingsSubscribe). The intent + ext-hours choice are stored so the onopen handler can
      re-subscribe after a reconnect (the subscription is per-connection). `send` no-ops when the
      socket is down; the stored intent survives. A re-subscribe with a new extHours is idempotent
      server-side (it just resets the per-connection flags), so no unsubscribe-first dance. */
   stocksPortfolioSubscribe(enabled: boolean, extHours: boolean): void {
      this.stocksPortfolioWanted = enabled;
      this.stocksExtHours = extHours;
      if (enabled) this.send({ type: "stocks_portfolio_subscribe", payload: { ext_hours: extHours } });
      else this.send({ type: "stocks_portfolio_unsubscribe" });
   }
   /* One-shot cached snapshot for the manual refresh button. A read; the server TTL-clamps it. */
   refreshStocks(extHours: boolean): void {
      this.send({ type: "stocks_portfolio_get", payload: { ext_hours: extHours } });
   }

   /* Watchlist: its own subscription, independent of the portfolio's, gated on the Watchlist
      panel's own effective visibility. Re-sent on reconnect if still wanted (see onopen). */
   stocksWatchSubscribe(enabled: boolean, extHours: boolean): void {
      this.stocksWatchWanted = enabled;
      this.stocksWatchExtHours = extHours;
      if (enabled) this.send({ type: "stocks_watch_subscribe", payload: { ext_hours: extHours } });
      else this.send({ type: "stocks_watch_unsubscribe" });
   }
   refreshWatchlist(extHours: boolean): void {
      this.send({ type: "stocks_watch_get", payload: { ext_hours: extHours } });
   }
   /* User-scoped write: the user curating their own watchlist. Delta add/remove; the server
      dedups, clamps, ignores invalid, and answers with a fresh stocks_watch_update. */
   stocksWatchSet(add: string[], remove: string[]): void {
      this.send({ type: "stocks_watch_set", payload: { add, remove } });
   }

   getMusicAudio(): MusicAudio {
      return this.music;
   }

   /* The control surface the composer's mic button binds to. Both push-to-talk and
      continuous listening are deliberate, user-initiated writes (voice input, in the same
      sanctioned class as chat submit). */
   getMicControl(): MicControl {
      return {
         available: () => this.mic.available,
         pttStart: () => this.mic.pttStart(),
         pttCommit: () => this.mic.pttCommit(),
         pttEnd: () => this.mic.pttEnd(),
         pttCancel: () => this.mic.pttCancel(),
         toggleContinuous: () => this.toggleContinuous(),
         onState: (cb) => {
            this.micStateListener = cb;
            cb(this.lastMicState);
         },
         listDevices: () => this.mic.listDevices(),
         currentDevice: () => this.mic.getDevice(),
         setDevice: (id) => {
            this.mic.setDevice(id);
            /* Apply immediately if continuous is latched: re-latch on the new device (a
               fresh always-on context) so the switch takes effect without a manual toggle. */
            if (this.continuousOn) {
               this.stopContinuous(true);
               this.startContinuous();
            }
         }
      };
   }

   private emitMicState(s: MicCaptureState): void {
      this.lastMicState = s;
      this.micStateListener(s);
   }

   /* Tap-to-latch continuous listening. A deliberate, user-initiated write (same sanctioned
      class as chat submit): it turns on DAWN's server-side VAD + wake word. */
   private toggleContinuous(): void {
      if (this.continuousOn) this.stopContinuous(true);
      else this.startContinuous();
   }

   private startContinuous(): void {
      if (this.continuousOn || !this.mic.available || this.ws?.readyState !== WebSocket.OPEN) return;
      this.continuousOn = true;
      /* Never inherit a stale recording flag across a re-arm/reconnect: a stale-true errs
         UNSAFE (it force-holds the mic open -> DAWN's own voice echoes) until the next
         always_on_state frame resets it. A fresh latch always starts not-recording. */
      this.alwaysOnRecording = false;
      this.resumeContinuous = true; // survive a reconnect
      /* Enable BEFORE streaming so DAWN sets up its always-on context first; sample_rate is
         the constant 48000 (its VAD decimation divides by it - reporting the ctx rate would
         degrade wake detection). */
      this.send({ type: "always_on_enable", payload: { sample_rate: 48000 } });
      /* Seed the echo mute: latching while DAWN is mid-reply (speaking or audio still
         playing) must not capture its voice. updateMicMute drives it after this. */
      this.mic.continuousStart(this.dawnSpeaking || this.tts.isSpeaking());
   }

   /* userInitiated: a tap-off / auto-unlatch clears the resume flag; a transient teardown
      (server auto-disable, error) leaves it so a reconnect can re-establish. */
   private stopContinuous(userInitiated: boolean): void {
      if (!this.continuousOn) return;
      this.continuousOn = false;
      this.alwaysOnRecording = false;
      if (userInitiated) this.resumeContinuous = false;
      window.clearTimeout(this.micMuteCooldown);
      this.micMuteCooldown = 0;
      this.mic.continuousStop(); // synchronous: releases the mic and emits idle
      this.send({ type: "always_on_disable" });
   }

   /* Apply one DAWN machine state to the reactor, echo-mute and conversation chip. */
   private applyState(st: string, detail?: string, tools?: unknown): void {
      this.lastState = st;
      if (st === "idle") this.resetTurnConv = 0; // the reset turn (if any) has finished
      /* Drive the continuous echo-mute off DAWN's speaking state: it stays "speaking"
         across TTS sentence gaps, so muting on it (not on per-segment TTS playback)
         keeps the mic from hearing DAWN's own voice between sentences. */
      this.dawnSpeaking = st === "speaking";
      this.updateMicMute();
      this.sinks.reactor.setState(toReactorState(st));
      this.sinks.conversation.setThinking(st === "thinking" || st === "summarizing");
      /* Keep the window upright while DAWN speaks (persists across sentence gaps), so it
         doesn't recede-then-raise between spoken bursts. Self-clears when state leaves
         "speaking" (the next frame passes false -> normal idle recede). */
      this.sinks.conversation.setSpeaking(this.dawnSpeaking);
      this.sinks.conversation.setStatus(this.activityFor(st, detail, tools));
      /* No client-side persist on idle (or anywhere): DAWN is the sole writer of the turn
         (server-authoritative persistence); the client only renders + reconciles the fanned
         message_appended. `state` here just drives the reactor / activity chip. */
   }

   /* True when a frame is tagged with a conversation other than the one on screen (mirrors
      DAWN's own client, isForeignConvFrame). Untagged frames (global / control) never are. A
      tagged frame while no conversation is bound (a fresh chat) is foreign too: DAWN always
      delivers new_conversation_response (ours, or the server-initiated voice bind) BEFORE that
      conversation's turn streams, so a legitimate turn's frames find convId already set. */
   private isForeignConv(src: Record<string, unknown>): boolean {
      const c = Number(src.conversation_id ?? 0);
      return c > 0 && c !== this.convId && c !== this.resetTurnConv;
   }

   /* Leaving a conversation mid-turn: its remaining frames (including its terminal idle) are
      now foreign and dropped, so settle the turn visuals here or the reactor/chip would hang in
      thinking/speaking. Called from every path that switches or unbinds the conversation. */
   private settleTurnOnSwitch(): void {
      this.resetTurnConv = 0;
      /* A typed turn's echo from the conversation just left is now dropped as foreign; don't
         let its entry absorb a same-text message here. */
      this.typedEchoes.length = 0;
      this.sinks.conversation.releaseTurns();
      /* "listening" here is the ASR phase of a turn (conversation-tagged); always-on's armed
         state rides always_on_state, so settling it is safe. */
      if (
         this.lastState === "thinking" ||
         this.lastState === "speaking" ||
         this.lastState === "summarizing" ||
         this.lastState === "listening"
      ) {
         this.applyState("idle");
      }
   }

   /* Single echo-mute decision for continuous listening. Muted while DAWN is speaking OR its
      voice is still audibly playing (the buffered tail after state:idle); when both settle,
      a short cooldown holds the mute a beat longer, then reopens the mic. Using DAWN's
      speaking state - which spans the whole reply - closes the inter-sentence gaps that
      per-segment TTS playback alone would leave open. No-op outside continuous mode. */
   private updateMicMute(): void {
      if (!this.continuousOn) {
         window.clearTimeout(this.micMuteCooldown);
         this.micMuteCooldown = 0;
         return;
      }
      /* Always-on RECORDING overrides the speaking-mute: DAWN plays the greeting
         (state:speaking) while it records the user's command, so muting on dawnSpeaking here
         would gag the command. Keep the mic open and let the AEC-referenced TTS playback
         (tts.ts) cancel the greeting from the capture instead. */
      if (this.alwaysOnRecording) {
         window.clearTimeout(this.micMuteCooldown);
         this.micMuteCooldown = 0;
         this.mic.setMuted(false);
         return;
      }
      if (this.dawnSpeaking || this.tts.isSpeaking()) {
         window.clearTimeout(this.micMuteCooldown);
         this.micMuteCooldown = 0;
         this.mic.setMuted(true);
      } else if (this.micMuteCooldown === 0) {
         this.micMuteCooldown = window.setTimeout(() => {
            this.micMuteCooldown = 0;
            this.mic.setMuted(false);
         }, MIC_MUTE_COOLDOWN_MS);
      }
   }

   /* Request the calendar map + today's occurrences (both reads). Called on connect,
      on the slow interval, and after a debounced calendar_events_changed. */
   private requestCalendar(): void {
      const { start, end } = todayWindow(this.userTz);
      this.send({ type: "calendar_list_my_calendars" });
      this.send({ type: "calendar_upcoming_events", payload: { start, end } });
   }

   /* Coalesce a burst of calendar_events_changed pushes into one refetch. */
   private scheduleCalendarRefetch(): void {
      window.clearTimeout(this.calendarDebounce);
      this.calendarDebounce = window.setTimeout(() => this.requestCalendar(), 500);
   }

   /* Request a page of the document library (list / search / load-more). Records the
      request kind so the shared doc_library_list_response can be labeled for the panel. */
   private requestLibrary(opts: { query?: string; offset?: number; append?: boolean; searching?: boolean } = {}): void {
      this.pendingLibraryAppend = opts.append === true;
      this.pendingLibrarySearching = opts.searching === true;
      const payload: Record<string, unknown> = { limit: LIB_PAGE, offset: opts.offset ?? 0 };
      if (opts.query) payload.query = opts.query;
      this.send({ type: "doc_library_list", payload });
   }

   /* Open the dedicated dawn-music stream socket and authenticate it with the session
      token. Once DAWN sees it (set_stream_wsi) it streams music audio here, each frame
      as [0x20][uint16-LE len][opus] (the daemon prepends the WS_BIN_MUSIC_DATA opcode).
      This is the SOLE music transport: DAWN removed the legacy main-socket path, so a
      failure to attach means no audio, not a degrade - hence the give-up in
      scheduleMusicReconnect surfaces an error. */
   private openMusicStream(token: string): void {
      if (!this.wantConnected || !token) return;
      this.musicWsAuthed = false;
      /* Idempotent: DAWN can send the `session` frame more than once per connect, and
         we must not tear down a live socket each time (rapid reopen can race the
         server's stream registration). Only (re)open if there is no live socket for
         this token. */
      const live =
         this.musicWs &&
         (this.musicWs.readyState === WebSocket.OPEN ||
            this.musicWs.readyState === WebSocket.CONNECTING);
      if (live && this.musicWsToken === token) return;
      this.closeMusicStream();
      this.musicWsToken = token;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      /* DEV: reach the dawn-music server (main+1) through the Vite /music-ws proxy, so
         it rides the one accepted dev cert on the same origin. PROD (co-located under
         DAWN): DAWN's main port has no /music-ws route, so connect cross-port to the
         advertised music_port (connect-src wss: allows it; it auths by token, not
         cookie). Fall back to main+1 when the server omits music_port (older daemons). */
      let musicUrl: string;
      if (import.meta.env.DEV) {
         musicUrl = `${proto}://${window.location.host}${this.dawnUrl("/music-ws")}`;
      } else {
         const port = this.musicPort || Number(window.location.port || "443") + 1;
         musicUrl = `${proto}://${window.location.hostname}:${port}${this.dawnUrl("/")}`;
      }
      let ws: WebSocket;
      try {
         ws = new WebSocket(musicUrl, "dawn-music");
      } catch {
         return;
      }
      ws.binaryType = "arraybuffer";
      this.musicWs = ws;

      ws.onopen = (): void => ws.send(JSON.stringify({ type: "auth", token }));

      ws.onmessage = (ev: MessageEvent): void => {
         if (ev.data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(ev.data);
            if (bytes.length === 0) return;
            /* Frame is [0x20][uint16-LE len][opus]: the daemon prepends the
               WS_BIN_MUSIC_DATA opcode to every dedicated-socket frame. Strip it so the
               decoder gets [len][opus]. (bytes[0] is always the opcode, never opus data,
               so this is unconditional in practice; guard defensively.) */
            void this.music.pushFrame(bytes[0] === BIN_MUSIC_DATA ? bytes.subarray(1) : bytes);
            return;
         }
         try {
            const m = JSON.parse(String(ev.data)) as { type?: string; reason?: string };
            if (m.type === "auth_ok") {
               this.musicWsFails = 0; // attached; audio now streams here
               this.musicWsAuthed = true;
               this.musicUnavailable = false;
               /* Debug, not info: an idle socket idle-times-out and reconnects to
                  stay ready, so at info level this would spam every ~30s when nothing
                  is playing. Playback keeps the socket alive (verified: stable). */
               console.debug("[dawn] music stream attached (dedicated socket)");
            } else if (m.type === "auth_failed") {
               /* No main-socket fallback exists anymore; a reconnect is the only recovery. */
               console.warn("[dawn] music stream auth failed:", m.reason);
               this.musicWsAuthed = false;
               this.closeMusicStream();
               this.scheduleMusicReconnect();
            }
         } catch {
            /* ignore non-JSON text */
         }
      };

      ws.onclose = (): void => {
         if (this.musicWs === ws) this.musicWs = null;
         this.scheduleMusicReconnect();
      };
      ws.onerror = (): void => {
         /* onclose fires right after and handles the reconnect. */
      };
   }

   private scheduleMusicReconnect(): void {
      if (!this.wantConnected || !this.musicEnabled) return;
      if (this.musicWsFails >= MUSIC_WS_MAX_FAILS) {
         /* This socket is the only music transport, so exhausting retries means there
            is no audio path at all - surface it once (not silent silence). A later
            music_control re-arms the retries (see musicControl). auth_ok clears it. */
         if (!this.musicUnavailable) {
            this.musicUnavailable = true;
            this.sinks.music.setError("Music stream unavailable");
            console.warn("[dawn] music stream: giving up after", MUSIC_WS_MAX_FAILS, "attempts");
         }
         return;
      }
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token) return;
      this.musicWsFails++;
      const delay = Math.min(15000, 1000 * 2 ** (this.musicWsFails - 1));
      window.clearTimeout(this.musicWsTimer);
      this.musicWsTimer = window.setTimeout(() => this.openMusicStream(token), delay);
   }

   private closeMusicStream(): void {
      window.clearTimeout(this.musicWsTimer);
      this.musicWsAuthed = false;
      const ws = this.musicWs;
      if (!ws) return;
      this.musicWs = null;
      ws.onclose = null; // an intentional close must not trigger a reconnect
      ws.onerror = null;
      try {
         ws.close();
      } catch {
         /* already closing */
      }
   }

   /* --- MODEL panel -------------------------------------------------------- */

   private notifyLlm(): void {
      /* Persistent HUD readout of the current brain: model + effort (OFF when
         reasoning is disabled, else LOW/MEDIUM/HIGH/…). Do NOT push an empty model
         — llm_state_update can arrive after get_config, and an empty value would
         clobber the cached (persistent) reading. */
      const caps = this.currentCaps();
      const entry = caps?.modes.find((m) => m.mode === this.llm.reasoning);
      const effort =
         caps && !caps.modes.length
            ? "N/A" // the model has no reasoning control
            : this.llm.reasoning === "disabled"
              ? "OFF"
              : entry && !entry.efforts.length
                ? "ON" // a mode with no effort choice (e.g. Ollama think on)
                : this.llm.effort.toUpperCase();
      const update: Record<string, string> = {
         effort,
         provider: this.llm.mode === "local" ? "Local" : providerLabel(this.llm.provider)
      };
      if (this.llm.model) update.model = displayModelName(this.llm.model);
      this.sinks.telemetry.update(update);
      for (const cb of this.llmListeners) cb();
   }

   /* Mirror the active conversation's title into the HUD readout (empty -> a fresh chat).
      The HUD caches the last value, so it survives a reload / re-anchor without a re-push. */
   private setActiveTitle(t: string): void {
      this.sinks.telemetry.update({ title: t || "New conversation" });
   }

   /* Re-request get_config to refresh the cloud model lists + provider availability after a
      backend config edit. Sets modelsRefreshOnly so the response updates the lists only,
      never the current selection (which would clobber a loaded conversation's provider).
      Shared by the config_changed push and the MODEL-panel-open refetch. */
   private requestConfigRefresh(): void {
      this.modelsRefreshOnly = true;
      this.send({ type: "get_config" });
   }

   /* Apply an llm_state_update (mode/provider/model + provider availability). */
   private applyLlmState(json: string): void {
      let msg: { payload?: Record<string, unknown> };
      try {
         msg = JSON.parse(json);
      } catch {
         return;
      }
      const pl = msg.payload;
      if (!pl) return;
      this.llm.mode = pl.type === "local" ? "local" : "cloud";
      if (typeof pl.provider === "string") {
         const prov = pl.provider.toLowerCase();
         if (isLlmProvider(prov)) this.llm.provider = prov;
      }
      if (typeof pl.model === "string" && pl.model) this.llm.model = pl.model;
      this.llm.providers = {
         openai: pl.openai_available === true,
         claude: pl.claude_available === true,
         gemini: pl.gemini_available === true,
         openrouter: pl.openrouter_available === true || this.llm.provider === "openrouter"
      };
      /* A switch_llm tool call changed the session model, and reasoning now depends on the model
         (P1.1b), but this frame carries no reasoning fields or caps. Re-read the session's
         runtime (a full get_config, not a lists-only refresh) for the effective values. */
      this.modelsRefreshOnly = false;
      this.send({ type: "get_config" });
      this.notifyLlm();
   }

   /* Send a session-only LLM change, then reflect it optimistically. */
   private applyLlm(fields: Record<string, string>): void {
      this.send({ type: "set_session_llm", payload: fields });
      this.notifyLlm();
   }

   /* Reflect a loaded conversation's stamped LLM settings on the MODEL panel.
      load_conversation_response carries an llm_settings object (DAWN's
      build_conv_llm_settings_json) with the mode/provider/model/reasoning the
      daemon actually runs THAT conversation with. Without applying it the panel
      keeps the connect-time llm_runtime snapshot and lies once a conversation with
      different settings is opened (e.g. shows native Claude / haiku / Off while the
      conversation runs on OpenRouter / sonnet-5 / thinking-low). Display only: it
      issues no set_session_llm (the daemon already resolved these server-side), and
      reconcileModel is deliberately NOT called - the stamped model is the truth even
      when it is absent from the active provider's list (as an OpenRouter model is). */
   private applyConvLlmSettings(settings: unknown): void {
      if (!settings || typeof settings !== "object") return;
      const s = settings as {
         llm_type?: string;
         cloud_provider?: string;
         model?: string;
         thinking_mode?: string;
         reasoning_effort?: string;
      };
      if (s.llm_type) this.llm.mode = s.llm_type === "local" ? "local" : "cloud";
      const prov = (s.cloud_provider ?? "").toLowerCase();
      if (isLlmProvider(prov)) {
         this.llm.provider = prov;
         /* The conversation demonstrably ran on this provider, so light its panel
            segment (never grey the active provider). */
         this.llm.providers = { ...this.llm.providers, [prov]: true };
      }
      if (s.model) this.llm.model = s.model;
      this.applyReasoningFields(settings);
   }

   /* Read a frame's reasoning fields (llm_runtime / set_session_llm_response /
      load_conversation llm_settings): the EFFECTIVE thinking_mode + reasoning_effort shown on the
      panel, the stored pick (for the "not available here" note), and the caps for the frame's
      model. Call AFTER this.llm.model is updated from the same frame. `fallback` covers an older
      server whose frame omits the fields. A missing field leaves the current value untouched. */
   private applyReasoningFields(raw: unknown, fallback: { mode?: string; effort?: string } = {}): void {
      const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const mode = toReasoning(f.thinking_mode ?? fallback.mode);
      if (mode) this.llm.reasoning = mode;
      const effort = typeof f.reasoning_effort === "string" && f.reasoning_effort ? f.reasoning_effort : fallback.effort;
      if (effort) this.llm.effort = effort;
      if ("thinking_mode_pick" in f || "reasoning_effort_pick" in f) {
         this.reasoningPick = {
            mode: toReasoning(f.thinking_mode_pick),
            effort: typeof f.reasoning_effort_pick === "string" ? f.reasoning_effort_pick : ""
         };
      }
      /* Bind the caps only to the model this frame itself names (a frame with no/empty model
         says nothing about which model they describe). */
      const caps = parseReasoningCaps(f.reasoning_capabilities);
      if (caps && typeof f.model === "string" && f.model && f.model === this.llm.model) {
         this.frameCaps = { mode: this.llm.mode, provider: this.llm.provider, model: f.model, caps };
      }
   }

   /* The current model's caps: the list tables first, then what a frame carried for this
      model. null = unknown (an older server): the panel uses the name heuristic. */
   private currentCaps(): ReasoningCaps | null {
      const m = this.llm.model;
      const listed = this.llm.mode === "local" ? this.localCaps[m] : this.cloudCaps?.[this.llm.provider]?.[m];
      if (listed) return listed;
      const fc = this.frameCaps;
      return fc && fc.model === m && fc.mode === this.llm.mode && (fc.mode === "local" || fc.provider === this.llm.provider)
         ? fc.caps
         : null;
   }

   /* After an optimistic model/provider/mode change: keep the shown mode + effort inside what
      the new model offers until the server's echo (the authority) lands, so the panel never
      shows a mode the model lacks. Falls back to the effort heuristic without caps. */
   private fitReasoningToModel(): void {
      const caps = this.currentCaps();
      if (!caps) {
         const opts = effortOptionsForModel(this.llm.model);
         if (!opts.includes(this.llm.effort)) this.llm.effort = opts.includes("medium") ? "medium" : opts[0];
         return;
      }
      if (!caps.modes.length) return;
      if (!caps.modes.some((m) => m.mode === this.llm.reasoning)) {
         this.llm.reasoning = caps.default.mode && caps.modes.some((m) => m.mode === caps.default.mode) ? caps.default.mode : caps.modes[0].mode;
      }
      this.fitEffortToMode(caps);
   }

   /* Keep the effort inside the current mode's list (a disabled mode keeps its kept pick). */
   private fitEffortToMode(caps: ReasoningCaps): void {
      const entry = caps.modes.find((m) => m.mode === this.llm.reasoning);
      if (!entry || !entry.efforts.length || entry.efforts.includes(this.llm.effort)) return;
      /* Same rule DAWN resolves with: the nearest offered effort to the pick, ties lower. */
      this.llm.effort = nearestEffort(entry.efforts, this.reasoningPick.effort || this.llm.effort);
   }

   /* The pick-vs-effective explanation, "" when they match (or no pick is known). */
   private reasoningNoteText(): string {
      return reasoningNote(this.reasoningPick, { mode: this.llm.reasoning, effort: this.llm.effort }, this.currentCaps());
   }

   /* The clamp notice for a reasoning_adjusted set_session_llm_response. */
   private reasoningAdjustedText(): string {
      return this.reasoningNoteText() || "Reasoning adjusted to what this model supports.";
   }

   private modelsFor(mode: LlmMode, provider: LlmProvider): string[] {
      return mode === "local" ? this.localModels : this.cloudModels[provider];
   }

   /* If the current model is not in the active list, switch to the default one.
      For OpenRouter that is the operator's configured default index (parity with
      the old WebUI); every other provider defaults to the first entry. */
   private reconcileModel(): void {
      const models = this.modelsFor(this.llm.mode, this.llm.provider);
      if (models.length > 0 && !models.includes(this.llm.model)) {
         const idx =
            this.llm.provider === "openrouter" &&
            this.openrouterDefaultIdx >= 0 &&
            this.openrouterDefaultIdx < models.length
               ? this.openrouterDefaultIdx
               : 0;
         this.llm.model = models[idx];
         /* Keep reasoning valid for the new model so the panel's segmented controls always have
            an active value (the server resolves + echoes too, but this avoids a transient
            no-selection state until the echo lands). */
         this.fitReasoningToModel();
         this.send({ type: "set_session_llm", payload: { type: this.llm.mode, model: this.llm.model } }); // type too (see setProvider)
      }
      this.notifyLlm();
   }

   getModelControl(): ModelControl {
      return {
         getState: (): LlmState => ({
            mode: this.llm.mode,
            provider: this.llm.provider,
            model: this.llm.model,
            reasoning: this.llm.reasoning,
            effort: this.llm.effort,
            providers: this.llm.providers,
            models: this.modelsFor(this.llm.mode, this.llm.provider),
            effortOptions: effortOptionsForModel(this.llm.model),
            reasoningCaps: this.currentCaps(),
            reasoningNote: this.reasoningNoteText(),
            isPrivate: this.isPrivate
         }),
         onChange: (cb) => this.llmListeners.push(cb),
         setMode: (mode) => {
            this.llm.mode = mode;
            this.applyLlm({ type: mode });
            this.reconcileModel();
         },
         setProvider: (provider) => {
            this.llm.provider = provider;
            /* Send `type` (cloud|local) alongside provider: the daemon tracks type/provider/model
               as INDEPENDENT fields and `type` WINS at dispatch, so omitting it leaves the session
               on its prior type - a cloud pick would silently keep routing to the local endpoint. */
            this.applyLlm({ type: this.llm.mode, provider });
            this.reconcileModel();
         },
         setModel: (model) => {
            this.llm.model = model;
            this.fitReasoningToModel();
            this.applyLlm({ type: this.llm.mode, model }); // send type too (see setProvider)
         },
         setReasoning: (reasoning) => {
            /* Optimistic; the set_session_llm_response echo confirms or adjusts it. */
            this.llm.reasoning = reasoning;
            this.reasoningPick = { ...this.reasoningPick, mode: reasoning }; // the new pick (no stale-pick note flash)
            const caps = this.currentCaps();
            if (caps) this.fitEffortToMode(caps);
            this.applyLlm({ thinking_mode: reasoning });
         },
         setEffort: (effort) => {
            this.llm.effort = effort;
            this.reasoningPick = { mode: this.currentCaps() ? this.llm.reasoning : this.reasoningPick.mode, effort };
            /* With caps, send the mode the panel shows alongside: on a model that can't turn
               reasoning off, a stale stored "disabled" pick must be replaced by what's shown
               (DAWN's P1.1b contract). */
            this.applyLlm(
               this.currentCaps() ? { thinking_mode: this.llm.reasoning, reasoning_effort: effort } : { reasoning_effort: effort }
            );
         },
         setPrivate: (on) => {
            this.isPrivate = on;
            if (this.convId > 0) {
               this.send({
                  type: "set_private",
                  payload: { conversation_id: this.convId, is_private: on }
               });
            }
            this.notifyLlm();
         },
         refreshModels: () => {
            /* Re-request get_config so a backend model-list edit is picked up live when the
               MODEL panel opens. The get_config_response handler refreshes this.cloudModels
               + availability and rebuilds the open panel, skipping the session selection (see
               modelsRefreshOnly). Complements the config_changed push (which also fires this
               when the panel is closed); keeping both is belt-and-suspenders. */
            this.requestConfigRefresh();
         }
      };
   }

   /* TTS on/off. `set_tts_enabled` is a per-connection preference ("don't synthesize
      voice for MY socket") - a sanctioned user-initiated write in the same benign class
      as set_private, NOT a depower-DAWN control. Telling DAWN matters beyond the local
      audio drop: with tts_enabled true, DAWN synthesizes each sentence SYNCHRONOUSLY on
      the worker thread that reads LLM tokens (webui_text_processing.c), so the whole reply
      - text included - gets paced to synthesis speed. Muting only client-side leaves that
      pacing in place; the write is what makes the reply stream at line speed. DAWN captures
      tts_enabled once at turn start, so this takes effect from the NEXT turn (a reply already
      in flight stays paced). Persisted; muting also stops audio in flight and onBinary drops
      any further incoming audio. The preference still rides the init/reconnect handshake for
      the connect-already-muted case. */
   isTtsEnabled(): boolean {
      return this.ttsEnabled;
   }

   setTtsEnabled(on: boolean): void {
      this.ttsEnabled = on;
      localStorage.setItem(TTS_KEY, on ? "true" : "false");
      if (!on) this.tts.stop();
      /* Tell DAWN so it stops (or resumes) synthesis for this connection - see above. */
      if (this.ws?.readyState === WebSocket.OPEN) {
         this.send({ type: "set_tts_enabled", payload: { enabled: on } });
      }
   }

   /* User typed a message. This DOES drive a real DAWN turn (costs budget); it is
      the one intentional user-initiated action on an otherwise read-only client. */
   submit(text: string, attachments?: { turnRef?: string; documents?: OutDocument[]; images?: OutImage[]; imageIds?: string[] }): void {
      /* Don't let a message vanish into a dead/half-open link: tell the user instead of
         silently dropping it (the old `readyState !== OPEN` guard swallowed it). */
      if (!this.isLinkLive()) {
         this.notifyUser("Not connected to DAWN - message not sent.");
         return;
      }
      /* No active conversation (fresh start after a reset): open one BEFORE the text so the
         daemon tags this turn with the new id and preserves the old thread. Derive a title from
         the first message (DAWN doesn't echo it back, so remember it to set the HUD readout on the
         response - otherwise it renders the "New conversation" placeholder until the auto-title). */
      if (this.convId === 0) {
         const title = titleFromMessage(text);
         this.pendingNewConvTitle = title;
         this.send({ type: "new_conversation", payload: { save_current: true, title } });
      }
      /* Do NOT persist the user turn here. With an active conversation the daemon
         persists the user message itself (text_input_dispatch.c: conv_db_add on
         conversation_id > 0); saving it again produced double user rows. We only own
         the FINAL ANSWER, saved on the idle transition. */
      /* Tag the turn with our conversation so it can't run orphaned. DAWN's active
         conversation is per-CONNECTION and resets to 0 on a reconnect; without this
         tag the daemon would fall back to that stale id and stream the turn against
         conv=0 - answered but never persisted, lost on the next reload. The `text`
         handler validates ownership and heals its active id from this field (the
         reconnect/multi-tab path it was built for). Omit it while convId is 0: the
         new_conversation above will mint and back-fill the id server-side. */
      const payload: {
         text: string;
         conversation_id?: number;
         images?: OutImage[];
         image_ids?: string[];
         client_ref?: string;
         attachments?: Array<{ filename: string; size: number; content: string; blob_id?: string }>;
      } = { text };
      /* document_attachments (+ turn_refs): documents as a structured field; DAWN builds the
         markers itself (the composer only sends `documents` when supportsStructuredDocs()). */
      if (attachments?.documents?.length && this.supportsStructuredDocs()) {
         payload.attachments = attachments.documents.map((d) => ({
            filename: d.filename,
            size: d.size,
            content: d.content,
            ...(d.blobId ? { blob_id: d.blobId } : {})
         }));
      }
      /* turn_refs: tag the turn so its echo and any refusal name it exactly. */
      if (attachments?.turnRef && this.hasFeature("turn_refs")) payload.client_ref = attachments.turnRef;
      if (this.convId > 0) payload.conversation_id = this.convId;
      /* Image attachments: the MANDATORY image_ids (the /api/images upload ids, order-matched),
         which the daemon reads, sends to the model, and persists as [IMAGE:<id>] markers. A DAWN
         advertising `image_turns_by_id` takes images ONLY that way (it ignores base64); an older
         one still needs the base64 images[] for the live model call, so it gets both. */
      if (attachments?.imageIds?.length) {
         payload.image_ids = attachments.imageIds;
         if (!this.hasFeature("image_turns_by_id") && attachments.images?.length) payload.images = attachments.images;
      }
      this.send({ type: "text", payload });
      /* DAWN will echo this as a user `transcript` (it drives its own WebUI's typed
         bubble). We already showed it locally, so remember it to dedupe that echo; a
         voice transcript has no local counterpart and displays. Bounded so a dropped
         echo cannot grow the list without limit. */
      this.typedEchoes.push({ text: text.trim(), at: performance.now(), ref: payload.client_ref });
      if (this.typedEchoes.length > 8) this.typedEchoes.shift();
      this.sinks.conversation.setThinking(true);
   }

   /* A refused turn named by its ref will never echo: drop exactly its dedup entry. */
   private dropTypedEchoRef(ref: string): void {
      const i = this.typedEchoes.findIndex((e) => e.ref === ref);
      if (i >= 0) this.typedEchoes.splice(i, 1);
   }

   /* A refused turn will never echo: drop ITS dedup entry (by text, not the newest), so it can't
      swallow a later same-text message. */
   private dropTypedEcho(text: string | null): void {
      if (text === null) return;
      const i = this.typedEchoes.findIndex((e) => e.text === text.trim());
      if (i >= 0) this.typedEchoes.splice(i, 1);
   }

   /* A dismissed notice. For a ringing ALARM (`scheduler-<id>`), stop the local ringing loop
      and tell DAWN to actually silence it (scheduler_action{dismiss}). Reminders/timers are
      not tracked (DAWN already auto-dismissed them server-side), so their close is local-only.
      Other notices are cleared locally by the layer. */
   dismiss(id: string): void {
      if (!id.startsWith("scheduler-")) return;
      const eventId = Number(id.slice("scheduler-".length));
      if (this.ringingAlarms.delete(eventId)) {
         if (this.ringingAlarms.size === 0) this.alarmChime.stopLoop();
         this.send({ type: "scheduler_action", payload: { action: "dismiss", event_id: eventId } });
      }
   }

   /* A named action on a notice's button. For a ringing alarm's Snooze/Dismiss: stop the local
      loop and send the matching scheduler_action to DAWN (snooze re-fires it later; dismiss
      ends it). Only fires for a tracked ringing alarm; other notices have no action buttons. */
   noticeAction(id: string, action: string, value?: string): void {
      /* A failed forget's Retry: a deliberate click on the card, re-sending the SAME forget
         the user already confirmed. Dismiss just closes the card (the layer removed it). */
      if (id === FORGET_NOTICE_ID) {
         const retryId = this.forgetRetryId;
         this.forgetRetryId = 0;
         if (action === "retry" && retryId > 0) this.forgetConversationMemories(retryId);
         return;
      }
      if (id === PHONE_NOTICE_ID) {
         this.phone.action(action); // Answer / Reject / Hang Up / Minimize / Expand
         return;
      }
      if (!id.startsWith("scheduler-")) return;
      if (action !== "snooze" && action !== "dismiss") return;
      const eventId = Number(id.slice("scheduler-".length));
      if (!this.ringingAlarms.delete(eventId)) return;
      if (this.ringingAlarms.size === 0) this.alarmChime.stopLoop();
      const payload: Record<string, unknown> = { action, event_id: eventId };
      /* Snooze duration from the dropdown (DAWN accepts 1-120; omit to use its default). */
      if (action === "snooze" && value) {
         const mins = Number(value);
         if (Number.isFinite(mins) && mins >= 1 && mins <= 120) payload.snooze_minutes = Math.round(mins);
      }
      this.send({ type: "scheduler_action", payload });
   }

   /* Whether any alarm is currently RINGING - the standby screensaver's "don't sleep while an
      alarm sounds" guard. Reads the same live set that drives the chime loop, so a
      server-timed-out / auto-dismissed alarm (whose card lingers) correctly reads as not
      ringing, unlike the notice's `critical` flag. */
   isAlarmRinging(): boolean {
      return this.ringingAlarms.size > 0 || this.phone.isRinging(); // a ringing phone keeps the display awake too
   }

   /* Register a callback fired at a wake-word match (the always-on VAD entering "recording"),
      so the ambient-standby screensaver can wake on a real voice match. Read-only observer. */
   onVoiceWake(cb: () => void): void {
      this.voiceWake = cb;
   }

   /* "Alarm sounds" preference (the System-menu toggle): gates the client chime + ringing
      loop only (the spoken alarm rides the general TTS mute, no DAWN verb). Persisted. */
   alarmSoundsEnabled(): boolean {
      return this.alarmChime.isEnabled();
   }
   setAlarmSounds(on: boolean): void {
      this.alarmChime.setEnabled(on);
      if (on) this.phone.resumeRing(); // a call ringing right now starts ringing here too
      localStorage.setItem(ALARM_SOUNDS_KEY, on ? "true" : "false");
   }

   /* "Always on (this browser)" session keepalive (the System-menu toggle). Turning it ON is
      consent-gated in the UI (it weakens login expiry). Persist the flag and, if the link is
      reliably live, send the gated verb now and record the server now matches. If the link is
      NOT live (offline / half-open), skip the send and leave the belief untouched so the
      session-frame convergence delivers it on the next (re)connect - so a "turn off" can't be
      silently lost into a dead socket. Gating on isLinkLive (not just capsSynced) covers the
      half-open case where readyState is OPEN but pings are going unanswered. */
   isKeepaliveEnabled(): boolean {
      return this.keepaliveOn;
   }
   setKeepalive(on: boolean): void {
      this.keepaliveOn = on;
      localStorage.setItem(KEEPALIVE_KEY, on ? "1" : "0");
      if (this.isLinkLive()) {
         this.send({ type: on ? "session_keepalive_enable" : "session_keepalive_disable" });
         this.keepaliveServerOn = on;
      }
   }

   /* Delete one of the user's own memories from the Context panel. Maps the row's item_id
      prefix to the matching user-scoped delete verb (auth-only, user-scoped server-side). The
      panel already confirm-gated this and removed the row optimistically; a server failure is
      surfaced as a notice from the *_response handler. Non-memory prefixes are ignored. */
   deleteMemory(itemId: string): void {
      const colon = itemId.indexOf(":");
      if (colon <= 0) return;
      const kind = itemId.slice(0, colon);
      const idStr = itemId.slice(colon + 1);
      /* Canonical positive-integer id only (rejects "", "abc", "0", "1e3", "0x10", " 5 "), so a
         malformed/non-canonical item_id never sends a wrong or rounded delete key. Mirrors the
         panel's isDeletable, so "show control" and "can delete" agree on every input. */
      if (!/^[1-9]\d*$/.test(idStr)) return;
      const verb = MEMORY_DELETE_VERBS[kind];
      if (!verb) return;
      this.send({ type: verb.type, payload: { [verb.field]: Number(idStr) } });
   }

   /* Focus/blur is a local UI cue only; the real reactor state comes from DAWN's
      `state` frames, so we tell the server nothing here. */
   setEngaged(_engaged: boolean): void {}

   /* `silent`: don't report "disconnected" (the caller emits its own status, or reloads). */
   disconnect(silent = false): void {
      this.wantConnected = false;
      window.clearTimeout(this.wsReconnectTimer); // cancel any pending auto-reconnect
      this.wsFails = 0;
      this.stopMetrics();
      this.stopHeartbeat();
      this.closeMusicStream();
      this.alarmChime.stopLoop();
      this.ringingAlarms.clear();
      this.phone.reset();
      this.tts?.stop();
      window.clearTimeout(this.micMuteCooldown);
      this.micMuteCooldown = 0;
      this.dawnSpeaking = false;
      /* Drop any in-flight utterance: the server's accumulated audio dies with the
         connection, so there is nothing to salvage. Reset the button to idle. */
      this.mic.stop();
      this.emitMicState("idle");
      window.clearTimeout(this.convListTimer); // no live picker refresh should fire post-teardown
      this.convListTimer = 0;
      this.pendingListRefresh = false;
      this.ws?.close();
      this.ws = null;
      if (!silent) this.emit("disconnected");
   }

   /* Reclaim the session for THIS tab after being superseded by another one. A deliberate
      user gesture (the "Use DAWN here" button): re-open the socket, which reconnects to our
      session and cleanly evicts whatever tab currently holds it (server-side reconnect-
      eviction, which sends IT a 4001 in turn). Only valid while superseded, so an errant call
      can't fight a healthy link. */
   reclaim(): void {
      if (!this.superseded) return;
      this.superseded = false;
      /* A takeover: the other tab may have advanced this conversation while we were backed
         off, so the next session frame does a FULL reload (not the lightweight re-anchor) to
         catch the display up to the latest turns. */
      this.reclaiming = true;
      this.wantConnected = true;
      this.wsFails = 0;
      window.clearTimeout(this.wsReconnectTimer);
      this.openSocket();
   }

   stop(): void {
      this.disconnect();
   }

   /* Final teardown (HMR/unmount). disconnect() keeps the lazily-built audio contexts so
      an in-session reconnect reuses them; dispose() also closes them, so a hot reload does
      not stack AudioContexts past Chrome's ~6-context cap (after which new audio silently
      dies). tts may be undefined if start() never ran. */
   dispose(): void {
      window.removeEventListener("storage", this.onStorage);
      this.disconnect();
      /* The forget-learned timers: busy re-asks of the count and the forget's no-reply timeout. */
      for (const t of this.learnedRetryTimers) window.clearTimeout(t);
      this.learnedRetryTimers.clear();
      this.learnedRetries.clear();
      window.clearTimeout(this.forgetTimer);
      this.forgetTimer = 0;
      /* Settle any in-flight full-text reads so their promises + timers never dangle across HMR. */
      for (const pending of this.pendingDocGets.values()) {
         window.clearTimeout(pending.timer);
         pending.resolve(null);
      }
      this.pendingDocGets.clear();
      /* Same for an in-flight edit save: clear its 15s timer + resolve so it can't pin this
         instance across an HMR reload. */
      if (this.pendingDocEdit) {
         window.clearTimeout(this.pendingDocEdit.timer);
         this.pendingDocEdit.resolve("Editor closed.");
         this.pendingDocEdit = null;
      }
      this.tts?.dispose();
      this.music.dispose();
      this.mic.dispose();
      this.ding.dispose();
      this.phone.dispose();
      this.alarmChime.dispose();
   }

   /* Whether a typed turn can go out now: the link is live AND this connection's config has arrived,
      so the feature flags that shape the turn (turn_refs, image flags) are known. */
   canSendTurn(): boolean {
      return this.isLinkLive() && this.configSeen;
   }

   /* Whether documents go as the structured `attachments` field: `document_attachments`, which only
      ever ships with `turn_refs` (required too: the echo of such a turn is matched by its ref). */
   supportsStructuredDocs(): boolean {
      return this.hasFeature("document_attachments") && this.hasFeature("turn_refs");
   }

   /* DAWN's per-turn document limits. Its defaults (5 documents, 1024 KB of text each) until the
      config field names are confirmed; the daemon enforces them regardless (ATTACHMENT_INVALID). */
   documentLimits(): { maxDocuments: number; maxContentBytes: number } {
      return { maxDocuments: 5, maxContentBytes: 1024 * 1024 };
   }

   /* Whether DAWN echoes a turn reference on the echo and on refusals: the `turn_refs` flag. */
   supportsTurnRefs(): boolean {
      return this.hasFeature("turn_refs");
   }

   /* Whether DAWN runs an image-only turn (empty text + image_ids): the `image_only_turns` flag. */
   supportsImageOnlyTurns(): boolean {
      return this.hasFeature("image_only_turns");
   }

   /* The Mail panel's source (the email verbs live behind the `email_client` flag). */
   emailSource(): EmailSource {
      return this.email;
   }

   /* Whether a chat turn can carry an email reference (DAWN's `email_refs` flag; the turn field
      lands with DAWN P1.4, so this stays false until this client sends it). Prerequisites before
      it may return true (docs/EMAIL_PANEL_DESIGN.md 4): the turn sends `email_refs`, private-first
      creation (newConversation({private:true}), done), and off-origin images in assistant replies
      no longer auto-load (4.7, not built yet). */
   supportsEmailRefs(): boolean {
      return false;
   }

   /* The login panel subscribes to reflect connection state. */
   onStatus(handler: StatusHandler): void {
      this.status = handler;
   }

   private emit(status: LinkStatus, detail?: string): void {
      this.lastStatus = status;
      this.lastDetail = detail ?? "";
      this.email.setLinked(status === "connected");
      /* Link down: an unechoed turn's fate can't be learned now; stop holding drafts for them. Not on
         "stale" (one missed heartbeat): the socket is still open and refusals still arrive. */
      if (status !== "connected" && status !== "stale" && this.sinks) this.sinks.conversation.releaseTurns();
      if (status !== "connected") this.settlePrivateCreate(false); // a pending private create can't complete now
      this.status(status, detail);
   }

   /* Snapshot for the System > Connection dialog: current link state, the origin the
      browser talks to (DAWN rides the same-origin proxy), and the daemon version if it
      advertised one (else ""). */
   getConnectionInfo(): { status: LinkStatus; detail: string; server: string; dawnVersion: string } {
      return {
         status: this.lastStatus,
         detail: this.lastDetail,
         server: window.location.origin,
         dawnVersion: this.dawnVersion
      };
   }

   private send(msg: object): void {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
   }

   /* Raw binary to the main socket (mic audio). The opcode is prepended by the caller;
      guarded so a frame that arrives after a drop is dropped, not thrown. */
   private sendBinary(bytes: Uint8Array): void {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(bytes);
   }

   /* One mic capture chunk -> an AUDIO_IN frame ([0x01][payload]). Voice input is a
      deliberate, user-initiated write, in the same sanctioned class as chat submit. */
   private sendAudioIn(payload: Uint8Array): void {
      /* Hold audio until the session is confirmed: Opus shipped before use_opus is set on
         the (re)connection would be decoded as PCM. In practice a hold is always long
         after `session`, so this only guards the reconnect-mid-utterance edge. */
      if (!this.capsSynced) return;
      const frame = new Uint8Array(1 + payload.byteLength);
      frame[0] = BIN_AUDIO_IN;
      frame.set(payload, 1);
      this.sendBinary(frame);
   }

   /* Advance the displayed uptime from the last synced base, so it counts up every
      second like the clock instead of jumping each 8s poll. */
   private tickUptime(): void {
      if (this.uptimeBaseAt === 0) return;
      const elapsed = (performance.now() - this.uptimeBaseAt) / 1000;
      this.sinks.telemetry.update({ up: fmtUptime(this.uptimeBaseSec + elapsed) });
   }

   private stopMetrics(): void {
      window.clearInterval(this.metricsTimer);
      window.clearInterval(this.uptimeTimer);
      window.clearInterval(this.calendarTimer);
      window.clearTimeout(this.calendarDebounce);
      window.clearInterval(this.haTimer);
      window.clearInterval(this.watchTimer);
   }

   /* A notification card. Handed to the notification layer, which owns its life: it
      spikes in, then either settles to a quiet float (`persist`, for things you may act
      on: an attention alert, a ringing alarm) or auto-fades (a toast: job/observation/
      info). It carries an × and snaps like the instruments (drag to dock, drag onto the
      atom to undock). Fixed id per channel so a newer notice replaces the older. `x`/`y`
      are the abstract default spot (-1..1) until the user moves/snaps it. */
   private spikeNotice(
      id: string,
      kind: string,
      summary: string,
      opts: {
         tone?: "nominal" | "attention";
         hold?: number;
         detail?: string;
         persist?: boolean;
         critical?: boolean;
         urgent?: boolean;
         actions?: NoticeAction[];
         open?: NoticeOpen;
      }
   ): void {
      this.sinks.notifications.notify({
         id,
         kind,
         summary,
         detail: opts.detail,
         tone: opts.tone ?? "nominal",
         persist: opts.persist,
         critical: opts.critical,
         urgent: opts.urgent,
         actions: opts.actions,
         hold: opts.hold,
         open: opts.open
      });
   }

   /* Track a job in the active set. `queued`/`running` are active; everything else
      is terminal, so drop it (set membership, never +/-1, so dup/out-of-order
      frames converge). */
   private trackJob(j: JobRow): void {
      if (j.conversation_id == null) return;
      const running = j.status === "queued" || j.status === "running";
      if (running) this.jobs.set(j.conversation_id, { title: j.title || "background job", running: j.status === "running" });
      else this.jobs.delete(j.conversation_id);
   }

   /* Reflect the active set into the jobs card: a sticky, movable status widget listing
      running jobs. It snaps like the instruments (central dead zone, side columns) and,
      being sticky, is always full-presence - never a fading toast. When none are active
      the card leaves the dashboard entirely. */
   private renderJobs(): void {
      const count = this.jobs.size;
      if (count === 0) {
         this.sinks.notifications.remove("jobs");
         return;
      }
      const items = [...this.jobs.values()].map((j) => `${j.running ? "▹" : "·"} ${j.title}`);
      this.sinks.notifications.notify({
         id: "jobs",
         kind: "jobs",
         summary: `${count} active job${count > 1 ? "s" : ""}`,
         items,
         sticky: true,
         // defaults to the right region (its old rail side); persists once moved
      });
   }

   /* Persist a turn to the DB. DAWN keeps webui text turns in memory only — the
      client owns the user turn and the final answer rows (webui_history.c message-
      ownership map); without this our conversations never survive a reconnect. */
   /* A user turn from the server. In Phase 0 it arrives BOTH as the transcript echo AND as the
      message_appended fan-out, in an unspecified order, so dedup order-independently on message
      id: already in the transcript -> skip (the other frame handled it); matches a locally-typed
      echo -> it's our own optimistic bubble, so just record its id (so the other frame dedups)
      and consume the echo; otherwise -> a spoken turn or another viewer's turn, rendered as a
      user bubble (unless a history replay, which loadHistory owns).
      INVARIANT (DAWN contract): when a user turn produces TWO frames (transcript echo +
      message_appended fan-out) they MUST carry the SAME POSITIVE message_id. The first frame
      consumes the text-based typedEcho, so the second can only dedup via hasMessage(messageId) -
      a 0/absent id on either would double the user's own message. DAWN guards the fan-out on
      message_id > 0 on BOTH the text and voice paths (verified), so a save-failure/id-0 turn
      emits only the echo (single frame - the splice handles it), never a doubling second frame. */
   private handleIncomingUser(text: string, messageId: number, replay: boolean, ref?: string): void {
      if (this.sinks.conversation.hasMessage(messageId)) return;
      /* turn_refs: our own echo names its turn, so dedup by the ref (a structured-attachments
         turn's echo carries server-built text that can't match what we showed). */
      if (ref !== undefined) {
         const i = this.typedEchoes.findIndex((e) => e.ref === ref);
         if (i >= 0) {
            this.typedEchoes.splice(i, 1);
            this.sinks.conversation.noteMessageId(messageId);
            return;
         }
      }
      /* An image-only turn's own echo has empty text (image_only_turns): it can only be ours (the
         local bubble already shows the attached images), so adopt its id and draw nothing. */
      if (!text) {
         const i = this.typedEchoes.findIndex((e) => e.text === "");
         if (i >= 0) {
            this.typedEchoes.splice(i, 1);
            this.sinks.conversation.noteMessageId(messageId);
         }
         return;
      }
      const now = performance.now();
      const echoIdx = this.typedEchoes.findIndex((e) => e.text === text && now - e.at < TYPED_ECHO_TTL_MS);
      if (echoIdx >= 0) {
         this.typedEchoes.splice(echoIdx, 1);
         this.sinks.conversation.noteMessageId(messageId);
         return;
      }
      if (!replay) this.sinks.conversation.showUser(text, messageId);
   }
}
