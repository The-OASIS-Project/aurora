/* The conversation picker's list: its first page, load-more and search, kept to one request in
   flight with a refresh asked for meanwhile queued rather than raced (two page-0 replies could be
   read as an append and duplicate the list), DAWN's conversation_list_changed pushes coalesced
   into one refresh, and rename and pin. Opening, deleting and the boot resume stay in the core,
   with the conversation on screen. */

import type { ConversationMeta, IngestSinks } from "./ingest.ts";

export const CONV_PAGE = 50; // conversation-picker page size (must match the component's PAGE)
const CONV_LIST_DEBOUNCE_MS = 700; // coalesce a turn's >=2 bumped conversation_list_changed frames into one refresh

/* The view it drives. */
type Sinks = Pick<IngestSinks, "conversationList">;

export class ConversationListFeed {
   private conversationsLoading = false; // single-flight latch: one list/search request at a time
   private pendingListAppend = false; // the in-flight list request is a load-more (append), not a replace
   private pendingListRefresh = false; // a page-0 refresh queued behind an in-flight request (drained on settle). Invariant: pendingListRefresh => conversationsLoading
   private convListTimer = 0; // debounce for the live conversation_list_changed refresh (coalesce a turn's >=2 bumped frames)

   constructor(
      private readonly send: (msg: object) => boolean,
      private readonly getSinks: () => Sinks,
      private readonly getConvId: () => number
   ) {}

   private get sinks(): Sinks {
      return this.getSinks();
   }

   /* The open conversation (its own turn's bumps are covered at its stream_end). */
   private get convId(): number {
      return this.getConvId();
   }

   /* The socket's open sends the first page itself (raw, before anything else). */
   markBootList(): void {
      this.conversationsLoading = true;
      this.pendingListAppend = false;
   }

   /* The socket closed: no list reply will come, and the reconnect's first page replaces any
      queued refresh. */
   linkDown(): void {
      this.conversationsLoading = false;
      this.pendingListAppend = false;
      this.pendingListRefresh = false;
      window.clearTimeout(this.convListTimer);
      this.convListTimer = 0;
   }

   /* A deliberate disconnect: no live refresh fires after it. */
   cancelRefresh(): void {
      window.clearTimeout(this.convListTimer);
      this.convListTimer = 0;
      this.pendingListRefresh = false;
   }

   /* A new conversation exists: refetch now, instead of the refresh its own `created` push queued. */
   refreshNow(): void {
      window.clearTimeout(this.convListTimer);
      this.convListTimer = 0;
      this.requestConversations();
   }

   /* list_conversations_response's list part. Whether it was a load-more (the core's boot resume
      reads it, then calls settleListRequest). */
   onList(p: Record<string, unknown>): boolean {
      const raw = (p.conversations ?? []) as Array<Record<string, unknown>>;
      const append = this.pendingListAppend;
      this.pendingListAppend = false;
      const total = typeof p.total === "number" ? p.total : undefined;
      this.sinks.conversationList.setList(
         raw.map((c) => this.toMeta(c)),
         {
            total,
            append,
            searching: false
         }
      );
      return append;
   }

   /* Its other frames (the core lists them in its switch). */
   onFrame(type: string, p: Record<string, unknown>): void {
      switch (type) {
         case "search_conversations_response": {
            this.settleListRequest();
            const raw = (p.conversations ?? []) as Array<Record<string, unknown>>;
            this.sinks.conversationList.setList(
               raw.map((c) => this.toMeta(c)),
               {
                  append: false,
                  searching: true
               }
            );
            break;
         }
         case "rename_conversation_response":
            /* No conversation_id echo: the panel already patched optimistically. An older DAWN
               sends no conversation_renamed for it (DAWN #120 does, before or after this reply,
               carrying the stored title, so the order doesn't matter). Reconcile on failure by
               refetching the server's truth; on success a debounced refresh closes the window
               where a list refetch already in flight (from a concurrent remote change) would
               otherwise land after and revert the optimistic patch. */
            if ((p as { success?: boolean }).success === false) this.requestConversations();
            else this.scheduleListRefresh();
            break;

         case "set_pinned_response":
            /* Echoes conversation_id + is_pinned; the panel patched optimistically on the
               click, so accept the success and only refetch to correct a failure. On success a
               debounced refresh reconciles against a concurrent in-flight list refetch (same
               revert window as rename). */
            if ((p as { success?: boolean }).success === false) this.requestConversations();
            else this.scheduleListRefresh();
            break;

         case "conversation_list_changed": {
            /* A conversation was created or bumped (got a message) by ANY interface - another
               tab, voice, messaging, a background job/briefing. Refresh the picker list so the
               new row / new order shows without a click. Debounced (a turn emits >=2 bumped
               frames) and latch-safe (requestConversations queues rather than racing). This is
               list membership/order only; unread-marking stays on conversation_messages_appended.
               Self-echo: our OWN active conversation's `bumped` is already covered by the
               own-turn refresh at terminal stream_end, so drop it here (else every token-thread
               bump refetches). `created` is NOT filtered on convId - on a fresh chat convId is
               still 0 when DAWN emits `created`, so it could never match; new_conversation_response
               cancels this debounce instead, collapsing the two paths into one fetch. */
            const cid = Number((p as { conversation_id?: number }).conversation_id ?? 0);
            const created = (p as { reason?: string }).reason === "created";
            if (!Number.isInteger(cid) || cid <= 0) break;
            if (!created && cid === this.convId) break; // own active turn -> handled at stream_end
            this.scheduleListRefresh();
            break;
         }
      }
   }

