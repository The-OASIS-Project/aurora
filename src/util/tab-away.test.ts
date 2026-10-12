// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TAB_AWAY_GRACE_MS, watchTabAway } from "./tab-away.ts";

let hidden = false;
const setHidden = (h: boolean): void => {
   hidden = h;
   document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
   hidden = false;
   Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
   vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => vi.useRealTimers());

describe("tab away", () => {
   it("counts a hidden tab as away only after the grace period, and a return at once", () => {
      const seen: boolean[] = [];
      const t = watchTabAway((a) => seen.push(a));
      setHidden(true);
      vi.advanceTimersByTime(TAB_AWAY_GRACE_MS - 1);
      expect(t.away()).toBe(false);
      vi.advanceTimersByTime(1);
      expect(t.away()).toBe(true);
      setHidden(false);
      expect(t.away()).toBe(false);
      expect(seen).toEqual([true, false]);
      t.dispose();
   });

   it("ignores a quick hop to another tab and back", () => {
      const seen: boolean[] = [];
      const t = watchTabAway((a) => seen.push(a));
      setHidden(true);
      vi.advanceTimersByTime(30_000);
      setHidden(false);
      vi.advanceTimersByTime(TAB_AWAY_GRACE_MS * 2);
      expect(seen).toEqual([]);
      expect(t.away()).toBe(false);
      t.dispose();
   });

   it("starts away in a tab that loads hidden", () => {
      hidden = true;
      const t = watchTabAway(() => {});
      expect(t.away()).toBe(true);
      t.dispose();
   });

   it("stops after dispose", () => {
      const seen: boolean[] = [];
      const t = watchTabAway((a) => seen.push(a));
      setHidden(true);
      t.dispose();
      vi.advanceTimersByTime(TAB_AWAY_GRACE_MS * 2);
      setHidden(false);
      expect(seen).toEqual([]);
   });
});
