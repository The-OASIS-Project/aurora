// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mountMemoryPanel } from "./memory-panel.ts";
import { batchSummary } from "../util/memory-text.ts";
import type { MemoryBatch, MemoryBatchOp } from "../ingest/ingest.ts";
import { closeDialog } from "../menu/dialog.ts";

/* What the Memory panel's Learned list does with DAWN's batches (memory_batches): it reads only
   once it's on screen and DAWN offers it, draws the one action DAWN allows per change, writes only
   from a button (Undo all and Forget behind a named confirm), and keeps pushes that land while a
   page is on its way. */

beforeAll(() => {
   class NoopObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
   }
   Object.assign(globalThis, { ResizeObserver: NoopObserver });
   if (!window.matchMedia) {
      Object.assign(window, {
         matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
      });
   }
   (globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
});

afterEach(() => {
   closeDialog();
   localStorage.clear();
   document.body.replaceChildren();
   vi.restoreAllMocks();
});

/* A confirm's action runs once its dialog has closed (the next tick). */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const op = (opId: number, over: Partial<MemoryBatchOp> = {}): MemoryBatchOp => ({
   opId,
   op: "added",
   status: "applied",
   outside: false,
   outsideFrom: null,
   factId: opId + 1000,
   text: `fact ${opId}`,
   targetText: null,
   targetStatus: null,
   sources: [],
   reason: null,
   reasonBy: null,
   action: "undo",
   ...over
});

const batch = (
   batchId: number,
   ops: MemoryBatchOp[],
   over: Partial<MemoryBatch> = {}
): MemoryBatch => ({
   batchId,
   conversationId: 7,
   afterMessageId: 100,
   createdAt: Math.floor(Date.now() / 1000) - 120,
   status: "applied",
   outside: false,
   outsideFrom: null,
   counts: { added: ops.length },
   ops,
   ...over
});

function mounted(sent = true) {
   const calls: string[] = [];
   let asked = 0; // each page request's id
   const panel = mountMemoryPanel(document.body, {
      list: (before) => (calls.push(`list:${before ?? "first"}`), sent ? ++asked : 0),
      undo: (b, o) => (calls.push(`undo:${b}:${o ?? "all"}`), sent),
      keep: (b, o) => (calls.push(`keep:${b}:${o}`), sent),
      forget: (f) => (calls.push(`forget:${f}`), sent),
      open: (id) => void calls.push(`open:${id}`)
   });
   const el = document.getElementById("memory")!;
   const button = (text: string): HTMLButtonElement | undefined =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
         (b) => b.textContent === text
      );
   const open = (batchIndex = 0): void =>
      el.querySelectorAll<HTMLButtonElement>(".memory-batch-head")[batchIndex].click();
   return { panel, el, calls, button, open };
}

