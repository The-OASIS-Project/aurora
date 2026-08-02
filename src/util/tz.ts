/*
 * Time-zone validation. DAWN hands us the user's IANA zone (e.g. "America/New_York");
 * passing an invalid `timeZone` to toLocaleString / Intl.DateTimeFormat throws a
 * RangeError, so a bad or stale zone would break a render. Validate once here and let
 * callers fall back to the browser's local zone (undefined) when it doesn't check out.
 */
export function safeTimeZone(zone: string | undefined | null): string | undefined {
   if (!zone) return undefined;
   try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone }); // throws on an unknown zone
      return zone;
   } catch {
      return undefined; // keep browser-local
   }
}
