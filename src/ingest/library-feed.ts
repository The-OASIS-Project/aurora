/* The Library panel's feed: the notes and documents list (list, search, load more), a document's
   original over HTTP, its full text over the WS, and the reader's edit saves, each read or save
   settled by its own reply or a timeout. */

import type { IngestSinks } from "./ingest.ts";
import { toLibraryItem } from "./feeds-wire.ts";
import { str } from "./wire.ts";

const LIB_PAGE = 50; // library-panel page size (doc_library_list limit)

/* The view it drives. */
type Sinks = Pick<IngestSinks, "library">;

export class LibraryFeed {
   /* doc_library_list_response is one type for list / search / load-more, so remember
      what the in-flight request was to label the response for the library panel. */
   private pendingLibraryAppend = false;
   private pendingLibrarySearching = false;
   /* In-flight doc_library_get requests, keyed by document id, so an async full-text
      read (the reader overlay) resolves against its own response (or null on error). The
      timeout handle is stored so it can be cleared on response/supersede/dispose (no
      dangling timer firing into a resolved promise or a torn-down instance). */
   private readonly pendingDocGets = new Map<
      number,
      {
         resolve: (v: { text: string; filename: string; filetype: string } | null) => void;
         timer: number;
      }
   >();
   /* A single in-flight doc/note EDIT save (doc_library_note_update / _doc_update). Only one
      edit is ever open (single-instance reader + Save disabled while saving), so one slot
      resolved by whichever *_update_response arrives is enough - and it sidesteps note_update
      omitting the id on its error branches (id correlation would miss those). */
   private pendingDocEdit: { resolve: (err: string | null) => void; timer: number } | null = null;

   constructor(
      private readonly send: (msg: object) => boolean,
      private readonly getSinks: () => Sinks,
      private readonly isLinkLive: () => boolean,
      private readonly dawnUrl: (path: string) => string
   ) {}

   private get sinks(): Sinks {
      return this.getSinks();
   }

   /* As the socket opens. */
   linkUp(): void {
      /* Library: the notes + documents list for the Library panel. A poll (there is no
         push feed); the panel's refresh control re-lists on demand. A read, no writes. */
      this.requestLibrary();
   }

   /* Its frames (the core lists them in its switch). */
   onFrame(type: string, p: Record<string, unknown>): void {
      switch (type) {
         case "doc_library_list_response": {
            /* Notes + documents for the Library panel. success:false (or an empty set)
               renders "Nothing in the library"; the panel labels this response by the
               in-flight request kind (list / search / load-more). */
            if (p.success === false) break;
            const docs = (p.documents ?? []) as Array<Record<string, unknown>>;
            this.sinks.library.setItems(docs.map(toLibraryItem), {
               append: this.pendingLibraryAppend,
               searching: this.pendingLibrarySearching,
               hasMore: p.has_more === true
            });
            break;
         }

         case "doc_library_get_response": {
            /* Resolve the reader's pending full-text request for this id. success:false
               (unavailable) resolves null so the reader can fall back. */
            const id = Number(p.id ?? 0);
            const pending = this.pendingDocGets.get(id);
            if (pending) {
               window.clearTimeout(pending.timer);
               this.pendingDocGets.delete(id);
               if (p.success === true && typeof p.text === "string") {
                  pending.resolve({
                     text: p.text,
                     filename: str(p.filename),
                     filetype: str(p.filetype)
                  });
               } else {
                  pending.resolve(null);
               }
            }
            break;
         }

         case "doc_library_note_update_response":
         case "doc_library_doc_update_response": {
            /* Resolve the single in-flight edit save. success:false carries the reason (a label
               collision, the pre-v63 "re-save to enable editing" reject, ...); surface it
               verbatim. note_update omits the id on its error branches, which is why this uses
               one pending slot rather than id correlation. */
            const pending = this.pendingDocEdit;
            if (pending) {
               window.clearTimeout(pending.timer);
               this.pendingDocEdit = null;
               const err =
                  p.success === true
                     ? null
                     : typeof p.error === "string" && p.error
                       ? p.error
                       : "Save failed.";
               pending.resolve(err);
            }
            break;
         }
      }
   }

   refreshLibrary(): void {
      this.requestLibrary();
   }

   searchLibrary(query: string, opts?: { limit?: number; offset?: number }): void {
      this.requestLibrary({ query, offset: opts?.offset ?? 0, searching: true });
   }

