/*
 * Microphone capture. The input counterpart to tts.ts / music.ts: it opens the mic,
 * taps an AnalyserNode to drive the reactor's bar ring while the user speaks (the same
 * onLevels feed TTS uses), and runs the audio through a capture worklet that emits
 * little-endian Int16 PCM chunks. Two modes share one acquire/graph:
 *   - push-to-talk: pttStart() ... pttEnd()  (a single utterance)
 *   - continuous:   continuousStart() ... continuousStop()  (open mic; DAWN's VAD)
 *
 * The class owns the audio graph and lifecycle ONLY; it knows nothing about the
 * WebSocket. Captured chunks and the utterance-end signal leave through callbacks so
 * the ingest (the single DAWN boundary) does the actual send. Chunks are Opus-encoded in
 * a worker when the session negotiated Opus (setEncoding), else handed up as raw Int16.
 *
 * Conventions mirror MusicAudio: secure-context gate, addModule(new URL(...)), port
 * messaging with transferables, a stop()/dispose() split (stop releases the mic but
 * keeps the context for reuse; dispose closes it), an in-flight-start guard so a fast
 * release cannot race acquisition, and a held one-gesture resume listener removed in
 * dispose. DAWN's ASR pipeline is 48 kHz-only, so a context the browser hands back at
 * any other rate is unusable and the mic disables itself. Below the render seam.
 */

const MIC_RATE = 48000; // DAWN's ASR is 48k-only; any other context rate is unusable (guarded)
const FFT_SIZE = 256;
const DEFAULT_CHUNK_MS = 100; // until the server config frame supplies audio_chunk_ms
const WORKLET_FLUSH_MS = 60; // let the worklet flush its partial buffer before we tear down
const DEVICE_KEY = "aurora.micDevice"; // persisted input-device id ("" = system default)

/* An input device the user can pick (from enumerateDevices). */
export interface MicDevice {
   id: string; // "" = system default
   label: string;
}

/* Opus encode config - matches DAWN's opus-worker.js exactly (48 kHz mono, 24 kbps,
   20 ms frames, VoIP/voice, DTX). Shared: the main thread uses it for the support probe,
   the encode worker configures the AudioEncoder with it. */
const OPUS_CONFIG = {
   codec: "opus",
   sampleRate: MIC_RATE,
   numberOfChannels: 1,
   bitrate: 24000,
   opus: { application: "voip", signal: "voice", frameDuration: 20000, complexity: 5, usedtx: true }
} as const;

export type MicCaptureState = "idle" | "recording" | "listening" | "error" | "unavailable";

export interface MicCallbacks {
   /* Normalized (0..1) frequency bins while capturing; null when capture stops. */
   onLevels: (bins: Float32Array | null) => void;
   /* One captured PCM chunk (little-endian Int16). Optional until a send path exists. */
   onFrame?: (payload: Uint8Array) => void;
   /* A push-to-talk utterance has fully flushed; the boundary should send AUDIO_IN_END. */
   onEnd?: () => void;
   /* Capture state changed (drives the mic-button chrome). */
   onState: (s: MicCaptureState) => void;
   /* An actionable problem (permission denied, wrong sample rate, mic revoked). */
   onError: (msg: string) => void;
}

/* The control surface the composer's mic button binds to (via the ingest). */
export interface MicControl {
   available(): boolean;
   pttStart(): void;
   pttCommit(): void;
   pttEnd(): void;
   pttCancel(): void;
   toggleContinuous(): void;
   onState(cb: (s: MicCaptureState) => void): void;
   /* Input-device selection (the System-menu Microphone picker). */
   listDevices(): Promise<MicDevice[]>;
   currentDevice(): string;
   setDevice(id: string): void;
}

