/* Music: the dedicated dawn-music stream socket (the only music transport: its auth, the audio it
   feeds the decoder, the buffer reports DAWN paces by, and its retries and watch), the player's
   state (the held end-of-track state, seek detection, flushes), the transport controls, and the
   queue and library reads. */

import type { IngestSinks, MusicState } from "./ingest.ts";
import { MusicAudio } from "../audio/music.ts";
import { MusicSocketWatch, type MusicDeadReason } from "./music-watch.ts";
import { MusicStateHold } from "./music-hold.ts";
import { toLibraryPage, toMusicState, toMusicTrack } from "./music-wire.ts";
import { str } from "./wire.ts";

/* The daemon prepends this opcode to every frame on the music socket. */
const BIN_MUSIC_DATA = 0x20; // a music Opus chunk ([uint16-LE len][opus] after the opcode)
const MUSIC_WS_MAX_FAILS = 5; // give up on the dedicated stream socket after this many
/* music_error codes that answer the queue and library section's requests (not playback). */
const MUSIC_SECTION_ERRORS = new Set([
   "UNAVAILABLE",
   "SEARCH_FAILED",
   "NOT_INITIALIZED",
   "INVALID_INDEX",
   "INVALID_REQUEST",
   "MEMORY_ERROR"
]);
const MUSIC_MAX_STALLS = 3; // silent-while-playing replacements in a row before "unavailable"
const MUSIC_SEEK_TOLERANCE_SEC = 1.25; // position divergence from projected playback that counts as a seek

/* The view it drives. */
type Sinks = Pick<IngestSinks, "music">;

export class MusicFeed {
   /* Dedicated dawn-music stream socket (main port + 1, proxied at /music-ws). This is
      the SOLE music transport: DAWN removed the legacy main-socket 0x20 fallback, so if
      this socket never attaches there is no audio at all (not a silent degrade). */
   private musicWs: WebSocket | null = null;
   private musicWsTimer = 0;
   private musicWsFails = 0;
   private musicWsAuthed = false; // auth_ok seen -> the socket may carry buffer reports
   private musicUnavailable = false; // surfaced "stream unavailable" after exhausting retries
   private musicWsToken = ""; // token the current music socket is (re)connecting with
   /* A proxy can keep a dead music socket OPEN with no onclose (see music-watch.ts): replace it
      when it doesn't attach in time or goes silent while DAWN says music is playing. */
   private readonly musicWatch = new MusicSocketWatch((reason) => this.onMusicSocketDead(reason));
   private musicStalls = 0; // consecutive silent-while-playing replacements; any audio frame clears it
   private musicEnabled = true; // config.music_enabled (older servers omit it -> assume on)
   private musicPort = 0; // config.music_port; used for the cross-port prod connect (0 = fall back to main+1)
   private prevMusicIndex: number | null = null; // last queue index seen (track-change detect)
   private prevMusicPos = 0; // last raw server position seen (from state OR position ticks)
   private prevMusicPosAt = 0; // performance.now() when prevMusicPos was captured
   private prevMusicPlaying = false; // was playback advancing at prevMusicPos (for the projection)
   private prevMusicPath = ""; // last track path seen (a new file at the same index is a track change)
   private prevMusicDuration = 0; // the heard track's length (to finish its counter while a state is held)
   private pendingMusicSeek: {
      index: number;
      path: string;
      params: Record<string, unknown>;
   } | null = null; // sent once that track is ready
   /* DAWN's end-of-track state, held until the buffered audio has played out (music-hold.ts). */
   private readonly musicHold = new MusicStateHold((payload, state, arrivedAt) =>
      this.applyMusicState(payload, state, arrivedAt)
   );
   /* Created at construction (not in start) so the player view can bind to it
      before ingest.start() runs. Its AudioContext stays lazy until the first frame. */
   readonly music = new MusicAudio();

   constructor(
      private readonly send: (msg: object) => boolean,
      private readonly getSinks: () => Sinks,
      private readonly getWantConnected: () => boolean,
      private readonly getToken: () => string | null,
      private readonly dawnUrl: (path: string) => string
   ) {}

   private get sinks(): Sinks {
      return this.getSinks();
   }

   /* Whether the user wants to be connected (vs a drop or a sign-out). */
   private get wantConnected(): boolean {
      return this.getWantConnected();
   }

   /* At start, before any socket. */
   start(): void {
      /* Surface a fatal music-audio problem (e.g. no secure context) in the player. */
      this.music.setErrorHandler((msg) => this.sinks.music.setError(msg));
      /* Closed-loop flow control: report our buffered depth up the music socket so the
         server can hold its ~2 s cushion (see MusicAudio). No-op until the socket auths. */
      this.music.setBufferReporter((ms) => this.musicReport(ms));
   }

