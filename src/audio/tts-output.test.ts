// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtsPlayback } from "./tts.ts";

/* A minimal AudioContext that records how the graph is wired. */
const wiring: Array<[string, string]> = [];
const contexts: FakeContext[] = [];
const sources: Array<{ onended: (() => void) | null; started: boolean }> = [];
let streamDestinations = 0;
class FakeNode {
   constructor(readonly name: string) {}
   connect(to: FakeNode): void {
      wiring.push([this.name, to.name]);
   }
   disconnect(): void {}
}
class FakeContext {
   state = "running";
   constructor() {
      contexts.push(this);
   }
   sampleRate = 48000;
   destination = new FakeNode("speakers");
   createAnalyser(): object {
      return Object.assign(new FakeNode("analyser"), {
         fftSize: 0,
         frequencyBinCount: 64,
         getByteFrequencyData() {}
      });
   }
   createBuffer(_ch: number, length: number): object {
      return { getChannelData: () => new Float32Array(length) };
   }
   createBufferSource(): object {
      const src = Object.assign(new FakeNode("segment"), {
         buffer: null,
         onended: null as (() => void) | null,
         started: false,
         start() {
            src.started = true;
         },
         stop() {}
      });
      sources.push(src);
      return src;
   }
   createMediaStreamDestination(): object {
      streamDestinations++;
      return { stream: {} };
   }
   resume(): Promise<void> {
      return Promise.resolve();
   }
   close(): Promise<void> {
      return Promise.resolve();
   }
}

beforeEach(() => {
   wiring.length = 0;
   contexts.length = 0;
   sources.length = 0;
   streamDestinations = 0;
   vi.stubGlobal("AudioContext", FakeContext);
   vi.stubGlobal("requestAnimationFrame", () => 0);
   vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => vi.unstubAllGlobals());

describe("TTS output", () => {
   it("plays straight to the speakers: one audio clock, no stream through an <audio> element", async () => {
      const tts = new TtsPlayback({ onLevels: () => {} });
      tts.queue(new Uint8Array([0, 0, 0, 16, 0, 32]));
      tts.play();
      await Promise.resolve();
      await Promise.resolve();
      expect(wiring).toContainEqual(["analyser", "speakers"]);
      expect(wiring).toContainEqual(["segment", "analyser"]);
      expect(streamDestinations).toBe(0);
      tts.dispose();
   });

   it("rebuilds after the context is closed under a playing segment, instead of waiting forever", async () => {
      const tts = new TtsPlayback({ onLevels: () => {} });
      tts.queue(new Uint8Array([0, 0, 0, 16]));
      tts.play();
      await Promise.resolve();
      contexts[0].state = "closed"; // the audio device went away; that segment's onended never comes
      tts.queue(new Uint8Array([0, 0, 0, 16]));
      tts.play();
      await Promise.resolve();
      expect(contexts.length).toBe(2);
      expect(wiring.filter(([from, to]) => from === "analyser" && to === "speakers").length).toBe(2);
      tts.dispose();
   });

   it("ignores a dropped source's late ended event", async () => {
      const tts = new TtsPlayback({ onLevels: () => {} });
      tts.queue(new Uint8Array([0, 0, 0, 16]));
      tts.play();
      await Promise.resolve();
      contexts[0].state = "closed";
      tts.queue(new Uint8Array([0, 0, 0, 16]));
      tts.play(); // recovery: the stuck first source is dropped, the second plays
      await Promise.resolve();
      tts.queue(new Uint8Array([0, 0, 0, 16]));
      tts.play(); // a third waits behind the second
      sources[0].onended?.(); // the dropped first source's ended event arrives late
      expect(tts.isSpeaking()).toBe(true); // still playing the second
      expect(sources.filter((s) => s.started).length).toBe(2); // the third didn't start over it
      sources[1].onended?.(); // the second really ends: now the third plays
      await Promise.resolve();
      expect(sources.filter((s) => s.started).length).toBe(3);
      tts.dispose();
   });
});
