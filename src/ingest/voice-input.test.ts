// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DawnIngest } from "./dawn-ws.ts";
import { MicCapture } from "../audio/mic.ts";
import { RecordingDing } from "../audio/ding.ts";
import { setAppLogins } from "../util/dawn-app.ts";

/* Continuous listening (DAWN's server-side VAD and wake word), driven the way the composer's mic
   button and DAWN's frames drive it: latching it, the echo mute that keeps DAWN's own voice out of
   the open mic, the ready ding on a wake, and DAWN turning it off. The mic's browser side
   (getUserMedia, the audio graph) is stubbed; what's checked is what Aurora tells DAWN and the mic. */

type Sent = { type: string; payload?: Record<string, unknown> };
let ing: Record<string, any> | null = null;
let sent: Sent[] = [];
let started: boolean[] = [];
let muted: boolean[] = [];
let stops = 0;
let dings = 0;

beforeEach(() => {
   localStorage.clear();
   setAppLogins(false);
   sent = [];
   started = [];
   muted = [];
   stops = 0;
   dings = 0;
   vi.useFakeTimers();
   vi.spyOn(console, "debug").mockImplementation(() => {});
   vi.spyOn(console, "warn").mockImplementation(() => {});
   vi.spyOn(MicCapture.prototype, "available", "get").mockReturnValue(true);
   vi.spyOn(MicCapture.prototype, "continuousStart").mockImplementation((m = false) => {
      started.push(m);
      return Promise.resolve();
   });
   vi.spyOn(MicCapture.prototype, "continuousStop").mockImplementation(() => {
      stops++;
   });
   vi.spyOn(MicCapture.prototype, "setMuted").mockImplementation((m: boolean) => {
      muted.push(m);
   });
   vi.spyOn(RecordingDing.prototype, "play").mockImplementation(() => {
      dings++;
   });
});
afterEach(() => {
   ing?.dispose();
   ing = null;
   vi.useRealTimers();
   vi.restoreAllMocks();
});

const sinks = new Proxy({}, { get: () => new Proxy({}, { get: () => () => undefined }) });

function connect() {
   ing = new DawnIngest();
   ing.start(sinks);
   ing.ws = {
      readyState: WebSocket.OPEN,
      send: (t: unknown) => {
         if (typeof t === "string") sent.push(JSON.parse(t) as Sent);
      },
      close: () => {}
   };
   return ing.getMicControl();
}
const frame = (type: string, payload: Record<string, unknown>): void =>
   ing!.onFrame(JSON.stringify({ type, payload }));
const types = (): string[] => sent.map((m) => m.type);

it("latching turns on DAWN's listening, and starts muted while DAWN is speaking", () => {
   const mic = connect();
   frame("state", { state: "speaking" });
   mic.toggleContinuous();
   expect(sent).toContainEqual({ type: "always_on_enable", payload: { sample_rate: 48000 } });
   expect(started).toEqual([true]);
   mic.toggleContinuous(); // tap off
   expect(types()).toContain("always_on_disable");
   expect(stops).toBe(1);
});

it("the echo mute: muted while DAWN speaks, open again a moment after it stops", () => {
   const mic = connect();
   mic.toggleContinuous();
   muted = [];
   frame("state", { state: "speaking" });
   expect(muted).toEqual([true]);
   frame("state", { state: "idle" });
   vi.advanceTimersByTime(799);
   expect(muted).toEqual([true]); // not yet: DAWN's tail could still echo
   vi.advanceTimersByTime(1);
   expect(muted).toEqual([true, false]);
});

it("a wake: the ready ding once, the screensaver woken, and the mic open for the command", () => {
   const mic = connect();
   const woke = vi.fn();
   ing!.onVoiceWake(woke);
   mic.toggleContinuous();
   frame("state", { state: "speaking" }); // even mid-reply, the command is captured
   muted = [];
   frame("always_on_state", { state: "recording" });
   frame("always_on_state", { state: "recording" }); // the same wake, re-sent
   expect(dings).toBe(1);
   expect(woke).toHaveBeenCalledTimes(1);
   expect(muted.at(-1)).toBe(false);
});

it("DAWN turning listening off, or refusing it, releases the mic and isn't re-armed", () => {
   const mic = connect();
   mic.toggleContinuous();
   frame("always_on_state", { state: "disabled" });
   expect(stops).toBe(1);
   mic.toggleContinuous(); // the user latches it again
   frame("error", { code: "ALREADY_ACTIVE", message: "Another tab is listening" });
   expect(stops).toBe(2);
   sent = [];
   mic.toggleContinuous(); // after a refusal the latch is off: this latches anew
   expect(types()).toEqual(["always_on_enable"]);
});
