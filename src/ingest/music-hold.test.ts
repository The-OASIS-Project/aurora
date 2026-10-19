// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DawnIngest } from "./dawn-ws.ts";
import type { MusicState } from "./ingest.ts";

/* DawnIngest's music_state handling with a fake player, sink and socket. */
function setup(bufferedMs = 2000) {
   const ing = new DawnIngest() as unknown as Record<string, any>;
   const player = {
      buffered: bufferedMs,
      flushes: 0,
      paused: false,
      bufferedLeadMs() {
         return this.buffered;
      },
      audiblePosition(raw: number) {
         return Math.max(0, raw - this.buffered / 1000);
      },
      setPaused(p: boolean) {
         this.paused = p;
      },
      flush() {
         this.flushes++;
      }
   };
   const shown: MusicState[] = [];
   const positions: number[] = [];
   const sent: Array<Record<string, unknown>> = [];
   ing.music = player;
   ing.sinks = {
      music: { setState: (s: MusicState) => shown.push(s), setPosition: (p: number) => positions.push(p), setError: () => {} }
   };
   ing.ws = { readyState: WebSocket.OPEN, send: (m: string) => sent.push(JSON.parse(m)) };
   ing.musicEnabled = false; // no music socket in these tests
   const frame = (type: string, payload: Record<string, unknown>): void => ing.onFrame(JSON.stringify({ type, payload }));
   const track = (n: number) => ({ path: `/music/${n}.flac`, title: `Song ${n}`, artist: "", album: "", duration_sec: 200 });
   const state = (n: number, extra: Record<string, unknown> = {}) =>
      frame("music_state", { playing: true, paused: false, track: track(n), position_sec: 0, queue_index: n, queue_length: 5, ...extra });
   const controls = () => sent.filter((m) => m.type === "music_control").map((m) => m.payload as Record<string, unknown>);
   return { ing, player, shown, positions, frame, state, controls, last: () => shown[shown.length - 1] };
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] }));
afterEach(() => vi.useRealTimers());

describe("end-of-track music_state hold", () => {
   it("holds the next track until the buffered audio has played, counting the old one to its end", () => {
      const t = setup();
      t.state(1);
      t.state(2, { advance: "auto" });
      expect(t.last().track?.title).toBe("Song 1");
      t.frame("music_position", { position_sec: 1, duration_sec: 200 });
      expect(t.positions[t.positions.length - 1]).toBeCloseTo(198, 0); // the old track's end - 2 s, not the next one's 1 s
      vi.advanceTimersByTime(2000);
      expect(t.last().track?.title).toBe("Song 2");
      expect(t.player.flushes).toBe(0); // gapless
   });

   it("lets the end of the queue play out: the stop applies later and never flushes", () => {
      const t = setup();
      t.state(1);
      t.frame("music_state", { playing: false, paused: false, track: { path: "/music/1.flac", title: "Song 1", duration_sec: 200 }, position_sec: 0, queue_index: 0, advance: "auto" });
      expect(t.last().playing).toBe(true);
      vi.advanceTimersByTime(2000);
      expect(t.last().playing).toBe(false);
      expect(t.last().positionSec).toBe(0);
      expect(t.player.flushes).toBe(0);
   });

   it("applies at once with nothing buffered", () => {
      const t = setup(0);
      t.state(1);
      t.state(2, { advance: "auto" });
      expect(t.last().track?.title).toBe("Song 2");
   });

   it("a loading state then its ready state replace the held one and keep the timer", () => {
      const t = setup();
      t.state(1);
      t.state(2, { advance: "auto", loading: true });
      vi.advanceTimersByTime(1000);
      t.state(2, { advance: "auto" });
      expect(t.last().track?.title).toBe("Song 1");
      vi.advanceTimersByTime(1000); // the original timer, not a fresh 2 s
      expect(t.last().track?.title).toBe("Song 2");
      expect(t.last().loading).toBe(false);
   });

   it("a newer non-auto state lands the held one first", () => {
      const t = setup();
      t.state(1);
      t.state(2, { advance: "auto" });
      vi.advanceTimersByTime(1500); // DAWN's position for track 2 counts from its arrival
      t.frame("music_state", { playing: false, paused: true, track: { path: "/music/2.flac", title: "Song 2", duration_sec: 200 }, position_sec: 1.5, queue_index: 2 });
      expect(t.shown.map((s) => s.track?.title).slice(-2)).toEqual(["Song 2", "Song 2"]);
      expect(t.last().paused).toBe(true);
      expect(t.player.flushes).toBe(0); // the jump from the held ~0 to 1.5 isn't a seek
   });

   it("Next while the next track is held plays that track from the start", () => {
      const t = setup();
      t.state(1);
      t.state(2, { advance: "auto" });
      t.ing.musicControl("next");
      expect(t.controls().pop()).toEqual({ action: "play_index", index: 2 });
      expect(t.last().track?.title).toBe("Song 2");
   });

   it("a seek while held goes back to the heard track, then seeks", () => {
      const t = setup();
      t.state(1);
      t.state(2, { advance: "auto" });
      t.ing.musicControl("seek", { position_sec: 120 });
      expect(t.controls().pop()).toEqual({ action: "play_index", index: 1 });
      expect(t.last().track?.title).toBe("Song 1");
      t.state(1, { loading: true }); // a Plex track opening: DAWN would ignore a seek now
      expect(t.controls().pop()).toEqual({ action: "play_index", index: 1 });
      t.state(1); // ready
      expect(t.controls().pop()).toEqual({ action: "seek", position_sec: 120 });
      vi.advanceTimersByTime(5000);
      expect(t.last().track?.title).toBe("Song 1"); // dropped, never applied
   });

   it("Pause on a held end-of-queue stop stops here and sends nothing", () => {
      const t = setup();
      t.state(1);
      t.frame("music_state", { playing: false, paused: false, track: { path: "/music/1.flac", title: "Song 1", duration_sec: 200 }, position_sec: 0, queue_index: 0, advance: "auto" });
      const before = t.controls().length;
      t.ing.musicControl("pause");
      expect(t.controls().length).toBe(before);
      expect(t.last().playing).toBe(false);
      expect(t.player.flushes).toBe(1);
   });

   it("a different file at the same index is a track change", () => {
      const t = setup(0);
      t.state(0);
      t.frame("music_state", { playing: true, paused: false, track: { path: "/music/other.flac", title: "Other", duration_sec: 100 }, position_sec: 0, queue_index: 0 });
      expect(t.player.flushes).toBe(1);
   });

   it("a control echo right after a held state applies isn't mistaken for a seek", () => {
      const t = setup();
      t.state(1);
      t.state(2, { advance: "auto" });
      vi.advanceTimersByTime(2000); // the held state applies; DAWN is ~2 s into track 2 by now
      vi.advanceTimersByTime(300);
      t.frame("music_state", { playing: true, paused: true, track: { path: "/music/2.flac", title: "Song 2", duration_sec: 200 }, position_sec: 2.3, queue_index: 2 });
      expect(t.player.flushes).toBe(0);
   });

   it("a seek while held stops the watch expecting audio until DAWN answers", () => {
      const t = setup();
      t.state(1);
      t.state(2, { advance: "auto" });
      t.ing.musicControl("seek", { position_sec: 30 });
      expect(t.ing.musicWatch.playing).toBe(false);
   });

   it("Next on a held end-of-queue stop stops here and sends nothing", () => {
      const t = setup();
      t.state(1);
      t.frame("music_state", { playing: false, paused: false, track: { path: "/music/1.flac", title: "Song 1", duration_sec: 200 }, position_sec: 0, queue_index: 0, advance: "auto" });
      const before = t.controls().length;
      t.ing.musicControl("next");
      expect(t.controls().length).toBe(before);
      expect(t.last().playing).toBe(false);
   });

   it("Previous while the next track is held goes to the one before the heard track", () => {
      const t = setup();
      t.state(1);
      t.state(2, { advance: "auto" });
      t.ing.musicControl("previous");
      expect(t.controls().pop()).toEqual({ action: "play_index", index: 0 });
   });

   it("a loading track's counter doesn't run, and the watch expects no audio", () => {
      const t = setup(0);
      t.state(1);
      t.state(2, { advance: "auto", loading: true });
      expect(t.last().loading).toBe(true);
      expect(t.ing.musicWatch.playing).toBe(false);
   });

   it("Previous on a held end-of-queue stop steps back from the heard track", () => {
      const t = setup();
      t.state(3);
      t.frame("music_state", { playing: false, paused: false, track: { path: "/music/0.flac", title: "Song 0", duration_sec: 200 }, position_sec: 0, queue_index: 0, advance: "auto" });
      t.ing.musicControl("previous");
      expect(t.controls().pop()).toEqual({ action: "play_index", index: 2 });
   });
});

