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

import type { ActivityStatus, Ingest, IngestSinks, MusicState, MusicTrack } from "./ingest.ts";
import type { ReactorState } from "../anchor/anchor.ts";
import { IMPORTANCE } from "../state/types.ts";
import { TtsPlayback } from "../audio/tts.ts";
import { MusicAudio } from "../audio/music.ts";
import {
   effortOptionsForModel,
   type LlmMode,
   type LlmProvider,
   type LlmState,
   type ModelControl,
   type Reasoning
} from "../model/model.ts";

/* Server -> client binary opcodes (webui_server.h). Audio is a 1-byte type prefix
   then raw payload. We consume the TTS output frames and the music stream. */
const BIN_AUDIO_OUT = 0x11; // a TTS PCM chunk
const BIN_AUDIO_SEGMENT_END = 0x12; // play the accumulated segment now
const BIN_MUSIC_DATA = 0x20; // a music Opus chunk ([uint16-LE len][opus] run)
const MUSIC_WS_MAX_FAILS = 5; // give up on the dedicated stream socket after this many

const TTS_KEY = "dawn.hero.tts"; // persisted TTS on/off
/* Exponential moving average of the live token rate: a smooth figure that leans
   toward recent generations. Persisted so it survives a refresh. */
const RATE_EMA_KEY = "dawn.hero.rateEma";
const RATE_EMA_ALPHA = 0.15; // higher = more responsive to the latest samples

/* Persisted reasoning/effort. DAWN does not report the session's values (they are
   absent from llm_runtime), so on reconnect the client would otherwise fall back
   to the global config default and appear to "reset". We remember the user's own
   choice here and re-assert it on connect. Drop this once DAWN serializes
   thinking_mode/reasoning_effort into llm_runtime (signal-map section 9). */
const LLM_PREFS_KEY = "dawn.hero.llmPrefs";

function loadLlmPrefs(): { reasoning?: Reasoning; effort?: string } {
   try {
      const raw = localStorage.getItem(LLM_PREFS_KEY);
      if (!raw) return {};
      const p = JSON.parse(raw) as { reasoning?: string; effort?: string };
      const reasoning =
         p.reasoning === "disabled" || p.reasoning === "enabled" ? (p.reasoning as Reasoning) : undefined;
      return { reasoning, effort: typeof p.effort === "string" ? p.effort : undefined };
   } catch {
      return {};
   }
}

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

export class DawnIngest implements Ingest {
   private sinks!: IngestSinks;
   private ws: WebSocket | null = null;
   /* Dedicated dawn-music stream socket (main port + 1, proxied at /music-ws).
      DAWN routes audio here once it authenticates, keeping it off the control
      channel; if it never attaches, audio just keeps arriving on the main socket. */
   private musicWs: WebSocket | null = null;
   private musicWsTimer = 0;
   private musicWsFails = 0;
   private musicWsToken = ""; // token the current music socket is (re)connecting with
   private status: StatusHandler = () => {};
   private wantConnected = false; // did the user ask to be connected (vs a drop)
   private loadedInitial = false; // guard: load the starting conversation only once
   private convId = 0; // active conversation; save_message targets persist to it
   private replyBuf = ""; // final assistant answer, accumulated to persist on idle
   private readonly jobs = new Map<number, { title: string; running: boolean }>();
   private schedulerEventId = 0; // the ringing event behind the scheduler notice
   private metricsTimer = 0; // polls get_metrics to keep the HUD readout live
   private uptimeTimer = 0; // ticks the uptime display every second between polls
   private uptimeBaseSec = 0; // last authoritative uptime from get_metrics
   private uptimeBaseAt = 0; // performance.now() when that uptime was received
   private tts!: TtsPlayback;
   /* Created at construction (not in start) so the player view can bind to it
      before ingest.start() runs. Its AudioContext stays lazy until the first frame. */
   private readonly music = new MusicAudio();
   private ttsEnabled = localStorage.getItem(TTS_KEY) !== "false"; // default on
   private rateEma = Number(localStorage.getItem(RATE_EMA_KEY) ?? 0); // 0 = no samples yet
   /* Tool-use latch. DAWN pings `tool_call` then flips straight back to `thinking`
      while the tool runs and its results are processed, so the tool_call state alone
      flickers past unseen. We latch "using tools" from the ping until the turn leaves
      the thinking phase (speaking/idle/etc), so even a fast tool call stays visible. */
   private toolActive = false;
   private toolName: string | undefined;
   /* LLM selection state (MODEL panel). Reasoning/effort are client-tracked (DAWN
      does not push them); mode/provider/model/availability come from llm_state_update.
      Reasoning/effort seed from the persisted user choice so a refresh does not revert
      them to the config default before get_config lands. */
   private readonly llmPrefs = loadLlmPrefs();
   private readonly llm = {
      mode: "cloud" as LlmMode,
      provider: "claude" as LlmProvider,
      model: "",
      reasoning: this.llmPrefs.reasoning ?? ("enabled" as Reasoning),
      effort: this.llmPrefs.effort ?? "medium",
      providers: { openai: false, claude: false, gemini: false } as Record<LlmProvider, boolean>
   };
   private readonly cloudModels: Record<LlmProvider, string[]> = {
      openai: [],
      claude: [],
      gemini: []
   };
   private localModels: string[] = [];
   private isPrivate = false;
   private readonly llmListeners: Array<() => void> = [];
   private readonly seenUnhandled = new Set<string>();

