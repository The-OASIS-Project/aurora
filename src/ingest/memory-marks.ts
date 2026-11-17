/*
 * What memory learned from the conversation on screen (memory_batches), for the marks drawn in
 * it: the conversation's batches, read with list_memory_batches {conversation_id} when it opens
 * (a few pages, newest first), then kept current from memory_batch pushes. DAWN's WebUI does the
 * same (www/js/ui/memory-marker.js). Kept out of dawn-ws.ts: DawnIngest feeds it the frames and
 * gives it a way to ask; it hands the conversation view the marks.
 */

import type { MemoryBatch, MemoryMark } from "./ingest.ts";

/* A conversation's batches are read this many pages deep (each up to DAWN's 20). */
export const MARK_PAGES_MAX = 5;

/* A page of one conversation's batches, as DawnIngest reads it. `request` is the id the ask
   returned, when DAWN named it (request_refs); without it, replies come in the order asked. */
export interface MarkPage {
   conversationId: number;
   before: number | null;
   batches: MemoryBatch[];
   nextBefore: number | null;
   error: string | null;
   request?: number;
}

export class MemoryMarks {
   /* The conversation on screen (0: none yet). */
   private conv = 0;
   private readonly marks = new Map<number, MemoryMark>();
   /* Each show() starts a reading of the conversation (a generation); a page asked for an older
      one (a conversation left, or read again on a reconnect) is answered, but changes nothing
      and asks no further page, so two readings never run side by side. */
   private gen = 0;
   /* Pages asked for and not answered yet, oldest first (DAWN answers in order). */
   private asked: Array<{ id: number; gen: number }> = [];
   /* Pages asked for in this reading. */
   private pages = 0;
   /* Pushes that came while a page of this reading was asked for: applied over it (newer).
      null = removed. */
   private readonly pushed = new Map<number, MemoryBatch | null>();

   private readonly ask: (conversationId: number, before: number | null) => number;
   private readonly out: (marks: MemoryMark[]) => void;

   /* `ask` sends list_memory_batches for a conversation and returns the request's id (0: not
      sent); `out` draws the marks. */
   constructor(
      ask: (conversationId: number, before: number | null) => number,
      out: (marks: MemoryMark[]) => void
   ) {
      this.ask = ask;
      this.out = out;
   }

   /* A conversation is on screen: its batches are read. The same one again (a reload, a
      re-anchor, a reconnect) keeps the marks it has and reads them fresh. */
   show(conversationId: number): void {
      if (conversationId !== this.conv) {
         this.conv = conversationId;
         this.marks.clear();
      }
      /* What waited for the previous reading's pages: still newer than anything it read. */
      this.applyPushed();
      this.gen++;
      this.pages = 0;
      this.emit();
      if (this.conv > 0) this.request(null);
   }

   /* After a reconnect: what changed meanwhile. */
   refresh(): void {
      this.show(this.conv);
   }

   page(p: MarkPage): void {
      const at = p.request !== undefined ? this.asked.findIndex((a) => a.id === p.request) : 0;
      if (at < 0 || this.asked.length === 0) return; // nothing asked for it
      const [mine] = this.asked.splice(at, 1);
      if (mine.gen !== this.gen || p.conversationId !== this.conv) return; // an older reading's
      if (!p.error) this.merge(p);
      if (!this.waiting()) this.applyPushed();
      this.emit();
      if (!p.error && p.nextBefore !== null && this.pages < MARK_PAGES_MAX) {
         this.request(p.nextBefore);
      }
   }

   /* A page DAWN refused (request_refs): it ends like an error page. */
   failed(request: number): void {
      this.page({
         conversationId: this.conv,
         before: null,
         batches: [],
         nextBefore: null,
         error: "refused",
         request
      });
   }

   /* A batch recorded or changed. */
   push(batch: MemoryBatch): void {
      if (batch.conversationId !== this.conv || this.conv === 0) return;
      if (this.waiting()) {
         this.pushed.set(batch.batchId, batch);
         return;
      }
      this.mark(batch);
      this.emit();
   }

   /* A batch a forget removed. */
   remove(batchId: number): void {
      if (this.waiting()) this.pushed.set(batchId, null);
      if (!this.marks.delete(batchId)) return;
      this.emit();
   }

   /* The socket dropped: no page asked for will come, so what it held goes now. */
   linkDown(): void {
      this.asked = [];
      this.applyPushed();
      this.emit();
   }

   /* A page of this reading is on its way. */
   private waiting(): boolean {
      return this.asked.some((a) => a.gen === this.gen);
   }

   private request(before: number | null): void {
      const id = this.ask(this.conv, before);
      if (!id) return;
      this.pages++;
      this.asked.push({ id, gen: this.gen });
   }

   /* A page into the marks: one in its range it no longer holds is gone (forgotten while
      away); a push since is newer than the page. */
   private merge(p: MarkPage): void {
      const ids = new Set(p.batches.map((b) => b.batchId));
      for (const [id, b] of this.pushed) if (b) ids.add(id);
      const sorted = p.batches.map((b) => b.batchId).sort((a, b) => a - b);
      const low = p.nextBefore !== null && sorted.length > 0 ? sorted[0] : -Infinity;
      const high = p.before ?? Infinity;
      for (const id of [...this.marks.keys()]) {
         if (id >= low && id < high && !ids.has(id)) this.marks.delete(id);
      }
      for (const b of p.batches) {
         if (!this.pushed.has(b.batchId)) this.marks.set(b.batchId, { batch: b, live: false });
      }
   }

   /* A pushed batch: new ones are live (their reply may not have its id yet); an update keeps
      the mark's placement as it was. */
   private mark(batch: MemoryBatch): void {
      const had = this.marks.get(batch.batchId);
      this.marks.set(batch.batchId, { batch, live: had ? had.live : true });
   }

   private applyPushed(): void {
      for (const [id, b] of this.pushed) {
         if (!b) this.marks.delete(id);
         else if (b.conversationId === this.conv) this.mark(b);
      }
      this.pushed.clear();
   }

   private emit(): void {
      this.out([...this.marks.values()].sort((a, b) => a.batch.batchId - b.batch.batchId));
   }
}
