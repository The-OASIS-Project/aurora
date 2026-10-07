/*
 * DawnIngest's side of the email boundary (EmailSource), kept out of the 5000-line dawn-ws.ts.
 * DawnIngest owns the socket: it tells this module whether DAWN advertises `email_client`
 * (each config frame) and whether the link is live, routes every email_*_response frame here,
 * and lends it `send`. Wire contract: DAWN's WEBSOCKET_PROTOCOL.md "Email" section (P1.1).
 *
 *  - Every request carries a page-unique `req`; replies are matched by it (DAWN runs email work
 *    off the socket thread, so replies can arrive out of order). A request DAWN replaced with a
 *    newer one answers SUPERSEDED, which callers ignore.
 *  - A request that hasn't been answered in time is sent once more (DAWN's send queue can drop a
 *    frame under load) WITHOUT forgetting the first: both tags stay registered, the first reply to
 *    either settles it, and a SUPERSEDED answer to one that has a newer twin is just dropped. (A
 *    retried list replaces the still-running first one on DAWN's side; a retried read waits behind
 *    it.) A real link loss fails everything in flight; a missed heartbeat ("stale") doesn't.
 *  - P1.1 has list / search / read / set_flags / unread_counts. Archive, trash, and undo (P1.2)
 *    and live changes (P1.3) aren't on the wire yet: supportsMoves() and supportsLiveChanges() are
 *    false, so the panel hides those actions (and the new-mail bells) and refreshes by hand.
 *  - Every string from DAWN is untrusted mail data; this module only maps shapes.
 */

import type {
   EmailAccount,
   EmailAccountStatus,
   EmailAvailability,
   EmailChanges,
   EmailErrorCode,
   EmailListQuery,
   EmailListResult,
   EmailMessage,
   EmailMoveResult,
   EmailRow,
   EmailSink,
   EmailSource,
   EmailUndoResult,
   EmailUnreadCount
} from "./email.ts";
import { EmailRequestError } from "./email.ts";

type Send = (msg: { type: string; payload?: Record<string, unknown> }) => void;
type Json = Record<string, unknown>;

const ATTEMPT_MS = 30_000; // IMAP logins + fetches run through DAWN's per-account queue
const ACCOUNTS_RETRY_MS = 10_000; // a failed account list is asked for again after this
const SEND_RETRIES = 1;

interface Pending {
   type: string;
   payload: Json;
   resolve: (p: Json) => void;
   reject: (e: EmailRequestError) => void;
   timer: number;
   retries: number;
   reqs: string[]; // every tag this request was sent under (still live until it settles)
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

function toRow(r: Json): EmailRow {
   return {
      accountId: num(r.account_id),
      messageId: str(r.message_id),
      threadId: typeof r.thread_id === "string" ? r.thread_id : undefined,
      fromName: str(r.from_name),
      fromAddr: str(r.from_addr),
      subject: str(r.subject),
      date: num(r.date),
      preview: str(r.preview),
      unread: r.unread === true,
      starred: typeof r.starred === "boolean" ? r.starred : undefined,
      important: typeof r.important === "boolean" ? r.important : undefined,
      hasAttachments: typeof r.has_attachments === "boolean" ? r.has_attachments : undefined
   };
}

const toAddr = (a: unknown): { name: string; addr: string } => {
   const o = (a && typeof a === "object" ? a : {}) as Json;
   return { name: str(o.name), addr: str(o.addr) };
};

function toMessage(m: Json): EmailMessage {
   const list = (v: unknown): Array<{ name: string; addr: string }> => (Array.isArray(v) ? v.map(toAddr) : []);
   return {
      accountId: num(m.account_id),
      messageId: str(m.message_id),
      threadId: typeof m.thread_id === "string" ? m.thread_id : undefined,
      subject: str(m.subject),
      fromName: str(m.from_name),
      fromAddr: str(m.from_addr),
      to: list(m.to),
      cc: list(m.cc),
      toTotal: typeof m.to_total === "number" ? m.to_total : undefined,
      ccTotal: typeof m.cc_total === "number" ? m.cc_total : undefined,
      replyTo: m.reply_to && typeof m.reply_to === "object" ? toAddr(m.reply_to) : undefined,
      date: num(m.date),
      bodyText: str(m.body_text),
      bodyHtml: typeof m.body_html === "string" ? m.body_html : undefined,
      textTruncated: m.text_truncated === true,
      htmlTruncated: m.html_truncated === true,
      attachments: Array.isArray(m.attachments)
         ? (m.attachments as Json[]).map((a) => ({
              partId: str(a.part_id),
              filename: str(a.filename),
              mime: str(a.mime),
              size: num(a.size),
              inline: a.inline === true,
              contentId: typeof a.content_id === "string" ? a.content_id : undefined
           }))
         : [],
      attachmentsTruncated: m.attachments_truncated === true
   };
}

function toCounts(v: unknown): EmailUnreadCount[] {
   if (!Array.isArray(v)) return [];
   const statuses: EmailAccountStatus[] = ["ok", "auth_revoked", "auth_failed", "unreachable"];
   return (v as Json[]).map((a) => ({
      accountId: num(a.account_id),
      inboxUnread: typeof a.inbox_unread === "number" && Number.isFinite(a.inbox_unread) ? a.inbox_unread : null,
      status: statuses.includes(a.status as EmailAccountStatus) ? (a.status as EmailAccountStatus) : "unreachable"
   }));
}

export class DawnEmail implements EmailSource {
   private sink: EmailSink | null = null;
   private advertised = false;
   private configSeen = false; // this connection's config frame has arrived (the flag is known)
   private availability: EmailAvailability = "unknown";
   private linked = false;
   private published = false; // the "linked" the panel last heard (link up + config known)
   private wanted = false;
   private readonly pending = new Map<string, Pending>(); // by req (a retried request has two)
   private accountsInFlight = false;
   private accountsRetry = 0;
   private readonly pageTag = (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2)).replace(/-/g, "").slice(0, 8);
   private seq = 0;