   loadMoreLibrary(offset: number): void {
      this.requestLibrary({ offset, append: true });
   }

   /* Fetch a document's original file over the same-origin /api proxy (the cookie rides
      it). A GET read; the view decodes text or object-URLs binaries for download. The
      attachment/nosniff headers on the endpoint don't affect a fetch(). */
   async fetchDocumentOriginal(blobId: string): Promise<{ blob: Blob; contentType: string }> {
      const res = await fetch(
         this.dawnUrl(`/api/documents/original/${encodeURIComponent(blobId)}`),
         {
            credentials: "same-origin"
         }
      );
      if (!res.ok) throw new Error(`document fetch failed: ${res.status}`);
      const blob = await res.blob();
      return { blob, contentType: res.headers.get("content-type") ?? "" };
   }

   /* doc_library_get over the WS, promise-correlated by id. Resolves null on an error
      response, a superseding request for the same id, or a 15s timeout (a dropped
      response must not leak the promise). */
   getDocumentText(
      id: number
   ): Promise<{ text: string; filename: string; filetype: string } | null> {
      return new Promise((resolve) => {
         /* Supersede any in-flight request for this id (clear its timer, resolve it null). */
         const prev = this.pendingDocGets.get(id);
         if (prev) {
            window.clearTimeout(prev.timer);
            prev.resolve(null);
         }
         const timer = window.setTimeout(() => {
            if (this.pendingDocGets.get(id)?.resolve === resolve) {
               this.pendingDocGets.delete(id);
               resolve(null);
            }
         }, 15000);
         this.pendingDocGets.set(id, { resolve, timer });
         this.send({ type: "doc_library_get", payload: { id } });
      });
   }

   /* Save an edited note (doc_library_note_update). label is the note's filename. */
   updateNote(id: number, label: string, text: string): Promise<string | null> {
      return this.editSave({ type: "doc_library_note_update", payload: { id, label, text } });
   }

   /* Save an edited document's stored text (doc_library_doc_update; re-chunks + re-embeds). */
   updateDocText(id: number, text: string): Promise<string | null> {
      return this.editSave({ type: "doc_library_doc_update", payload: { id, text } });
   }

   /* Send an edit frame and resolve on the matching *_update_response: null = saved, else a
      human-readable error string (a label collision, a pre-v63 "re-save to enable editing"
      reject, ...). Resolves fast when the link is down; a 15s timeout guards a dropped
      response. One slot - a second save supersedes the first (shouldn't happen: modal-gated). */
   private editSave(frame: {
      type: string;
      payload: Record<string, unknown>;
   }): Promise<string | null> {
      return new Promise((resolve) => {
         if (!this.isLinkLive()) {
            resolve("Not connected to DAWN - edit not saved.");
            return;
         }
         if (this.pendingDocEdit) {
            window.clearTimeout(this.pendingDocEdit.timer);
            this.pendingDocEdit.resolve("Superseded by a newer save.");
         }
         const timer = window.setTimeout(() => {
            if (this.pendingDocEdit?.resolve === resolve) {
               this.pendingDocEdit = null;
               resolve("Save timed out.");
            }
         }, 15000);
         this.pendingDocEdit = { resolve, timer };
         this.send(frame);
      });
   }

   /* Request a page of the document library (list / search / load-more). Records the
      request kind so the shared doc_library_list_response can be labeled for the panel. */
   private requestLibrary(
      opts: { query?: string; offset?: number; append?: boolean; searching?: boolean } = {}
   ): void {
      this.pendingLibraryAppend = opts.append === true;
      this.pendingLibrarySearching = opts.searching === true;
      const payload: Record<string, unknown> = { limit: LIB_PAGE, offset: opts.offset ?? 0 };
      if (opts.query) payload.query = opts.query;
      this.send({ type: "doc_library_list", payload });
   }

   /* Final teardown (HMR / unmount). */
   dispose(): void {
      /* Settle any in-flight full-text reads so their promises + timers never dangle across HMR. */
      for (const pending of this.pendingDocGets.values()) {
         window.clearTimeout(pending.timer);
         pending.resolve(null);
      }
      this.pendingDocGets.clear();
      /* Same for an in-flight edit save: clear its 15s timer + resolve so it can't pin this
         instance across an HMR reload. */
      if (this.pendingDocEdit) {
         window.clearTimeout(this.pendingDocEdit.timer);
         this.pendingDocEdit.resolve("Editor closed.");
         this.pendingDocEdit = null;
      }
   }
}
