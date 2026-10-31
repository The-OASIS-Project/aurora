import { describe, expect, it } from "vitest";
import { collectToolNotes, type NoteRow } from "./tool-notes.ts";

const a = (content: string, extra: Partial<NoteRow> = {}): NoteRow => ({
   role: "assistant",
   content,
   ...extra
});

describe("collectToolNotes", () => {
   it("pairs call notes with the following result notes, keeping lead-in prose", () => {
      const rows = [
         a("Let me check.\n\n[Tool Call: get_weather]\n\n[Tool Call: get_time]"),
         a("[Tool Result: Sunny, 72F]"),
         a("[Tool Result: 3:04 PM]"),
         a("It's sunny and 72.")
      ];
      const r = collectToolNotes(rows, 0, "7");
      expect(r?.prose).toBe("Let me check.");
      expect(r?.consumed).toBe(2);
      expect(r?.tools).toEqual([
         { id: "note-7-0", name: "get_weather", args: undefined, result: "Sunny, 72F" },
         { id: "note-7-1", name: "get_time", args: undefined, result: "3:04 PM" }
      ]);
   });

   it("splits several results in one message only on the exact seam", () => {
      const rows = [
         a("[Tool Call: a]\n\n[Tool Call: b]"),
         a("[Tool Result: x] y]\n\n[Tool Result: (no text)]")
      ];
      const r = collectToolNotes(rows, 0, "1");
      expect(r?.tools.map((t) => t.result)).toEqual(["x] y", "(no text)"]);
      expect(r?.consumed).toBe(1);
   });

   it("labels an unsaved call and pads mismatched counts", () => {
      const rows = [
         a("[Tool Call: its name and arguments weren't saved]"),
         a("[Tool Result: one]\n\n[Tool Result: two]")
      ];
      const r = collectToolNotes(rows, 0, "2");
      expect(r?.tools[0]).toMatchObject({ name: "tool", result: "one" });
      expect(r?.tools[0].args).toMatch(/weren.t saved/);
      expect(r?.tools[1]).toMatchObject({ name: "tool", result: "two" });
      const extraCalls = collectToolNotes([a("[Tool Call: a]\n\n[Tool Call: b]")], 0, "3");
      expect(extraCalls?.tools.map((t) => t.result)).toEqual(["", ""]);
      expect(extraCalls?.consumed).toBe(0);
   });

   it("ignores ordinary text, a note mid-message, user rows, and structured turns", () => {
      expect(collectToolNotes([a("Just an answer.")], 0, "x")).toBeNull();
      expect(collectToolNotes([a("[Tool Call: a]\n\nand then more prose")], 0, "x")).toBeNull();
      expect(collectToolNotes([{ role: "user", content: "[Tool Call: a]" }], 0, "x")).toBeNull();
      expect(
         collectToolNotes([a("[Tool Call: a]", { tool_calls: [{ id: "t1" }] })], 0, "x")
      ).toBeNull();
   });

   it("leaves a stray result row and a [No text] row alone", () => {
      expect(collectToolNotes([a("[Tool Result: orphan]")], 0, "5")).toBeNull();
      expect(collectToolNotes([a("[Tool Call: a]"), a("[No text]")], 0, "6")?.consumed).toBe(0);
   });

   it("stops consuming at the first non-result row", () => {
      const rows = [
         a("[Tool Call: a]"),
         a("[Tool Result: r]"),
         { role: "user", content: "[Tool Result: typed]" }
      ];
      expect(collectToolNotes(rows, 0, "4")?.consumed).toBe(1);
   });
});
