// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MemoryBatch } from "../ingest/ingest.ts";

vi.mock("./visual.ts", async (orig) => ({
   ...(await orig<typeof import("./visual.ts")>()),
   createVisualFrame: () => {
      const el = document.createElement("div");
      el.className = "convo-visual";
      return el;
   }
}));

const { mountConversation } = await import("./conversation.ts");

/* What memory learned, drawn in the conversation: a chip after the newest message on screen at or
   below the batch's after_message_id, waiting a moment for a reply's id when the batch was just
   recorded, gone with the transcript, and opening the batch when clicked. */

beforeAll(() => {
   if (!window.matchMedia) {
      Object.assign(window, {
         matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
      });
   }
   Element.prototype.scrollTo = function () {};
   class NoopObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
   }
   Object.assign(globalThis, { ResizeObserver: NoopObserver, IntersectionObserver: NoopObserver });
});

let destroy: (() => void) | null = null;
afterEach(() => {
   destroy?.();
   destroy = null;
   document.body.replaceChildren();
   vi.useRealTimers();
});

function mount(opened: MemoryBatch[] = []) {
   document.body.innerHTML = `<div id="stage"><div id="console"><div id="convo"></div>
      <form id="composer"><div class="composer-row"><button id="composer-attach" type="button"></button>
      <textarea id="composer-input"></textarea><button class="composer-hint" type="submit"></button></div></form></div></div>`;
   const view = mountConversation(document.getElementById("stage")!, {
      onSubmit: () => {},
      canSubmit: () => true,
      onOpenMemoryBatch: (b) => opened.push(b)
   });
   destroy = () => view.destroy();
   return view;
}

const batch = (
   batchId: number,
   afterMessageId: number,
   over: Partial<MemoryBatch> = {}
): MemoryBatch => ({
   batchId,
   conversationId: 7,
   afterMessageId,
   createdAt: 1793000000,
   status: "applied",
   outside: false,
   outsideFrom: null,
   counts: { added: 2, merged: 1 },
   ops: [],
   ...over
});

/* What the transcript shows, in order: "u<id>" / "a<id>" for messages, "m<batch>" for marks. */
const order = (): string[] =>
   [...document.querySelectorAll<HTMLElement>(".convo-scroll > *")]
      .map((el) =>
         el.classList.contains("convo-memory")
            ? `m${el.dataset.batchId}`
            : el.classList.contains("convo-msg")
              ? `${el.classList.contains("user") ? "u" : "a"}${el.dataset.messageId ?? "?"}`
              : ""
      )
      .filter(Boolean);

const history = [
   { role: "user" as const, text: "hello", id: 10 },
   { role: "assistant" as const, text: "hi", id: 11 },
   { role: "user" as const, text: "more", id: 14 },
   { role: "assistant" as const, text: "sure", id: 15 }
];

describe("memory marks in the conversation", () => {
   it("go after the newest message at or below where each batch read up to", () => {
      const view = mount();
      view.loadHistory(history);
      view.setMemoryMarks([
         { batch: batch(2, 13), live: false }, // after 11 (12 and 13 aren't drawn: tool rows)
         { batch: batch(3, 15), live: false },
         { batch: batch(4, 0), live: false }, // the list only
         { batch: batch(5, 5), live: false } // its messages aren't on screen
      ]);
      expect(order()).toEqual(["u10", "a11", "m2", "u14", "a15", "m3"]);
      expect(document.querySelector(".convo-memory")?.textContent).toBe(
         "Memory2 learned, 1 updated"
      );
   });

   it("open the batch they show", () => {
      const opened: MemoryBatch[] = [];
      const view = mount(opened);
      view.loadHistory(history);
      view.setMemoryMarks([{ batch: batch(3, 15), live: false }]);
      document.querySelector<HTMLButtonElement>(".convo-memory")!.click();
      expect(opened.map((b) => b.batchId)).toEqual([3]);
   });

   it("a batch just recorded waits for its reply's id instead of landing above the reply", () => {
      vi.useFakeTimers();
      const view = mount();
      view.loadHistory(history.slice(0, 2));
      view.showUser("and then?", 20);
      view.startReply();
      view.appendDelta("the reply");
      view.endReply(); // streamed, not yet given its id
      view.setMemoryMarks([{ batch: batch(6, 21), live: true }]);
      expect(order()).toEqual(["u10", "a11", "u20", "a?"]); // waiting, not after u20
      view.linkStream(7, 1);
      view.adoptId(7, 1, 21, "the reply");
      vi.advanceTimersByTime(10);
      expect(order()).toEqual(["u10", "a11", "u20", "a21", "m6"]);
   });

   it("after waiting long enough, a just-recorded batch goes where it can", () => {
      vi.useFakeTimers();
      const view = mount();
      view.loadHistory(history.slice(0, 2));
      view.setMemoryMarks([{ batch: batch(6, 30), live: true }]);
      vi.advanceTimersByTime(3500);
      expect(order()).toEqual(["u10", "a11", "m6"]);
   });

   it("an unchanged mark keeps its element when the marks are placed again", () => {
      const view = mount();
      view.loadHistory(history);
      const b = batch(3, 15);
      view.setMemoryMarks([{ batch: b, live: false }]);
      const before = document.querySelector(".convo-memory");
      view.setMemoryMarks([
         { batch: batch(2, 11), live: false },
         { batch: b, live: false }
      ]);
      expect(document.querySelectorAll(".convo-memory")[1]).toBe(before);
      expect(order()).toEqual(["u10", "a11", "m2", "u14", "a15", "m3"]);
   });

   it("a just-recorded batch whose messages aren't on screen isn't drawn after its wait", () => {
      vi.useFakeTimers();
      const view = mount();
      view.loadHistory(history.slice(0, 2)); // messages 10 and 11
      view.setMemoryMarks([{ batch: batch(6, 5), live: true }]); // read up to 5: not loaded
      vi.advanceTimersByTime(3500);
      expect(order()).toEqual(["u10", "a11"]);
   });

   it("in a fresh chat with no ids yet, a just-recorded batch goes at the end after its wait", () => {
      vi.useFakeTimers();
      const view = mount();
      view.showUser("hi");
      view.setMemoryMarks([{ batch: batch(6, 5), live: true }]);
      vi.advanceTimersByTime(3500);
      expect(order()).toEqual(["u?", "m6"]);
   });

   it("say an undone batch is undone, not only show it struck through", () => {
      const view = mount();
      view.loadHistory(history);
      view.setMemoryMarks([{ batch: batch(3, 15, { status: "undone" }), live: false }]);
      expect(document.querySelector(".convo-memory")?.getAttribute("aria-label")).toContain(
         "2 learned, 1 updated, undone"
      );
   });

   it("follow a typed message once DAWN confirms it with its id", () => {
      const view = mount();
      view.loadHistory(history.slice(0, 2)); // up to reply 11
      const input = document.getElementById("composer-input") as HTMLTextAreaElement;
      input.value = "and another thing";
      document.getElementById("composer")!.dispatchEvent(new Event("submit", { cancelable: true }));
      view.confirmTurn("and another thing", undefined, 14); // DAWN's echo
      view.setMemoryMarks([{ batch: batch(7, 14), live: false }]);
      expect(order()).toEqual(["u10", "a11", "u14", "m7"]);
   });

   it("go with the transcript", () => {
      const view = mount();
      view.loadHistory(history);
      view.setMemoryMarks([{ batch: batch(3, 15), live: false }]);
      view.loadHistory(history.slice(0, 2)); // another conversation opened
      expect(order()).toEqual(["u10", "a11"]);
   });
});
