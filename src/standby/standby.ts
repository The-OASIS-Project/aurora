/*
 * Ambient standby ("Deep Idle") controller + self-owned overlay view. It drives the pure
 * StandbyMachine from real signals (activity monitor, reactor state, mic, alarm-ringing) and
 * applies the asleep/awake transition to the DOM: a `body.standby` class fades the chrome, the
 * `#standby` overlay becomes the pointer sink + (in P1) hosts the drifting clock, and the
 * injected onStandby(on) dims/undims the reactor. Peer of the notification / music views - it
 * never imports the Anchor (main injects onStandby) and never touches the render seam.
 */

import { StandbyMachine, type ReactorState, type StandbyTransition } from "./machine.ts";
import { mountActivity } from "./activity.ts";
import { getStandbyMin, standbyTimeoutMs } from "./standby-timeout.ts";
import { formatClockTime, formatClockDate } from "../util/clock-format.ts";

/* Drifting-clock motion. Incommensurate periods so the Lissajous path never exactly repeats
   or lingers; amplitude is a fraction of the available half-travel so the text stays fully on
   screen. This continuous drift IS the OLED burn-in defense for the one lit element. */
const DRIFT_TX = 185; // seconds, x period (slow)
const DRIFT_TY = 117; // seconds, y period (incommensurate with TX so the path never repeats)
const DRIFT_FRAC = 0.82; // fraction of the max on-screen travel to use
const HOP_EVERY = 40; // seconds between discrete repositions under reduced motion

export interface StandbyController {
   /* Whether the display is currently in standby (asleep) - lets the frame loop skip
      invisible per-frame work (e.g. the music spectrum draw). */
   isAsleep(): boolean;
   /* Inactivity delay in minutes (0 = Off), from the System-menu picker. */
   setTimeoutMinutes(min: number): void;
   /* The DAWN user's IANA timezone, for the standby clock (the box may be UTC). */
   setTimezone(tz: string | undefined): void;
   /* Decorated reactor sink: busy guard only (never a wake - ambient FYIs must not wake). */
   onReactorState(s: ReactorState): void;
   /* Decorated mic state: "recording" (PTT) is a user wake + busy guard; else not recording. */
   onMicState(s: string): void;
   /* An `urgent` notice (ringing alarm / live timer|reminder|briefing / SAGE alert): peek. */
   wakeForAlert(): void;
   /* A wake-word match (voice input): a full user wake. */
   wakeOnVoice(): void;
   /* Called from the one frame loop: polls alarm-ringing and evaluates the idle timeout. */
   tick(dt: number): void;
   destroy(): void;
}

