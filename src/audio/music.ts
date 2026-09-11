/*
 * Music audio pipeline. DAWN streams music as Opus (unlike TTS, which we get as
 * raw PCM), so the browser must decode it: WebCodecs AudioDecoder -> AudioWorklet
 * ring buffer -> gain -> analyser -> speakers. Frames arrive on the dedicated
 * dawn-music socket as [0x20][uint16-LE len][opus...]; DawnIngest strips the 0x20
 * opcode and hands us the [len][opus] payload. An analyser tap feeds the spectrum meter.
 *
 * Closed-loop flow control: the server paces music to hold a ~2 s cushion on us so
 * a TTS CPU burst can't drain the buffer to a stutter, but only if we report our
 * total buffered depth back up the music socket. We report worklet ring depth PLUS
 * the WebCodecs decode-input backlog (decode callbacks run on the main thread, so
 * under load the server's frames pile up in the decoder queue, not the worklet -
 * counting only the worklet reads "empty" and makes the server flood us). The
 * reporter is owned by the ingest (it holds the socket); we invoke it per report.
 *
 * This lives below the render seam: it is audio, not pixels. The reference is
 * DAWN's own WebUI player; the decode/worklet chain is lifted from it.
 */

import { audioDataToChannels, decodeOpusFrames } from "./webcodecs.ts";

const OPUS_RATE = 48000; // Opus (and thus our AudioContext) is always 48 kHz stereo
const MUSIC_FRAME_MS = 20; // one Opus frame = 960 samples @ 48 kHz; converts decode backlog to ms
const VOL_KEY = "dawn.hero.musicVol";
const DECODER_REBUILD_WINDOW_MS = 3000; // rolling window for throttling decoder rebuilds
const DECODER_REBUILD_MAX = 5; // rebuilds allowed per window before giving up on the stream
const BUFFERED_MS_MAX = 10000; // clamp our reported depth (matches DAWN WEBUI_MUSIC_CLIENT_BUFFER_MAX_MS)

export class MusicAudio {
   private ctx: AudioContext | null = null;
   private decoder: AudioDecoder | null = null;
   private worklet: AudioWorkletNode | null = null;
   private gain: GainNode | null = null;
   private analyser: AnalyserNode | null = null;
   private freq: Uint8Array<ArrayBuffer> | null = null;
   private ts = 0; // running decode timestamp (microseconds), +20 ms per frame
   private ready = false;
   private paused = false; // deliberately paused: the context is suspended, keep it that way
   private initing: Promise<void> | null = null;
   private bufferPercent = 0;
   private bufferedMs = 0; // total client-side buffered audio (worklet ring + decode queue)
   private lastReportedMs = -1; // last depth actually sent upstream (-1 = none yet); gates idle spam
   private decoderConfig: AudioDecoderConfig | null = null; // stored so a decode error can rebuild
   private decoderRebuilds = 0; // rebuilds within the current error window (throttle)
   private decoderWindowAt = 0; // performance.now() when the current error window opened
   private volume = clampVol(Number(localStorage.getItem(VOL_KEY) ?? 0.8));
   private muted = false;
   private onError: (msg: string) => void = () => {};
   private reportBuffer: (bufferedMs: number) => void = () => {};
   private readonly resumeOnGesture: () => void;

   /* Surface a fatal audio-setup problem (e.g. no secure context) to the UI. */
   setErrorHandler(fn: (msg: string) => void): void {
      this.onError = fn;
   }

   /* Register the closed-loop buffer reporter. The ingest owns the music socket, so
      it passes a sender here; we call it every worklet report (~32 ms) with our TOTAL
      buffered depth. A no-op until set, and harmless if the socket isn't attached. */
   setBufferReporter(fn: (bufferedMs: number) => void): void {
      this.reportBuffer = fn;
   }

