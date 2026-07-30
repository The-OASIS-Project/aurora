/*
 * Music audio pipeline. DAWN streams music as Opus (unlike TTS, which we get as
 * raw PCM), so the browser must decode it: WebCodecs AudioDecoder -> AudioWorklet
 * ring buffer -> gain -> analyser -> speakers. Binary frames arrive on the main
 * WebSocket as [0x20][uint16-LE len][opus...]; DawnIngest strips the 0x20 opcode
 * and hands us the payload. An analyser tap feeds the player's spectrum meter.
 *
 * This lives below the render seam: it is audio, not pixels. The reference is
 * DAWN's own WebUI player; the decode/worklet chain is lifted from it.
 */

const OPUS_RATE = 48000; // Opus (and thus our AudioContext) is always 48 kHz stereo
const VOL_KEY = "dawn.hero.musicVol";

export class MusicAudio {
   private ctx: AudioContext | null = null;
   private decoder: AudioDecoder | null = null;
   private worklet: AudioWorkletNode | null = null;
   private gain: GainNode | null = null;
   private analyser: AnalyserNode | null = null;
   private freq: Uint8Array<ArrayBuffer> | null = null;
   private ts = 0; // running decode timestamp (microseconds), +20 ms per frame
   private ready = false;
   private initing: Promise<void> | null = null;
   private bufferPercent = 0;
   private volume = clampVol(Number(localStorage.getItem(VOL_KEY) ?? 0.8));
   private muted = false;
   private onError: (msg: string) => void = () => {};

   /* Surface a fatal audio-setup problem (e.g. no secure context) to the UI. */
   setErrorHandler(fn: (msg: string) => void): void {
      this.onError = fn;
   }

   constructor() {
      /* AudioContext can only start after a user gesture. The user has almost
         always clicked/typed before music plays, but resume once on the first
         gesture as a guarantee. */
      const resume = (): void => void this.ctx?.resume();
      window.addEventListener("pointerdown", resume, { once: true, passive: true });
   }

   /* Feed one binary music payload (opcode already stripped): a run of
      length-prefixed Opus frames. Lazily boots the decode graph on first frame. */
   async pushFrame(payload: Uint8Array): Promise<void> {
      if (!this.ready) await this.init();
      if (this.ctx?.state === "suspended") await this.ctx.resume();
      const dec = this.decoder;
      if (!dec || dec.state === "closed") return;

      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      let offset = 0;
      while (offset + 2 <= payload.byteLength) {
         const len = view.getUint16(offset, true); // little-endian
         offset += 2;
         if (len === 0 || len > 1500 || offset + len > payload.byteLength) break;
         const frame = payload.subarray(offset, offset + len);
         offset += len;
         try {
            dec.decode(new EncodedAudioChunk({ type: "key", timestamp: this.ts, data: frame }));
            this.ts += 20000; // 20 ms per Opus frame
         } catch {
            /* a bad packet drops a frame; the ring buffer rides it out */
         }
      }
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
      this.decoder = new AudioDecoder({
         output: (d) => this.onDecoded(d),
         error: (e) => console.error("[music] decoder error:", e)
      });
      this.decoder.configure(cfg);

      try {
         await this.ctx.audioWorklet.addModule(new URL("./music-worklet.js", import.meta.url));
      } catch (e) {
         console.error("[music] AudioWorklet unavailable (needs a secure context):", e);
         this.onError("Music audio needs HTTPS on this origin");
         return;
      }
      this.worklet = new AudioWorkletNode(this.ctx, "music-processor", { outputChannelCount: [2] });
      this.worklet.connect(this.gain);
      this.worklet.port.onmessage = (e: MessageEvent): void => {
         if (e.data?.type === "buffer") this.bufferPercent = e.data.percent as number;
      };
      this.ready = true;
   }

   /* WebCodecs hands back decoded PCM in one of several layouts; normalize to two
      Float32 channels and ship them to the worklet as transferables. */
   private onDecoded(data: AudioData): void {
      try {
         const frames = data.numberOfFrames;
         const channels = data.numberOfChannels;
         const format = data.format ?? "";
         const left = new Float32Array(frames);
         const right = new Float32Array(frames);

         if (format === "f32-planar") {
            data.copyTo(left, { planeIndex: 0 });
            if (channels > 1) data.copyTo(right, { planeIndex: 1 });
            else right.set(left);
         } else if (format === "f32") {
            const inter = new Float32Array(frames * channels);
            data.copyTo(inter, { planeIndex: 0 });
            for (let i = 0; i < frames; i++) {
               left[i] = inter[i * channels];
               right[i] = channels >= 2 ? inter[i * channels + 1] : inter[i * channels];
            }
         } else if (format === "s16" || format === "s16-planar") {
            const bytes = new ArrayBuffer(frames * channels * 2);
            data.copyTo(bytes, { planeIndex: 0 });
            const i16 = new Int16Array(bytes);
            if (format === "s16") {
               for (let i = 0; i < frames; i++) {
                  left[i] = i16[i * channels] / 32768;
                  right[i] = channels >= 2 ? i16[i * channels + 1] / 32768 : left[i];
               }
            } else {
               for (let i = 0; i < frames; i++) left[i] = i16[i] / 32768;
               if (channels > 1) {
                  const rb = new ArrayBuffer(frames * 2);
                  data.copyTo(rb, { planeIndex: 1 });
                  const r16 = new Int16Array(rb);
                  for (let i = 0; i < frames; i++) right[i] = r16[i] / 32768;
               } else {
                  right.set(left);
               }
            }
         } else {
            data.close();
            return;
         }

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
   flush(): void {
      this.ts = 0;
      this.worklet?.port.postMessage({ type: "clear" });
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