   /* A session frame stored a fresh token: the music socket's retries start over. */
   sessionStarted(): void {
      this.musicWsFails = 0;
      this.musicStalls = 0;
      this.musicUnavailable = false; // fresh connection re-arms the give-up notice
   }

   /* The config frame: whether DAWN has music, and where its stream socket listens. */
   configured(p: Record<string, unknown>): void {
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
      const token = this.getToken();
      if (this.musicEnabled && token) this.openMusicStream(token);
      else if (!this.musicEnabled) this.closeMusicStream();
   }

   /* The main socket closed. */
   linkDown(): void {
      this.closeMusicStream();
      /* Drop the seek-detection baseline: a resume may land at a different track/
         position, and a stale baseline would misread that first music_state as a seek. */
      this.prevMusicIndex = null;
      this.musicHold.drop(); // the reconnect's music_state says where playback is
      this.pendingMusicSeek = null;
      this.musicWatch.setPlaying(false); // the reconnect's music_state says again
   }

   /* A deliberate disconnect: nothing is left to show a held state on. */
   dropHeld(): void {
      this.musicHold.drop();
   }

   /* Its frames (the core lists them in its switch). */
   onFrame(type: string, p: Record<string, unknown>): void {
      switch (type) {
         case "music_state": {
            const st = toMusicState(p);
            /* Another advance:"auto" state while one is held belongs to the same transition (a
               Plex track's loading state, then its ready state, or a skip past a bad track):
               it replaces the held one and the timer stands, so the latest state applies when
               the heard track ends. */
            if (p.advance === "auto" && this.musicHold.peek()) {
               this.musicHold.replace(p, st);
               this.musicWatch.setPlaying(st.playing && !st.paused && !st.loading);
               break;
            }
            /* Any other newer state lands a held one first (Next, pause, seek...). The held state's
               baseline counts from when it arrived, so this one's seek check is still valid. */
            this.musicHold.resolve();
            /* End of a track (advance:"auto"), heard ~2 s later than DAWN sends it: hold it until
               the buffered audio has played out (see music-hold.ts). */
            const buffered = this.music.bufferedLeadMs();
            if (p.advance === "auto" && this.prevMusicPlaying && buffered > 0) {
               this.musicHold.hold(p, st, buffered);
               /* A natural stop or a loading next track: DAWN sends no audio meanwhile (what's left
                  is buffered), so the watch stops expecting it. A ready next track keeps it. */
               this.musicWatch.setPlaying(st.playing && !st.paused && !st.loading);
               /* Count the heard track to its end while the next one's position ticks are ignored. */
               if (this.prevMusicDuration > 0) {
                  this.sinks.music.setPosition(
                     Math.max(0, this.prevMusicDuration - this.musicHold.remainingSec()),
                     this.prevMusicDuration
                  );
               }
               break;
            }
            this.applyMusicState(p, st);
            break;
         }

         case "music_position": {
            /* While a state is held, ticks describe the NEXT track: keep counting the heard one. */
            if (this.musicHold.peek()) break;
            const posSec = Number(p.position_sec ?? 0);
            /* Keep the seek-detection baseline fresh: position ticks (~1/s) are the only
               frames during steady playback, so without this the projection above would
               drift a whole track's length between control echoes. */
            this.prevMusicPos = posSec;
            this.prevMusicPosAt = performance.now();
            this.sinks.music.setPosition(
               this.music.audiblePosition(posSec),
               Number(p.duration_sec ?? 0)
            );
            break;
         }

         case "music_queue_response": {
            const q = Array.isArray(p.queue) ? (p.queue as Array<Record<string, unknown>>) : [];
            this.sinks.music.setQueue?.({
               tracks: q.map(toMusicTrack),
               currentIndex: Number(p.current_index ?? 0)
            });
            break;
         }

         case "music_search_response": {
            const r = Array.isArray(p.results) ? (p.results as Array<Record<string, unknown>>) : [];
            this.sinks.music.setSearchResults?.(str(p.query), r.map(toMusicTrack));
            break;
         }

         case "music_library_response": {
            const page = toLibraryPage(p);
            if (page) this.sinks.music.setLibrary?.(page);
            break;
         }

         case "music_error":
            /* A declined "previous" (nothing earlier: the queue's start, or shuffle with no history
               yet) isn't an error and changes nothing: playback goes on, so the watch expects its
               audio again (the previous had paused that expectation) and it's logged quietly. */
            if (p.code === "NOTHING_EARLIER") {
               this.musicWatch.setPlaying(this.prevMusicPlaying);
               this.sinks.music.setError(str(p.message, "Nothing earlier to go back to"), "info");
               console.info("[dawn] music: nothing earlier to go back to");
               break;
            }
            /* DAWN can stop streaming on an error without a music_state (a failed auto-advance
               decode), so stop expecting audio until the next music_state says playing again. */
            this.musicWatch.setPlaying(false);
            this.sinks.music.setError(str(p.message, str(p.code, "Music error")));
            /* The queue and library section's own refusals: it stops waiting and says so. */
            if (MUSIC_SECTION_ERRORS.has(str(p.code)))
               this.sinks.music.setLibraryError?.(str(p.code), str(p.message));
            console.warn("[dawn] music_error:", p.code, p.message);
            break;
      }
   }

