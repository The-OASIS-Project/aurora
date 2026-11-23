/* The Learned list (what memory learned per batch, DAWN's memory_batches), the marks those
   batches draw in the conversation on screen, and the Context panel's memory deletes: their
   requests, the replies and refusals that settle them, and the pushes that change a batch. */

import type { IngestSinks } from "./ingest.ts";
import { parseMemoryBatch, parseMemoryBatchPage, rowId } from "./memory-batch-wire.ts";
import { MemoryMarks } from "./memory-marks.ts";

/* A Learned-list request still owed a reply (see MemoryFeed.memoryReqs). */
type MemoryReq =
   | { kind: "list"; id: number; before: number | null }
   | { kind: "undo"; batchId: number; opId: number | null }
   | { kind: "keep"; batchId: number; opId: number }
   | { kind: "forget"; factId: number }
   | { kind: "marks"; id: number; conversationId: number };

/* A Learned-list page (DAWN allows up to 50). */
const MEMORY_BATCH_PAGE = 20;

/* Context-panel memory delete: item_id prefix -> the user-scoped delete verb + its id field
   (verified in dawn/src/webui/webui_memory.c + memory_focus_adapters.c). Only these prefixes
   have an id-based delete; relation/document_chunk/calendar_occ and preferences do not. Paired
   with the Context panel's DELETABLE_PREFIXES (the display gate) - keep the kinds in sync. */
const MEMORY_DELETE_VERBS: Record<string, { type: string; field: string }> = {
   fact: { type: "delete_memory_fact", field: "fact_id" },
   entity: { type: "delete_memory_entity", field: "entity_id" },
   summary: { type: "delete_memory_summary", field: "summary_id" }
};

/* The views it drives. */
type Sinks = Pick<IngestSinks, "memoryBatches" | "conversation">;

type SpikeNotice = (
   id: string,
   kind: string,
   summary: string,
   opts: { tone?: "nominal" | "attention"; hold?: number }
) => void;

export class MemoryFeed {
   /* Facts a Learned-list Forget was sent for: their delete_memory_fact_response is the panel's. */
   private pendingFactForgets = new Set<number>();
   /* The Learned list's requests still owed a reply, by the `req` they carry (request_refs): an
      error naming one (SERVICE_UNAVAILABLE when DAWN can't check the login, say) is its only
      answer, and settles it as failed. */
   private memoryReqs = new Map<string, MemoryReq>();
   private memoryReqSeq = 0;
   /* What memory learned from the conversation on screen, drawn as marks in it. */
   private marks = new MemoryMarks(
      (conversationId, before) => this.listConversationBatches(conversationId, before),
      (m) => this.sinks.conversation.setMemoryMarks(m)
   );

   constructor(
      private readonly send: (msg: object) => boolean,
      private readonly hasFeature: (flag: string) => boolean,
      private readonly getSinks: () => Sinks,
      private readonly spikeNotice: SpikeNotice
   ) {}

   private get sinks(): Sinks {
      return this.getSinks();
   }

   /* The socket opened, or closed: no reply to an older request will come. */
   linkDown(): void {
      this.pendingFactForgets.clear();
      this.memoryReqs.clear();
      this.sinks.memoryBatches.linkDown();
      this.marks.linkDown();
   }

   /* The config frame: whether this DAWN records batches. */
   configured(): void {
      this.sinks.memoryBatches.setAvailable(this.hasFeature("memory_batches"));
      if (this.hasFeature("memory_batches")) {
         this.sinks.memoryBatches.linkUp();
         this.marks.refresh();
      }
   }

   /* The conversation on screen changed. */
   show(id: number): void {
      this.marks.show(id);
   }

