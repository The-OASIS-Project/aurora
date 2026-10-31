import { describe, expect, it } from "vitest";
import { formatCacheState } from "./cache-state.ts";

describe("formatCacheState", () => {
   it("labels known states and flags only a warm miss", () => {
      expect(formatCacheState("warm")).toEqual({ text: "Warm", flag: false });
      expect(formatCacheState("warm_miss")).toEqual({ text: "Missed", flag: true });
      expect(formatCacheState("model")).toEqual({ text: "Model changed", flag: false });
   });
   it("shows nothing to judge for untracked, unknown, or absent", () => {
      for (const s of ["untracked", "something_new", undefined, 7])
         expect(formatCacheState(s)).toEqual({ text: "--", flag: false });
   });
});
