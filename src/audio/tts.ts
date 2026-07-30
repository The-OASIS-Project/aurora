/*
 * TTS playback — ported from DAWN's WebUI (www/js/audio/playback.js). DAWN streams
 * the spoken response as raw 16-bit PCM (48kHz mono) over the WebSocket binary
 * channel (AUDIO_OUT chunks, then an AUDIO_SEGMENT_END to play). Because this client
 * advertises only the `pcm` codec, the daemon sends PCM (not Opus), so there is no
 * decoder to port — just Web Audio playback.
 *
 * It also taps the playing audio through an AnalyserNode and pushes the FFT to the
 * reactor (onLevels), so the atom's bar ring is driven by DAWN's actual voice while
 * it speaks, then falls back to the idle shimmer (onLevels(null)) when it stops.
 */

const TTS_SAMPLE_RATE = 48000; // DAWN resamples TTS to 48k (webui_audio.c s_tts_resampler)
const FFT_SIZE = 256;

export interface TtsCallbacks {
   /* Normalized (0..1) frequency bins while speaking; null when playback stops. */
   onLevels: (bins: Float32Array | null) => void;
}

export class TtsPlayback {
   private ctx: AudioContext | null = null;
   private analyser: AnalyserNode | null = null;
   private freq: Uint8Array<ArrayBuffer> = new Uint8Array(FFT_SIZE / 2);
   private levels = new Float32Array(FFT_SIZE / 2);
   private chunks: Uint8Array[] = []; // accumulating the current segment
   private segments: Uint8Array[] = []; // segments waiting behind the one playing
   private playing = false;
   private current: AudioBufferSourceNode | null = null;
   private raf = 0;
   private readonly onLevels: (bins: Float32Array | null) => void;

   constructor(cb: TtsCallbacks) {
      this.onLevels = cb.onLevels;
   }

   /* An AUDIO_OUT chunk (raw PCM bytes). */
   queue(pcm: Uint8Array): void {
      this.chunks.push(pcm);
   }

   /* AUDIO_SEGMENT_END: concatenate the accumulated chunks and play (or enqueue
      behind the segment currently playing). */
   play(): void {
      if (this.chunks.length === 0) return;
      const total = this.chunks.reduce((s, c) => s + c.length, 0);
      const aligned = total - (total % 2); // whole Int16 samples
      const buf = new Uint8Array(aligned);
      let off = 0;
      for (const c of this.chunks) {
         const n = Math.min(c.length, aligned - off);
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
      this.ctx = new AudioContext({ sampleRate: TTS_SAMPLE_RATE });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0.4;
      this.analyser.minDecibels = -55; // TTS quiet parts
      this.analyser.maxDecibels = -10; // TTS peaks
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      this.levels = new Float32Array(this.analyser.frequencyBinCount);
   }

   private async playBuffer(bytes: Uint8Array): Promise<void> {
      this.playing = true;
      try {
         this.ensureContext();
         const ctx = this.ctx!;
         const analyser = this.analyser!;
         if (ctx.state === "suspended") await ctx.resume(); // autoplay: needs a gesture first

         const numSamples = bytes.length / 2;
         const audioBuffer = ctx.createBuffer(1, numSamples, TTS_SAMPLE_RATE);
         const channel = audioBuffer.getChannelData(0);
         /* Little-endian 16-bit signed PCM -> float, read by hand to stay clear of
            the strict typed-array/DataView buffer-type generics. */
         for (let i = 0; i < numSamples; i++) {
            let s = (bytes[i * 2 + 1]! << 8) | bytes[i * 2]!;
            if (s >= 0x8000) s -= 0x10000;
            channel[i] = s / 32768;
         }

         const src = ctx.createBufferSource();
         src.buffer = audioBuffer;
         src.connect(analyser);
         analyser.connect(ctx.destination);
         this.current = src;
         this.startSampling();

         src.onended = (): void => {
            if (this.segments.length > 0) {
               void this.playBuffer(this.segments.shift()!);
            } else {
               this.playing = false;
               this.current = null;
               this.stopSampling();
            }
         };
         src.start(0);
      } catch {
         this.playing = false;
         this.stopSampling();
         if (this.segments.length > 0) void this.playBuffer(this.segments.shift()!);
      }
   }

   /* Push the analyser FFT to the reactor each frame while a segment plays. */
   private startSampling(): void {
      if (this.raf || !this.analyser) return;
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
      this.onLevels(null); // back to the idle shimmer
   }

   /* Stop immediately and clear everything (e.g. TTS toggled off, or disconnect). */
   stop(): void {
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
      if (this.ctx && this.ctx.state !== "closed") void this.ctx.close();
      this.ctx = null;
   }
}
