import { describe, expect, it } from "vitest";
import { isoDate } from "./time.ts";

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
