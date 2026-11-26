/*
 * DawnIngest: the REAL DAWN source. The one file that replaces StubIngest to go
 * from fake data to live. It implements the same `Ingest` interface, writing to
 * the same four sinks, so nothing above this boundary changes (brief S7.4).
 *
 * Two responsibilities:
 *   1. Auth + transport - log in over /api/auth, open the /ws WebSocket with the
 *      mandatory `dawn-1.0` subprotocol, own its lifecycle.
 *   2. Frame routing - translate DAWN's { type, payload } frames into sink calls.
 *
 * SCOPE (slice 1): connection + auth + the reactor's state machine + live reply
 * streaming + a connection status readout. Every frame we do not yet consume is
 * logged once (see UNHANDLED) so the real traffic tells us what to wire next.
 * Panels (attention/scheduler/jobs/music/HA) are later slices.
 *
 * WRITES: everything this client sends that changes DAWN starts from a deliberate user
 * gesture (a typed message, a panel action, a confirm). A received frame may complete or
 * restore what the user already chose (a preference re-sent after a reconnect, a deferred
 * setting, the re-anchor), never start a new action. DAWN's permissions decide what it may
 * do (CLAUDE.md, "Parity with DAWN's WebUI").
 * Focus/blur (setEngaged) tells DAWN nothing - our reactor reflects DAWN's actual
 * state, never our input focus.
 *
 * Protocol reference: dawn/docs/WEBSOCKET_PROTOCOL.md
 * Consumer map:       docs/DAWN_UI_SIGNAL_MAP.md
 */

import { LocalUserPrefs, type UserPrefs } from "./prefs.ts";
import type {
   ActivityStatus,
   LinkStatus,
   HAServiceCall,
   Ingest,
   IngestSinks,
   NoticeAction,
   NoticeOpen,
   OutDocument,
   OutImage,
   ConversationItem,
   TurnWait,
   UploadedDoc,
   UploadedImage,
   WatchFields
} from "./ingest.ts";
import { TtsPlayback } from "../audio/tts.ts";
import type { MusicAudio } from "../audio/music.ts";
import type { MicControl } from "../audio/mic.ts";
import { AlarmChime } from "../audio/alarm-chime.ts";
import { collectToolNotes } from "./tool-notes.ts";
import type { EmailRef, EmailSource } from "./email.ts";
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
import type { ModelControl } from "../model/model.ts";
import { str } from "./wire.ts";
import { MemoryFeed } from "./memory-feed.ts";
import { HAFeed } from "./ha-feed.ts";
import { WatchesFeed } from "./watches-feed.ts";
import { StocksFeed } from "./stocks-feed.ts";
import { CalendarFeed } from "./calendar-feed.ts";
import { LibraryFeed } from "./library-feed.ts";
import { AlarmsFeed } from "./alarms-feed.ts";
import { JobsFeed } from "./jobs-feed.ts";
import { AttentionFeed } from "./attention-feed.ts";
import { MusicFeed } from "./music-feed.ts";
import { ModelFeed } from "./model-feed.ts";
import { VoiceInput } from "./voice-input.ts";
import { CONV_PAGE, ConversationListFeed } from "./conversation-list-feed.ts";
import { safeTimeZone } from "../util/tz.ts";
import { CLIENT_PROTOCOL } from "./contract.ts";
import { TelemetryFeed } from "./telemetry-feed.ts";
import { toActivity, toReactorState } from "./state-map.ts";
import {
   displayCut,
   interpretMessage,
   parseToolCalls,
   titleFromMessage,
   toEmailRef,
   type ReloadedToolResult
} from "./history-wire.ts";
import { toContextItem } from "./feeds-wire.ts";
import { formatCtx } from "./telemetry-format.ts";

/* Server -> client binary opcodes (webui_server.h). Every audio frame is a 1-byte
   type prefix then payload. TTS rides the MAIN socket; music rides ONLY the dedicated
   dawn-music socket (the legacy main-socket music path was removed server-side), but
   it still carries the 0x20 opcode there - the daemon prepends WS_BIN_MUSIC_DATA to
   every dedicated-socket frame, so the payload is [0x20][uint16-LE len][opus]. */
const TYPED_ECHO_TTL_MS = 15000; // window to match a typed turn's echo before it's stale
const BIN_AUDIO_OUT = 0x11; // a TTS PCM chunk
const BIN_AUDIO_SEGMENT_END = 0x12; // play the accumulated segment now
/* Cap the main-socket reconnect backoff (retries indefinitely): low, so the link is back within a
   few seconds of DAWN returning from a restart. One tab asking every few seconds is no load. */
const MAIN_WS_MAX_DELAY = 5000;
const LOGIN_WATCH_FAST_MS = 5000; // the login card re-checks the cookie this often for a minute...
const LOGIN_WATCH_FAST_CHECKS = 12;
const LOGIN_WATCH_SLOW_MS = 30000; // ...then this often
const AUTH_STATUS_TIMEOUT_MS = 5000; // a /api/auth/status that takes longer counts as unreachable
const RESUME_QUIET_TRIES = 14; // ~1 minute of page-load retries (1+2+4 s, then 5 s each) before the card says DAWN can't be reached
const REVOKE_RECHECKS = 3; // a "not logged in" answer to an UNAUTHORIZED is asked again this many times...
const REVOKE_RECHECK_MS = 3000; // ...this far apart, before signing out
const UNCONFIRMED_REVOKE_MAX = 3; // reconnects on an UNAUTHORIZED auth status didn't confirm, before signing out
/* A connection must stay up this long before the backoff resets: one that dies right after opening
   (e.g. a frame the browser refuses, which fails the socket) otherwise reconnects every second forever. */
const MAIN_WS_STABLE_MS = 10_000;
/* Message-type prefixes of OPTIONAL subsystems (built out of some DAWNs): an UNKNOWN_TYPE for one of
   these is quiet (the request fails fast and that type stops being sent for the connection). */
const OPTIONAL_PREFIXES = [
   "ha_",
   "calendar_",
   "stocks_",
   "email_",
   "phone_",
   "watch_",
   "doc_library_"
];

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
const CONV_KEY = "dawn.hero.convId"; // the conversation to reopen on next load (resume where you left off)
const REANCHOR_FALLBACK_MS = 3000; // no set_active_conversation_response in this long -> older DAWN, fall back to load_conversation

const TTS_KEY = "dawn.hero.tts"; // persisted TTS on/off
const ALARM_SOUNDS_KEY = "dawn.hero.alarmSounds"; // persisted "Alarm sounds" (chime/loop) on/off
const KEEPALIVE_KEY = "dawn.hero.sessionKeepalive"; // persisted "Always on (this browser)" session keepalive
/* Why a load_conversation went out: an open the user made, the boot resume, a reconnect's
   restore of the conversation on screen (no redraw), or a reload that redraws it (a reclaim). */
type LoadPurpose = "user" | "resume" | "reanchor" | "reload";

/* How long a stopped turn's leftover frames may be dropped at most (a safety net: DAWN always ends
   the turn with its tagged idle). */
const STOP_DRAIN_MAX_MS = 180_000;
/* When to offer to stop the other reply, if DAWN's turn_waiting doesn't say (stop_after_ms). */
const TURN_WAIT_STOP_AFTER_MS = 5000;
const TURN_WAIT_STOP_AFTER_MAX_MS = 600_000;

type StatusHandler = (status: LinkStatus, detail?: string) => void;

/* Persisted so a reload/reconnect RESUMES the same DAWN session instead of
   minting a new one each time. Without this, every connect burns a session slot
   and the daemon hits its per-user cap ("Max sessions reached"). */