   constructor(private readonly send: Send) {}

   /* From each config frame (the one place the flags are known for this connection): availability
      is decided here, the panel sees the link come up only now (so its link-up catch-up runs with the
      flag known), and the account list is (re)loaded once per connection. */
   setServerSupport(advertised: boolean): void {
      const was = this.advertised;
      this.advertised = advertised;
      this.configSeen = true;
      if (was && !advertised) this.failAll("UNAVAILABLE", "Mail isn't available on this DAWN");
      this.update();
      this.publishLinked();
      if (advertised && this.linked) this.loadAccounts();
   }

   /* The link is usable (connected, or "stale": one missed heartbeat, socket still open). Only a
      real loss fails what's in flight. While down, the panel keeps the last availability (so it can
      show itself offline); on the way back up it hears nothing until this connection's config. */
   setLinked(on: boolean): void {
      if (on === this.linked) return;
      this.linked = on;
      if (!on) {
         this.failAll("UNREACHABLE", "Lost the connection to DAWN");
         window.clearTimeout(this.accountsRetry); // the next connection loads the list afresh
         this.configSeen = false; // the flag is re-learned from the next connection's config
      }
      this.publishLinked();
   }

   /* What the panel sees as "linked": the link is up AND this connection's flags are known. */
   private publishLinked(): void {
      const on = this.linked && this.configSeen;
      if (on === this.published) return;
      this.published = on;
      this.sink?.setLinked(on);
   }

   private update(): void {
      const next: EmailAvailability = this.advertised ? "available" : "unavailable";
      if (next !== this.availability) {
         this.availability = next;
         this.sink?.setAvailability(next);
      }
   }

