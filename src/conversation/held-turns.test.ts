// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mountConversation, type ConversationController } from "./conversation.ts";

beforeAll(() => {
   if (!window.matchMedia) {
      Object.assign(window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
   }
   Object.assign(URL, { createObjectURL: () => "blob:test", revokeObjectURL: () => {} });
   Element.prototype.scrollTo = function () {} as typeof Element.prototype.scrollTo;
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
});

/* The composer markup the view binds to (a subset of index.html). */
function mount(
   onSubmit: (text: string, a?: { turnRef?: string }) => void,
   turnRefs = false
): { input: HTMLTextAreaElement; send: (text: string) => void } {
   document.body.innerHTML = `<div id="stage"><div id="console"><div id="convo"></div>
      <form id="composer"><div class="composer-row"><button id="composer-attach" type="button"></button>
      <textarea id="composer-input"></textarea><button class="composer-hint" type="submit"></button></div></form></div></div>`;
   const stage = document.getElementById("stage")!;
   view = mountConversation(stage, {
      onSubmit,
      canSubmit: () => true,
      turnRefs: () => turnRefs,
      uploadDocument: () => Promise.reject(new Error("unused")),
      uploadImage: () => Promise.resolve({ id: "img_fresh", mimeType: "image/jpeg", size: 1 })
   });
   const input = document.getElementById("composer-input") as HTMLTextAreaElement;
   const form = document.getElementById("composer") as HTMLFormElement;
   return {
      input,
      send: (text) => {
         input.value = text;
         form.dispatchEvent(new Event("submit", { cancelable: true }));
      }
   };
}

const userBubbles = (): string[] => Array.from(document.querySelectorAll(".convo-msg.user .convo-body")).map((b) => b.textContent ?? "");

describe("held turns with turn references (turn_refs)", () => {
   it("tags each turn and confirms / refuses exactly the turn named, even with identical text", () => {
      const refs: string[] = [];
      const { input, send } = mount((_t, a) => refs.push(a?.turnRef ?? ""), true);
      send("same");
      send("same");
      send("other");
      expect(new Set(refs).size).toBe(3);
      view!.confirmTurn("same", refs[1]); // DAWN echoed the SECOND "same"
      expect(view!.rejectTurn({ ref: refs[0] }, false)).toBe("same"); // the first is refused
      expect(userBubbles()).toEqual(["same", "other"]);
      expect(input.value).toBe("same");
      expect(view!.rejectTurn({ ref: refs[1] }, false)).toBeNull(); // already confirmed
   });
});

describe("refusal note", () => {
   it("shows above the composer and clears when the user edits or sends", () => {
      const { input, send } = mount(() => {});
      send("refused");
      view!.rejectTurn("newest", false);
      view!.noteRefusal("Message not sent: too many images");
      const note = (): Element | null => document.querySelector(".composer-note");
      expect(note()?.textContent).toContain("too many images");
      expect(note()?.getAttribute("role")).toBe("alert");
      input.dispatchEvent(new Event("input"));
      expect(note()).toBeNull();
      view!.noteRefusal("again");
      send("retry");
      expect(note()).toBeNull();
      view!.noteRefusal("once more");
      view!.addEmailRef({ accountId: 1, messageId: "m", sender: "s", subject: "x" });
      expect(note()).toBeNull(); // adding an attachment edits the draft too
      view!.noteRefusal("and again");
      (document.querySelector(".composer-pending-remove") as HTMLButtonElement).click();
      expect(note()).toBeNull(); // so does removing one
   });
});

describe("held turns", () => {
   it("a refusal of the newest turn takes its bubble back and restores its text", () => {
      const sent = vi.fn();
      const { input, send } = mount(sent);
      send("first");
      send("second");
      expect(userBubbles()).toEqual(["first", "second"]);
      view!.confirmTurn("first");
      expect(view!.rejectTurn("newest", false)).toBe("second");
      expect(userBubbles()).toEqual(["first"]);
      expect(input.value).toBe("second");
   });

   it("an echo confirms the matching held turn, so a later refusal can't take it back", () => {
      const { send } = mount(() => {});
      send("hello");
      view!.confirmTurn("hello");
      expect(view!.rejectTurn("newest", false)).toBeNull();
      expect(userBubbles()).toEqual(["hello"]);
   });

   it("an image refusal names only the image turn, not a later text turn", () => {
      const { input, send } = mount(() => {});
      send("plain one");
      expect(view!.rejectTurn("image", false)).toBeNull(); // no image turn is held
      expect(userBubbles()).toEqual(["plain one"]);
      expect(input.value).toBe("");
   });

   it("merges a restored turn ahead of a new draft instead of dropping either", () => {
      const { input, send } = mount(() => {});
      send("refused one");
      input.value = "typing something new";
      view!.rejectTurn("newest", false);
      expect(input.value).toBe("refused one\n\ntyping something new");
   });

   it("drops holds on release (link loss / conversation switch)", () => {
      const { send } = mount(() => {});
      send("in flight");
      view!.releaseTurns();
      expect(view!.rejectTurn("newest", false)).toBeNull();
      expect(userBubbles()).toEqual(["in flight"]);
   });
});
