/*
 * Holding DAWN's end-of-track music_state until the listener actually gets there.
 *
 * DAWN streams music ~2 s ahead of what is heard (the closed-loop buffer Aurora reports as
 * buffered_ms). At a natural track end it sends the next track's music_state (advance:"auto") at
 * once, and at the natural end of the queue a stop with advance:"auto", while the listener still
 * has the old track's last ~2 s buffered. Applied at once, the title and length switch early and
 * the counter never reaches the end. So an auto state that arrives while playing with audio
 * buffered is held for the buffered depth, then applied (the DAWN WebUI does the same,
 * www/js/audio/music-playback.js).
 *
 * The rules around a held state (what a newer state, Next, a seek or Pause does to it) live in
 * DawnIngest; this class only owns the one held state and its timer.
 */

import type { MusicState } from "./ingest.ts";

export interface HeldMusicState {
   payload: Record<string, unknown>;
   state: MusicState;
   applyAt: number; // performance.now() when it applies on its own
   arrivedAt: number; // performance.now() when DAWN's state arrived: its position counts from here
}

export class MusicStateHold {
   private held: HeldMusicState | null = null;
   private timer = 0;

   /* `apply` runs the held state through the normal handling, given when it arrived. */
   constructor(
      private readonly apply: (
         payload: Record<string, unknown>,
         state: MusicState,
         arrivedAt: number
      ) => void
   ) {}

   /* Hold this state for `ms`, then apply it. Any state already held is applied first. */
   hold(payload: Record<string, unknown>, state: MusicState, ms: number): void {
      this.resolve();
      const now = performance.now();
      this.held = { payload, state, applyAt: now + ms, arrivedAt: now };
      this.timer = window.setTimeout(() => this.resolve(), ms);
   }

   /* A later state for the same transition (the ready state after a loading one): it replaces
      the held one and keeps the timer, which still ends when the heard track does. */
   replace(payload: Record<string, unknown>, state: MusicState): void {
      if (!this.held) return;
      this.held = { ...this.held, payload, state, arrivedAt: performance.now() };
   }

   peek(): HeldMusicState | null {
      return this.held;
   }

   /* Seconds until the held state applies on its own (0 when nothing is held). */
   remainingSec(): number {
      return this.held ? Math.max(0, (this.held.applyAt - performance.now()) / 1000) : 0;
   }

   /* Apply the held state now. True if there was one. */
   resolve(): boolean {
      const h = this.take();
      if (!h) return false;
      this.apply(h.payload, h.state, h.arrivedAt);
      return true;
   }

   /* Forget the held state without applying it. */
   drop(): void {
      this.take();
   }

   private take(): HeldMusicState | null {
      window.clearTimeout(this.timer);
      this.timer = 0;
      const h = this.held;
      this.held = null;
      return h;
   }
}
