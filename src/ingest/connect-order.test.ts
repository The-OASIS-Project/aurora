// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DawnIngest } from "./dawn-ws.ts";
import { setAppLogins } from "../util/dawn-app.ts";
import { CONVERSATION_ID, SCENARIOS, connectFrames } from "../../tests/fake-dawn/scenarios.ts";

/* What Aurora asks DAWN for when it connects, in order: the handshake and the reads it sends as
   the socket opens, then what the session, config and state frames add. Several replies are
   matched to their request by order, so moving one of these sends (splitting dawn-ws.ts into
   modules, say) must keep the sequence; this pins it. */

class FakeSocket {
   static last: FakeSocket | null = null;
   static readonly OPEN = 1;
   readyState = 0;
   binaryType = "";
   readonly sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];
   onopen: (() => void) | null = null;
   onmessage: ((ev: { data: string }) => void) | null = null;
   onclose: ((ev: unknown) => void) | null = null;
   onerror: (() => void) | null = null;
   constructor(
      readonly url: string,
      readonly protocol: string
   ) {
      FakeSocket.last = this;
   }
   send(t: string): void {
      this.sent.push(JSON.parse(t));
   }
   close(): void {}
}

let ing: Record<string, any> | null = null;
beforeEach(() => {
   localStorage.clear();
   setAppLogins(false);
   vi.stubGlobal("WebSocket", FakeSocket);
   vi.stubGlobal("__APP_VERSION__", "0.0.0-test"); // defined by Vite at build time
   vi.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => {
   ing?.dispose();
   ing = null;
   vi.restoreAllMocks();
   vi.unstubAllGlobals();
});

/* Sinks that accept every call and do nothing. */
const sinks = new Proxy({}, { get: () => new Proxy({}, { get: () => () => undefined }) });

function connect(): FakeSocket {
   ing = new DawnIngest();
   ing.start(sinks);
   ing.openSocket();
   const ws = FakeSocket.last!;
   ws.readyState = FakeSocket.OPEN;
   ws.onopen!();
   return ws;
}

/* What the socket's open sends first, after the handshake (the same either way). */
const ON_OPEN = [
   "get_config",
   "get_my_settings",
   "list_llm_models",
   "list_conversations",
   "jobs_request",
   "music_subscribe",
   "calendar_list_my_calendars",
   "calendar_upcoming_events",
   "doc_library_list",
   "ha_status",
   "ha_list_entities",
   "watch_list"
];
/* What the session, config and state frames add. */
const AFTER_FRAMES = [
   "calendar_list_my_calendars",
   "calendar_upcoming_events",
   "ping",
   "phone_status"
];

function types(ws: FakeSocket): string[] {
   for (const f of connectFrames(SCENARIOS.signedIn)) ws.onmessage!({ data: JSON.stringify(f) });
   return ws.sent.map((m) => m.type);
}

it("a first connect: init, then the reads, in order", () => {
   const ws = connect();
   expect(ws.sent[0]).toEqual({
      type: "init",
      payload: {
         capabilities: { audio_codecs: ["pcm"] },
         tts_enabled: true,
         tool_step_origin: true,
         session_keepalive: false,
         client: { name: "aurora", version: "0.0.0-test", protocol: 1 }
      }
   });
   expect(types(ws)).toEqual(["init", ...ON_OPEN, "get_metrics", ...AFTER_FRAMES]);
});

it("a reload: reconnect with the stored session, and the live feeds re-armed in order", () => {
   const token = "a1".repeat(16);
   localStorage.setItem("dawn.hero.sessionToken", token);
   ing = new DawnIngest();
   ing.start(sinks);
   /* What the panels asked for before the reload (no socket yet: only the intent is kept). */
   ing.watchReadingsSubscribe(true);
   ing.stocksPortfolioSubscribe(true, false);
   ing.stocksWatchSubscribe(true, true);
   ing.openSocket();
   const ws = FakeSocket.last!;
   ws.readyState = FakeSocket.OPEN;
   ws.onopen!();
   expect(ws.sent[0]).toMatchObject({ type: "reconnect", payload: { token } });
   expect(types(ws)).toEqual([
      "reconnect",
      ...ON_OPEN,
      "watch_readings_subscribe",
      "stocks_portfolio_subscribe",
      "stocks_watch_subscribe",
      "get_metrics",
      ...AFTER_FRAMES
   ]);
   expect(ws.sent.find((m) => m.type === "stocks_watch_subscribe")?.payload).toEqual({
      ext_hours: true
   });
});

it("a dropped link with a conversation open: the restore goes in its place", () => {
   for (const reconnected of [false, true]) {
      const first = connect();
      types(first);
      ing!.convId = CONVERSATION_ID; // opened and drawn before the link dropped
      ing!.drawnConvId = CONVERSATION_ID;
      ing!.openSocket();
      const ws = FakeSocket.last!;
      ws.readyState = FakeSocket.OPEN;
      ws.onopen!();
      const session = { token: "0".repeat(32), reconnected, sessionId: 2 };
      for (const f of connectFrames(SCENARIOS.signedIn, session))
         ws.onmessage!({ data: JSON.stringify(f) });
      /* A fresh session lost the model's history, so it loads in full; its own session keeps
         it, so only the pointer is re-set. The zone is known by now: no calendar re-ask. */
      const restore = reconnected ? "set_active_conversation" : "load_conversation";
      expect(ws.sent.map((m) => m.type)).toEqual([
         "reconnect",
         ...ON_OPEN,
         "get_metrics",
         "ping",
         "phone_status",
         restore
      ]);
      expect(ws.sent.at(-1)?.payload).toMatchObject({ conversation_id: CONVERSATION_ID });
      ing!.dispose();
   }
});