   /* Apply one music_state to the player, the watch and the view.

      Flush the decode buffer on a USER-initiated track change or seek so the new audio starts
      at once instead of after the old lead drains. A natural end-of-track advance is tagged
      advance:"auto" by the server (gapless: the next track is already in our buffered lead) -
      do NOT flush that, or we truncate ~2 s of good audio. A natural stop at the end of the
      queue is tagged too: it arrives once the buffer has played out (held, see music_state), and
      is neither flushed nor muted, so the tail always finishes.

      DAWN re-emits an untagged music_state on EVERY control (volume, pause, shuffle, repeat,
      ...) carrying the current position, and sends no music_state during steady playback (only
      music_position ticks). So a real seek can't be told from a routine control echo by a raw
      position delta - that would flush good audio on a plain volume nudge. Instead compare the
      reported position to where playback should be by now (last known position projected
      forward by wall-clock while playing); only a genuine jump past a small tolerance is a
      seek. The baseline is refreshed by both state and position frames. `arrivedAt`: a held state
      applied late; DAWN's position for it counts from when it arrived, so that is its baseline
      time (else a control echo right after would read the ~2 s gap as a seek and flush). */
   private applyMusicState(p: Record<string, unknown>, st: MusicState, arrivedAt?: number): void {
      const now = performance.now();
      const noSeekCheck = arrivedAt !== undefined; // its own ~0 position is a track start, not a seek
      const elapsedSec = this.prevMusicPlaying
         ? Math.max(0, (now - this.prevMusicPosAt) / 1000)
         : 0;
      const projected = this.prevMusicPos + elapsedSec;
      const seen = this.prevMusicIndex !== null;
      const nowPlaying = st.playing && !st.paused;
      const autoAdvance = p.advance === "auto";
      /* A different file at the same index is a new track too (a new song played into index 0). */
      /* By the track itself when both paths are known: the queue position alone can change under a
         playing track (another tab replaced the shared queue, and this client plays on with
         queue_index -1, or the track sits at a new position), which is no track change and must not
         flush. The position is the fallback when a path is missing. */
      const path = st.track?.path ?? "";
      const trackChanged =
         seen &&
         (path && this.prevMusicPath
            ? path !== this.prevMusicPath
            : st.queueIndex !== this.prevMusicIndex);
      const seeked =
         seen && !noSeekCheck && Math.abs(st.positionSec - projected) > MUSIC_SEEK_TOLERANCE_SEC;
      /* Stop (not pause) resets the server position to 0, so its buffered lead is stale - flush
         it. Pause keeps position, so it is NOT a flush (see below). */
      const stopped = seen && this.prevMusicPlaying && !nowPlaying && !st.paused;
      /* The first state after a (re)connect has no baseline, but the buffered lead may be from
         before the drop (frozen by a pause, or not yet played out). It's only still good for the
         same track, playing or paused; a stop (a restarted DAWN comes back stopped) or another
         track makes it stale, and unpausing would play it. */
      const staleAfterDrop =
         !seen &&
         this.prevMusicPath !== "" &&
         ((!st.playing && !st.paused) || path !== this.prevMusicPath);
      /* Flushed before any unpause below, so none of it plays. */
      if ((stopped || trackChanged || seeked || staleAfterDrop) && !autoAdvance) this.music.flush();
      /* Pause freezes output while KEEPING the buffered lead (seamless resume, no ~2 s tail after
         the press and no ~2 s skip on resume); play resumes it. */
      this.music.setPaused(st.paused === true);
      /* Loading (DAWN fetching or opening the next track): no audio to expect meanwhile. */
      this.musicWatch.setPlaying(nowPlaying && !st.loading);
      this.prevMusicIndex = st.queueIndex;
      this.prevMusicPath = st.track?.path ?? "";
      this.prevMusicDuration = st.durationSec;
      this.prevMusicPos = st.positionSec;
      this.prevMusicPosAt = arrivedAt ?? now;
      this.prevMusicPlaying = nowPlaying && !st.loading; // a loading track's position doesn't move
      /* A seek waiting for its track to open (musicControl's seek-while-held). */
      const ps = this.pendingMusicSeek;
      if (ps && !st.loading) {
         this.pendingMusicSeek = null;
         /* By the track itself when both paths are known (the queue can move under it), else by position. */
         const path = st.track?.path ?? "";
         if (st.playing && (path && ps.path ? path === ps.path : st.queueIndex === ps.index)) {
            this.send({ type: "music_control", payload: { action: "seek", ...ps.params } });
         }
      }
      /* A stop gets no further position ticks: reset the bar rather than freeze it at the old end. */
      const shown = st.playing || st.paused ? this.music.audiblePosition(st.positionSec) : 0;
      this.sinks.music.setState({ ...st, positionSec: shown });
   }