export class MicCapture {
   private ctx: AudioContext | null = null;
   private stream: MediaStream | null = null;
   private source: MediaStreamAudioSourceNode | null = null;
   private analyser: AnalyserNode | null = null;
   private worklet: AudioWorkletNode | null = null;
   private sink: GainNode | null = null; // zero-gain path to destination so the graph renders (no echo)
   private encoder: Worker | null = null; // Opus encode worker (when useOpus); null = raw PCM
   private useOpus = false; // locked per session by the ingest from the handshake codec
   opusSupported = false; // AudioEncoder can do the Opus config (async-probed at construction)
   private freq: Uint8Array<ArrayBuffer> = new Uint8Array(FFT_SIZE / 2);
   private levels = new Float32Array(FFT_SIZE / 2);
   private raf = 0;
   private mode: "ptt" | "continuous" | null = null;
   private muted = false;
   private wantContinuous = false; // intent latch for continuous, survives the async start window
   /* Capture-from-pointerdown: a push-to-talk gesture captures immediately (so the first
      word is never clipped) but holds its chunks here until the gesture is confirmed a
      hold (pttCommit). A tap discards them, so a tap never sends audio nor seeds an orphan
      buffer on the server. Once committed, chunks stream straight through. */
   private pending: Uint8Array[] = [];
   private committed = false;
   private chunkMs = DEFAULT_CHUNK_MS;
   private workletLoaded = false;
   private startPromise: Promise<void> | null = null;
   private ending: Promise<void> | null = null; // an in-flight PTT teardown, so the next op can await it
   private acquireGen = 0; // bumped by begin()/stop() so an in-flight acquire can detect it's stale
   private disposed = false; // dispose() ran; an in-flight acquire must not rebuild the graph
   private rateUnusable = false; // sticky: a non-48k context was seen -> the mic is unusable
   private deviceId = localStorage.getItem(DEVICE_KEY) ?? ""; // "" = system default input
   private readonly cb: MicCallbacks;
   private readonly resumeOnGesture: () => void;
   /* Static capture capability: secure context + getUserMedia + AudioWorklet. Opus
      encode is a separate optional upgrade, so it is NOT required here. */
   readonly supported: boolean;

   constructor(cb: MicCallbacks) {
      this.cb = cb;
      this.supported =
         window.isSecureContext &&
         typeof navigator !== "undefined" &&
         !!navigator.mediaDevices?.getUserMedia &&
         typeof AudioWorkletNode !== "undefined";
      /* AudioContext resume needs a gesture; the user has always clicked before the mic
         is used, but resume once as a guarantee. Held so dispose() can drop it. */
      this.resumeOnGesture = (): void => void this.ctx?.resume();
      window.addEventListener("pointerdown", this.resumeOnGesture, { once: true, passive: true });
      /* Probe Opus encode support now (resolves well before the user connects + speaks),
         so the ingest can advertise the right codec in the handshake. */
      void this.probeOpus();
   }

   private async probeOpus(): Promise<void> {
      try {
         if (typeof AudioEncoder === "undefined") return;
         const s = await AudioEncoder.isConfigSupported(OPUS_CONFIG as unknown as AudioEncoderConfig);
         this.opusSupported = s.supported === true;
      } catch {
         this.opusSupported = false;
      }
   }

   /* The ingest locks the session codec from the handshake it sent DAWN: opus only if we
      both support it AND advertised it. Builds the encode worker on demand. */
   setEncoding(useOpus: boolean): void {
      this.useOpus = useOpus && this.opusSupported;
      if (this.useOpus && !this.encoder) {
         this.buildEncoder();
      } else if (!this.useOpus && this.encoder) {
         /* A reconnect renegotiated down to PCM: drop the now-idle encode worker. */
         this.encoder.onmessage = null;
         this.encoder.terminate();
         this.encoder = null;
      }
   }