   /* The user's enabled accounts (DAWN's account list; setup lives in DAWN's WebUI). */
   private loadAccounts(): void {
      if (this.accountsInFlight || !this.sink) return;
      this.accountsInFlight = true;
      this.request("email_list_accounts", {})
         .then((p) => {
            const rows = Array.isArray(p.accounts) ? (p.accounts as Json[]) : [];
            const accounts: EmailAccount[] = rows
               .filter((a) => a.enabled === true)
               .map((a) => ({
                  id: num(a.id),
                  address: str(a.username) || str(a.display_name) || str(a.name),
                  displayName: str(a.name) || str(a.display_name),
                  readOnly: a.read_only === true
               }));
            window.clearTimeout(this.accountsRetry);
            this.sink?.setAccountsError(null);
            this.sink?.setAccounts(accounts);
         })
         .catch((e: unknown) => {
            /* A link loss says so on its own (the panel goes offline; the next connection reloads). */
            const code = e instanceof EmailRequestError ? e.code : "FAILED";
            if (code === "UNREACHABLE" || code === "CANCELLED") return;
            /* Not answered, or refused: say so, and try again shortly while this connection lasts. */
            this.sink?.setAccountsError(e instanceof Error && e.message ? e.message : "DAWN didn't answer");
            window.clearTimeout(this.accountsRetry);
            this.accountsRetry = window.setTimeout(() => {
               if (this.published && this.advertised) this.loadAccounts();
            }, ACCOUNTS_RETRY_MS);
         })
         .finally(() => (this.accountsInFlight = false));
   }

   attach(sink: EmailSink): void {
      this.sink = sink;
      sink.setAvailability(this.availability);
      this.published = this.linked && this.configSeen;
      sink.setLinked(this.published);
      if (this.published && this.advertised) this.loadAccounts();
   }

   detach(): void {
      this.sink = null;
      this.wanted = false;
   }

   /* ---- request/response ---------------------------------------------------- */

   /* An email_*_response frame from DawnIngest. Returns whether it was one of ours. */
   handleFrame(type: string, p: Json): boolean {
      if (!type.startsWith("email_") || !type.endsWith("_response")) return false;
      let req = str(p.req);
      /* DAWN's account-settings verbs don't echo req (email_list_accounts takes no payload): match
         a tag-less reply by its type when exactly one such request is outstanding. */
      if (!req) {
         const want = type.replace(/_response$/, "");
         const live = [...new Set(this.pending.values())].filter((e) => e.type === want);
         if (live.length === 1) req = live[0].reqs.find((r) => this.pending.get(r) === live[0]) ?? "";
      }
      const entry = req ? this.pending.get(req) : undefined;
      if (!entry) return true; // a late reply to a request already settled or given up on
      /* One attempt of a retried request was replaced by its own newer twin: wait for the twin. */
      if (p.success === false && p.error_code === "SUPERSEDED" && entry.reqs.some((r) => r !== req && this.pending.get(r) === entry)) {
         this.pending.delete(req);
         return true;
      }
      for (const r of entry.reqs) this.pending.delete(r);
      window.clearTimeout(entry.timer);
      if (p.success === false) {
         const code = (str(p.error_code) || "FAILED") as EmailErrorCode;
         entry.reject(new EmailRequestError(code, str(p.error) || "Something went wrong"));
      } else {
         entry.resolve(p);
      }
      return true;
   }

   private request(type: string, payload: Json): Promise<Json> {
      if (!this.linked) return Promise.reject(new EmailRequestError("UNREACHABLE", "Not connected to DAWN"));
      if (!this.configSeen) return Promise.reject(new EmailRequestError("UNREACHABLE", "Connecting to DAWN…"));
      if (!this.advertised) return Promise.reject(new EmailRequestError("UNAVAILABLE", "Mail isn't available on this DAWN"));
      return new Promise((resolve, reject) =>
         this.dispatch({ type, payload, resolve, reject, timer: 0, retries: SEND_RETRIES, reqs: [] })
      );
   }

   /* Send (or re-send) a request under a fresh tag. Earlier tags stay registered: if the first
      attempt's reply was only slow, not lost, it still settles the request. */
   private dispatch(entry: Pending): void {
      const req = `${this.pageTag}-${++this.seq}`;
      entry.reqs.push(req);
      this.pending.set(req, entry);
      entry.timer = window.setTimeout(() => {
         if (entry.retries > 0 && this.linked) {
            entry.retries--;
            this.dispatch(entry); // the frame may have been dropped under load: ask again
         } else {
            for (const r of entry.reqs) this.pending.delete(r);
            entry.reject(new EmailRequestError("TIMEOUT", "DAWN didn't answer in time"));
         }
      }, ATTEMPT_MS);
      this.send({ type: entry.type, payload: { ...entry.payload, req } });
   }