   /* The memory frames (the core lists them in its switch). */
   onFrame(type: string, p: Record<string, unknown>): void {
      switch (type) {
         case "delete_memory_fact_response":
         case "delete_memory_entity_response":
         case "delete_memory_summary_response": {
            /* A Forget from the Learned list (the reply names its fact): the panel's own. */
            const forgotId = type === "delete_memory_fact_response" ? rowId(p.fact_id) : null;
            if (forgotId !== null && this.pendingFactForgets.delete(forgotId)) {
               this.memoryReplied(p, (r) => r.kind === "forget" && r.factId === forgotId);
               this.onMemoryForgotten(forgotId, p);
               break;
            }
            /* The Context panel confirm-gated + optimistically removed the row. On success
               there is nothing to do; a genuine failure surfaces a notice. "Not found" means
               it was already gone (a re-click, or deleted elsewhere), so treat it as success -
               the optimistic removal was correct. No id echo in the response, so nothing to
               reconcile per-row. */
            if ((p as { success?: boolean }).success === false) {
               const err = String((p as { error?: string }).error ?? "");
               if (!/not found/i.test(err)) {
                  this.spikeNotice(
                     "memory-delete",
                     "attention",
                     err || "Couldn't delete that memory",
                     {
                        hold: 5,
                        tone: "attention"
                     }
                  );
               }
            }
            break;
         }

         case "list_memory_batches_response": {
            const asked = this.memoryReplied(p);
            /* The per-conversation form (conversation_id echoed) is the marks'; the other is the
               Learned list's page. */
            if (p.conversation_id != null) {
               this.marks.page({
                  conversationId: rowId(p.conversation_id) ?? 0,
                  ...parseMemoryBatchPage(p),
                  ...(asked?.kind === "marks" ? { request: asked.id } : {})
               });
               break;
            }
            const page = parseMemoryBatchPage(p);
            if (asked?.kind === "list") page.request = asked.id;
            this.sinks.memoryBatches.setPage(page);
            break;
         }

         case "memory_batch": {
            /* Recorded, changed by an undo / keep / forgotten fact, or removed by a forget. */
            const removedId = p.removed === true ? rowId(p.batch_id) : null;
            if (removedId !== null) {
               this.sinks.memoryBatches.removeBatch(removedId);
               this.marks.remove(removedId);
               break;
            }
            const batch = parseMemoryBatch(p);
            if (batch) {
               this.sinks.memoryBatches.upsertBatch(batch);
               this.marks.push(batch);
            }
            break;
         }

         case "undo_memory_batch_response":
            this.onMemoryUndone(p);
            break;

         case "keep_memory_op_response":
            this.onMemoryKept(p);
            break;
      }
   }

   /* --- The Learned list (memory_batches). The writes come only from the panel's buttons (Undo
      all and Forget behind their named confirms there). Undo and Keep run on a DAWN worker and
      answer when it ends; DAWN pushes the changed batch first, so the list redraws from that
      and the reply only says how it went. */
   listMemoryBatches(before?: number): number {
      if (!this.hasFeature("memory_batches")) return 0;
      const payload: Record<string, number> = { limit: MEMORY_BATCH_PAGE };
      if (before !== undefined && before > 0) payload.before_batch_id = before;
      const id = this.memoryReqSeq + 1; // the id sendMemory gives it
      const sent = this.sendMemory("list_memory_batches", payload, {
         kind: "list",
         id,
         before: payload.before_batch_id ?? null
      });
      return sent ? id : 0;
   }

   /* A page of one conversation's batches, for the marks drawn in it (memory-marks.ts). */
   private listConversationBatches(conversationId: number, before: number | null): number {
      if (!this.hasFeature("memory_batches") || conversationId <= 0) return 0;
      const payload: Record<string, number> = {
         conversation_id: conversationId,
         limit: MEMORY_BATCH_PAGE
      };
      if (before !== null && before > 0) payload.before_batch_id = before;
      const id = this.memoryReqSeq + 1; // the id sendMemory gives it
      const sent = this.sendMemory("list_memory_batches", payload, {
         kind: "marks",
         id,
         conversationId
      });
      return sent ? id : 0;
   }