   private buildEncoder(): void {
      this.encoder = new Worker(new URL("./opus-encode-worker.js", import.meta.url), {
         type: "module"
      });
      this.encoder.postMessage({ type: "config", config: OPUS_CONFIG });
      this.encoder.onmessage = (e: MessageEvent): void => {
         const m = e.data;
         if (m?.type === "encoded") this.handlePayload(new Uint8Array(m.data as ArrayBuffer));
         else if (m?.type === "end") this.cb.onEnd?.();
         else if (m?.type === "error") console.warn("[mic] opus encode error:", m.message);
      };
   }

   get available(): boolean {
      return this.supported && !this.rateUnusable;
   }

   /* The server's audio_chunk_ms (config frame); applied to the worklet on next acquire. */
   setChunkMs(ms: number): void {
      if (ms > 0) this.chunkMs = ms;
   }

   /* Input devices the user can choose from. Labels are only populated once mic permission
      has been granted (a fresh page shows blanks until the first capture). */
   async listDevices(): Promise<MicDevice[]> {
      const out: MicDevice[] = [{ id: "", label: "System default" }];
      try {
         const devs = await navigator.mediaDevices.enumerateDevices();
         for (const d of devs) {
            if (d.kind === "audioinput") out.push({ id: d.deviceId, label: d.label || "Microphone" });
         }
      } catch {
         /* enumeration blocked -> just the default */
      }
      return out;
   }

   getDevice(): string {
      return this.deviceId;
   }

   /* Pick an input device (persisted). Takes effect on the next capture; the caller
      re-latches continuous if it wants the change to apply immediately. */
   setDevice(id: string): void {
      this.deviceId = id;
      if (id) localStorage.setItem(DEVICE_KEY, id);
      else localStorage.removeItem(DEVICE_KEY);
   }

   // --- Push-to-talk -------------------------------------------------------

   pttStart(): void {
      if (this.mode) return; // already capturing
      this.begin("ptt");
   }

   /* The gesture crossed the hold threshold: it is a real utterance. Flush everything
      captured since pointerdown and stream live from here (first word preserved). */
   pttCommit(): void {
      if (this.mode !== "ptt" || this.committed) return;
      this.committed = true;
      for (const p of this.pending) this.cb.onFrame?.(p);
      this.pending = [];
   }

   /* One ready-to-send payload (a raw PCM chunk, or a length-prefixed Opus run): buffer it
      while a PTT gesture is still pending (a tap discards it), else stream it straight out. */
   private handlePayload(payload: Uint8Array): void {
      if (this.mode === "ptt" && !this.committed) this.pending.push(payload);
      else this.cb.onFrame?.(payload);
   }

   /* End a push-to-talk utterance: flush the worklet, release, and signal end. */
   pttEnd(): void {
      if (this.mode !== "ptt") return;
      this.ending = this.finishPtt(true);
   }

   /* Abort a push-to-talk gesture (a tap, or a cancelled press): release, send nothing. */
   pttCancel(): void {
      if (this.mode !== "ptt") return;
      this.ending = this.finishPtt(false);
   }

   // --- Continuous ---------------------------------------------------------

   /* Await any in-flight PTT teardown first: the tap gesture that latches continuous fires
      pttStart -> pttCancel (async) -> here, so `mode` may still be "ptt" for a moment. Without
      the await, begin() would bail on its `if (this.mode)` guard and we'd arm DAWN but never
      stream (silent listen). `wantContinuous` is the cancel token: a stop/disable/error that
      lands during the await clears it (continuousStop no-ops on mode, so `mode` alone can't
      cover this), and we bail rather than open an orphan mic with the ingest already off.
      initialMuted seeds the echo-mute when latching mid-TTS-reply. */
   async continuousStart(initialMuted = false): Promise<void> {
      this.wantContinuous = true;
      const pending = this.ending;
      if (pending) {
         try {
            await pending;
         } catch {
            /* the teardown surfaced its own error */
         }
      }
      if (!this.wantContinuous || this.mode || this.disposed) return;
      this.begin("continuous", initialMuted);
   }

   continuousStop(): void {
      this.wantContinuous = false; // clear the intent unconditionally (may run before mode flips)
      this.ending = null;
      if (this.mode !== "continuous") return;
      this.mode = null;
      this.stop();
      this.cb.onState("idle");
   }

