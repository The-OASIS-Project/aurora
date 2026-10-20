import { describe, expect, it } from "vitest";
import { isoDate, todayWindow, dayStart } from "./time.ts";

describe("isoDate", () => {
   it("formats YYYY-MM-DD in the given zone, crossing midnight correctly", () => {
      const t = Date.UTC(2026, 8, 29, 2, 30) / 1000; // 2026-09-29 02:30 UTC
      expect(isoDate(t, "UTC")).toBe("2026-09-29");
      expect(isoDate(t, "America/New_York")).toBe("2026-09-28"); // 22:30 the day before
   });

   it("returns empty for an out-of-range instant", () => {
      expect(isoDate(1e13, "UTC")).toBe("");
   });

   it("falls back to browser-local on an invalid zone instead of throwing", () => {
      expect(isoDate(0, "Not/AZone")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
   });
});

describe("todayWindow / dayStart", () => {
   const day = (sec: number, tz: string): string =>
      new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(sec * 1000));
   const clock = (sec: number, tz: string): string =>
      new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(sec * 1000));
   /* The window is exactly the zone's calendar day: its first second is on that date and the
      second before it isn't, and the same at the end. */
   const expectDay = (w: { start: number; end: number }, date: string, tz: string): void => {
      expect(day(w.start, tz)).toBe(date);
      expect(day(w.start - 1, tz)).not.toBe(date);
      expect(day(w.end - 1, tz)).toBe(date);
      expect(day(w.end, tz)).not.toBe(date);
   };

   it("an ordinary day is 24 hours from midnight, half-hour zones included", () => {
      const w = todayWindow("Asia/Kolkata", Date.parse("2026-10-19T12:00:00Z"));
      expectDay(w, "2026-10-19", "Asia/Kolkata");
      expect(w.end - w.start).toBe(86400);
      expect(clock(w.start, "Asia/Kolkata")).toBe("00:00");
   });

   it("a spring-forward day is 23 hours and a fall-back day 25", () => {
      const spring = todayWindow("America/New_York", Date.parse("2026-03-08T18:00:00Z"));
      expectDay(spring, "2026-03-08", "America/New_York");
      expect(spring.end - spring.start).toBe(23 * 3600);
      const fall = todayWindow("America/New_York", Date.parse("2026-11-01T18:00:00Z"));
      expectDay(fall, "2026-11-01", "America/New_York");
      expect(fall.end - fall.start).toBe(25 * 3600);
   });

   it("a day whose midnight is skipped starts when the clock jumps", () => {
      /* Chile springs forward at 24:00 on the first Saturday of September: 6 Sep 2026 has no 00:00. */
      const w = todayWindow("America/Santiago", Date.parse("2026-09-06T15:00:00Z"));
      expectDay(w, "2026-09-06", "America/Santiago");
      expect(clock(w.start, "America/Santiago")).toBe("01:00");
      expect(w.end - w.start).toBe(23 * 3600);
   });

   it("the day before a skipped midnight ends at the jump", () => {
      const w = todayWindow("America/Santiago", Date.parse("2026-09-05T15:00:00Z"));
      expectDay(w, "2026-09-05", "America/Santiago");
      expect(w.end - w.start).toBe(86400);
   });

   it("a clock set back across midnight starts the day at the first 00:00", () => {
      /* Vostok went from +7 to +5 at 02:00 on 18 Dec 2023, so midnight came twice. */
      const w = todayWindow("Antarctica/Vostok", Date.parse("2023-12-18T12:00:00Z"));
      expectDay(w, "2023-12-18", "Antarctica/Vostok");
      expect(w.start).toBe(Date.parse("2023-12-17T17:00:00Z") / 1000);
   });

   it("an unknown zone falls back to the browser's", () => {
      const now = Date.parse("2026-10-19T12:00:00Z");
      expect(todayWindow("Not/AZone", now)).toEqual(todayWindow(undefined, now));
   });

   it("dayStart rolls over a month's end", () => {
      expect(dayStart(2026, 10, 32, "UTC")).toBe(Date.parse("2026-11-01T00:00:00Z") / 1000);
   });
});