   undoMemoryBatch(batchId: number, opId: number | null): boolean {
      if (!this.hasFeature("memory_batches") || batchId <= 0) return false;
      const payload: Record<string, number> = { batch_id: batchId };
      if (opId !== null && opId > 0) payload.op_id = opId;
      return this.sendMemory("undo_memory_batch", payload, {
         kind: "undo",
         batchId,
         opId: payload.op_id ?? null
      });
   }

   keepMemoryOp(batchId: number, opId: number): boolean {
      if (!this.hasFeature("memory_batches") || batchId <= 0 || opId <= 0) return false;
      return this.sendMemory(
         "keep_memory_op",
         { batch_id: batchId, op_id: opId },
         { kind: "keep", batchId, opId }
      );
   }

   /* The forget DAWN suggested (an op's action "forget"): the ordinary delete_memory_fact, which
      records the forget and pushes the batch without that row. */
   forgetMemoryFact(factId: number): boolean {
      if (!this.hasFeature("memory_batches") || factId <= 0) return false;
      if (!this.sendMemory("delete_memory_fact", { fact_id: factId }, { kind: "forget", factId }))
         return false;
      this.pendingFactForgets.add(factId);
      return true;
   }

   /* A Learned-list request, tagged with a `req` when DAWN echoes it (request_refs). */
   private sendMemory(type: string, payload: Record<string, number>, pending: MemoryReq): boolean {
      const id = ++this.memoryReqSeq;
      const req = this.hasFeature("request_refs") ? `mem-${id}` : "";
      if (!this.send({ type, payload: req ? { ...payload, req } : payload })) return false;
      if (req) this.memoryReqs.set(req, pending);
      return true;
   }

   /* A reply settles its request: the one it names (request_refs), else, for a reply DAWN's
      worker sends (Undo, Keep and Forget, which don't echo `req`), the oldest one it matches. */
   private memoryReplied(
      p: Record<string, unknown>,
      matches?: (pending: MemoryReq) => boolean
   ): MemoryReq | undefined {
      const named = typeof p.req === "string" ? this.memoryReqs.get(p.req) : undefined;
      if (named) {
         this.memoryReqs.delete(p.req as string);
         return named;
      }
      if (!matches) return undefined;
      for (const [req, pending] of this.memoryReqs) {
         if (!matches(pending)) continue;
         this.memoryReqs.delete(req);
         return pending;
      }
      return undefined;
   }

   /* An error naming a Learned-list request (request_refs): DAWN refused it, and no reply will
      come. Settle it as failed, so the list stops loading and the buttons come back; nothing is
      sent again (the user retries). Whether it was one. */
   settleMemoryRefusal(p: Record<string, unknown>): boolean {
      const pending = typeof p.req === "string" ? this.memoryReqs.get(p.req) : undefined;
      if (!pending || p.severity === "info") return false;
      this.memoryReqs.delete(p.req as string);
      const message =
         typeof p.message === "string" && p.message
            ? p.message
            : "DAWN couldn't do this right now. Try again in a moment.";
      if (pending.kind === "marks") {
         this.marks.failed(pending.id);
         return true;
      }
      if (pending.kind === "list") {
         this.sinks.memoryBatches.setPage({
            before: pending.before,
            batches: [],
            nextBefore: null,
            error: message,
            request: pending.id
         });
         return true;
      }
      this.memoryNotice(message, true);
      if (pending.kind === "forget") {
         this.pendingFactForgets.delete(pending.factId);
         this.sinks.memoryBatches.actionDone({ kind: "forget", factId: pending.factId, ok: false });
      } else if (pending.kind === "keep") {
         this.sinks.memoryBatches.actionDone({
            kind: "keep",
            batchId: pending.batchId,
            opId: pending.opId,
            ok: false,
            factId: null
         });
      } else {
         this.sinks.memoryBatches.actionDone({
            kind: "undo",
            batchId: pending.batchId,
            opId: pending.opId,
            ok: false
         });
      }
      return true;
   }

