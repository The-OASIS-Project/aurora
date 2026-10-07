// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cleanTrusted, normalizeAddress, TRUSTED_MAX_BYTES, TRUSTED_SENDERS } from "./mail-prefs.ts";

describe("trusted-sender keys", () => {
   it("normalizes an address without widening it to other mailboxes", () => {
      expect(normalizeAddress("News@Example.COM")).toBe("news@example.com");
      expect(normalizeAddress("a.b+tag@example.com")).toBe("a.b+tag@example.com"); // +tags and dots kept
      expect(normalizeAddress("x@bücher.example")).toBe("x@xn--bcher-kva.example"); // IDN as punycode
      for (const bad of [
         "", "no-at", "a@b@c.com", "@example.com", "a@", "A <a@example.com>", "a@localhost",
         /* Raw forms the URL parser would quietly turn into a@bank.com: never the same key. */
         "a@bank.com/evil", "a@bank.com?x", "a@bank.com#z", "a@b%61nk.com", "a@\uff42\uff41\uff4e\uff4b.com",
         "a@bank\u3002com", "a@ba\u00adnk.com", "a@ba\u200bnk.com", "a@0x7f.1", "a@127.0.0.1", "a@bank.com.",
         "\u202egro@bank.com", "a\u00ad@bank.com"
      ]) {
         expect(normalizeAddress(bad), bad).toBeNull();
      }
   });

   it("de-duplicates and caps the list by bytes, and rejects a non-list", () => {
      expect(cleanTrusted(["A@x.com", "a@x.com", 5, "bad", "b@y.org"])).toEqual(["a@x.com", "b@y.org"]);
      const many = Array.from({ length: 2000 }, (_, i) => `sender${i}@newsletters.example.com`);
      const kept = cleanTrusted(many);
      expect(kept.length).toBeLessThan(many.length);
      expect(new TextEncoder().encode(JSON.stringify(kept)).length).toBeLessThanOrEqual(TRUSTED_MAX_BYTES);
      expect(TRUSTED_SENDERS.parse("a@x.com")).toBeUndefined();
   });
});
