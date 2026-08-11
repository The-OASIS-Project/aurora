/*
 * Microphone capture worklet (runs on the audio thread). The inverse of
 * music-worklet.js: it READS inputs[0] instead of writing outputs[0]. Buffers live
 * mic input (Float32) and, every `targetSamples`, converts it to little-endian Int16
 * PCM and posts it to the main thread. Gated by start/stop so continuous mode can
 * mute (pause) without tearing down the graph; stop flushes the partial buffer so the
 * last fragment of a push-to-talk utterance is not dropped. Lifted from DAWN's WebUI
 * capture worklet (the working reference). Below the render seam: audio, not pixels.
 */
class MicCaptureProcessor extends AudioWorkletProcessor {
   constructor() {
      super();
      this.targetSamples = 4800; // overwritten by 'config' (rate * chunkMs / 1000)
      this.buffer = new Float32Array(this.targetSamples);
      this.index = 0;
      this.recording = false;

      this.port.onmessage = (e) => {
         const msg = e.data;
         if (msg.type === "config") {
            if (msg.targetSamples) {
               this.targetSamples = msg.targetSamples;
               this.buffer = new Float32Array(this.targetSamples);
               this.index = 0;
            }
         } else if (msg.type === "start") {
            this.recording = true;
            this.index = 0;
         } else if (msg.type === "stop") {
            this.recording = false;
            this.flush(); // emit the partial buffer so a trailing fragment is not lost
         }
      };
   }

   flush() {
      if (this.index === 0) return;
      const pcm = new Int16Array(this.index);
      for (let i = 0; i < this.index; i++) {
         const s = Math.max(-1, Math.min(1, this.buffer[i]));
         pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage({ type: "audio", data: pcm }, [pcm.buffer]);
      this.index = 0;
   }

   process(inputs) {
      const input = inputs[0];
      if (!input || !input[0] || !this.recording) return true;
      const chan = input[0];
      for (let i = 0; i < chan.length; i++) {
         if (this.index >= this.targetSamples) this.flush();
         this.buffer[this.index++] = chan[i];
      }
      return true;
   }
}

registerProcessor("mic-capture-processor", MicCaptureProcessor);
