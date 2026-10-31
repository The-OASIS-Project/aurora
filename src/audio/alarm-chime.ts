/*
 * Scheduler alarm/reminder/timer chime. The client-side audio cue for a firing scheduled
 * event: DAWN's own alarm tone plays on the DAEMON speaker only (not routed to sessions),
 * so each web client plays its own. This deliberately MATCHES the daemon's tones so a client
 * sounds the same as being in the room with the daemon - synthesized from the exact spec in
 * DAWN's common/src/audio/chime.c (dawn_chime_generate / dawn_alarm_tone_generate):
 *   - Reminder/timer chime (playChime): ascending C5-E5-G5 (523/659/784 Hz), 250ms each.
 *   - Ringing-alarm loop (startLoop): alternating A5 (880) 250ms -> E5 (659) 250ms, repeated
 *     with a 200ms gap (the daemon loops the same 500ms buffer with ALARM_GAP_MS).
 * Both notes carry the daemon's linear ADSR (10% attack, 10% decay to 0.7, 60% sustain, 20%
 * release).
 *
 *   - Incoming-call ring (startRing): 440 Hz then 480 Hz bursts every 3 s (the WebUI's phone.js
 *     pattern; the real ring plays only at the daemon).
 *
 * Gated by the "Alarm sounds" preference (System-menu toggle): when off, all are no-ops.
 * Own lazy, isolated AudioContext (suspended when idle so it doesn't hold an output thread);
 * every path error-swallowed - purely cosmetic, must never break the notification flow. Below
 * the render seam (audio I/O only).
 */

/* Reminder/timer chime: ascending C5, E5, G5 (dawn_chime_generate's notes[]). */
const CHIME_NOTES = [523.25, 659.25, 783.99];
const NOTE_DUR = 0.25; // seconds per note (daemon CHIME_NOTE_DURATION_MS / ALARM half)

/* Ringing-alarm tone: A5 then E5 (dawn_alarm_tone_generate), looped with a 200ms gap. */
const ALARM_HI = 880.0;
const ALARM_LO = 659.25;
const ALARM_GAP_MS = 200; // daemon ALARM_GAP_MS between repetitions
const ALARM_PERIOD_MS = NOTE_DUR * 2 * 1000 + ALARM_GAP_MS; // 500ms tone + 200ms gap

/* Peak gain. The daemon plays its 0.5-amplitude tone at ~80% volume; this is a calmer
   client level (tunable). SUSTAIN_FRAC mirrors the daemon envelope's 0.7 sustain. */
const PEAK = 0.3;
const SUSTAIN_FRAC = 0.7;

/* Incoming-call ring (the WebUI's phone.js pattern): a 440 Hz then a 480 Hz burst, repeating
   every 3 s. The real ring only plays at the daemon, so a client rings for itself. */
const RING_HI = 480;
const RING_LO = 440;
const RING_BURST = 0.4; // seconds per tone
const RING_PERIOD_MS = 3000;

/* New-mail chime: one soft, low two-note rise (G5 then C6), quieter than the alarm tones so it
   reads as "for your information", never "needs you". */
const MAIL_NOTES = [783.99, 1046.5];
const MAIL_NOTE = 0.14;
const MAIL_PEAK = 0.12;

export class AlarmChime {
   private ctx: AudioContext | null = null;
   private loopTimer = 0;
   private ringTimer = 0;
   private shotEnd = 0; // context time the last one-shot chime ends (don't suspend under it)
   private enabled: boolean;

   constructor(enabled: boolean) {
      this.enabled = enabled;
   }

   setEnabled(on: boolean): void {
      this.enabled = on;
      if (!on) {
         this.stopLoop();
         this.stopRing();
      }
   }

   isEnabled(): boolean {
      return this.enabled;
   }

   /* The reminder/timer chime: one ascending C-E-G arpeggio (matches the daemon). */
   playChime(): void {
      if (!this.enabled) return;
      const ctx = this.ensure();
      if (!ctx) return;
      try {
         const t = ctx.currentTime;
         let last: OscillatorNode | null = null;
         CHIME_NOTES.forEach((hz, i) => {
            last = this.tone(ctx, hz, t + i * NOTE_DUR, NOTE_DUR);
         });
         this.shotEnd = Math.max(this.shotEnd, t + CHIME_NOTES.length * NOTE_DUR);
         /* Suspend once the last note ends (and no loop is running), so a one-off chime
            doesn't leave the output thread spinning all session. */
         if (last) (last as OscillatorNode).onended = (): void => this.suspendIfIdle(ctx);
      } catch {
         /* cosmetic */
      }
   }

