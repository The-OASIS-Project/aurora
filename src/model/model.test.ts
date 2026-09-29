import { describe, expect, it } from "vitest";
import {
   effortLabel,
   formatBudgetTokens,
   nearestEffort,
   parseReasoningCaps,
   reasoningModeLabel,
   reasoningNote,
   toReasoning
} from "./model.ts";

describe("parseReasoningCaps", () => {
   it("returns null for an absent or malformed caps object (older server)", () => {
      expect(parseReasoningCaps(undefined)).toBeNull();
      expect(parseReasoningCaps({})).toBeNull();
      expect(parseReasoningCaps({ modes: "x" })).toBeNull();
   });

   it("keeps an explicit empty modes list (unsupported, not unknown)", () => {
      expect(parseReasoningCaps({ modes: [] })?.modes).toEqual([]);
   });

   it("parses modes in order and drops unknown modes, duplicates and 'none'", () => {
      const caps = parseReasoningCaps({
         source: "row",
         modes: [
            { mode: "disabled", efforts: [], budget: false },
            { mode: "bogus", efforts: ["low"] },
            { mode: "enabled", efforts: ["none", "low", "medium"], budget: true, budget_tokens: { low: 1024, medium: 8192, bad: -1 } },
            { mode: "enabled", efforts: ["high"] }
         ],
         default: { mode: "enabled", effort: "low" }
      });
      expect(caps?.modes.map((m) => m.mode)).toEqual(["disabled", "enabled"]);
      expect(caps?.modes[1].efforts).toEqual(["low", "medium"]);
      expect(caps?.modes[1].budget).toBe(true);
      expect(caps?.modes[1].budgetTokens).toEqual({ low: 1024, medium: 8192 });
      expect(caps?.default).toEqual({ mode: "enabled", effort: "low" });
   });

   it("tolerates a missing or invalid default", () => {
      expect(parseReasoningCaps({ modes: [{ mode: "adaptive", efforts: ["low"] }], default: { mode: "x" } })?.default).toEqual({
         mode: "",
         effort: ""
      });
   });
});

describe("reasoning labels", () => {
   it("maps legacy auto to enabled and rejects unknowns", () => {
      expect(toReasoning("auto")).toBe("enabled");
      expect(toReasoning("adaptive")).toBe("adaptive");
      expect(toReasoning("sometimes")).toBeNull();
   });

   it("labels modes and efforts like DAWN's WebUI", () => {
      expect(reasoningModeLabel("disabled")).toBe("Off");
      expect(reasoningModeLabel("adaptive")).toBe("Adaptive");
      expect(reasoningModeLabel("enabled")).toBe("On");
      expect(reasoningModeLabel("enabled", true)).toBe("Budget");
      expect(effortLabel("xhigh")).toBe("Extra high");
      expect(effortLabel("max")).toBe("Max");
   });

   it("explains a pick the model doesn't offer, and stays quiet when it matches", () => {
      const caps = parseReasoningCaps({ modes: [{ mode: "adaptive", efforts: ["low", "medium"] }] });
      expect(reasoningNote({ mode: "disabled", effort: "low" }, { mode: "adaptive", effort: "low" }, caps)).toBe(
         "Off isn't available on this model; running Adaptive."
      );
      expect(reasoningNote({ mode: "adaptive", effort: "xhigh" }, { mode: "adaptive", effort: "medium" }, caps)).toBe(
         "Extra high isn't available on this model; running Medium."
      );
      expect(reasoningNote({ mode: "adaptive", effort: "low" }, { mode: "adaptive", effort: "low" }, caps)).toBe("");
      expect(reasoningNote({ mode: null, effort: "" }, { mode: "adaptive", effort: "low" }, caps)).toBe("");
      /* A legacy "enabled" pick on an adaptive model is just "on" to DAWN: no note. */
      expect(reasoningNote({ mode: "enabled", effort: "low" }, { mode: "adaptive", effort: "low" }, caps)).toBe("");
      /* Off keeps its effort pick; no effort note while disabled. */
      expect(reasoningNote({ mode: "disabled", effort: "high" }, { mode: "disabled", effort: "low" }, caps)).toBe("");
   });

   it("resolves the nearest offered effort, ties lower", () => {
      expect(nearestEffort(["low", "medium", "high", "max"], "xhigh")).toBe("high");
      expect(nearestEffort(["low", "high"], "medium")).toBe("low");
      expect(nearestEffort(["low", "medium"], "medium")).toBe("medium");
      expect(nearestEffort(["low"], "bogus")).toBe("low");
      expect(nearestEffort([], "low")).toBe("");
   });

   it("formats budget sizes", () => {
      expect(formatBudgetTokens(512)).toBe("512");
      expect(formatBudgetTokens(1024)).toBe("1K");
      expect(formatBudgetTokens(1536)).toBe("1.5K");
      expect(formatBudgetTokens(8192)).toBe("8K");
   });
});