   /* Bind the sinks. Does NOT connect — the user drives that from the login
      panel via connect(), so credentials never live in the composition root. */
   start(sinks: IngestSinks): void {
      this.sinks = sinks;
      /* TTS playback drives the reactor's bar ring with DAWN's real voice. */
      this.tts = new TtsPlayback({ onLevels: (bins) => this.sinks.reactor.setLevels(bins) });
      /* Surface a fatal music-audio problem (e.g. no secure context) in the player. */
      this.music.setErrorHandler((msg) => this.sinks.music.setError(msg));
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
         /* Resume the stored session if we have one, else start a fresh session.
            Resuming is what keeps us from burning a session slot on every reload.
            We advertise only `pcm`, so DAWN sends raw PCM TTS (no Opus decoder). */
         const caps = { capabilities: { audio_codecs: ["pcm"] }, tts_enabled: this.ttsEnabled };
         const token = localStorage.getItem(TOKEN_KEY);
         if (token) this.send({ type: "reconnect", payload: { token, ...caps } });
         else this.send({ type: "init", payload: caps });
         /* Ask for the configured ai_name so the reply header reads "Friday", not
            a generic label. Read-only request; ignored gracefully if refused. */
         ws.send(JSON.stringify({ type: "get_config" }));
         /* The user's timezone, so the clock shows their local time (the box running
            Chrome may be UTC). */
         ws.send(JSON.stringify({ type: "get_my_settings" }));
         /* Local model list for the MODEL panel (cloud lists come from get_config). */
         ws.send(JSON.stringify({ type: "list_llm_models" }));
         /* Load the most recent conversation as a starting point (and into the
            session context, so continuing the chat continues it). Jobs are already
            hidden from this list server-side. Temporary default until we add a
            picker. */
         ws.send(JSON.stringify({ type: "list_conversations", payload: { limit: 15, offset: 0 } }));
         /* The caller's active background jobs, for the jobs panel. */
         ws.send(JSON.stringify({ type: "jobs_request" }));
         /* Subscribe to music: replies with the current music_state and, once a
            track is playing, streams Opus audio as 0x20 binary frames. Subscribe
            alone starts no audio. */
         ws.send(JSON.stringify({ type: "music_subscribe", payload: { quality: "standard" } }));
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
         if (ev.data instanceof ArrayBuffer) this.onBinary(ev.data);
         else if (typeof ev.data === "string") this.onFrame(ev.data);
      };

      ws.onclose = (ev: CloseEvent): void => {
         this.ws = null;
         this.stopMetrics();
         this.closeMusicStream();
         this.sinks.reactor.setState("idle");
         this.emit(this.wantConnected ? "error" : "disconnected", ev.reason || undefined);
      };

      ws.onerror = (): void => {
         /* onclose fires right after with the detail; keep the status honest. */
         this.emit("error", "WebSocket error");
      };
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
               The token also authenticates the dedicated music stream socket, so
               (re)open it here where we have a fresh one. */
            if (typeof p.token === "string") {
               localStorage.setItem(TOKEN_KEY, p.token);
               this.musicWsFails = 0;
               this.openMusicStream(p.token);
            }
            break;

