import { beforeEach, describe, expect, it } from "vitest";
import { clearUserState, isDifferentUser, rememberUser, stashEndReason, takeEndReason } from "./user-state.ts";

/* Node has no Web Storage: a minimal in-memory stand-in for localStorage + sessionStorage. */
class MemStorage {
   private m = new Map<string, string>();
   get length(): number {
      return this.m.size;
   }
   key(i: number): string | null {
      return [...this.m.keys()][i] ?? null;
   }
   getItem(k: string): string | null {
      return this.m.has(k) ? (this.m.get(k) as string) : null;
   }
   setItem(k: string, v: string): void {
      this.m.set(k, String(v));
   }
   removeItem(k: string): void {
      this.m.delete(k);
   }
}

beforeEach(() => {
   Object.assign(globalThis, { localStorage: new MemStorage(), sessionStorage: new MemStorage() });
});

describe("user state", () => {
   it("clears every per-user key but keeps layout prefs", () => {
      for (const k of ["dawn.hero.sessionToken", "dawn.hero.convId", "dawn.hero.hud", "dawn.hero.sessionKeepalive"]) {
         localStorage.setItem(k, "x");
      }
      localStorage.setItem("dawn.hero.contextPos", "keep");
      localStorage.setItem("aurora.notice.attention:Front door open.pos", "1,2");
      rememberUser("admin");
      clearUserState();
      expect(localStorage.getItem("dawn.hero.sessionToken")).toBeNull();
      expect(localStorage.getItem("dawn.hero.convId")).toBeNull();
      expect(localStorage.getItem("dawn.hero.hud")).toBeNull();
      expect(localStorage.getItem("dawn.hero.sessionKeepalive")).toBeNull();
      expect(localStorage.getItem("dawn.hero.contextPos")).toBe("keep");
      expect(localStorage.getItem("aurora.notice.attention:Front door open.pos")).toBeNull();
      expect(isDifferentUser("admin")).toBe(false); // the last-user marker survives a plain clear
      clearUserState({ forgetUser: true });
      expect(isDifferentUser("admin")).toBe(true);
   });

   it("detects a different user exactly (case-sensitive), and treats no record as different", () => {
      expect(isDifferentUser("vision")).toBe(true);
      rememberUser(" admin ");
      expect(isDifferentUser("admin")).toBe(false);
      expect(isDifferentUser("Admin")).toBe(true);
      expect(isDifferentUser("vision")).toBe(true);
   });

   it("carries a session-end reason once", () => {
      stashEndReason("Session revoked");
      expect(takeEndReason()).toBe("Session revoked");
      expect(takeEndReason()).toBeUndefined();
      stashEndReason(undefined);
      expect(takeEndReason()).toBeUndefined();
   });
});
