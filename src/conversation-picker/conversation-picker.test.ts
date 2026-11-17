// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mountConversationPicker } from "./conversation-picker.ts";
import type { ConversationMeta } from "../ingest/ingest.ts";

/* An inline rename and a rename from elsewhere at the same time: since DAWN #120 every rename
   reaches every client (conversation_renamed), so one can land while the user's own rename input
   is open. */

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
});

afterEach(() => {
   localStorage.clear();
   document.body.replaceChildren();
});

const row = (id: number, title: string): ConversationMeta => ({
   id,
   title,
   createdAt: 1793000000,
   updatedAt: 1793000000,
   messageCount: 2,
   isArchived: false,
   isPrivate: false,
   isPinned: false,
   origin: "webui"
});

function mounted() {
   localStorage.setItem("dawn.hero.conversationsOpen", "true"); // the list open, not collapsed
   const renames: Array<[number, string]> = [];
   const picker = mountConversationPicker(document.body, {
      onLoad: () => {},
      onNew: () => {},
      onSearch: () => {},
      onRename: (id, title) => renames.push([id, title]),
      onDelete: () => {},
      onPin: () => {},
      onForgetMemories: () => {},
      onLoadMore: () => {}
   });
   picker.setList([row(7, "Trip plans")], { append: false, searching: false });
   const startRename = (): HTMLInputElement => {
      document.querySelector<HTMLButtonElement>(".cpick-act-rename")!.click();
      return document.querySelector<HTMLInputElement>(".cpick-rename-input")!;
   };
   const titles = (): string[] =>
      [...document.querySelectorAll(".cpick-row-title")].map((t) => t.textContent ?? "");
   return { picker, renames, startRename, titles };
}

describe("an inline rename while a rename lands from elsewhere", () => {
   it("keeps the input, and clicking away unchanged doesn't send the old title back", () => {
      const { picker, renames, startRename, titles } = mounted();
      const input = startRename();
      input.value = "Trip plans"; // what the user sees, untouched
      picker.markRenamed(7, "Summer trip"); // another tab renamed it meanwhile
      expect(document.activeElement).toBe(input); // still editing
      input.blur();
      expect(renames).toEqual([]);
      expect(titles()).toEqual(["Summer trip"]);
   });

   it("a title the user did type still goes", () => {
      const { picker, renames, startRename } = mounted();
      const input = startRename();
      picker.markRenamed(7, "Summer trip");
      input.value = "Beach week";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      expect(renames).toEqual([[7, "Beach week"]]);
   });
});
