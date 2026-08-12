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
   const sameYear = tzMidnightUTC(then, zone) >= Date.UTC(now.getUTCFullYear(), 0, 1);
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