         case "config":
         case "server_features":
            /* Handshake acknowledgements; nothing to render yet. */
            break;

         case "force_logout":
            /* Session revoked server-side: the stored token is dead, drop it so we
               do not keep trying to resume a session that no longer exists. */
            localStorage.removeItem(TOKEN_KEY);
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
                  };
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
            }
            /* Reasoning/effort: DAWN does not report the session's values (absent
               from llm_runtime), so seed from the config default ONLY when the user
               has not chosen their own. A persisted choice wins and is re-asserted
               below so the session matches. Legacy "auto" folds into "enabled". */
            if (!this.hasLlmPrefs()) {
               const t = cfg.llm?.thinking;
               if (t?.mode) this.llm.reasoning = t.mode === "disabled" ? "disabled" : "enabled";
               if (t?.reasoning_effort) this.llm.effort = t.reasoning_effort;
            }
            /* CURRENT session state: llm_runtime (payload level, resolved for this
               session) — the reliable source, since llm_state_update only fires on a
               switch_llm tool call, never on connect. Provider is capitalized here. */
            const rt = (p.llm_runtime ?? {}) as {
               type?: string;
               provider?: string;
               model?: string;
               openai_available?: boolean;
               claude_available?: boolean;
               gemini_available?: boolean;
            };
            if (rt.type) this.llm.mode = rt.type === "local" ? "local" : "cloud";
            const prov = (rt.provider ?? "").toLowerCase();
            if (prov === "openai" || prov === "claude" || prov === "gemini") this.llm.provider = prov;
            if (rt.model) this.llm.model = rt.model;
            if (rt.openai_available !== undefined) {
               this.llm.providers = {
                  openai: rt.openai_available === true,
                  claude: rt.claude_available === true,
                  gemini: rt.gemini_available === true
               };
            }
            this.notifyLlm();
            /* Make the session match the persisted reasoning/effort (see below). */
            this.reassertLlmPrefs();
            break;
         }

         case "list_llm_models_response": {
            const models = (p.models ?? []) as Array<{ name?: string }>;
            this.localModels = models.map((m) => m.name ?? "").filter(Boolean);
            this.notifyLlm();
            break;
         }

         case "get_my_settings_response": {
            const tz = (p as { timezone?: string }).timezone;
            if (tz) this.sinks.telemetry.setTimezone(tz);
            break;
         }

         case "list_conversations_response": {
            /* Pick the most recently updated conversation and load it. Once only,
               so a later manual reload is not clobbered. */
            if (this.loadedInitial) break;
            const convs = (p.conversations ?? []) as Array<{
               id: number;
               title?: string;
               updated_at?: number;
               created_at?: number;
               is_archived?: boolean;
               origin?: string;
            }>;
            if (convs.length === 0) break;
            /* Only interactive human conversations. `messaging:*` (SMS/Telegram)
               and `briefing` (automated digests) carry the freshest updated_at but
               are not what "my last conversation" means; jobs are already excluded
               server-side. Fall back to the whole list if none match. */
            const INTERACTIVE = new Set(["webui", "voice"]);
            const pool = convs.filter((c) => INTERACTIVE.has(c.origin ?? ""));
            const sorted = [...(pool.length ? pool : convs)].sort(
               (a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)
            );
            const pick = sorted[0];
            this.loadedInitial = true;
            this.convId = pick.id; // new turns persist to (and continue) this one
            this.send({ type: "load_conversation", payload: { conversation_id: pick.id } });
            break;
         }

         case "load_conversation_response": {
            const msgs = (p.messages ?? []) as Array<{ role: string; content: string }>;
            this.sinks.conversation.loadHistory(
               msgs
                  .filter((m) => m.role === "user" || m.role === "assistant")
                  .map((m) => ({ role: m.role as "user" | "assistant", text: m.content }))
            );
            break;
         }

         case "conversation_reset":
            /* A tool (reset_conversation / "start a new conversation") cleared the
               context. Empty the surface and drop our active conversation so the
               NEXT message opens a fresh one (mirrors the old WebUI's startNewChat),
               preserving the previous conversation instead of appending to it. */
            this.sinks.conversation.clear();
            this.convId = 0;
            break;

         case "new_conversation_response":
            /* The fresh conversation the daemon just created — persist to it now. */
            this.convId = Number((p as { conversation_id?: number }).conversation_id ?? 0);
            break;

         case "state": {
            const st = String(p.state ?? "idle");
            const detail = typeof p.detail === "string" ? p.detail : undefined;
            this.sinks.reactor.setState(toReactorState(st));
            this.sinks.conversation.setThinking(st === "thinking" || st === "summarizing");
            this.sinks.conversation.setStatus(this.activityFor(st, detail, p.tools));
            /* Turn complete: persist the final answer once (the last stream's text).
               Tool-iteration rows are saved server-side; we own the final answer. */
            if (st === "idle" && this.replyBuf.trim()) {
               this.saveMessage("assistant", this.replyBuf);
               this.replyBuf = "";
            }
            break;
         }

         case "error": {
            /* DAWN sends purely informational notices as `error` frames too (e.g.
               INFO_THINKING_DISABLED, "start a new conversation to use thinking"),
               and hardcodes recoverable:true on every error frame — so the `INFO_`
               code prefix is the only signal. Don't paint the reactor red for those. */
            const code = typeof p.code === "string" ? p.code : "";
            if (code.startsWith("INFO_")) {
               console.info("[dawn] notice:", code, p.message);
            } else {
               this.sinks.reactor.setState("error");
               console.warn("[dawn] error frame:", code, p.message);
            }
            break;
         }

         case "music_state":
            this.sinks.music.setState(toMusicState(p));
            break;

         case "music_position":
            this.sinks.music.setPosition(Number(p.position_sec ?? 0), Number(p.duration_sec ?? 0));
            break;

         case "music_error":
            this.sinks.music.setError(String(p.message ?? p.code ?? "Music error"));
            console.warn("[dawn] music_error:", p.code, p.message);
            break;

         case "jobs_snapshot": {
            /* The complete active set — replace ours wholesale. */
            this.jobs.clear();
            for (const j of (p.jobs ?? []) as JobRow[]) this.trackJob(j);
            this.renderJobs();
            break;
         }

         case "job_update": {
            /* One job's transition. Upsert by id, drop on any terminal status. A
               newly-appearing active job gets a brief foreground notice, since the
               dock-rail panel itself is exempt from the spike choreography. */
            const job = (p.job ?? {}) as JobRow;
            const wasActive = job.conversation_id != null && this.jobs.has(job.conversation_id);
            this.trackJob(job);
            const nowActive = job.conversation_id != null && this.jobs.has(job.conversation_id);
            if (!wasActive && nowActive) {
               this.spikeNotice("job-notice", "jobs", `Started: ${job.title || "background job"}`, {
                  to: IMPORTANCE.notice,
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
               to: IMPORTANCE.notice,
               x: 0.6,
               y: -0.4
            });
            break;

         case "attention_alert": {
            /* SAGE proactive attention — the signature ambient spike. level=alert
               needs the user (warm + claims the front); level=ambient is an FYI. */
            const alert = String(p.level ?? "ambient") === "alert";
            this.spikeNotice("attention", "attention", String(p.summary ?? ""), {
               to: alert ? IMPORTANCE.alert : IMPORTANCE.notice,
               tone: alert ? "attention" : "nominal",
               hold: alert ? 9 : 6,
               x: -0.62,
               y: -0.42
            });
            break;
         }

         case "silent_observation":
            /* A quieter noticed-something FYI, categorized (calendar/email/…). */
            this.spikeNotice("observation", String(p.category ?? "note"), String(p.note ?? ""), {
               to: IMPORTANCE.notice,
               hold: 5,
               x: -0.62,
               y: 0.42
            });
            break;

         case "scheduler_notification": {
            /* Alarms/timers/reminders. Surface an actively firing one; a ringing
               alarm keeps its event id so a dismiss can silence it on DAWN. Any
               other status (dismissed/snoozed/cancelled, incl. from another client)
               clears our notice. */
            const status = String(p.status ?? "");
            if (status === "ringing" || status === "fired") {
               /* Only `ringing` needs a real dismiss; `fired` already auto-dismissed. */
               this.schedulerEventId = status === "ringing" ? Number(p.event_id ?? 0) : 0;
               this.spikeNotice("scheduler", String(p.event_type ?? "alarm"), String(p.name ?? "Alarm"), {
                  to: IMPORTANCE.alert,
                  tone: "attention",
                  hold: 10,
                  detail: String(p.message ?? ""),
                  x: 0.62,
                  y: 0.42
               });
            } else {
               this.schedulerEventId = 0;
               this.sinks.store.remove("scheduler");
            }
            break;
         }

         case "metrics_update": {
            /* token_rate -> throughput strain (gauge, live) AND an EMA for the HUD (a
               smooth figure that tracks recent generations, not the fluctuating
               instantaneous rate). Strain normalized against a brisk ~50 tok/s. */
            const rate = Number(p.token_rate ?? 0);
            this.sinks.reactor.setStrain(Math.min(rate / 50, 1));
            if (rate > 0) {
               this.rateEma =
                  this.rateEma > 0 ? this.rateEma + RATE_EMA_ALPHA * (rate - this.rateEma) : rate;
               localStorage.setItem(RATE_EMA_KEY, String(this.rateEma));
               this.sinks.telemetry.update({ rate: `${Math.round(this.rateEma)}/s` });
            }
            break;
         }

         case "context": {
            /* Context-window usage %, last known (pushed during turns). */
            const usage = Number((p as { usage?: number }).usage ?? 0);
            this.sinks.telemetry.update({ ctx: `${Math.round(usage)}%` });
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
            /* Reset per stream so replyBuf holds the LAST stream (the final answer)
               when the turn settles to idle. */
            this.replyBuf = "";
            this.sinks.conversation.startReply();
            break;

         case "stream_delta": {
            const delta = String(p.delta ?? "");
            this.replyBuf += delta;
            this.sinks.conversation.appendDelta(delta);
            break;
         }

         case "stream_end":
            this.sinks.conversation.endReply();
            break;

         case "transcript":
            /* DAWN smuggles llm_state_update inside a transcript with this role
               (webui_server.c). Intercept it — it is not a message. */
            if (p.role === "__llm_state__" && typeof p.text === "string") {
               this.applyLlmState(p.text);
               break;
            }
            /* A complete (non-streamed or replayed) message. Show assistant text;
               persist a live (non-replay) one, since it never went through a stream. */
            if (p.role === "assistant" && typeof p.text === "string") {
               this.sinks.conversation.showReply(p.text);
               if (p.replay !== true) this.saveMessage("assistant", p.text);
            }
            break;

         case "message_appended": {
            /* A server-persisted assistant message pushed live — chiefly a completed
               background job's answer, which otherwise never surfaces here (it reaches
               us as this frame, not a stream). Already saved server-side, so DISPLAY
               only. Skip our own active conversation's rows: those arrive via the
               stream path, and echoing them here would double them. */
            const mp = p as { conversation_id?: number; role?: string; text?: string };
            if (mp.conversation_id !== this.convId && mp.role === "assistant" && mp.text) {
               this.sinks.conversation.showReply(mp.text);
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
      this.sinks.conversation.clear();
   }

   /* Binary frame: a 1-byte opcode then payload. TTS chunks accumulate and the
      segment-end plays them; music frames stream straight into the Opus decoder. */
   private onBinary(buf: ArrayBuffer): void {
      const bytes = new Uint8Array(buf);
      if (bytes.length === 0) return;
      const op = bytes[0];
      if (op === BIN_AUDIO_OUT) this.tts.queue(bytes.subarray(1));
      else if (op === BIN_AUDIO_SEGMENT_END) this.tts.play();
      else if (op === BIN_MUSIC_DATA) void this.music.pushFrame(bytes.subarray(1));
   }

   /* Music transport: a music_control write (Tier C, a deliberate user action). */
   musicControl(action: string, params: Record<string, unknown> = {}): void {
      this.send({ type: "music_control", payload: { action, ...params } });
   }

   getMusicAudio(): MusicAudio {
      return this.music;
   }

   /* Open the dedicated dawn-music stream socket and authenticate it with the
      session token. Once DAWN sees it (set_stream_wsi), it sends music audio here
      instead of on the main socket, keeping high-bandwidth audio off the control
      channel (the main socket drops music frames under backpressure). Frames use the
      same [0x20][uint16-LE len][opus] framing. Purely an enhancement: if this never
      attaches, audio keeps flowing on the main socket. */
   private openMusicStream(token: string): void {
      if (!this.wantConnected || !token) return;
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
            /* Same framing as the main socket, opcode-prefixed. */
            void this.music.pushFrame(bytes[0] === BIN_MUSIC_DATA ? bytes.subarray(1) : bytes);
            return;
         }
         try {
            const m = JSON.parse(String(ev.data)) as { type?: string; reason?: string };
            if (m.type === "auth_ok") {
               this.musicWsFails = 0; // attached; audio now streams here
               /* Debug, not info: an idle socket idle-times-out and reconnects to
                  stay ready, so at info level this would spam every ~30s when nothing
                  is playing. Playback keeps the socket alive (verified: stable). */
               console.debug("[dawn] music stream attached (dedicated socket)");
            } else if (m.type === "auth_failed") {
               console.warn("[dawn] music stream auth failed:", m.reason);
               this.closeMusicStream(); // fall back to the main socket
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
      if (!this.wantConnected || this.musicWsFails >= MUSIC_WS_MAX_FAILS) return;
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token) return;
      this.musicWsFails++;
      const delay = Math.min(15000, 1000 * 2 ** (this.musicWsFails - 1));
      window.clearTimeout(this.musicWsTimer);
      this.musicWsTimer = window.setTimeout(() => this.openMusicStream(token), delay);
   }

   private closeMusicStream(): void {
      window.clearTimeout(this.musicWsTimer);
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
      const update: Record<string, string> = { effort };
      if (this.llm.model) update.model = this.llm.model;
      this.sinks.telemetry.update(update);
      for (const cb of this.llmListeners) cb();
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
      if (typeof pl.provider === "string") this.llm.provider = pl.provider as LlmProvider;
      if (typeof pl.model === "string") this.llm.model = pl.model;
      this.llm.providers = {
         openai: pl.openai_available === true,
         claude: pl.claude_available === true,
         gemini: pl.gemini_available === true
      };
      this.notifyLlm();
   }

   /* Send a session-only LLM change, then reflect it optimistically. */
   private applyLlm(fields: Record<string, string>): void {
      this.send({ type: "set_session_llm", payload: fields });
      this.notifyLlm();
   }

   /* Reasoning/effort persistence. DAWN cannot report the session's values back, so
      we remember the user's explicit choice and re-apply it on connect. */
   private hasLlmPrefs(): boolean {
      return localStorage.getItem(LLM_PREFS_KEY) !== null;
   }
   private persistLlmPrefs(): void {
      localStorage.setItem(
         LLM_PREFS_KEY,
         JSON.stringify({ reasoning: this.llm.reasoning, effort: this.llm.effort })
      );
   }
   /* Push the persisted reasoning/effort to the session on (re)connect so a recycled
      session (or a fresh one) matches what the UI shows. No-op until the user has
      chosen a value, so it adds no write for a default setup. */
   private reassertLlmPrefs(): void {
      if (!this.hasLlmPrefs()) return;
      this.send({
         type: "set_session_llm",
         payload: { thinking_mode: this.llm.reasoning, reasoning_effort: this.llm.effort }
      });
   }

   private modelsFor(mode: LlmMode, provider: LlmProvider): string[] {
      return mode === "local" ? this.localModels : this.cloudModels[provider];
   }

   /* If the current model is not in the active list, switch to the first one. */
   private reconcileModel(): void {
      const models = this.modelsFor(this.llm.mode, this.llm.provider);
      if (models.length > 0 && !models.includes(this.llm.model)) {
         this.llm.model = models[0];
         this.send({ type: "set_session_llm", payload: { model: this.llm.model } });
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
            this.applyLlm({ provider });
            this.reconcileModel();
         },
         setModel: (model) => {
            this.llm.model = model;
            this.applyLlm({ model });
         },
         setReasoning: (reasoning) => {
            this.llm.reasoning = reasoning;
            this.persistLlmPrefs();
            this.applyLlm({ thinking_mode: reasoning });
         },
         setEffort: (effort) => {
            this.llm.effort = effort;
            this.persistLlmPrefs();
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
         }
      };
   }

   /* TTS on/off. Persisted; toggling live tells DAWN (set_tts_enabled) and stops any
      audio in flight. The value also rides the next init/reconnect handshake. */
   isTtsEnabled(): boolean {
      return this.ttsEnabled;
   }

   setTtsEnabled(on: boolean): void {
      this.ttsEnabled = on;
      localStorage.setItem(TTS_KEY, on ? "true" : "false");
      this.send({ type: "set_tts_enabled", payload: { enabled: on } });
      if (!on) this.tts.stop();
   }

   /* User typed a message. This DOES drive a real DAWN turn (costs budget); it is
      the one intentional user-initiated action on an otherwise read-only client. */
   submit(text: string): void {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      /* No active conversation (fresh start after a reset): open one BEFORE the text
         so the daemon tags this turn with the new id and preserves the old thread.
         new_conversation_response sets convId for the assistant-save. */
      if (this.convId === 0) {
         this.send({
            type: "new_conversation",
            payload: { save_current: true, title: text.slice(0, 48) }
         });
      }
      /* Do NOT persist the user turn here. With an active conversation the daemon
         persists the user message itself (text_input_dispatch.c: conv_db_add on
         conversation_id > 0); saving it again produced double user rows. We only own
         the FINAL ANSWER, saved on the idle transition. */
      this.send({ type: "text", payload: { text } });
      this.sinks.conversation.setThinking(true);
   }

   /* A dismissed notice: for a ringing alarm, tell DAWN to actually stop it
      (scheduler_action{dismiss}); other notices are cleared locally by the store. */
   dismiss(id: string): void {
      if (id === "scheduler" && this.schedulerEventId > 0) {
         this.send({
            type: "scheduler_action",
            payload: { action: "dismiss", event_id: this.schedulerEventId }
         });
         this.schedulerEventId = 0;
      }
   }

   /* Focus/blur is a local UI cue only; the real reactor state comes from DAWN's
      `state` frames, so we tell the server nothing here. */
   setEngaged(_engaged: boolean): void {}

   disconnect(): void {
      this.wantConnected = false;
      this.stopMetrics();
      this.closeMusicStream();
      this.tts?.stop();
      this.ws?.close();
      this.ws = null;
      this.emit("disconnected");
   }

   stop(): void {
      this.disconnect();
   }

   /* The login panel subscribes to reflect connection state. */
   onStatus(handler: StatusHandler): void {
      this.status = handler;
   }

   private emit(status: LinkStatus, detail?: string): void {
      this.status(status, detail);
   }

   private send(msg: object): void {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
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
   }

   /* A transient, dismissable notice that spikes forward then recedes on its own.
      Fixed id per channel so a newer notice replaces the older. */
   private spikeNotice(
      id: string,
      kind: string,
      summary: string,
      opts: { to: number; x: number; y: number; tone?: "nominal" | "attention"; hold?: number; detail?: string }
   ): void {
      this.sinks.store.upsert({
         id,
         kind,
         summary,
         detail: opts.detail,
         restImportance: IMPORTANCE.invisible,
         position: { x: opts.x, y: opts.y },
         tone: opts.tone ?? "nominal",
         dismissable: true
      });
      this.sinks.store.spike(id, opts.to, opts.tone ?? "nominal", opts.hold ?? 6);
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

   /* Reflect the active set into the jobs panel: a pinned right-rail card listing
      running jobs. When none are active the panel leaves the dashboard entirely. */
   private renderJobs(): void {
      const count = this.jobs.size;
      if (count === 0) {
         this.sinks.store.remove("jobs");
         return;
      }
      const items = [...this.jobs.values()].map((j) => `${j.running ? "▹" : "·"} ${j.title}`);
      this.sinks.store.upsert({
         id: "jobs",
         kind: "jobs",
         summary: `${count} active job${count > 1 ? "s" : ""}`,
         items,
         pinned: true,
         dock: "right",
         dockOrder: 0,
         dockOnly: true,
         restImportance: IMPORTANCE.ambient,
         importance: IMPORTANCE.ambient,
         position: { x: 0, y: 0 },
         tone: "nominal"
      });
   }

   /* Persist a turn to the DB. DAWN keeps webui text turns in memory only — the
      client owns the user turn and the final answer rows (webui_history.c message-
      ownership map); without this our conversations never survive a reconnect. */
   private saveMessage(role: "user" | "assistant", content: string): void {
      if (this.convId > 0 && content.trim()) {
         this.send({ type: "save_message", payload: { conversation_id: this.convId, role, content } });
      }
   }
}
