/*
 * Shared clock formatting: the HUD clock and the standby screensaver clock both render the
 * same 24-hour time + uppercase date in the DAWN user's timezone (the box running Chrome may
 * be UTC). Extracted so there is one source of truth for the format, not a DOM-coupled copy.
 */

const TIME_OPTS: Intl.DateTimeFormatOptions = {
   hour12: false,
   hour: "2-digit",
   minute: "2-digit",
   second: "2-digit"
};
const DATE_OPTS: Intl.DateTimeFormatOptions = {
   weekday: "short",
   day: "2-digit",
   month: "short",
   year: "numeric"
};

/* HH:MM:SS in the given IANA tz (or the local tz when undefined). */
export function formatClockTime(now: Date, tz?: string): string {
   return now.toLocaleTimeString("en-GB", tz ? { ...TIME_OPTS, timeZone: tz } : TIME_OPTS);
}

/* "WED 17 SEP 2026" in the given IANA tz (or local). */
export function formatClockDate(now: Date, tz?: string): string {
   return now
      .toLocaleDateString("en-US", tz ? { ...DATE_OPTS, timeZone: tz } : DATE_OPTS)
      .toUpperCase();
}
