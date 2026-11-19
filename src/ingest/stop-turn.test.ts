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

/* What the socket's close does for a waiting turn (dawn-ws.ts onclose, then the link status). */
function linkDown(c: ReturnType<typeof client>): void {
   c.ing.setTurnWait(null, true);
   (DawnIngest.prototype as any).emit.call(c.ing, "disconnected");
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

   it("a reply DAWN saved as stopped is adopted with its mark; one it didn't save is marked not saved", () => {
      const c = client(["turn_wait", "stopped_replies_saved"]);
      c.frame("state", { state: "thinking", conversation_id: 7 });
      c.frame("stream_start", { stream_id: 3, conversation_id: 7 });
      c.frame("stream_delta", { delta: "Once upon", conversation_id: 7 });
      c.ing.cancelTurn();
      c.frame("state", { state: "idle" });
      c.frame("stream_end", {
         stream_id: 3,
         conversation_id: 7,
         reason: "stopped",
         will_persist: true
      });
      c.frame("message_appended", {
         conversation_id: 7,
         message_id: 90,
         role: "assistant",
         text: "Once upon a",
         stream_id: 3,
         session_id: c.ing.sessionId,
         stopped: true
      });
      c.frame("state", { state: "idle", conversation_id: 7 });
      expect(c.named("adoptId").at(-1)?.slice(3)).toEqual(["Once upon a", c.ing.sessionId, true]);
      expect(c.named("stoppedUnsaved")).toEqual([]);

      /* Stopped before any text (or while a tool ran): nothing saved, so it says so. */
      c.frame("state", { state: "thinking", conversation_id: 7 });
      c.ing.cancelTurn();
      c.frame("state", { state: "idle" });
      c.frame("state", { state: "idle", conversation_id: 7 });
      expect(c.named("stoppedUnsaved")).toHaveLength(1);
   });

   it("a partial saved in the conversation a reset tool left isn't called unsaved", () => {
      const c = client(["turn_wait", "stopped_replies_saved"]);
      c.frame("state", { state: "thinking", conversation_id: 7 });
      c.frame("conversation_reset", {});
      c.frame("stream_start", { stream_id: 3, conversation_id: 7 });
      c.frame("stream_delta", { delta: "Done, new", conversation_id: 7 });
      c.ing.cancelTurn();
      c.frame("state", { state: "idle" });
      c.frame("stream_end", {
         stream_id: 3,
         conversation_id: 7,
         reason: "stopped",
         will_persist: true
      });
      c.frame("state", { state: "idle", conversation_id: 7 });
      expect(c.named("stoppedUnsaved")).toEqual([]);
   });

   it("an older DAWN (no saved stopped replies): a stopped reply is marked not saved", () => {
      const c = client(["turn_wait"]);
      c.frame("state", { state: "thinking", conversation_id: 7 });
      c.frame("stream_start", { stream_id: 3, conversation_id: 7 });
      c.ing.cancelTurn();
      c.frame("state", { state: "idle" });
      c.frame("stream_end", { stream_id: 3, conversation_id: 7, reason: "error" });
      c.frame("state", { state: "idle", conversation_id: 7 });
      expect(c.named("stoppedUnsaved")).toHaveLength(1);
   });

   it("a stopped row from another tab or a reload carries its mark", () => {
      const c = client(["turn_wait", "stopped_replies_saved"]);
      c.frame("message_appended", {
         conversation_id: 7,
         message_id: 91,
         role: "assistant",
         text: "Half a story",
         stream_id: 0,
         stopped: true
      });
      expect(c.named("renderAppended").at(-1)?.[0]).toMatchObject({ stopped: true });
      c.frame("load_conversation_response", {
         success: true,
         conversation_id: 7,
         messages: [
            { id: 1, role: "user", content: "tell me" },
            { id: 2, role: "assistant", content: "Half a story", stopped: true }
         ]
      });
      const items = c.named("loadHistory").at(-1)?.[0] as Array<{ stopped?: boolean }>;
      expect(items.map((i) => i.stopped)).toEqual([false, true]);
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

   it("stays offered while the reply's speech still plays after DAWN's idle, and stops it here", () => {
      const c = client();
      let speaking = true;
      c.ing.tts.isSpeaking = () => speaking;
      c.frame("state", { state: "thinking", conversation_id: 7 });
      c.frame("state", { state: "speaking", conversation_id: 7 });
      c.frame("state", { state: "idle", conversation_id: 7 });
      expect(c.active()).toBe(true);
      c.ing.cancelTurn();
      expect(c.sent).toEqual([]); // nothing for DAWN to cancel
      expect(c.ing.tts.stop).toHaveBeenCalled();
      expect(c.active()).toBe(false);
      /* Played out on its own instead: Stop goes. */
      c.frame("state", { state: "thinking", conversation_id: 7 });
      c.frame("state", { state: "idle", conversation_id: 7 });
      expect(c.active()).toBe(true);
      speaking = false;
      c.ing.tts.onActive(false); // TtsPlayback's played-out callback
      expect(c.active()).toBe(false);
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

   it("says a voice turn went unsent only for the conversation on screen", () => {
      const c = client();
      c.frame("turn_unsent", { conversation_id: 9, text_saved: false });
      expect(c.named("noteRefusal")).toEqual([]);
      /* Stopped before it ran, no wait shown (DAWN #125). */
      c.frame("turn_unsent", { conversation_id: 7, text_saved: false });
      expect(c.named("noteRefusal")).toHaveLength(1);
      c.frame("turn_waiting", { conversation_id: 7, waiting: true, holder: "turn" });
      c.frame("turn_unsent", { conversation_id: 7, text_saved: false });
      expect(c.named("noteRefusal")).toHaveLength(2);
   });

   it("a typed turn stopped before it ran, even after its grant, comes back by its ref", () => {
      const c = client();
      c.frame("turn_waiting", {
         conversation_id: 7,
         client_ref: "4",
         waiting: true,
         holder: "turn"
      });
      c.frame("turn_waiting", { conversation_id: 7, client_ref: "4", waiting: false });
      c.frame("turn_unsent", { conversation_id: 7, client_ref: "4", text_saved: false });
      expect(c.named("rejectTurn")).toEqual([[{ ref: "4" }, false]]);
      /* A new chat's names conversation 0: still matched by ref. */
      c.frame("turn_unsent", { conversation_id: 0, client_ref: "5", text_saved: false });
      expect(c.named("rejectTurn").at(-1)).toEqual([{ ref: "5" }, false]);
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

   it("a wait is this session's turn to stop, even while another app's reply speaks", () => {
      const c = client();
      c.frame("state", { state: "speaking", conversation_id: 7 }); // another app's reply
      c.frame("turn_waiting", {
         conversation_id: 7,
         client_ref: "3",
         waiting: true,
         holder: "turn"
      });
      c.frame("state", { state: "thinking", conversation_id: 7, detail: "Finishing…" });
      expect(c.active()).toBe(true);
      c.ing.cancelTurn();
      expect(c.sent.map((m) => m.type)).toEqual(["cancel"]);
   });

   it("keeps a waiting turn's draft across a link loss, and shows the wait again on the same session", () => {
      const c = client();
      c.frame("turn_waiting", {
         conversation_id: 7,
         client_ref: "3",
         waiting: true,
         holder: "turn"
      });
      linkDown(c);
      expect(c.named("releaseTurns").at(-1)).toEqual(["3"]);
      c.frame("session", { authenticated: true, token: "t", reconnected: true, session_id: 1 });
      expect(c.named("setTurnWait").at(-1)?.[0]).toMatchObject({ ref: "3" });
      expect(c.active()).toBe(true);
      /* Its echo: it started. */
      c.frame("transcript", { role: "user", text: "hi", client_ref: "3", conversation_id: 7 });
      expect(c.named("setTurnWait").at(-1)).toEqual([null]);
   });

   it("a reload of the same conversation (a takeover reclaim) keeps the waiting message and its wait", () => {
      const c = client();
      c.frame("turn_waiting", {
         conversation_id: 7,
         client_ref: "3",
         waiting: true,
         holder: "turn"
      });
      c.frame("load_conversation_response", { success: true, conversation_id: 7, messages: [] });
      expect(c.named("loadHistory").at(-1)?.[1]).toBe("3");
      expect(c.named("setTurnWait").at(-1)?.[0]).toMatchObject({ ref: "3" });
      /* Another conversation's load lets it go. */
      c.frame("load_conversation_response", { success: true, conversation_id: 9, messages: [] });
      expect(c.named("loadHistory").at(-1)?.[1]).toBeUndefined();
      expect(c.named("setTurnWait").at(-1)).toEqual([null]);
   });

   it("drops the kept wait when the reconnect lands on a fresh session", () => {
      const c = client();
      c.frame("turn_waiting", {
         conversation_id: 7,
         client_ref: "3",
         waiting: true,
         holder: "turn"
      });
      linkDown(c);
      c.frame("session", { authenticated: true, token: "t", reconnected: false, session_id: 2 });
      expect(c.named("releaseTurns").at(-1)).toEqual([]);
      expect(c.named("setTurnWait").at(-1)).toEqual([null]);
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
      /* The user asked for it: the words coming back are the answer, no alert. */
      expect(c.named("noteRefusal")).toHaveLength(0);
      /* One DAWN drops on its own (a shutdown, the connection gone too long) still says so. */
      c.frame("turn_waiting", {
         conversation_id: 7,
         client_ref: "6",
         waiting: true,
         holder: "turn"
      });
      c.frame("turn_unsent", { conversation_id: 7, client_ref: "6", text_saved: false });
      expect(c.named("noteRefusal")).toHaveLength(1);
      /* Nothing is drained: the next turn's frames show. */
      c.frame("state", { state: "thinking", conversation_id: 7 });
      c.frame("stream_delta", { delta: "next", conversation_id: 7 });
      expect(c.named("appendDelta")).toEqual([["next"]]);
   });
});