const TOKEN_KEY = "dawn.hero.sessionToken";

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
   private dawnVersion = ""; // daemon version if a frame advertises it (feature-detected; else "")
   private lastStatus: LinkStatus = "disconnected"; // last emitted status, for the Connection dialog
   private lastDetail = "";
   private status: StatusHandler = () => {};
   private wantConnected = false; // did the user ask to be connected (vs a drop)
   private wsReconnectTimer = 0; // scheduled main-socket reconnect after an unexpected drop
   private checkingAuth = false; // an UNAUTHORIZED is being confirmed against /api/auth/status
   private unconfirmedRevokes = 0; // UNAUTHORIZEDs auth status didn't confirm, since DAWN last accepted the login (a pong)
   private loginWatchTimer = 0; // the login card's periodic "logged in after all?" check
   private resumeFails = 0; // page-load resume attempts that couldn't reach DAWN (backoff)
   private wsFails = 0; // consecutive main-socket reconnect attempts (drives the backoff)
   private wsStableTimer = 0; // resets wsFails once the current connection has stayed up
   private loadedInitial = false; // guard: load the starting conversation only once
   private resumingStored = false; // the initial load is a resume of the persisted convId (fall back silently on failure)
   /* The DAWN session this connection is on (the session frame's session_id), when it says. */
   private sessionId: number | undefined;
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
   /* The conversation picker's list: conversation-list-feed.ts. */
   private readonly conversationListFeed = new ConversationListFeed(
      (msg) => this.send(msg),
      () => this.sinks,
      () => this.convId
   );
   private pendingDeleteId = 0; // a conversation delete awaiting its (id-less) response
   private convId = 0; // the active conversation id (turns are tagged to it; DAWN persists them)
   /* Texts submitted from the composer, awaiting DAWN's user-transcript echo. DAWN echoes
      every user turn (typed AND voice); we append typed turns locally on submit, so these
      let us dedupe the echo of our own typing. What is left unmatched is spoken input. Each
      carries a timestamp so a stale entry (echo that never arrived) can't later swallow an
      identical spoken turn. */
   private readonly typedEchoes: Array<{ text: string; at: number; ref?: string }> = [];
   /* When a TURN_QUEUE_FULL arrived (its trailing PROCESSING_ERROR is swallowed). */
   private queueFullAt = 0;
   /* Client-side chime/loop for scheduled events (the daemon tone is daemon-local). Initial
      enabled state from the persisted "Alarm sounds" preference; the System-menu toggle flips it. */
   private readonly alarmChime = new AlarmChime(localStorage.getItem(ALARM_SOUNDS_KEY) !== "false");
   /* Phone calls (WebUI parity): the call card + ring tone; see phone-wire.ts. */
   private readonly phone = new PhoneCalls(
      (m) => this.send(m),
      () => this.sinks.notifications,
      this.alarmChime
   );
   /* Notices: ringing alarms, background jobs, SAGE attention. */
   private readonly alarmsFeed = new AlarmsFeed(
      (msg) => this.send(msg),
      () => this.sinks,
      (id, kind, summary, opts) => this.spikeNotice(id, kind, summary, opts),
      this.alarmChime
   );
   private readonly jobsFeed = new JobsFeed(
      (msg) => this.send(msg),
      () => this.sinks,
      (id, kind, summary, opts) => this.spikeNotice(id, kind, summary, opts)
   );
   private readonly attentionFeed = new AttentionFeed((id, kind, summary, opts) =>
      this.spikeNotice(id, kind, summary, opts)
   );
   /* The Calendar card's and the Library panel's feeds. */
   private readonly calendarFeed = new CalendarFeed(
      (msg) => this.send(msg),
      () => this.sinks,
      () => this.userTz
   );
   private readonly libraryFeed = new LibraryFeed(
      (msg) => this.send(msg),
      () => this.sinks,
      () => this.isLinkLive(),
      (path) => this.dawnUrl(path)
   );
   /* The Home Assistant, Watches and Stocks / Watchlist boards. */
   private readonly haFeed = new HAFeed(
      (msg) => this.send(msg),
      () => this.sinks,
      (id, kind, summary, opts) => this.spikeNotice(id, kind, summary, opts)
   );
   private readonly watchesFeed = new WatchesFeed(
      (msg) => this.send(msg),
      () => this.sinks,
      (id, kind, summary, opts) => this.spikeNotice(id, kind, summary, opts),
      () => this.isLinkLive(),
      (message) => this.notifyUser(message)
   );
   private readonly stocksFeed = new StocksFeed(
      (msg) => this.send(msg),
      () => this.sinks,
      (message) => this.notifyUser(message)
   );
   private zoneFromSession = false; // this DAWN names the zone on the session frame (get_my_settings's is then ignored)
   private userTz = ""; // user's IANA tz (from get_my_settings); "" => browser-local
   /* Created at construction (not in start) so its Opus-decode support is probed before
      the handshake advertises a codec, and so the reactor tap is wired once. onLevels
      references sinks, which start() sets before any audio can arrive. */
   private readonly tts = new TtsPlayback({
      onLevels: (bins) => this.sinks.reactor.setLevels(bins),
      /* Echo prevention for continuous listening: onActive tracks real TTS playback (the
         buffered tail included); updateMicMute combines it with DAWN's speaking state so the
         mic stays muted through the whole reply - sentence gaps and tail. No-op outside
         continuous mode, so PTT is unaffected. */
      onActive: (on: boolean) => {
         this.voiceInput.updateMicMute();
         if (!on && this.speechTail) {
            this.speechTail = false; // the reply's speech has played out
            if (!this.ownTurn) this.sinks.conversation.setTurnActive(false);
         }
      }
   });
   /* Music: the dedicated stream socket, the player's state and transport (music-feed.ts). */
   private readonly musicFeed = new MusicFeed(
      (msg) => this.send(msg),
      () => this.sinks,
      () => this.wantConnected,
      () => localStorage.getItem(TOKEN_KEY),
      (path) => this.dawnUrl(path)
   );
   /* Voice input: the mic, push-to-talk, continuous listening (voice-input.ts). */
   private readonly voiceInput = new VoiceInput({
      send: (msg) => this.send(msg),
      sendBinary: (bytes) => this.sendBinary(bytes),
      sinks: () => this.sinks,
      ws: () => this.ws,
      capsSynced: () => this.capsSynced,
      wantConnected: () => this.wantConnected,
      dawnSpeaking: () => this.dawnSpeaking,
      tts: () => this.tts
   });
   /* True once DAWN has processed our init/reconnect (the `session` frame confirms it), so
      use_opus is set and it is safe to ship Opus. Reset on close: after a drop, Opus sent
      before the new session frame would be decoded as PCM (garbage). */
   private capsSynced = false;
   private dawnSpeaking = false; // DAWN's `state` is "speaking" (persists across TTS sentence gaps)
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
   /* The HUD's telemetry rows (token rate, cache, context, TTFT / latency, uptime) and the
      reactor's strain / hesitation gauges. */
   private readonly telemetryFeed = new TelemetryFeed(
      (msg) => this.send(msg),
      () => this.sinks,
      () => this.modelFeed.llm
   );
   /* Tool-use latch. DAWN pings `tool_call` then flips straight back to `thinking`
      while the tool runs and its results are processed, so the tool_call state alone
      flickers past unseen. We latch "using tools" from the ping until the turn leaves
      the thinking phase (speaking/idle/etc), so even a fast tool call stays visible. */
   private toolActive = false;
   private toolName: string | undefined;
   /* The model selection (the MODEL panel and the HUD's model rows): model-feed.ts. */
   private readonly modelFeed = new ModelFeed({
      send: (msg) => this.send(msg),
      sinks: () => this.sinks,
      spikeNotice: (id, kind, summary, opts) => this.spikeNotice(id, kind, summary, opts),
      getRev: () => this.llmRev,
      setRev: (v) => (this.llmRev = v),
      getNeedsRead: () => this.llmNeedsRead,
      setNeedsRead: (v) => (this.llmNeedsRead = v),
      getPrivate: () => this.isPrivate,
      setPrivate: (v) => (this.isPrivate = v),
      convId: () => this.convId,
      askConfig: (listsOnly) => this.askConfig(listsOnly),
      requestConfigRefresh: () => this.requestConfigRefresh(),
      selectionSettled: () => this.selectionSettled()
   });
   /* Set while a MODEL-panel-open refresh get_config is in flight: the response updates the
      model lists + provider availability, but must NOT re-apply the session's llm_runtime
      selection (mode/provider/model/reasoning) - that would revert a loaded conversation's
      provider back to the session default, since DAWN does not switch the session LLM on a
      conversation load (applyConvLlmSettings owns that, client-side). */
   /* The model selection's revision: bumped by everything that changes it (a set_session_llm
      sent, DAWN's tool switching the model, a conversation's settings, New Chat). Each get_config
      asked records the revision and its purpose (replies come in order). A reply asked at an
      older revision is an older snapshot, and a lists-only one (a config edit, the MODEL panel
      opening) never touches the selection: either way it updates only the lists and
      availability. */
   private llmRev = 0;
   private configAsks: Array<{ rev: number; listsOnly: boolean; req?: string }> = [];
   /* The revision each set_session_llm sent created, oldest first (replies come in order). A
      reply may change the selection, its reasoning or a pending switch only while its write's
      revision is still current: a later write, a conversation load, DAWN's tool switching the
      model or New Chat (each bumps llmRev) makes it an older reply that would undo newer state. */
   private llmWritesOwed: Array<{ rev: number; req?: string; chosen?: boolean }> = [];
   /* load_conversation requests still waiting for their reply, oldest first (DAWN answers in
      order): each sets the session's LLM to that conversation's settings when DAWN handles it.
      One the user opened records the conversation that was open before (`back`): a refused load
      (the conversation deleted meanwhile) returns to it, as DAWN's session never left it. */
   private convLoadsOwed: Array<{
      id: number;
      back?: number;
      req?: string;
      /* Why it was sent, so a refused one can be sent again the same way (see loadRetry). */
      purpose?: LoadPurpose;
      /* Refused, going back must also restore that conversation's server context (a reconnect's
         replay of an interrupted open; see loadRestores). */
      restore?: boolean;
      /* A refused load this open set aside (retrySetAside): refused too, it's put back. */
      retry?: { id: number; purpose: LoadPurpose };
      /* A model change to send once this load's reply has been applied (choiceAfterRetry). */
      then?: Record<string, unknown>;
   }> = [];
   /* With request_refs (DAWN #116) each get_config, set_session_llm and load_conversation carries
      a `req` (the flags arrive with the config frame, so a connection's first requests don't):
      a reply that names one settles that request, and an error that names one is its refusal
      (settleModelRefusal). One without settles the oldest sent without one (DAWN answers in
      order). */
   private llmReqSeq = 0;
   /* The purpose of the get_config being sent (askConfig; taken by send). */
   private askListsOnly = false;
   /* A model change was refused and the selection shown may never have run: read the session's
      selection until a read is answered (see onPong). */
   private llmNeedsRead = false;
   /* A resume, re-anchor or reload DAWN refused while it couldn't check the login: sent again,
      the same way, once DAWN answers a ping. */
   private loadRetry: { id: number; purpose: LoadPurpose } | null = null;
   /* A model change the user made while a refused load waits to resend: with no conversation
      attached DAWN doesn't save it, and the load would put the conversation's own model back, so
      it goes again right after that load (DAWN answers in order). */
   private choiceAfterRetry: Record<string, unknown> | null = null;
   /* The refused load an open of the user's set aside (taken by send onto the open's entry): if
      the open is refused too, it waits to resend again. */
   private retrySetAside: { id: number; purpose: LoadPurpose } | null = null;
   /* The choice the load being sent carries (taken by send). */
   private loadThen: Record<string, unknown> | null = null;
   /* The load being sent replays an open a link loss interrupted: refused, it returns to the
      conversation on screen AND restores that one's server context (the new session may not hold
      it). Set by the session handler, taken by send. */
   private loadRestores = false;
   /* The conversation a user-opened load returns to if refused (set by loadConversation, taken
      by send). */
   private loadBack: number | undefined;
   /* The conversation whose transcript is drawn (0: a fresh chat). The active id can run ahead of
      it (an open still loading); a reconnect then must load it in full, not just re-anchor. */
   private drawnConvId = 0;
   /* The Learned list (memory_batches), its marks in the conversation on screen, and the
      Context panel's memory deletes. */
   private readonly memoryFeed = new MemoryFeed(
      (msg) => this.send(msg),
      (flag) => this.hasFeature(flag),
      () => this.sinks,
      (id, kind, summary, opts) => this.spikeNotice(id, kind, summary, opts)
   );
   /* When the last error line was shown, to drop DAWN's generic "Failed to get response"
      LLM_ERROR that trails a specific error for the same failed turn (see the error case). */
   private lastErrorAt = 0;
   private pendingNewConvTitle = ""; // title derived from the first message, applied on new_conversation_response
   private isPrivate = false;
   /* A private-first new conversation waiting for DAWN to confirm it (newConversation). */
   private privateCreate: {
      resolve: (ok: boolean) => void;
      timer: number;
      promise: Promise<boolean>;
   } | null = null;
   private discardNextCreate = false;
   /* The conversation a tool reset just left, whose in-flight reply still renders here until
      that turn goes idle (see conversation_reset); 0 = none. */
   private resetTurnConv = 0;
   private lastState = "idle"; // last applied DAWN machine state (settleTurnOnSwitch)
   /* Stop. DAWN acks a cancel at once (an untagged `idle` written straight to the socket), AHEAD of
      what the stopped turn had already queued (text, speech, tool steps, states), so the ack ends
      nothing. The turn's own end is its worker's conversation-tagged `idle` (DAWN's cancel exit),
      (untagged when the stop came before DAWN created a fresh chat's conversation: then it is the
      second idle), and DAWN starts no other turn of this session before it, so everything between belongs to the
      stopped turn and is dropped. `afterReply`: the reply had finished (only its speech was
      left), so nothing is marked stopped and DAWN keeps the reply. */
   private stopped: {
      afterReply: boolean;
      timer: number;
      idles: number;
      conv: number;
      /* DAWN said it will save the stopped reply (will_persist): its row comes to redraw it. */
      saving: boolean;
   } | null = null;
   private ownTurn = false; // this session's own turn is running (it saw `thinking`): Stop applies
   private liveStreamId = 0; // the reply streaming now (stream_start), 0 between replies
   private replyEnded = false; // this turn's reply finished (terminal stream_end); speech may remain
   /* This session's turn waiting for another on the same conversation (turn_wait), and that
      conversation: shown on the held bubble, with the offer to stop the other reply. */
   private turnWait: (TurnWait & { conversationId: number }) | null = null;
   /* The same wait kept across a link loss: DAWN keeps the turn waiting but doesn't say so again
      after a reconnect, so a reconnect to the same session shows it again (and its draft is kept). */
   private keptWait: (TurnWait & { conversationId: number }) | null = null;
   /* This session's speech still playing after its turn ended: Stop stops it here. */
   private speechTail = false;
   /* A stopped reply DAWN saves in the conversation a reset tool left: its row may still redraw
      the bubble on screen. */
   private stoppedSave: { conv: number; streamId: number } | null = null;
   /* A waiting turn the user took back (Stop / Esc): its turn_unsent comes back quietly, since the
      user asked for it. The ref, or "" for a voice turn. */
   private unsentAsked: string | null = null;
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
   private readonly email = new DawnEmail(
      (m) => this.send(m),
      (type) => this.unsupportedTypes.has(type)
   );
   private readonly prefs = new LocalUserPrefs();
   private readonly unsupportedTypes = new Set<string>(); // types this connection's DAWN said it doesn't handle
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
   private readonly seenUnhandled = new Set<string>();

   /* Bind the sinks. Does NOT connect - the user drives that from the login
      panel via connect(), so credentials never live in the composition root. */
   start(sinks: IngestSinks): void {
      this.sinks = sinks;
      window.addEventListener("storage", this.onStorage);
      this.musicFeed.start();
      this.telemetryFeed.showRate();
      /* Stay silent until tryResume() decides - so a successful auto-resume never
         flashes the login card. */
      this.emit("checking");
   }

   /* The login panel calls this. Runs the documented cookie-auth flow, then opens
      the socket. Throws on auth failure so the panel can show the reason. */
   async connect(username: string, password: string): Promise<void> {
      window.clearTimeout(this.loginWatchTimer);
      window.clearTimeout(this.wsReconnectTimer); // a pending resume retry
      this.wantConnected = true;
      try {
         await this.signIn(username, password);
      } catch (e) {
         /* Not signed in: the card stays, and keeps checking whether this browser is logged in
            after all (a restart-time sign-out), as before the attempt. */
         this.wantConnected = false;
         this.watchForLogin(0);
         throw e;
      }
   }

   private async signIn(username: string, password: string): Promise<void> {
      this.emit("authenticating");
      /* Learn DAWN's flags (per-app logins) before logging in, in case the page-load probe failed:
         the login and every URL after it must agree on which cookie they use. */
      /* Unknown flags would mean logging in on the shared cookie, which on a newer DAWN overwrites
         the WebUI's login with this user: stop instead (an older DAWN still answers status). */
      const status = await this.authStatusOrNull();
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
         body: JSON.stringify(
            this.appLogins
               ? { csrf_token, username, password, app: APP_NAME }
               : { csrf_token, username, password }
         )
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
      if (
         isDifferentUser(username) ||
         (this.signedInAs !== "" && this.signedInAs !== username.trim())
      ) {
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
      const resumeContinuous = this.voiceInput.resumeContinuous; // a drop in the window would clear it
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
      let ok: boolean;
      try {
         const res = await fetch(this.dawnUrl("/api/auth/logout"), {
            method: "POST",
            credentials: "same-origin",
            /* A half-open link must not hang the logout forever (feature-detected: older browsers). */
            signal:
               typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(15000) : undefined
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
            this.voiceInput.resumeContinuous = resumeContinuous;
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
      let reached = false;
      try {
         const s = await this.authStatus();
         if (this.wantConnected) return; // a sign-in or another resume got there meanwhile
         if (s) {
            reached = true;
            this.resumeFails = 0;
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
         /* unreachable: handled below */
      }
      /* DAWN didn't answer (down or restarting; a proxy's 5xx): whether this browser is logged in
         is unknown, so wait for DAWN rather than show the login card, and ask again. */
      if (!reached) {
         this.resumeFails++;
         /* Quiet at first (a restart takes a minute or so); then say so on the card, still trying. */
         if (this.resumeFails > RESUME_QUIET_TRIES)
            this.emit("error", "Can't reach DAWN. Still trying…");
         else this.emit("connecting", "waiting for DAWN…");
         window.clearTimeout(this.wsReconnectTimer);
         this.wsReconnectTimer = window.setTimeout(
            () => void this.tryResume(),
            Math.min(MAIN_WS_MAX_DELAY, 1000 * 2 ** (this.resumeFails - 1))
         );
         return;
      }
      /* No valid session - reveal the login card, with why the last one ended if it was revoked. */
      const reason = takeEndReason();
      if (reason) this.emit("error", reason);
      else this.emit("idle");
      this.watchForLogin(0);
   }

   /* While the login card is up, ask DAWN now and then whether this browser is logged in after all,
      and resume if so. A DAWN shutting down answers "not logged in" for every login once its
      database has closed, and a restart can land the page here mid-shutdown: the cookie is still
      good once DAWN is back. A really ended login keeps answering "no", so nothing happens. */
   private watchForLogin(checks: number): void {
      window.clearTimeout(this.loginWatchTimer);
      this.loginWatchTimer = window.setTimeout(
         () => void this.checkLogin(checks),
         checks < LOGIN_WATCH_FAST_CHECKS ? LOGIN_WATCH_FAST_MS : LOGIN_WATCH_SLOW_MS
      );
   }

   private async checkLogin(checks: number): Promise<void> {
      if (this.wantConnected) return; // signing in, or already resumed
      const s = await this.authStatusOrNull();
      if (this.wantConnected) return;
      if (!s?.authenticated) {
         this.watchForLogin(checks + 1);
         return;
      }
      /* Logged in as someone other than this tab showed (its panels may still hold that user's
            data, behind the card): no automatic resume; signing in reloads onto a clean page. */
      const who = typeof s.username === "string" ? s.username.trim() : "";
      if (this.signedInAs !== "" && who !== this.signedInAs) return;
      void this.tryResume();
   }

   private openSocket(): void {
      this.serverFeatures = null; // re-learned from this connection's config (a different build may answer)
      this.configSeen = false;
      this.emit("connecting");
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      /* Same-origin /ws - Vite proxies it to the DAWN daemon. The dawn-1.0
         subprotocol is MANDATORY: omit it and libwebsockets routes us to its
         HTTP handler, the socket "opens", and every frame is silently dropped. */
      const ws = new WebSocket(
         `${proto}://${window.location.host}${this.dawnUrl("/ws")}`,
         "dawn-1.0"
      );
      ws.binaryType = "arraybuffer"; // TTS PCM arrives as binary frames
      this.ws = ws;

      ws.onopen = (): void => {
         this.unsupportedTypes.clear(); // a new connection may be a different (upgraded) daemon
         this.sinks.stocks.setUnsupported?.(false);
         this.sinks.watchlist.setUnsupported?.(false);
         this.sinks.calendar.setUnsupported?.(false);
         /* The backoff resets only once this connection proves stable, not on the open itself. */
         window.clearTimeout(this.wsStableTimer);
         this.wsStableTimer = window.setTimeout(() => {
            if (this.ws === ws) this.wsFails = 0;
         }, MAIN_WS_STABLE_MS);
         /* Resume the stored session if we have one, else start a fresh session.
            Resuming is what keeps us from burning a session slot on every reload.
            The `audio_codecs` capability is BIDIRECTIONAL on DAWN (one use_opus flag drives
            both TTS out and mic in), so advertise `opus` only if we can BOTH encode the mic
            AND decode TTS - otherwise DAWN would send Opus TTS we can't play (static). Lock
            both audio paths to the same codec so nothing is misframed. */
         const useOpus = this.voiceInput.mic.opusSupported && this.tts.opusSupported;
         this.voiceInput.mic.setEncoding(useOpus);
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
         this.configAsks = [{ rev: this.llmRev, listsOnly: false }]; // no older ask will be answered
         this.llmWritesOwed = []; // nor an older model write
         this.convLoadsOwed = []; // nor an older load
         this.loadRetry = null; // the new connection's own resume or re-anchor takes over
         /* Nor the Learned list's requests on an older socket. Its close normally said so, but a
            socket that opened before the old one's close arrived (a fast reconnect, a reclaim)
            skips that cleanup (the stale-socket guard), so say it here too. */
         this.memoryFeed.linkDown();
         this.modelFeed.linkUp();
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
         this.conversationListFeed.markBootList();
         ws.send(
            JSON.stringify({ type: "list_conversations", payload: { limit: CONV_PAGE, offset: 0 } })
         );
         /* The caller's active background jobs, for the jobs panel. */
         ws.send(JSON.stringify({ type: "jobs_request" }));
         /* Subscribe to music: replies with the current music_state and, once a
            track is playing, streams Opus audio as 0x20 binary frames. Subscribe
            alone starts no audio. */
         ws.send(JSON.stringify({ type: "music_subscribe", payload: { quality: "standard" } }));
         this.calendarFeed.linkUp();
         this.libraryFeed.linkUp();
         this.haFeed.linkUp();
         this.watchesFeed.linkUp();
         this.stocksFeed.linkUp();
         /* System metrics for the HUD, now and on a slow poll (they are a snapshot,
            not pushed). Cleared on close. */
         ws.send(JSON.stringify({ type: "get_metrics" }));
         this.telemetryFeed.startPolling();
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
         window.clearTimeout(this.wsStableTimer); // it didn't last: the backoff keeps growing
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
         this.voiceInput.linkDown();
         /* Silence a ringing-alarm loop on the drop like the other audio producers: the tone
            belongs to the dead connection, and if the alarm is dismissed/times-out during the
            outage that terminal frame is lost (DAWN won't re-broadcast it on reconnect), so it
            would otherwise beep forever. The persistent card carries the state across. */
         this.alarmsFeed.linkDown();
         this.phone.reset(); // a call's frames can't arrive on a dead link; a reconnect re-asks
         /* No turn survives the link for this view: Stop goes away until one runs again, and a
            waiting turn's frames aren't re-sent after a reconnect (DAWN keeps it; its own frames
            follow when it starts). */
         this.endStop();
         this.ownTurn = false;
         this.liveStreamId = 0;
         this.replyEnded = false;
         this.speechTail = false;
         this.unsentAsked = null;
         this.stoppedSave = null; // a reload after the reconnect draws the row
         this.sinks.conversation.setTurnActive(false);
         this.setTurnWait(null, true); // kept: DAWN still holds the turn
         this.memoryFeed.linkDown(); // their replies can't come now
         this.stopMetrics();
         this.musicFeed.linkDown();
         /* Drop any in-flight list latch: a load-more that never got its response must not
            poison the post-reconnect boot response into an append. Also drop a queued live
            refresh + its debounce: the reconnect boot list (onopen list_conversations) is the
            loss-recovery path (the frame is fire-and-forget, never replayed), so a stale
            pending refetch would just be redundant. */
         this.conversationListFeed.linkDown();
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
         if (this.reanchoring)
            this.send({ type: "load_conversation", payload: { conversation_id: id } });
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
      /* Recent traffic proves life, except while a pong is overdue: other replies can keep flowing
         (DAWN answering SERVICE_UNAVAILABLE, say) without settling the doubt, so probe until a
         pong clears it or a second miss reconnects. */
      /* And while a refused load or a refused change's read waits to be sent again: those go out
         on a pong, and steady traffic (music progress, say) would otherwise never let one come. */
      const recovering = this.loadRetry !== null || this.llmNeedsRead;
      if (
         this.missedPongs === 0 &&
         !recovering &&
         performance.now() - this.lastInboundAt < PING_IDLE_MS
      )
         return;
      this.sendPing();
   }

   private sendPing(): void {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.pendingPingSeq = ++this.pingSeq;
      this.send({ type: "ping", payload: { seq: this.pendingPingSeq } });
      window.clearTimeout(this.pongTimer);
      this.pongTimer = window.setTimeout(
         () => this.onPongTimeout(this.pendingPingSeq),
         PONG_TIMEOUT_MS
      );
   }

   private onPong(seq: number): void {
      if (seq !== this.pendingPingSeq) return; // stale/duplicate
      const wasSuspect = this.missedPongs > 0; // recovered from a "stale" state
      this.pongSupported = true; // the watchdog's feature gate: DAWN answers pings
      this.unsupportedProbes = 0;
      this.missedPongs = 0;
      this.pendingPingSeq = 0;
      window.clearTimeout(this.pongTimer);
      /* DAWN checks logins again: the read of the selection a refused change left owed. */
      if (this.llmNeedsRead && !this.configAsks.some((a) => !a.listsOnly)) this.askConfig();
      /* And a load it refused, sent again as it was: a resume as a resume (one that's really gone
         then falls back quietly), a reconnect's restore without redrawing, a reload redrawn. */
      const retry = this.loadRetry;
      this.loadRetry = null;
      const choice = this.choiceAfterRetry;
      this.choiceAfterRetry = null;
      if (retry && this.convId === retry.id) {
         if (retry.purpose === "resume") this.resumingStored = true;
         if (retry.purpose === "reanchor") this.reanchoring = true;
         /* The user's choice made meanwhile goes once this load's reply has applied the
            conversation's own settings (so its echo is the current one), on the conversation. */
         this.loadThen = choice;
         this.send({ type: "load_conversation", payload: { conversation_id: retry.id } });
         this.loadThen = null;
      }
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
   private async authStatus(): Promise<{
      authenticated?: boolean;
      username?: string;
      protocol?: unknown;
   } | null> {
      const get = async (url: string): Promise<Record<string, unknown> | null> => {
         /* A deadline, so a request a proxy or a wedged DAWN never answers counts as unreachable
            rather than leaving whoever is waiting on it (a sign-out check, the resume) hanging. */
         const res = await fetch(url, {
            credentials: "same-origin",
            signal:
               typeof AbortSignal.timeout === "function"
                  ? AbortSignal.timeout(AUTH_STATUS_TIMEOUT_MS)
                  : undefined // feature-detected, as logout
         });
         return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
      };
      let s = await get(this.dawnUrl("/api/auth/status"));
      if (s && !this.appLogins && Array.isArray(s.features) && s.features.includes("app_logins")) {
         this.appLogins = true;
         setAppLogins(true); // shared with the markdown renderer (same-origin /api links in replies)
         s = await get(this.dawnUrl("/api/auth/status"));
      }
      return s;
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

   /* An UNAUTHORIZED reply. DAWN sends it for a revoked login, but also for any failed login
      lookup, which is what a DAWN shutting down returns once its database has closed (it closes
      before the WebUI stops), and its /api/auth/status then says "not logged in" too. So:
      - DAWN answers "not logged in": ask again a few times, a few seconds apart, while this socket
        is still open. A shutdown closes the socket (or stops answering) within that; a real end of
        the login keeps answering "no", and only then is the user signed out.
      - Unreachable, or still logged in: drop this socket and let the reconnect re-authenticate
        from the cookie. Bounded (reset by a pong), so a socket DAWN keeps refusing under a
        valid-looking login still ends at the login card. */
   private async onUnauthorized(reason?: string): Promise<void> {
      if (this.loggingOut) {
         this.revokeSession(reason); // our own logout: it only records the end
         return;
      }
      /* A DAWN with login_unavailable (PR #92) says SERVICE_UNAVAILABLE when it can't check a login
         and closes for a restart first, so its UNAUTHORIZED always means the login ended. */
      if (this.hasFeature("login_unavailable")) {
         this.revokeSession(reason);
         return;
      }
      if (this.checkingAuth) return; // one check covers a burst (the ping and a request together)
      this.checkingAuth = true;
      const ws = this.ws;
      try {
         let status = await this.authStatusOrNull();
         for (let i = 0; status?.authenticated === false && i < REVOKE_RECHECKS; i++) {
            await new Promise((r) => window.setTimeout(r, REVOKE_RECHECK_MS));
            if (this.loggingOut) {
               this.revokeSession(reason);
               return;
            }
            if (this.ws !== ws) return; // the socket went away meanwhile (a shutdown): the reconnect takes it from here
            status = await this.authStatusOrNull();
         }
         if (this.ws !== ws) return;
         if (status?.authenticated === false) {
            this.unconfirmedRevokes = 0;
            this.revokeSession(reason, true);
            return;
         }
         if (++this.unconfirmedRevokes > UNCONFIRMED_REVOKE_MAX) {
            this.unconfirmedRevokes = 0;
            this.revokeSession(reason); // DAWN says logged in but keeps refusing the socket: no auto-resume
            return;
         }
         console.warn(
            "[dawn] UNAUTHORIZED not confirmed by auth status (DAWN restarting?), reconnecting"
         );
         /* onclose reconnects (wantConnected), as for any drop. */
         if (this.wantConnected && ws) ws.close();
      } finally {
         this.checkingAuth = false;
      }
   }

   private async authStatusOrNull(): Promise<Awaited<ReturnType<DawnIngest["authStatus"]>>> {
      try {
         return await this.authStatus();
      } catch {
         return null; // unreachable (or timed out)
      }
   }

   /* `watch`: the end came from an UNAUTHORIZED that DAWN's auth status kept confirming, which a
      long shutdown can still fake; if the page can't reload, the login card then keeps checking. */
   private revokeSession(reason?: string, watch = false): void {
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
         if (watch) this.watchForLogin(0);
         return;
      }
      stashEndReason(reason ?? "Your session ended.");
      window.location.reload();
   }

   private onFrame(raw: string): void {
      let msg: { type?: string; payload?: unknown };
      try {
         msg = JSON.parse(raw) as { type?: string; payload?: unknown };
      } catch {
         return;
      }
      if (!msg || typeof msg !== "object") return; // valid JSON, but not a frame
      const type = typeof msg.type === "string" ? msg.type : "";
      const p = (msg.payload && typeof msg.payload === "object" ? msg.payload : {}) as Record<
         string,
         unknown
      >;

      /* A turn can run to completion on a conversation the user has switched away from (DAWN
         keeps it in that conversation's own history). Its live frames are tagged with that
         conversation_id; drop them so they never render into the conversation on screen.
         tool_step and message_appended apply their own conversation checks below. */
      if (FOREIGN_GATED_FRAMES.has(type)) {
         /* context_injection / context_citations are FLAT AT THE ROOT (no payload wrapper). */
         const src =
            type === "context_injection" || type === "context_citations"
               ? (msg as Record<string, unknown>)
               : p;
         /* The llm_state_update smuggled in a transcript is session-wide, not a turn's row. */
         /* The stopped turn's own end (its stream's end, saying whether it was saved, and its
            idle) is never foreign to the drain waiting for it. */
         const stoppedEnd =
            (type === "state" || type === "stream_end") &&
            this.stopped !== null &&
            this.stopped.conv > 0 &&
            Number(src.conversation_id ?? 0) === this.stopped.conv;
         if (
            !stoppedEnd &&
            !(type === "transcript" && p.role === "__llm_state__") &&
            this.isForeignConv(src)
         ) {
            /* A foreign turn's voice still plays here: DAWN keeps sending the origin a turn's audio
               after it switches away (conn_is_audio_target), so that turn's speaking/idle state
               still drives the echo-mute; only the visuals are skipped. */
            if (type === "state") {
               this.dawnSpeaking = p.state === "speaking";
               this.voiceInput.updateMicMute();
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
               this.musicFeed.sessionStarted();
            }
            /* The user's zone (their own, else the server's), the one DAWN reads and speaks times
               in. Authenticated frame only; an older DAWN leaves it out (get_my_settings covers it). */
            if (p.authenticated === true) {
               /* The session this connection is on (stream ids count per session, so a saved
                  reply's message_appended names its session for us to tell ours apart). */
               const sid = (p as { session_id?: unknown }).session_id;
               this.sessionId = typeof sid === "number" && sid > 0 ? sid : undefined;
               const zone = (p as { timezone?: unknown }).timezone;
               this.zoneFromSession = typeof zone === "string" && zone !== "";
               if (typeof zone === "string") this.applyTimezone(zone);
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
            if ((p as { reconnected?: boolean }).reconnected === false)
               this.keepaliveServerOn = false;
            /* A turn that waited when the link went: still waiting in the same session (DAWN sends
               its frames when it starts), gone with a fresh one (the reload shows what was saved). */
            if (this.keptWait) {
               const k = this.keptWait;
               if (
                  (p as { reconnected?: boolean }).reconnected === true &&
                  k.conversationId === this.convId
               ) {
                  this.setTurnWait({ ...k, stopping: false });
                  this.ownTurn = true;
                  this.sinks.conversation.setTurnActive(true);
               } else {
                  this.keptWait = null;
                  this.sinks.conversation.releaseTurns();
               }
            }
            if (this.keepaliveOn !== this.keepaliveServerOn) {
               this.send({
                  type: this.keepaliveOn ? "session_keepalive_enable" : "session_keepalive_disable"
               });
               this.keepaliveServerOn = this.keepaliveOn;
            }
            /* Re-establish continuous listening after a reconnect: DAWN destroyed the
               always-on context on the drop, so re-enable from HERE (never before the
               handshake, or the enable targets the throwaway connection and is lost). */
            this.voiceInput.resumeIfWanted();
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
               /* A conversation opened but not yet drawn when the link dropped (the active id ran
                  ahead of the transcript) loads in full too: a re-anchor would point the session
                  at it while another conversation stays on screen. */
               if (this.reclaiming || this.convId !== this.drawnConvId) {
                  /* Refused (the conversation gone meanwhile), the replay of an interrupted open
                     goes back to the one on screen, as the open itself would have. */
                  if (!this.reclaiming && this.convId !== this.drawnConvId) {
                     this.loadBack = this.drawnConvId;
                     this.loadRestores = true;
                  }
                  this.reclaiming = false;
                  this.send({
                     type: "load_conversation",
                     payload: { conversation_id: this.convId }
                  });
                  this.loadBack = undefined;
                  this.loadRestores = false;
               } else {
                  this.reanchoring = true;
                  if ((p as { reconnected?: boolean }).reconnected === false) {
                     this.send({
                        type: "load_conversation",
                        payload: { conversation_id: this.convId }
                     });
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
               ? new Set(
                    (p.features as unknown[]).filter((f): f is string => typeof f === "string")
                 )
               : null;
            if (typeof p.protocol === "number" && p.protocol !== CLIENT_PROTOCOL) {
               this.disconnect(true);
               this.emit("error", protocolMismatchText(p.protocol, this.dawnVersion));
               break;
            }
            this.email.setServerSupport(this.hasFeature("email_client"));
            /* The Learned list exists only on a DAWN that records batches; on each connect what
               changed while away comes from a fresh first page. */
            this.memoryFeed.configured();
            /* On-connect config. Advertises the dedicated music-stream server as of
               signal-map §9.1c: skip the socket entirely when music is disabled, else
               open it now with the token `session` just stored. Older servers omit
               music_enabled -> the field stays true and we open.
               music_port: in a co-located PROD build there is no /music-ws route on
               DAWN's main port (music is a separate lws server on main+1), so we connect
               cross-port to wss://<host>:music_port. In DEV we keep the Vite /music-ws
               proxy (one accepted cert, same origin). See music-feed.ts openMusicStream. */
            this.musicFeed.configured(p);
            /* Mic capture chunks at the server's configured cadence (falls back to a
               default until this arrives). Matches the TTS-out audio_chunk_ms. */
            if (typeof p.audio_chunk_ms === "number")
               this.voiceInput.mic.setChunkMs(p.audio_chunk_ms);
            break;
         }

         case "server_features":
            /* Handshake acknowledgement. Nothing to render, but pick up the daemon
               version if this server advertises it (feature-detected; older ones omit). */
            if (typeof p.version === "string") this.dawnVersion = p.version;
            break;

         case "turn_waiting": {
            /* turn_wait: this session's turn waits for another on the same conversation, or now
               starts (waiting:false; its own frames follow). Only for the conversation on screen. */
            if (!this.hasFeature("turn_wait")) break;
            const conv = Number(p.conversation_id ?? 0);
            if (!conv || conv !== this.convId) break;
            if (p.waiting === false) {
               this.setTurnWait(null);
               break;
            }
            const ref = typeof p.client_ref === "string" ? p.client_ref : undefined;
            /* Bounded: a timer longer than ~24.8 days fires at once in browsers. */
            const after =
               typeof p.stop_after_ms === "number" && p.stop_after_ms >= 0
                  ? Math.min(p.stop_after_ms, TURN_WAIT_STOP_AFTER_MAX_MS)
                  : TURN_WAIT_STOP_AFTER_MS;
            /* The same wait said again keeps its state (a stop already asked for, its timer). */
            if (this.turnWait && this.turnWait.ref === ref && this.turnWait.conversationId === conv)
               break;
            this.setTurnWait({
               conversationId: conv,
               ref,
               holder: p.holder === "job" || p.holder === "channel" ? p.holder : "turn",
               stopAfterMs: after,
               stopping: false
            });
            /* DAWN says this session's turn waits: it is ours to stop, whatever state came before
               (another app's reply may be speaking here). */
            if (!this.stopped) {
               this.ownTurn = true;
               this.sinks.conversation.setTurnActive(true);
            }
            break;
         }

         case "turn_unsent": {
            /* turn_wait: the waiting turn stopped before it started (the user's Stop, its
               connection gone too long, a shutdown); nothing of it was saved. A typed one comes
               back to the composer, merged ahead of any draft; a voice one is just said so. */
            if (!this.hasFeature("turn_wait")) break;
            const ref = typeof p.client_ref === "string" ? p.client_ref : undefined;
            /* A voice turn's (no ref) is said only for the conversation on screen: one that waited
               here, or (DAWN #125) one stopped before it ran, waiting or not. A typed one is matched
               by its ref, which also covers a new chat's (conversation_id 0). */
            const unsentConv = Number(p.conversation_id ?? 0);
            if (ref === undefined && unsentConv !== (this.turnWait?.conversationId ?? this.convId))
               break;
            this.setTurnWait(null);
            /* Taken back by the user: the words returning are the answer, no alert. */
            const asked = this.unsentAsked !== null && this.unsentAsked === (ref ?? "");
            this.unsentAsked = null;
            const returned =
               ref !== undefined ? this.sinks.conversation.rejectTurn({ ref }, false) : null;
            if (returned !== null && ref !== undefined) {
               this.dropTypedEchoRef(ref); // it will never echo
               if (!asked)
                  this.sinks.conversation.noteRefusal(
                     "Your message wasn't sent. It's back in the message box."
                  );
            } else if (ref === undefined && !asked) {
               this.sinks.conversation.noteRefusal("Your voice message wasn't sent.");
            }
            break;
         }

         case "stop_other_reply_response": {
            if (!this.turnWait) break;
            if (p.success === true) break; // the grant (turn_waiting false) follows when it's ended
            this.setTurnWait({ ...this.turnWait, stopping: false });
            this.spikeNotice(
               "turn-wait-stop",
               "conversation",
               p.error === "NOT_RUNNING"
                  ? "That reply already finished."
                  : "Couldn't stop the other reply.",
               { hold: 5 }
            );
            break;
         }

         case "pong":
            /* Heartbeat reply (a live, authed session). Confirms the link. */
            this.unconfirmedRevokes = 0; // DAWN accepted this login: refusals before it were a passing state
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
            const cfg = (p.config ?? p) as { general?: { ai_name?: string } };
            const name = cfg.general?.ai_name;
            if (name) {
               this.assistantName = name.charAt(0).toUpperCase() + name.slice(1);
               this.sinks.conversation.setAssistantName(this.assistantName);
            }
            /* A reply naming a request this connection doesn't owe (none should) applies nothing. */
            const ask = this.takeOwed(this.configAsks, p) ?? {
               rev: this.llmRev,
               listsOnly: typeof p.req === "string"
            };
            this.modelFeed.onConfig(p, ask);
            break;
         }

         case "list_llm_models_response":
            this.modelFeed.onFrame(type, p);
            break;

         case "set_session_llm_response": {
            /* Authoritative echo of a set_session_llm change (§9.1d). Reflect the
               value the SERVER resolved, not the one the user picked, across every
               field the response carries (provider / model / *_available /
               thinking_mode / reasoning_effort, which are the EFFECTIVE values): a model
               may not offer the picked mode/effort (P1.1b), and a provider switch resolves a
               new model + availability set the optimistic local state does not know.
               `reasoning_adjusted` = the fields THIS request set were changed to fit the
               model; DAWN sends no text for it, so Aurora words the notice. */
            const owedWrite = this.takeOwed(this.llmWritesOwed, p);
            this.modelFeed.onSessionLlm(p, owedWrite);
            break;
         }

         case "get_my_settings_response": {
            /* An unset user zone ("") means the server's zone (DAWN user-timezone): DAWN sends its
               resolved zone as server_timezone. An older daemon sends neither: browser-local. */
            /* Only for an older DAWN: a newer one named the zone on the session frame, resolved the
               way DAWN uses it (validated, canonical, the server's when the stored one won't load),
               where this carries the raw stored name. */
            if (!this.zoneFromSession)
               this.applyTimezone(
                  (p as { timezone?: string }).timezone ||
                     (p as { server_timezone?: string }).server_timezone
               );
            break;
         }

         case "timezone_changed":
            /* The user saved My Settings (in any tab or the WebUI): their zone may have changed.
               It can repeat the zone in use, which changes nothing. */
            this.applyTimezone((p as { timezone?: string }).timezone);
            break;

         case "list_conversations_response": {
            const append = this.conversationListFeed.onList(p);
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
            this.conversationListFeed.settleListRequest();
            break;
         }

         case "search_conversations_response":
            this.conversationListFeed.onFrame(type, p);
            break;

         case "load_conversation_response": {
            const load = this.takeOwed(this.convLoadsOwed, p);
            /* A reply naming a request this connection doesn't owe (none should) opens nothing. */
            if (!load && typeof p.req === "string") break;
            this.onConversationLoaded(p, load);
            /* A choice the user made while this load waited to resend: now, after it. */
            if (load?.then) this.send({ type: "set_session_llm", payload: load.then });
            /* Opened, the session runs the conversation's stored model; in local mode with llama.cpp
               it follows the loaded one again (on a failure, it ends a sync's wait on this load). */
            this.modelFeed.syncLoadedLocalModel();
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
               this.showConversation(0);
               localStorage.removeItem(CONV_KEY);
               this.sinks.conversationList.setActive(0);
               break;
            }
            const cid = Number((p as { conversation_id?: number }).conversation_id ?? this.convId);
            this.convId = cid;
            this.showConversation(cid);
            localStorage.setItem(CONV_KEY, String(cid));
            this.sinks.conversationList.setActive(cid);
            this.isPrivate = Boolean((p as { is_private?: boolean }).is_private);
            this.modelFeed.notifyLlm();
            break;
         }

         case "rename_conversation_response":
         case "set_pinned_response":
            this.conversationListFeed.onFrame(type, p);
            break;

         case "delete_memory_fact_response":
         case "delete_memory_entity_response":
         case "delete_memory_summary_response":
         case "list_memory_batches_response":
         case "memory_batch":
         case "undo_memory_batch_response":
         case "keep_memory_op_response":
            this.memoryFeed.onFrame(type, p);
            break;

         case "set_private_response": {
            /* The conversation's privacy is persisted; a private flip also privated its
               continuations (`also_private`). Refetch the picker so every affected row's badge is
               right, rather than patching ids one by one. A failure is surfaced; the toggle keeps
               the user's intent (a later load reflects the server's real value). */
            /* A pending private-first create (newConversation) settles only on the reply for ITS
               conversation (DAWN echoes conversation_id + is_private), never on a stray one. */
            const pp = p as { success?: boolean; conversation_id?: number; is_private?: boolean };
            const forPending =
               !!this.privateCreate &&
               this.convId > 0 &&
               Number(pp.conversation_id ?? 0) === this.convId;
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
            this.conversationListFeed.scheduleListRefresh();
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
                     this.send({
                        type: "conversation_learned_request",
                        payload: { conversation_id: cid }
                     });
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
               this.conversationListFeed.requestConversations(); // restore the row the panel optimistically removed
               this.pendingDeleteId = 0;
               break;
            }
            /* Deleted the open conversation: DAWN cleared the session server-side, so
               reset our surface + id to a fresh chat so the transcript doesn't strand. */
            if (this.pendingDeleteId > 0 && this.pendingDeleteId === this.convId) {
               this.settleTurnOnSwitch(); // its live turn (if any) is now foreign; don't strand the visuals
               this.convId = 0;
               this.showConversation(0);
               localStorage.removeItem(CONV_KEY); // the resumed conversation is gone
               this.sinks.conversation.clear();
               this.setTurnWait(null); // the held bubble it showed on is gone
               this.sinks.context.clear();
               this.setActiveTitle(""); // fresh chat
               this.sinks.conversationList.setActive(0);
            }
            this.pendingDeleteId = 0;
            /* Delete emits no conversation_list_changed; a debounced refresh reconciles the
               list (and closes the same optimistic-revert window as rename/pin). */
            this.conversationListFeed.scheduleListRefresh();
            break;
         }

         case "conversation_renamed": {
            /* A title changed: DAWN's own auto-title, and (DAWN #120) any rename, from any client,
               this one's included. Live-patch the row title. */
            const cid = Number((p as { conversation_id?: number }).conversation_id ?? 0);
            const t =
               typeof (p as { title?: string }).title === "string"
                  ? (p as { title: string }).title
                  : "";
            if (cid) this.sinks.conversationList.markRenamed(cid, t);
            if (cid) this.sinks.memoryBatches.renameConversation(cid, t);
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
               this.conversationListFeed.scheduleListRefresh();
            } else {
               this.sinks.conversationList.markAppended(cid);
            }
            break;
         }

         case "conversation_list_changed":
            this.conversationListFeed.onFrame(type, p);
            break;

         case "conversation_reset":
            /* A tool (reset_conversation / "start a new conversation") cleared the
               context. Empty the surface and drop our active conversation so the
               NEXT message opens a fresh one (mirrors the old WebUI's startNewChat),
               preserving the previous conversation instead of appending to it. */
            this.sinks.conversation.clear();
            this.setTurnWait(null); // the held bubble it showed on is gone
            this.sinks.context.clear();
            /* The reset arrives MID-turn (the tool returns and the model still replies), and that
               reply stays tagged with the old conversation. Keep it on screen until the turn
               ends, rather than gating it as foreign and stranding the reactor mid-reply. */
            if (this.convId > 0) this.resetTurnConv = this.convId;
            this.convId = 0;
            this.showConversation(0);
            this.setActiveTitle(""); // fresh chat -> HUD shows "New conversation"
            localStorage.removeItem(CONV_KEY); // context was reset; the next message opens a fresh one
            this.sinks.conversationList.setActive(0);
            break;

         case "clear_session_response":
            /* The ack to New Chat's clear_session (webui_history.c handle_clear_session). The
               client reset itself when it sent it, so there is nothing to do; a failure ("No
               active session") means there was no context to clear, and the next frame gets a
               fresh session anyway. */
            break;

         case "new_conversation_response": {
            /* The fresh conversation the daemon just created - persist to it now. A
               `server_initiated` push is DAWN lazily auto-creating+binding a conversation for a
               voice turn that had none (always-on / push-to-talk); it carries the
               transcript-derived `title` and OWNS the conversation's privacy (public). So on that
               path: reflect the pushed title (no blank flicker), and do NOT replay a pending
               is_private toggle onto it. A normal client-initiated new_conversation has no title
               yet (DAWN auto-titles later via conversation_renamed) and inherits a pending
               privacy intent. Feature-detected: older servers omit the flag -> client path. */
            const np = p as {
               conversation_id?: number;
               title?: string;
               server_initiated?: boolean;
            };
            const serverInitiated = np.server_initiated === true;
            /* A private-first create the user abandoned (they opened another conversation while it
               was in flight): the empty conversation exists server-side, but it must not take over
               the view. */
            if (this.discardNextCreate && !serverInitiated) {
               this.discardNextCreate = false;
               this.conversationListFeed.scheduleListRefresh();
               break;
            }
            this.sinks.context.clear(); // fresh conversation: no injected context yet
            /* Reflect the real title: a server-initiated (voice) create pushes it; a client
               create derives it from the first message (DAWN doesn't echo it, so we remembered
               it). Without this the HUD shows the "New conversation" placeholder until the
               later auto-title, while the picker already shows the real title. */
            this.setActiveTitle(
               serverInitiated ? String(np.title ?? "") : this.pendingNewConvTitle
            );
            this.pendingNewConvTitle = "";
            this.convId = Number(np.conversation_id ?? 0);
            this.showConversation(this.convId);
            if (this.convId <= 0 && !serverInitiated) this.settlePrivateCreate(false);
            if (this.convId > 0) {
               localStorage.setItem(CONV_KEY, String(this.convId)); // resume this on the next reload
               this.sinks.conversationList.setActive(this.convId);
               /* Our own create also emits a `created` conversation_list_changed (before this
                  response, with convId still 0 so it isn't self-filtered). Cancel that debounced
                  refresh and do the one immediate refetch here, so a fresh chat's first message
                  triggers exactly one list_conversations, not two. */
               this.conversationListFeed.refreshNow(); // the new row now exists - refresh the picker list
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
            const msg =
               typeof p.message === "string" && p.message
                  ? p.message
                  : "DAWN reported a prompt-cache problem.";
            this.spikeNotice("cache-alert", "cache", msg, {
               tone: "attention",
               persist: true,
               hold: 9
            });
            break;
         }

         case "phone_call_notification":
            this.phone.onFrame(p);
            break;

         case "state": {
            const st = str(p.state, "idle");
            if (this.stopped) {
               /* Draining a stopped turn: DAWN's ack is an UNTAGGED idle written ahead of the
                  turn's queued frames; the turn's own end is its worker's conversation-TAGGED
                  idle. Its leftover thinking / speaking in between are ignored. */
               if (st !== "idle") break;
               /* A stop before DAWN created a fresh chat's conversation ends untagged: then the
                  turn's idle is the second one (the ack being the other, in either order). */
               if (Number(p.conversation_id ?? 0) > 0 || ++this.stopped.idles >= 2)
                  this.endStop(true);
            }
            this.applyState(st, typeof p.detail === "string" ? p.detail : undefined, p.tools);
            break;
         }

         case "error": {
            /* Route on `severity` (§9.1b): info = benign notice, warning/error = a real
               problem. Fall back to the
               `INFO_` code prefix for older servers that don't send severity. Never
               paint the reactor red for an info notice; instead surface it as an
               ambient spike so the user sees why. */
            const code = typeof p.code === "string" ? p.code : "";
            /* A request DAWN refused (it names it by `req`): settled here, never a reactor error. */
            if (this.settleModelRefusal(p) || this.memoryFeed.settleMemoryRefusal(p)) {
               /* What the code means for the whole connection still applies. */
               if (code === "UNKNOWN_TYPE") this.onUnknownType(str(p.request_type), str(p.req));
               if (code === "UNAUTHORIZED")
                  void this.onUnauthorized(typeof p.message === "string" ? p.message : undefined);
               break;
            }
            /* This DAWN doesn't handle a message type we sent (an older daemon, or a subsystem
               like Home Assistant or the calendar not built in). Never a visible error: fail the
               matching request fast, stop sending that type on this connection, and note it. It
               can arrive before replies to earlier requests, so it's matched by `req`, not order. */
            if (code === "UNKNOWN_TYPE") {
               this.onUnknownType(
                  typeof p.request_type === "string" ? p.request_type : "",
                  typeof p.req === "string" ? p.req : ""
               );
               break;
            }
            /* The session was revoked/expired server-side (DAWN re-validates the token
               against the DB on every authed verb, including our heartbeat ping, and
               answers a dead session with UNAUTHORIZED instead of a pong). Confirmed before
               acting: a DAWN shutting down answers the same way once its database is closed. */
            if (code === "UNAUTHORIZED") {
               void this.onUnauthorized(typeof p.message === "string" ? p.message : undefined);
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
               code === "ATTACHMENT_INVALID" ||
               code === "EMAIL_REF_LIMIT" ||
               code === "EMAIL_UNAVAILABLE";
            const refusalText = (): string =>
               typeof p.message === "string" && p.message
                  ? p.message
                  : code === "TURN_QUEUE_FULL"
                    ? "DAWN is busy. Try again in a moment."
                    : "it couldn't be sent.";
            if (errRef && errSeverity === "error") {
               const refused = this.sinks.conversation.rejectTurn(
                  { ref: errRef },
                  code === "IMAGE_UNAVAILABLE"
               );
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
            /* DAWN couldn't check the login just now (its database busy, or down for a restart;
               login_unavailable). A typed turn it refused this way already came back above (it
               names the turn); otherwise it's passing, never a sign-out or an error flash. The
               connection stays logged in; a ping answered this way gets no pong, and the
               heartbeat keeps probing until a pong or a second miss (a reconnect). */
            if (code === "SERVICE_UNAVAILABLE") {
               console.debug("[dawn] DAWN couldn't check the login just now; retrying");
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
            if (this.voiceInput.onAlwaysOnRefusal(code, p)) break;
            /* A turn refused for its images (DAWN image_turns_by_id): it never ran and nothing was
               saved. Give the draft back (text + attachments) and say why; not a reactor error. */
            if (code === "IMAGE_UNAVAILABLE" || code === "IMAGE_LIMIT" || code === "IMAGE_ERROR") {
               const message =
                  typeof p.message === "string" && p.message
                     ? p.message
                     : "The attached images couldn't be sent.";
               /* Only one image turn is ever held, so this names exactly that one. Re-upload its
                  images on IMAGE_UNAVAILABLE (an expired upload), so a retry gets fresh ids. */
               this.dropTypedEcho(
                  this.sinks.conversation.rejectTurn("image", code === "IMAGE_UNAVAILABLE")
               );
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
               this.sinks.conversation.noteRefusal(
                  "DAWN is busy - a message wasn't sent. Try again in a moment."
               );
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
               typeof p.severity === "string"
                  ? p.severity
                  : code.startsWith("INFO_")
                    ? "info"
                    : "error";
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
                  message === "Failed to get response from AI" ||
                  message === "Failed to get response";
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

         case "music_state":
         case "music_position":
         case "music_queue_response":
         case "music_search_response":
         case "music_library_response":
         case "music_error":
            this.musicFeed.onFrame(type, p);
            break;

         case "calendar_list_my_calendars_response":
         case "calendar_upcoming_events_response":
         case "calendar_events_changed":
            this.calendarFeed.onFrame(type, p);
            break;

         case "doc_library_list_response":
         case "doc_library_get_response":
         case "doc_library_note_update_response":
         case "doc_library_doc_update_response":
            this.libraryFeed.onFrame(type, p);
            break;

         case "ha_status_response":
         case "ha_entities_response":
         case "ha_call_service_response":
         case "ha_state_changed":
            this.haFeed.onFrame(type, p);
            break;

         case "watch_list_response":
         case "watch_set_enabled_response":
         case "watch_readings":
            this.watchesFeed.onFrame(type, p);
            break;

         case "stocks_portfolio_update":
         case "stocks_watch_update":
         case "stocks_portfolio_subscribe_response":
         case "stocks_portfolio_unsubscribe_response":
         case "stocks_watch_subscribe_response":
         case "stocks_watch_unsubscribe_response":
         case "stocks_watch_set_response":
            this.stocksFeed.onFrame(type, p);
            break;

         case "watch_readings_subscribe_response":
         case "watch_add_response":
         case "watch_update_response":
         case "watch_remove_response":
            this.watchesFeed.onFrame(type, p);
            break;

         case "jobs_snapshot":
         case "job_update":
         case "jobs_invalidate":
         case "job_notification":
            this.jobsFeed.onFrame(type, p);
            break;

         case "attention_alert":
         case "silent_observation":
            this.attentionFeed.onFrame(type, p);
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
                  sourceId: str(r.source_id),
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

         case "scheduler_notification":
            this.alarmsFeed.onFrame(type, p);
            break;

         case "metrics_update":
         case "context":
         case "get_metrics_response":
            this.telemetryFeed.onFrame(type, p);
            break;

         case "stream_start":
            if (this.dropsStoppedReply()) break; // the stopped reply's late start
            this.liveStreamId = Number(p.stream_id ?? 0);
            this.replyEnded = false;
            this.setTurnWait(null); // our turn runs (a grant lost to a link loss says no more)
            this.sinks.conversation.startReply();
            break;

         case "stream_delta": {
            if (this.dropsStoppedReply()) break; // text still in flight from the reply stopped
            this.sinks.conversation.appendDelta(str(p.delta));
            break;
         }

         case "stream_end": {
            if (this.dropsStoppedReply()) {
               /* Already sealed as stopped. will_persist: DAWN will save it, as far as it got
                  (reason "stopped", stopped_replies_saved) or whole (the Stop landed as it
                  finished); without it nothing is saved. Register the stopped bubble so the row's
                  message_appended adopts onto it and redraws it from what was saved. */
               const conv = Number(p.conversation_id ?? this.convId);
               if (p.will_persist === true) {
                  /* Saved even in a conversation a reset tool left (the turn's own, still on
                     screen): its row is let in to redraw the bubble (stoppedSave). */
                  const own = this.stopped !== null && conv === this.stopped.conv;
                  if (own && this.stopped) this.stopped.saving = true;
                  if (conv === this.convId || own) {
                     const streamId = Number(p.stream_id ?? 0);
                     this.sinks.conversation.linkStream(conv, streamId, this.sessionId);
                     if (conv !== this.convId) this.stoppedSave = { conv, streamId };
                  }
                  this.conversationListFeed.scheduleListRefresh(); // the picker's row gained a reply
               }
               break;
            }
            this.sinks.conversation.endReply();
            /* A tool_iteration end is a mid-turn bubble seal (the tool loop re-issues
               stream_start/end per iteration); only a TERMINAL end carries the final answer. */
            const reason = typeof p.reason === "string" ? p.reason : "";
            if (reason !== "tool_iteration") {
               this.telemetryFeed.turnEnded(); // the next idle metrics_update carries this turn's cache figures
               /* DAWN is the sole writer of the turn (server-authoritative persistence): the
                  client no longer saves the reply. Register the finalized bubble under
                  (conv, streamId) so the fanned message_appended adopts onto it instead of
                  re-rendering. A real streamed reply always has streamId > 0; warn if not, since a
                  0 can't correlate the fan-out (it would double-render). Active conversation only. */
               const conv = Number(p.conversation_id ?? this.convId); // wire int64; coerce like the rest of the file
               const streamId = Number(p.stream_id ?? 0);
               if (conv === this.convId) {
                  if (!(streamId > 0)) {
                     console.warn(
                        "[dawn] terminal stream_end with no stream_id - fan-out may double-render",
                        conv
                     );
                  }
                  this.sinks.conversation.linkStream(conv, streamId, this.sessionId);
               }
               /* Settle the UI to idle when no voice is (or will be) playing. A reinvoke
                  re-engagement drives no state:idle and carries no TTS, so without this the reactor
                  hangs in its last state (thinking/speaking). Guard on dawnSpeaking + the live TTS
                  tail so a NORMAL spoken turn keeps its voice animation until DAWN's real state:idle
                  arrives (which handles the TTS-tail timing). */
               this.replyEnded = true;
               this.liveStreamId = 0;
               if (!this.dawnSpeaking && !this.tts.isSpeaking()) {
                  this.lastState = "idle";
                  this.resetTurnConv = 0;
                  /* Nothing to stop now; the turn stays this session's own, so speech that follows
                     the text (it can start after it) still offers Stop. */
                  this.sinks.conversation.setTurnActive(false);
                  this.sinks.reactor.setState("idle");
                  this.sinks.conversation.setThinking(false);
                  this.sinks.conversation.setStatus(this.activityFor("idle", undefined, undefined));
               }
               /* Refresh the picker for our OWN just-finished turn: its `bumped` frames are
                  self-echo-filtered in conversation_list_changed, so without this the active row's
                  count/time/position would stay stale until some other interface changed something.
                  Debounced + coalesced with the terminal end (one fetch per turn, not per tool
                  iteration), and invisible while the picker is collapsed. */
               this.conversationListFeed.scheduleListRefresh();
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
            if (this.dropsStoppedReply()) break; // a step of the reply the user stopped
            /* The inner `payload` is an opaque, redacted JSON string - untrusted. tool_call_id
               rides INSIDE it (same place `tool` does), byte-identical to load_conversation's key
               so live + reload pair on one implementation; omitted when the provider gave none. All
               fields reach the DOM via textContent (never innerHTML). */
            let obj: {
               tool?: unknown;
               args?: unknown;
               result?: unknown;
               tool_call_id?: unknown;
               iter?: unknown;
               error?: unknown;
            } = {};
            try {
               obj = JSON.parse(str(p.payload)) as typeof obj;
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
               (webui_server.c). Intercept it - it is not a message. */
            if (p.role === "__llm_state__" && typeof p.text === "string") {
               this.modelFeed.applyLlmState(p.text);
               break;
            }
            /* A user turn echoed by DAWN. It fires for typed AND voice input; we already
               appended the typed bubble locally (recorded in typedEchoes), so dedupe that
               and display only what has no local counterpart - i.e. spoken input. */
            if (p.role === "user" && typeof p.text === "string") {
               const ref =
                  typeof (p as { client_ref?: unknown }).client_ref === "string"
                     ? (p as { client_ref: string }).client_ref
                     : undefined;
               const messageId = Number((p as { message_id?: number }).message_id ?? 0);
               /* First the echo bookkeeping (it consumes our typed echo while the id is still new),
                  then the held turn's confirm, which gives its bubble the id: the other way round,
                  the id would already be known and the echo left behind, hiding a later turn of the
                  same words. */
               this.handleIncomingUser(p.text.trim(), messageId, p.replay === true, ref);
               /* Confirm our held turn: by its ref when DAWN echoes one (turn_refs), else the oldest
                  held turn with this text. */
               if (p.replay !== true && (ref !== undefined || !this.hasFeature("turn_refs")))
                  this.sinks.conversation.confirmTurn(p.text, ref, messageId);
               if (ref !== undefined && this.keptWait?.ref === ref) this.setTurnWait(null); // it started
               break;
            }
            /* A visual the render_visual tool just drew (DAWN sends the tool's whole result live; the
               saved reply carries it too, which is how a reload shows it). Keyed on the role DAWN
               sets for that tool only, never on content. Replays come back with the saved rows. */
            if (p.role === "visual" && typeof p.text === "string") {
               /* A stopped reply's chart: a saved partial carries it, and its row draws it when it
                  comes (stopped_replies_saved); otherwise it isn't kept, so it isn't drawn. */
               if (p.replay !== true && !this.dropsStoppedReply())
                  this.sinks.conversation.addVisual(p.text);
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
                     console.warn(
                        "[dawn] assistant transcript with no message_id - fan-out may double-render"
                     );
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
               /* The stopped reply saved in the conversation a reset tool left: it redraws the
                  bubble still on screen (only that row, matched by its stream; nothing else of
                  that conversation is drawn here, and the view stays unbound). */
               const save = this.stoppedSave;
               const sid = Number((p as { stream_id?: number }).stream_id ?? 0);
               if (save && cid === save.conv && sid === save.streamId) {
                  this.stoppedSave = null;
                  this.sinks.conversation.adoptId(
                     cid,
                     sid,
                     Number((p as { message_id?: number }).message_id ?? 0),
                     interpretMessage(String((p as { text?: string }).text ?? ""))?.text ??
                        undefined,
                     typeof (p as { session_id?: unknown }).session_id === "number"
                        ? (p as { session_id: number }).session_id
                        : undefined,
                     (p as { stopped?: unknown }).stopped === true
                  );
               }
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
            /* An assistant row's text as the transcript shows it (as a reload would). */
            const info =
               role === "assistant"
                  ? interpretMessage(String((p as { text?: string }).text ?? ""))
                  : null;
            if (
               streamId &&
               this.sinks.conversation.adoptId(
                  cid,
                  streamId,
                  messageId,
                  info?.text ?? undefined,
                  typeof (p as { session_id?: unknown }).session_id === "number"
                     ? (p as { session_id: number }).session_id
                     : undefined,
                  (p as { stopped?: unknown }).stopped === true
               )
            )
               break; // our streamed reply's echo (redrawn if it streamed only in part)
            /* User fan-out (stream_id 0): route through the same order-independent handler as the
               transcript echo, so the origin's optimistic bubble is recognized (dedup) and a
               non-origin viewer renders it as a user bubble. */
            if (role === "user") {
               /* Our own turn's fan-out may carry its client_ref (turn_refs): needed to recognize a
                  structured-attachments turn whose echo was lost, since its server-built text can't
                  match what we sent. */
               const fanRef =
                  typeof (p as { client_ref?: unknown }).client_ref === "string"
                     ? (p as { client_ref: string }).client_ref
                     : undefined;
               this.handleIncomingUser(
                  String((p as { text?: string }).text ?? "").trim(),
                  messageId,
                  false,
                  fanRef,
                  toEmailRef((p as { email_ref?: unknown }).email_ref)
               );
               break;
            }
            const text = info?.text ?? "";
            if (text)
               this.sinks.conversation.renderAppended({
                  role,
                  text,
                  messageId,
                  stopped: (p as { stopped?: unknown }).stopped === true
               });
            if (info?.tools) for (const c of info.tools) this.sinks.conversation.toolCall(c);
            break;
         }

         case "always_on_state":
            this.voiceInput.onFrame(type, p);
            break;

         default:
            /* The mail panel's replies (email_*_response), matched by req in email-wire.ts. */
            if (this.email.handleFrame(type, p)) break;
            /* Log each unseen type ONCE - this is our live map of what to wire
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
   private activityFor(
      st: string,
      detail: string | undefined,
      toolsRaw: unknown
   ): ActivityStatus | null {
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
      this.modelFeed.newChat(); // a new chat starts from DAWN's defaults, not an old switch
      this.llmRev++;
      this.send({ type: "clear_session" });
      /* A new chat starts on DAWN's configured default model (dawn.toml), not whatever the last
         conversation ran on: DAWN's "reset" restores the session LLM config to its defaults, and
         the set_session_llm_response echo carries the resulting type/provider/model/reasoning
         for the panel. Sent after clear_session, so no conversation is active to stamp it on. */
      this.send({ type: "set_session_llm", payload: { type: "reset" } });
      this.convId = 0;
      this.showConversation(0);
      localStorage.removeItem(CONV_KEY); // fresh chat: nothing to resume until a message opens one
      /* Finalize any in-flight streamed bubble before wiping (both the menu New Chat and the
         picker "+ New" arrive here). */
      this.sinks.conversation.endReply();
      this.settleTurnOnSwitch();
      this.sinks.conversation.clear();
      this.setTurnWait(null); // the held bubble it showed on is gone
      this.sinks.context.clear();
      this.sinks.conversationList.setActive(0);
      this.pendingNewConvTitle = "";
      this.setActiveTitle(""); // reset the HUD readout to the fresh-chat placeholder (was lingering the old title)
   }

   /* --- Conversation picker (Ingest): see conversation-list-feed.ts. */
   listConversations(opts: { limit: number; offset: number }): void {
      this.conversationListFeed.listConversations(opts);
   }

   searchConversations(
      query: string,
      content: boolean,
      opts?: { limit?: number; offset?: number }
   ): void {
      this.conversationListFeed.searchConversations(query, content, opts);
   }

   loadConversation(id: number): void {
      if (id <= 0) return;
      /* An open of the user's supersedes a refused load still to resend, but keeps it aside: refused
         too, the open goes back to that conversation, which still needs its load. */
      this.retrySetAside = this.loadRetry;
      this.loadRetry = null;
      /* Finalize any in-flight streamed bubble before switching id. Set convId optimistically so
         a text sent before the response is tagged to the right conversation (M2);
         load_conversation_response confirms it. */
      this.sinks.conversation.endReply();
      if (id !== this.convId) this.settleTurnOnSwitch();
      if (this.privateCreate) {
         this.settlePrivateCreate(false);
         this.discardNextCreate = true; // its new_conversation_response must not steal the view
      }
      /* The way back is the conversation actually on screen: opened while another opened one is
         still unanswered (and still the active id), it's that one's way back. */
      const waiting = [...this.convLoadsOwed]
         .reverse()
         .find((l) => l.back !== undefined && l.id === this.convId);
      const back = waiting ? waiting.back : this.convId;
      /* And whether going back must restore that conversation's server context (a reconnect's
         replay still unanswered). */
      if (waiting?.restore) this.loadRestores = true;
      this.convId = id;
      this.sinks.conversationList.setActive(id);
      /* Opening another conversation ends a switch to local still waiting for the model list:
         completed after this request, DAWN would save it onto the conversation being opened. Its
         own settings are coming, so older config snapshots no longer describe the selection. */
      this.modelFeed.cancelLocalPick();
      this.llmRev++;
      if (id !== back) this.loadBack = back;
      this.send({ type: "load_conversation", payload: { conversation_id: id } });
      this.loadBack = undefined;
      this.loadRestores = false;
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
      this.modelFeed.notifyLlm();
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
      this.conversationListFeed.renameConversation(id, title);
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
      this.conversationListFeed.setPinned(id, pinned);
   }

   /* --- The Learned list (memory_batches): see memory-feed.ts. */
   listMemoryBatches(before?: number): number {
      return this.memoryFeed.listMemoryBatches(before);
   }

   /* The transcript on screen is now this conversation's: its memory marks follow it. */
   private showConversation(id: number): void {
      this.drawnConvId = id;
      this.memoryFeed.show(id);
   }

   undoMemoryBatch(batchId: number, opId: number | null): boolean {
      return this.memoryFeed.undoMemoryBatch(batchId, opId);
   }

   keepMemoryOp(batchId: number, opId: number): boolean {
      return this.memoryFeed.keepMemoryOp(batchId, opId);
   }

   forgetMemoryFact(factId: number): boolean {
      return this.memoryFeed.forgetMemoryFact(factId);
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
         this.spikeNotice(
            "memory-forget-busy",
            "memory",
            "A forget is already running; try again when it finishes",
            {
               hold: 5
            }
         );
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

   /* --- Library (Ingest): see library-feed.ts. */
   refreshLibrary(): void {
      this.libraryFeed.refreshLibrary();
   }

   searchLibrary(query: string, opts?: { limit?: number; offset?: number }): void {
      this.libraryFeed.searchLibrary(query, opts);
   }

   loadMoreLibrary(offset: number): void {
      this.libraryFeed.loadMoreLibrary(offset);
   }

   fetchDocumentOriginal(blobId: string): Promise<{ blob: Blob; contentType: string }> {
      return this.libraryFeed.fetchDocumentOriginal(blobId);
   }

   /* Upload a document (POST /api/documents, multipart) over the same-origin /api proxy - a
      sanctioned conversation-input write. DAWN extracts the text server-side and optionally
      stores the original; the composer inlines the result as an [ATTACHED DOCUMENT] marker. */
   async uploadDocument(file: File): Promise<UploadedDoc> {
      const fd = new FormData();
      fd.append("document", file);
      const res = await fetch(this.dawnUrl("/api/documents"), {
         method: "POST",
         credentials: "same-origin",
         body: fd
      });
      if (!res.ok) throw new Error(`document upload failed: ${res.status}`);
      const j = (await res.json()) as Record<string, unknown>;
      if (j.success === false) throw new Error(str(j.error, "upload failed"));
      const blobId =
         typeof j.original_blob_id === "string" && j.original_blob_id
            ? j.original_blob_id
            : undefined;
      return {
         filename: str(j.filename, file.name),
         content: typeof j.content === "string" ? j.content : "",
         size: Number(j.size ?? file.size),
         type: str(j.type),
         blobId
      };
   }

   /* Upload a (client-compressed) image (POST /api/images, multipart field "image") over the
      same-origin /api proxy - a sanctioned conversation-input write. Returns the server id
      used both to attach the image to the turn (image_ids) and to rehydrate it on reload. */
   async uploadImage(image: Blob): Promise<UploadedImage> {
      const fd = new FormData();
      fd.append("image", image, "image.jpg");
      const res = await fetch(this.dawnUrl("/api/images"), {
         method: "POST",
         credentials: "same-origin",
         body: fd
      });
      if (!res.ok) throw new Error(`image upload failed: ${res.status}`);
      const j = (await res.json()) as Record<string, unknown>;
      const id = typeof j.id === "string" ? j.id : "";
      if (!id) throw new Error("image upload returned no id");
      return { id, mimeType: str(j.mime_type, "image/jpeg"), size: Number(j.size ?? 0) };
   }

   isVisionCapable(): boolean {
      return this.modelFeed.isVisionCapable();
   }

   /* A DAWN vendor script (`/js/vendor/…`, e.g. Chart.js) for a visual to inline. DAWN serves them
      only to a signed-in browser, so it goes with this app's login, and anything that isn't
      JavaScript is refused (a redirect to the login page must never be inlined as a script). */
   async fetchVendorScript(path: string): Promise<string> {
      if (!/^\/js\/vendor\/[A-Za-z0-9._-]+\.js$/.test(path)) throw new Error("not a vendor script");
      const res = await fetch(this.dawnUrl(path), {
         credentials: "same-origin",
         redirect: "error"
      });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !/javascript/i.test(type))
         throw new Error(`vendor script unavailable: ${res.status} ${type}`);
      return res.text();
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

   getDocumentText(
      id: number
   ): Promise<{ text: string; filename: string; filetype: string } | null> {
      return this.libraryFeed.getDocumentText(id);
   }

   updateNote(id: number, label: string, text: string): Promise<string | null> {
      return this.libraryFeed.updateNote(id, label, text);
   }

   updateDocText(id: number, text: string): Promise<string | null> {
      return this.libraryFeed.updateDocText(id, text);
   }

   /* Binary frame on the MAIN socket: a 1-byte opcode then payload. Only TTS arrives
      here now - chunks accumulate and the segment-end plays them. Music has its own
      dedicated socket (see music-feed.ts openMusicStream) and never rides the main socket. */
   private onBinary(buf: ArrayBuffer): void {
      const bytes = new Uint8Array(buf);
      if (bytes.length === 0) return;
      const op = bytes[0];
      /* Muted: drop the audio. DAWN applies set_tts_enabled from the next turn, so a reply
         already being spoken when the user mutes keeps sending audio until it ends. */
      /* Speech DAWN had already queued for a turn the user stopped: never played. */
      if (this.stopped && (op === BIN_AUDIO_OUT || op === BIN_AUDIO_SEGMENT_END)) return;
      if (op === BIN_AUDIO_OUT) {
         if (this.ttsEnabled) this.tts.queue(bytes.subarray(1));
      } else if (op === BIN_AUDIO_SEGMENT_END) {
         if (this.ttsEnabled) this.tts.play();
      }
   }

   /* Show every time and day in the user's zone: the clock, calendar, picker day groups and each
      panel's dates. An unknown zone keeps the one in use (browser-local until DAWN names one); the
      same zone again does nothing. The calendar refetches, since the zone decides which events
      fall on "today". */
   private applyTimezone(zone: string | undefined): void {
      const tz = safeTimeZone(zone);
      if (!tz || tz === this.userTz) return;
      this.userTz = tz;
      this.sinks.telemetry.setTimezone(tz);
      this.sinks.calendar.setTimezone(tz);
      this.sinks.conversationList.setTimezone(tz);
      this.calendarFeed.requestCalendar();
   }

   musicControl(action: string, params: Record<string, unknown> = {}): void {
      this.musicFeed.musicControl(action, params);
   }

   /* Stop this session's turn (DAWN's `cancel`, scoped to this session: other tabs and users are
      untouched). A reply in progress stays on screen, marked stopped, and its speech stops at
      once; a turn still waiting for another comes back unsent (turn_unsent). */
   cancelTurn(): void {
      /* Only the speech of a finished turn is left: stop it here (DAWN has nothing to cancel). */
      if (this.speechTail && !this.ownTurn) {
         this.speechTail = false;
         this.tts.stop();
         this.sinks.conversation.setTurnActive(false);
         return;
      }
      if (this.ws?.readyState !== WebSocket.OPEN || this.stopped) return;
      if (!this.ownTurn && !this.turnWait) return;
      this.send({ type: "cancel" });
      if (this.turnWait) {
         this.unsentAsked = this.turnWait.ref ?? ""; // DAWN answers with turn_unsent
         return; // nothing streamed yet
      }
      /* After the reply finished only its speech is left: stop that, and DAWN keeps the reply. */
      const afterReply = this.replyEnded && this.liveStreamId === 0;
      /* Safety net only (DAWN always ends a turn with its tagged idle, even after a long tool):
         never drop frames forever if that frame were lost. */
      const timer = window.setTimeout(() => this.endStop(true), STOP_DRAIN_MAX_MS);
      /* The turn's conversation: after a reset tool the view has none, and the turn's own idle
         (tagged with it) must still reach the drain. */
      this.stopped = {
         afterReply,
         timer,
         idles: 0,
         conv: this.convId || this.resetTurnConv,
         saving: false
      };
      this.sinks.conversation.setTurnActive(false);
      this.tts.stop();
      if (!afterReply) this.sinks.conversation.markStopped();
   }

   /* Stop the turn this session's turn waits for (turn_wait). Its grant (turn_waiting false)
      follows once that turn has ended. */
   stopOtherReply(): void {
      const w = this.turnWait;
      if (!w || w.stopping || !this.hasFeature("turn_wait")) return;
      if (!this.send({ type: "stop_other_reply", payload: { conversation_id: w.conversationId } }))
         return;
      this.setTurnWait({ ...w, stopping: true });
   }

   /* `ended`: the stopped turn ended (not a link loss or a switch away from it). A reply DAWN
      said nothing of saving (no will_persist: no text yet, a tool was running, or an older DAWN
      that saves no stopped reply) is then marked not saved, as a reload won't show it. */
   private endStop(ended = false): void {
      const s = this.stopped;
      if (!s) return;
      window.clearTimeout(s.timer);
      this.stopped = null;
      if (ended && !s.afterReply && !s.saving) this.sinks.conversation.stoppedUnsaved();
   }

   /* A frame of a reply the user stopped (dropped while its turn drains). */
   private dropsStoppedReply(): boolean {
      return this.stopped !== null && !this.stopped.afterReply;
   }

   private setTurnWait(w: (TurnWait & { conversationId: number }) | null, keep = false): void {
      if (!keep) this.keptWait = w;
      if (w === null && this.turnWait === null) return;
      this.turnWait = w;
      this.sinks.conversation.setTurnWait(
         w
            ? { ref: w.ref, holder: w.holder, stopAfterMs: w.stopAfterMs, stopping: w.stopping }
            : null
      );
   }

   /* Stop is offered only for this session's own running turn: a bystander tab sees DAWN speak
      (the fanned `speaking`) but never its `thinking`, and Stop there would cancel nothing. While
      a stopped turn's leftovers drain, Stop stays off. */
   private syncTurnActive(st: string, prev: string): void {
      if (this.stopped) {
         this.sinks.conversation.setTurnActive(false);
         if (st === "idle" || st === "error") this.ownTurn = false;
         return;
      }
      /* This session's turn opens with thinking from rest (a typed turn, or a voice one after
         listening). One that opens speaking is a job's answer re-engaging the conversation, which
         may never send its idle (DAWN sends it only with speech on), or another tab's voice: no
         Stop for either, even when a tool later says thinking. */
      const opens = prev === "idle" || prev === "listening" || prev === "error";
      if ((st === "thinking" || st === "summarizing") && (this.ownTurn || opens)) {
         if (!this.ownTurn) {
            /* A turn begins: nothing of the last one's reply carries over. */
            this.replyEnded = false;
            this.liveStreamId = 0;
         }
         this.ownTurn = true;
      } else if (st === "idle" || st === "error") {
         /* Its speech can still be playing here (DAWN runs ahead of what's heard). */
         if (this.ownTurn && st === "idle" && this.tts.isSpeaking()) this.speechTail = true;
         this.ownTurn = false;
         this.replyEnded = false;
         this.liveStreamId = 0;
      }
      this.sinks.conversation.setTurnActive(
         (this.ownTurn && (st === "thinking" || st === "summarizing" || st === "speaking")) ||
            (this.speechTail && st === "idle")
      );
   }

   /* Reads for the player's queue and library section (music-feed.ts). */
   musicQueueList(): void {
      this.musicFeed.musicQueueList();
   }

   musicSearch(query: string): void {
      this.musicFeed.musicSearch(query);
   }

   musicLibrary(type: string, params: Record<string, unknown> = {}): void {
      this.musicFeed.musicLibrary(type, params);
   }

   /* --- The boards: see ha-feed.ts, watches-feed.ts and stocks-feed.ts. */
   refreshHA(): void {
      this.haFeed.refreshHA();
   }
   haControl(call: HAServiceCall): void {
      this.haFeed.haControl(call);
   }
   requestWatches(): void {
      this.watchesFeed.requestWatches();
   }
   setWatchEnabled(id: number, enabled: boolean): void {
      this.watchesFeed.setWatchEnabled(id, enabled);
   }
   watchReadingsSubscribe(enabled: boolean): void {
      this.watchesFeed.watchReadingsSubscribe(enabled);
   }
   addWatch(metric: string, fields?: WatchFields): void {
      this.watchesFeed.addWatch(metric, fields);
   }
   updateWatch(id: number, fields: WatchFields): void {
      this.watchesFeed.updateWatch(id, fields);
   }
   removeWatch(id: number): void {
      this.watchesFeed.removeWatch(id);
   }
   stocksPortfolioSubscribe(enabled: boolean, extHours: boolean): void {
      this.stocksFeed.stocksPortfolioSubscribe(enabled, extHours);
   }
   refreshStocks(extHours: boolean): void {
      this.stocksFeed.refreshStocks(extHours);
   }
   stocksWatchSubscribe(enabled: boolean, extHours: boolean): void {
      this.stocksFeed.stocksWatchSubscribe(enabled, extHours);
   }
   refreshWatchlist(extHours: boolean): void {
      this.stocksFeed.refreshWatchlist(extHours);
   }
   stocksWatchSet(add: string[], remove: string[]): void {
      this.stocksFeed.stocksWatchSet(add, remove);
   }

   getMusicAudio(): MusicAudio {
      return this.musicFeed.music;
   }

   /* The control surface the composer's mic button binds to. Both push-to-talk and
      continuous listening are deliberate, user-initiated writes (voice input, in the same
      sanctioned class as chat submit). */
   getMicControl(): MicControl {
      return this.voiceInput.getMicControl();
   }

   /* Apply one DAWN machine state to the reactor, echo-mute and conversation chip. */
   private applyState(st: string, detail?: string, tools?: unknown): void {
      const prev = this.lastState;
      this.lastState = st;
      if (st === "idle") this.resetTurnConv = 0; // the reset turn (if any) has finished
      /* Drive the continuous echo-mute off DAWN's speaking state: it stays "speaking"
         across TTS sentence gaps, so muting on it (not on per-segment TTS playback)
         keeps the mic from hearing DAWN's own voice between sentences. */
      this.dawnSpeaking = st === "speaking";
      this.voiceInput.updateMicMute();
      this.sinks.reactor.setState(toReactorState(st));
      this.sinks.conversation.setThinking(st === "thinking" || st === "summarizing");
      this.syncTurnActive(st, prev);
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
      /* The turn (and any stopped reply, or a turn waiting for another) belonged to the
         conversation just left. */
      this.endStop();
      this.ownTurn = false;
      this.liveStreamId = 0;
      this.replyEnded = false;
      this.unsentAsked = null;
      this.stoppedSave = null;
      this.sinks.conversation.setTurnActive(false);
      this.setTurnWait(null);
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

   /* Mirror the active conversation's title into the HUD readout (empty -> a fresh chat).
      The HUD caches the last value, so it survives a reload / re-anchor without a re-push. */
   private setActiveTitle(t: string): void {
      this.sinks.telemetry.update({ title: t || "New conversation" });
   }

   /* load_conversation_response: the conversation opened (or why it couldn't). */
   private onConversationLoaded(
      p: Record<string, unknown>,
      load?: {
         id: number;
         back?: number;
         restore?: boolean;
         retry?: { id: number; purpose: LoadPurpose };
      }
   ): void {
      /* A failed load (e.g. the conversation was deleted from another client) must
         NOT wipe the surface: guard success and leave state untouched. */
      if ((p as { success?: boolean }).success === false) {
         if (this.resumingStored) {
            /* The persisted conversation is gone or inaccessible: silently fall
               back to a fresh chat - no error notice for an auto-resume. */
            this.resumingStored = false;
            this.settleTurnOnSwitch();
            this.convId = 0;
            this.showConversation(0);
            localStorage.removeItem(CONV_KEY);
            this.sinks.conversationList.setActive(0);
            return;
         }
         if (this.reanchoring) {
            /* The conversation we were in was deleted/inaccessible while we were
               away: drop to a fresh chat so the next turn opens a new one via the
               convId===0 path, rather than tagging turns to a dead id. Silent. */
            this.reanchoring = false;
            this.settleTurnOnSwitch();
            this.convId = 0;
            this.showConversation(0);
            localStorage.removeItem(CONV_KEY);
            this.sinks.conversationList.setActive(0);
            return;
         }
         /* One the user opened (a picker row, a batch's title) whose conversation is gone: back to
            the one still open, which DAWN's session never left, unless something else has moved
            the view since. Turns must not go to a conversation that doesn't exist. */
         if (load) this.returnFromOpen(load);
         else
            this.spikeNotice("conv-load", "conversation", "Could not open that conversation", {
               hold: 4
            });
         return;
      }
      const cid = Number((p as { conversation_id?: number }).conversation_id ?? this.convId);
      this.loadRetry = null; // a conversation is loaded: a refused one waiting to resend is moot
      /* It's on screen now: the way back for any opened load still unanswered (the same one
         opened twice, say, the second refused). */
      for (const l of this.convLoadsOwed) {
         if (l.back === undefined) continue;
         l.back = cid;
         l.restore = undefined; // its context is DAWN's now: nothing to restore going back to it
      }
      if (this.reanchoring) {
         /* Reconnect re-anchor: DAWN's per-connection active conversation is now
            restored, so the next turn (typed or voice) is tagged correctly. Do NOT
            touch the transcript - it is already on screen; loadHistory would rebuild
            it needlessly. Reconcile the cheap server-authoritative bits only. */
         this.reanchoring = false;
         this.convId = cid;
         this.showConversation(cid);
         localStorage.setItem(CONV_KEY, String(cid));
         this.sinks.conversationList.setActive(cid);
         this.isPrivate = Boolean((p as { is_private?: boolean }).is_private);
         this.modelFeed.applyConvLlmSettings((p as { llm_settings?: unknown }).llm_settings);
         this.setActiveTitle(String((p as { title?: string }).title ?? ""));
         this.modelFeed.notifyLlm();
         return;
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
            toolResults.set(m.tool_call_id, {
               result: m.content ?? "",
               error: m.is_error === true
            });
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
         items.push({
            role: m.role as "user" | "assistant",
            text: info?.text,
            tools,
            id,
            email:
               m.role === "user" ? toEmailRef((m as { email_ref?: unknown }).email_ref) : undefined,
            stopped: (m as { stopped?: unknown }).stopped === true
         });
      }
      /* A reload of the conversation our message waits in (a takeover reclaim, a reconnect)
         keeps that unsaved message, and its wait; any other load lets it go. */
      const kept = this.keptWait && this.keptWait.conversationId === cid ? this.keptWait : null;
      this.sinks.conversation.loadHistory(items, kept?.ref);
      if (kept) {
         this.setTurnWait(null);
         this.setTurnWait({ ...kept, stopping: false });
      } else this.setTurnWait(null);
      for (const rid of consumedIds) this.sinks.conversation.noteMessageId(rid);
      this.convId = cid; // authoritative confirm of the optimistic set in loadConversation()
      this.showConversation(cid); // after loadHistory drew the transcript the marks go in
      this.resumingStored = false; // a successful load ends any in-flight resume
      localStorage.setItem(CONV_KEY, String(cid)); // remember it for the next reload
      this.sinks.conversationList.setActive(cid);
      /* Reflect the conversation's server-side privacy so the toggle survives a
         reload/reconnect/switch (DAWN persists it; we only forgot to read it). */
      this.isPrivate = Boolean((p as { is_private?: boolean }).is_private);
      /* And its stamped LLM settings, so the MODEL panel shows what this
         conversation actually runs on rather than the connect-time snapshot. */
      this.modelFeed.applyConvLlmSettings((p as { llm_settings?: unknown }).llm_settings);
      this.setActiveTitle(String((p as { title?: string }).title ?? ""));
      /* Seed CONTEXT USAGE from the conversation's STORED last usage, so an opened
         conversation shows its context fill before the first live `context` frame. */
      const ctxMax = Number((p as { context_max?: number }).context_max ?? 0);
      if (ctxMax > 0) {
         const ctxTokens = Number((p as { context_tokens?: number }).context_tokens ?? 0);
         this.sinks.telemetry.update({ ctx: formatCtx(ctxTokens, ctxMax) });
      }
      this.modelFeed.notifyLlm();
   }

   /* The owed request a reply settles: the one it names (request_refs), else the oldest sent
      without a `req` (or, failing that, the oldest). */
   private takeOwed<T extends { req?: string }>(
      owed: T[],
      p: Record<string, unknown>
   ): T | undefined {
      const req = typeof p.req === "string" ? p.req : undefined;
      let at = req !== undefined ? owed.findIndex((e) => e.req === req) : -1;
      if (req === undefined) {
         at = owed.findIndex((e) => e.req === undefined);
         if (at < 0) at = owed.length > 0 ? 0 : -1;
      }
      return at < 0 ? undefined : owed.splice(at, 1)[0];
   }

   /* An open that didn't happen (failed, or refused): back to the conversation on screen, which
      DAWN's session never left, unless the view has moved on since. A reconnect's replay also
      rebuilds that conversation's server context (a fresh session holds none), without redrawing
      it; or goes to a fresh chat when none was on screen. */
   private returnFromOpen(load: {
      id: number;
      back?: number;
      restore?: boolean;
      retry?: { id: number; purpose: LoadPurpose };
   }): void {
      if (load.back !== undefined && this.convId === load.id) {
         this.convId = load.back;
         this.sinks.conversationList.setActive(load.back);
         /* Back to a conversation whose own refused load was set aside: it still needs it. */
         if (load.retry && load.retry.id === load.back) this.loadRetry = load.retry;
         if (load.restore) {
            if (load.back > 0) {
               this.reanchoring = true;
               this.send({ type: "load_conversation", payload: { conversation_id: load.back } });
            } else {
               this.showConversation(0);
               localStorage.removeItem(CONV_KEY);
            }
         }
      }
      this.spikeNotice("conv-load", "conversation", "Could not open that conversation", {
         hold: 4
      });
   }

   /* An error naming a model request (request_refs): DAWN refused it and no reply will come.
      A refused open goes the way a failed one does (back to the conversation on screen); a
      refused model change leaves the panel showing a choice that never happened, so DAWN's
      selection is read again; a refused read just stops being waited for. Whether it was one. */
   private settleModelRefusal(p: Record<string, unknown>): boolean {
      if (typeof p.req !== "string" || p.severity === "info") return false;
      const req = p.req;
      const message = typeof p.message === "string" && p.message ? p.message : "";
      const load = this.convLoadsOwed.findIndex((e) => e.req === req);
      if (load >= 0) {
         const [entry] = this.convLoadsOwed.splice(load, 1);
         if (entry.purpose === "user") {
            /* One the user opened: back to the conversation on screen, as a failed open does, but
               settled from its own entry: the shared resume / re-anchor flags may belong to another
               load still on its way, whose own reply must keep them. */
            this.returnFromOpen(entry);
         } else {
            /* A resume, re-anchor or reclaim refused while DAWN couldn't check the login: the
               conversation isn't gone, so it stays the one to resume (a failed load would drop
               it). Its transcript isn't drawn yet, so the next connect loads it in full; a turn
               meanwhile names it and runs there. */
            this.loadRetry = { id: entry.id, purpose: entry.purpose ?? "reload" };
            if (entry.then) this.choiceAfterRetry = entry.then; // for the next retry
            this.resumingStored = false;
            this.reanchoring = false;
         }
         this.modelFeed.runDeferredLoadedSync();
         return true;
      }
      const write = this.llmWritesOwed.findIndex((e) => e.req === req);
      if (write >= 0) {
         const [entry] = this.llmWritesOwed.splice(write, 1);
         if (entry.rev === this.llmRev) {
            this.modelFeed.cancelLocalPick();
            /* What the session runs, since the change didn't happen: read now, and again once DAWN
               answers a ping if this read is refused too (the same outage). */
            this.llmNeedsRead = true;
            this.askConfig();
            if (entry.chosen !== false) {
               this.spikeNotice(
                  "llm-switch-error",
                  "attention",
                  message ? `Couldn't change the model: ${message}` : "Couldn't change the model",
                  { tone: "attention", hold: 9 }
               );
            }
         }
         this.modelFeed.runDeferredLoadedSync();
         return true;
      }
      const ask = this.configAsks.findIndex((e) => e.req === req);
      if (ask >= 0) {
         this.configAsks.splice(ask, 1);
         this.modelFeed.notifyLlm();
         this.modelFeed.runDeferredLoadedSync();
         return true;
      }
      return false;
   }

   /* Re-request get_config to refresh the cloud model lists + provider availability after a
      backend config edit. Asked lists-only (configAsks), so the response updates the lists
      only, never the current selection (which would clobber a loaded conversation's provider).
      Shared by the config_changed push and the MODEL-panel-open refetch. */
   private requestConfigRefresh(): void {
      this.askConfig(true);
   }

   private askConfig(listsOnly = false): void {
      /* Owed a reply only when it went out (a closed socket drops it; the next one asks again). */
      this.askListsOnly = listsOnly;
      this.send({ type: "get_config" });
      this.askListsOnly = false;
   }

   /* Nothing still owed a reply could change the session's selection: no model write (New Chat's
      reset, a pick), no conversation load (it applies that conversation's settings) and no full
      config read (the selection itself, on connect or after DAWN's tool switched the model).
      DAWN answers a connection's frames in order, but a load sent after the model list (the boot
      or reconnect re-open) reaches DAWN after a sync the list would trigger, and would be undone
      by it. Lists-only reads never touch the selection, so they don't count. */
   private selectionSettled(): boolean {
      return (
         this.llmWritesOwed.length === 0 &&
         this.convLoadsOwed.length === 0 &&
         !this.configAsks.some((a) => !a.listsOnly) &&
         /* A refused change left the panel showing a choice that may never have run: nothing
            follows it until a read says what the session runs. */
         !this.llmNeedsRead
      );
   }

   /* --- MODEL panel: see model-feed.ts. */
   getModelControl(): ModelControl {
      return this.modelFeed.getModelControl();
   }

   /* TTS on/off. `set_tts_enabled` is a per-connection preference ("don't synthesize
      voice for MY socket") - a deliberate per-connection write like set_private.
      Telling DAWN matters beyond the local
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
   submit(
      text: string,
      attachments?: {
         turnRef?: string;
         documents?: OutDocument[];
         images?: OutImage[];
         imageIds?: string[];
         fromVisual?: boolean;
         emailRefs?: EmailRef[];
      }
   ): void {
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
         from_visual?: boolean;
         email_refs?: Array<{
            account_id: number;
            message_id: string;
            from: string;
            subject: string;
         }>;
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
      if (attachments?.turnRef && this.hasFeature("turn_refs"))
         payload.client_ref = attachments.turnRef;
      if (this.convId > 0) payload.conversation_id = this.convId;
      /* A rendered visual's prompt, not the person: DAWN lets no confirm count in this turn (a
         model-written script calling sendPrompt("yes") must not approve a staged action). */
      if (attachments?.fromVisual) payload.from_visual = true;
      /* P1.4: the email the turn asks about. The model reads it itself through the email tool; `from`
         and `subject` are the chip's display strings, stored for display only (never sent to the
         model). The id goes back exactly as the mail panel received it. */
      if (attachments?.emailRefs?.length && this.supportsEmailRefs()) {
         payload.email_refs = attachments.emailRefs.slice(0, 1).map((r) => ({
            account_id: r.accountId,
            message_id: r.messageId,
            from: displayCut(r.sender),
            subject: displayCut(r.subject)
         }));
      }
      /* Image attachments: the MANDATORY image_ids (the /api/images upload ids, order-matched),
         which the daemon reads, sends to the model, and persists as [IMAGE:<id>] markers. A DAWN
         advertising `image_turns_by_id` takes images ONLY that way (it ignores base64); an older
         one still needs the base64 images[] for the live model call, so it gets both. */
      if (attachments?.imageIds?.length) {
         payload.image_ids = attachments.imageIds;
         if (!this.hasFeature("image_turns_by_id") && attachments.images?.length)
            payload.images = attachments.images;
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

   /* A dismissed notice: a ringing alarm's close silences it at DAWN (alarms-feed.ts). */
   dismiss(id: string): void {
      this.alarmsFeed.dismiss(id);
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
      this.alarmsFeed.noticeAction(id, action, value);
   }

   /* Whether any alarm is currently RINGING - the standby screensaver's "don't sleep while an
      alarm sounds" guard. Reads the same live set that drives the chime loop, so a
      server-timed-out / auto-dismissed alarm (whose card lingers) correctly reads as not
      ringing, unlike the notice's `critical` flag. */
   isAlarmRinging(): boolean {
      return this.alarmsFeed.isRinging() || this.phone.isRinging(); // a ringing phone keeps the display awake too
   }

   /* Register a callback fired at a wake-word match (the always-on VAD entering "recording"),
      so the ambient-standby screensaver can wake on a real voice match. Read-only observer. */
   onVoiceWake(cb: () => void): void {
      this.voiceInput.onVoiceWake(cb);
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

   /* Delete one of the user's own memories from the Context panel (memory-feed.ts). */
   deleteMemory(itemId: string): void {
      this.memoryFeed.deleteMemory(itemId);
   }

   /* Focus/blur is a local UI cue only; the real reactor state comes from DAWN's
      `state` frames, so we tell the server nothing here. */
   setEngaged(_engaged: boolean): void {}

   /* `silent`: don't report "disconnected" (the caller emits its own status, or reloads). */
   disconnect(silent = false): void {
      this.wantConnected = false;
      window.clearTimeout(this.loginWatchTimer);
      this.musicFeed.dropHeld(); // nothing left to show it on
      this.endStop();
      window.clearTimeout(this.wsReconnectTimer); // cancel any pending auto-reconnect
      this.wsFails = 0;
      this.stopMetrics();
      this.stopHeartbeat();
      this.musicFeed.closeMusicStream();
      this.alarmsFeed.linkDown();
      this.phone.reset();
      this.tts?.stop();
      this.dawnSpeaking = false;
      this.voiceInput.stop();
      this.conversationListFeed.cancelRefresh(); // no live picker refresh should fire post-teardown
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
      this.prefs.dispose();
      window.clearTimeout(this.wsStableTimer);
      /* The forget-learned timers: busy re-asks of the count and the forget's no-reply timeout. */
      for (const t of this.learnedRetryTimers) window.clearTimeout(t);
      this.learnedRetryTimers.clear();
      this.learnedRetries.clear();
      window.clearTimeout(this.forgetTimer);
      this.forgetTimer = 0;
      this.libraryFeed.dispose();
      this.tts?.dispose();
      this.musicFeed.dispose();
      this.voiceInput.dispose();
      this.phone.dispose();
      this.email.dispose();
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

   /* Whether DAWN refuses every confirm in a turn marked from_visual: the `visual_prompt_guard` flag.
      Without it an older DAWN ignores the mark, so a visual's prompt would count as the person's. */
   supportsVisualPromptGuard(): boolean {
      return this.hasFeature("visual_prompt_guard");
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

   /* The Mail panel's new-mail chime, through the same player and "Alarm sounds" gate as alarms. */
   playMailChime(): void {
      this.alarmChime.playMailChime();
   }

   /* The user's settings (8.7). In this browser until DAWN advertises a settings store (9.14). */
   userPrefs(): UserPrefs {
      return this.prefs;
   }

   /* Whether a chat turn can carry an email reference: DAWN's `email_refs` flag (P1.4). Its
      prerequisites are all in (docs/EMAIL_PANEL_DESIGN.md 4): submit() sends `email_refs`,
      private-first creation (newConversation({private:true})), and off-origin images in rendered
      replies wait for a click (render/markdown.ts, 4.7). */
   supportsEmailRefs(): boolean {
      return this.hasFeature("email_refs");
   }

   /* The login panel subscribes to reflect connection state. */
   onStatus(handler: StatusHandler): void {
      this.status = handler;
   }

   private emit(status: LinkStatus, detail?: string): void {
      this.lastStatus = status;
      this.lastDetail = detail ?? "";
      this.email.setLinked(status === "connected" || status === "stale"); // stale = socket still open
      /* Link down: an unechoed turn's fate can't be learned now; stop holding drafts for them. Not on
         "stale" (one missed heartbeat): the socket is still open and refusals still arrive. */
      if (status !== "connected" && status !== "stale" && this.sinks)
         this.sinks.conversation.releaseTurns(this.keptWait?.ref);
      if (status !== "connected") this.settlePrivateCreate(false); // a pending private create can't complete now
      this.status(status, detail);
   }

   /* Snapshot for the System > Connection dialog: current link state, the origin the
      browser talks to (DAWN rides the same-origin proxy), and the daemon version if it
      advertised one (else ""). */
   getConnectionInfo(): {
      status: LinkStatus;
      detail: string;
      server: string;
      dawnVersion: string;
   } {
      return {
         status: this.lastStatus,
         detail: this.lastDetail,
         server: window.location.origin,
         dawnVersion: this.dawnVersion
      };
   }

   /* True when the frame went out on an open socket. */
   private send(msg: object): boolean {
      /* A type this DAWN said it doesn't handle isn't sent again on this connection (polls stop).
      Never `text`: a chat message is always attempted, and a refusal says so. */
      const type = (msg as { type?: unknown }).type;
      if (typeof type === "string" && this.unsupportedTypes.has(type)) return false;
      if (type === "set_session_llm") this.llmRev++; // see llmRev
      if (this.ws?.readyState !== WebSocket.OPEN) return false;
      const owed =
         type === "get_config" || type === "set_session_llm" || type === "load_conversation";
      const req = owed && this.hasFeature("request_refs") ? `llm-${++this.llmReqSeq}` : undefined;
      if (req !== undefined) {
         const payload = (msg as { payload?: Record<string, unknown> }).payload ?? {};
         msg = { ...msg, payload: { ...payload, req } };
      }
      if (type === "get_config") {
         this.configAsks.push({ rev: this.llmRev, listsOnly: this.askListsOnly, req });
      }
      if (type === "set_session_llm") {
         /* The user's own choice, not New Chat's reset or the llama.cpp follow (see the notice in
            settleModelRefusal). "Use default model" is a reset the user chose: it carries the
            reasoning, which New Chat's never does. */
         const fields = (msg as { payload?: Record<string, unknown> }).payload ?? {};
         const chosen =
            (fields.type !== "reset" || fields.thinking_mode !== undefined) &&
            fields.from_restore !== true;
         this.llmWritesOwed.push({ rev: this.llmRev, req, chosen }); // see llmWritesOwed
         if (chosen && this.loadRetry) {
            const { req: _req, ...choice } = fields;
            this.choiceAfterRetry = choice;
         }
      }
      if (type === "load_conversation") {
         const id = Number(
            (msg as { payload?: { conversation_id?: unknown } }).payload?.conversation_id
         );
         const purpose: LoadPurpose =
            this.loadBack !== undefined
               ? "user"
               : this.resumingStored
                 ? "resume"
                 : this.reanchoring
                   ? "reanchor"
                   : "reload";
         this.convLoadsOwed.push({
            id,
            back: this.loadBack,
            req,
            purpose,
            restore: this.loadRestores || undefined,
            retry: purpose === "user" ? (this.retrySetAside ?? undefined) : undefined,
            then: this.loadThen ?? undefined
         });
         if (purpose === "user") this.retrySetAside = null;
      }
      this.ws.send(JSON.stringify(msg));
      return true;
   }

   /* UNKNOWN_TYPE (DAWN bcb0bdc1+; older daemons send nothing): see the error case. Only an
      OPTIONAL subsystem's verbs (built out of some DAWNs) are quietly stopped; a core verb DAWN doesn't
      know means this DAWN is older than this Aurora, which the user is told, never silently blocked. */
   private onUnknownType(requestType: string, req: string): void {
      if (req) this.email.failUnsupported(req);
      if (!OPTIONAL_PREFIXES.some((p) => requestType.startsWith(p))) {
         if (requestType === "text") {
            /* A typed turn that never ran: its draft comes back (UNKNOWN_TYPE names no client_ref). */
            this.dropTypedEcho(this.sinks.conversation.rejectTurn("newest", false));
            this.sinks.conversation.noteRefusal(
               "Message not sent: this DAWN doesn't accept it (it may be older than this Aurora)."
            );
         } else if (requestType && !this.unsupportedTypes.has(requestType)) {
            this.notifyUser(
               `This DAWN doesn't handle "${requestType}" (it may be older than this Aurora).`
            );
         }
         if (requestType && requestType !== "text") this.unsupportedTypes.add(requestType); // say it once
         console.warn(`[dawn] this DAWN doesn't handle "${requestType || "a message"}"`);
         return;
      }
      this.unsupportedTypes.add(requestType);
      /* Home Assistant isn't part of this DAWN (e.g. a SmartThings build): the board says so
         instead of waiting for a status that will never come. */
      if (requestType === "ha_status")
         this.sinks.ha.setStatus({
            configured: false,
            connected: false,
            error: "Home Assistant isn't available on this DAWN"
         });
      if (requestType.startsWith("ha_")) this.haFeed.stopPolling();
      if (requestType.startsWith("calendar_")) {
         this.calendarFeed.stopPolling();
         this.sinks.calendar.setUnsupported?.(true);
      }
      /* The Schwab feeds aren't in this DAWN: say so now instead of after the panels' timeout. */
      if (requestType.startsWith("stocks_portfolio_")) this.sinks.stocks.setUnsupported?.(true);
      if (requestType.startsWith("stocks_watch_")) this.sinks.watchlist.setUnsupported?.(true);
      console.warn(
         `[dawn] this DAWN doesn't handle "${requestType || "a message"}"; not sending it again on this connection`
      );
   }

   /* Raw binary to the main socket (mic audio). The opcode is prepended by the caller;
      guarded so a frame that arrives after a drop is dropped, not thrown. */
   private sendBinary(bytes: Uint8Array<ArrayBuffer>): void {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(bytes);
   }

   private stopMetrics(): void {
      this.telemetryFeed.stopPolling();
      this.calendarFeed.stopPolling();
      this.haFeed.stopPolling();
      this.watchesFeed.stopPolling();
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

   /* Persist a turn to the DB. DAWN keeps webui text turns in memory only - the
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
   private handleIncomingUser(
      text: string,
      messageId: number,
      replay: boolean,
      ref?: string,
      email?: EmailRef
   ): void {
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
      const echoIdx = this.typedEchoes.findIndex(
         (e) => e.text === text && now - e.at < TYPED_ECHO_TTL_MS
      );
      if (echoIdx >= 0) {
         this.typedEchoes.splice(echoIdx, 1);
         this.sinks.conversation.noteMessageId(messageId);
         return;
      }
      if (!replay) this.sinks.conversation.showUser(text, messageId, email);
   }
}
