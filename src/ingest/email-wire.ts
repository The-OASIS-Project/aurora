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
 *  - P1.1 list / search / read / set_flags / unread_counts; P1.2 archive / trash / undo plus the
 *    `email_changed` notice after every move or undo (from any tab, or Friday). Live changes (P1.3)
 *    aren't on the wire yet: supportsLiveChanges() is false (no new-mail bells; refresh by hand).
 *  - Moves are batched (clicks within a short window per account and kind, and while that key's
 *    previous call is still running, at most 50 ids per call, as DAWN asks; one call per key in
 *    flight keeps inside DAWN's per-session queue) and NEVER re-sent: DAWN queues them and may already have done one, so a lost reply is
 *    "outcome unknown" and the panel reloads (DAWN's email_changed says what really moved).
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
const MOVE_BATCH_MS = 250; // rapid clicks within this become one call
const MOVE_MAX = 50; // DAWN's per-call limit for archive / trash / undo

interface Pending {
   type: string;
   payload: Json;
   resolve: (p: Json) => void;
   reject: (e: EmailRequestError) => void;
   timer: number;
   retries: number;
   reqs: string[]; // every tag this request was sent under (still live until it settles)
   /* The code a final timeout rejects with: a move that may have run is OUTCOME_UNKNOWN. */
   timeoutCode: EmailErrorCode;
}

type MoveKind = "archive" | "trash";
interface MoveWaiter {
   ids: string[];
   resolve: (r: EmailMoveResult) => void;
   reject: (e: EmailRequestError) => void;
}
interface MoveBatch {
   accountId: number;
   kind: MoveKind;
   ids: string[];
   waiters: MoveWaiter[];
   timer: number;
   due: boolean; // its window closed while the key's previous call was still running
}

/* An IMAP id without its UIDVALIDITY suffix ("INBOX:4211.7" -> "INBOX:4211"), so a reply's pinned
   id matches the one sent. Gmail ids have no suffix and are unchanged. */
const baseId = (id: string): string => id.replace(/(:\d+)\.\d+$/, "$1");

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
   const list = (v: unknown): Array<{ name: string; addr: string }> =>
      Array.isArray(v) ? v.map(toAddr) : [];
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

function toAccount(a: Json): EmailAccount {
   return {
      id: num(a.id),
      address: str(a.username) || str(a.display_name) || str(a.name),
      displayName: str(a.name) || str(a.display_name),
      readOnly: a.read_only === true,
      canTrash: typeof a.can_trash === "boolean" ? a.can_trash : undefined,
      canArchive: typeof a.can_archive === "boolean" ? a.can_archive : undefined
   };
}

function toCounts(v: unknown): EmailUnreadCount[] {
   if (!Array.isArray(v)) return [];
   const statuses: EmailAccountStatus[] = ["ok", "auth_revoked", "auth_failed", "unreachable"];
   return (v as Json[]).map((a) => ({
      accountId: num(a.account_id),
      inboxUnread:
         typeof a.inbox_unread === "number" && Number.isFinite(a.inbox_unread)
            ? a.inbox_unread
            : null,
      status: statuses.includes(a.status as EmailAccountStatus)
         ? (a.status as EmailAccountStatus)
         : "unreachable"
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
   private accounts: EmailAccount[] = []; // the last list sent to the panel (capabilities merge in)
   private readonly batches = new Map<string, MoveBatch>();
   private readonly inFlight = new Set<string>(); // keys whose move call hasn't answered yet
   private accountsRetry = 0;
   private readonly pageTag = (
      globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2)
   )
      .replace(/-/g, "")
      .slice(0, 8);
   private seq = 0;

   constructor(
      private readonly send: Send,
      /* Whether this connection's DAWN said it doesn't handle a type (UNKNOWN_TYPE): such a request
         fails at once instead of being swallowed and waiting out its timeout. */
      private readonly unsupported: (type: string) => boolean = () => false
   ) {}

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
         this.failBatches("UNREACHABLE", "Lost the connection to DAWN");
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
            const accounts: EmailAccount[] = rows.filter((a) => a.enabled === true).map(toAccount);
            window.clearTimeout(this.accountsRetry);
            this.accounts = accounts;
            this.sink?.setAccountsError(null);
            this.sink?.setAccounts(accounts);
         })
         .catch((e: unknown) => {
            /* A link loss says so on its own (the panel goes offline; the next connection reloads). */
            const code = e instanceof EmailRequestError ? e.code : "FAILED";
            if (code === "UNREACHABLE" || code === "CANCELLED") return;
            /* Not answered, or refused: say so, and try again shortly while this connection lasts. */
            this.sink?.setAccountsError(
               e instanceof Error && e.message ? e.message : "DAWN didn't answer"
            );
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

   /* An email_* frame from DawnIngest (a reply, or the email_changed notice). Returns whether it
      was one of ours. */
   handleFrame(type: string, p: Json): boolean {
      if (type === "email_changed") {
         this.onChanged(p);
         return true;
      }
      if (!type.startsWith("email_") || !type.endsWith("_response")) return false;
      let req = str(p.req);
      /* DAWN's account-settings verbs don't echo req (email_list_accounts takes no payload): match
         a tag-less reply by its type when exactly one such request is outstanding. */
      if (!req) {
         const want = type.replace(/_response$/, "");
         const live = [...new Set(this.pending.values())].filter((e) => e.type === want);
         if (live.length === 1)
            req = live[0].reqs.find((r) => this.pending.get(r) === live[0]) ?? "";
      }
      const entry = req ? this.pending.get(req) : undefined;
      if (!entry) return true; // a late reply to a request already settled or given up on
      /* One attempt of a retried request was replaced by its own newer twin: wait for the twin. */
      if (
         p.success === false &&
         p.error_code === "SUPERSEDED" &&
         entry.reqs.some((r) => r !== req && this.pending.get(r) === entry)
      ) {
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

   /* `once`: never re-sent (a move or undo that may already have run); a lost reply rejects as
      OUTCOME_UNKNOWN instead of TIMEOUT. */
   private request(type: string, payload: Json, once = false): Promise<Json> {
      if (!this.linked)
         return Promise.reject(new EmailRequestError("UNREACHABLE", "Not connected to DAWN"));
      if (!this.configSeen)
         return Promise.reject(new EmailRequestError("UNREACHABLE", "Connecting to DAWN…"));
      if (!this.advertised)
         return Promise.reject(
            new EmailRequestError("UNAVAILABLE", "Mail isn't available on this DAWN")
         );
      if (this.unsupported(type))
         return Promise.reject(
            new EmailRequestError("UNAVAILABLE", "This DAWN doesn't support that yet")
         );
      return new Promise((resolve, reject) =>
         this.dispatch({
            type,
            payload,
            resolve,
            reject,
            timer: 0,
            retries: once ? 0 : SEND_RETRIES,
            reqs: [],
            timeoutCode: once ? "OUTCOME_UNKNOWN" : "TIMEOUT"
         })
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
            entry.reject(
               new EmailRequestError(
                  entry.timeoutCode,
                  entry.timeoutCode === "OUTCOME_UNKNOWN"
                     ? "DAWN didn't confirm it"
                     : "DAWN didn't answer in time"
               )
            );
         }
      }, ATTEMPT_MS);
      this.send({ type: entry.type, payload: { ...entry.payload, req } });
   }

   /* DAWN answered one of our requests with UNKNOWN_TYPE (it doesn't handle that verb): nothing
      ran, so the request fails now instead of waiting out its timeout. */
   failUnsupported(req: string): void {
      const entry = this.pending.get(req);
      if (!entry) return;
      for (const r of entry.reqs) this.pending.delete(r);
      window.clearTimeout(entry.timer);
      entry.reject(new EmailRequestError("UNAVAILABLE", "This DAWN doesn't support that yet"));
   }

   /* Queued (not yet sent) moves: nothing ran, so they simply fail. */
   private failBatches(code: EmailErrorCode, message: string): void {
      for (const b of this.batches.values()) {
         window.clearTimeout(b.timer);
         for (const w of b.waiters) w.reject(new EmailRequestError(code, message));
      }
      this.batches.clear();
   }

   private failAll(code: EmailErrorCode, message: string): void {
      const entries = new Set(this.pending.values());
      this.pending.clear();
      for (const e of entries) {
         window.clearTimeout(e.timer);
         /* A sent move or undo may already have run: its outcome is unknown, not refused. */
         const unknown = e.timeoutCode === "OUTCOME_UNKNOWN" && code !== "CANCELLED";
         e.reject(
            new EmailRequestError(
               unknown ? "OUTCOME_UNKNOWN" : code,
               unknown ? "The connection dropped before DAWN confirmed it" : message
            )
         );
      }
   }

   /* ---- EmailSource --------------------------------------------------------- */

   supportsMoves(): boolean {
      return this.advertised; // archive / trash / undo ride the same email_client flag (P1.2)
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
      if (Array.isArray(p.accounts)) {
         if (!q.accountIds?.length) this.sink?.setUnreadCounts(toCounts(p.accounts));
         this.mergeCaps(p.accounts as Json[]);
      }
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

   async read(
      accountId: number,
      messageId: string,
      markRead: boolean
   ): Promise<{ message: EmailMessage; unread: boolean }> {
      const p = await this.request("email_read", {
         account_id: accountId,
         message_id: messageId,
         mark_read: markRead
      });
      const m = p.message && typeof p.message === "object" ? toMessage(p.message as Json) : null;
      if (!m) throw new EmailRequestError("FAILED", "DAWN sent an empty message");
      return { message: m, unread: p.unread === true };
   }

   async setFlags(
      accountId: number,
      messageIds: string[],
      flags: { unread?: boolean }
   ): Promise<void> {
      if (flags.unread === undefined) return;
      const p = await this.request("email_set_flags", {
         account_id: accountId,
         message_ids: messageIds,
         unread: flags.unread
      });
      const failed = Array.isArray(p.failed) ? (p.failed as Json[]) : [];
      if (failed.length && failed.length === messageIds.length) {
         throw new EmailRequestError(
            (str(failed[0].error_code) || "FAILED") as EmailErrorCode,
            str(failed[0].error) || "Couldn't change it"
         );
      }
   }

   archive(accountId: number, messageIds: string[]): Promise<EmailMoveResult> {
      return this.move("archive", accountId, messageIds);
   }
   trash(accountId: number, messageIds: string[]): Promise<EmailMoveResult> {
      return this.move("trash", accountId, messageIds);
   }

   async undo(accountId: number, tokens: string[]): Promise<EmailUndoResult> {
      const restored: EmailUndoResult["restored"] = [];
      const failed: EmailUndoResult["failed"] = [];
      for (let i = 0; i < tokens.length; i += MOVE_MAX) {
         const chunk = tokens.slice(i, i + MOVE_MAX);
         let p: Json;
         try {
            p = await this.request("email_undo", { account_id: accountId, undo: chunk }, true);
         } catch (e) {
            /* Keep what earlier parts restored; this part's tokens failed with the reason. A lost
               reply (outcome unknown) still rejects, so the caller reloads. */
            if (i === 0 || (e instanceof EmailRequestError && e.code === "OUTCOME_UNKNOWN"))
               throw e;
            const err =
               e instanceof EmailRequestError
                  ? e
                  : new EmailRequestError("FAILED", "Something went wrong");
            for (const t of chunk) failed.push({ undo: t, code: err.code, message: err.message });
            continue;
         }
         for (const r of Array.isArray(p.restored) ? (p.restored as Json[]) : []) {
            restored.push({
               undo: str(r.undo),
               row: r.row && typeof r.row === "object" ? toRow(r.row as Json) : null
            });
         }
         for (const f of Array.isArray(p.failed) ? (p.failed as Json[]) : []) {
            failed.push({
               undo: str(f.undo),
               code: (str(f.error_code) || "FAILED") as EmailErrorCode,
               message: str(f.error)
            });
         }
      }
      return { restored, failed };
   }

   /* ---- moves: batched, never re-sent ---------------------------------------- */

   private move(kind: MoveKind, accountId: number, messageIds: string[]): Promise<EmailMoveResult> {
      if (!this.linked)
         return Promise.reject(new EmailRequestError("UNREACHABLE", "Not connected to DAWN"));
      /* More than one call's worth: split it (each part batches on its own), then join the results. */
      if (messageIds.length > MOVE_MAX) {
         const parts: Promise<EmailMoveResult>[] = [];
         for (let i = 0; i < messageIds.length; i += MOVE_MAX)
            parts.push(this.move(kind, accountId, messageIds.slice(i, i + MOVE_MAX)));
         return Promise.all(parts).then((rs) => ({
            done: rs.flatMap((r) => r.done),
            failed: rs.flatMap((r) => r.failed)
         }));
      }
      return new Promise((resolve, reject) => {
         const key = `${kind}:${accountId}`;
         let b = this.batches.get(key);
         if (b && b.ids.length + messageIds.length > MOVE_MAX) {
            this.flushMove(key); // full: send what's queued, start a new batch
            b = undefined;
         }
         if (!b) {
            b = { accountId, kind, ids: [], waiters: [], timer: 0, due: false };
            this.batches.set(key, b);
            const bb = b;
            b.timer = window.setTimeout(() => {
               if (this.batches.get(key) !== bb) return;
               if (this.inFlight.has(key))
                  bb.due = true; // goes when the running call answers
               else this.flushMove(key);
            }, MOVE_BATCH_MS);
         }
         for (const id of messageIds) if (!b.ids.includes(id)) b.ids.push(id); // one id once per call
         b.waiters.push({ ids: messageIds, resolve, reject });
         if (b.ids.length >= MOVE_MAX) this.flushMove(key);
      });
   }

   private flushMove(key: string): void {
      const b = this.batches.get(key);
      if (!b) return;
      this.batches.delete(key);
      window.clearTimeout(b.timer);
      this.inFlight.add(key);
      this.request(`email_${b.kind}`, { account_id: b.accountId, message_ids: b.ids }, true)
         .then((p) => {
            const done = (Array.isArray(p.done) ? (p.done as Json[]) : []).map((d) => ({
               messageId: str(d.message_id),
               undo: typeof d.undo === "string" && d.undo ? d.undo : null,
               leftFlagged: d.left_flagged === true ? true : undefined
            }));
            const failed = (Array.isArray(p.failed) ? (p.failed as Json[]) : []).map((f) => ({
               messageId: str(f.message_id),
               code: (str(f.error_code) || "FAILED") as EmailErrorCode,
               message: str(f.error)
            }));
            /* Each click gets its own slice: done ids may come back pinned (a new suffix), so match
               on the id without it; failed ids come back as sent. */
            for (const w of b.waiters) {
               const mine = new Set(w.ids.map(baseId));
               w.resolve({
                  done: done.filter((d) => mine.has(baseId(d.messageId))),
                  failed: failed.filter((f) => mine.has(baseId(f.messageId)))
               });
            }
         })
         .catch((e: unknown) => {
            const err =
               e instanceof EmailRequestError
                  ? e
                  : new EmailRequestError("FAILED", "Something went wrong");
            for (const w of b.waiters) w.reject(err);
         })
         .finally(() => {
            this.inFlight.delete(key);
            if (this.batches.get(key)?.due) this.flushMove(key);
         });
   }

   /* email_changed: what a move or undo did, sent to every tab (and after Friday's moves too). */
   private onChanged(p: Json): void {
      const rows = (v: unknown): EmailRow[] => (Array.isArray(v) ? (v as Json[]).map(toRow) : []);
      const kind = p.kind === "trash" || p.kind === "archive" ? p.kind : undefined;
      this.sink?.applyChanges({
         accountId: num(p.account_id),
         state: typeof p.state === "string" ? p.state : null,
         created: rows(p.created),
         updated: rows(p.updated),
         destroyed: Array.isArray(p.destroyed)
            ? (p.destroyed as unknown[]).filter((x): x is string => typeof x === "string")
            : [],
         kind,
         undo: p.undo === true,
         refresh: p.refresh === true
      });
   }

   /* can_trash / can_archive also ride the first page's accounts[]: fold them into the account list. */
   private mergeCaps(list: Json[]): void {
      let changed = false;
      const next = this.accounts.map((a) => {
         const c = list.find((x) => num(x.account_id) === a.id);
         if (!c) return a;
         const canTrash = typeof c.can_trash === "boolean" ? c.can_trash : a.canTrash;
         const canArchive = typeof c.can_archive === "boolean" ? c.can_archive : a.canArchive;
         if (canTrash === a.canTrash && canArchive === a.canArchive) return a;
         changed = true;
         return { ...a, canTrash, canArchive };
      });
      if (changed) {
         this.accounts = next;
         this.sink?.setAccounts(next);
      }
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
      this.failBatches("CANCELLED", "Closed");
      this.failAll("CANCELLED", "Closed");
   }
}
