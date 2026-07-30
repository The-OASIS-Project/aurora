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

/* What ingest can push to the conversation console (a passive view). Streaming
   replies arrive as startReply -> appendDelta* -> endReply; a complete message
   (non-streamed or replayed history) arrives as showReply. */
export interface ConversationSink {
   setThinking(thinking: boolean): void;
   startReply(): void;
   appendDelta(delta: string): void;
   endReply(): void;
   showReply(text: string): void;
   /* The configured assistant display name (ai_name), for the reply header. */
   setAssistantName(name: string): void;
   /* Replace the transcript with a loaded conversation's history (oldest first). */
   loadHistory(msgs: { role: "user" | "assistant"; text: string }[]): void;
   /* A tool reset the conversation — empty the surface. */
   clear(): void;
   /* Current activity (thinking / using tools / ...) or null to clear it. */
   setStatus(status: ActivityStatus | null): void;
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

/* The sinks ingest fans out to. */
export interface IngestSinks {
   store: Store;
   reactor: ReactorSink;
   conversation: ConversationSink;
   telemetry: TelemetrySink;
   music: MusicSink;
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
   stop(): void;
}
