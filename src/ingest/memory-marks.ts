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

/* A page of one conversation's batches, as DawnIngest reads it. */
export interface MarkPage {
   conversationId: number;
   before: number | null;
   batches: MemoryBatch[];
   nextBefore: number | null;
   error: string | null;
}

export class MemoryMarks {
   /* The conversation on screen (0: none yet). */
   private conv = 0;
   private readonly marks = new Map<number, MemoryMark>();
   /* Pages asked for whose reply hasn't come (any conversation's: each reply ends one). */
   private asking = 0;
   /* Pages asked for since the conversation opened. */
   private pages = 0;
   /* Pushes that came while a page was asked for: applied over it (newer). null = removed. */
   private readonly pushed = new Map<number, MemoryBatch | null>();

   private readonly ask: (conversationId: number, before: number | null) => boolean;
   private readonly out: (marks: MemoryMark[]) => void;

   /* `ask` sends list_memory_batches for a conversation (false: not sent); `out` draws the marks. */
   constructor(
      ask: (conversationId: number, before: number | null) => boolean,
      out: (marks: MemoryMark[]) => void
   ) {
      this.ask = ask;
      this.out = out;
   }

   /* A conversation is on screen: its batches are read. The same one again (a reload, a
      re-anchor) keeps the marks it has and reads them fresh. */
   show(conversationId: number): void {
      if (conversationId !== this.conv) {
         this.conv = conversationId;
         this.marks.clear();
         this.pushed.clear();
      }
      this.emit();
      this.pages = 0;
      if (this.conv > 0) this.request(null);
   }

   /* After a reconnect: what changed meanwhile. */
   refresh(): void {
      this.show(this.conv);
   }

   page(p: MarkPage): void {
      this.asking = Math.max(0, this.asking - 1);
      if (p.conversationId !== this.conv) {
         /* Another conversation's (left meanwhile): held pushes wait for this one's own page. */
         if (this.asking === 0) this.applyPushed();
         return;
      }
      if (p.error) {
         this.applyPushed();
         this.emit();
         return;
      }
      /* A mark in the page's range that the page doesn't hold is gone (forgotten while away);
         a push since is newer than the page. */
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
      this.applyPushed();
      this.emit();
      if (p.nextBefore !== null && this.pages < MARK_PAGES_MAX) this.request(p.nextBefore);
   }

   /* A page DAWN refused (request_refs): it ends like an error page. */
   failed(conversationId: number): void {
      this.page({ conversationId, before: null, batches: [], nextBefore: null, error: "refused" });
   }

   /* A batch recorded or changed. */
   push(batch: MemoryBatch): void {
      if (batch.conversationId !== this.conv || this.conv === 0) return;
      if (this.asking > 0) {
         this.pushed.set(batch.batchId, batch);
         return;
      }
      this.mark(batch);
      this.emit();
   }

   /* A batch a forget removed. */
   remove(batchId: number): void {
      if (this.asking > 0) this.pushed.set(batchId, null);
      if (!this.marks.delete(batchId)) return;
      this.emit();
   }

   /* The socket dropped: a page asked for won't come, so what it held goes now. */
   linkDown(): void {
      this.asking = 0;
      this.applyPushed();
      this.emit();
   }

   private request(before: number | null): void {
      if (!this.ask(this.conv, before)) return;
      this.pages++;
      this.asking++;
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
