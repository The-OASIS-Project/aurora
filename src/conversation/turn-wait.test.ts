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
