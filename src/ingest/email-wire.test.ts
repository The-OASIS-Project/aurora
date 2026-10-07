// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DawnEmail } from "./email-wire.ts";
import type { EmailSink, EmailUnreadCount, EmailAccount, EmailAvailability } from "./email.ts";

type Sent = { type: string; payload?: Record<string, unknown> };

function setup() {
   const sent: Sent[] = [];
   const wire = new DawnEmail((m) => sent.push(m));
   const seen = { availability: "" as EmailAvailability | "", linked: false, accounts: [] as EmailAccount[], counts: [] as EmailUnreadCount[] };
   const sink: EmailSink = {
      setAvailability: (a) => (seen.availability = a),
      setAccounts: (a) => (seen.accounts = a),
      setUnreadCounts: (c) => (seen.counts = c),
      applyChanges: () => {},
      setLinked: (on) => (seen.linked = on),
      setAccountsError: () => {}
   };
   const reply = (type: string, payload: Record<string, unknown>): void => {
      const req = [...sent].reverse().find((m) => m.type === type.replace(/_response$/, ""))?.payload?.req;
      wire.handleFrame(type, { ...payload, req });
   };
   return { wire, sent, sink, seen, reply };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("DawnEmail", () => {
   it("becomes available with the flag + link, and loads the enabled accounts", () => {
      const t = setup();
      t.wire.attach(t.sink);
      t.wire.setLinked(true);
      t.wire.setServerSupport(true);
      expect(t.seen.availability).toBe("available");
      const req = t.sent.find((m) => m.type === "email_list_accounts");
      expect(typeof req?.payload?.req).toBe("string");
      /* DAWN's email_list_accounts reply carries no req (the verb takes no payload). */
      t.wire.handleFrame("email_list_accounts_response", {
         success: true,
         accounts: [
            { id: 3, name: "Work", username: "me@example.org", enabled: true, read_only: false },
            { id: 4, name: "Old", username: "old@example.org", enabled: false, read_only: false }
         ]
      });
      return Promise.resolve().then(() => {
         expect(t.seen.accounts).toEqual([{ id: 3, address: "me@example.org", displayName: "Work", readOnly: false }]);
      });
   });

   it("waits for each connection's config before the panel hears the link, and stays put while down", async () => {
      const t = setup();
      t.wire.attach(t.sink);
      t.wire.setLinked(true);
      expect(t.seen.availability).toBe("unknown");
      expect(t.seen.linked).toBe(false);
      await expect(t.wire.unreadCounts()).rejects.toMatchObject({ code: "UNREACHABLE" });
      expect(t.sent.length).toBe(0);
      t.wire.setServerSupport(true);
      expect(t.seen).toMatchObject({ availability: "available", linked: true });
      /* A blip: the panel shows itself offline with its rows, not "Loading…". */
      t.wire.setLinked(false);
      expect(t.seen).toMatchObject({ availability: "available", linked: false });
      t.wire.setLinked(true);
      expect(t.seen.linked).toBe(false); // not until this connection's config
      t.wire.setServerSupport(true);
      expect(t.seen.linked).toBe(true);
   });

   it("says when the account list fails, retries it, and clears the error once it loads", async () => {
      const t = setup();
      const errors: Array<string | null> = [];
      t.sink.setAccountsError = (m) => errors.push(m);
      t.wire.attach(t.sink);
      t.wire.setLinked(true);
      t.wire.setServerSupport(true);
      t.wire.handleFrame("email_list_accounts_response", { success: false, error: "Failed to list accounts" });
      for (let i = 0; i < 5; i++) await Promise.resolve(); // settle the request's catch + finally
      expect(errors).toEqual(["Failed to list accounts"]);
      vi.advanceTimersByTime(10_001);
      expect(t.sent.filter((m) => m.type === "email_list_accounts").length).toBe(2);
      t.wire.handleFrame("email_list_accounts_response", { success: true, accounts: [] });
      await Promise.resolve();
      expect(errors).toEqual(["Failed to list accounts", null]);
   });

   it("matches a retried account list's tag-less replies once", () => {
      const t = setup();
      t.wire.attach(t.sink);
      t.wire.setLinked(true);
      t.wire.setServerSupport(true);
      vi.advanceTimersByTime(30_001); // retried under a second tag
      expect(t.sent.filter((m) => m.type === "email_list_accounts").length).toBe(2);
      const rows = { success: true, accounts: [{ id: 3, name: "Work", username: "me@example.org", enabled: true }] };
      t.wire.handleFrame("email_list_accounts_response", rows);
      t.wire.handleFrame("email_list_accounts_response", rows); // the twin: nothing pending, dropped
      return Promise.resolve().then(() => expect(t.seen.accounts.map((a) => a.id)).toEqual([3]));
   });

   it("is unavailable without the flag, and reports moves as not yet supported", async () => {
      const t = setup();
      t.wire.attach(t.sink);
      t.wire.setLinked(true);
      t.wire.setServerSupport(false);
      expect(t.seen.availability).toBe("unavailable");
      expect(t.wire.supportsMoves()).toBe(false);
      await expect(t.wire.list({})).rejects.toMatchObject({ code: "UNAVAILABLE" });
   });

   it("matches replies by req (even out of order) and maps rows, cursor, partial, and counts", async () => {
      const t = setup();
      t.wire.attach(t.sink);
      t.wire.setLinked(true);
      t.wire.setServerSupport(true);
      const listP = t.wire.list({ limit: 25 });
      const countsP = t.wire.unreadCounts();
      const listReq = t.sent.find((m) => m.type === "email_list")!;
      expect(listReq.payload).toMatchObject({ folder: "inbox", unread_only: false, limit: 25 });
      expect(listReq.payload?.cursor).toBeUndefined();
      t.reply("email_unread_counts_response", { success: true, accounts: [{ account_id: 3, inbox_unread: null, status: "unreachable" }] });
      t.wire.handleFrame("email_list_response", {
         success: true,
         req: listReq.payload!.req,
         rows: [{ account_id: 3, message_id: "INBOX:42", from_name: "Ann", from_addr: "a@example.com", subject: "Hi", date: 100, preview: "", unread: true }],
         cursor: "abc",
         partial: [{ account_id: 5, error_code: "AUTH_FAILED", error: "refused" }],
         accounts: [{ account_id: 3, inbox_unread: 12, status: "ok" }]
      });
      const list = await listP;
      expect(list.rows[0]).toMatchObject({ accountId: 3, messageId: "INBOX:42", fromName: "Ann", unread: true, preview: "" });
      expect(list.cursor).toBe("abc");
      expect(list.partial).toEqual([{ accountId: 5, code: "AUTH_FAILED", message: "refused" }]);
      expect(t.seen.counts).toEqual([{ accountId: 3, inboxUnread: 12, status: "ok" }]);
      expect(await countsP).toEqual([{ accountId: 3, inboxUnread: null, status: "unreachable" }]);
   });

   it("uses email_search for a query and rejects with the coded error", async () => {
      const t = setup();
      t.wire.attach(t.sink);
      t.wire.setLinked(true);
      t.wire.setServerSupport(true);
      const p = t.wire.list({ query: "invoice", accountIds: [3] });
      expect(t.sent.at(-1)).toMatchObject({ type: "email_search", payload: { query: "invoice", account_ids: [3] } });
      t.reply("email_search_response", { success: false, error_code: "SUPERSEDED", error: "replaced" });
      await expect(p).rejects.toMatchObject({ code: "SUPERSEDED" });
   });

   it("retries a request once when DAWN doesn't answer, then times out", async () => {
      const t = setup();
      t.wire.attach(t.sink);
      t.wire.setLinked(true);
      t.wire.setServerSupport(true);
      const p = t.wire.read(3, "INBOX:42", true);
      const first = t.sent.filter((m) => m.type === "email_read").length;
      vi.advanceTimersByTime(30_001);
      expect(t.sent.filter((m) => m.type === "email_read").length).toBe(first + 1);
      vi.advanceTimersByTime(30_001);
      await expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
   });

   it("lets a slow first reply settle a retried request, and drops the twin's SUPERSEDED", async () => {
      const t = setup();
      t.wire.attach(t.sink);
      t.wire.setLinked(true);
      t.wire.setServerSupport(true);
      const p = t.wire.list({});
      const firstReq = t.sent.filter((m) => m.type === "email_list")[0].payload!.req;
      vi.advanceTimersByTime(30_001); // retried under a new tag
      const secondReq = t.sent.filter((m) => m.type === "email_list")[1].payload!.req;
      expect(secondReq).not.toBe(firstReq);
      /* DAWN: the retry replaced the running first list, which answers SUPERSEDED: ignored. */
      t.wire.handleFrame("email_list_response", { success: false, error_code: "SUPERSEDED", req: firstReq });
      t.wire.handleFrame("email_list_response", { success: true, req: secondReq, rows: [], cursor: null });
      await expect(p).resolves.toMatchObject({ rows: [], cursor: null });

      const r = t.wire.read(3, "INBOX:1", true);
      const readReq = t.sent.filter((m) => m.type === "email_read")[0].payload!.req;
      vi.advanceTimersByTime(30_001); // retry waits behind the first on DAWN's side
      t.wire.handleFrame("email_read_response", { success: true, req: readReq, unread: false, message: { account_id: 3, message_id: "INBOX:1" } });
      await expect(r).resolves.toMatchObject({ unread: false }); // the slow first reply still counts
   });

   it("doesn't forward a filtered first page's counts (they'd wipe the other accounts)", async () => {
      const t = setup();
      t.wire.attach(t.sink);
      t.wire.setLinked(true);
      t.wire.setServerSupport(true);
      const p = t.wire.list({ accountIds: [3] });
      t.reply("email_list_response", { success: true, rows: [], cursor: null, accounts: [{ account_id: 3, inbox_unread: 2, status: "ok" }] });
      await p;
      expect(t.seen.counts).toEqual([]);
   });

   it("maps a read message and fails in-flight requests on a link loss", async () => {
      const t = setup();
      t.wire.attach(t.sink);
      t.wire.setLinked(true);
      t.wire.setServerSupport(true);
      const p = t.wire.read(3, "INBOX:42", false);
      expect(t.sent.at(-1)?.payload).toMatchObject({ account_id: 3, message_id: "INBOX:42", mark_read: false });
      t.reply("email_read_response", {
         success: true,
         unread: true,
         message: {
            account_id: 3, message_id: "INBOX:42", subject: "Lunch", from_name: "Ann", from_addr: "a@example.com",
            to: [{ name: "", addr: "me@example.org" }], cc: [], to_total: 40, reply_to: { name: "", addr: "list@example.com" },
            date: 1, body_text: "hi", body_html: "<p>hi</p>", text_truncated: false, html_truncated: false,
            attachments: [{ part_id: "2", filename: "menu.pdf", mime: "application/pdf", size: 10, inline: false }],
            attachments_truncated: true
         }
      });
      const r = await p;
      expect(r.unread).toBe(true);
      expect(r.message).toMatchObject({ toTotal: 40, replyTo: { addr: "list@example.com" }, bodyHtml: "<p>hi</p>", attachmentsTruncated: true });
      expect(r.message.attachments[0]).toMatchObject({ partId: "2", filename: "menu.pdf" });

      const q = t.wire.unreadCounts();
      t.wire.setLinked(false);
      await expect(q).rejects.toMatchObject({ code: "UNREACHABLE" });
   });
});