   private failAll(code: EmailErrorCode, message: string): void {
      const entries = new Set(this.pending.values());
      this.pending.clear();
      for (const e of entries) {
         window.clearTimeout(e.timer);
         e.reject(new EmailRequestError(code, message));
      }
   }

   /* ---- EmailSource --------------------------------------------------------- */

   supportsMoves(): boolean {
      return false; // archive / trash / undo arrive with DAWN's P1.2
   }

   supportsLiveChanges(): boolean {
      return false; // the change feed (and so new-mail notices) arrives with DAWN's P1.3
   }

   async list(q: EmailListQuery): Promise<EmailListResult> {
      const base: Json = { unread_only: !!q.unreadOnly, limit: q.limit ?? 25 };
      if (q.accountIds?.length) base.account_ids = q.accountIds;
      if (q.cursor) base.cursor = q.cursor;
      const p = q.query
         ? await this.request("email_search", { ...base, query: q.query })
         : await this.request("email_list", { ...base, folder: "inbox" });
      /* The first inbox page carries the unread counts on the same login, but only for the accounts
         it covered: forward them only when it covered every account (else they'd wipe the rest). */
      if (Array.isArray(p.accounts) && !q.accountIds?.length) this.sink?.setUnreadCounts(toCounts(p.accounts));
      return {
         rows: Array.isArray(p.rows) ? (p.rows as Json[]).map(toRow) : [],
         cursor: typeof p.cursor === "string" && p.cursor ? p.cursor : null,
         partial: Array.isArray(p.partial)
            ? (p.partial as Json[]).map((x) => ({
                 accountId: num(x.account_id),
                 code: (str(x.error_code) || "FAILED") as EmailErrorCode,
                 message: str(x.error)
              }))
            : []
      };
   }

   async read(accountId: number, messageId: string, markRead: boolean): Promise<{ message: EmailMessage; unread: boolean }> {
      const p = await this.request("email_read", { account_id: accountId, message_id: messageId, mark_read: markRead });
      const m = p.message && typeof p.message === "object" ? toMessage(p.message as Json) : null;
      if (!m) throw new EmailRequestError("FAILED", "DAWN sent an empty message");
      return { message: m, unread: p.unread === true };
   }

   async setFlags(accountId: number, messageIds: string[], flags: { unread?: boolean }): Promise<void> {
      if (flags.unread === undefined) return;
      const p = await this.request("email_set_flags", { account_id: accountId, message_ids: messageIds, unread: flags.unread });
      const failed = Array.isArray(p.failed) ? (p.failed as Json[]) : [];
      if (failed.length && failed.length === messageIds.length) {
         throw new EmailRequestError((str(failed[0].error_code) || "FAILED") as EmailErrorCode, str(failed[0].error) || "Couldn't change it");
      }
   }

   archive(_accountId: number, _messageIds: string[]): Promise<EmailMoveResult> {
      return Promise.reject(new EmailRequestError("UNAVAILABLE", "Archive comes with a later DAWN update"));
   }
   trash(_accountId: number, _messageIds: string[]): Promise<EmailMoveResult> {
      return Promise.reject(new EmailRequestError("UNAVAILABLE", "Trash comes with a later DAWN update"));
   }
   undo(_accountId: number, _tokens: string[]): Promise<EmailUndoResult> {
      return Promise.reject(new EmailRequestError("UNAVAILABLE", "Undo comes with a later DAWN update"));
   }

   async unreadCounts(): Promise<EmailUnreadCount[]> {
      const p = await this.request("email_unread_counts", {});
      return toCounts(p.accounts);
   }

   changes(_accountId: number, _sinceState: string): Promise<EmailChanges> {
      /* Live changes arrive with DAWN's P1.3: until then the panel reloads. */
      return Promise.reject(new EmailRequestError("CANNOT_CALCULATE", "No change feed yet"));
   }

   setSubscription(want: boolean, _accountIds?: number[]): void {
      this.wanted = want; // email_subscribe arrives with DAWN's P1.3
   }

   /* The panel's subscription intent (replayed on reconnect once DAWN has the verb). */
   get subscriptionWanted(): boolean {
      return this.wanted;
   }

   dispose(): void {
      window.clearTimeout(this.accountsRetry);
      this.failAll("CANCELLED", "Closed");
   }
}
