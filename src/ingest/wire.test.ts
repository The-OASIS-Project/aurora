import { describe, expect, it } from "vitest";
import { str } from "./wire.ts";

describe("str", () => {
   it("keeps text, renders numbers and booleans, and falls back for the rest", () => {
      expect(str("Song")).toBe("Song");
      expect(str("")).toBe(""); // an empty string is a value, not a missing one
      expect(str(42)).toBe("42");
      expect(str(false)).toBe("false");
      expect(str(undefined)).toBe("");
      expect(str(null, "idle")).toBe("idle");
      expect(str({ title: "x" }, "?")).toBe("?"); // never "[object Object]"
      expect(str(["a"])).toBe("");
   });
});
