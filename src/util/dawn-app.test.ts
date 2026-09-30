import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAppLogins, tagDawnUrl, tagIfDawnApi } from "./dawn-app.ts";

beforeEach(() => {
   Object.assign(globalThis, { window: { location: { origin: "https://dawn.local:3000" } } });
});
afterEach(() => setAppLogins(false));

describe("per-app login tagging", () => {
   it("leaves URLs alone when per-app logins are off", () => {
      expect(tagDawnUrl("/ws")).toBe("/ws");
      expect(tagIfDawnApi("/api/images/x")).toBe("/api/images/x");
   });

   it("tags DAWN paths, merging with an existing query and keeping a fragment", () => {
      setAppLogins(true);
      expect(tagDawnUrl("/ws")).toBe("/ws?app=aurora");
      expect(tagDawnUrl("/api/x?limit=5")).toBe("/api/x?limit=5&app=aurora");
      expect(tagDawnUrl("/api/x#top")).toBe("/api/x?app=aurora#top");
   });

   it("tags only same-origin /api links found in rendered content", () => {
      setAppLogins(true);
      expect(tagIfDawnApi("/api/images/img_1")).toBe("/api/images/img_1?app=aurora");
      expect(tagIfDawnApi("https://dawn.local:3000/api/documents/original/b?x=1")).toBe(
         "/api/documents/original/b?x=1&app=aurora"
      );
      expect(tagIfDawnApi("https://example.com/api/images/x")).toBe("https://example.com/api/images/x");
      expect(tagIfDawnApi("/aurora/logo.png")).toBe("/aurora/logo.png");
      expect(tagIfDawnApi("/api/images/x?app=aurora")).toBe("/api/images/x?app=aurora");
   });
});
