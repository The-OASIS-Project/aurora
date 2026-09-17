/*
 * StandbyMachine: the pure decision core of the ambient-standby ("Deep Idle") screensaver.
 * No DOM, no timers, no globals - it takes events + an injected clock and, on each tick,
 * decides whether the display should be asleep. The view (standby.ts) owns the DOM and
 * feeds this machine; this file is what the vitest suite pins.
 *
 * Model (reviewed):
 *  - A USER wake (mouse/key/wheel/PTT/wake-word) starts a full session on the inactivity
 *    timeout. A PEEK wake (an `urgent` notice) is temporary: it returns to standby after a
 *    short RETURN delay once nothing is busy, and any user gesture PROMOTES it to a full
 *    session.
 *  - Never sleep while busy: reactor mid-turn (listening/thinking/speaking - NOT `error`,
 *    which is a latched failure state cleared only by the next turn), an alarm actually
 *    RINGING (from the ingest's ringing set, not a lingering `critical` card), or the mic
 *    actually RECORDING (NOT the continuous-listening `listening` latch).
 *  - The peek return timer is DEFERRED while busy and counts from the moment busy clears
 *    (so a ringing alarm holds the display up until it stops, then it returns).
 */

export type ReactorState = "idle" | "listening" | "thinking" | "speaking" | "error";

/* The asleep-state flip a mutator/tick caused, for the view to drive DOM (null = no change). */
export type StandbyTransition = "sleep" | "wake" | null;

const DEFAULT_RETURN_MS = 60_000; // peek auto-return delay, capped to the inactivity timeout

export class StandbyMachine {
   private readonly now: () => number;
   private readonly returnMs: number;

   private timeoutMs = 0; // 0 = disabled (Off): never sleeps
   private asleep = false;
   private mode: "user" | "peek" = "user";

   private lastActivity: number;
   private peekAt = 0;
   private lastBusyClear: number;

   private reactorBusy = false;
   private alarmRinging = false;
   private micRecording = false;

   constructor(deps: { now: () => number; returnMs?: number }) {
      this.now = deps.now;
      this.returnMs = deps.returnMs ?? DEFAULT_RETURN_MS;
      const t = this.now();
      this.lastActivity = t;
      this.lastBusyClear = t;
   }

   isAsleep(): boolean {
      return this.asleep;
   }

   /* Inactivity delay in ms; 0 = Off. Re-arms the countdown from now. */
   setTimeoutMs(ms: number): void {
      this.timeoutMs = Math.max(0, ms);
      this.lastActivity = this.now();
   }

   private busy(): boolean {
      return this.reactorBusy || this.alarmRinging || this.micRecording;
   }

   /* Apply a busy-source change and record the falling edge, so the peek return timer can
      count from the instant the display stopped being busy. */
   private updateBusy(mut: () => void): void {
      const was = this.busy();
      mut();
      if (was && !this.busy()) this.lastBusyClear = this.now();
   }

   onReactorState(s: ReactorState): void {
      const b = s === "listening" || s === "thinking" || s === "speaking";
      this.updateBusy(() => (this.reactorBusy = b));
   }

   onAlarmRinging(ringing: boolean): void {
      this.updateBusy(() => (this.alarmRinging = ringing));
   }

   onMicRecording(recording: boolean): void {
      this.updateBusy(() => (this.micRecording = recording));
   }

   /* A genuine user gesture (mouse/key/wheel/PTT/wake-word). Wakes to a full session and
      promotes a peek. Returns the resulting transition. */
   onUserGesture(): StandbyTransition {
      this.lastActivity = this.now();
      this.mode = "user";
      if (this.asleep) {
         this.asleep = false;
         return "wake";
      }
      return null;
   }

   /* An `urgent` notice (ringing alarm, live timer/reminder/briefing, SAGE alert). Peeks
      the display if asleep, or refreshes an in-progress peek; a no-op during a user session
      (an urgent alert never shortens a session the user is in). */
   onUrgent(): StandbyTransition {
      const t = this.now();
      if (this.asleep) {
         this.asleep = false;
         this.mode = "peek";
         this.peekAt = t;
         return "wake";
      }
      if (this.mode === "peek") this.peekAt = t; // extend/refresh a live peek
      return null;
   }

   private windowMs(): number {
      return this.mode === "peek" ? Math.min(this.returnMs, this.timeoutMs) : this.timeoutMs;
   }

   private anchorTs(): number {
      const base = this.mode === "peek" ? this.peekAt : this.lastActivity;
      return Math.max(base, this.lastBusyClear); // deferred while / just after busy
   }

   /* Advance the clock; sleeps if the (mode-appropriate) idle window has elapsed and nothing
      is busy. Only ever transitions awake -> asleep (waking is event-driven, above). */
   tick(): StandbyTransition {
      if (this.asleep || this.timeoutMs === 0 || this.busy()) return null;
      if (this.now() - this.anchorTs() >= this.windowMs()) {
         this.asleep = true;
         return "sleep";
      }
      return null;
   }
}
