import { describe, expect, it } from "vitest";
import { parseMemoryBatch, parseMemoryBatchPage, rowId } from "./memory-batch-wire.ts";

/* A batch as DAWN's WEBSOCKET_PROTOCOL.md shows it ("The batch object", "Op rows"). */
const batch = (over: Record<string, unknown> = {}) => ({
   batch_id: 412,
   conversation_id: 1703,
   from_message_id: 26230,
   after_message_id: 26244,
   created_at: 1793000000,
   path: "agent",
   status: "applied",
   outside: true,
   outside_from: "email",
   counts: { added: 3, reinforced: 2, merged: 1, dropped: 0 },
   ops: [
      {
         op_id: 9001,
         op: "merged",
         status: "applied",
         outside: false,
         outside_from: null,
         fact_id: 7690,
         text: "likes tea",
         target_fact_id: 7702,
         target_text: "prefers tea",
         target_status: "current",
         reason: "same thing",
         reason_by: "model",
         action: "undo"
      },
      { op_id: 9000, op: "added", fact_id: 7702, sources: [{ fact_id: 7690, text: "likes tea" }] }
   ],
   ...over
});

describe("reading a memory batch", () => {
   it("reads the batch and its ops as DAWN sends them", () => {
      const b = parseMemoryBatch(batch());
      expect(b).toMatchObject({
         batchId: 412,
         conversationId: 1703,
         afterMessageId: 26244,
         createdAt: 1793000000,
         status: "applied",
         outside: true,
         outsideFrom: "email",
         counts: { added: 3, reinforced: 2, merged: 1 }
      });
      expect(b?.counts.dropped).toBeUndefined(); // zero counts drop out
      expect(b?.ops[0]).toEqual({
         opId: 9001,
         op: "merged",
         status: "applied",
         outside: false,
         outsideFrom: null,
         factId: 7690,
         text: "likes tea",
         targetText: "prefers tea",
         targetStatus: "current",
         sources: [],
         reason: "same thing",
         reasonBy: "model",
         action: "undo"
      });
      expect(b?.ops[1]).toMatchObject({
         status: "applied", // absent status reads as applied
         sources: [{ factId: 7690, text: "likes tea" }],
         action: null,
         reasonBy: null
      });
   });

   it("drops a batch with no usable id, and skips ops with none", () => {
      expect(parseMemoryBatch({ ...batch(), batch_id: "412" })).toBeNull();
      expect(parseMemoryBatch({ ...batch(), batch_id: 0 })).toBeNull();
      expect(parseMemoryBatch(null)).toBeNull();
      const b = parseMemoryBatch(
         batch({ ops: [{ op: "added" }, { op_id: 5 }, "x", { op_id: 6, op: "added" }] })
      );
      expect(b?.ops.map((o) => o.opId)).toEqual([6]);
   });

   it("keeps a kind it doesn't know, and refuses an action it doesn't", () => {
      const b = parseMemoryBatch(
         batch({ ops: [{ op_id: 1, op: "teleported", status: "beamed", action: "delete_all" }] })
      );
      expect(b?.ops[0]).toMatchObject({ op: "teleported", status: "beamed", action: null });
   });

   it("names what outside text was read only when the batch read some", () => {
      expect(
         parseMemoryBatch(batch({ outside: false, outside_from: "email" }))?.outsideFrom
      ).toBeNull();
      expect(parseMemoryBatch(batch({ outside_from: "carrier_pigeon" }))?.outsideFrom).toBe(
         "carrier_pigeon"
      );
   });

   it("tells a DAWN that sends no title from a batch with none", () => {
      expect(parseMemoryBatch(batch())).not.toHaveProperty("conversationTitle");
      expect(parseMemoryBatch(batch({ conversation_title: null }))?.conversationTitle).toBeNull();
      expect(parseMemoryBatch(batch({ conversation_title: "Trip plans" }))?.conversationTitle).toBe(
         "Trip plans"
      );
   });

   it("reads a missing anchor as the list only", () => {
      expect(parseMemoryBatch(batch({ after_message_id: null }))?.afterMessageId).toBe(0);
      expect(parseMemoryBatch(batch({ conversation_id: null }))?.conversationId).toBeNull();
   });

   it("treats ids as positive safe integers only", () => {
      expect(rowId(5)).toBe(5);
      expect([rowId(0), rowId(-1), rowId(1.5), rowId("5"), rowId(2 ** 60)]).toEqual([
         null,
         null,
         null,
         null,
         null
      ]);
   });
});

describe("reading a Learned list page", () => {
   it("carries the cursor for the next page only when there is more", () => {
      expect(
         parseMemoryBatchPage({
            before_batch_id: null,
            batches: [batch()],
            has_more: true,
            next_before_batch_id: 371,
            error: null
         })
      ).toMatchObject({ before: null, nextBefore: 371, error: null });
      expect(
         parseMemoryBatchPage({ before_batch_id: 380, batches: [], has_more: false }).nextBefore
      ).toBeNull();
   });

   it("an error page has no batches", () => {
      expect(parseMemoryBatchPage({ error: "Not found", batches: [batch()] })).toEqual({
         before: null,
         batches: [],
         nextBefore: null,
         error: "Not found"
      });
   });
});
