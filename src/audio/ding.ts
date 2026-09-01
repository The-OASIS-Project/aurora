/*
 * The always-on "ready" ding. When DAWN's bare-wake flow enters `always_on_state:
 * recording` (it dropped the spoken "Hello." greeting that caused the echo hang), Aurora
 * plays this short synthesized tone as the acknowledgement that DAWN is listening for the
 * command.
 *
 * Why a synthesized tone and not a voice clip: DAWN's server-side VAD does NOT score a
 * pure enveloped tone as speech, so it is echo-safe even though the continuous mic is held
 * OPEN during recording (see the mic-open fix in dawn-ws.ts) - the tone can bleed into the
 * capture without re-triggering the end-of-speech stall the greeting caused. So it needs no
 * mic-mute and no AEC referencing, unlike TTS.
 *
 * It owns a dedicated AudioContext, isolated from the TTS playback and mic capture graphs,
 * lazily created (always-on is armed by a user gesture, so audio is already unlocked). It is
 * purely cosmetic: every path swallows errors so a failed ding can never break the voice
 * flow. Below the render seam (audio I/O only).
 */

/* Tone shape - tuned in-browser. A short rising two-note "go ahead". Kept low-peak and
   click-free (exponential attack/release). Change these to retune; nothing else moves. */
const NOTE1_HZ = 784; // G5
const NOTE2_HZ = 1047; // C6, the rising resolve
const NOTE2_AT = 0.08; // when the pitch steps up (sec from start)
const PEAK_GAIN = 0.12; // low peak: an acknowledgement, not an alarm
const ATTACK_AT = 0.015; // exponential attack target time
const RELEASE_AT = 0.18; // exponential release back to silence
const STOP_AT = 0.2; // hard stop (a beat after the release settles)

export class RecordingDing {
   private ctx: AudioContext | null = null;

   /* Play the ding once. Safe to call on every entry into `recording`; the caller guards
      the once-per-wake transition. Fully error-swallowed - cosmetic, never load-bearing. */
   play(): void {
      try {
         if (!this.ctx || this.ctx.state === "closed") this.ctx = new AudioContext();
         const ctx = this.ctx;
         if (ctx.state === "suspended") void ctx.resume().catch(() => {});
         const t = ctx.currentTime;
         const osc = ctx.createOscillator();
         const gain = ctx.createGain();
         osc.type = "sine";
         osc.frequency.setValueAtTime(NOTE1_HZ, t);
         osc.frequency.setValueAtTime(NOTE2_HZ, t + NOTE2_AT);
         /* Ramp from ~0 (exponential ramps can't touch zero) up then back down. */
         gain.gain.setValueAtTime(0.0001, t);
         gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, t + ATTACK_AT);
         gain.gain.exponentialRampToValueAtTime(0.0001, t + RELEASE_AT);
         osc.connect(gain).connect(ctx.destination);
         /* Suspend once the tone has fully played (dings are seconds apart at minimum) so we
            don't hold an idle audio output thread all session; play() resumes it next wake. */
         osc.onended = (): void => {
            try {
               if (this.ctx === ctx && ctx.state === "running") void ctx.suspend().catch(() => {});
            } catch {
               /* context already torn down */
            }
         };
         osc.start(t);
         osc.stop(t + STOP_AT);
      } catch {
         /* cosmetic - a failed ding must never break the voice flow */
      }
   }

   dispose(): void {
      if (this.ctx && this.ctx.state !== "closed") void this.ctx.close().catch(() => {});
      this.ctx = null;
   }
}