   /* Convert a raw server position to the audible position. The server streams a ~2 s
      lead, so its reported position runs ahead of what is playing by our buffered depth;
      subtract it (floored at 0) so the progress bar tracks playback, not decode. */
   audiblePosition(rawSec: number): number {
      return Math.max(0, rawSec - this.bufferedMs / 1000);
   }

   constructor() {
      /* AudioContext can only start after a user gesture. The user has almost
         always clicked/typed before music plays, but resume once on the first
         gesture as a guarantee. Held as a field so dispose() can drop it if no
         gesture ever fired (otherwise the {once} listener pins this instance). */
      this.resumeOnGesture = (): void => void this.ctx?.resume();
      window.addEventListener("pointerdown", this.resumeOnGesture, { once: true, passive: true });
   }

   /* Release the whole decode/audio graph. Called on final teardown (HMR dispose),
      NOT on an in-session disconnect - a reconnect reuses the lazily-built context. */
   dispose(): void {
      window.removeEventListener("pointerdown", this.resumeOnGesture);
      try {
         if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
      } catch {
         /* already closed */
      }
      this.decoder = null;
      if (this.worklet) this.worklet.port.onmessage = null;
      try {
         this.worklet?.disconnect();
         this.gain?.disconnect();
         this.analyser?.disconnect();
      } catch {
         /* nodes already detached */
      }
      this.worklet = null;
      this.gain = null;
      this.analyser = null;
      this.freq = null;
      if (this.ctx && this.ctx.state !== "closed") void this.ctx.close().catch(() => {});
      this.ctx = null;
      this.ready = false;
      this.paused = false;
      this.initing = null;
      this.bufferedMs = 0;
      this.lastReportedMs = -1;
      this.decoderConfig = null;
   }

   /* Feed one binary music payload (opcode already stripped by DawnIngest): a run of
      length-prefixed Opus frames. Lazily boots the decode graph on first frame. */
   async pushFrame(payload: Uint8Array): Promise<void> {
      if (!this.ready) await this.init();
      /* Auto-resume a context suspended by the autoplay policy, but NOT one we suspended
         to pause: a straggler frame arriving mid-pause must not un-pause playback. */
      if (this.ctx?.state === "suspended" && !this.paused) await this.ctx.resume();
      const dec = this.decoder;
      if (!dec || dec.state === "closed") return;
      /* Walk the [uint16-LE len][opus] run; cap frame length at 1500 (a music packet is
         well under that) so a corrupt length can't run the parser off the buffer. */
      this.ts = decodeOpusFrames(dec, payload, this.ts, MUSIC_FRAME_MS * 1000, 1500);
   }

   private init(): Promise<void> {
      if (this.ready) return Promise.resolve();
      if (!this.initing) this.initing = this.boot();
      return this.initing;
   }

   private async boot(): Promise<void> {
      /* WebCodecs (AudioDecoder) and AudioWorklet are secure-context ONLY. localhost
         counts as secure over http, but a network origin (http://<ip>:5273) does not,
         so music decode silently dies there. Fail loudly and actionably instead. */
      if (!window.isSecureContext || typeof AudioDecoder === "undefined") {
         const msg = "Music audio needs a secure context. Open the dashboard over https:// (or via localhost); a plain http://<ip> origin cannot decode audio.";
         console.error(
            `[music] ${msg} isSecureContext=${window.isSecureContext}, AudioDecoder=${typeof AudioDecoder}, origin=${window.location.origin}`
         );
         this.onError("Music audio needs HTTPS on this origin");
         return;
      }

      this.ctx = new AudioContext({ sampleRate: OPUS_RATE });
      if (this.ctx.sampleRate !== OPUS_RATE) {
         console.warn(`[music] wanted 48kHz, got ${this.ctx.sampleRate}; playback may be off-speed`);
      }
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.muted ? 0 : this.volume;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.6;
      this.analyser.minDecibels = -70;
      this.analyser.maxDecibels = -10;
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      this.gain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);

