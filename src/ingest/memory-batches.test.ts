// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DawnIngest } from "./dawn-ws.ts";

/* The ingest half of the Learned list (memory_batches): nothing is sent to a DAWN that doesn't
   record batches, the frames reach the panel's sink, and a Forget's delete_memory_fact_response
   goes back to the panel rather than the Context panel's handling. */

type Sent = { type: string; payload?: Record<string, unknown> };
const clients: Array<Record<string, any>> = [];

function client(features: string[] = ["memory_batches"], conversation?: object) {
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
               : name === "conversation" && conversation
                 ? conversation
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
      expect(c.ing.listMemoryBatches()).toBe(0);
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

   it("with request_refs, a refused request is settled as failed; a reply settles it once", () => {
      const c = client(["memory_batches", "request_refs"]);
      c.ing.listMemoryBatches();
      c.ing.undoMemoryBatch(4, 2);
      c.ing.forgetMemoryFact(9);
      const reqs = c.sent.map((m) => m.payload?.req);
      expect(reqs).toEqual(["mem-1", "mem-2", "mem-3"]);
      /* DAWN couldn't check the login: each request's only answer is an error naming it. */
      const refuse = (req: unknown) =>
         c.frame("error", {
            code: "SERVICE_UNAVAILABLE",
            message: "Couldn't check the login; try again",
            severity: "error",
            req,
            request_type: "x"
         });
      reqs.forEach(refuse);
      expect(c.calls).toEqual([
         [
            "setPage",
            {
               before: null,
               batches: [],
               nextBefore: null,
               error: "Couldn't check the login; try again",
               request: 1
            }
         ],
         ["actionDone", { kind: "undo", batchId: 4, opId: 2, ok: false }],
         ["actionDone", { kind: "forget", factId: 9, ok: false }]
      ]);
      /* A request that was answered is done: a later error naming it settles nothing. */
      c.ing.keepMemoryOp(4, 3);
      c.frame("keep_memory_op_response", {
         batch_id: 4,
         op_id: 3,
         status: "ok",
         fact_id: 50,
         req: "mem-4"
      });
      refuse("mem-4");
      expect(c.calls.filter(([name]) => name === "actionDone")).toHaveLength(3);
   });

   it("a worker's untagged reply settles the request it answers", () => {
      const c = client(["memory_batches", "request_refs"]);
      c.ing.undoMemoryBatch(4, 2);
      /* DAWN's worker replies without the req: the undo is done all the same. */
      c.frame("undo_memory_batch_response", { batch_id: 4, op_id: 2, status: "ok", undone: [2] });
      expect(c.ing.memoryFeed.memoryReqs.size).toBe(0);
      c.ing.forgetMemoryFact(9);
      c.frame("delete_memory_fact_response", { fact_id: 9, success: true });
      expect(c.ing.memoryFeed.memoryReqs.size).toBe(0);
   });

   it("a refused request that says the login ended also signs out", () => {
      const c = client(["memory_batches", "request_refs"]);
      const signOut = vi.fn(async () => {});
      c.ing.onUnauthorized = signOut;
      c.ing.listMemoryBatches();
      c.frame("error", {
         code: "UNAUTHORIZED",
         message: "Session expired",
         severity: "error",
         req: "mem-1"
      });
      expect(c.calls.map(([name]) => name)).toEqual(["setPage"]);
      expect(signOut).toHaveBeenCalledWith("Session expired");
   });

   it("a page carries the request it answers", () => {
      const c = client(["memory_batches", "request_refs"]);
      expect(c.ing.listMemoryBatches()).toBe(1);
      c.frame("list_memory_batches_response", { before_batch_id: null, batches: [], req: "mem-1" });
      expect((c.calls[0][1] as { request?: number }).request).toBe(1);
   });

   it("a new socket ends the old one's requests, even when the old close was skipped", () => {
      const c = client(["memory_batches", "request_refs"]);
      c.ing.undoMemoryBatch(4, 2); // on the old socket, never answered
      c.ing.forgetMemoryFact(9);
      const sockets: Array<{ onopen: (() => void) | null }> = [];
      vi.stubGlobal(
         "WebSocket",
         Object.assign(
            class {
               static OPEN = 1;
               readyState = 1;
               binaryType = "";
               onopen: (() => void) | null = null;
               onmessage = null;
               onclose = null;
               onerror = null;
               constructor() {
                  sockets.push(this);
               }
               send(): void {}
               close(): void {}
            },
            { OPEN: 1 }
         )
      );
      vi.stubGlobal("__APP_VERSION__", "test"); // the build defines it; the handshake sends it
      /* A reclaim: the new socket opens; the old one's close (which would clean up) never acts. */
      c.ing.openSocket();
      sockets[0].onopen?.();
      expect(c.calls.map(([name]) => name)).toContain("linkDown");
      expect(c.ing.memoryFeed.memoryReqs.size).toBe(0);
      expect(c.ing.memoryFeed.pendingFactForgets.size).toBe(0);
      vi.unstubAllGlobals();
   });

   it("a conversation's own batches are read for its marks, and drawn there", () => {
      const marks: unknown[] = [];
      const c = client(["memory_batches"], { setMemoryMarks: (m: unknown) => marks.push(m) });
      c.ing.memoryFeed.marks.show(7);
      expect(c.sent.at(-1)).toEqual({
         type: "list_memory_batches",
         payload: { conversation_id: 7, limit: 20 }
      });
      c.frame("list_memory_batches_response", {
         conversation_id: 7,
         before_batch_id: null,
         batches: [{ batch_id: 5, conversation_id: 7, after_message_id: 9, ops: [] }],
         has_more: false
      });
      c.frame("memory_batch", { batch_id: 6, conversation_id: 7, after_message_id: 12, ops: [] });
      const last = marks.at(-1) as Array<{ batch: { batchId: number }; live: boolean }>;
      expect(last.map((m) => [m.batch.batchId, m.live])).toEqual([
         [5, false],
         [6, true]
      ]);
      /* The Learned list sees neither as its page; it does get the push. */
      expect(c.calls.map(([name]) => name)).toEqual(["upsertBatch"]);
   });

   it("a typed turn's echo, confirmed, doesn't hide a later turn of the same words", () => {
      const ids = new Set<number>();
      const shown: number[] = [];
      const c = client(["memory_batches", "turn_refs"], {
         hasMessage: (id: number) => ids.has(id),
         noteMessageId: (id: number) => ids.add(id),
         confirmTurn: (_t: string, _r: string, id: number) => ids.add(id), // stamps the bubble
         showUser: (_t: string, id: number) => shown.push(id),
         setMemoryMarks: () => {}
      });
      c.ing.typedEchoes.push({ text: "lights on", at: performance.now(), ref: "1" });
      c.frame("transcript", { role: "user", text: "lights on", message_id: 14, client_ref: "1" });
      /* A spoken turn with the same words a moment later (another viewer's, or the voice path). */
      c.frame("transcript", { role: "user", text: "lights on", message_id: 20 });
      expect(shown).toEqual([20]);
   });

   it("without request_refs nothing is tagged", () => {
      const c = client();
      c.ing.listMemoryBatches();
      expect(c.sent[0].payload).not.toHaveProperty("req");
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
