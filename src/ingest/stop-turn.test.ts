// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DawnIngest } from "./dawn-ws.ts";

/* Stop (DAWN's `cancel`) and turn_wait: what a stopped turn still sends is dropped until the turn
   has ended, Stop is offered only for this session's own turn, and a turn waiting for another
   turn on the conversation shows, offers to stop that one, and comes back when it goes unsent. */

type Sent = { type: string; payload?: Record<string, unknown> };
const clients: Array<Record<string, any>> = [];

function client(features: string[] = ["turn_wait"], convId = 7) {
   const calls: Array<[string, unknown[]]> = [];
   const conversation = new Proxy(
      {},
      {
         get:
            (_t, name) =>
            (...args: unknown[]) => {
               calls.push([String(name), args]);
               if (name === "rejectTurn") return "the held words";
               return undefined;
            }
      }
   );
   const notices: string[] = [];
   const sink = new Proxy({}, { get: () => () => undefined });
   const sinks = new Proxy(
      {},
      {
         get: (_t, name) =>
            name === "conversation"
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
   ing.convId = convId;
   Object.assign(ing.tts, {
      queue: vi.fn(),
      play: vi.fn(),
      stop: vi.fn(),
      isSpeaking: () => false
   });
   const frame = (type: string, payload: object): void =>
      ing.onFrame(JSON.stringify({ type, payload }));
   const named = (name: string) => calls.filter(([n]) => n === name).map(([, a]) => a);
   const active = () => named("setTurnActive").at(-1)?.[0];
   return { ing, sent, calls, notices, frame, named, active };
}

beforeEach(() => {
   localStorage.clear();
   vi.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => {
   for (const ing of clients.splice(0)) ing.dispose();
   vi.restoreAllMocks();
});

describe("Stop", () => {
   it("stops the reply, then drops what the stopped turn still sends until its own idle", () => {
      const c = client();
      c.frame("state", { state: "thinking", conversation_id: 7 });
      expect(c.active()).toBe(true);
      c.frame("stream_start", { stream_id: 3, conversation_id: 7 });
      c.frame("stream_delta", { delta: "Hel", conversation_id: 7 });
      c.ing.cancelTurn();
      expect(c.sent.map((m) => m.type)).toEqual(["cancel"]);
      expect(c.named("markStopped")).toHaveLength(1);
      expect(c.active()).toBe(false);
      expect(c.ing.tts.stop).toHaveBeenCalled();
      /* DAWN's ack, written ahead of what the turn had queued. */
      c.frame("state", { state: "idle" });
      c.frame("stream_delta", { delta: "lo", conversation_id: 7 });
      c.frame("state", { state: "speaking", conversation_id: 7 });
      c.ing.onBinary(new Uint8Array([0x11, 1, 2]).buffer);
      expect(c.named("appendDelta")).toEqual([["Hel"]]);
      expect(c.ing.tts.queue).not.toHaveBeenCalled();
      expect(c.active()).toBe(false);
      /* The turn's own end: what follows is the next turn's. */
      c.frame("state", { state: "idle", conversation_id: 7 });
      c.frame("state", { state: "thinking", conversation_id: 7 });
      c.frame("stream_start", { stream_id: 4, conversation_id: 7 });
      c.frame("stream_delta", { delta: "Next", conversation_id: 7 });
      expect(c.named("appendDelta")).toEqual([["Hel"], ["Next"]]);
      expect(c.active()).toBe(true);
   });

   it("ends the drain on the second idle when the stop came before a fresh chat had a conversation", () => {
      const c = client([], 0);
      c.frame("state", { state: "thinking" });
      c.ing.cancelTurn();
      c.frame("state", { state: "idle" }); // the ack
      c.frame("stream_delta", { delta: "late" });
      c.frame("state", { state: "idle" }); // the turn's own, untagged
      c.frame("state", { state: "thinking" });
      c.frame("stream_delta", { delta: "next" });
      expect(c.named("appendDelta")).toEqual([["next"]]);
   });

   it("lets a reply DAWN finished as the Stop landed be adopted, and keeps a finished reply's text", () => {
      const c = client();
      c.frame("state", { state: "thinking", conversation_id: 7 });
      c.frame("stream_start", { stream_id: 3, conversation_id: 7 });
      c.ing.cancelTurn();
      /* A stopped reply ends "error" and isn't saved: nothing to adopt. */
      c.frame("stream_end", { stream_id: 3, conversation_id: 7, reason: "error" });
      expect(c.named("linkStream")).toEqual([]);
      c.frame("stream_end", {
         stream_id: 3,
         conversation_id: 7,
         reason: "complete",
         will_persist: true
      });
      expect(c.named("linkStream")).toEqual([[7, 3, c.ing.sessionId]]);
      expect(c.named("endReply")).toHaveLength(0); // already sealed as stopped
   });

   it("after the text has finished, stops only the speech and marks nothing stopped", () => {
      const c = client();
      c.frame("state", { state: "thinking", conversation_id: 7 });
      c.frame("stream_start", { stream_id: 3, conversation_id: 7 });
      c.frame("stream_end", { stream_id: 3, conversation_id: 7, reason: "complete" });
      c.frame("state", { state: "speaking", conversation_id: 7 });
      expect(c.active()).toBe(true);
      c.ing.cancelTurn();
      expect(c.sent.map((m) => m.type)).toEqual(["cancel"]);
      expect(c.named("markStopped")).toHaveLength(0);
      c.ing.onBinary(new Uint8Array([0x11, 1, 2]).buffer);
      expect(c.ing.tts.queue).not.toHaveBeenCalled();
   });

   it("isn't offered for a job's answer re-engaging the conversation, which may send no idle", () => {
      const c = client();
      c.frame("state", { state: "speaking", conversation_id: 7 });
      c.frame("stream_start", { stream_id: 3, conversation_id: 7 });
      c.frame("stream_end", { stream_id: 3, conversation_id: 7, reason: "tool_iteration" });
      c.frame("state", { state: "thinking", conversation_id: 7, detail: "Processing results..." });
      expect(c.active()).toBe(false);
      c.ing.cancelTurn();
      expect(c.sent).toEqual([]);
      c.frame("stream_start", { stream_id: 4, conversation_id: 7 });
      c.frame("stream_delta", { delta: "Re", conversation_id: 7 });
      c.frame("stream_end", { stream_id: 4, conversation_id: 7, reason: "complete" });
      /* No idle from it; the user's next turn is theirs to stop, and shows. */
      c.frame("state", { state: "idle", conversation_id: 7 });
      c.frame("state", { state: "thinking", conversation_id: 7 });
      expect(c.active()).toBe(true);
      c.frame("stream_start", { stream_id: 5, conversation_id: 7 });
      c.frame("stream_delta", { delta: "NEXT", conversation_id: 7 });
      expect(c.named("appendDelta")).toEqual([["Re"], ["NEXT"]]);
   });

   it("after a reset tool, the stopped turn's own idle (tagged with the old conversation) ends the drain", () => {
      const c = client();
      c.frame("state", { state: "thinking", conversation_id: 7 });
      c.frame("conversation_reset", {});
      c.frame("stream_start", { stream_id: 3, conversation_id: 7 });
      c.frame("stream_delta", { delta: "Done, new", conversation_id: 7 });
      c.ing.cancelTurn();
      c.frame("state", { state: "idle" }); // the ack
      c.frame("stream_delta", { delta: " leftover", conversation_id: 7 });
      c.frame("state", { state: "idle", conversation_id: 7 }); // the turn's own end
      c.ing.convId = 8; // the next message opened a new conversation
      c.frame("state", { state: "thinking", conversation_id: 8 });
      c.frame("stream_start", { stream_id: 4, conversation_id: 8 });
      c.frame("stream_delta", { delta: "NEXT", conversation_id: 8 });
      expect(c.named("appendDelta")).toEqual([["Done, new"], ["NEXT"]]);
   });

   it("drops a stopped reply's chart", () => {
      const c = client();
      c.frame("state", { state: "thinking", conversation_id: 7 });
      c.frame("stream_start", { stream_id: 3, conversation_id: 7 });
      c.ing.cancelTurn();
      c.frame("transcript", { role: "visual", text: "<svg></svg>", conversation_id: 7 });
      expect(c.named("addVisual")).toEqual([]);
   });

   it("isn't offered to a tab that only hears another tab's reply", () => {
      const c = client();
      c.frame("state", { state: "speaking", conversation_id: 7 });
      expect(c.active()).toBe(false);
      c.ing.cancelTurn();
      expect(c.sent).toEqual([]);
   });
});

describe("turn_wait", () => {
   it("is ignored by a DAWN without the flag", () => {
      const c = client([]);
      c.frame("turn_waiting", {
         conversation_id: 7,
         client_ref: "3",
         waiting: true,
         holder: "turn"
      });
      c.frame("turn_unsent", { conversation_id: 7, client_ref: "3", text_saved: false });
      expect(c.named("setTurnWait")).toEqual([]);
      expect(c.named("rejectTurn")).toEqual([]);
   });

   it("shows the wait, stops the other reply on request, and clears when the turn starts", () => {
      const c = client();
      c.frame("turn_waiting", {
         conversation_id: 7,
         client_ref: "3",
         waiting: true,
         holder: "job",
         stop_after_ms: 2000
      });
      expect(c.named("setTurnWait").at(-1)).toEqual([
         { ref: "3", holder: "job", stopAfterMs: 2000, stopping: false }
      ]);
      c.ing.stopOtherReply();
      c.ing.stopOtherReply(); // once
      expect(c.sent).toEqual([{ type: "stop_other_reply", payload: { conversation_id: 7 } }]);
      expect(c.named("setTurnWait").at(-1)?.[0]).toMatchObject({ stopping: true });
      c.frame("stop_other_reply_response", {
         conversation_id: 7,
         success: false,
         error: "NOT_RUNNING"
      });
      expect(c.named("setTurnWait").at(-1)?.[0]).toMatchObject({ stopping: false });
      expect(c.notices).toContain("That reply already finished.");
      c.frame("turn_waiting", { conversation_id: 7, client_ref: "3", waiting: false });
      expect(c.named("setTurnWait").at(-1)).toEqual([null]);
   });

   it("says a voice turn went unsent only for the wait shown here", () => {
      const c = client();
      c.frame("turn_unsent", { conversation_id: 7, text_saved: false });
      expect(c.named("noteRefusal")).toEqual([]);
      c.frame("turn_waiting", { conversation_id: 7, waiting: true, holder: "turn" });
      c.frame("turn_unsent", { conversation_id: 9, text_saved: false });
      expect(c.named("noteRefusal")).toEqual([]);
      c.frame("turn_unsent", { conversation_id: 7, text_saved: false });
      expect(c.named("noteRefusal")).toHaveLength(1);
   });

   it("bounds the delay before offering to stop the other reply", () => {
      const c = client();
      c.frame("turn_waiting", {
         conversation_id: 7,
         client_ref: "3",
         waiting: true,
         holder: "x",
         stop_after_ms: 3e9
      });
      expect(c.named("setTurnWait").at(-1)?.[0]).toMatchObject({
         holder: "turn",
         stopAfterMs: 600_000
      });
   });

   it("ignores a wait on a conversation that isn't on screen", () => {
      const c = client();
      c.frame("turn_waiting", {
         conversation_id: 9,
         client_ref: "3",
         waiting: true,
         holder: "turn"
      });
      expect(c.named("setTurnWait")).toEqual([]);
   });

   it("Stop on a waiting turn sends cancel, and turn_unsent gives the words back", () => {
      const c = client();
      c.frame("state", { state: "thinking", conversation_id: 7, detail: "Finishing the reply…" });
      c.frame("turn_waiting", {
         conversation_id: 7,
         client_ref: "3",
         waiting: true,
         holder: "turn"
      });
      c.ing.cancelTurn();
      expect(c.sent.map((m) => m.type)).toEqual(["cancel"]);
      expect(c.named("markStopped")).toHaveLength(0); // nothing had streamed
      c.frame("state", { state: "idle" });
      c.frame("turn_unsent", { conversation_id: 7, client_ref: "3", text_saved: false });
      expect(c.named("setTurnWait").at(-1)).toEqual([null]);
      expect(c.named("rejectTurn")).toEqual([[{ ref: "3" }, false]]);
      expect(c.named("noteRefusal")).toHaveLength(1);
      /* Nothing is drained: the next turn's frames show. */
      c.frame("state", { state: "thinking", conversation_id: 7 });
      c.frame("stream_delta", { delta: "next", conversation_id: 7 });
      expect(c.named("appendDelta")).toEqual([["next"]]);
   });
});