describe("a track the shared queue no longer holds (queue_index -1)", () => {
   it("isn't a track change: the position moving under the same track doesn't flush", () => {
      const t = setup();
      t.state(1);
      t.state(1, { queue_index: -1 }); // another client replaced the queue
      t.state(1, { queue_index: 3 }); // or the track sits at a new position
      expect(t.player.flushes).toBe(0);
      t.state(2, { queue_index: 3 }); // a new track at the same position is one
      expect(t.player.flushes).toBe(1);
   });

   it("never sends a play_index of -1 from the held remaps", () => {
      const t = setup();
      t.state(1, { queue_index: -1 });
      t.state(0, { advance: "auto", queue_index: 0 });
      t.ing.musicControl("previous");
      expect(t.controls().pop()).toEqual({ action: "previous" });
      t.state(1, { queue_index: -1 });
      t.state(0, { advance: "auto", queue_index: 0 });
      const sent = t.controls().length;
      t.ing.musicControl("seek", { position: 30 });
      expect(t.controls().length).toBe(sent); // no seek into a song the user wasn't looking at
      expect(t.last().track?.title).toBe("Song 1"); // still the heard track, held as before
      vi.advanceTimersByTime(2000);
      expect(t.last().track?.title).toBe("Song 0"); // the next one lands on time
   });

   it("a seek waiting for its track finds it by path even if the queue moved", () => {
      const t = setup();
      t.state(1);
      t.state(2, { advance: "auto" });
      t.ing.musicControl("seek", { position: 30 });
      expect(t.controls().pop()).toEqual({ action: "play_index", index: 1 });
      t.state(1, { queue_index: 4 }); // another tab replaced the queue meanwhile
      expect(t.controls().pop()).toEqual({ action: "seek", position: 30 });
   });

   it("a declined previous keeps the watch expecting audio", () => {
      const t = setup();
      t.state(1);
      t.ing.musicControl("previous");
      expect(t.ing.musicWatch.playing).toBe(false);
      t.frame("music_error", { code: "NOTHING_EARLIER", message: "Nothing earlier" });
      expect(t.ing.musicWatch.playing).toBe(true);
   });
});
