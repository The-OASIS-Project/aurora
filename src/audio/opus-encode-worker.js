/*
 * Opus encode worker (off the main thread so encoding never janks the 60fps render).
 * The encode half of DAWN's opus-worker.js: it takes little-endian Int16 PCM chunks
 * (48 kHz mono) from the mic capture worklet, encodes them with the WebCodecs
 * AudioEncoder, and posts back a run of length-prefixed Opus frames -
 * `[uint16-LE len][opus]...` - exactly the shape DAWN's AUDIO_IN path parses.
 *
 * Frames are BATCHED (~5 per message). WebCodecs emits one EncodedAudioChunk per 20 ms
 * Opus frame; DAWN's always-on VAD processes audio in fixed 512-sample (32 ms) chunks and
 * DISCARDS any sub-512 remainder per call with no carry-over. One 20 ms frame decimates to
 * 320 samples (< 512), so sending frames singly means the VAD is never fed and continuous
 * listening hears nothing. Batching ~100 ms per message (matching DAWN's own WebUI) gives
 * ~1600 decimated samples, so the VAD runs. PTT is unaffected by the batch size (DAWN
 * buffers the whole utterance and processes it on AUDIO_IN_END).
 *
 * End-marker ordering: a push-to-talk release must not send AUDIO_IN_END before the last
 * Opus frame. `end` flushes the encoder (draining every buffered frame into the batch),
 * flushes the batch, and only then echoes `end` - the worker's FIFO message order
 * guarantees the main thread sees all `encoded` messages before `end`.
 */

const BATCH_FRAMES = 5; // ~100 ms per message; comfortably above DAWN's 512-sample VAD floor
const BATCH_FLUSH_MS = 150; // flush a partial batch this long after its first frame

let encoder = null;
let config = null; // {codec, sampleRate, numberOfChannels, bitrate, opus:{...}}
let ts = 0; // running AudioData timestamp (microseconds); reset per utterance
let batch = []; // accumulated framed [len][opus] awaiting a batched post
let batchFrames = 0;
let flushTimer = null; // fires a partial batch so a quiet room keeps DAWN's stream fed

function pushFramed(framed) {
   batch.push(framed);
   if (++batchFrames >= BATCH_FRAMES) {
      flushBatch();
      return;
   }
   /* Continuous mode never sends `end`, and DTX makes silence sparse: without a timed
      flush a partial batch could sit for a minute and trip DAWN's 60s no-audio auto-disable. */
   if (flushTimer === null) {
      flushTimer = setTimeout(() => {
         flushTimer = null;
         flushBatch();
      }, BATCH_FLUSH_MS);
   }
}

function flushBatch() {
   if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
   }
   if (batchFrames === 0) return;
   let total = 0;
   for (const f of batch) total += f.byteLength;
   const out = new Uint8Array(total);
   let off = 0;
   for (const f of batch) {
      out.set(f, off);
      off += f.byteLength;
   }
   batch = [];
   batchFrames = 0;
   self.postMessage({ type: "encoded", data: out.buffer }, [out.buffer]);
}

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
         pushFramed(framed);
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
      /* Drain the encoder (its outputs land in the batch), flush the batch, THEN echo end,
         so the main thread sends AUDIO_IN_END after the last Opus frame. */
      if (encoder && encoder.state === "configured") {
         try {
            await encoder.flush();
         } catch {
            /* a flush error just means those frames are lost; still signal end */
         }
      }
      flushBatch();
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
      batch = [];
      batchFrames = 0;
      if (flushTimer !== null) {
         clearTimeout(flushTimer);
         flushTimer = null;
      }
   }
};
