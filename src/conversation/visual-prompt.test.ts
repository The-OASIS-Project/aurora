// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/* Capture the view's visual-prompt handler (the real bridge needs a loaded iframe). */
let visualPrompt: ((text: string) => void) | null = null;
vi.mock("./visual.ts", async (orig) => ({
   ...(await orig<typeof import("./visual.ts")>()),
   initVisuals: (cb: (text: string) => void) => {
      visualPrompt = cb;
      return () => {};
   }
}));

const { mountConversation } = await import("./conversation.ts");
const { visualPromptText, VISUAL_PROMPT_MAX } = await import("./visual.ts");

beforeAll(() => {
   if (!window.matchMedia) {
      Object.assign(window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
   }
   Element.prototype.scrollTo = function () {} as typeof Element.prototype.scrollTo;
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
});

type Sent = { text: string; a?: { turnRef?: string; fromVisual?: boolean } };

function mount(guard = true): { sent: Sent[]; input: HTMLTextAreaElement; view: ReturnType<typeof mountConversation> } {
   document.body.innerHTML = `<div id="stage"><div id="console"><div id="convo"></div>
      <form id="composer"><div class="composer-row"><button id="composer-attach" type="button"></button>
      <textarea id="composer-input"></textarea><button class="composer-hint" type="submit"></button></div></form></div></div>`;
   const sent: Sent[] = [];
   const view = mountConversation(document.getElementById("stage")!, {
      onSubmit: (text, a) => sent.push({ text, a }),
      canSubmit: () => true,
      turnRefs: () => true,
      visualPrompts: () => guard,
      onVisualPromptBlocked: () => sent.push({ text: "<blocked>" })
   });
   destroy = () => view.destroy();
   return { sent, input: document.getElementById("composer-input") as HTMLTextAreaElement, view };
}

describe("a rendered visual's prompt", () => {
   it("goes as its own from_visual turn and never touches the person's draft", () => {
      const t = mount();
      t.input.value = "my half-typed draft";
      visualPrompt!("yes");
      expect(t.sent).toEqual([{ text: "yes", a: { turnRef: expect.any(String), fromVisual: true } }]);
      expect(t.input.value).toBe("my half-typed draft");
   });

   it("is never sent to a DAWN that can't refuse confirms in it, and one goes per gesture", () => {
      const old = mount(false);
      visualPrompt!("yes");
      visualPrompt!("yes"); // a looping script: one notice, not a stack
      expect(old.sent).toEqual([{ text: "<blocked>" }]);
      expect(document.querySelectorAll(".convo-msg.user").length).toBe(0);
      destroy?.();
      const t = mount();
      visualPrompt!("one");
      visualPrompt!("two"); // the same gesture's window: dropped
      expect(t.sent.map((s) => s.text)).toEqual(["one"]);
   });

   it("isn't put into the draft when DAWN refuses it", () => {
      const t = mount();
      t.input.value = "draft";
      visualPrompt!("yes");
      const ref = t.sent[0].a!.turnRef!;
      expect(t.view.rejectTurn({ ref }, false)).toBe("yes");
      expect(t.input.value).toBe("draft");
      expect(document.querySelectorAll(".convo-msg.user").length).toBe(0);
   });

   it("needs a recent gesture and some text, and is capped", () => {
      expect(visualPromptText("yes", false)).toBeNull();
      expect(visualPromptText("   ", true)).toBeNull();
      expect(visualPromptText("  show more  ", true)).toBe("show more");
      expect(visualPromptText("x".repeat(VISUAL_PROMPT_MAX + 50), true)!.length).toBe(VISUAL_PROMPT_MAX);
   });
});
