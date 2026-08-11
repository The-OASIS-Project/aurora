/*
 * Shared WebCodecs helpers for the audio layer. The decode-side normalization and the
 * length-prefixed Opus frame walk are the fiddliest, most error-prone code in the audio
 * stack (plane strides, s16 byte-reinterpret, the frame-length bounds check) and the
 * exact wire contract with DAWN. music.ts (stereo playback) and tts.ts (mono playback)
 * both need them, so they live here once - a bug fixed here is fixed for both.
 *
 * These are PURE transforms: they do not close the AudioData (the caller owns its
 * lifecycle) and apply no up/down-mix - the caller decides mono-vs-stereo policy.
 */

/* Copy a decoded AudioData into one planar Float32Array per channel present, handling
   every WebCodecs output layout. Returns [] for an unknown format. */
export function audioDataToChannels(data: AudioData): Float32Array[] {
   const frames = data.numberOfFrames;
   const channels = data.numberOfChannels;
   const format = data.format ?? "";
   const out: Float32Array[] = [];
   for (let c = 0; c < channels; c++) out.push(new Float32Array(frames));

   if (format === "f32-planar") {
      for (let c = 0; c < channels; c++) data.copyTo(out[c]!, { planeIndex: c });
   } else if (format === "f32") {
      const inter = new Float32Array(frames * channels);
      data.copyTo(inter, { planeIndex: 0 });
      for (let i = 0; i < frames; i++) {
         for (let c = 0; c < channels; c++) out[c]![i] = inter[i * channels + c]!;
      }
   } else if (format === "s16") {
      const bytes = new ArrayBuffer(frames * channels * 2);
      data.copyTo(bytes, { planeIndex: 0 });
      const i16 = new Int16Array(bytes);
      for (let i = 0; i < frames; i++) {
         for (let c = 0; c < channels; c++) out[c]![i] = i16[i * channels + c]! / 32768;
      }
   } else if (format === "s16-planar") {
      for (let c = 0; c < channels; c++) {
         const bytes = new ArrayBuffer(frames * 2);
         data.copyTo(bytes, { planeIndex: c });
         const i16 = new Int16Array(bytes);
         for (let i = 0; i < frames; i++) out[c]![i] = i16[i]! / 32768;
      }
   } else {
      return [];
   }
   return out;
}

/* Walk a run of length-prefixed Opus frames - `[uint16-LE len][opus]...` - decoding each
   into `dec`. Bounds-checked so a malformed/short buffer can't over-read or loop forever;
   a bad packet is skipped, an impossible length ends the walk. Returns the timestamp
   advanced past the frames consumed (callers thread their own running ts through).
   maxLen = 0 means no per-frame cap. */
export function decodeOpusFrames(
   dec: AudioDecoder,
   payload: Uint8Array,
   ts: number,
   frameUs = 20000,
   maxLen = 0
): number {
   const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
   let off = 0;
   while (off + 2 <= payload.byteLength) {
      const len = view.getUint16(off, true); // little-endian
      off += 2;
      if (len === 0 || (maxLen > 0 && len > maxLen) || off + len > payload.byteLength) break;
      const frame = payload.subarray(off, off + len);
      off += len;
      try {
         dec.decode(new EncodedAudioChunk({ type: "key", timestamp: ts, data: frame }));
         ts += frameUs;
      } catch {
         /* a bad packet drops a frame; keep going */
      }
   }
   return ts;
}
