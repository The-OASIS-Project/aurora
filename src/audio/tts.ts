/*
 * TTS playback - ported from DAWN's WebUI (www/js/audio/playback.js). DAWN streams the
 * spoken response over the WebSocket binary channel (AUDIO_OUT chunks, then an
 * AUDIO_SEGMENT_END to play). The wire codec is whichever the client advertised in its
 * `audio_codecs` handshake: raw 16-bit PCM (48kHz mono) by default, or Opus (48kHz mono,
 * length-prefixed `[uint16-LE len][opus]...` frames, the same framing as music) when the
 * client advertised `opus`. That one flag is bidirectional on DAWN's side, so if the mic
 * sends Opus, TTS arrives as Opus too; setOpus() keeps this side in step.
 *
 * It also taps the playing audio through an AnalyserNode and pushes the FFT to the
 * reactor (onLevels), so the atom's bar ring is driven by DAWN's actual voice while it
 * speaks, then falls back to the idle shimmer (onLevels(null)) when it stops.
 */

import { audioDataToChannels, decodeOpusFrames } from "./webcodecs.ts";

const TTS_SAMPLE_RATE = 48000; // DAWN resamples TTS to 48k (webui_audio.c s_tts_resampler)
const FFT_SIZE = 256;
const OPUS_DECODE_CONFIG = { codec: "opus", sampleRate: TTS_SAMPLE_RATE, numberOfChannels: 1 };

export interface TtsCallbacks {
   /* Normalized (0..1) frequency bins while speaking; null when playback stops. */
   onLevels: (bins: Float32Array | null) => void;
   /* True while DAWN's voice is actually playing, false when it fully drains/stops. Driven
      off real playback (not frame arrival), so continuous-listening capture can mute itself
      against the speakers during a reply. Optional. */
   onActive?: (active: boolean) => void;
}

export class TtsPlayback {
   private ctx: AudioContext | null = null;
   private analyser: AnalyserNode | null = null;
   /* Playback routes analyser -> a MediaStreamAudioDestinationNode -> a detached <audio>
      element, NOT straight to ctx.destination. The reason is echo cancellation: the
      browser's getUserMedia AEC only cancels output it has a *reference* for, and Web
      Audio's ctx.destination is invisible to it, so our TTS (e.g. the always-on
      "Hello." greeting) would bleed uncancelled into the live continuous mic and hold
      DAWN's server-side VAD hot (end-of-speech never fires). Playing through a media
      element is the path the AEC references (it is how DAWN's own WebUI escapes this).
      `sink` null => the element route was unavailable and we fell back to ctx.destination
      (audio still plays, just without AEC referencing). */
   private msd: MediaStreamAudioDestinationNode | null = null;
   private sink: HTMLAudioElement | null = null;
   private directOutput = false; // true once we've fallen back to analyser -> ctx.destination
   private freq: Uint8Array<ArrayBuffer> = new Uint8Array(FFT_SIZE / 2);
   private levels = new Float32Array(FFT_SIZE / 2);
   private chunks: Uint8Array[] = []; // accumulating the current segment
   private segments: Uint8Array[] = []; // segments waiting behind the one playing
   private playing = false;
   private current: AudioBufferSourceNode | null = null;
   private raf = 0;
   private opus = false; // decode incoming segments as Opus (vs raw PCM)
   private decoder: AudioDecoder | null = null;
   private decodeTs = 0; // running Opus timestamp (monotonic across segments)
   private decoded: Float32Array[] = []; // mono PCM collected for the segment being decoded
   private playGen = 0; // bumped by stop()/dispose() so an in-flight decode can bail on resume
   private speaking = false; // playback-active edge, for onActive
   opusSupported = false; // AudioDecoder can do the Opus config (async-probed at construction)
   private readonly onLevels: (bins: Float32Array | null) => void;
   private readonly onActive: (active: boolean) => void;

   constructor(cb: TtsCallbacks) {
      this.onLevels = cb.onLevels;
      this.onActive = cb.onActive ?? ((): void => {});
      void this.probeOpus();
   }

   private setSpeaking(v: boolean): void {
      if (this.speaking === v) return;
      this.speaking = v;
      this.onActive(v);
   }

   /* Is DAWN's voice actually playing right now (server-ahead-of-audible lag included)?
      Used to seed/hold the continuous-listening echo mute against the real playback tail. */
   isSpeaking(): boolean {
      return this.speaking;
   }

   private async probeOpus(): Promise<void> {
      try {
         if (typeof AudioDecoder === "undefined") return;
         const s = await AudioDecoder.isConfigSupported(
            OPUS_DECODE_CONFIG as unknown as AudioDecoderConfig
         );
         this.opusSupported = s.supported === true;
      } catch {
         this.opusSupported = false;
      }
   }

   /* Match the wire codec DAWN uses for TTS out (set from the same handshake decision as
      the mic). Opus only if we actually support decoding it. */
   setOpus(on: boolean): void {
      this.opus = on && this.opusSupported;
   }

