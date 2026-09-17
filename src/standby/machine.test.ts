import { describe, it, expect } from "vitest";
import { StandbyMachine } from "./machine.ts";

/* A controllable clock so the pure machine can be advanced deterministically. */
function harness(opts?: { returnMs?: number }) {
   let t = 0;
   const m = new StandbyMachine({ now: () => t, returnMs: opts?.returnMs ?? 60_000 });
   return {
      m,
      at(ms: number) {
         t = ms;
      },
      advance(ms: number) {
         t += ms;
      }
   };
}

const TEN_MIN = 10 * 60_000;

describe("StandbyMachine", () => {
   it("Off (timeout 0) never sleeps", () => {
      const h = harness();
      h.m.setTimeoutMs(0);
      h.at(10 * TEN_MIN);
      expect(h.m.tick()).toBeNull();
      expect(h.m.isAsleep()).toBe(false);
   });

   it("sleeps once the inactivity window elapses, not before", () => {
      const h = harness();
      h.m.setTimeoutMs(1000);
      h.at(999);
      expect(h.m.tick()).toBeNull();
      h.at(1000);
      expect(h.m.tick()).toBe("sleep");
      expect(h.m.isAsleep()).toBe(true);
   });

   it("a user gesture wakes and starts a full session", () => {
      const h = harness();
      h.m.setTimeoutMs(1000);
      h.at(1000);
      h.m.tick(); // asleep
      expect(h.m.onUserGesture()).toBe("wake");
      expect(h.m.isAsleep()).toBe(false);
      // full session: doesn't re-sleep until a fresh window from the gesture
      h.at(1000 + 999);
      expect(h.m.tick()).toBeNull();
      h.at(1000 + 1000);
      expect(h.m.tick()).toBe("sleep");
   });

   it("reactor error is NOT busy (still sleeps after a failed turn)", () => {
      const h = harness();
      h.m.setTimeoutMs(1000);
      h.m.onReactorState("error");
      h.at(1000);
      expect(h.m.tick()).toBe("sleep");
   });

   it("reactor thinking/speaking/listening defers sleep; counts from busy-clear", () => {
      const h = harness();
      h.m.setTimeoutMs(1000);
      h.m.onReactorState("thinking");
      h.at(1000);
      expect(h.m.tick()).toBeNull(); // busy
      h.at(1000);
      h.m.onReactorState("idle"); // busy clears at t=1000
      h.at(1999);
      expect(h.m.tick()).toBeNull(); // window counts from the clear
      h.at(2000);
      expect(h.m.tick()).toBe("sleep");
   });

   it("a ringing alarm defers sleep; the mic 'recording' too", () => {
      const h = harness();
      h.m.setTimeoutMs(1000);
      h.m.onAlarmRinging(true);
      h.at(5000);
      expect(h.m.tick()).toBeNull();
      h.m.onAlarmRinging(false); // clears at 5000
      h.m.onMicRecording(true); // still busy
      h.at(9000);
      expect(h.m.tick()).toBeNull();
      h.m.onMicRecording(false); // clears at 9000
      h.at(9999);
      expect(h.m.tick()).toBeNull();
      h.at(10_000);
      expect(h.m.tick()).toBe("sleep");
   });

   it("a non-ringing urgent notice peeks and auto-returns after the return window", () => {
      const h = harness({ returnMs: 60_000 });
      h.m.setTimeoutMs(TEN_MIN);
      h.at(TEN_MIN);
      h.m.tick(); // asleep
      expect(h.m.onUrgent()).toBe("wake"); // peek
      expect(h.m.isAsleep()).toBe(false);
      h.at(TEN_MIN + 59_999);
      expect(h.m.tick()).toBeNull();
      h.at(TEN_MIN + 60_000);
      expect(h.m.tick()).toBe("sleep"); // returned to standby
   });

   it("a peek defers its return while an alarm rings, then counts from when it stops", () => {
      const h = harness({ returnMs: 60_000 });
      h.m.setTimeoutMs(TEN_MIN);
      h.at(TEN_MIN);
      h.m.tick();
      h.m.onUrgent(); // peek at TEN_MIN
      h.m.onAlarmRinging(true);
      h.at(TEN_MIN + 120_000); // long past the return window, still ringing
      expect(h.m.tick()).toBeNull();
      const stop = TEN_MIN + 120_000;
      h.m.onAlarmRinging(false); // clears
      h.at(stop + 59_999);
      expect(h.m.tick()).toBeNull();
      h.at(stop + 60_000);
      expect(h.m.tick()).toBe("sleep");
   });

   it("a user gesture during a peek promotes to a full session", () => {
      const h = harness({ returnMs: 60_000 });
      h.m.setTimeoutMs(TEN_MIN);
      h.at(TEN_MIN);
      h.m.tick();
      h.m.onUrgent(); // peek
      h.at(TEN_MIN + 10_000);
      expect(h.m.onUserGesture()).toBeNull(); // already awake, promotes
      // now a FULL window from the gesture, not the short return
      h.at(TEN_MIN + 10_000 + 60_000);
      expect(h.m.tick()).toBeNull(); // would have re-slept if still a peek
      h.at(TEN_MIN + 10_000 + TEN_MIN);
      expect(h.m.tick()).toBe("sleep");
   });

   it("an urgent during a user session does not shorten it", () => {
      const h = harness();
      h.m.setTimeoutMs(TEN_MIN); // lastActivity = 0
      h.at(TEN_MIN / 2);
      expect(h.m.onUrgent()).toBeNull(); // no-op during a user session
      h.at(TEN_MIN - 1);
      expect(h.m.tick()).toBeNull();
      h.at(TEN_MIN);
      expect(h.m.tick()).toBe("sleep"); // window unchanged by the urgent
   });

   it("the peek return window is capped to the (shorter) inactivity timeout", () => {
      const h = harness({ returnMs: 60_000 });
      h.m.setTimeoutMs(30_000); // shorter than the 60s return
      h.at(30_000);
      h.m.tick(); // asleep
      h.m.onUrgent(); // peek at 30_000
      h.at(30_000 + 30_000); // returns after the timeout, not 60s
      expect(h.m.tick()).toBe("sleep");
   });
});
