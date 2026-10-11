// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MUSIC_CONNECT_TIMEOUT_MS, MUSIC_STALL_MS, MusicSocketWatch, type MusicDeadReason } from "./music-watch.ts";

function setup() {
   const dead: MusicDeadReason[] = [];
   const watch = new MusicSocketWatch((r) => dead.push(r));
   return { watch, dead };
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] }));
afterEach(() => vi.useRealTimers());

describe("music socket watch", () => {
   it("declares a socket dead when it never gets auth_ok", () => {
      const t = setup();
      t.watch.opened();
      vi.advanceTimersByTime(MUSIC_CONNECT_TIMEOUT_MS - 1000);
      expect(t.dead).toEqual([]);
      vi.advanceTimersByTime(1000);
      expect(t.dead).toEqual(["connect"]);
      vi.advanceTimersByTime(60_000);
      expect(t.dead).toEqual(["connect"]); // fires once, then stops
   });

   it("never declares an idle attached socket dead", () => {
      const t = setup();
      t.watch.opened();
      t.watch.attached();
      vi.advanceTimersByTime(10 * 60_000);
      expect(t.dead).toEqual([]);
   });

   it("stays quiet while audio keeps arriving during playback", () => {
      const t = setup();
      t.watch.opened();
      t.watch.attached();
      t.watch.setPlaying(true);
      for (let i = 0; i < 60; i++) {
         vi.advanceTimersByTime(1000);
         t.watch.audio();
      }
      expect(t.dead).toEqual([]);
   });

   it("declares a stall when playback is on but no audio arrives", () => {
      const t = setup();
      t.watch.opened();
      t.watch.attached();
      vi.advanceTimersByTime(30_000); // a long idle first doesn't count against playback
      t.watch.setPlaying(true);
      vi.advanceTimersByTime(MUSIC_STALL_MS - 1000);
      expect(t.dead).toEqual([]);
      vi.advanceTimersByTime(1000);
      expect(t.dead).toEqual(["stall"]);
   });

   it("measures a resume from the resume, not from the last frame before the pause", () => {
      const t = setup();
      t.watch.opened();
      t.watch.attached();
      t.watch.setPlaying(true);
      t.watch.audio();
      t.watch.setPlaying(false); // paused: DAWN stops streaming
      vi.advanceTimersByTime(60_000);
      t.watch.setPlaying(true);
      vi.advanceTimersByTime(MUSIC_STALL_MS - 1000);
      expect(t.dead).toEqual([]);
   });

   it("does nothing after stop()", () => {
      const t = setup();
      t.watch.opened();
      t.watch.stop();
      vi.advanceTimersByTime(MUSIC_CONNECT_TIMEOUT_MS * 3);
      expect(t.dead).toEqual([]);
   });

   it("a new socket restarts the connect deadline", () => {
      const t = setup();
      t.watch.opened();
      vi.advanceTimersByTime(MUSIC_CONNECT_TIMEOUT_MS - 2000);
      t.watch.opened();
      vi.advanceTimersByTime(MUSIC_CONNECT_TIMEOUT_MS - 2000);
      expect(t.dead).toEqual([]);
   });

   it("a hold keeps an attached socket through silence until audio or a fresh start", () => {
      const t = setup();
      t.watch.setPlaying(true); // DAWN already says playing when the cap is hit
      t.watch.holdStalls();
      t.watch.opened(); // the hold survives a new socket
      t.watch.attached();
      vi.advanceTimersByTime(60_000);
      expect(t.dead).toEqual([]);
      t.watch.audio(); // DAWN sends again: back to normal judging
      vi.advanceTimersByTime(MUSIC_STALL_MS);
      expect(t.dead).toEqual(["stall"]);
   });

   it("a new start of playback releases a hold", () => {
      const t = setup();
      t.watch.opened();
      t.watch.attached();
      t.watch.setPlaying(true);
      t.watch.holdStalls();
      t.watch.setPlaying(false);
      t.watch.setPlaying(true);
      vi.advanceTimersByTime(MUSIC_STALL_MS);
      expect(t.dead).toEqual(["stall"]);
   });
});
