// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { mountConversation, type ConversationController } from "./conversation.ts";

/* The view half of turn_wait: the wait line under the waiting message and its delayed offer to
   stop the other reply, the other turn's messages placed above it, and a reload of the same
   conversation keeping the unsaved message (with its images' URLs). */

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

let view: ConversationController | null = null;
afterEach(() => {
   view?.destroy();
   view = null;
   document.body.replaceChildren();
   vi.useRealTimers();
   vi.restoreAllMocks();
});

let lastRef = "";
function mount(onStopOther = (): void => {}) {
   document.body.innerHTML = `<div id="stage"><div id="console"><div id="convo"></div>
      <form id="composer"><div class="composer-row"><button id="composer-attach" type="button"></button>
      <textarea id="composer-input"></textarea><button class="composer-hint" type="submit"></button></div></form></div></div>`;
   view = mountConversation(document.getElementById("stage")!, {
      onSubmit: (_t: string, a?: { turnRef?: string }) => {
         lastRef = a?.turnRef ?? "";
      },
      canSubmit: () => true,
      turnRefs: () => true,
      onStopOther,
      fetchImage: () => Promise.resolve({ blob: new Blob(["x"], { type: "image/jpeg" }) })
   } as never);
   const input = document.getElementById("composer-input") as HTMLTextAreaElement;
   const form = document.getElementById("composer") as HTMLFormElement;
   return (text: string): void => {
      input.value = text;
      form.dispatchEvent(new Event("submit", { cancelable: true }));
   };
}

const bubbles = (): string[] =>
   Array.from(document.querySelectorAll(".convo-msg .convo-body")).map((b) =>
      (b.textContent ?? "").trim()
   );

it("shows the wait under the message, offers the stop after the delay, and puts the other turn above", () => {
   vi.useFakeTimers();
   const stops: number[] = [];
   const send = mount(() => stops.push(1));
   send("after you");
   view!.setTurnWait({ ref: lastRef, holder: "job", stopAfterMs: 5000, stopping: false });
   const wait = document.querySelector(".convo-msg.user .convo-wait")!;
   expect(wait.textContent).toContain("Sends when the background job's turn finishes");
   expect(wait.querySelector("button")).toBeNull();
   vi.advanceTimersByTime(5000);
   const stop = wait.querySelector<HTMLButtonElement>("button.convo-wait-stop")!;
   stop.click();
   expect(stops).toEqual([1]);
   view!.setTurnWait({ ref: lastRef, holder: "job", stopAfterMs: 5000, stopping: true });
   expect(stop.disabled).toBe(true);
   view!.renderAppended({ role: "assistant", text: "the job's answer", messageId: 50 });
   expect(bubbles()).toEqual(["the job's answer", expect.stringContaining("after you")]);
   view!.setTurnWait(null);
   expect(document.querySelector(".convo-wait")).toBeNull();
});

it("a reload of the same conversation keeps the waiting message and its image URLs", async () => {
   let n = 0;
   vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:img-${++n}`);
   const revoked: string[] = [];
   vi.spyOn(URL, "revokeObjectURL").mockImplementation((u) => void revoked.push(u));
   const send = mount();
   view!.loadHistory([{ role: "assistant", text: "older [IMAGE:img_aaaaaaaaaaaa]", id: 1 }]);
   send("look [IMAGE:img_bbbbbbbbbbbb]");
   await vi.waitFor(() => expect(n).toBe(2));
   view!.loadHistory([{ role: "assistant", text: "saved meanwhile", id: 2 }], lastRef);
   expect(bubbles()).toEqual(["saved meanwhile", expect.stringContaining("look")]);
   expect(revoked).toEqual(["blob:img-1"]); // the old transcript's, not the kept message's
   const kept = document.querySelector<HTMLImageElement>(".convo-msg.user img")!;
   expect(kept.src).toBe("blob:img-2");
});

const mark = (): string | null =>
   document.querySelector(".convo-msg.assistant .convo-stopped")?.textContent ?? null;

it("a stopped reply keeps its mark when DAWN saves it as stopped, drawn from the saved row", () => {
   mount();
   view!.startReply();
   view!.appendDelta("Once upon a ti");
   view!.markStopped();
   expect(mark()).toBe("Stopped");
   view!.linkStream(7, 3, 1);
   expect(view!.adoptId(7, 3, 90, "Once upon a time", 1, true)).toBe(true);
   expect(mark()).toBe("Stopped");
   expect(bubbles()).toEqual(["Once upon a time"]);
});

it("a stopped reply DAWN saved whole loses its mark; one it didn't save says so", () => {
   mount();
   view!.startReply();
   view!.appendDelta("All of it");
   view!.markStopped();
   view!.linkStream(7, 3, 1);
   view!.adoptId(7, 3, 90, "All of it, finished.", 1, false);
   expect(mark()).toBeNull();
   expect(bubbles()).toEqual(["All of it, finished."]);
   view!.startReply();
   view!.appendDelta("Never kept");
   view!.markStopped();
   view!.stoppedUnsaved();
   expect(
      Array.from(document.querySelectorAll(".convo-stopped")).map((n) => n.textContent)
   ).toEqual(["Stopped · not saved"]);
});

it("a reload and another tab's row draw the mark from the row", () => {
   mount();
   view!.loadHistory([
      { role: "user", text: "tell me", id: 1 },
      { role: "assistant", text: "Half a story", id: 2, stopped: true },
      { role: "assistant", text: "A whole one", id: 3 }
   ]);
   expect(
      Array.from(document.querySelectorAll(".convo-msg")).map(
         (m) => m.querySelector(".convo-stopped")?.textContent ?? ""
      )
   ).toEqual(["", "Stopped", ""]);
   view!.renderAppended({ role: "assistant", text: "Cut short", messageId: 4, stopped: true });
   expect(document.querySelectorAll(".convo-stopped")).toHaveLength(2);
});