   /* Echo mute: pause/resume the worklet stream without releasing the mic (continuous
      mode, while DAWN speaks). Also pauses the levels feed so the reactor is not fought. */
   setMuted(muted: boolean): void {
      if (this.muted === muted) return;
      this.muted = muted;
      if (this.mode !== "continuous") return;
      this.postWorklet(muted ? "stop" : "start");
      if (muted) {
         this.stopSampling();
         /* Drop whatever the encoder was mid-batch so the pre-mute tail isn't prepended
            to post-unmute audio (a fresh stream resumes on unmute). */
         if (this.useOpus && this.encoder) this.encoder.postMessage({ type: "reset" });
      } else {
         this.startSampling();
      }
   }

   // --- Lifecycle ----------------------------------------------------------

   /* Release the mic and capture graph but keep the AudioContext for reuse (like
      TtsPlayback.stop). Does not emit a state - the caller owns the visible state. */
   stop(): void {
      this.acquireGen++; // invalidate any in-flight acquire so it won't build/keep a graph
      this.stopSampling();
      this.postWorklet("stop");
      if (this.worklet) {
         this.worklet.port.onmessage = null;
         try {
            this.worklet.disconnect();
         } catch {
            /* already detached */
         }
         this.worklet = null;
      }
      if (this.source) {
         try {
            this.source.disconnect();
         } catch {
            /* already detached */
         }
         this.source = null;
      }
      /* Drop the analyser's output edge (kept node, fresh wiring next acquire) and the
         zero-gain sink so the render path is fully torn down. */
      try {
         this.analyser?.disconnect();
      } catch {
         /* already detached */
      }
      if (this.sink) {
         try {
            this.sink.disconnect();
         } catch {
            /* already detached */
         }
         this.sink = null;
      }
      if (this.stream) {
         for (const t of this.stream.getTracks()) {
            t.onended = null;
            t.stop();
         }
         this.stream = null;
      }
      if (this.ctx && this.ctx.state === "running") void this.ctx.suspend();
      this.mode = null;
      this.muted = false;
   }

   dispose(): void {
      this.disposed = true;
      window.removeEventListener("pointerdown", this.resumeOnGesture);
      this.stop();
      if (this.encoder) {
         this.encoder.onmessage = null;
         this.encoder.terminate();
         this.encoder = null;
      }
      if (this.analyser) {
         try {
            this.analyser.disconnect();
         } catch {
            /* already detached */
         }
         this.analyser = null;
      }
      if (this.ctx && this.ctx.state !== "closed") void this.ctx.close().catch(() => {});
      this.ctx = null;
      this.workletLoaded = false;
      this.startPromise = null;
   }

   // --- Internals ----------------------------------------------------------

   private begin(mode: "ptt" | "continuous", initialMuted = false): void {
      if (!this.available) {
         this.cb.onError(
            this.supported
               ? "Microphone unavailable on this device."
               : "Talking to DAWN needs a secure (https) connection."
         );
         this.cb.onState("unavailable");
         return;
      }
      /* PTT always starts live; continuous seeds its mute from the caller so latching while
         DAWN is mid-reply doesn't capture the ongoing TTS. */
      this.muted = mode === "continuous" ? initialMuted : false;
      this.mode = mode;
      this.pending = [];
      this.committed = mode === "continuous"; // continuous streams immediately; PTT waits for commit
      /* Discard any Opus residual the encoder holds from a prior tap/abandoned utterance,
         so this utterance's first frame isn't prefixed with stale audio (ASR mis-hears the
         opening word otherwise). Resetting at the START covers tap/cancel/disconnect alike. */
      if (this.useOpus && this.encoder) this.encoder.postMessage({ type: "reset" });
      const gen = ++this.acquireGen;
      this.cb.onState(mode === "ptt" ? "recording" : "listening");
      this.startPromise = this.acquire(gen).catch((e) => this.onAcquireError(e));
   }

