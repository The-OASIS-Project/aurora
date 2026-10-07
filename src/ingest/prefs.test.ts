// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { definePref, LocalUserPrefs, PREFS_KEY } from "./prefs.ts";

const FLAG = definePref<boolean>({ key: "test.flag", default: false, parse: (r) => (typeof r === "boolean" ? r : undefined) });
const LIST = definePref<string[]>({
   key: "test.list",
   default: [],
   parse: (r) => (Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : undefined)
});

afterEach(() => localStorage.clear());

describe("LocalUserPrefs", () => {
   it("returns defaults, keeps set values, and falls back to the default for a bad stored value", () => {
      const p = new LocalUserPrefs();
      expect(p.get(FLAG)).toBe(false);
      p.set(FLAG, true);
      expect(p.get(FLAG)).toBe(true);
      expect(new LocalUserPrefs().get(FLAG)).toBe(true); // persisted
      localStorage.setItem(PREFS_KEY, JSON.stringify({ v: 1, values: { "test.flag": "yes" }, authority: "local", dirty: [] }));
      expect(new LocalUserPrefs().get(FLAG)).toBe(false);
      p.dispose();
   });

   it("never resolves a key to an Object.prototype member, and refuses bad key names", () => {
      const CTOR = definePref<string>({ key: "test.constructor", default: "d", parse: (r) => (typeof r === "string" ? r : undefined) });
      expect(new LocalUserPrefs().get(CTOR)).toBe("d");
      expect(() => definePref({ key: "NoDots", default: 1, parse: () => 1 })).toThrow();
      expect(() => definePref({ key: "x.Upper", default: 1, parse: () => 1 })).toThrow();
   });

   it("applies an update to the current value and tells listeners which keys changed", () => {
      const p = new LocalUserPrefs();
      const seen: string[][] = [];
      const off = p.onChange((keys) => seen.push(keys));
      p.update(LIST, (cur) => [...cur, "a"]);
      p.update(LIST, (cur) => [...cur, "b"]);
      p.set(LIST, ["a", "b"]); // unchanged: no notice
      expect(p.get(LIST)).toEqual(["a", "b"]);
      expect(seen).toEqual([["test.list"], ["test.list"]]);
      off();
      p.dispose();
   });

   it("follows another tab through the storage event", () => {
      const p = new LocalUserPrefs();
      const seen: string[][] = [];
      p.onChange((keys) => seen.push(keys));
      localStorage.setItem(PREFS_KEY, JSON.stringify({ v: 1, values: { "test.flag": true }, authority: "local", dirty: [] }));
      window.dispatchEvent(new StorageEvent("storage", { key: PREFS_KEY }));
      expect(p.get(FLAG)).toBe(true);
      expect(seen).toEqual([["test.flag"]]);
      p.dispose();
   });
});
