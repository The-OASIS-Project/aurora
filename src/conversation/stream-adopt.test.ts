// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/* A visual's frame is a sandboxed iframe, which jsdom can't build (no iframe.sandbox): a plain
   element with the frame's class stands in, which is all these tests look at. */
vi.mock("./visual.ts", async (orig) => ({
   ...(await orig<typeof import("./visual.ts")>()),
   createVisualFrame: () => {
      const el = document.createElement("div");
      el.className = "convo-visual";
      return el;
   }
}));

const { mountConversation } = await import("./conversation.ts");

/* A streamed reply's saved row (message_appended) adopting the bubble that streamed it: the id is
   stamped on, and the bubble is redrawn from the saved text only when the words differ (a tab that
   took the session over mid-reply streamed only the rest of it). */

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
});

function mount(): ReturnType<typeof mountConversation> {
   document.body.innerHTML = `<div id="stage"><div id="console"><div id="convo"></div>
      <form id="composer"><div class="composer-row"><button id="composer-attach" type="button"></button>
      <textarea id="composer-input"></textarea><button class="composer-hint" type="submit"></button></div></form></div></div>`;
   const view = mountConversation(document.getElementById("stage")!, {
      onSubmit: () => {},
      canSubmit: () => true
   });
   destroy = () => view.destroy();
   return view;
}

const reply = (): HTMLElement =>
   document.querySelector<HTMLElement>(".convo-msg.assistant .convo-body")!;

/* Streams `text` as one reply and closes it, registered as stream 5 of conversation 1. */
function stream(view: ReturnType<typeof mountConversation>, text: string): void {
   view.startReply();
   view.appendDelta(text);
   view.endReply();
   view.linkStream(1, 5);
}

describe("adopting a streamed reply's saved row", () => {
   it("a reply that streamed only its end is redrawn whole from the saved text", () => {
      const view = mount();
      stream(view, "and that is the end of it.");
      expect(
         view.adoptId(1, 5, 99, "The whole reply, from the start, and that is the end of it.")
      ).toBe(true);
      expect(reply().textContent).toContain("The whole reply, from the start");
      expect(document.querySelector(".convo-msg.assistant")!.getAttribute("data-message-id")).toBe(
         "99"
      );
      expect(document.querySelectorAll(".convo-msg.assistant")).toHaveLength(1);
   });

   it("a reply whose words match is left as drawn (white space aside)", () => {
      const view = mount();
      stream(view, "Hello there, all of it.");
      const drawn = reply().firstElementChild;
      expect(view.adoptId(1, 5, 99, "Hello there,\n all of it.  ")).toBe(true);
      expect(reply().firstElementChild).toBe(drawn); // the same node: not redrawn
   });

   const VISUAL = '<dawn-visual title="t" type="svg"><svg></svg></dawn-visual>';

   it("a visual drawn mid-reply stays where it was when the words match", () => {
      const view = mount();
      view.startReply();
      view.appendDelta("Before it. ");
      view.addVisual(VISUAL);
      view.appendDelta("After it.");
      view.endReply();
      view.linkStream(1, 5);
      const frame = reply().querySelector(".convo-visual");
      expect(frame).not.toBeNull();
      /* The saved row has the visual at its end, as DAWN saves it. */
      expect(view.adoptId(1, 5, 99, `Before it. After it.\n${VISUAL}\n`)).toBe(true);
      expect(reply().querySelector(".convo-visual")).toBe(frame); // the same frame, not redrawn
   });

   it("a visual the tab missed is drawn from the saved row", () => {
      const view = mount();
      stream(view, "Here it is.");
      expect(reply().querySelector(".convo-visual")).toBeNull();
      view.adoptId(1, 5, 99, `Here it is.\n${VISUAL}\n`);
      expect(reply().querySelectorAll(".convo-visual")).toHaveLength(1);
   });

   it("a saved image marker is drawn as an image, not as text, as a reload draws it", () => {
      const view = mount();
      stream(view, "Here is the picture.");
      view.adoptId(1, 5, 99, "Here is the picture.\n[IMAGE:img_abcdefghijkl]");
      expect(reply().textContent).not.toContain("[IMAGE:");
      expect(reply().querySelectorAll(".convo-image-thumb")).toHaveLength(1);
   });

   it("a different reply that happens to share the stream id doesn't overwrite the bubble", () => {
      const view = mount();
      stream(view, "My own reply, all of it.");
      view.adoptId(1, 5, 99, "Another session's reply about something else.");
      expect(reply().textContent).toContain("My own reply, all of it.");
   });

   it("a row for a stream it didn't draw isn't adopted", () => {
      const view = mount();
      stream(view, "Mine.");
      expect(view.adoptId(1, 6, 99, "Someone else's.")).toBe(false);
      expect(reply().textContent).toContain("Mine.");
   });
});