      if (typeof AudioDecoder === "undefined") {
         console.error("[music] WebCodecs AudioDecoder unavailable; no music audio");
         return;
      }
      const cfg: AudioDecoderConfig = { codec: "opus", sampleRate: OPUS_RATE, numberOfChannels: 2 };
      const support = await AudioDecoder.isConfigSupported(cfg);
      if (!support.supported) {
         console.error("[music] stereo 48kHz Opus decode unsupported");
         return;
      }
      this.decoderConfig = cfg;
      this.buildDecoder();

      try {
         /* Loaded from public/worklets/ (not bundled) so it stays a real same-origin
            script under DAWN's CSP (script-src 'self'). A bundled worklet under Vite's
            inline limit becomes a data: URI, which DAWN's script-src refuses. */
         await this.ctx.audioWorklet.addModule(
            `${import.meta.env.BASE_URL}worklets/music-worklet.js`
         );
      } catch (e) {
         console.error("[music] AudioWorklet unavailable (needs a secure context):", e);
         this.onError("Music audio needs HTTPS on this origin");
         return;
      }
      this.worklet = new AudioWorkletNode(this.ctx, "music-processor", { outputChannelCount: [2] });
      this.worklet.connect(this.gain);
      this.worklet.port.onmessage = (e: MessageEvent): void => {
         if (e.data?.type !== "buffer") return;
         this.bufferPercent = e.data.percent as number;
         if (typeof e.data.bufferedMs === "number") {
            /* Total buffered = worklet ring depth PLUS the WebCodecs decode-input
               backlog. Reporting worklet-only reads "empty" under main-thread load
               and makes the server burst until it floods the decode queue. Clamp to the
               server's own ceiling so a runaway decode backlog can't over-report. */
            const dec = this.decoder;
            const backlogMs = dec && dec.decodeQueueSize ? dec.decodeQueueSize * MUSIC_FRAME_MS : 0;
            this.bufferedMs = Math.min(BUFFERED_MS_MAX, (e.data.bufferedMs as number) + backlogMs);
            /* Gate the upstream send on activity: the worklet reports ~31/s for the whole
               life of the node, but while nothing plays that is just "0" the server can't
               use. Send every non-zero depth, plus the single 0 that marks a drain (so the
               server refills fast), then go quiet until audio flows again. */
            if (this.bufferedMs !== 0 || this.lastReportedMs !== 0) {
               this.reportBuffer(this.bufferedMs);
               this.lastReportedMs = this.bufferedMs;
            }
         }
      };
      this.ready = true;
   }

   /* Create + configure the Opus decoder. Factored out so a fatal decode error can
      rebuild it: a WebCodecs decoder is single-use, an error closes it permanently, so
      recovery is a fresh instance, not a reconfigure. Returns false if it can't build. */
   private buildDecoder(): boolean {
      if (!this.decoderConfig || typeof AudioDecoder === "undefined") return false;
      /* A fatal error auto-closes the prior decoder, but if one is somehow still open
         (a manual rebuild path, an edge impl), close it so we don't leak it on replace. */
      if (this.decoder && this.decoder.state !== "closed") {
         try {
            this.decoder.close();
         } catch {
            /* already closing */
         }
      }
      try {
         const dec = new AudioDecoder({
            output: (d) => this.onDecoded(d),
            error: (e) => this.onDecoderError(e)
         });
         dec.configure(this.decoderConfig);
         this.decoder = dec;
         return true;
      } catch (e) {
         console.error("[music] failed to build Opus decoder:", e);
         this.decoder = null;
         return false;
      }
   }

   /* A fatal decode error closes the decoder for good (one bad packet from a network
      hiccup or a mid-frame server ring-drop is enough). Rather than go silent until the
      next reconnect, rebuild so subsequent frames decode - the audio already in the
      worklet ring keeps playing, so recovery is a brief gap, not a stop. Throttle it: a
      genuinely broken stream would otherwise thrash, so after a burst give up and surface
      it. A flush (seek / track change) re-arms recovery. */
   private onDecoderError(e: unknown): void {
      console.warn("[music] decoder error, rebuilding:", e);
      if (!this.ready) return; // teardown in progress
      const now = performance.now();
      if (now - this.decoderWindowAt > DECODER_REBUILD_WINDOW_MS) {
         this.decoderWindowAt = now;
         this.decoderRebuilds = 0;
      }
      if (++this.decoderRebuilds > DECODER_REBUILD_MAX) {
         console.error("[music] decoder failing repeatedly; giving up until the next seek/track");
         this.onError("Music decode error");
         this.decoder = null;
         return;
      }
      this.buildDecoder();
   }

   /* WebCodecs hands back decoded PCM in one of several layouts; normalize to channels
      (upmixing mono to stereo) and ship them to the worklet as transferables. */
   private onDecoded(data: AudioData): void {
      try {
         const chans = audioDataToChannels(data);
         const left = chans[0];
         if (!left) return; // unknown layout
         /* Mono -> a DISTINCT copy for the right channel: left/right are transferred as
            separate buffers, and transferring one buffer twice would throw. */
         const right = chans[1] ?? left.slice();
         this.worklet?.port.postMessage({ type: "audio", left, right }, [left.buffer, right.buffer]);
      } catch (e) {
         console.warn("[music] decoded-audio handling failed:", e);
      } finally {
         data.close();
      }
   }

   /* Live frequency data for the player's spectrum meter (null until playing). */
   getSpectrum(): Uint8Array<ArrayBuffer> | null {
      if (!this.analyser || !this.freq) return null;
      this.analyser.getByteFrequencyData(this.freq);
      return this.freq;
   }

   /* Flush buffered audio (on seek / track change) so new audio starts at once
      instead of after the old buffer drains. */
   /* Pause / resume playback by suspending the AudioContext rather than flushing. DAWN
      stops the stream on pause, but the client holds a ~2 s decoded lead that would
      otherwise keep playing for ~2 s after the button press. Suspending stops output at
      once and PRESERVES that buffer, so resume is seamless - unlike a flush, which would
      discard the lead and make resume skip ~2 s of the track. Safe without a fresh user
      gesture: the context was already started by the initial play gesture. */
   setPaused(paused: boolean): void {
      this.paused = paused;
      if (!this.ctx) return;
      if (paused) {
         if (this.ctx.state === "running") void this.ctx.suspend().catch(() => {});
      } else if (this.ctx.state === "suspended") {
         void this.ctx.resume().catch(() => {});
      }
   }

   flush(): void {
      this.ts = 0;
      this.bufferedMs = 0; // the worklet's clear also re-reports 0, but correct getBufferedMs now
      this.worklet?.port.postMessage({ type: "clear" });
      /* A seek / track change is a fresh start: re-arm the rebuild throttle and revive the
         decoder if a prior error burst left us without a live one, so playback resumes. */
      this.decoderRebuilds = 0;
      this.decoderWindowAt = 0;
      if (this.ready && (!this.decoder || this.decoder.state === "closed")) this.buildDecoder();
   }

   getBufferPercent(): number {
      return this.bufferPercent;
   }

   getVolume(): number {
      return this.volume;
   }
   isMuted(): boolean {
      return this.muted;
   }
   setVolume(v: number): void {
      this.volume = clampVol(v);
      localStorage.setItem(VOL_KEY, String(this.volume));
      if (this.gain && !this.muted) this.gain.gain.value = this.volume;
   }
   setMuted(on: boolean): void {
      this.muted = on;
      if (this.gain) this.gain.gain.value = on ? 0 : this.volume;
   }
}

function clampVol(v: number): number {
   if (!Number.isFinite(v)) return 0.8;
   return Math.min(1, Math.max(0, v));
}
