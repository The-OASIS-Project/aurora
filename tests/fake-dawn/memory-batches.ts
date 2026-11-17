/* What memory learned, per batch, as the fake DAWN keeps it for one user (memory_batches).

   Provenance: DAWN's webui_memory_batches.c and docs/WEBSOCKET_PROTOCOL.md, "Consolidation: what
   memory learned per batch" (DAWN main, df8e7caf). The shapes are DAWN's wire format. What the
   fake leaves out: stale undos (nothing else changes memory here), the 256-op batch cap, the
   one-undo-or-keep-at-a-time rule, and the per-conversation marker form beyond filtering. Times
   are relative to now, so the seeded batches always read as recent. */

type Op = {
   op_id: number;
   op: string;
   status: string;
   outside: boolean;
   outside_from: string | null;
   fact_id: number | null;
   relation_id: null;
   entity_id: null;
   text: string | null;
   target_fact_id: number | null;
   target_entity_id: null;
   target_text: string | null;
   target_status?: string;
   sources?: Array<{ fact_id: number; text: string }>;
   reason?: string;
   reason_by?: "model" | "dawn";
   action: "undo" | "keep" | "forget" | null;
};

type Batch = {
   batch_id: number;
   conversation_id: number | null;
   from_message_id: number;
   after_message_id: number;
   created_at: number;
   path: string;
   status: string;
   outside: boolean;
   outside_from: string | null;
   counts: Record<string, number>;
   ops: Op[];
};

const KINDS = [
   "added",
   "reinforced",
   "merged",
   "replaced",
   "closed",
   "linked",
   "proposed",
   "pref_set",
   "dropped",
   "deferred",
   "suggested_forget",
   "refused"
];

function op(op_id: number, kind: string, text: string, over: Partial<Op> = {}): Op {
   return {
      op_id,
      op: kind,
      status: "applied",
      outside: false,
      outside_from: null,
      fact_id: null,
      relation_id: null,
      entity_id: null,
      text,
      target_fact_id: null,
      target_entity_id: null,
      target_text: null,
      action: null,
      ...over
   };
}

/* A batch's counts from its ops, as DAWN keeps them (a set-aside candidate counts as deferred). */
function countsOf(ops: Op[]): Record<string, number> {
   const counts: Record<string, number> = Object.fromEntries(KINDS.map((k) => [k, 0]));
   for (const o of ops) counts[o.op] = (counts[o.op] ?? 0) + 1;
   return counts;
}

/* applied, partial (some undone, some not), undone (every op that can be undone was). */
function statusOf(ops: Op[]): string {
   const undone = ops.filter((o) => o.status === "undone").length;
   const undoable = ops.filter((o) => o.action === "undo").length;
   if (undone === 0) return "applied";
   return undoable === 0 ? "undone" : "partial";
}

export class MemoryBatchStore {
   private readonly batches: Batch[];
   private nextOp = 9100;
   private nextFact = 5100;

   /* A conversation's title now, or null when it's gone (DAWN looks it up when it builds the
      frame). */
   private readonly titleOf: (conversationId: number) => string | null;

   constructor(conversationId: number, titleOf: (conversationId: number) => string | null) {
      this.titleOf = titleOf;
      const now = Math.floor(Date.now() / 1000);
      const batch = (
         batch_id: number,
         agoSec: number,
         ops: Op[],
         over: Partial<Batch> = {}
      ): Batch => ({
         batch_id,
         conversation_id: conversationId,
         from_message_id: 1,
         after_message_id: 2, // the seeded conversation's reply (conversations.ts)
         created_at: now - agoSec,
         path: "agent",
         status: statusOf(ops),
         outside: false,
         outside_from: null,
         counts: countsOf(ops),
         ops,
         ...over
      });
      this.batches = [
         batch(3, 2 * 3600, [
            op(9001, "added", "Prefers tea over coffee in the morning", {
               fact_id: 5001,
               action: "undo",
               sources: [{ fact_id: 5002, text: "Likes tea" }]
            }),
            op(9002, "added", "Is building an ambient interface for a home assistant", {
               fact_id: 5003,
               action: "undo"
            }),
            op(9003, "merged", "Likes tea", {
               fact_id: 5002,
               target_fact_id: 5001,
               target_text: "Prefers tea over coffee in the morning",
               target_status: "current",
               reason: "The same preference, said two ways",
               reason_by: "model",
               action: "undo"
            }),
            op(9004, "dropped", "Said the weather was nice today", {
               reason: "Small talk, not worth keeping",
               reason_by: "model",
               action: "keep"
            })
         ]),
         batch(
            2,
            26 * 3600,
            [
               op(9010, "added", "Has a dentist appointment on the 20th", {
                  fact_id: 5010,
                  outside: true,
                  outside_from: "email",
                  action: "undo"
               }),
               op(9011, "suggested_forget", "Works night shifts", {
                  fact_id: 5011,
                  reason: "Contradicted by a newer fact about working days",
                  reason_by: "model",
                  action: "forget"
               })
            ],
            { outside: true, outside_from: "email" }
         ),
         batch(1, 4 * 86400, [
            op(9020, "pref_set", "units: metric", { status: "undone", action: null })
         ])
      ];
   }

