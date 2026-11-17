// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DawnIngest } from "./dawn-ws.ts";

/* The ingest half of the Learned list (memory_batches): nothing is sent to a DAWN that doesn't
   record batches, the frames reach the panel's sink, and a Forget's delete_memory_fact_response
   goes back to the panel rather than the Context panel's handling. */

type Sent = { type: string; payload?: Record<string, unknown> };
const clients: Array<Record<string, any>> = [];

function client(features: string[] = ["memory_batches"]) {
   const calls: Array<[string, unknown]> = [];
   const memoryBatches = new Proxy(
      {},
      { get: (_t, name) => (arg: unknown) => calls.push([String(name), arg]) }
   );
   const notices: string[] = [];
   const sink = new Proxy({}, { get: () => () => undefined });
   const sinks = new Proxy(
      {},
      {
         get: (_t, name) =>
            name === "memoryBatches"
               ? memoryBatches
               : name === "notifications"
                 ? {
                      notify: (n: { summary: string }) => notices.push(n.summary),
                      remove: () => undefined
                   }
                 : sink
      }
   );
   const ing = new DawnIngest() as unknown as Record<string, any>;
   clients.push(ing);
   ing.emit = () => {};
   ing.start(sinks);
   const sent: Sent[] = [];
   ing.ws = {
      readyState: WebSocket.OPEN,
      send: (t: string) => sent.push(JSON.parse(t)),
      close: () => {}
   };
   ing.serverFeatures = new Set(features);
   const frame = (type: string, payload: object): void =>
      ing.onFrame(JSON.stringify({ type, payload }));
   return { ing, sent, calls, notices, frame };
}

beforeEach(() => {
   localStorage.clear();
   vi.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => {
   for (const ing of clients.splice(0)) ing.dispose();
   vi.restoreAllMocks();
});

describe("the Learned list over the wire", () => {
   it("sends nothing to a DAWN that doesn't record batches", () => {
      const c = client([]);
      expect(c.ing.listMemoryBatches()).toBe(false);
      expect(c.ing.undoMemoryBatch(4, null)).toBe(false);
      expect(c.ing.keepMemoryOp(4, 2)).toBe(false);
      expect(c.ing.forgetMemoryFact(9)).toBe(false);
      expect(c.sent).toEqual([]);
   });

   it("sends the verbs as DAWN takes them", () => {
      const c = client();
      c.ing.listMemoryBatches();
      c.ing.listMemoryBatches(380);
      c.ing.undoMemoryBatch(412, null);
      c.ing.undoMemoryBatch(412, 9001);
      c.ing.keepMemoryOp(412, 9010);
      expect(c.sent).toEqual([
         { type: "list_memory_batches", payload: { limit: 20 } },
         { type: "list_memory_batches", payload: { limit: 20, before_batch_id: 380 } },
         { type: "undo_memory_batch", payload: { batch_id: 412 } },
         { type: "undo_memory_batch", payload: { batch_id: 412, op_id: 9001 } },
         { type: "keep_memory_op", payload: { batch_id: 412, op_id: 9010 } }
      ]);
   });

   it("routes pages and pushes to the panel; a removed batch by its id", () => {
      const c = client();
      c.frame("list_memory_batches_response", {
         before_batch_id: null,
         batches: [{ batch_id: 5, ops: [] }],
         has_more: false
      });
      c.frame("list_memory_batches_response", { conversation_id: 7, batches: [] }); // a marker's
      c.frame("memory_batch", { batch_id: 6, status: "applied", ops: [] });
      c.frame("memory_batch", { batch_id: 6, removed: true });
      expect(c.calls.map(([name]) => name)).toEqual(["setPage", "upsertBatch", "removeBatch"]);
      expect(c.calls[2][1]).toBe(6);
   });

   it("a Forget's reply is the panel's; any other fact delete keeps its own handling", () => {
      const c = client();
      c.ing.forgetMemoryFact(77);
      expect(c.sent.at(-1)).toEqual({ type: "delete_memory_fact", payload: { fact_id: 77 } });
      c.frame("delete_memory_fact_response", {
         fact_id: 77,
         success: false,
         error: "Memory is busy with another change; try again shortly"
      });
      expect(c.calls).toEqual([["actionDone", { kind: "forget", factId: 77, ok: false }]]);
      expect(c.notices).toEqual(["Memory is busy with another change; try again shortly"]);
      /* A Context-panel delete of the same fact afterwards isn't the panel's. */
      c.frame("delete_memory_fact_response", { fact_id: 77, success: true });
      expect(c.calls).toHaveLength(1);
   });

   it("an undo says how it went only when it didn't simply work", () => {
      const c = client();
      c.frame("undo_memory_batch_response", { batch_id: 4, status: "ok", undone: [1], stale: [] });
      expect(c.notices).toEqual([]);
      c.frame("undo_memory_batch_response", {
         batch_id: 4,
         status: "partial",
         undone: [1, 2],
         stale: [3]
      });
      c.frame("undo_memory_batch_response", {
         batch_id: 4,
         op_id: 2,
         status: "error",
         error: "Couldn't undo this right now. Try again in a moment."
      });
      expect(c.notices).toEqual([
         "Undid 2; 1 item changed since and stayed as it is.",
         "Couldn't undo this right now. Try again in a moment."
      ]);
      expect(c.calls.map(([, r]) => r)).toEqual([
         { kind: "undo", batchId: 4, opId: null, ok: true },
         { kind: "undo", batchId: 4, opId: null, ok: false },
         { kind: "undo", batchId: 4, opId: 2, ok: false }
      ]);
   });

   it("a reply with no usable ids still ends the action that was running", () => {
      const c = client();
      c.frame("undo_memory_batch_response", { status: "error", error: "Not found" });
      c.frame("keep_memory_op_response", { status: "ok", fact_id: 5 });
      expect(c.calls.map(([, r]) => r)).toEqual([
         { kind: "undo", batchId: 0, opId: null, ok: false },
         { kind: "keep", batchId: 0, opId: 0, ok: false, factId: null }
      ]);
   });

   it("a keep reports the fact it stored", () => {
      const c = client();
      c.frame("keep_memory_op_response", { batch_id: 4, op_id: 9, status: "ok", fact_id: 88 });
      expect(c.calls).toEqual([
         ["actionDone", { kind: "keep", batchId: 4, opId: 9, ok: true, factId: 88 }]
      ]);
   });

   it("the config frame offers the list only when DAWN advertises it, and asks for a fresh page", () => {
      const off = client([]);
      off.frame("config", { protocol: 1, features: [] });
      expect(off.calls).toEqual([["setAvailable", false]]);
      const on = client();
      on.frame("config", { protocol: 1, features: ["memory_batches"] });
      expect(on.calls.map(([name]) => name)).toEqual(["setAvailable", "linkUp"]);
   });
});
