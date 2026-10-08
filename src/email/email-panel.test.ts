// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { assignMonograms, MAIL_STORAGE_KEYS, mountEmailPanel } from "./email-panel.ts";
import { EmailSim } from "../ingest/email-sim.ts";
import { LocalUserPrefs } from "../ingest/prefs.ts";
import { AFTER_MOVE, ALWAYS_IMAGES, MARK_READ, TRUSTED_SENDERS } from "./mail-prefs.ts";

beforeAll(() => {
   /* jsdom lacks these layout observers; the panel only needs them to exist. */
   class NoopObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
   }
   Object.assign(globalThis, { IntersectionObserver: NoopObserver, ResizeObserver: NoopObserver });
   Element.prototype.scrollIntoView ??= function () {};
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
   const panel = mountEmailPanel(document.body, { source: sim, prefs: new LocalUserPrefs(), onDiscuss: () => {}, notify: () => {}, removeNotice: () => {} });
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
         prefs: new LocalUserPrefs(),
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

describe("Mail options (3.9)", () => {
   const mountWith = async (prefs: LocalUserPrefs) => {
      const sim = new EmailSim({ latency: [0, 0], changeEverySec: 0, flakyRate: 0 });
      const panel = mountEmailPanel(document.body, { source: sim, prefs, onDiscuss: () => {}, notify: () => {}, removeNotice: () => {} });
      panel.setVisible(true);
      await flush();
      return panel;
   };
   const rowBySubject = (text: string): HTMLElement =>
      Array.from(document.querySelectorAll<HTMLElement>(".mail-row")).find((r) => r.textContent?.includes(text))!;
   const bar = (): string => document.querySelector(".mail-images-bar")?.textContent ?? "";
   const link = (label: string): HTMLButtonElement =>
      Array.from(document.querySelectorAll<HTMLButtonElement>(".mail-images-bar .mail-link")).find((b) => b.textContent?.startsWith(label))!;

   it("trusts a sender from the images bar, shows their images, and Stop takes it back", async () => {
      const prefs = new LocalUserPrefs();
      const panel = await mountWith(prefs);
      rowBySubject("calm UIs").click();
      await flush();
      expect(bar()).toContain("Always show from digest@news.example.net");
      expect(document.querySelector(".mail-reader-body img[src]")).toBeNull();
      link("Always show from").click();
      await flush();
      expect(bar()).toContain("Images from digest@news.example.net load automatically");
      expect(document.querySelector(".mail-reader-body img[src]")).not.toBeNull();
      expect(prefs.get(TRUSTED_SENDERS)).toEqual(["digest@news.example.net"]);
      link("Stop").click();
      await flush();
      expect(bar()).toContain("blocked");
      expect(document.querySelector(".mail-reader-body img[src]")).toBeNull();
      expect(prefs.get(TRUSTED_SENDERS)).toEqual([]);
      panel.destroy();
      prefs.dispose();
   });

   it("marks read after 3 s on screen, or only when chosen", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
      try {
         const prefs = new LocalUserPrefs();
         prefs.set(MARK_READ, "delayed");
         const sim = new EmailSim({ latency: [0, 0], changeEverySec: 0, flakyRate: 0 });
         const panel = mountEmailPanel(document.body, { source: sim, prefs, onDiscuss: () => {}, notify: () => {}, removeNotice: () => {} });
         panel.setVisible(true);
         await vi.advanceTimersByTimeAsync(10);
         const first = (): HTMLElement => document.querySelector<HTMLElement>(".mail-row.unread")!;
         const key = first().dataset.key!;
         first().click();
         await vi.advanceTimersByTimeAsync(10);
         const row = (): HTMLElement => document.querySelector<HTMLElement>(`.mail-row[data-key="${key}"]`)!;
         expect(row().classList.contains("unread")).toBe(true);
         expect(document.querySelector(".mail-r-mark")?.getAttribute("aria-label")).toBe("Mark read");
         await vi.advanceTimersByTimeAsync(3100);
         expect(row().classList.contains("unread")).toBe(false);

         prefs.set(MARK_READ, "manual");
         const next = document.querySelector<HTMLElement>(".mail-row.unread")!;
         const nextKey = next.dataset.key!;
         next.click();
         await vi.advanceTimersByTimeAsync(5000);
         const nextRow = (): HTMLElement => document.querySelector<HTMLElement>(`.mail-row[data-key="${nextKey}"]`)!;
         expect(nextRow().classList.contains("unread")).toBe(true);
         (document.querySelector(".mail-r-mark") as HTMLButtonElement).click(); // the reader's toggle
         await vi.advanceTimersByTimeAsync(10);
         expect(nextRow().classList.contains("unread")).toBe(false);
         panel.destroy();
         prefs.dispose();
      } finally {
         vi.useRealTimers();
      }
   });

   it("opens the next message after archiving when chosen", async () => {
      const prefs = new LocalUserPrefs();
      prefs.set(AFTER_MOVE, "next");
      const panel = await mountWith(prefs);
      const rows = Array.from(document.querySelectorAll<HTMLElement>(".mail-row"));
      const secondSubject = rows[1].querySelector(".mail-row-subject")?.textContent;
      rows[0].click();
      await flush();
      (document.querySelector(".mail-r-archive") as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 250)); // the stepped open settles before it reads
      expect(document.querySelector(".mail-reader-subject")?.textContent).toBe(secondSubject);
      panel.destroy();
      prefs.dispose();
   });

   it("has two levels; Escape steps back before it closes", async () => {
      const prefs = new LocalUserPrefs();
      const panel = await mountWith(prefs);
      (document.querySelector(".mail-filter-btn") as HTMLButtonElement).click();
      (document.querySelector(".mail-pop-more") as HTMLButtonElement).click();
      expect(document.querySelector(".mail-popover")?.textContent).toContain("Mark as read");
      const delayed = document.querySelector<HTMLInputElement>('input[name="mail-markread"][value="delayed"]')!;
      delayed.click();
      expect(prefs.get(MARK_READ)).toBe("delayed");
      /* Always show images asks before it turns on. */
      document.querySelector<HTMLInputElement>('[data-focus-id="always"]')!.click();
      expect(prefs.get(ALWAYS_IMAGES)).toBe(false);
      (document.querySelector(".mail-pop-turn-on") as HTMLButtonElement).click();
      expect(prefs.get(ALWAYS_IMAGES)).toBe(true);
      const pop = document.querySelector(".mail-popover") as HTMLElement;
      pop.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(pop.hidden).toBe(false);
      expect(pop.textContent).toContain("Show mail from");
      pop.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(pop.hidden).toBe(true);
      panel.destroy();
      prefs.dispose();
   });

   it("groups archives of one account into one Undo that takes them all back", async () => {
      const prefs = new LocalUserPrefs();
      const panel = await mountWith(prefs);
      const before = document.querySelectorAll(".mail-row").length;
      const archiveFirstOf = (acct: string): void => {
         const row = Array.from(document.querySelectorAll<HTMLElement>(".mail-row")).find((r) => r.dataset.key?.startsWith(`${acct}/`))!;
         row.querySelector<HTMLButtonElement>('[data-act="archive"]')!.click();
      };
      archiveFirstOf("1");
      await flush();
      await new Promise((r) => setTimeout(r, 450)); // past the reflow lock that guards a row sliding under the pointer
      archiveFirstOf("1");
      await flush();
      expect(document.querySelector(".mail-toast-text")?.textContent).toBe("Archived 2");
      expect(document.querySelectorAll(".mail-row").length).toBe(before - 2);
      (document.querySelector(".mail-toast-undo") as HTMLButtonElement).click();
      await flush();
      await flush();
      expect(document.querySelectorAll(".mail-row").length).toBe(before);
      panel.destroy();
      prefs.dispose();
   });

   it("keeps both Undos when the second click comes before the first move has answered", async () => {
      const prefs = new LocalUserPrefs();
      const sim = new EmailSim({ latency: [0, 0], changeEverySec: 0, flakyRate: 0 });
      const panel = mountEmailPanel(document.body, { source: sim, prefs, onDiscuss: () => {}, notify: () => {}, removeNotice: () => {} });
      panel.setVisible(true);
      await flush();
      const before = document.querySelectorAll(".mail-row").length;
      /* A slow DAWN from here on: each move takes 600 ms to answer. */
      const archive = sim.archive.bind(sim);
      sim.archive = (a, ids) => new Promise((r) => setTimeout(() => r(archive(a, ids)), 600));
      const archiveFirstOf = (acct: string): void => {
         const row = Array.from(document.querySelectorAll<HTMLElement>(".mail-row")).find((r) => r.dataset.key?.startsWith(`${acct}/`))!;
         row.querySelector<HTMLButtonElement>('[data-act="archive"]')!.click();
      };
      archiveFirstOf("1");
      await new Promise((r) => setTimeout(r, 450)); // the first is still on its way
      archiveFirstOf("1");
      await new Promise((r) => setTimeout(r, 1500));
      expect(document.querySelector(".mail-toast-text")?.textContent).toBe("Archived 2");
      (document.querySelector(".mail-toast-undo") as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 50));
      expect(document.querySelectorAll(".mail-row").length).toBe(before);
      panel.destroy();
      prefs.dispose();
   });

   it("puts archives and trashes from any account in one group with one Undo", async () => {
      const prefs = new LocalUserPrefs();
      const panel = await mountWith(prefs);
      const before = document.querySelectorAll(".mail-row").length;
      const act = (acct: string, what: "archive" | "trash"): void => {
         const row = Array.from(document.querySelectorAll<HTMLElement>(".mail-row")).find((r) => r.dataset.key?.startsWith(`${acct}/`))!;
         row.querySelector<HTMLButtonElement>(`[data-act="${what}"]`)!.click();
      };
      const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 450)); // past the reflow lock
      act("1", "archive");
      await settle();
      act("2", "trash"); // another account (IMAP: its undo brings it back under a new id)
      await settle();
      act("1", "archive");
      await flush();
      expect(document.querySelector(".mail-toast-text")?.textContent).toBe("2 archived, 1 moved to Trash");
      expect(document.querySelectorAll(".mail-row").length).toBe(before - 3);
      (document.querySelector(".mail-toast-undo") as HTMLButtonElement).click();
      await flush();
      await flush();
      expect(document.querySelectorAll(".mail-row").length).toBe(before);
      panel.destroy();
      prefs.dispose();
   });

   it("shows Discuss only when DAWN can take an email in a chat turn", async () => {
      for (const can of [false, true]) {
         const prefs = new LocalUserPrefs();
         const sim = new EmailSim({ latency: [0, 0], changeEverySec: 0, flakyRate: 0 });
         const panel = mountEmailPanel(document.body, { source: sim, prefs, canDiscuss: () => can, onDiscuss: () => {}, notify: () => {}, removeNotice: () => {} });
         panel.setVisible(true);
         await flush();
         document.querySelector<HTMLElement>(".mail-row")!.click();
         await flush();
         expect(document.body.textContent?.includes("Discuss")).toBe(can);
         panel.destroy();
         prefs.dispose();
         document.body.replaceChildren();
      }
   });
});
