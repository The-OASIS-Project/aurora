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
   OutImage,
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
import {
   effortOptionsForModel,
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
   private readonly typedEchoes: Array<{ text: string; at: number }> = [];
   private readonly jobs = new Map<number, { title: string; running: boolean }>();
   /* Event ids of currently-ringing ALARMS (not reminders/timers, which DAWN auto-dismisses).
      Drives the scheduler_action{dismiss} on user close and the shared ringing-tone loop
      (loop runs while the set is non-empty). Keyed per event so concurrent alarms + a
      reminder don't clobber each other's cards (each notice is `scheduler-<eventId>`). */
   private readonly ringingAlarms = new Set<number>();
   /* Client-side chime/loop for scheduled events (the daemon tone is daemon-local). Initial
      enabled state from the persisted "Alarm sounds" preference; the System-menu toggle flips it. */
   private readonly alarmChime = new AlarmChime(localStorage.getItem(ALARM_SOUNDS_KEY) !== "false");
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
   private haTimer = 0; // polls ha_refresh_entities as the backstop under the realtime push
   private watchTimer = 0; // polls watch_list (no push exists); refreshes the rule structure
   private watchReadingsWanted = false; // Watches panel visible -> subscribe to the 1 Hz gauge stream
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
   private micMuteCooldown = 0; // timer: reopen the mic a beat after DAWN goes fully quiet
   private ttsEnabled = localStorage.getItem(TTS_KEY) !== "false"; // default on
   private rateEma = Number(localStorage.getItem(RATE_EMA_KEY) ?? 0); // 0 = no samples yet
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
   private readonly llmListeners: Array<() => void> = [];
   private readonly seenUnhandled = new Set<string>();

   /* Bind the sinks. Does NOT connect — the user drives that from the login
      panel via connect(), so credentials never live in the composition root. */
   start(sinks: IngestSinks): void {
      this.sinks = sinks;
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

      const csrfRes = await fetch("/api/auth/csrf", { credentials: "same-origin" });
      if (!csrfRes.ok) throw new Error(`CSRF request failed (${csrfRes.status})`);
      const { csrf_token } = (await csrfRes.json()) as { csrf_token: string };

      const loginRes = await fetch("/api/auth/login", {
         method: "POST",
         credentials: "same-origin",
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify({ csrf_token, username, password })
      });
      const login = (await loginRes.json().catch(() => ({}))) as {
         success?: boolean;
         error?: string;
      };
      if (!loginRes.ok || !login.success) {
         this.emit("error", login.error ?? `Login failed (${loginRes.status})`);
         throw new Error(login.error ?? "Login failed");
      }

      this.openSocket();
   }

   /* On page load, if the auth cookie is still valid, skip the login card and open
      the socket straight away (resuming the stored session). Keeps the user logged
      in across an F5 instead of asking for credentials every reload. */
   async tryResume(): Promise<void> {
      try {
         const res = await fetch("/api/auth/status", { credentials: "same-origin" });
         if (res.ok) {
            const s = (await res.json()) as { authenticated?: boolean };
            if (s.authenticated) {
               this.wantConnected = true;
               this.openSocket();
               return;
            }
         }
      } catch {
         /* fall through to show the login card */
      }
      /* No valid session — reveal the login card. */
      this.emit("idle");
   }

   private openSocket(): void {
      this.emit("connecting");
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      /* Same-origin /ws — Vite proxies it to the DAWN daemon. The dawn-1.0
         subprotocol is MANDATORY: omit it and libwebsockets routes us to its
         HTTP handler, the socket "opens", and every frame is silently dropped. */
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`, "dawn-1.0");
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
            tool_step_origin: true
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
         this.stopMetrics();
         this.closeMusicStream();
         /* Drop the seek-detection baseline: a resume may land at a different track/
            position, and a stale baseline would misread that first music_state as a seek. */
         this.prevMusicIndex = null;
         /* Drop any in-flight list latch: a load-more that never got its response must not
            poison the post-reconnect boot response into an append. */
         this.conversationsLoading = false;
         this.pendingListAppend = false;
         this.sinks.reactor.setState("idle");
         /* Superseded: another connection deliberately took over this session server-side. Do
            NOT auto-reconnect - re-stealing it would restart the very fight the eviction exists
            to end. Back off, stop wanting the link, surface the takeover; the user reclaims
            with a gesture (reclaim()). We recognize it two ways: the WS close code `4001` (only
            when it survives - it does NOT through the Vite dev proxy, which delivers 1006), AND
            an already-set `superseded` flag from the `session_superseded` data frame the server
            sends just before the close (frames DO survive the proxy). So the frame is the
            reliable signal; the close code is the same-origin/prod belt-and-suspenders. */
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
         } else {
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
      this.spikeNotice("link-notice", "notice", message, { tone: "attention", hold: 6, x: 0, y: -0.55 });
   }

   /* Session revoked/expired server-side (force_logout, or an UNAUTHORIZED reply to any authed
      verb incl. the heartbeat). Drop the dead token, stop wanting to be connected so the
      auto-reconnect does NOT silently mint a fresh session behind the revocation, cancel any
      pending retry and the heartbeat, and surface the login card with the reason. */
   private revokeSession(reason?: string): void {
      localStorage.removeItem(TOKEN_KEY);
      this.wantConnected = false;
      window.clearTimeout(this.wsReconnectTimer);
      this.stopHeartbeat();
      this.emit("error", reason);
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

      switch (type) {
         case "session":
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
            /* On-connect config. Advertises the dedicated music-stream server as of
               signal-map §9.1c: skip the socket entirely when music is disabled, else
               open it now with the token `session` just stored. (music_port is for a
               non-proxied client; we always reach it through the /music-ws dev proxy.)
               Older servers omit music_enabled -> the field stays true and we open. */
            this.musicEnabled = p.music_enabled !== false;
            if (typeof p.version === "string") this.dawnVersion = p.version;
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
               this.sinks.conversation.setAssistantName(
                  name.charAt(0).toUpperCase() + name.slice(1)
               );
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
               /* Reasoning/effort: prefer the session's resolved runtime values; fall
                  back to the global config default only for older servers that omit them
                  from llm_runtime. Legacy "auto" folds into "enabled". */
               this.applyReasoning(rt.thinking_mode ?? cfg.llm?.thinking?.mode, rt.reasoning_effort ?? cfg.llm?.thinking?.reasoning_effort);
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
            const models = (p.models ?? []) as Array<{ name?: string }>;
            this.localModels = models.map((m) => m.name ?? "").filter(Boolean);
            /* Reconcile in case we are in local mode with a model that predates this list
               (Mode switched to local before it arrived) - picks a valid local model now. */
            this.reconcileModel();
            break;
         }

         case "set_session_llm_response":
            /* Authoritative echo of a set_session_llm change (§9.1d). Reflect the
               value the SERVER resolved, not the one the user picked, across every
               field the response carries (provider / model / *_available /
               thinking_mode / reasoning_effort): native Claude clamps a
               mid-conversation thinking-disable back to enabled (§9.2), and a
               provider switch resolves a new model + availability set the optimistic
               local state does not know. Following the echo keeps the panel from
               showing a state the session is not actually in. The paired
               INFO_THINKING_KEPT_ON notice (an `error` frame) explains the clamp. */
            if (p.success !== false) {
               if (typeof p.provider === "string") {
                  const prov = p.provider.toLowerCase();
                  if (isLlmProvider(prov)) this.llm.provider = prov;
               }
               if (typeof p.model === "string" && p.model) this.llm.model = p.model;
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
               this.applyReasoning(
                  typeof p.thinking_mode === "string" ? p.thinking_mode : undefined,
                  typeof p.reasoning_effort === "string" ? p.reasoning_effort : undefined
               );
               this.notifyLlm();
            } else {
               /* The session LLM change was rejected (e.g. a provider/model DAWN could not
                  select). Surface it instead of failing silently - a control-feedback notice,
                  not a chat line. The session kept its previous LLM. */
               const err = (p as { error?: string }).error;
               console.warn("[dawn] set_session_llm rejected:", err);
               this.spikeNotice("llm-switch-error", "attention", err || "Could not switch model", {
                  tone: "attention",
                  hold: 9,
                  x: 0,
                  y: -0.55
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
            this.conversationsLoading = false;
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
            break;
         }

         case "search_conversations_response": {
            this.conversationsLoading = false;
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
                  this.convId = 0;
                  localStorage.removeItem(CONV_KEY);
                  this.sinks.conversationList.setActive(0);
                  break;
               }
               this.spikeNotice("conv-load", "conversation", "Could not open that conversation", {
                  x: 0,
                  y: -0.4,
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
            this.sinks.conversation.loadHistory(
               msgs
                  .filter((m) => m.role === "user" || m.role === "assistant")
                  .flatMap((m) => {
                     const info = interpretMessage(m.content);
                     /* The REAL tool source is the separate `tool_calls` column (ordered,
                        id'd, with args + correlated results); interpretMessage's content-block
                        tools are a legacy fallback. Prefer tool_calls when present. */
                     const structured = parseToolCalls(m.tool_calls, toolResults);
                     const tools = structured.length ? structured : info?.tools;
                     if (!info && !tools) return [];
                     /* Stamp the DB id so a late message_appended for a reloaded row can't
                        re-double it (Phase-0 dedup prereq). */
                     return [
                        {
                           role: m.role as "user" | "assistant",
                           text: info?.text,
                           tools,
                           id: Number(m.id ?? 0) || undefined
                        }
                     ];
                  })
            );
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
               rename: the panel already patched optimistically. Only reconcile on
               failure by refetching the server's truth. */
            if ((p as { success?: boolean }).success === false) this.requestConversations();
            break;

         case "set_pinned_response":
            /* Echoes conversation_id + is_pinned; the panel patched optimistically on the
               click, so accept the success and only refetch to correct a failure. */
            if ((p as { success?: boolean }).success === false) this.requestConversations();
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
                     x: 0,
                     y: -0.4,
                     hold: 5,
                     tone: "attention"
                  });
               }
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
                  x: 0,
                  y: -0.4,
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
               this.convId = 0;
               localStorage.removeItem(CONV_KEY); // the resumed conversation is gone
               this.sinks.conversation.clear();
               this.sinks.context.clear();
               this.setActiveTitle(""); // fresh chat
               this.sinks.conversationList.setActive(0);
            }
            this.pendingDeleteId = 0;
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
            } else {
               this.sinks.conversationList.markAppended(cid);
            }
            break;
         }

         case "conversation_reset":
            /* A tool (reset_conversation / "start a new conversation") cleared the
               context. Empty the surface and drop our active conversation so the
               NEXT message opens a fresh one (mirrors the old WebUI's startNewChat),
               preserving the previous conversation instead of appending to it. */
            this.sinks.conversation.clear();
            this.sinks.context.clear();
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
            this.sinks.context.clear(); // fresh conversation: no injected context yet
            /* Reflect the real title: a server-initiated (voice) create pushes it; a client
               create derives it from the first message (DAWN doesn't echo it, so we remembered
               it). Without this the HUD shows the "New conversation" placeholder until the
               later auto-title, while the picker already shows the real title. */
            this.setActiveTitle(serverInitiated ? String(np.title ?? "") : this.pendingNewConvTitle);
            this.pendingNewConvTitle = "";
            this.convId = Number(np.conversation_id ?? 0);
            if (this.convId > 0) {
               localStorage.setItem(CONV_KEY, String(this.convId)); // resume this on the next reload
               this.sinks.conversationList.setActive(this.convId);
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

         case "state": {
            const st = String(p.state ?? "idle");
            const detail = typeof p.detail === "string" ? p.detail : undefined;
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
            this.sinks.conversation.setStatus(this.activityFor(st, detail, p.tools));
            /* No client-side persist on idle (or anywhere): DAWN is the sole writer of the turn
               (server-authoritative persistence); the client only renders + reconciles the fanned
               message_appended. `state` here just drives the reactor / activity chip. */
            break;
         }

         case "error": {
            /* Route on `severity` (§9.1b): info = benign notice (e.g.
               INFO_THINKING_KEPT_ON), warning/error = a real problem. Fall back to the
               `INFO_` code prefix for older servers that don't send severity. Never
               paint the reactor red for an info notice; instead surface it as an
               ambient spike so the user sees why (e.g. the thinking toggle held on). */
            const code = typeof p.code === "string" ? p.code : "";
            /* The session was revoked/expired server-side (DAWN re-validates the token
               against the DB on every authed verb, including our heartbeat ping, and
               answers a dead session with UNAUTHORIZED instead of a pong). Treat it like
               force_logout: stop resuming a session that no longer exists, surface login. */
            if (code === "UNAUTHORIZED") {
               this.revokeSession(typeof p.message === "string" ? p.message : undefined);
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
                     hold: 7,
                     x: 0,
                     y: -0.55
                  });
               }
            } else if (severity === "warning") {
               /* A warning is not a failed turn - surface it as an ambient toast, not a
                  chat line. */
               const message = typeof p.message === "string" ? p.message : "";
               console.warn("[dawn] warning frame:", code, message);
               this.spikeNotice("dawn-warning", "attention", message || "Warning", {
                  tone: "attention",
                  hold: 9,
                  x: 0,
                  y: -0.55
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
                  hold: 7,
                  x: 0,
                  y: -0.55
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
                  hold: 6,
                  x: 0,
                  y: -0.55
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
                  hold: 6,
                  x: 0,
                  y: -0.55
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
                  x: 0.6,
                  y: -0.4
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
               x: 0.6,
               y: -0.4
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
               /* Spawn centered, in the reactor's full-height dead strip: docked panels are kept
                  in the left/right columns flanking it, so a centered notice avoids them. */
               x: 0,
               y: -0.42
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
               x: 0,
               y: 0.42
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
                  x: 0.62,
                  y: 0.42
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
                  this.sinks.reactor.setState("idle");
                  this.sinks.conversation.setThinking(false);
                  this.sinks.conversation.setStatus(this.activityFor("idle", undefined, undefined));
               }
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
               this.handleIncomingUser(
                  p.text.trim(),
                  Number((p as { message_id?: number }).message_id ?? 0),
                  p.replay === true
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
               this.handleIncomingUser(String((p as { text?: string }).text ?? "").trim(), messageId, false);
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
               if (enteringRecording) this.ding.play();
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
      this.convId = 0;
      localStorage.removeItem(CONV_KEY); // fresh chat: nothing to resume until a message opens one
      /* Finalize any in-flight streamed bubble before wiping (both the menu New Chat and the
         picker "+ New" arrive here). */
      this.sinks.conversation.endReply();
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
      mutation whose response can't be patched in place (rename/delete failure, a new row). */
   private requestConversations(): void {
      this.pendingListAppend = false;
      this.conversationsLoading = true;
      this.send({ type: "list_conversations", payload: { limit: CONV_PAGE, offset: 0 } });
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
      this.convId = id;
      this.sinks.conversationList.setActive(id);
      this.send({ type: "load_conversation", payload: { conversation_id: id } });
   }

   newConversation(): void {
      /* Lazy creation (Aurora's model): clear the surface + id now; the first message
         opens the conversation via the convId===0 path in submit(). */
      this.newChat();
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
      const res = await fetch(`/api/documents/original/${encodeURIComponent(blobId)}`, {
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
      const res = await fetch("/api/documents", { method: "POST", credentials: "same-origin", body: fd });
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
      const res = await fetch("/api/images", { method: "POST", credentials: "same-origin", body: fd });
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
      const res = await fetch(`/api/images/${encodeURIComponent(id)}`, {
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
      let ws: WebSocket;
      try {
         ws = new WebSocket(`${proto}://${window.location.host}/music-ws`, "dawn-music");
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
      const effort = this.llm.reasoning === "disabled" ? "OFF" : this.llm.effort.toUpperCase();
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
      if (typeof pl.model === "string") this.llm.model = pl.model;
      this.llm.providers = {
         openai: pl.openai_available === true,
         claude: pl.claude_available === true,
         gemini: pl.gemini_available === true,
         openrouter: pl.openrouter_available === true || this.llm.provider === "openrouter"
      };
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
      this.applyReasoning(s.thinking_mode, s.reasoning_effort);
   }

   /* Set the panel's reasoning/effort from a server-provided (thinking_mode,
      reasoning_effort) pair — get_config's llm_runtime on connect, or a
      set_session_llm echo after a change. Both args are optional; a missing field
      leaves the current value untouched. Legacy "auto" folds into binary "enabled". */
   private applyReasoning(thinkingMode?: string, effort?: string): void {
      if (thinkingMode) this.llm.reasoning = thinkingMode === "disabled" ? "disabled" : "enabled";
      if (effort) this.llm.effort = effort;
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
         /* Keep effort valid for the new model so the panel's segmented control always has
            an active value (the server clamps + echoes too, but this avoids a transient
            no-selection state until the echo lands). */
         const opts = effortOptionsForModel(this.llm.model);
         if (!opts.includes(this.llm.effort)) this.llm.effort = opts.includes("medium") ? "medium" : opts[0];
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
            this.applyLlm({ type: this.llm.mode, model }); // send type too (see setProvider)
         },
         setReasoning: (reasoning) => {
            /* Optimistic; the set_session_llm_response echo confirms or clamps it. */
            this.llm.reasoning = reasoning;
            this.applyLlm({ thinking_mode: reasoning });
         },
         setEffort: (effort) => {
            this.llm.effort = effort;
            this.applyLlm({ reasoning_effort: effort });
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
   submit(text: string, attachments?: { images?: OutImage[]; imageIds?: string[] }): void {
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
      } = { text };
      if (this.convId > 0) payload.conversation_id = this.convId;
      /* Image attachments: base64 for the live LLM call, plus the MANDATORY image_ids (the
         /api/images upload ids, order-matched) the daemon persists as [IMAGE:<id>] markers so
         they rehydrate on reload. Hard cut-over: an image turn without ids persists text-only,
         so the composer always sends both together (built from the same pending list). */
      if (attachments?.images?.length) {
         payload.images = attachments.images;
         payload.image_ids = attachments.imageIds ?? [];
      }
      this.send({ type: "text", payload });
      /* DAWN will echo this as a user `transcript` (it drives its own WebUI's typed
         bubble). We already showed it locally, so remember it to dedupe that echo; a
         voice transcript has no local counterpart and displays. Bounded so a dropped
         echo cannot grow the list without limit. */
      this.typedEchoes.push({ text: text.trim(), at: performance.now() });
      if (this.typedEchoes.length > 8) this.typedEchoes.shift();
      this.sinks.conversation.setThinking(true);
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

   /* "Alarm sounds" preference (the System-menu toggle): gates the client chime + ringing
      loop only (the spoken alarm rides the general TTS mute, no DAWN verb). Persisted. */
   alarmSoundsEnabled(): boolean {
      return this.alarmChime.isEnabled();
   }
   setAlarmSounds(on: boolean): void {
      this.alarmChime.setEnabled(on);
      localStorage.setItem(ALARM_SOUNDS_KEY, on ? "true" : "false");
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

   disconnect(): void {
      this.wantConnected = false;
      window.clearTimeout(this.wsReconnectTimer); // cancel any pending auto-reconnect
      this.wsFails = 0;
      this.stopMetrics();
      this.stopHeartbeat();
      this.closeMusicStream();
      this.alarmChime.stopLoop();
      this.ringingAlarms.clear();
      this.tts?.stop();
      window.clearTimeout(this.micMuteCooldown);
      this.micMuteCooldown = 0;
      this.dawnSpeaking = false;
      /* Drop any in-flight utterance: the server's accumulated audio dies with the
         connection, so there is nothing to salvage. Reset the button to idle. */
      this.mic.stop();
      this.emitMicState("idle");
      this.ws?.close();
      this.ws = null;
      this.emit("disconnected");
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
      this.disconnect();
      /* Settle any in-flight full-text reads so their promises + timers never dangle across HMR. */
      for (const pending of this.pendingDocGets.values()) {
         window.clearTimeout(pending.timer);
         pending.resolve(null);
      }
      this.pendingDocGets.clear();
      this.tts?.dispose();
      this.music.dispose();
      this.mic.dispose();
      this.ding.dispose();
      this.alarmChime.dispose();
   }

   /* The login panel subscribes to reflect connection state. */
   onStatus(handler: StatusHandler): void {
      this.status = handler;
   }

   private emit(status: LinkStatus, detail?: string): void {
      this.lastStatus = status;
      this.lastDetail = detail ?? "";
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
         x: number;
         y: number;
         tone?: "nominal" | "attention";
         hold?: number;
         detail?: string;
         persist?: boolean;
         critical?: boolean;
         actions?: NoticeAction[];
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
         actions: opts.actions,
         hold: opts.hold,
         x: opts.x,
         y: opts.y
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
         x: 0.62, // defaults to the right region (its old rail side); persists once moved
         y: -0.2
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
   private handleIncomingUser(text: string, messageId: number, replay: boolean): void {
      if (!text) return;
      if (this.sinks.conversation.hasMessage(messageId)) return;
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