describe("the Learned list", () => {
   it("isn't offered until DAWN records batches, and reads only once it's on screen", () => {
      const { panel, el, calls } = mounted();
      expect(panel.isAvailable()).toBe(false);
      expect(panel.isVisible()).toBe(false); // opt-in
      panel.setVisible(true);
      expect(el.classList.contains("memory-unavailable")).toBe(true);
      expect(calls).toEqual([]);
      panel.setAvailable(true);
      panel.linkUp(); // the same connect's config frame
      expect(calls).toEqual(["list:first"]); // asked once
   });

   it("draws each batch as a quiet summary, and says when there's nothing yet", () => {
      const { panel, el } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      panel.setPage({ before: null, batches: [], nextBefore: null, error: null });
      expect(el.textContent).toContain("Nothing learned yet");
      panel.linkUp(); // a later connect reads a fresh first page
      panel.setPage({
         before: null,
         batches: [batch(5, [op(1), op(2)], { counts: { added: 2, merged: 1 } })],
         nextBefore: null,
         error: null
      });
      expect(el.querySelector(".memory-batch-summary")?.textContent).toBe("2 learned, 1 updated");
      expect(el.querySelector(".memory-op")).toBeNull(); // closed until opened
   });

   it("heads a batch with its conversation, which opens it; renames follow", () => {
      const { panel, el, calls } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      panel.setPage({
         before: null,
         batches: [
            batch(5, [op(1)], { conversationTitle: "Trip plans" }),
            batch(4, [op(2)], { conversationTitle: "" }),
            batch(3, [op(3)], { conversationTitle: null }),
            batch(2, [op(4)]) // an older DAWN: no title at all
         ],
         nextBefore: null,
         error: null
      });
      const titles = (): Array<string | undefined> =>
         [...el.querySelectorAll(".memory-batch")].map(
            (b) => b.querySelector(".memory-batch-conv")?.textContent ?? undefined
         );
      expect(titles()).toEqual(["Trip plans", "Untitled conversation", undefined, undefined]);
      el.querySelector<HTMLButtonElement>(".memory-batch-conv")!.click();
      expect(calls).toContain("open:7");
      expect(el.querySelector(".memory-op")).toBeNull(); // opening it doesn't toggle the batch
      panel.renameConversation(7, "Summer trip");
      expect(titles()).toEqual(["Summer trip", "Summer trip", undefined, undefined]);
   });

   it("a preference-only batch isn't 'Nothing new'", () => {
      expect(batchSummary(batch(1, [], { counts: { pref_set: 1 } }))).toBe("1 preference");
      expect(batchSummary(batch(1, [], { counts: {} }))).toBe("Nothing new");
   });

   it("shows memory text as text, never markup", () => {
      const { panel, el, open } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      panel.setPage({
         before: null,
         batches: [
            batch(5, [
               op(1, {
                  text: "<img src=x onerror=alert(1)>",
                  reason: "<b>x</b>",
                  reasonBy: "model"
               })
            ])
         ],
         nextBefore: null,
         error: null
      });
      open();
      expect(el.querySelector("img, b")).toBeNull();
      expect(el.querySelector(".memory-op-text")?.textContent).toBe("<img src=x onerror=alert(1)>");
      expect(el.querySelector(".memory-op-reason")?.textContent).toBe("Model's reason: <b>x</b>");
   });

   it("draws only the action DAWN allows, and Undo all only for more than one undo", () => {
      const { panel, el, open, button } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      panel.setPage({
         before: null,
         batches: [
            batch(5, [
               op(1),
               op(2, { op: "dropped", action: "keep" }),
               op(3, { op: "suggested_forget", action: "forget" }),
               op(4, { status: "undone", action: null })
            ])
         ],
         nextBefore: null,
         error: null
      });
      open();
      const actions = [...el.querySelectorAll(".memory-op .memory-action")].map(
         (b) => b.textContent
      );
      expect(actions).toEqual(["Undo", "Keep", "Forget"]);
      expect(button("Undo all")).toBeUndefined(); // one undo only
   });

   it("a single Undo goes at once and holds the other Undo and Keep buttons until it ends", () => {
      const { panel, el, open, calls } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      panel.setPage({
         before: null,
         batches: [batch(5, [op(1), op(2), op(3, { op: "dropped", action: "keep" })])],
         nextBefore: null,
         error: null
      });
      open();
      el.querySelector<HTMLButtonElement>(".memory-op .action-undo")!.click();
      expect(calls).toContain("undo:5:1");
      const buttons = [...el.querySelectorAll<HTMLButtonElement>(".memory-action")];
      expect(buttons.map((b) => [b.textContent, b.disabled])).toEqual([
         ["Undoing…", true],
         ["Undo", true],
         ["Keep", true],
         ["Undo all", true]
      ]);
      panel.actionDone({ kind: "undo", batchId: 5, opId: 1, ok: true });
      expect(el.querySelector<HTMLButtonElement>(".action-keep")!.disabled).toBe(false);
   });

   it("Undo all asks first, and only its confirm sends it", async () => {
      const { panel, open, button, calls } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      panel.setPage({
         before: null,
         batches: [batch(5, [op(1), op(2)])],
         nextBefore: null,
         error: null
      });
      open();
      button("Undo all")!.click();
      expect(document.querySelector(".dialog-title")?.textContent).toBe("Undo 2 changes?");
      button("Cancel")!.click();
      expect(calls.filter((c) => c.startsWith("undo"))).toEqual([]);
      button("Undo all")!.click();
      [...document.querySelectorAll<HTMLButtonElement>(".dialog-card button")]
         .find((b) => b.textContent === "Undo all")!
         .click();
      await tick();
      expect(calls).toContain("undo:5:all");
   });

   it("Forget asks first, then forgets the fact", async () => {
      const { panel, open, button, calls } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      panel.setPage({
         before: null,
         batches: [batch(5, [op(3, { op: "suggested_forget", action: "forget", factId: 77 })])],
         nextBefore: null,
         error: null
      });
      open();
      button("Forget")!.click();
      expect(document.querySelector(".dialog-title")?.textContent).toBe("Forget this memory?");
      expect(calls).toEqual(["list:first"]);
      [...document.querySelectorAll<HTMLButtonElement>(".dialog-card button")]
         .find((b) => b.textContent === "Forget")!
         .click();
      await tick();
      expect(calls).toContain("forget:77");
      expect(button("Forgetting…")?.disabled).toBe(true);
      panel.actionDone({ kind: "forget", factId: 77, ok: false });
      expect(button("Forget")?.disabled).toBe(false);
   });

   it("a confirm cancelled after a redraw gives the keyboard back to the redrawn button", () => {
      const { panel, el, open, button } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      const page = batch(5, [op(1), op(2)]);
      panel.setPage({ before: null, batches: [page], nextBefore: null, error: null });
      open();
      button("Undo all")!.focus();
      button("Undo all")!.click();
      panel.upsertBatch({ ...page }); // a push redraws the list under the dialog
      button("Cancel")!.click();
      expect(document.activeElement?.textContent).toBe("Undo all");
      expect(el.contains(document.activeElement)).toBe(true);
   });

   it("a mark clicked: the panel comes up with that batch open, older than its pages or not", () => {
      const { panel, el, calls } = mounted();
      panel.setAvailable(true); // hidden: nothing read yet
      panel.focusBatch(batch(3, [op(1)]));
      expect(panel.isVisible()).toBe(true);
      expect(calls).toEqual(["list:first"]);
      panel.setPage({
         before: null,
         batches: [batch(30, [op(2)])],
         nextBefore: 30,
         error: null,
         request: 1
      });
      const shown = [...el.querySelectorAll<HTMLElement>(".memory-batch")];
      expect(shown).toHaveLength(2); // 30, and 3 though it's behind Show older
      const asked = shown[1];
      expect(asked.classList.contains("open")).toBe(true);
      expect(asked.classList.contains("memory-batch-lit")).toBe(true);
      expect(document.activeElement?.closest(".memory-batch")).toBe(asked);
   });

   it("an asked-for batch older than the pages keeps its updates through an older page", () => {
      const { panel, el, button } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      panel.setPage({
         before: null,
         batches: [batch(30, [op(1)])],
         nextBefore: 30,
         error: null,
         request: 1
      });
      panel.focusBatch(batch(3, [op(2)])); // shown, though behind Show older
      button("Show older")!.click(); // request 2
      panel.upsertBatch(
         batch(3, [op(2, { status: "undone", action: null })], { status: "undone" })
      );
      panel.setPage({
         before: 30,
         batches: [batch(25, [op(3)])],
         nextBefore: 20,
         error: null,
         request: 2
      });
      const three = [...el.querySelectorAll<HTMLElement>(".memory-batch")].at(-1)!;
      expect(three.dataset.status).toBe("undone");
   });

   it("an asked-for batch follows an update, or its removal, while the list is on its way", () => {
      const { panel, el } = mounted();
      panel.setAvailable(true);
      panel.focusBatch(batch(3, [op(2)])); // the panel opens, its first page on its way
      panel.removeBatch(3); // forgotten meanwhile
      panel.setPage({
         before: null,
         batches: [batch(30, [op(1)])],
         nextBefore: 30,
         error: null,
         request: 1
      });
      expect(el.querySelectorAll(".memory-batch")).toHaveLength(1); // not brought back
   });

   it("keeps a push that lands while the page is on its way", () => {
      const { panel, el } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true); // the first page is asked for
      panel.upsertBatch(batch(9, [op(1)], { counts: { added: 1 } }));
      panel.removeBatch(4);
      panel.setPage({
         before: null,
         batches: [batch(4, [op(2)]), batch(3, [op(3)])],
         nextBefore: null,
         error: null
      });
      const ids = [...el.querySelectorAll(".memory-batch-summary")].length;
      expect(ids).toBe(2); // 9 and 3: the push, and the page without the removed one
   });

   it("pages older batches, and leaves a push older than the cursor to its page", () => {
      const { panel, el, button, calls } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      panel.setPage({ before: null, batches: [batch(30, [op(1)])], nextBefore: 30, error: null });
      panel.upsertBatch(batch(12, [op(2)]));
      expect(el.querySelectorAll(".memory-batch")).toHaveLength(1);
      button("Show older")!.click();
      expect(calls).toContain("list:30");
      panel.setPage({ before: 30, batches: [batch(12, [op(2)])], nextBefore: null, error: null });
      expect(el.querySelectorAll(".memory-batch")).toHaveLength(2);
      expect(button("Show older")).toBeUndefined();
   });

   it("a link loss ends what was running; the buttons wait for a fresh first page", () => {
      const { panel, el, open, calls } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      const page = { before: null, batches: [batch(5, [op(1)])], nextBefore: null, error: null };
      panel.setPage(page);
      open();
      el.querySelector<HTMLButtonElement>(".action-undo")!.click();
      panel.linkDown();
      const undo = (): HTMLButtonElement => el.querySelector<HTMLButtonElement>(".action-undo")!;
      expect([undo().textContent, undo().disabled]).toEqual(["Undo", true]);
      panel.linkUp();
      expect(calls.filter((c) => c === "list:first")).toHaveLength(2);
      panel.setPage(page);
      open();
      expect(undo().disabled).toBe(false);
   });

   it("a link loss before the first page says not connected", () => {
      const { panel, el } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      panel.linkDown();
      expect(el.textContent).toContain("Not connected");
   });

   it("an older page's failure keeps a push for what's shown, and drops what was for it", () => {
      const { panel, el, button, open } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      panel.setPage({ before: null, batches: [batch(30, [op(1)])], nextBefore: 30, error: null });
      button("Show older")!.click();
      /* An undo's push for the shown batch lands while the older page is on its way. */
      panel.upsertBatch(
         batch(30, [op(1, { status: "undone", action: null })], { status: "undone" })
      );
      panel.upsertBatch(batch(12, [op(2)]));
      panel.setPage({ before: 30, batches: [], nextBefore: 30, error: "Couldn't load" });
      expect(el.querySelectorAll(".memory-batch")).toHaveLength(1);
      open();
      expect(el.querySelector(".memory-op .memory-tag")?.textContent).toBe("Undone");
   });

   it("a conversation title waits for the link before it opens anything", () => {
      const { panel, el, calls } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      panel.setPage({
         before: null,
         batches: [batch(5, [op(1)], { conversationTitle: "Trip plans" })],
         nextBefore: null,
         error: null
      });
      panel.linkDown();
      const title = el.querySelector<HTMLButtonElement>(".memory-batch-conv")!;
      expect(title.disabled).toBe(true);
      title.click();
      expect(calls.filter((c) => c.startsWith("open"))).toEqual([]);
   });

   it("a batch pushed while an older page loads doesn't strand the page's boundary", () => {
      const { panel, el, button, calls } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      const range = (from: number, n: number) =>
         Array.from({ length: n }, (_, i) => batch(from - i, [op(from - i)]));
      panel.setPage({ before: null, batches: range(100, 20), nextBefore: 81, error: null });
      button("Show older")!.click(); // asks for what's older than 81
      panel.upsertBatch(batch(101, [op(500)])); // shown at once, but nothing evicted yet
      panel.setPage({ before: 81, batches: range(80, 20), nextBefore: 61, error: null });
      const ids = [...el.querySelectorAll(".memory-batch")].length;
      expect(ids).toBe(40); // 101..62: the oldest (61) went back behind Show older
      button("Show older")!.click();
      expect(calls.at(-1)).toBe("list:62"); // and the next page starts right at it
   });

   it("a reply to a page asked before the panel was hidden doesn't settle the new one", () => {
      const { panel, el, button } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      panel.setPage({ before: null, batches: [batch(30, [op(1)])], nextBefore: 30, error: null });
      button("Show older")!.click();
      panel.setVisible(false);
      panel.setVisible(true); // a fresh first page is asked for
      panel.setPage({ before: 30, batches: [batch(29, [op(2)])], nextBefore: null, error: null });
      expect(el.textContent).toContain("Loading…"); // the stale older page changed nothing
      panel.setPage({ before: null, batches: [batch(31, [op(3)])], nextBefore: null, error: null });
      expect(el.querySelectorAll(".memory-batch")).toHaveLength(1);
   });

   it("a refusal of the newer first page isn't mistaken for the older one's reply", () => {
      const { panel, el } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true); // request 1
      panel.setVisible(false);
      panel.setVisible(true); // request 2, the one wanted
      /* DAWN refuses request 2 at once (errors aren't queued); request 1's page follows. */
      panel.setPage({ before: null, batches: [], nextBefore: null, error: "Busy", request: 2 });
      panel.setPage({
         before: null,
         batches: [batch(5, [op(1)])],
         nextBefore: null,
         error: null,
         request: 1
      });
      expect(el.textContent).toContain("Busy");
      expect(el.querySelectorAll(".memory-batch")).toHaveLength(0);
   });

   it("a rename that overtakes the page on its way still wins over the page's older title", () => {
      const { panel, el } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true); // the first page is on its way
      panel.renameConversation(7, "Summer trip"); // the notice overtakes the queued page
      panel.setPage({
         before: null,
         batches: [batch(5, [op(1)], { conversationTitle: "Trip plans" })],
         nextBefore: null,
         error: null,
         request: 1
      });
      expect(el.querySelector(".memory-batch-conv")?.textContent).toBe("Summer trip");
   });

   it("a batch pushed after a rename, but built before it, keeps the new title", () => {
      const { panel, el } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      const before = batch(5, [op(1)], { conversationTitle: "Trip plans" });
      panel.setPage({ before: null, batches: [before], nextBefore: null, error: null, request: 1 });
      panel.renameConversation(7, "Summer trip");
      panel.upsertBatch({ ...before, status: "partial" }); // an undo's push, built earlier
      expect(el.querySelector(".memory-batch-conv")?.textContent).toBe("Summer trip");
   });

   it("a push held for an older page is kept only within what that page brought", () => {
      const { panel, el, button } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      panel.setPage({ before: null, batches: [batch(40, [op(1)])], nextBefore: 30, error: null });
      button("Show older")!.click();
      panel.upsertBatch(batch(10, [op(2)])); // older than the page will reach
      panel.setPage({ before: 30, batches: [batch(29, [op(3)])], nextBefore: 21, error: null });
      expect(el.querySelectorAll(".memory-batch")).toHaveLength(2); // 40 and 29, not 10
   });

   it("a rename reaches a push held for a page, so the old title can't come back", () => {
      const { panel, el } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true); // the first page is on its way
      panel.upsertBatch(batch(5, [op(1)], { conversationTitle: "Trip plans" }));
      panel.renameConversation(7, "Summer trip");
      panel.setPage({
         before: null,
         batches: [batch(5, [op(1)], { conversationTitle: "Trip plans" })],
         nextBefore: null,
         error: null
      });
      expect(el.querySelector(".memory-batch-conv")?.textContent).toBe("Summer trip");
   });

   it("hiding lets go of the list; showing reads it fresh", () => {
      const { panel, el, calls } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      panel.setPage({ before: null, batches: [batch(5, [op(1)])], nextBefore: null, error: null });
      panel.setVisible(false);
      panel.upsertBatch(batch(6, [op(2)])); // nothing kept while hidden
      expect(el.querySelectorAll(".memory-batch")).toHaveLength(0);
      panel.setVisible(true);
      expect(calls.filter((c) => c === "list:first")).toHaveLength(2);
   });

   it("keeps at most what the pages brought: the oldest goes back behind Show older", () => {
      const { panel, el, button } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      const page = Array.from({ length: 20 }, (_, i) => batch(100 - i, [op(i + 1)]));
      panel.setPage({ before: null, batches: page, nextBefore: null, error: null });
      panel.upsertBatch(batch(101, [op(50)]));
      expect(el.querySelectorAll(".memory-batch")).toHaveLength(20);
      expect(button("Show older")).toBeDefined(); // batch 81 waits behind it again
   });

   it("a late Undo reply from before a reconnect doesn't end a newer Keep", () => {
      const { panel, el, open } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      const page = batch(5, [op(1), op(2, { op: "dropped", action: "keep" })]);
      panel.setPage({ before: null, batches: [page], nextBefore: null, error: null, request: 1 });
      open();
      el.querySelector<HTMLButtonElement>(".action-undo")!.click();
      panel.linkDown();
      panel.linkUp();
      panel.setPage({ before: null, batches: [page], nextBefore: null, error: null, request: 2 });
      open();
      el.querySelector<HTMLButtonElement>(".action-keep")!.click();
      /* DAWN's worker answers the old Undo on the new connection. */
      panel.actionDone({ kind: "undo", batchId: 5, opId: 1, ok: true });
      const keep = el.querySelector<HTMLButtonElement>(".action-keep")!;
      expect([keep.textContent, keep.disabled]).toEqual(["Keeping…", true]);
   });

   it("points out the row a Keep stored", () => {
      const { panel, el, open } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      panel.setPage({
         before: null,
         batches: [batch(5, [op(1, { op: "dropped", action: "keep", factId: null })])],
         nextBefore: null,
         error: null
      });
      open();
      el.querySelector<HTMLButtonElement>(".action-keep")!.click();
      /* DAWN pushes the batch first (the candidate kept, the stored fact appended), then replies. */
      panel.upsertBatch(
         batch(5, [
            op(1, { op: "dropped", status: "kept", action: null, factId: 88 }),
            op(2, { factId: 88 })
         ])
      );
      panel.actionDone({ kind: "keep", batchId: 5, opId: 1, ok: true, factId: 88 });
      const rows = [...el.querySelectorAll(".memory-op")];
      expect(rows.map((r) => r.classList.contains("memory-op-new"))).toEqual([false, true]);
   });

   it("not connected: says so instead of loading forever", () => {
      const { panel, el } = mounted(false);
      panel.setAvailable(true);
      panel.setVisible(true);
      expect(el.textContent).toContain("Not connected");
   });

   it("a failed first page offers a retry", () => {
      const { panel, el, button, calls } = mounted();
      panel.setAvailable(true);
      panel.setVisible(true);
      panel.setPage({ before: null, batches: [], nextBefore: null, error: "Not found" });
      expect(el.textContent).toContain("Not found");
      button("Try again")!.click();
      expect(calls.filter((c) => c === "list:first")).toHaveLength(2);
   });
});
