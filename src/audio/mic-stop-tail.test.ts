// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MicCapture } from "./mic.ts";

/* With Opus, audio goes through an encode worker and comes back a moment later, batched. When
   continuous listening is turned off, the worker can still hand back audio it was holding. That
   audio must not reach DAWN: arriving after always_on_disable, DAWN takes it for the start of a
   push-to-talk recording that never ends, and refuses every re-arm (PTT_ACTIVE). A push-to-talk
   release relies on the opposite: its last frames, and its end marker, come back after its mode
   has cleared, and must still go out. */

class FakeWorker {
   static last: FakeWorker | null = null;
   onmessage: ((e: { data: unknown }) => void) | null = null;
   readonly posted: Array<{ type: string }> = [];
   constructor() {
      FakeWorker.last = this;
   }
   postMessage(m: { type: string }): void {
      this.posted.push(m);
   }
   terminate(): void {}
   /* The worker hands an encoded batch back. */
   encoded(...bytes: number[]): void {
      this.onmessage?.({ data: { type: "encoded", data: new Uint8Array(bytes).buffer } });
   }
   end(): void {
      this.onmessage?.({ data: { type: "end" } });
   }
}

let frames: number[][] = [];
let ends = 0;

beforeEach(() => {
   frames = [];
   ends = 0;
   vi.stubGlobal("Worker", FakeWorker);
   vi.spyOn(MicCapture.prototype, "available", "get").mockReturnValue(true);
   /* The browser side (getUserMedia, the audio graph) isn't what's tested. */
   vi.spyOn(
      MicCapture.prototype as unknown as { acquire: () => Promise<void> },
      "acquire"
   ).mockResolvedValue(undefined);
});
afterEach(() => {
   vi.restoreAllMocks();
   vi.unstubAllGlobals();
});

function mic(): { m: MicCapture; worker: FakeWorker } {
   const m = new MicCapture({
      onFrame: (p) => frames.push([...p]),
      onEnd: () => ends++,
      onState: () => {},
      onError: () => {},
      onLevels: () => {}
   });
   m.opusSupported = true;
   m.setEncoding(true);
   return { m, worker: FakeWorker.last! };
}

it("after continuous listening stops, audio the encoder hands back late isn't sent", async () => {
   const { m, worker } = mic();
   await m.continuousStart();
   worker.encoded(1, 2);
   expect(frames).toEqual([[1, 2]]); // streaming while on
   m.continuousStop();
   worker.encoded(3, 4); // the batch it was holding
   expect(frames).toEqual([[1, 2]]);
});

it("a push-to-talk release still sends its last frames, then its end", async () => {
   const { m, worker } = mic();
   m.pttStart();
   m.pttCommit();
   const released = (m as unknown as { finishPtt: (send: boolean) => Promise<void> }).finishPtt(
      true
   );
   await vi.waitFor(() => expect(worker.posted.map((p) => p.type)).toContain("end"));
   await released;
   worker.encoded(5, 6); // the flushed tail, after the mode has cleared
   worker.end();
   expect(frames).toEqual([[5, 6]]);
   expect(ends).toBe(1);
});

it("a cancelled push-to-talk sends nothing, even what the encoder hands back late", async () => {
   const { m, worker } = mic();
   m.pttStart();
   const cancelled = (m as unknown as { finishPtt: (send: boolean) => Promise<void> }).finishPtt(
      false
   );
   await cancelled;
   worker.encoded(9, 9);
   expect(frames).toEqual([]);
   expect(ends).toBe(0);
});

it("the mic going away mid-listening sends nothing late either", async () => {
   const { m, worker } = mic();
   await m.continuousStart();
   (m as unknown as { onTrackEnded: () => void }).onTrackEnded(); // unplugged, or permission revoked
   worker.encoded(4, 4);
   expect(frames).toEqual([]);
});

it("turned back on after a stop, it streams again", async () => {
   const { m, worker } = mic();
   await m.continuousStart();
   m.continuousStop();
   await m.continuousStart();
   worker.encoded(7, 8);
   expect(frames).toEqual([[7, 8]]);
});