   /* An AUDIO_OUT chunk (raw bytes: PCM samples, or part of the Opus frame stream). */
   queue(pcm: Uint8Array): void {
      this.chunks.push(pcm);
   }

   /* AUDIO_SEGMENT_END: concatenate the accumulated chunks and play (or enqueue behind
      the segment currently playing). */
   play(): void {
      if (this.chunks.length === 0) return;
      const total = this.chunks.reduce((s, c) => s + c.length, 0);
      /* PCM must land on whole Int16 samples; Opus framing is byte-exact, so keep it all. */
      const usable = this.opus ? total : total - (total % 2);
      const buf = new Uint8Array(usable);
      let off = 0;
      for (const c of this.chunks) {
         const n = Math.min(c.length, usable - off);
         if (n > 0) {
            buf.set(c.subarray(0, n), off);
            off += n;
         }
      }
      this.chunks = [];
      if (this.playing) this.segments.push(buf);
      else void this.playBuffer(buf);
   }

   private ensureContext(): void {
      if (this.ctx && this.ctx.state !== "closed") return;
      /* Rebuilding after an EXTERNAL context close (audio-device change, OS audio-session
         interruption - our own close only happens in dispose, which nulls ctx): release
         the old element sink first so wireOutput doesn't orphan a still-referenced <audio>
         pointing at the dead stream. No-op on the first build (sink is null). */
      this.releaseSink();
      this.ctx = new AudioContext({ sampleRate: TTS_SAMPLE_RATE });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0.4;
      this.analyser.minDecibels = -55; // TTS quiet parts
      this.analyser.maxDecibels = -10; // TTS peaks
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      this.levels = new Float32Array(this.analyser.frequencyBinCount);
      this.wireOutput();
   }

   /* Route the analyser to the media-element sink so the AEC can reference our TTS (see
      the `msd`/`sink` field note). Falls back to ctx.destination if the element route
      can't be built, so audio never goes silent. Called once per fresh context. */
   private wireOutput(): void {
      const ctx = this.ctx!;
      this.directOutput = false;
      try {
         this.msd = ctx.createMediaStreamDestination();
         const el = new Audio();
         el.autoplay = false;
         el.srcObject = this.msd.stream;
         this.sink = el;
         this.analyser!.connect(this.msd);
      } catch {
         /* No MediaStreamDestination/Audio: play straight to the speakers (no AEC ref). */
         this.msd = null;
         this.sink = null;
         this.fallbackToDirectOutput();
      }
   }

   /* Kick the media-element sink into playing its live stream (idempotent - the stream
      never ends, so one successful play() keeps rendering across segment gaps). A
      rejected play() (no gesture yet) drops us to direct output so TTS is never silent. */
   private ensureSinkPlaying(): void {
      if (!this.sink || this.directOutput || !this.sink.paused) return;
      /* Scope the rejection to THIS sink: a dispose()/rebuild during the pending play()
         (reconnect churn, which is the greeting-on-connect case) swaps this.sink, and an
         unscoped fallback would then wrongly drop the fresh context to direct output (no
         AEC) or throw on a null ctx. A stale rejection is a no-op. */
      const el = this.sink;
      el.play().catch(() => {
         if (this.sink === el) this.fallbackToDirectOutput();
      });
   }

   /* Give up the media-element route (its play() was rejected, or it was never available)
      and connect the analyser straight to the speakers. Idempotent. Keeps audio alive at
      the cost of AEC referencing (the mic's worklet-mute is still the primary guard). */
   private fallbackToDirectOutput(): void {
      if (this.directOutput) return;
      this.directOutput = true;
      if (this.msd) {
         try {
            this.analyser?.disconnect(this.msd);
         } catch {
            /* not connected */
         }
      }
      if (this.sink) {
         try {
            this.sink.pause();
         } catch {
            /* nothing to pause */
         }
         this.sink.srcObject = null;
         this.sink = null;
      }
      this.msd = null;
      this.analyser?.connect(this.ctx!.destination);
   }

   /* Detach and drop the media-element sink + its stream destination. Shared by dispose()
      and the closed-context rebuild in ensureContext. */
   private releaseSink(): void {
      if (this.sink) {
         try {
            this.sink.pause();
         } catch {
            /* nothing to pause */
         }
         this.sink.srcObject = null;
         this.sink = null;
      }
      this.msd = null;
   }

   private async playBuffer(bytes: Uint8Array): Promise<void> {
      this.playing = true;
      const gen = this.playGen; // capture: a stop()/dispose() during an await invalidates us
      try {
         this.ensureContext();
         const ctx = this.ctx!;
         const analyser = this.analyser!;
         if (ctx.state === "suspended") await ctx.resume(); // autoplay: needs a gesture first
         this.ensureSinkPlaying(); // start the media-element sink (falls back if it can't)

         /* Turn the segment into one mono Float32 channel: decode Opus, or read PCM by
            hand (little-endian 16-bit signed -> float). */
         const channel = this.opus ? await this.decodeOpus(bytes) : pcmToFloat(bytes);
         /* Opus decode (and the resume above) awaited: if a stop/dispose landed meanwhile,
            do NOT start a source - it would play after the stop and desync `playing`. */
         if (gen !== this.playGen) return;
         if (channel.length === 0) {
            /* Nothing to play (empty or a failed decode): don't stall the queue. */
            this.afterSegment();
            return;
         }

         const audioBuffer = ctx.createBuffer(1, channel.length, TTS_SAMPLE_RATE);
         audioBuffer.getChannelData(0).set(channel);

         const src = ctx.createBufferSource();
         src.buffer = audioBuffer;
         src.connect(analyser); // analyser -> sink is wired once in ensureContext/wireOutput
         this.current = src;
         this.startSampling();

         src.onended = (): void => this.afterSegment();
         src.start(0);
      } catch {
         this.playing = false;
         this.stopSampling();
         if (this.segments.length > 0) void this.playBuffer(this.segments.shift()!);
      }
   }

