import { describe, expect, it } from "vitest";
import { MemoryMarks, type MarkPage } from "./memory-marks.ts";
import type { MemoryBatch, MemoryMark } from "./ingest.ts";

/* The marks for the conversation on screen: read when it opens (a few pages), kept current from
   pushes, a push landing while a page is on its way applied over it. */

const batch = (
   batchId: number,
   conversationId = 7,
   over: Partial<MemoryBatch> = {}
): MemoryBatch => ({
   batchId,
   conversationId,
   afterMessageId: 10,
   createdAt: 1793000000,
   status: "applied",
   outside: false,
   outsideFrom: null,
   counts: { added: 1 },
   ops: [],
   ...over
});

function tracker(sent = true) {
   const asked: Array<[number, number | null]> = [];
   let drawn: MemoryMark[] = [];
   const marks = new MemoryMarks(
      (c, before) => (asked.push([c, before]), sent),
      (m) => (drawn = m)
   );
   const ids = (): Array<[number, boolean]> => drawn.map((m) => [m.batch.batchId, m.live]);
   const page = (p: Partial<MarkPage>): void =>
      marks.page({
         conversationId: 7,
         before: null,
         batches: [],
         nextBefore: null,
         error: null,
         ...p
      });
   return { marks, asked, ids, page };
}

describe("the marks for the conversation on screen", () => {
   it("reads its batches when it opens, and draws them as listed (not live)", () => {
      const t = tracker();
      t.marks.show(7);
      expect(t.asked).toEqual([[7, null]]);
      t.page({ batches: [batch(5), batch(3)] });
      expect(t.ids()).toEqual([
         [3, false],
         [5, false]
      ]);
   });

   it("follows the next pages, a few deep", () => {
      const t = tracker();
      t.marks.show(7);
      for (let i = 0; i < 7; i++) t.page({ batches: [batch(100 - i)], nextBefore: 100 - i });
      expect(t.asked).toHaveLength(5); // the first page and four more
   });

   it("a batch recorded now is live; one for another conversation isn't drawn", () => {
      const t = tracker();
      t.marks.show(7);
      t.page({});
      t.marks.push(batch(9));
      t.marks.push(batch(10, 8));
      expect(t.ids()).toEqual([[9, true]]);
   });

   it("a push while a page is on its way is applied over it", () => {
      const t = tracker();
      t.marks.show(7);
      t.marks.push(batch(5, 7, { status: "undone" }));
      t.marks.remove(4);
      t.page({ batches: [batch(5), batch(4)] });
      expect(t.ids()).toEqual([[5, true]]);
   });

   it("a page drops the marks in its range it no longer holds (forgotten while away)", () => {
      const t = tracker();
      t.marks.show(7);
      t.page({ batches: [batch(5), batch(3)] });
      t.marks.refresh(); // a reconnect
      t.page({ batches: [batch(5)] });
      expect(t.ids()).toEqual([[5, false]]);
   });

   it("another conversation's late page changes nothing", () => {
      const t = tracker();
      t.marks.show(7);
      t.marks.show(8); // opened another before the first page came
      t.page({ conversationId: 7, batches: [batch(5)] });
      expect(t.ids()).toEqual([]);
   });

   it("a new chat clears the marks", () => {
      const t = tracker();
      t.marks.show(7);
      t.page({ batches: [batch(5)] });
      t.marks.show(0);
      expect(t.ids()).toEqual([]);
   });

   it("a link loss ends the page asked for, applying what it held", () => {
      const t = tracker();
      t.marks.show(7);
      t.marks.push(batch(9));
      t.marks.linkDown();
      expect(t.ids()).toEqual([[9, true]]);
   });
});
