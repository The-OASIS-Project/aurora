/*
 * Opus encode worker (off the main thread so encoding never janks the 60fps render).
 * The encode half of DAWN's opus-worker.js: it takes little-endian Int16 PCM chunks
 * (48 kHz mono) from the mic capture worklet, encodes them with the WebCodecs
 * AudioEncoder, and posts back a run of length-prefixed Opus frames -
 * `[uint16-LE len][opus]...` - exactly the shape DAWN's AUDIO_IN path parses.
 *
 * End-marker ordering (the reason encoding is sequenced through here, not fired-and-
 * forgotten): a push-to-talk release must not send AUDIO_IN_END before the last Opus
 * frame, or the server clips the final word and the late frame seeds an orphan buffer.
 * So `end` flushes the encoder (draining every buffered frame to the output callback
 * first) and only then echoes `end` back - the worker's FIFO message order guarantees
 * the main thread sees all `encoded` messages before `end`.
 */

let encoder = null;
let config = null; // {codec, sampleRate, numberOfChannels, bitrate, opus:{...}}
let ts = 0; // running AudioData timestamp (microseconds); reset per utterance

function buildEncoder() {
   ts = 0;
   encoder = new AudioEncoder({
      output: (chunk) => {
         const body = new Uint8Array(chunk.byteLength);
         chunk.copyTo(body);
         /* Length-prefix each frame (uint16 LE), matching DAWN's stream framing. */
         const framed = new Uint8Array(2 + body.byteLength);
         framed[0] = body.byteLength & 0xff;
         framed[1] = (body.byteLength >> 8) & 0xff;
         framed.set(body, 2);
         self.postMessage({ type: "encoded", data: framed.buffer }, [framed.buffer]);
      },
      error: (e) => {
         /* A WebCodecs codec is single-use: a fatal error closes it for good, so drop it
            and rebuild on the next encode (the main thread also hears the error). */
         self.postMessage({ type: "error", message: String(e && e.message ? e.message : e) });
         encoder = null;
      }
   });
   encoder.configure(config);
}

self.onmessage = async (e) => {
   const m = e.data;
   if (m.type === "config") {
      config = m.config;
      return;
   }
   if (m.type === "encode") {
      if (!config) return;
      if (!encoder || encoder.state === "closed") buildEncoder();
      const pcm = new Int16Array(m.pcm);
      const f = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
      try {
         const audio = new AudioData({
            format: "f32-planar",
            sampleRate: config.sampleRate,
            numberOfFrames: f.length,
            numberOfChannels: 1,
            timestamp: ts,
            data: f
         });
         ts += Math.round((f.length / config.sampleRate) * 1e6);
         encoder.encode(audio);
         audio.close();
      } catch (err) {
         self.postMessage({ type: "error", message: String(err && err.message ? err.message : err) });
      }
      return;
   }
   if (m.type === "end") {
      /* Drain every buffered frame (output fires synchronously during flush) BEFORE
         echoing end, so the main thread sends AUDIO_IN_END after the last Opus frame. */
      if (encoder && encoder.state === "configured") {
         try {
            await encoder.flush();
         } catch {
            /* a flush error just means those frames are lost; still signal end */
         }
      }
      ts = 0; // next utterance starts fresh
      self.postMessage({ type: "end" });
      return;
   }
   if (m.type === "reset") {
      if (encoder && encoder.state !== "closed") {
         try {
            encoder.close();
         } catch {
            /* already closed */
         }
      }
      encoder = null;
      ts = 0;
   }
};