   /* The Mail panel's new-mail chime (opt-in per screen; same "Alarm sounds" gate). */
   playMailChime(): void {
      if (!this.enabled) return;
      const ctx = this.ensure();
      if (!ctx) return;
      try {
         const t = ctx.currentTime;
         let last: OscillatorNode | null = null;
         MAIL_NOTES.forEach((hz, i) => {
            last = this.tone(ctx, hz, t + i * MAIL_NOTE, MAIL_NOTE, MAIL_PEAK);
         });
         this.shotEnd = Math.max(this.shotEnd, t + MAIL_NOTES.length * MAIL_NOTE);
         if (last) (last as OscillatorNode).onended = (): void => this.suspendIfIdle(ctx);
      } catch {
         /* cosmetic */
      }
   }

   /* Begin the ringing-alarm loop (idempotent; shared by all concurrent ringing alarms). */
   startLoop(): void {
      if (!this.enabled || this.loopTimer) return;
      const beat = (): void => {
         const ctx = this.ensure();
         if (!ctx) return;
         try {
            const t = ctx.currentTime;
            this.tone(ctx, ALARM_HI, t, NOTE_DUR);
            this.tone(ctx, ALARM_LO, t + NOTE_DUR, NOTE_DUR);
         } catch {
            /* cosmetic */
         }
      };
      beat(); // first repetition immediately
      this.loopTimer = window.setInterval(beat, ALARM_PERIOD_MS);
   }

   stopLoop(): void {
      if (this.loopTimer) {
         window.clearInterval(this.loopTimer);
         this.loopTimer = 0;
      }
      this.suspendWhenSilent();
   }

   /* Begin the incoming-call ring (idempotent). Gated by the same "Alarm sounds" preference. */
   startRing(): void {
      if (!this.enabled || this.ringTimer) return;
      const burst = (): void => {
         const ctx = this.ensure();
         if (!ctx) return;
         try {
            const t = ctx.currentTime;
            this.tone(ctx, RING_LO, t, RING_BURST);
            this.tone(ctx, RING_HI, t + RING_BURST, RING_BURST);
         } catch {
            /* cosmetic */
         }
      };
      burst();
      this.ringTimer = window.setInterval(burst, RING_PERIOD_MS);
   }

   stopRing(): void {
      if (this.ringTimer) {
         window.clearInterval(this.ringTimer);
         this.ringTimer = 0;
      }
      this.suspendWhenSilent();
   }

   /* Release the audio output thread once nothing is looping (a later tone resumes it). */
   private suspendWhenSilent(): void {
      if (this.loopTimer || this.ringTimer || this.chimePlaying()) return;
      try {
         if (this.ctx && this.ctx.state === "running") void this.ctx.suspend().catch(() => {});
      } catch {
         /* context already torn down */
      }
   }

   /* Lazily create/resume the shared context. Null if it can't be built (all callers no-op). */
   private ensure(): AudioContext | null {
      try {
         if (!this.ctx || this.ctx.state === "closed") this.ctx = new AudioContext();
         if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
         return this.ctx;
      } catch {
         return null;
      }
   }

   /* One sine note with the daemon's linear ADSR: 10% attack to peak, 10% decay to the 0.7
      sustain, 60% sustain, 20% release to zero. Returns the oscillator so the caller can hang
      an onended on the final note. */
   private tone(
      ctx: AudioContext,
      hz: number,
      start: number,
      dur: number,
      peak = PEAK
   ): OscillatorNode {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(hz, start);
      const sustain = peak * SUSTAIN_FRAC;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peak, start + dur * 0.1); // attack
      gain.gain.linearRampToValueAtTime(sustain, start + dur * 0.2); // decay to sustain
      gain.gain.setValueAtTime(sustain, start + dur * 0.8); // hold sustain
      gain.gain.linearRampToValueAtTime(0, start + dur); // release
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur + 0.01);
      return osc;
   }

   /* A one-shot chime is still sounding (another chime's end must not cut it off). */
   private chimePlaying(): boolean {
      return !!this.ctx && this.ctx.currentTime < this.shotEnd - 0.01;
   }

   private suspendIfIdle(ctx: AudioContext): void {
      try {
         if (
            this.ctx === ctx &&
            !this.loopTimer &&
            !this.ringTimer &&
            !this.chimePlaying() &&
            ctx.state === "running"
         ) {
            void ctx.suspend().catch(() => {});
         }
      } catch {
         /* context already torn down */
      }
   }

   dispose(): void {
      this.stopLoop();
      this.stopRing();
      if (this.ctx && this.ctx.state !== "closed") void this.ctx.close().catch(() => {});
      this.ctx = null;
   }
}