   /* Advance to the next queued segment, or settle to idle when the queue drains. */
   private afterSegment(): void {
      this.current = null;
      if (this.segments.length > 0) {
         void this.playBuffer(this.segments.shift()!);
      } else {
         this.playing = false;
         this.stopSampling();
      }
   }

   /* Decode one segment's worth of length-prefixed Opus frames to a mono Float32 buffer.
      A WebCodecs decoder is single-use, so a fatal error rebuilds it for the next call. */
   private async decodeOpus(buf: Uint8Array): Promise<Float32Array> {
      if (!this.ensureDecoder() || !this.decoder) return new Float32Array(0);
      this.decoded = [];
      this.decodeTs = decodeOpusFrames(this.decoder, buf, this.decodeTs);
      try {
         await this.decoder.flush(); // drain all outputs for this segment
      } catch {
         /* a decode error already surfaced; play whatever decoded */
      }
      const total = this.decoded.reduce((s, c) => s + c.length, 0);
      const out = new Float32Array(total);
      let p = 0;
      for (const c of this.decoded) {
         out.set(c, p);
         p += c.length;
      }
      this.decoded = [];
      return out;
   }

   private ensureDecoder(): boolean {
      if (this.decoder && this.decoder.state !== "closed") return true;
      if (typeof AudioDecoder === "undefined") return false;
      try {
         const dec = new AudioDecoder({
            output: (d) => this.onDecoded(d),
            error: (e) => {
               console.warn("[tts] Opus decode error, will rebuild:", e);
               this.decoder = null;
            }
         });
         dec.configure(OPUS_DECODE_CONFIG as unknown as AudioDecoderConfig);
         this.decoder = dec;
         return true;
      } catch (e) {
         console.error("[tts] failed to build Opus decoder:", e);
         this.decoder = null;
         return false;
      }
   }

   /* Collect one decoded frame's mono samples (channel 0 of whatever layout came back). */
   private onDecoded(data: AudioData): void {
      try {
         const ch = audioDataToChannels(data)[0];
         if (ch) this.decoded.push(ch);
      } catch (e) {
         console.warn("[tts] decoded-audio handling failed:", e);
      } finally {
         data.close();
      }
   }

   /* Push the analyser FFT to the reactor each frame while a segment plays. */
   private startSampling(): void {
      if (this.raf || !this.analyser) return;
      this.setSpeaking(true); // playback actually begins here (first segment; later segments no-op)
      const tick = (): void => {
         if (!this.analyser) return;
         this.analyser.getByteFrequencyData(this.freq);
         for (let i = 0; i < this.levels.length; i++) this.levels[i] = this.freq[i]! / 255;
         this.onLevels(this.levels);
         this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
   }

   private stopSampling(): void {
      if (this.raf) {
         cancelAnimationFrame(this.raf);
         this.raf = 0;
      }
      this.setSpeaking(false); // playback fully drained/stopped
      this.onLevels(null); // back to the idle shimmer
   }

   /* Stop immediately and clear everything (e.g. TTS toggled off, or disconnect). */
   stop(): void {
      this.playGen++; // invalidate any in-flight decode so it won't start a source
      this.chunks = [];
      this.segments = [];
      if (this.current) {
         try {
            this.current.stop();
         } catch {
            /* already stopped */
         }
         this.current = null;
      }
      this.playing = false;
      this.stopSampling();
   }

   dispose(): void {
      this.stop();
      if (this.decoder && this.decoder.state !== "closed") {
         try {
            this.decoder.close();
         } catch {
            /* already closed */
         }
      }
      this.decoder = null;
      this.releaseSink();
      if (this.ctx && this.ctx.state !== "closed") void this.ctx.close();
      this.ctx = null;
   }
}

/* Little-endian 16-bit signed PCM -> mono float, read by hand to stay clear of the strict
   typed-array/DataView buffer-type generics. */
function pcmToFloat(bytes: Uint8Array): Float32Array {
   const numSamples = Math.floor(bytes.length / 2);
   const out = new Float32Array(numSamples);
   for (let i = 0; i < numSamples; i++) {
      let s = (bytes[i * 2 + 1]! << 8) | bytes[i * 2]!;
      if (s >= 0x8000) s -= 0x10000;
      out[i] = s / 32768;
   }
   return out;
}
