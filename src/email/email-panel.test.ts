// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { assignMonograms, MAIL_STORAGE_KEYS, mountEmailPanel } from "./email-panel.ts";
import { EmailSim } from "../ingest/email-sim.ts";

beforeAll(() => {
   /* jsdom lacks these layout observers; the panel only needs them to exist. */
   class NoopObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
   }
   Object.assign(globalThis, { IntersectionObserver: NoopObserver, ResizeObserver: NoopObserver });
   if (!window.matchMedia) {
      Object.assign(window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
   }
});

afterEach(() => {
   vi.restoreAllMocks();
   localStorage.clear();
   document.body.replaceChildren();
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("assignMonograms", () => {
   it("never gives two accounts the same tile", () => {
      const m = assignMonograms([
         { id: 1, label: "Work" },
         { id: 2, label: "Workshop" },
         { id: 3, label: "gmail.com" },
         { id: 4, label: "gmail.com" },
         { id: 5, label: "Personal" }
      ]);
      expect(new Set(m.values()).size).toBe(5);
      expect(m.get(5)).toBe("P");
   });
});

async function mounted() {
   const sim = new EmailSim({ latency: [0, 0], changeEverySec: 0, flakyRate: 0 });
   const panel = mountEmailPanel(document.body, { source: sim, onDiscuss: () => {}, notify: () => {}, removeNotice: () => {} });
   panel.setVisible(true);
   await flush();
   return panel;
}

describe("Mail panel behaviour", () => {
   it("allows unchecking every account, then Show all brings them back", async () => {
      const panel = await mounted();
      (document.querySelector(".mail-filter-btn") as HTMLButtonElement).click();
      /* The popover re-renders after each change: re-query the live checkbox every time. */
      for (let guard = 0; guard < 10; guard++) {
         const checked = document.querySelector<HTMLInputElement>(".mail-pop-check input:checked");
         if (!checked) break;
         checked.click();
         await flush();
      }
      await flush();
      expect(document.querySelector(".mail-status")?.textContent).toContain("No accounts selected");
      expect(document.querySelectorAll(".mail-row").length).toBe(0);
      expect(document.querySelector<HTMLInputElement>(".mail-pop-row input")?.checked).toBe(false);
      (document.querySelector(".mail-status .mail-link") as HTMLButtonElement).click();
      await flush();
      expect(document.querySelectorAll(".mail-row").length).toBeGreaterThan(0);
      panel.destroy();
   });

   it("steps through messages with Next / Previous and J / K", async () => {
      const panel = await mounted();
      const rows = Array.from(document.querySelectorAll<HTMLElement>(".mail-row"));
      rows[0].click();
      await flush();
      const subject = (): string | undefined => document.querySelector(".mail-reader-subject")?.textContent ?? undefined;
      const first = subject();
      expect(document.querySelector<HTMLButtonElement>(".mail-prev")?.disabled).toBe(true);
      (document.querySelector(".mail-next") as HTMLButtonElement).click();
      await flush();
      const second = subject();
      expect(second).not.toBe(first);
      document.querySelector(".mail-reader-subject")!.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
      await flush();
      expect(subject()).toBe(first);
      document.querySelector(".mail-reader-subject")!.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
      await flush();
      expect(subject()).toBe(second);
      panel.destroy();
   });
});

describe("Mail panel storage", () => {
   it("writes no localStorage key outside its allowlist, and never mail content", async () => {
      const writes: Array<[string, string]> = [];
      const real = Storage.prototype.setItem;
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
         writes.push([k, v]);
         real.call(this, k, v);
      });
      const sim = new EmailSim({ latency: [0, 0], changeEverySec: 0, flakyRate: 0 });
      const notices: string[] = [];
      const panel = mountEmailPanel(document.body, {
         source: sim,
         onDiscuss: () => {},
         notify: (n) => notices.push(n.id),
         removeNotice: () => {}
      });
      panel.setVisible(true);
      await flush();
      /* Exercise the prefs + layout writers: filter, unread-only, collapse/expand, open a message. */
      (document.querySelector(".mail-unread-pill") as HTMLButtonElement).click();
      (document.querySelector(".mail-filter-btn") as HTMLButtonElement).click();
      (document.querySelector(".mail-pop-bell") as HTMLButtonElement).click();
      (document.querySelector(".mail-toggle") as HTMLButtonElement).click();
      (document.querySelector(".mail-toggle") as HTMLButtonElement).click();
      await flush();
      const firstRow = document.querySelector<HTMLElement>(".mail-row");
      firstRow?.click();
      await flush();
      panel.destroy();

      const allowed = new Set<string>(MAIL_STORAGE_KEYS);
      expect(writes.length).toBeGreaterThan(0);
      for (const [k, v] of writes) {
         expect(allowed.has(k), `unexpected key ${k}`).toBe(true);
         expect(v).not.toMatch(/@|subject|receipt/i); // prefs hold ids and flags, never addresses or text
      }
      for (const id of notices) expect(id).toMatch(/^mail-new:\d+$/);
   });
});
