/*
 * Liveness for the dedicated dawn-music socket. A proxy in front of DAWN (the Vite dev proxy, or a
 * production reverse proxy) can keep the browser's side of the socket OPEN after DAWN's side has
 * closed: onclose never fires, DAWN logs "no dedicated music socket connected" and drops every
 * frame, and the player sits silent until a reload. The socket carries no ping, so liveness comes
 * from what it should be doing:
 *
 *   connecting -> it must open and get DAWN's auth_ok within CONNECT_TIMEOUT_MS;
 *   playing    -> while DAWN says music is playing (music_state on the main socket), audio frames
 *                 arrive every 20 ms, so STALL_MS without one means the socket is dead.
 *
 * Idle (nothing playing) has no frames to expect, so an idle socket is never declared dead; a dead
 * idle socket is caught by the stall check as soon as playback starts. DawnIngest owns the socket
 * and reacts to onDead (close it, run the normal retries); this class only keeps the clock.
 */

export const MUSIC_CONNECT_TIMEOUT_MS = 10_000;
export const MUSIC_STALL_MS = 5_000;
const TICK_MS = 1_000;

export type MusicDeadReason = "connect" | "stall";

export class MusicSocketWatch {
   private timer = 0;
   private openedAt = 0; // when the current socket was created (connect/auth deadline base)
   private authed = false;
   private playing = false;
   private lastAudioAt = 0; // last audio frame, or the start of the current expectation window
   private stallsHeld = false; // stop judging by silence until audio or a fresh start of playback

   constructor(private readonly onDead: (reason: MusicDeadReason) => void) {}

   /* A new socket was created: start the connect/auth deadline. */
   opened(): void {
      this.stop();
      this.openedAt = performance.now();
      this.authed = false;
      this.timer = window.setInterval(() => this.tick(), TICK_MS);
   }

   /* auth_ok: the socket is attached. Frames are expected from now on while playing. */
   attached(): void {
      this.authed = true;
      this.lastAudioAt = performance.now();
   }

   audio(): void {
      this.lastAudioAt = performance.now();
      this.stallsHeld = false;
   }

   /* Fresh sockets kept getting nothing while DAWN said "playing": the silence is DAWN's, not the
      socket's. Keep the socket (so audio plays the moment DAWN sends it) but stop replacing it for
      silence until audio arrives or playback starts again. Survives opened(). */
   holdStalls(): void {
      this.stallsHeld = true;
   }

   /* DAWN's playing-and-not-paused state. Starting playback opens a fresh window, so a resume
      after a long pause isn't measured from the last frame before it. */
   setPlaying(playing: boolean): void {
      if (playing && !this.playing) {
         this.lastAudioAt = performance.now();
         this.stallsHeld = false;
      }
      this.playing = playing;
   }

   /* The socket is gone (closed on purpose or by DAWN): nothing to watch until the next opened(). */
   stop(): void {
      window.clearInterval(this.timer);
      this.timer = 0;
   }

   private tick(): void {
      const now = performance.now();
      if (!this.authed) {
         if (now - this.openedAt >= MUSIC_CONNECT_TIMEOUT_MS) this.dead("connect");
      } else if (this.playing && !this.stallsHeld && now - this.lastAudioAt >= MUSIC_STALL_MS) {
         this.dead("stall");
      }
   }

   private dead(reason: MusicDeadReason): void {
      this.stop();
      this.onDead(reason);
   }
}
