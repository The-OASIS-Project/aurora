import { describe, expect, it } from "vitest";
import { EmailSim } from "./email-sim.ts";
import type { EmailChanges, EmailSink } from "./email.ts";

const quiet = (): EmailSim => new EmailSim({ latency: [0, 0], changeEverySec: 0, flakyRate: 0 });

function recorder(): EmailSink & { changes: EmailChanges[] } {
   const changes: EmailChanges[] = [];
   return {
      changes,
      setAvailability: () => {},
      setAccounts: () => {},
      setUnreadCounts: () => {},
      setLinked: () => {},
      applyChanges: (c) => changes.push(c)
   };
}

describe("EmailSim paging", () => {
   it("pages the merged list newest-first with no gaps or repeats", async () => {
      const sim = quiet();
      const seen = new Set<string>();
      let prevDate = Infinity;
      let cursor: string | null | undefined;
      let pages = 0;
      do {
         const r = await sim.list({ cursor: cursor ?? undefined, limit: 50 });
         for (const row of r.rows) {
            const key = `${row.accountId}/${row.messageId}`;
            expect(seen.has(key)).toBe(false);
            seen.add(key);
            expect(row.date).toBeLessThanOrEqual(prevDate);
            prevDate = row.date;
         }
         cursor = r.cursor;
         pages++;
      } while (cursor && pages < 50);
      expect(cursor).toBeNull();
      expect(seen.size).toBe(345); // 160 + 120 + 60 + 5 specials
   });

   it("refuses a cursor from a different filter", async () => {
      const sim = quiet();
      const first = await sim.list({ limit: 10 });
      await expect(sim.list({ cursor: first.cursor!, unreadOnly: true })).rejects.toMatchObject({ code: "CURSOR_STALE" });
      await expect(sim.list({ cursor: "garbage" })).rejects.toMatchObject({ code: "CURSOR_STALE" });
   });

   it("filters by account, unread, and query", async () => {
      const sim = quiet();
      const work = await sim.list({ accountIds: [2], limit: 50 });
      expect(work.rows.every((r) => r.accountId === 2)).toBe(true);
      const unread = await sim.list({ unreadOnly: true, limit: 50 });
      expect(unread.rows.every((r) => r.unread)).toBe(true);
      const q = await sim.list({ query: "receipt", limit: 50 });
      expect(q.rows.some((r) => r.subject.includes("receipt"))).toBe(true);
   });

   it("reports a revoked account as a partial failure", async () => {
      const sim = new EmailSim({ latency: [0, 0], changeEverySec: 0, flakyRate: 0, revoked: true });
      const r = await sim.list({ limit: 20 });
      expect(r.partial).toEqual([expect.objectContaining({ accountId: 2, code: "AUTH_REVOKED" })]);
      expect(r.rows.some((x) => x.accountId === 2)).toBe(false);
   });
});

describe("EmailSim triage", () => {
   it("marks read on open and pushes the change", async () => {
      const sim = quiet();
      const sink = recorder();
      sim.attach(sink);
      const row = (await sim.list({ unreadOnly: true, accountIds: [1], limit: 1 })).rows[0];
      const r = await sim.read(1, row.messageId, true);
      expect(r.unread).toBe(false);
      expect(sink.changes.at(-1)?.updated[0]).toMatchObject({ messageId: row.messageId, unread: false });
   });

   it("trashes with an undo that restores once, with a new id on IMAP", async () => {
      const sim = quiet();
      const sink = recorder();
      sim.attach(sink);
      const row = (await sim.list({ accountIds: [2], limit: 1 })).rows[0];
      const t = await sim.trash(2, [row.messageId]);
      expect(t.done).toHaveLength(1);
      expect(sink.changes.at(-1)?.destroyed).toEqual([row.messageId]);
      await expect(sim.read(2, row.messageId, false)).rejects.toMatchObject({ code: "NOT_FOUND" });

      const u = await sim.undo(2, [t.done[0].undo]);
      expect(u.restored).toHaveLength(1);
      expect(u.restored[0].row.messageId).not.toBe(row.messageId); // new UID after the move back
      expect(sink.changes.at(-1)?.created[0].messageId).toBe(u.restored[0].row.messageId);

      const again = await sim.undo(2, [t.done[0].undo]);
      expect(again.failed).toHaveLength(1); // single use
   });

   it("refuses writes on a read-only account", async () => {
      const sim = quiet();
      const row = (await sim.list({ accountIds: [3], limit: 1 })).rows[0];
      const r = await sim.archive(3, [row.messageId]);
      expect(r.failed[0].code).toBe("READ_ONLY");
      await expect(sim.setFlags(3, [row.messageId], { unread: true })).rejects.toMatchObject({ code: "READ_ONLY" });
   });
});
