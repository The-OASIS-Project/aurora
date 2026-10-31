// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mountConversation, type ConversationController } from "./conversation.ts";
import type { EmailRef } from "../ingest/email.ts";

beforeAll(() => {
   if (!window.matchMedia) {
      Object.assign(window, {
         matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
      });
   }
   Object.assign(URL, { createObjectURL: () => "blob:test", revokeObjectURL: () => {} });
   Element.prototype.scrollTo = function () {} as typeof Element.prototype.scrollTo;
   class NoopObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
   }
   Object.assign(globalThis, { ResizeObserver: NoopObserver, IntersectionObserver: NoopObserver });
   /* jsdom has no iframe.sandbox token list; the visual frame only adds to it. */
   if (!(HTMLIFrameElement.prototype as unknown as { sandbox?: unknown }).sandbox) {
      Object.defineProperty(HTMLIFrameElement.prototype, "sandbox", {
         get(this: HTMLIFrameElement) {
            return { add: (t: string) => this.setAttribute("sandbox", t) };
         }
      });
   }
});

let view: ConversationController | null = null;
afterEach(() => {
   view?.destroy();
   view = null;
   document.body.replaceChildren();
});

const REF: EmailRef = {
   accountId: 3,
   messageId: "INBOX:4211.7",
   sender: "Ann <ann@example.com>",
   subject: "Lunch on Friday?"
};

function mount(): {
   sent: Array<{ text: string; refs?: EmailRef[] }>;
   opened: EmailRef[];
   send: (text: string) => void;
} {
   document.body.innerHTML = `<div id="stage"><div id="console"><div id="convo"></div>
      <form id="composer"><div class="composer-row"><button id="composer-attach" type="button"></button>
      <textarea id="composer-input"></textarea><button class="composer-hint" type="submit"></button></div></form></div></div>`;
   const sent: Array<{ text: string; refs?: EmailRef[] }> = [];
   const opened: EmailRef[] = [];
   view = mountConversation(document.getElementById("stage")!, {
      onSubmit: (text, a) => sent.push({ text, refs: a?.emailRefs }),
      canSubmit: () => true,
      turnRefs: () => true,
      emailRefsSupported: () => true,
      onOpenEmail: (r) => opened.push(r)
   });
   const input = document.getElementById("composer-input") as HTMLTextAreaElement;
   const form = document.getElementById("composer") as HTMLFormElement;
   return {
      sent,
      opened,
      send: (text) => {
         input.value = text;
         form.dispatchEvent(new Event("submit", { cancelable: true }));
      }
   };
}

const chips = (): HTMLButtonElement[] =>
   Array.from(document.querySelectorAll<HTMLButtonElement>(".convo-msg.user .convo-email-chip"));

describe("email in chat (P1.4)", () => {
   it("needs words with an email, then sends the ref with its display strings and shows the chip", () => {
      const t = mount();
      view!.addEmailRef(REF);
      t.send("");
      expect(t.sent).toEqual([]);
      expect(document.querySelector(".composer-note")?.textContent).toContain(
         "Add a question about this email"
      );
      t.send("Can I make it?");
      expect(t.sent).toEqual([{ text: "Can I make it?", refs: [REF] }]);
      expect(chips().map((c) => c.textContent)).toEqual([
         "MAILAnn <ann@example.com>: Lunch on Friday?"
      ]);
   });

   it("gives the email back with the draft when DAWN refuses the turn", () => {
      const t = mount();
      view!.addEmailRef(REF);
      t.send("Summarize it");
      expect(view!.rejectTurn("newest", false)).toBe("Summarize it");
      expect(chips()).toEqual([]); // the refused bubble (and its chip) came back out
      t.send("Summarize it, please"); // the email is attached to the draft again
      expect(t.sent.at(-1)).toEqual({ text: "Summarize it, please", refs: [REF] });
   });

   it("renders the chip on reloaded and appended rows, and opens it in Mail on click", () => {
      const t = mount();
      view!.loadHistory([
         { role: "user", text: "What does this say?", id: 10, email: REF },
         { role: "assistant", text: "It says hi.", id: 11 }
      ]);
      view!.renderAppended({
         role: "user",
         text: "And this one?",
         messageId: 12,
         email: { ...REF, messageId: "abc123" }
      });
      expect(chips().length).toBe(2);
      chips()[0].click();
      expect(t.opened).toEqual([REF]);
   });
});

describe("live visuals from the render_visual tool", () => {
   const VISUAL =
      '<dawn-visual title="Box" type="svg">\n<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>\n</dawn-visual>';
   const frames = (): number => document.querySelectorAll(".convo-msg.assistant iframe").length;

   it("joins the reply that's streaming, where it arrived", () => {
      mount();
      view!.startReply();
      view!.appendDelta("Here it is:");
      view!.addVisual(VISUAL);
      view!.appendDelta(" and some more text.");
      view!.endReply();
      expect(frames()).toBe(1);
      const body = document.querySelector(".convo-msg.assistant .convo-body")!;
      expect(body.textContent).toContain("Here it is:");
      expect(body.textContent).toContain("and some more text.");
   });

   it("waits for the reply when it arrives before any text, and a saved row doesn't double it", () => {
      mount();
      view!.addVisual(VISUAL);
      view!.startReply();
      view!.appendDelta("Drawn above.");
      view!.endReply();
      expect(frames()).toBe(1);
      view!.addVisual(VISUAL); // a tool-only turn: its saved row (message_appended) carries the visual
      view!.renderAppended({ role: "assistant", text: VISUAL, messageId: 99 });
      view!.startReply();
      view!.appendDelta("next turn");
      view!.endReply();
      expect(frames()).toBe(2); // the appended row's one, not a third from the dropped pending copy
   });
});
