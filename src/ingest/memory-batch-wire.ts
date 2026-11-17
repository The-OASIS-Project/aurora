/*
 * Reading DAWN's memory batch frames (memory_batches; DAWN's WEBSOCKET_PROTOCOL.md, "Consolidation:
 * what memory learned per batch"): the batch object a memory_batch push carries, and a
 * list_memory_batches_response page. Every field is checked: a batch with no usable id is dropped,
 * an op with none is skipped, and anything else missing reads as absent. Enum strings pass
 * through as they are (a view renders a kind it doesn't know generically).
 */

import type { MemoryBatch, MemoryBatchOp, MemoryBatchPage } from "./ingest.ts";

/* A DAWN row id: a positive integer, else null. */
export function rowId(value: unknown): number | null {
   return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/* A short enum-ish string (a kind, a status): a non-empty string, else null. */
const word = (value: unknown): string | null =>
   typeof value === "string" && value !== "" ? value : null;

const ACTIONS = new Set(["undo", "keep", "forget"]);

function parseOp(raw: unknown): MemoryBatchOp | null {
   if (!raw || typeof raw !== "object") return null;
   const o = raw as Record<string, unknown>;
   const opId = rowId(o.op_id);
   const op = word(o.op);
   if (opId === null || op === null) return null;
   const sources = Array.isArray(o.sources)
      ? o.sources
           .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
           .map((s) => ({ factId: rowId(s.fact_id), text: text(s.text) }))
      : [];
   const action = typeof o.action === "string" && ACTIONS.has(o.action) ? o.action : null;
   return {
      opId,
      op,
      status: word(o.status) ?? "applied",
      outside: o.outside === true,
      outsideFrom: o.outside === true ? word(o.outside_from) : null,
      factId: rowId(o.fact_id),
      text: text(o.text),
      targetText: text(o.target_text),
      targetStatus: word(o.target_status),
      sources,
      reason: text(o.reason) || null,
      reasonBy: o.reason_by === "model" || o.reason_by === "dawn" ? o.reason_by : null,
      action: action as MemoryBatchOp["action"]
   };
}

/* A batch object, or null when it has no usable id. A removed batch ({batch_id, removed}) is
   read by the caller before this. */
export function parseMemoryBatch(raw: unknown): MemoryBatch | null {
   if (!raw || typeof raw !== "object") return null;
   const b = raw as Record<string, unknown>;
   const batchId = rowId(b.batch_id);
   if (batchId === null) return null;
   const counts: Record<string, number> = {};
   if (b.counts && typeof b.counts === "object") {
      for (const [k, v] of Object.entries(b.counts as Record<string, unknown>)) {
         if (typeof v === "number" && Number.isFinite(v) && v > 0) counts[k] = Math.floor(v);
      }
   }
   const ops = Array.isArray(b.ops)
      ? b.ops.map(parseOp).filter((op): op is MemoryBatchOp => op !== null)
      : [];
   const created = b.created_at;
   return {
      batchId,
      conversationId: rowId(b.conversation_id),
      ...("conversation_title" in b ? { conversationTitle: text(b.conversation_title) } : {}),
      afterMessageId: rowId(b.after_message_id) ?? 0,
      createdAt:
         typeof created === "number" && Number.isFinite(created) && created > 0 ? created : 0,
      status: word(b.status) ?? "applied",
      outside: b.outside === true,
      outsideFrom: b.outside === true ? word(b.outside_from) : null,
      counts,
      ops
   };
}

/* A list_memory_batches_response for the Learned list (the form without conversation_id). */
export function parseMemoryBatchPage(p: Record<string, unknown>): MemoryBatchPage {
   const error = typeof p.error === "string" && p.error !== "" ? p.error : null;
   const batches = Array.isArray(p.batches)
      ? p.batches.map(parseMemoryBatch).filter((b): b is MemoryBatch => b !== null)
      : [];
   return {
      before: rowId(p.before_batch_id),
      batches: error ? [] : batches,
      nextBefore: !error && p.has_more === true ? rowId(p.next_before_batch_id) : null,
      error
   };
}