   /* Music transport: a music_control write (Tier C, a deliberate user action). A held end-of-
      track state is resolved first (DAWN has already moved past what's heard):
      - next: if the held state is a playing next track, DAWN is already on it, so "next" means
        that track from the start (play_index), not the one after it;
      - seek: the seek is within the heard track, so drop the held state and go back to it
        (play_index) before seeking;
      - pause or next on a held natural stop: the queue already ended in DAWN; stop here, send
        nothing. previous on it steps back from the heard track (DAWN has reset to index 0). */
   musicControl(action: string, params: Record<string, unknown> = {}): void {
      this.pendingMusicSeek = null; // a newer control replaces a seek still waiting for its track
      const held = this.musicHold.peek();
      if (held) {
         /* The heard track's queue position, or null when unknown or not in the shared queue any more
            (queue_index -1: another client replaced the queue): never sent as a play_index. */
         const heardIndex =
            this.prevMusicIndex !== null && this.prevMusicIndex >= 0 ? this.prevMusicIndex : null;
         const movedOn =
            held.state.playing &&
            held.state.queueIndex >= 0 &&
            held.state.queueIndex !== heardIndex;
         if (action === "seek") {
            if (heardIndex !== null) {
               this.musicHold.drop();
               this.musicWatch.setPlaying(false); // a play_index (maybe a Plex fetch): no audio until its echo
               this.send({
                  type: "music_control",
                  payload: { action: "play_index", index: heardIndex }
               });
               /* DAWN ignores a seek while a track is still opening (a Plex fetch), so seek once
                  it reports the track ready (applyMusicState). */
               this.pendingMusicSeek = { index: heardIndex, path: this.prevMusicPath, params };
               return;
            }
            /* The heard track isn't in the shared queue any more, so there's no way back to it that
               leaves the queue alone (play {path} inserts it for every client). Ignore the seek rather
               than land it in the next song, which DAWN is already on: the heard track plays out and
               the next one lands on time. */
            return;
         } else if ((action === "pause" || action === "next") && !held.state.playing) {
            /* The queue already ended in DAWN: stop here. (Next on the last track does nothing, as
               it would have a moment earlier.) */
            this.musicHold.resolve();
            this.music.flush();
            return;
         } else if (action === "previous" && !held.state.playing && heardIndex !== null) {
            /* DAWN reset to index 0 at the end of the queue: step back from the heard track. */
            this.musicHold.resolve();
            action = "play_index";
            params = { index: Math.max(0, heardIndex - 1) };
         } else if (action === "next" && movedOn) {
            this.musicHold.resolve();
            action = "play_index";
            params = { index: held.state.queueIndex };
         } else if (
            action === "previous" &&
            movedOn &&
            heardIndex !== null &&
            heardIndex > 0 &&
            !held.state.shuffle
         ) {
            /* DAWN is already one past the heard track, so its "previous" would replay the heard one. */
            this.musicHold.resolve();
            action = "play_index";
            params = { index: heardIndex - 1 };
         } else {
            this.musicHold.resolve();
         }
      }
      /* A control that changes the track can make DAWN fetch it on its main thread first (a Plex
         download), with nothing reaching us meanwhile: expect no audio until its music_state. */
      if (
         action === "next" ||
         action === "previous" ||
         action === "play_index" ||
         action === "play"
      ) {
         this.musicWatch.setPlaying(false);
      }
      this.send({ type: "music_control", payload: { action, ...params } });
      /* The dedicated socket is the only audio path now, so a control the user issued
         while it's down (retries exhausted) would play silently. Treat the action as
         fresh intent: re-arm the retry counter and reconnect so "press play again"
         recovers. Cheap - openMusicStream is idempotent when a live socket exists. */
      if (this.musicEnabled && !this.musicWs) {
         const token = this.getToken();
         if (token) {
            this.musicWsFails = 0;
            this.musicStalls = 0;
            this.musicUnavailable = false;
            this.openMusicStream(token);
         }
      }
   }

