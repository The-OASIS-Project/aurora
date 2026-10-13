// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { arePanelsLocked, mountPanelLock, setPanelsLocked } from "./panel-lock.ts";

afterEach(() => {
   setPanelsLocked(false);
   localStorage.clear();
   document.body.replaceChildren();
});

const panel = (): HTMLElement => document.body.appendChild(document.createElement("div"));
const button = (el: HTMLElement): HTMLButtonElement => el.querySelector<HTMLButtonElement>(".movable-lock")!;

describe("panel position lock", () => {
   it("locks and unlocks from the padlock, and remembers it per panel", () => {
      const el = panel();
      const lock = mountPanelLock(el, "test.pos");
      expect(lock.locked()).toBe(false);
      button(el).click();
      expect(lock.locked()).toBe(true);
      expect(el.classList.contains("movable-locked")).toBe(true);
      expect(button(el).getAttribute("aria-pressed")).toBe("true");
      expect(button(el).getAttribute("aria-label")).toBe("Unlock position");
      lock.dispose();
      const again = mountPanelLock(panel(), "test.pos");
      expect(again.locked()).toBe(true); // persisted beside the position
      expect(mountPanelLock(panel(), "other.pos").locked()).toBe(false);
   });

   it("Lock all panels locks every panel and holds their padlocks", () => {
      const a = panel();
      const b = panel();
      const la = mountPanelLock(a, "a.pos");
      const lb = mountPanelLock(b, "b.pos");
      setPanelsLocked(true);
      expect(arePanelsLocked()).toBe(true);
      expect(la.locked() && lb.locked()).toBe(true);
      expect(button(a).disabled).toBe(true);
      button(a).click(); // can't unlock one while all are locked
      expect(la.locked()).toBe(true);
      setPanelsLocked(false);
      expect(la.locked() || lb.locked()).toBe(false);
      expect(b.classList.contains("movable-locked")).toBe(false);
   });

   it("follows a lock change made in another tab", () => {
      const el = panel();
      const lock = mountPanelLock(el, "e.pos");
      localStorage.setItem("e.pos.locked", "1");
      window.dispatchEvent(new StorageEvent("storage", { key: "e.pos.locked", newValue: "1" }));
      expect(lock.locked()).toBe(true);
      localStorage.setItem("dawn.hero.panelsLocked", "1");
      localStorage.removeItem("e.pos.locked");
      window.dispatchEvent(new StorageEvent("storage", { key: "dawn.hero.panelsLocked", newValue: "1" }));
      expect(arePanelsLocked()).toBe(true);
      expect(button(el).disabled).toBe(true);
   });

   it("dispose removes the padlock and the locked state", () => {
      const el = panel();
      const lock = mountPanelLock(el, "d.pos");
      button(el).click();
      lock.dispose();
      expect(el.querySelector(".movable-lock")).toBeNull();
      expect(el.classList.contains("movable-locked")).toBe(false);
   });
});