   private async acquire(gen: number): Promise<void> {
      const stream = await navigator.mediaDevices.getUserMedia({
         audio: {
            ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : {}),
            sampleRate: MIC_RATE,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
         }
      });
      /* getUserMedia can block for seconds on the permission prompt. If a stop()/dispose()
         (or a newer begin) landed while we waited, this acquire is stale: release the mic
         we just got and bail BEFORE ensureContext, which would otherwise resurrect a fresh
         AudioContext onto a disposed instance (stuck OS mic light + stacked context). */
      if (gen !== this.acquireGen || this.disposed) {
         for (const t of stream.getTracks()) t.stop();
         return;
      }
      this.stream = stream;
      /* Detect an unplugged / OS-revoked mic so a latched session doesn't stream silence. */
      const track = this.stream.getAudioTracks()[0];
      if (track) track.onended = (): void => this.onTrackEnded();

      this.ensureContext();
      const ctx = this.ctx!;
      if (ctx.sampleRate !== MIC_RATE) {
         this.failRate(ctx.sampleRate);
         return;
      }
      if (ctx.state === "suspended") await ctx.resume();

      this.source = ctx.createMediaStreamSource(this.stream);
      /* A MediaStreamAudioSourceNode wired only to terminal nodes (analyser + a worklet
         with no downstream) is not pulled into the render graph in Chrome, so both read
         digital silence. Give the capture path a route to the destination through a
         zero-gain node: the graph renders, but nothing reaches the speakers (no echo). */
      this.sink = ctx.createGain();
      this.sink.gain.value = 0;
      this.sink.connect(ctx.destination);
      this.source.connect(this.analyser!);
      this.analyser!.connect(this.sink);

      if (!this.workletLoaded) {
         /* From public/worklets/ (not bundled) so it stays a real same-origin script
            under DAWN's CSP; a bundled sub-inline-limit worklet becomes a data: URI that
            script-src refuses. Mirrors MusicAudio. */
         await ctx.audioWorklet.addModule(
            `${import.meta.env.BASE_URL}worklets/mic-capture-worklet.js`
         );
         this.workletLoaded = true;
      }
      this.worklet = new AudioWorkletNode(ctx, "mic-capture-processor");
      this.worklet.port.onmessage = (e: MessageEvent): void => {
         if (e.data?.type !== "audio") return;
         const pcm = e.data.data as Int16Array;
         /* Opus: hand the raw PCM to the encode worker; its length-prefixed Opus frames
            come back on the encoder's onmessage and flow through handlePayload. Raw PCM:
            the chunk is the payload as-is. */
         if (this.useOpus && this.encoder) {
            this.encoder.postMessage({ type: "encode", pcm: pcm.buffer }, [pcm.buffer]);
         } else {
            this.handlePayload(new Uint8Array(pcm.buffer));
         }
      };
      this.source.connect(this.worklet);
      this.worklet.connect(this.sink); // pull the worklet into the render graph too
      const targetSamples = Math.floor((ctx.sampleRate * this.chunkMs) / 1000);
      this.worklet.port.postMessage({ type: "config", targetSamples });