   /* A batch as DAWN sends it: a copy, with its conversation's title as of now. */
   private wire(batch: Batch): object {
      const title = batch.conversation_id === null ? null : this.titleOf(batch.conversation_id);
      return { ...structuredClone(batch), conversation_title: title };
   }

   private frame(batch: Batch): object {
      return { type: "memory_batch", payload: this.wire(batch) };
   }

   /* list_memory_batches: newest first, a keyset page from before_batch_id. */
   list(payload: Record<string, unknown>): object {
      const conversation =
         typeof payload.conversation_id === "number" ? payload.conversation_id : undefined;
      const before = typeof payload.before_batch_id === "number" ? payload.before_batch_id : null;
      const asked = typeof payload.limit === "number" ? payload.limit : 20;
      const limit = Math.min(Math.max(1, Math.floor(asked)), 50);
      const matching = this.batches
         .filter((b) => conversation === undefined || b.conversation_id === conversation)
         .filter((b) => before === null || b.batch_id < before)
         .sort((a, b) => b.batch_id - a.batch_id);
      const page = matching.slice(0, limit);
      const hasMore = matching.length > limit;
      return {
         type: "list_memory_batches_response",
         payload: {
            ...(conversation !== undefined ? { conversation_id: conversation } : {}),
            before_batch_id: before,
            limit,
            batches: page.map((b) => this.wire(b)),
            has_more: hasMore,
            ...(hasMore ? { next_before_batch_id: page[page.length - 1].batch_id } : {}),
            error: null
         }
      };
   }

   /* undo_memory_batch: one op, or every op that can be undone. The changed batch, then the
      reply (DAWN pushes before it replies). */
   undo(payload: Record<string, unknown>): { pushed: object[]; reply: object } {
      const batchId = payload.batch_id;
      const opId = payload.op_id;
      const batch = this.batches.find((b) => b.batch_id === batchId);
      const notFound = {
         pushed: [],
         reply: undoReply(batchId, opId, "error", [], "Not found")
      };
      if (!batch || (opId !== undefined && typeof opId !== "number")) return notFound;
      const targets =
         opId === undefined
            ? batch.ops.filter((o) => o.action === "undo")
            : batch.ops.filter((o) => o.op_id === opId);
      if (opId !== undefined && targets.length === 0) return notFound;
      const undone: number[] = [];
      for (const o of targets) {
         if (o.action !== "undo") continue;
         o.status = "undone";
         o.action = null;
         undone.push(o.op_id);
      }
      batch.status = statusOf(batch.ops);
      return {
         pushed: undone.length > 0 ? [this.frame(batch)] : [],
         reply: undoReply(batchId, opId, "ok", undone, null)
      };
   }

   /* keep_memory_op: the candidate becomes kept and a new added op joins the batch. */
   keep(payload: Record<string, unknown>): { pushed: object[]; reply: object } {
      const batch = this.batches.find((b) => b.batch_id === payload.batch_id);
      const candidate = batch?.ops.find((o) => o.op_id === payload.op_id);
      if (!batch || !candidate) {
         return { pushed: [], reply: keepReply(payload, "error", null, "Not found") };
      }
      if (candidate.action !== "keep") {
         return { pushed: [], reply: keepReply(payload, "error", null, "This one can't be kept.") };
      }
      const factId = this.nextFact++;
      candidate.status = "kept";
      candidate.action = null;
      candidate.fact_id = factId;
      batch.ops.push(
         op(this.nextOp++, "added", candidate.text ?? "", {
            fact_id: factId,
            outside: candidate.outside,
            outside_from: candidate.outside_from,
            action: "undo"
         })
      );
      batch.counts = countsOf(batch.ops);
      batch.status = statusOf(batch.ops);
      return { pushed: [this.frame(batch)], reply: keepReply(payload, "ok", factId, null) };
   }

   /* delete_memory_fact: every op naming the fact leaves its batch (forgetting removes them). */
   forget(payload: Record<string, unknown>): { pushed: object[]; reply: object } {
      const factId = payload.fact_id;
      const pushed: object[] = [];
      for (const b of this.batches) {
         const before = b.ops.length;
         b.ops = b.ops.filter((o) => o.fact_id !== factId && o.target_fact_id !== factId);
         if (b.ops.length !== before) {
            b.counts = countsOf(b.ops);
            b.status = statusOf(b.ops);
            pushed.push(this.frame(b));
         }
      }
      return {
         pushed,
         reply: {
            type: "delete_memory_fact_response",
            payload: {
               fact_id: typeof factId === "number" ? factId : 0,
               success: true,
               message: "Fact deleted"
            }
         }
      };
   }
}

function undoReply(
   batchId: unknown,
   opId: unknown,
   status: string,
   undone: number[],
   error: string | null
): object {
   return {
      type: "undo_memory_batch_response",
      payload: {
         batch_id: typeof batchId === "number" ? batchId : 0,
         ...(typeof opId === "number" ? { op_id: opId } : {}),
         status,
         undone,
         stale: [],
         error
      }
   };
}

function keepReply(
   payload: Record<string, unknown>,
   status: string,
   factId: number | null,
   error: string | null
): object {
   return {
      type: "keep_memory_op_response",
      payload: {
         batch_id: typeof payload.batch_id === "number" ? payload.batch_id : 0,
         op_id: typeof payload.op_id === "number" ? payload.op_id : 0,
         status,
         fact_id: factId,
         error
      }
   };
}