export function mountStandby(deps: {
   onStandby: (on: boolean) => void; // -> anchor.setStandby
   isAlarmRinging: () => boolean; // -> dawn.isAlarmRinging()
}): StandbyController {
   const machine = new StandbyMachine({ now: () => performance.now() });

   /* Body-mounted so the chrome-fade selector can exclude it by id, and so it layers above the
      body-mounted dialogs/reader/lightbox it must also darken. Empty in P0 (the drifting clock
      is added in P1). Pointer sink only while asleep. */
   const overlay = document.createElement("div");
   overlay.id = "standby";
   overlay.setAttribute("aria-hidden", "true");
   /* The large dim drifting clock: the one lit element in standby, kept moving for burn-in. */
   const clock = document.createElement("div");
   clock.className = "standby-clock";
   const clockTime = document.createElement("div");
   clockTime.className = "standby-clock-time";
   const clockDate = document.createElement("div");
   clockDate.className = "standby-clock-date";
   clock.append(clockTime, clockDate);
   overlay.appendChild(clock);
   document.body.appendChild(overlay);

   let tz: string | undefined;
   let lastSecond = -1;
   let driftT = 0; // drift accumulator (seconds), advanced while asleep
   let hopT = 0; // reduced-motion discrete-reposition accumulator
   const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

   /* The clock is positioned by its TOP-LEFT (absolute translate), left-justified, so as the
      seconds tick and digit widths change the text extends rightward from a fixed left edge -
      it never wobbles side-to-side the way a centered clock would. cx/cy are the resting
      (screen-centered) top-left; ax/ay the drift amplitude. Measured ONCE per standby session
      (and on resize), not per frame - the clock box is effectively fixed size. */
   let cx = 0;
   let cy = 0;
   let ax = 0;
   let ay = 0;
   let measured = false;
   let hopX = 0;
   let hopY = 0;
   const remeasure = (): void => {
      cx = Math.max(0, window.innerWidth - clock.offsetWidth) / 2;
      cy = Math.max(0, window.innerHeight - clock.offsetHeight) / 2;
      ax = cx * DRIFT_FRAC;
      ay = cy * DRIFT_FRAC;
      hopX = cx; // reduced-motion clock rests centered until the first hop
      hopY = cy;
      measured = true;
   };

   /* Refresh the clock text at most once a second. */
   const paintClock = (): void => {
      const now = new Date();
      const s = now.getSeconds();
      if (s === lastSecond) return;
      lastSecond = s;
      clockTime.textContent = formatClockTime(now, tz);
      clockDate.textContent = formatClockDate(now, tz);
   };
   const onResize = (): void => {
      measured = false; // re-measure on the next asleep tick
   };
   window.addEventListener("resize", onResize);

   const place = (x: number, y: number): void => {
      clock.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
   };
   /* Reduced motion: no smooth drift - hop to a fresh random on-screen spot at least ~12% of
      the viewport from the last, so pixels still rotate without continuous motion. */
   const hop = (): void => {
      const minJump = 0.12 * Math.min(window.innerWidth, window.innerHeight);
      for (let i = 0; i < 8; i++) {
         const nx = Math.random() * cx * 2; // [0 .. free width]
         const ny = Math.random() * cy * 2;
         if (Math.hypot(nx - hopX, ny - hopY) >= minJump) {
            hopX = nx;
            hopY = ny;
            break;
         }
      }
      place(hopX, hopY);
   };

   const applyAsleep = (asleep: boolean): void => {
      document.body.classList.toggle("standby", asleep);
      overlay.classList.toggle("on", asleep);
      overlay.style.pointerEvents = asleep ? "auto" : "none";
      if (!asleep) measured = false; // re-measure the clock box on the next standby session
      deps.onStandby(asleep);
   };
   const apply = (tr: StandbyTransition): void => {
      if (tr === "sleep") applyAsleep(true);
      else if (tr === "wake") applyAsleep(false);
   };

   const activity = mountActivity({
      onUserGesture: () => apply(machine.onUserGesture()),
      isAsleep: () => machine.isAsleep()
   });

   const setTimeoutMinutes = (min: number): void => {
      machine.setTimeoutMs(standbyTimeoutMs(min));
   };
   setTimeoutMinutes(getStandbyMin()); // apply the persisted setting on mount

   return {
      isAsleep: () => machine.isAsleep(),
      setTimeoutMinutes,
      setTimezone: (z) => {
         tz = z;
         if (machine.isAsleep()) {
            lastSecond = -1;
            paintClock(); // reflect the new tz immediately if the clock is showing
         }
      },
      onReactorState: (s) => machine.onReactorState(s), // guard only; apply() not called -> no wake
      onMicState: (s) => {
         const rec = s === "recording";
         machine.onMicRecording(rec);
         if (rec) apply(machine.onUserGesture()); // PTT is a user wake
      },
      wakeForAlert: () => apply(machine.onUrgent()),
      wakeOnVoice: () => apply(machine.onUserGesture()),
      tick: (dt) => {
         machine.onAlarmRinging(deps.isAlarmRinging()); // idempotent poll; records the ring's end
         apply(machine.tick());
         if (!machine.isAsleep()) return; // only the standby clock animates, and only while asleep
         paintClock();
         if (!measured) remeasure(); // once per session, after the text is set so the box is real
         if (reduced) {
            hopT += dt;
            if (hopT >= HOP_EVERY) {
               hopT = 0;
               hop();
            }
            return;
         }
         driftT += dt;
         place(
            cx + ax * Math.sin((2 * Math.PI * driftT) / DRIFT_TX),
            cy + ay * Math.sin((2 * Math.PI * driftT) / DRIFT_TY)
         );
      },
      destroy: () => {
         activity.destroy();
         window.removeEventListener("resize", onResize);
         document.body.classList.remove("standby");
         overlay.remove();
         deps.onStandby(false);
      }
   };
}
