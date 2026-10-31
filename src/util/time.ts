/*
 * Relative-time + day-bucket formatting for list surfaces (the conversation picker
 * today; jobs / scheduler later). Time-zone aware via safeTimeZone so "Today" /
 * "Yesterday" and weekday labels are computed in DAWN's user zone (the same zone the
 * clock shows), not the browser box's zone (which may be UTC). A shared home so the
 * next list surface does not reinvent it. All inputs are epoch SECONDS (DAWN's wire
 * unit for timestamps).
 */
import { safeTimeZone } from "./tz.ts";

/* The calendar day of `d`, in `tz`, expressed as a UTC midnight so two such values
   subtract to a whole-day difference regardless of zone. Both operands are normalised
   the same way, so the arithmetic is exact across month/DST boundaries. */
function tzMidnightUTC(d: Date, tz: string | undefined): number {
   const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
   }).formatToParts(d);
   const val = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
   return Date.UTC(val("year"), val("month") - 1, val("day"));
}

/* Whole days from the calendar day of `then` to the calendar day of `now`, in `tz`
   (0 = same day, 1 = yesterday, ...). */
function dayDiff(then: Date, now: Date, tz: string | undefined): number {
   return Math.round((tzMidnightUTC(now, tz) - tzMidnightUTC(then, tz)) / 86400000);
}

/* A compact "when" for a list row: just now / 5m / 3h / Yesterday / a weekday within
   the last week / an absolute date beyond that. tz only affects the day-boundary
   decisions (Yesterday / weekday / date), not the sub-day elapsed math. */
export function relativeTime(epochSec: number, tz?: string | null): string {
   const zone = safeTimeZone(tz);
   const then = new Date(epochSec * 1000);
   const now = new Date();
   const elapsedMs = now.getTime() - then.getTime();

   if (elapsedMs < 45_000) return "just now";
   const mins = Math.floor(elapsedMs / 60_000);
   if (mins < 60) return `${mins}m`;
   const hours = Math.floor(elapsedMs / 3_600_000);
   if (hours < 24) return `${hours}h`;

   const days = dayDiff(then, now, zone);
   if (days <= 1) return "Yesterday";
   if (days < 7) return then.toLocaleDateString([], { weekday: "long", timeZone: zone });
   const sameYear = wallParts(then.getTime(), zone).y === wallParts(now.getTime(), zone).y; // the zone's year, not UTC's
   return then.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: sameYear ? undefined : "numeric",
      timeZone: zone
   });
}

/* The group header a row falls under: Today / Yesterday / This Week / "Month YYYY".
   Computed in the user's tz so the buckets line up with the clock, not the box. */
export function dayBucket(epochSec: number, tz?: string | null): string {
   const zone = safeTimeZone(tz);
   const then = new Date(epochSec * 1000);
   const days = dayDiff(then, new Date(), zone);
   if (days <= 0) return "Today";
   if (days === 1) return "Yesterday";
   if (days < 7) return "This Week";
   return then.toLocaleDateString([], { month: "long", year: "numeric", timeZone: zone });
}

/* "YYYY-MM-DD" for an epoch-seconds instant, in the given zone (browser-local when unset or
   invalid); "" for an out-of-range instant. Built from parts, so it never depends on a
   locale's date pattern. */
export function isoDate(epochSec: number, tz?: string | null): string {
   const d = new Date(epochSec * 1000);
   if (Number.isNaN(d.getTime())) return "";
   const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: safeTimeZone(tz),
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
   }).formatToParts(d);
   const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
   return `${get("year")}-${get("month")}-${get("day")}`;
}

/* The zone's wall clock at an instant (epoch ms): calendar date + time of day. */
function wallParts(
   ms: number,
   zone: string | undefined
): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
   const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric"
   }).formatToParts(new Date(ms));
   const val = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
   return {
      y: val("year"),
      mo: val("month"),
      d: val("day"),
      h: val("hour") % 24,
      mi: val("minute"),
      s: val("second")
   };
}

/* Seconds the zone's clock reads ahead of UTC at an instant (epoch ms). */
function offsetSecAt(ms: number, zone: string | undefined): number {
   const w = wallParts(ms, zone);
   return Math.round((Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - ms) / 1000);
}

/* The first instant (epoch seconds) of calendar date y-mo-d in the zone. Usually its midnight;
   where a clock change skips midnight, the moment the clock jumps (the day starts at 01:00).
   Month/day overflow is fine (d + 1 at a month's end is the next month's 1st). */
export function dayStart(y: number, mo: number, d: number, zone: string | undefined): number {
   const wallMs = Date.UTC(y, mo - 1, d);
   const want = new Date(wallMs);
   const onDay = (p: ReturnType<typeof wallParts>): boolean =>
      p.y === want.getUTCFullYear() && p.mo === want.getUTCMonth() + 1 && p.d === want.getUTCDate();
   /* Midnight under each offset in force around it (a day either side covers a change at any
      hour). A clock set back across midnight reads 00:00 twice: the day starts at the first. */
   let first: number | null = null;
   for (const k of [-1, 0, 1]) {
      const t = wallMs - offsetSecAt(wallMs + k * 86400_000, zone) * 1000;
      const p = wallParts(t, zone);
      if (onDay(p) && p.h === 0 && p.mi === 0 && p.s === 0 && (first === null || t < first))
         first = t;
   }
   if (first !== null) return Math.floor(first / 1000);
   let t = wallMs - offsetSecAt(wallMs, zone) * 1000;
   t = wallMs - offsetSecAt(t, zone) * 1000; // again, in case the offset changed in between
   const p = wallParts(t, zone);
   if (!onDay(p)) {
      /* Midnight doesn't exist: t reads on the day before; the day starts where that reading
         would reach 24:00, the jump. */
      t += (86400 - (p.h * 3600 + p.mi * 60 + p.s)) * 1000;
   }
   return Math.floor(t / 1000);
}

/* Today in the zone (browser-local when unset or invalid), as epoch seconds [first instant,
   the next day's first instant): 23 or 25 hours across a clock change, not always 24. */
export function todayWindow(
   tz?: string | null,
   nowMs: number = Date.now()
): { start: number; end: number } {
   const zone = safeTimeZone(tz);
   const w = wallParts(nowMs, zone);
   return { start: dayStart(w.y, w.mo, w.d, zone), end: dayStart(w.y, w.mo, w.d + 1, zone) };
}