   /* Reads for the player's queue and library section (answers route to the music sink). */
   musicQueueList(): void {
      this.send({ type: "music_queue", payload: { action: "list" } });
   }

   musicSearch(query: string): void {
      const q = query.trim();
      if (q) this.send({ type: "music_search", payload: { query: q.slice(0, 200), limit: 100 } });
   }

   musicLibrary(type: string, params: Record<string, unknown> = {}): void {
      this.send({ type: "music_library", payload: { type, ...params } });
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

   /* Open the dedicated dawn-music stream socket and authenticate it with the session
      token. Once DAWN sees it (set_stream_wsi) it streams music audio here, each frame
      as [0x20][uint16-LE len][opus] (the daemon prepends the WS_BIN_MUSIC_DATA opcode).
      This is the SOLE music transport: DAWN removed the legacy main-socket path, so a
      failure to attach means no audio, not a degrade - hence the give-up in
      scheduleMusicReconnect surfaces an error. */
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
      if (live && this.musicWsToken === token) return; // keeps its auth state: buffer reports go on
      this.closeMusicStream(); // clears musicWsAuthed for the new socket
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
      this.musicWatch.opened();

      ws.onopen = (): void => ws.send(JSON.stringify({ type: "auth", token }));

      ws.onmessage = (ev: MessageEvent): void => {
         if (ev.data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(ev.data);
            if (bytes.length === 0) return;
            this.musicWatch.audio();
            this.musicStalls = 0;
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
               this.musicWatch.attached();
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
         if (this.musicWs !== ws) return; // a replaced socket's late close
         this.musicWs = null;
         this.musicWatch.stop();
         this.scheduleMusicReconnect();
      };
      ws.onerror = (): void => {
         /* onclose fires right after and handles the reconnect. */
      };
   }

   private scheduleMusicReconnect(): void {
      if (!this.wantConnected || !this.musicEnabled) return;
      if (this.musicWsFails >= MUSIC_WS_MAX_FAILS) {
         this.musicGiveUp(`${MUSIC_WS_MAX_FAILS} attempts`);
         return;
      }
      const token = this.getToken();
      if (!token) return;
      this.musicWsFails++;
      const delay = Math.min(15000, 1000 * 2 ** (this.musicWsFails - 1));
      window.clearTimeout(this.musicWsTimer);
      this.musicWsTimer = window.setTimeout(() => this.openMusicStream(token), delay);
   }

   /* This socket is the only music transport, so giving up means there is no audio path at all -
      surface it once (not silent silence). A later music_control re-arms the retries (see
      musicControl). auth_ok clears it. */
   private musicGiveUp(why: string): void {
      if (this.musicUnavailable) return;
      this.musicUnavailable = true;
      this.sinks.music.setError("Music stream unavailable");
      console.warn("[dawn] music stream: giving up after", why);
   }

   /* The watch found the socket dead without a close: replace it through the normal retries. A
      connect timeout counts as a failed attempt there. A stall doesn't (the socket did attach, and
      auth_ok resets that count), so stalls are capped on their own: when fresh sockets keep getting
      nothing while DAWN says "playing", the silence is DAWN's and another replacement won't help.
      The cap still reconnects (so audio plays the moment DAWN sends it) but stops judging the socket
      by silence until audio arrives or playback starts again. */
   private onMusicSocketDead(reason: MusicDeadReason): void {
      console.warn(
         reason === "connect"
            ? "[dawn] music stream: no auth_ok in time, reconnecting"
            : "[dawn] music stream: no audio while playing, reconnecting"
      );
      this.closeMusicStream();
      if (reason === "stall" && ++this.musicStalls >= MUSIC_MAX_STALLS) {
         this.musicWatch.holdStalls();
         this.musicGiveUp(`${MUSIC_MAX_STALLS} silent reconnects`);
      }
      this.scheduleMusicReconnect();
   }

   closeMusicStream(): void {
      window.clearTimeout(this.musicWsTimer);
      this.musicWatch.stop();
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

   /* Final teardown (HMR / unmount). */
   dispose(): void {
      this.music.dispose();
   }
}