   /* Map DAWN's conversation object (list/search) into the picker's ConversationMeta.
      ids are DB AUTOINCREMENT ints, so Number() is exact. */
   private toMeta(c: Record<string, unknown>): ConversationMeta {
      return {
         id: Number(c.id ?? 0),
         title: typeof c.title === "string" ? c.title : "",
         createdAt: Number(c.created_at ?? 0),
         updatedAt: Number(c.updated_at ?? 0),
         messageCount: Number(c.message_count ?? 0),
         isArchived: Boolean(c.is_archived),
         isPrivate: Boolean(c.is_private),
         isPinned: Boolean(c.is_pinned),
         origin: typeof c.origin === "string" ? c.origin : "webui"
      };
   }

   /* Refetch the first page of the list (a replace), reconciling the picker after a
      mutation whose response can't be patched in place (rename/delete failure, a new row) or a
      live conversation_list_changed. Queue-don't-drop: if a list/search request is already in
      flight, mark a pending refresh and let settleListRequest() re-fire it on the response,
      rather than sending a second page-0 that races the in-flight one (which could be consumed
      as an append and duplicate/replace the list). All callers inherit this safety. */
   requestConversations(): void {
      if (this.conversationsLoading) {
         this.pendingListRefresh = true; // invariant: only set while loading; drained on settle
         return;
      }
      this.pendingListAppend = false;
      this.conversationsLoading = true;
      this.send({ type: "list_conversations", payload: { limit: CONV_PAGE, offset: 0 } });
   }

   /* Clear the single-flight latch on a list/search response, then drain a refresh that was
      queued while it was in flight. Called from BOTH list and search response handlers so a
      queued refresh is never stranded behind a search. */
   settleListRequest(): void {
      this.conversationsLoading = false;
      if (this.pendingListRefresh) {
         this.pendingListRefresh = false;
         this.requestConversations();
      }
   }

   /* Debounced page-0 refresh for the live conversation_list_changed frame (and the own-turn /
      mutation-success reconciles). Coalesces a turn's >=2 bumped frames into one refetch. */
   scheduleListRefresh(): void {
      window.clearTimeout(this.convListTimer);
      this.convListTimer = window.setTimeout(() => {
         this.convListTimer = 0;
         this.requestConversations();
      }, CONV_LIST_DEBOUNCE_MS);
   }

   listConversations(opts: { limit: number; offset: number }): void {
      if (this.conversationsLoading) return; // one list/search request in flight at a time
      this.pendingListAppend = opts.offset > 0;
      this.conversationsLoading = true;
      this.send({
         type: "list_conversations",
         payload: { limit: opts.limit, offset: opts.offset }
      });
   }

   searchConversations(
      query: string,
      content: boolean,
      opts?: { limit?: number; offset?: number }
   ): void {
      this.conversationsLoading = true;
      this.pendingListAppend = false;
      this.send({
         type: "search_conversations",
         payload: {
            query,
            search_content: content,
            limit: opts?.limit ?? CONV_PAGE,
            offset: opts?.offset ?? 0
         }
      });
   }

   renameConversation(id: number, title: string): void {
      if (id > 0 && title.trim()) {
         this.send({ type: "rename_conversation", payload: { conversation_id: id, title } });
         /* The Learned list follows renames from conversation_renamed alone: only a DAWN that
            titles its batches (#120) shows one, and that DAWN sends the frame for every rename
            (a refused one sends none, so nothing wrong is shown). */
      }
   }

   setPinned(id: number, pinned: boolean): void {
      if (id > 0)
         this.send({ type: "set_pinned", payload: { conversation_id: id, is_pinned: pinned } });
   }
}