      /* A stop()/dispose() during the resume/addModule awaits above would have left this
         freshly-built graph orphaned; tear it back down. */
      if (gen !== this.acquireGen || this.disposed) {
         this.stop();
         return;
      }
      /* Start streaming + sampling unless we came up muted (continuous latched mid-TTS); a
         later setMuted(false) starts the worklet + levels when DAWN stops speaking. */
      if (!this.muted) {
         this.worklet.port.postMessage({ type: "start" });
         this.startSampling();
      }
   }

   /* Flush and release a push-to-talk utterance. Awaits any in-flight acquire first so a
      fast release cannot tear down mid-start; the flushed chunk is posted before onEnd so
      the boundary sends AUDIO_IN_END after the last audio (a clipped last word otherwise). */
   private async finishPtt(send: boolean): Promise<void> {
      if (this.startPromise) {
         try {
            await this.startPromise;
         } catch {
            /* acquire already surfaced its error */
         }
         this.startPromise = null;
      }
      if (this.mode !== "ptt") {
         this.ending = null; // no longer a teardown in flight (acquire failed / already torn down)
         return;
      }
      /* Sending: flush anything still pending (a hold that ended before the commit timer)
         and mark committed so the worklet's final flush chunk streams live, not into the
         about-to-be-discarded buffer. */
      if (send) this.pttCommit();
      this.postWorklet("stop"); // flush the partial buffer -> a final 'audio' message
      /* Let that final chunk reach (Opus: the encode worker; PCM: onFrame) before we end. */
      await new Promise((r) => setTimeout(r, WORKLET_FLUSH_MS));
      this.mode = null;
      this.pending = [];
      this.stop();
      this.cb.onState("idle");
      this.ending = null;
      if (send) {
         /* Opus: route the end through the encoder FIFO so AUDIO_IN_END lands AFTER the
            last Opus frame (the worker flushes, then echoes end -> onEnd). PCM: no worker
            hop, so the flushed chunk is already out; end now. */
         if (this.useOpus && this.encoder) this.encoder.postMessage({ type: "end" });
         else this.cb.onEnd?.();
      }
   }

   private ensureContext(): void {
      if (this.ctx && this.ctx.state !== "closed") {
         if (!this.analyser) this.buildAnalyser();
         return;
      }
      this.ctx = new AudioContext({ sampleRate: MIC_RATE });
      this.workletLoaded = false; // a fresh context has no modules loaded
      this.buildAnalyser();
   }

   private buildAnalyser(): void {
      const ctx = this.ctx!;
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0.4;
      this.analyser.minDecibels = -60; // a speaking voice sits quieter than TTS peaks
      this.analyser.maxDecibels = -10;
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      this.levels = new Float32Array(this.analyser.frequencyBinCount);
   }

   /* Push the analyser FFT to the reactor each frame while capturing. */
   private startSampling(): void {
      if (this.raf || !this.analyser) return;
      const tick = (): void => {
         if (!this.analyser) return;
         this.analyser.getByteFrequencyData(this.freq);
         for (let i = 0; i < this.levels.length; i++) this.levels[i] = this.freq[i]! / 255;
         this.cb.onLevels(this.levels);
         this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
   }

   private stopSampling(): void {
      if (this.raf) {
         cancelAnimationFrame(this.raf);
         this.raf = 0;
      }
      this.cb.onLevels(null); // back to the idle shimmer
   }

   private postWorklet(type: "start" | "stop"): void {
      this.worklet?.port.postMessage({ type });
   }

   private failRate(rate: number): void {
      console.error(
         `[mic] AudioContext is ${rate}Hz, not ${MIC_RATE}Hz; DAWN's ASR is 48k-only. Disabling the mic.`
      );
      this.rateUnusable = true;
      this.mode = null;
      this.stop();
      this.cb.onState("unavailable");
      this.cb.onError("Microphone unavailable: this audio device is not 48 kHz.");
   }

   private onAcquireError(e: unknown): void {
      const err = e as { name?: string; message?: string };
      const msg =
         err?.name === "NotAllowedError"
            ? "Microphone access denied. Allow it in your browser to speak to DAWN."
            : `Microphone error: ${err?.message ?? "unknown"}`;
      console.error("[mic] acquire failed:", e);
      this.mode = null;
      this.stop();
      this.cb.onState("error");
      this.cb.onError(msg);
   }

   private onTrackEnded(): void {
      if (!this.mode) return;
      console.warn("[mic] input track ended (mic revoked or unplugged)");
      this.mode = null;
      this.stop();
      this.cb.onState("idle");
      this.cb.onError("Microphone disconnected.");
   }
}