   private onMemoryUndone(p: Record<string, unknown>): void {
      /* One with no usable batch id still ends the undo that was running (the panel's slot). */
      const batchId = rowId(p.batch_id) ?? 0;
      const opId = rowId(p.op_id);
      /* DAWN runs one per user at a time, so a reply without usable ids is the one running. */
      this.memoryReplied(
         p,
         (r) => r.kind === "undo" && (batchId === 0 || (r.batchId === batchId && r.opId === opId))
      );
      const undone = Array.isArray(p.undone) ? p.undone.length : 0;
      const stale = Array.isArray(p.stale) ? p.stale.length : 0;
      const error = typeof p.error === "string" && p.error ? p.error : "";
      /* Done: the pushed batch already shows it. Anything else is said once, calmly. */
      if (p.status === "ok") {
         if (undone === 0) this.memoryNotice("Nothing left to undo", false);
      } else if (p.status === "partial") {
         const them =
            stale === 1
               ? "1 item changed since and stayed as it is"
               : `${stale} items changed since and stayed as they are`;
         this.memoryNotice(`Undid ${undone}; ${them}.`, false);
      } else if (p.status === "stale") {
         this.memoryNotice(error || "This memory changed since; nothing was undone.", false);
      } else {
         this.memoryNotice(error || "Couldn't undo this.", true);
      }
      this.sinks.memoryBatches.actionDone({
         kind: "undo",
         batchId,
         opId,
         ok: p.status === "ok"
      });
   }

   private onMemoryKept(p: Record<string, unknown>): void {
      /* One with no usable ids still ends the keep that was running (the panel's slot). */
      const batchId = rowId(p.batch_id) ?? 0;
      const opId = rowId(p.op_id) ?? 0;
      this.memoryReplied(
         p,
         (r) =>
            r.kind === "keep" &&
            (batchId === 0 || opId === 0 || (r.batchId === batchId && r.opId === opId))
      );
      const ok = p.status === "ok" && batchId > 0 && opId > 0;
      if (p.status !== "ok") {
         const error = typeof p.error === "string" && p.error ? p.error : "";
         this.memoryNotice(error || "Couldn't keep this.", true);
      }
      this.sinks.memoryBatches.actionDone({
         kind: "keep",
         batchId,
         opId,
         ok,
         factId: ok ? rowId(p.fact_id) : null
      });
   }

   private onMemoryForgotten(factId: number, p: Record<string, unknown>): void {
      /* "Not found": already gone (forgotten elsewhere), which is what was asked. */
      const error = typeof p.error === "string" ? p.error : "";
      const ok = p.success !== false || /not found/i.test(error);
      if (!ok) this.memoryNotice(error || "Couldn't forget that memory", true);
      this.sinks.memoryBatches.actionDone({ kind: "forget", factId, ok });
   }

   private memoryNotice(text: string, failed: boolean): void {
      this.spikeNotice("memory-batch", failed ? "attention" : "memory", text, {
         hold: failed ? 6 : 5,
         ...(failed ? { tone: "attention" as const } : {})
      });
   }

   /* Delete one of the user's own memories from the Context panel. Maps the row's item_id
      prefix to the matching user-scoped delete verb (auth-only, user-scoped server-side). The
      panel already confirm-gated this and removed the row optimistically; a server failure is
      surfaced as a notice from the *_response handler. Non-memory prefixes are ignored. */
   deleteMemory(itemId: string): void {
      const colon = itemId.indexOf(":");
      if (colon <= 0) return;
      const kind = itemId.slice(0, colon);
      const idStr = itemId.slice(colon + 1);
      /* Canonical positive-integer id only (rejects "", "abc", "0", "1e3", "0x10", " 5 "), so a
         malformed/non-canonical item_id never sends a wrong or rounded delete key. Mirrors the
         panel's isDeletable, so "show control" and "can delete" agree on every input. */
      if (!/^[1-9]\d*$/.test(idStr)) return;
      const verb = MEMORY_DELETE_VERBS[kind];
      if (!verb) return;
      this.send({ type: verb.type, payload: { [verb.field]: Number(idStr) } });
   }
}
