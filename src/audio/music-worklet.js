/*
 * Music playback worklet (runs on the audio thread). A 10-second stereo ring
 * buffer fed decoded Float32 samples from the main thread; on underrun it emits
 * silence rather than glitching. Reports buffer fill back periodically. Lifted
 * from DAWN's WebUI player (the working reference); it is renderer-agnostic and
 * sits below the render seam (it is audio, not pixels).
 */
class MusicProcessor extends AudioWorkletProcessor {
   constructor() {
      super();
      this.bufferSize = 48000 * 10; // 10 s at 48 kHz
      this.left = new Float32Array(this.bufferSize);
      this.right = new Float32Array(this.bufferSize);
      this.writePos = 0;
      this.readPos = 0;
      this.available = 0;
      // process() runs per 128-sample render quantum (~2.67 ms at 48 kHz), so 12
      // calls is ~32 ms - the cadence the server's flow-control pacer wants for a
      // ~2 s buffer target (percent alone quantizes too coarsely for that).
      this.reportInterval = 12;
      this.reportCounter = 0;

      this.port.onmessage = (e) => {
         if (e.data.type === "audio") {
            this.addSamples(e.data.left, e.data.right);
         } else if (e.data.type === "clear") {
            this.writePos = 0;
            this.readPos = 0;
            this.available = 0;
            // Report the drain immediately (bufferedMs 0 lets the server refill fast).
            this.port.postMessage({ type: "buffer", percent: 0, bufferedMs: 0 });
         }
      };
   }

   addSamples(left, right) {
      const n = left.length;
      if (this.available + n > this.bufferSize) {
         const overflow = this.available + n - this.bufferSize;
         this.readPos = (this.readPos + overflow) % this.bufferSize;
         this.available -= overflow;
      }
      for (let i = 0; i < n; i++) {
         this.left[this.writePos] = left[i];
         this.right[this.writePos] = right[i];
         this.writePos = (this.writePos + 1) % this.bufferSize;
      }
      this.available += n;
   }

   process(_inputs, outputs) {
      const output = outputs[0];
      if (!output || output.length < 2) return true;
      const outL = output[0];
      const outR = output[1];
      const frames = outL.length;

      for (let i = 0; i < frames; i++) {
         if (this.available > 0) {
            outL[i] = this.left[this.readPos];
            outR[i] = this.right[this.readPos];
            this.readPos = (this.readPos + 1) % this.bufferSize;
            this.available--;
         } else {
            outL[i] = 0;
            outR[i] = 0;
         }
      }

      if (++this.reportCounter >= this.reportInterval) {
         this.reportCounter = 0;
         // percent (of the 10 s ring) drives the UI; bufferedMs is the absolute
         // depth the server's closed-loop pacer needs to hold its ~2 s cushion.
         this.port.postMessage({
            type: "buffer",
            percent: Math.round((this.available / this.bufferSize) * 100),
            bufferedMs: Math.round((this.available / sampleRate) * 1000)
         });
      }
      return true;
   }
}

registerProcessor("music-processor", MusicProcessor);
