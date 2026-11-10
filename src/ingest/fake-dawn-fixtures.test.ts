// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DawnIngest } from "./dawn-ws.ts";
import { setAppLogins } from "../util/dawn-app.ts";
import { ANSWERED, FakeDawn, INTERACTIVE, type Delivery } from "../../tests/fake-dawn/fake-dawn.ts";
import {
   CONVERSATION_ID,
   SCENARIOS,
   TRANSCRIPT,
   USERNAME,
   answerFrame,
   connectFrames,
   superseded,
   unknownType
} from "../../tests/fake-dawn/scenarios.ts";

/* The fake DAWN's fixtures (tests/fake-dawn/, used by the smoke test) round-tripped through the
   real client: each frame must be one DawnIngest handles, and must mean to it what the fixture
   says. The client parses leniently, so a stale fixture would otherwise just render less, and the
   smoke test, which checks only the core screen, could miss it. docs/FAKE_DAWN_PLAN.md phase 1c.

   Many fixtures are empty (no jobs, no watches, nothing queued), and the client reads a missing
   field as its empty default, so a renamed key there would look the same. Those tests also check
   that the fixture still carries each key the client reads (`carries`). */

type Call = { sink: string; method: string; args: unknown[] };

/* Every client made in a test, torn down after it (timers, the storage listener). */
const clients: Array<Record<string, any>> = [];

/* The verbs whose answers this file round-trips: each `answer()` call adds its verb. A meta-test
   checks it covers every verb the fake answers, so a new answer can't go untested. */
const tested = new Set<string>(["init", "reconnect"]); // the connect frames, tested below
/* The interactive requests the tests below send (the same check for INTERACTIVE). */
const interacted = new Set<string>();
function answer(verb: string, payload: Record<string, unknown> = {}): object[] {
   tested.add(verb);
   return answerFrame(verb, payload);
}

/* The fixture frame's payload still carries each key the client reads. */
function carries(frame: object, keys: string[]): void {
   expect(Object.keys((frame as { payload: object }).payload)).toEqual(
      expect.arrayContaining(keys)
   );
}

/* A DawnIngest with recording sinks and a socket that records what the client sends. */
function client() {
   const calls: Call[] = [];
   const sinks = new Proxy(
      {},
      {
         get: (_t, sink) =>
            new Proxy(
               {},
               {
                  get:
                     (_u, method) =>
                     (...args: unknown[]) => {
                        calls.push({ sink: String(sink), method: String(method), args });
                        return undefined;
                     }
               }
            )
      }
   );
   const ing = new DawnIngest() as unknown as Record<string, any>;
   clients.push(ing);
   const statuses: Array<[string, string | undefined]> = [];
   ing.emit = (s: string, d?: string) => statuses.push([s, d]);
   ing.start(sinks);
   const sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];
   ing.ws = {
      readyState: WebSocket.OPEN,
      send: (t: string) => sent.push(JSON.parse(t)),
      close: () => {}
   };
   const frame = (f: object): void => ing.onFrame(JSON.stringify(f));
   const called = (sink: string, method: string): unknown[][] =>
      calls.filter((c) => c.sink === sink && c.method === method).map((c) => c.args);
   return { ing, calls, sent, statuses, frame, called };
}

let debug: { mock: { calls: unknown[][] } };
beforeEach(() => {
   localStorage.clear();
   setAppLogins(false); // module state: one test learning app_logins mustn't leak into the next
   debug = vi.spyOn(console, "debug").mockImplementation(() => {});
   vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
   /* The client logs a frame it has no handler for: none of the fake's frames may be one. Read
      before the teardown, asserted after it, so a failure here can't leave mocks for the next
      test. */
   const unhandled = debug.mock.calls.filter((c) => String(c[0]).includes("unhandled frame"));
   for (const ing of clients.splice(0)) ing.dispose();
   vi.restoreAllMocks();
   vi.unstubAllGlobals();
   expect(unhandled).toEqual([]);
});

describe("the connect frames", () => {
   it("session: stores the token and takes the user's zone", () => {
      const c = client();
      const token = "a1".repeat(16);
      c.frame(connectFrames(SCENARIOS.signedIn, { token, reconnected: false, sessionId: 3 })[0]);
      expect(localStorage.getItem("dawn.hero.sessionToken")).toBe(token);
      expect(c.called("telemetry", "setTimezone")).toEqual([["UTC"]]);
   });

   it("config: the flags, the version, and no music socket", () => {
      const c = client();
      for (const f of connectFrames(SCENARIOS.signedIn).slice(0, 3)) c.frame(f);
      expect([...c.ing.serverFeatures].sort()).toEqual([...SCENARIOS.signedIn.features].sort());
      expect(c.ing.dawnVersion).toBe("0.0.0-fake");
      expect(c.ing.musicEnabled).toBe(false);
   });

   it("config from an older DAWN: no flags at all", () => {
      const c = client();
      c.frame(connectFrames(SCENARIOS.legacyDawn)[1]);
      expect(c.ing.serverFeatures).toBeNull();
   });

   it("config with a newer protocol: stops with the message", () => {
      const c = client();
      c.frame(connectFrames(SCENARIOS.upgradedMidLoad)[1]);
      expect(c.statuses).toContainEqual([
         "error",
         "DAWN v0.0.0-fake is newer than this Aurora. Update Aurora to connect."
      ]);
   });

   it("state: the reactor goes idle", () => {
      const c = client();
      c.frame(connectFrames(SCENARIOS.signedIn)[3]);
      expect(c.called("reactor", "setState")).toEqual([["idle"]]);
   });
});

describe("the answers", () => {
   it("get_config: the assistant's name and the session's model", () => {
      const c = client();
      for (const f of answer("get_config", {})) c.frame(f);
      expect(c.called("conversation", "setAssistantName")).toEqual([["Friday"]]);
      expect(c.ing.llm.provider).toBe("claude");
      expect(c.ing.llm.model).toBe("claude-sonnet-5-5");
      expect(c.ing.cloudModels.claude).toEqual(["claude-sonnet-5-5"]);
      /* The model's reasoning caps parsed: off or adaptive, adaptive by default. */
      const caps = c.ing.cloudCaps.claude["claude-sonnet-5-5"];
      expect(caps.modes.map((m: { mode: string }) => m.mode)).toEqual(["disabled", "adaptive"]);
      expect(c.called("telemetry", "update")).toContainEqual([
         { effort: "MEDIUM", provider: "Claude", model: "claude-sonnet-5-5" }
      ]);
   });

   it("get_my_settings (an older DAWN, no zone on its session frame): the server's zone", () => {
      const c = client();
      const frames = answer("get_my_settings", {});
      carries(frames[0], ["timezone", "server_timezone"]);
      for (const f of frames) c.frame(f); // timezone "" = the server's: server_timezone
      expect(c.called("telemetry", "setTimezone")).toEqual([["UTC"]]);
   });

   it("list_llm_models: no local models", () => {
      const c = client();
      c.ing.localModels = ["stale"];
      const frames = answer("list_llm_models", {});
      carries(frames[0], ["models"]);
      for (const f of frames) c.frame(f);
      expect(c.ing.localModels).toEqual([]);
   });

   it("list_conversations: the row, and the remembered conversation is opened", () => {
      localStorage.setItem("dawn.hero.convId", String(CONVERSATION_ID));
      const c = client();
      for (const f of answer("list_conversations", {})) c.frame(f);
      const [rows] = c.called("conversationList", "setList")[0] as [
         Array<{ id: number; title: string }>
      ];
      expect(rows.map((r) => [r.id, r.title])).toEqual([[CONVERSATION_ID, TRANSCRIPT.title]]);
      expect(c.sent).toContainEqual({
         type: "load_conversation",
         payload: { conversation_id: CONVERSATION_ID }
      });
   });

   it("load_conversation: the transcript, its title, and the conversation's model", () => {
      const c = client();
      for (const f of answer("load_conversation", { conversation_id: CONVERSATION_ID })) c.frame(f);
      const [items] = c.called("conversation", "loadHistory")[0] as [
         Array<{ role: string; text: string }>
      ];
      expect(items.map((i) => [i.role, i.text])).toEqual([
         ["user", TRANSCRIPT.user],
         ["assistant", TRANSCRIPT.assistant]
      ]);
      expect(c.ing.convId).toBe(CONVERSATION_ID);
      expect(c.called("telemetry", "update")).toContainEqual([{ title: TRANSCRIPT.title }]);
      expect(c.ing.llm.model).toBe("claude-sonnet-5-5");
   });

   it("load_conversation of a conversation that's gone: a fresh chat, silently", () => {
      localStorage.setItem("dawn.hero.convId", "7");
      const c = client();
      c.ing.convId = 7;
      c.ing.resumingStored = true;
      for (const f of answer("load_conversation", { conversation_id: 7 })) c.frame(f);
      expect(c.ing.convId).toBe(0);
      expect(localStorage.getItem("dawn.hero.convId")).toBeNull();
      expect(c.called("conversation", "loadHistory")).toEqual([]);
   });

   it("jobs_request: no active jobs, so no jobs card", () => {
      const c = client();
      const frames = answer("jobs_request", {});
      carries(frames[0], ["jobs", "truncated"]);
      /* A stale job, which the snapshot must replace. */
      c.ing.jobs.set(99, { conversation_id: 99, status: "running" });
      for (const f of frames) c.frame(f);
      expect(c.ing.jobs.size).toBe(0);
      expect(c.called("notifications", "remove")).toEqual([["jobs"]]);
   });

   it("music_subscribe: stopped, nothing queued", () => {
      const c = client();
      const frames = answer("music_subscribe", {});
      carries(frames[0], [
         "playing",
         "paused",
         "track",
         "position_sec",
         "queue_length",
         "queue_index",
         "queue_rev",
         "shuffle",
         "repeat_mode"
      ]);
      for (const f of frames) c.frame(f);
      const [state] = c.called("music", "setState")[0] as [Record<string, unknown>];
      expect(state).toMatchObject({
         playing: false,
         paused: false,
         track: null,
         queueLength: 0,
         queueIndex: 0,
         queueRev: 0,
         repeatMode: 0
      });
   });

   it("get_metrics: the averages and the uptime", () => {
      const c = client();
      for (const f of answer("get_metrics", {})) c.frame(f);
      expect(c.called("telemetry", "update")).toContainEqual([{ ttft: "400ms", lat: "1700ms" }]);
      expect(c.called("telemetry", "update")).toContainEqual([{ up: "01:00:00" }]);
   });

   it("ping: the pong answers the ping the client sent, and confirms the login", () => {
      const c = client();
      c.frame(connectFrames(SCENARIOS.signedIn)[0]); // the session starts the heartbeat
      const ping = c.sent.find((m) => m.type === "ping");
      expect(ping?.payload?.seq).toBeGreaterThan(0);
      c.ing.unconfirmedRevokes = 2;
      for (const f of answer("ping", ping!.payload)) c.frame(f);
      expect(c.ing.unconfirmedRevokes).toBe(0);
      expect(c.ing.pendingPingSeq).toBe(0); // matched by seq (a pong without it leaves this set)
      expect(c.ing.pongSupported).toBe(true);
   });

   it("watch_list and watch_readings_subscribe: no watches, attention armed", () => {
      const c = client();
      const frames = answer("watch_list", {});
      carries(frames[0], ["success", "attention_enabled", "watches", "catalog"]);
      for (const f of frames) c.frame(f);
      for (const f of answer("watch_readings_subscribe", {})) c.frame(f);
      expect(c.called("watches", "setWatches")).toEqual([[[], []]]);
      expect(c.called("watches", "setStatus")).toEqual([[{ ok: true, attentionEnabled: true }]]);
   });

   it("doc_library_list: an empty library", () => {
      const c = client();
      const frames = answer("doc_library_list", {});
      carries(frames[0], ["success", "documents", "has_more"]);
      for (const f of frames) c.frame(f);
      expect(c.called("library", "setItems")).toEqual([
         [[], { append: false, searching: false, hasMore: false }]
      ]);
   });

   it("set_active_conversation: a reconnect's re-anchor lands on the conversation", () => {
      const c = client();
      c.ing.convId = CONVERSATION_ID;
      c.ing.reanchoring = true;
      for (const f of answer("set_active_conversation", { conversation_id: CONVERSATION_ID }))
         c.frame(f);
      expect(c.called("conversationList", "setActive")).toEqual([[CONVERSATION_ID]]);
      expect(localStorage.getItem("dawn.hero.convId")).toBe(String(CONVERSATION_ID));
      expect(c.ing.reanchoring).toBe(false);
   });

   it("set_active_conversation without an id: DAWN's own refusal", () => {
      expect(answer("set_active_conversation", {})[0]).toEqual({
         type: "set_active_conversation_response",
         payload: { success: false, error: "Missing conversation id" }
      });
   });

   it("set_active_conversation of a conversation that's gone: a fresh chat", () => {
      const c = client();
      c.ing.convId = 999;
      c.ing.reanchoring = true;
      const reply = answer("set_active_conversation", { conversation_id: 999 });
      expect(reply[0]).toEqual({
         type: "set_active_conversation_response",
         payload: { success: false, conversation_id: 999, error: "Conversation unavailable" }
      });
      for (const f of reply) c.frame(f);
      expect(c.ing.convId).toBe(0);
      expect(c.called("conversationList", "setActive")).toEqual([[0]]);
   });

   it("UNKNOWN_TYPE for an optional subsystem: quiet, and not asked again", () => {
      const c = client();
      c.frame(unknownType("ha_status"));
      c.frame(unknownType("calendar_upcoming_events"));
      expect(c.called("ha", "setStatus")).toEqual([
         [
            {
               configured: false,
               connected: false,
               error: "Home Assistant isn't available on this DAWN"
            }
         ]
      ]);
      expect(c.called("calendar", "setUnsupported")).toEqual([[true]]);
      expect(c.called("notifications", "notify")).toEqual([]); // no "doesn't handle" card
      expect([...c.ing.unsupportedTypes].sort()).toEqual(["calendar_upcoming_events", "ha_status"]);
   });
});

describe("/api/auth/status through the fake", () => {
   /* fetch answered by the fake's HTTP side, exactly as the smoke test's route does. */
   function statusVia(fake: FakeDawn): void {
      vi.stubGlobal(
         "fetch",
         vi.fn((url: string) => {
            const reply = fake.http("GET", new URL(url, "http://localhost"));
            return Promise.resolve(
               new Response(JSON.stringify(reply.body), { status: reply.status })
            );
         })
      );
   }

   it("per-app logins: resumes on the tagged answer (the untagged one is the WebUI's)", async () => {
      localStorage.setItem("dawn.hero.lastUser", USERNAME);
      const fake = new FakeDawn(SCENARIOS.signedIn);
      statusVia(fake);
      const c = client();
      let opened = 0;
      c.ing.openSocket = () => opened++;
      await c.ing.tryResume();
      expect(opened).toBe(1);
      expect(c.ing.signedInAs).toBe(USERNAME);
      expect(fake.log.map((e) => e.text)).toEqual([
         "GET /api/auth/status",
         "GET /api/auth/status?app=aurora"
      ]);
      expect(fake.violations).toEqual([]);
   });

   it("an older DAWN: one untagged ask, and it resumes", async () => {
      localStorage.setItem("dawn.hero.lastUser", USERNAME);
      const fake = new FakeDawn(SCENARIOS.legacyDawn);
      statusVia(fake);
      const c = client();
      let opened = 0;
      c.ing.openSocket = () => opened++;
      await c.ing.tryResume();
      expect(opened).toBe(1);
      expect(fake.log.map((e) => e.text)).toEqual(["GET /api/auth/status"]);
      expect(fake.violations).toEqual([]);
   });

   it("signed out: the login card", async () => {
      const fake = new FakeDawn(SCENARIOS.signedOut);
      statusVia(fake);
      const c = client();
      let opened = 0;
      c.ing.openSocket = () => opened++;
      await c.ing.tryResume();
      expect(opened).toBe(0);
      expect(c.statuses.at(-1)).toEqual(["idle", undefined]);
   });

   it("a newer protocol: says so before opening anything", async () => {
      const fake = new FakeDawn(SCENARIOS.protocolMismatch);
      statusVia(fake);
      const c = client();
      let opened = 0;
      c.ing.openSocket = () => opened++;
      await c.ing.tryResume();
      expect(opened).toBe(0);
      expect(c.statuses).toContainEqual([
         "error",
         "This DAWN is newer than this Aurora. Update Aurora to connect."
      ]);
   });
});

it("every verb the fake answers is round-tripped above", () => {
   expect([...ANSWERED].filter((v) => !tested.has(v))).toEqual([]);
});

describe("the fake's login flow", () => {
   const at = (path: string): URL => new URL(path, "https://localhost:5274");
   const login = (fake: FakeDawn, body: object) =>
      fake.http("POST", at("/api/auth/login?app=aurora"), JSON.stringify(body));

   it("signs in with the CSRF token it handed out, as the username given", () => {
      const fake = new FakeDawn(SCENARIOS.signedOut);
      const { csrf_token } = fake.http("GET", at("/api/auth/csrf?app=aurora")).body as {
         csrf_token: string;
      };
      const r = login(fake, { csrf_token, username: "tester", password: "x", app: "aurora" });
      expect(r).toEqual({
         status: 200,
         body: { success: true, username: "tester", is_admin: false }
      });
      expect(fake.http("GET", at("/api/auth/status?app=aurora")).body).toMatchObject({
         authenticated: true,
         username: "tester"
      });
      expect(fake.violations).toEqual([]);
   });

   const token = (fake: FakeDawn): string =>
      (fake.http("GET", at("/api/auth/csrf?app=aurora")).body as { csrf_token: string }).csrf_token;
   const creds = { username: "u", password: "p", app: "aurora" };

   it("refuses a CSRF token it didn't hand out, and a missing one, as DAWN does", () => {
      const fake = new FakeDawn(SCENARIOS.signedOut);
      expect(login(fake, { ...creds, csrf_token: "forged" })).toEqual({
         status: 403,
         body: { success: false, error: "Invalid or expired token. Please refresh." }
      });
      expect(login(fake, creds)).toEqual({
         status: 400,
         body: { success: false, error: "Missing CSRF token" }
      });
   });

   it("spends a token on the first attempt, even a failed one, and keeps two tabs' tokens valid", () => {
      const fake = new FakeDawn(SCENARIOS.signedOut);
      const a = token(fake);
      const b = token(fake); // a second tab
      expect(login(fake, { ...creds, csrf_token: a, password: "" }).status).toBe(401);
      expect(login(fake, { ...creds, csrf_token: a }).body).toEqual({
         success: false,
         error: "Token already used. Please refresh."
      });
      expect(login(fake, { ...creds, csrf_token: b }).status).toBe(200);
   });

   it("refuses a name DAWN couldn't have (padded with spaces) and a wrong app", () => {
      const fake = new FakeDawn(SCENARIOS.signedOut);
      expect(login(fake, { ...creds, csrf_token: token(fake), username: " u" }).body).toEqual({
         success: false,
         error: "Invalid credentials"
      });
      expect(login(fake, { ...creds, csrf_token: token(fake), app: "webui2" }).body).toEqual({
         success: false,
         error: "Invalid app"
      });
   });

   it("logging out ends the login and tells the transport; signed out it's still a 200", () => {
      const fake = new FakeDawn(SCENARIOS.signedIn);
      let ended = 0;
      fake.onSessionEnd = () => ended++;
      expect(fake.http("POST", at("/api/auth/logout?app=aurora")).body).toEqual({ success: true });
      expect(ended).toBe(1);
      expect(fake.http("GET", at("/api/auth/status?app=aurora")).body).toMatchObject({
         authenticated: false
      });
      expect(fake.http("POST", at("/api/auth/logout?app=aurora"))).toEqual({
         status: 200,
         body: { success: true }
      });
      expect(ended).toBe(1); // no login, no sockets to end
   });

   it("a new login ends the browser's previous one, as DAWN's does", () => {
      const fake = new FakeDawn(SCENARIOS.signedIn);
      let ended = 0;
      fake.onSessionEnd = () => ended++;
      expect(login(fake, { ...creds, csrf_token: token(fake) }).status).toBe(200);
      expect(ended).toBe(1);
   });

   it("refuses a socket while signed out", () => {
      const fake = new FakeDawn(SCENARIOS.signedOut);
      const ws = new URL("wss://localhost:5274/ws?app=aurora");
      expect(fake.open(ws, ["dawn-1.0"], "wss://localhost:5274")).toBe(false);
   });

   it("keeps at most maxLog entries when asked to", () => {
      const fake = new FakeDawn(SCENARIOS.signedIn, { maxLog: 3 });
      for (let i = 0; i < 10; i++) fake.http("GET", at("/api/auth/status?app=aurora"));
      expect(fake.log).toHaveLength(3);
   });
});

describe("the fake on JSON that isn't an object", () => {
   const at = (path: string): URL => new URL(path, "https://localhost:5274");

   it("drops a frame like null or 1 as a violation, without throwing", () => {
      const fake = new FakeDawn(SCENARIOS.signedIn);
      expect(fake.message("null")).toEqual([]);
      expect(fake.message("1")).toEqual([]);
      expect(fake.violations).toEqual([
         "a frame that isn't a JSON object: null",
         "a frame that isn't a JSON object: 1"
      ]);
   });

   it("refuses a login body like null or 1 as DAWN does", () => {
      const fake = new FakeDawn(SCENARIOS.signedOut);
      const login = (body: string) => fake.http("POST", at("/api/auth/login?app=aurora"), body);
      expect(login("null").body).toEqual({ success: false, error: "Invalid JSON" });
      expect(login("1").body).toEqual({ success: false, error: "Missing CSRF token" });
   });
});

describe("the fake's CSRF records are bounded and expire, like DAWN's", () => {
   const at = (path: string): URL => new URL(path, "https://localhost:5274");
   const token = (fake: FakeDawn): string =>
      (fake.http("GET", at("/api/auth/csrf?app=aurora")).body as { csrf_token: string }).csrf_token;
   afterEach(() => vi.useRealTimers());

   it("refuses a token older than ten minutes", () => {
      vi.useFakeTimers();
      const fake = new FakeDawn(SCENARIOS.signedOut);
      const t = token(fake);
      vi.advanceTimersByTime(600_001);
      const r = fake.http(
         "POST",
         at("/api/auth/login?app=aurora"),
         JSON.stringify({ csrf_token: t, username: "u", password: "p", app: "aurora" })
      );
      expect(r).toEqual({
         status: 403,
         body: { success: false, error: "Invalid or expired token. Please refresh." }
      });
   });

   it("remembers at most 1024 issued and 1024 used tokens", () => {
      const fake = new FakeDawn(SCENARIOS.signedOut) as unknown as Record<string, any>;
      for (let i = 0; i < 3000; i++) token(fake as unknown as FakeDawn);
      expect(fake.csrfIssued.size).toBe(1024);
      for (const t of [...fake.csrfIssued.keys()])
         (fake as unknown as FakeDawn).http(
            "POST",
            at("/api/auth/login?app=aurora"),
            JSON.stringify({ csrf_token: t, username: "", password: "", app: "aurora" })
         );
      for (let i = 0; i < 1500; i++) {
         const t = token(fake as unknown as FakeDawn);
         (fake as unknown as FakeDawn).http(
            "POST",
            at("/api/auth/login?app=aurora"),
            JSON.stringify({ csrf_token: t, username: "", password: "", app: "aurora" })
         );
      }
      expect(fake.csrfUsed.size).toBe(1024);
   });
});

describe("the fake's interactive requests", () => {
   type Frame = { type: string; payload: Record<string, any> };
   const fast = { firstTokenMs: 10, chunkMs: 1 };
   /* A fake with fast pacing whose pushed frames are collected (with who each went to), and a
      sender for one connection's frames (each request type sent counts as covered). */
   function interactive(scenario = SCENARIOS.signedIn, timing = fast) {
      const fake = new FakeDawn(scenario, { timing });
      const pushed: Array<Frame & { to: Delivery }> = [];
      fake.onPush = (f, to) => pushed.push({ ...(f as Frame), to });
      /* Each connection sends init first, as the client does. */
      const connected = new Set<string>();
      const send = (type: string, payload: object = {}, conn = "default"): Frame[] => {
         if (!connected.has(conn)) {
            connected.add(conn);
            fake.message(JSON.stringify({ type: "init", payload: {} }), conn);
         }
         if (INTERACTIVE.has(type)) interacted.add(type);
         return fake.message(JSON.stringify({ type, payload }), conn) as Frame[];
      };
      const to = (who: Delivery) =>
         pushed.filter((f) => JSON.stringify(f.to) === JSON.stringify(who));
      return { fake, pushed, send, to };
   }
   const mine = { conn: "default" };
   const others = { except: "default" };
   afterEach(() => vi.useRealTimers());

   it("a turn in a conversation: echoed at once, the reply streams, both rows saved", () => {
      vi.useFakeTimers();
      const { fake, pushed, send, to } = interactive();
      send("load_conversation", { conversation_id: CONVERSATION_ID });
      const before = fake.store.get(CONVERSATION_ID)!.messages.length;
      const now = send("text", { text: "hello there", client_ref: "7" });
      expect(now.map((f) => f.type)).toEqual([
         "state",
         "conversation_list_changed",
         "transcript",
         "message_appended"
      ]);
      expect(now[2].payload).toMatchObject({
         role: "user",
         text: "hello there",
         conversation_id: CONVERSATION_ID,
         server_saved: true,
         client_ref: "7"
      });
      expect(now[3].payload).toMatchObject({ role: "user", stream_id: 0, client_ref: "7" });
      expect(fake.store.get(CONVERSATION_ID)!.messages.length).toBe(before + 1); // the user row
      vi.runAllTimers();
      const types = to(mine).map((f) => f.type);
      expect(types.slice(0, 4)).toEqual([
         "metrics_update",
         "state",
         "metrics_update",
         "stream_start"
      ]);
      expect(types.slice(-7)).toEqual([
         "metrics_update",
         "stream_end",
         "conversation_list_changed",
         "message_appended",
         "context",
         "state",
         "metrics_update"
      ]);
      const end = pushed.find((f) => f.type === "stream_end")!;
      expect(end.payload).toMatchObject({ reason: "complete", will_persist: true });
      const reply = pushed
         .filter((f) => f.type === "stream_delta")
         .map((f) => f.payload.delta)
         .join("");
      expect(reply).toContain("You said:");
      expect(reply).toContain("> hello there");
      const saved = fake.store.get(CONVERSATION_ID)!.messages;
      expect(saved.length).toBe(before + 2);
      expect(saved.at(-1)).toMatchObject({ role: "assistant", content: reply });
      const appended = to(mine).find((f) => f.type === "message_appended")!;
      expect(appended.payload).toMatchObject({
         role: "assistant",
         message_id: saved.at(-1)!.id,
         stream_id: end.payload.stream_id
      });
      expect(fake.violations).toEqual([]);
   });

   it("the user's other tabs get only the saved rows and the list changes, no client_ref", () => {
      vi.useFakeTimers();
      const { send, to } = interactive();
      send("load_conversation", { conversation_id: CONVERSATION_ID });
      send("text", { text: "hi", client_ref: "4" });
      vi.runAllTimers();
      const theirs = to(others);
      expect(theirs.map((f) => [f.type, f.payload.role ?? f.payload.reason])).toEqual([
         ["conversation_list_changed", "bumped"],
         ["message_appended", "user"],
         ["conversation_list_changed", "bumped"],
         ["message_appended", "assistant"]
      ]);
      for (const f of theirs) expect(f.payload.client_ref).toBeUndefined();
   });

   it("its frames are ones the real client handles: the echo, a reply bubble, the saved reply", () => {
      vi.useFakeTimers();
      const { pushed, send } = interactive();
      send("load_conversation", { conversation_id: CONVERSATION_ID });
      const now = send("text", { text: "hi", client_ref: "1" });
      vi.runAllTimers();
      for (const f of [
         now[2],
         pushed.find((p) => p.type === "message_appended" && p.payload.role === "assistant")!
      ])
         carries(f, ["conversation_id", "message_id"]);
      carries(
         pushed.find((f) => f.type === "stream_end")!,
         ["stream_id", "will_persist"]
      );
      const c = client();
      c.ing.convId = CONVERSATION_ID;
      for (const f of [...now, ...pushed.filter((p) => "conn" in p.to)]) c.frame(f);
      expect(c.called("conversation", "startReply")).toHaveLength(1);
      expect(c.called("conversation", "appendDelta").length).toBe(
         pushed.filter((f) => f.type === "stream_delta").length
      );
      expect(c.called("conversation", "endReply")).toHaveLength(1);
   });

   it("turns run one at a time: a second waits for the first, and a full queue is refused", () => {
      vi.useFakeTimers();
      const { send, to } = interactive();
      send("load_conversation", { conversation_id: CONVERSATION_ID });
      send("text", { text: "first" });
      expect(send("text", { text: "second", client_ref: "2" })).toEqual([]);
      vi.runAllTimers();
      const mineNow = to(mine);
      const ends = mineNow.flatMap((f, i) => (f.type === "stream_end" ? [i] : []));
      const echo = mineNow.findIndex((f) => f.type === "transcript");
      expect(ends).toHaveLength(2);
      expect(echo).toBeGreaterThan(ends[0]); // the second turn starts after the first ends
      expect(mineNow[echo].payload).toMatchObject({ text: "second", client_ref: "2" });

      send("text", { text: "running" });
      for (let i = 0; i < 16; i++) expect(send("text", { text: `q${i}` })).toEqual([]);
      expect(send("text", { text: "one too many", client_ref: "9" })[0].payload).toMatchObject({
         code: "TURN_QUEUE_FULL",
         /* DAWN's text has an em dash; built here so this source stays free of one. */
         message: `You have too many messages queued ${String.fromCharCode(0x2014)} wait for the current reply.`,
         client_ref: "9"
      });
   });

   it("a queued turn runs in the conversation it was sent in, even after the tab moves on", () => {
      vi.useFakeTimers();
      const { fake, send } = interactive();
      send("load_conversation", { conversation_id: CONVERSATION_ID });
      const before = fake.store.get(CONVERSATION_ID)!.messages.length;
      send("text", { text: "first" });
      send("text", { text: "queued" });
      const fresh = send("new_conversation")[1].payload.conversation_id as number;
      vi.runAllTimers();
      expect(fake.store.get(CONVERSATION_ID)!.messages.length).toBe(before + 4);
      expect(fake.store.get(fresh)!.messages).toEqual([]);
   });

   it("a closed tab's queued turns still run and are saved; only the other tabs hear of them", () => {
      vi.useFakeTimers();
      const { fake, pushed, send } = interactive();
      send("load_conversation", { conversation_id: CONVERSATION_ID });
      const before = fake.store.get(CONVERSATION_ID)!.messages.length;
      send("text", { text: "first" });
      send("text", { text: "queued" });
      fake.closed("default");
      const closedAt = pushed.length;
      vi.runAllTimers();
      expect(fake.store.get(CONVERSATION_ID)!.messages.length).toBe(before + 4);
      const after = pushed.slice(closedAt);
      /* With the tab gone the session has no connection: the saved rows go to every connection
         (all but none), and nothing is addressed to a connection. */
      expect(after.every((f) => JSON.stringify(f.to) === JSON.stringify({ except: "" }))).toBe(
         true
      );
      expect(after.filter((f) => f.type === "message_appended")).toHaveLength(3);
   });

   it("a turn naming a conversation runs there, as DAWN re-anchors to it", () => {
      vi.useFakeTimers();
      const { fake, send } = interactive();
      const other = send("new_conversation")[1].payload.conversation_id as number;
      send("load_conversation", { conversation_id: CONVERSATION_ID });
      const now = send("text", { text: "here", conversation_id: other });
      expect(now[0].payload.conversation_id).toBe(other);
      vi.runAllTimers();
      expect(fake.store.get(other)!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      /* A conversation the user doesn't have is ignored: the session's own is used. */
      expect(send("text", { text: "x", conversation_id: 999 })[0].payload.conversation_id).toBe(
         other
      );
   });

   it("each connection is its own session: a new chat in one tab leaves the other's", () => {
      vi.useFakeTimers();
      const { send } = interactive();
      send("load_conversation", { conversation_id: CONVERSATION_ID }, "a");
      send("load_conversation", { conversation_id: CONVERSATION_ID }, "b");
      const created = send("new_conversation", {}, "a")[1].payload.conversation_id as number;
      expect(send("text", { text: "in a" }, "a")[0].payload.conversation_id).toBe(created);
      expect(send("text", { text: "in b" }, "b")[0].payload.conversation_id).toBe(CONVERSATION_ID);
   });

   it("new_conversation creates one the next turn runs in; clear_session leaves it (nothing saved)", () => {
      vi.useFakeTimers();
      const { fake, pushed, send, to } = interactive();
      const created = send("new_conversation", { save_current: true, title: "Fresh chat" });
      expect(created.map((f) => f.type)).toEqual([
         "conversation_list_changed",
         "new_conversation_response"
      ]);
      expect(to(others).map((f) => f.type)).toEqual(["conversation_list_changed"]);
      const id = created[1].payload.conversation_id as number;
      expect(created[1].payload).toEqual({ success: true, conversation_id: id, is_private: false });
      expect(fake.store.get(id)).toMatchObject({ title: "Fresh chat", messages: [] });
      expect(fake.store.get(send("new_conversation")[1].payload.conversation_id)!.title).toBe(
         "New Conversation"
      );
      send("load_conversation", { conversation_id: id });
      expect(send("text", { text: "first" })[2].payload.conversation_id).toBe(id);
      vi.runAllTimers();
      expect(fake.store.get(id)!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

      expect(send("clear_session")).toEqual([
         { type: "clear_session_response", payload: { success: true } }
      ]);
      pushed.length = 0;
      const unsaved = send("text", { text: "no conversation" });
      expect(unsaved.map((f) => f.type)).toEqual(["state", "transcript"]);
      expect(unsaved[0].payload.conversation_id).toBeUndefined();
      expect(unsaved[1].payload.server_saved).toBeUndefined();
      vi.runAllTimers();
      expect(pushed.find((f) => f.type === "stream_end")!.payload).toMatchObject({
         conversation_id: 0
      });
      expect(pushed.find((f) => f.type === "stream_end")!.payload.will_persist).toBeUndefined();
      expect(to(others)).toEqual([]);
      expect(fake.store.get(id)!.messages).toHaveLength(2); // unchanged
   });

   it("set_session_llm: picks are kept, the effective values fitted to the model and marked", () => {
      const { fake, send } = interactive();
      send("load_conversation", { conversation_id: CONVERSATION_ID });
      const low = send("set_session_llm", { reasoning_effort: "low" });
      expect(low[0].payload).toMatchObject({
         success: true,
         provider: "claude",
         thinking_mode: "adaptive",
         reasoning_effort: "low",
         reasoning_adjusted: false
      });
      expect(low[1].type).toBe("context");
      expect(send("set_session_llm", { reasoning_effort: "max" })[0].payload).toMatchObject({
         reasoning_effort: "high",
         reasoning_effort_pick: "max",
         reasoning_adjusted: true
      });
      /* "enabled" (older clients' "reasoning on") and "auto" are never a fit (llm_capabilities.c). */
      for (const mode of ["enabled", "auto"])
         expect(send("set_session_llm", { thinking_mode: mode })[0].payload).toMatchObject({
            thinking_mode: "adaptive",
            thinking_mode_pick: mode,
            reasoning_adjusted: false
         });
      /* Off keeps the effort pick, and isn't a fit; an unknown name is ignored. */
      expect(send("set_session_llm", { thinking_mode: "disabled" })[0].payload).toMatchObject({
         thinking_mode: "disabled",
         reasoning_adjusted: false
      });
      expect(send("set_session_llm", { reasoning_effort: "ludicrous" })[0].payload).toMatchObject({
         reasoning_effort_pick: "max",
         reasoning_adjusted: false
      });
      expect(fake.store.get(CONVERSATION_ID)!.pick).toEqual({ mode: "disabled", effort: "max" });
      /* A refusal still echoes the config; a provider name DAWN doesn't know is ignored. */
      expect(send("set_session_llm", { provider: "openai" })[0].payload).toMatchObject({
         success: false,
         error: "API key not configured for requested provider",
         thinking_mode: "disabled",
         model: expect.any(String),
         reasoning_adjusted: false
      });
      for (const provider of ["Claude", "foo"])
         expect(send("set_session_llm", { provider })[0].payload.success).toBe(true);
      /* get_config reports the session's reasoning. */
      expect(
         (send("get_config")[0].payload.llm_runtime as Record<string, unknown>).thinking_mode
      ).toBe("disabled");
      /* A load restores the conversation's picks; a new chat starts with the session's. */
      send("clear_session"); // so the reset doesn't stamp the conversation too
      send("set_session_llm", { type: "reset" });
      send("load_conversation", { conversation_id: CONVERSATION_ID });
      const id = send("new_conversation")[1].payload.conversation_id as number;
      expect(fake.store.get(id)!.pick).toEqual({ mode: "disabled", effort: "max" });
      /* The echo means to the client what it says: the shown reasoning follows it. */
      const c = client();
      c.frame(low[0]);
      expect([c.ing.llm.reasoning, c.ing.llm.effort]).toEqual(["adaptive", "low"]);
   });

   it("New Chat's replies are ones the real client handles", () => {
      const { send } = interactive();
      const c = client();
      for (const f of [...send("clear_session"), ...send("set_session_llm", { type: "reset" })])
         c.frame(f);
      /* (afterEach fails the test on any frame the client doesn't handle.) */
      expect([c.ing.llm.reasoning, c.ing.llm.effort]).toEqual(["adaptive", "medium"]);
   });

   it("only space, tab, CR and LF make a turn empty, as in DAWN", () => {
      vi.useFakeTimers(); // the non-empty one runs a turn
      const { send } = interactive();
      expect(send("text", { text: " \t\r\n", client_ref: "3" })[0].payload).toMatchObject({
         code: "EMPTY_MESSAGE",
         client_ref: "3"
      });
      expect(send("text", { text: String.fromCharCode(0xa0) })[0].type).toBe("state"); // a no-break space
   });

   it("an empty turn naming a conversation still moves the session there, as DAWN re-anchors first", () => {
      vi.useFakeTimers();
      const { send } = interactive();
      send("load_conversation", { conversation_id: CONVERSATION_ID });
      const other = send("new_conversation")[1].payload.conversation_id as number;
      send("load_conversation", { conversation_id: CONVERSATION_ID });
      expect(send("text", { text: "", conversation_id: other })[0].payload.code).toBe(
         "EMPTY_MESSAGE"
      );
      expect(send("text", { text: "next" })[0].payload.conversation_id).toBe(other);
   });

   it("a bad client_ref is refused (naming no turn) and recorded; a non-string text is read as JSON", () => {
      vi.useFakeTimers();
      const { fake, send } = interactive();
      for (const ref of [7, "", "x".repeat(65), "tab\there", null]) {
         const [err] = send("text", { text: "hi", client_ref: ref });
         expect(err.payload).toEqual({
            code: "INVALID_CLIENT_REF",
            message: "client_ref must be 1 to 64 printable ASCII characters",
            severity: "error",
            recoverable: true
         });
      }
      expect(fake.violations).toHaveLength(5);
      send("load_conversation", { conversation_id: CONVERSATION_ID });
      expect(send("text", { text: 42 })[2].payload.text).toBe("42");
   });

   it("with no pacing the whole turn is answered at once and the reply still saved", () => {
      const { fake, pushed, send } = interactive(SCENARIOS.signedIn, {
         firstTokenMs: 0,
         chunkMs: 0
      });
      send("load_conversation", { conversation_id: CONVERSATION_ID });
      const before = fake.store.get(CONVERSATION_ID)!.messages.length;
      const now = send("text", { text: "quick" });
      expect(now.at(-1)!.type).toBe("metrics_update");
      expect(now.some((f) => f.type === "stream_end")).toBe(true);
      expect(pushed.every((f) => "except" in f.to)).toBe(true);
      expect(fake.store.get(CONVERSATION_ID)!.messages.length).toBe(before + 2);
   });

   it("a logout ends the sessions: nothing scheduled is sent, and a new login starts fresh", () => {
      vi.useFakeTimers();
      const { fake, pushed, send } = interactive();
      const at = (path: string): URL => new URL(path, "https://localhost:5274");
      send("load_conversation", { conversation_id: CONVERSATION_ID });
      send("set_session_llm", { reasoning_effort: "low" });
      send("text", { text: "cut off" });
      fake.http("POST", at("/api/auth/logout?app=aurora"));
      pushed.length = 0;
      vi.runAllTimers();
      expect(pushed).toEqual([]);
      const { csrf_token } = fake.http("GET", at("/api/auth/csrf?app=aurora")).body as {
         csrf_token: string;
      };
      const body = { csrf_token, username: "u", password: "p", app: "aurora" };
      expect(fake.http("POST", at("/api/auth/login?app=aurora"), JSON.stringify(body)).status).toBe(
         200
      );
      /* The old socket is gone with the login (anything it still sends is dropped); the new
         login's socket gets a new session. */
      expect(send("text", { text: "late" })).toEqual([]);
      expect(send("text", { text: "after" }, "next")[0].payload.conversation_id).toBeUndefined();
      expect(send("set_session_llm", {}, "next")[0].payload.reasoning_effort).toBe("medium");
   });

   it("a transport failing on a saved turn's first frames leaves the session free", () => {
      vi.useFakeTimers();
      const { fake, send } = interactive();
      send("load_conversation", { conversation_id: CONVERSATION_ID });
      fake.onPush = () => {
         throw new Error("socket gone");
      };
      expect(() => send("text", { text: "hi" })).not.toThrow(); // its others' frames go at once
      vi.runAllTimers();
      expect(fake.violations.join("\n")).toContain("socket gone");
      expect(send("text", { text: "again" })[0].type).toBe("state");
   });

   it("list_conversations pages as DAWN does", () => {
      const { fake, send } = interactive();
      for (let i = 0; i < 60; i++) send("new_conversation");
      const page = (payload: object) => send("list_conversations", payload)[0].payload;
      expect(page({}).conversations).toHaveLength(50);
      expect(page({}).total).toBe(61);
      expect(page({ limit: 10, offset: 55 }).conversations).toHaveLength(6);
      expect(page({ limit: 500 }).conversations).toHaveLength(50);
      expect(page({ limit: 0, offset: -3 }).conversations[0].id).toBe(fake.store.list()[0].id);
   });

   it("a fault while sending a scheduled frame is a violation, not a throw", () => {
      vi.useFakeTimers();
      const { fake, send } = interactive();
      fake.onPush = () => {
         throw new Error("socket gone");
      };
      send("text", { text: "hi" });
      expect(() => vi.runAllTimers()).not.toThrow();
      expect(fake.violations.join("\n")).toContain("socket gone");
      /* The session isn't left busy: the next turn runs at once. */
      expect(send("text", { text: "again" })[0].type).toBe("state");
   });
});

describe("the fake's sessions, keyed by token as in DAWN", () => {
   type Frame = { type: string; payload: Record<string, any> };
   function fake() {
      const f = new FakeDawn(SCENARIOS.signedIn, { timing: { firstTokenMs: 10, chunkMs: 1 } });
      const evicted: string[] = [];
      const pushed: Array<Frame & { to: Delivery }> = [];
      f.onEvict = (conn) => evicted.push(conn);
      f.onPush = (fr, to) => pushed.push({ ...(fr as Frame), to });
      const send = (conn: string, type: string, payload: object = {}): Frame[] =>
         f.message(JSON.stringify({ type, payload }), conn) as Frame[];
      const session = (conn: string, type = "init", payload: object = {}) =>
         send(conn, type, payload)[0].payload;
      return { f, evicted, pushed, send, session };
   }
   afterEach(() => vi.useRealTimers());

   it("init makes a new session with a new 32-hex token; reconnect takes it back", () => {
      const { f, evicted, send, session } = fake();
      const a = session("a");
      expect(a.token).toMatch(/^[0-9a-f]{32}$/);
      expect(a.reconnected).toBe(false);
      const b = session("b");
      expect(b.token).not.toBe(a.token);
      expect(b.session_id).not.toBe(a.session_id);
      send("a", "set_session_llm", { reasoning_effort: "low" });
      const back = session("a2", "reconnect", { token: a.token });
      expect(back).toMatchObject({ token: a.token, reconnected: true, session_id: a.session_id });
      /* The session's reasoning came with it; the connection's conversation didn't. */
      expect(send("a2", "set_session_llm", {})[0].payload.reasoning_effort).toBe("low");
      expect(send("a2", "text", { text: "hi" })[0].payload.conversation_id).toBeUndefined();
      expect(evicted).toEqual(["a"]);
      expect(f.violations).toEqual([]);
      /* DAWN still answers the evicted connection until its socket closes, and a change it sends
         acts on the session; the client backs off instead, so one is a fault. */
      expect(send("a", "ping")[0].type).toBe("pong");
      send("a", "clear_session");
      expect(f.violations).toEqual([
         "clear_session from a connection whose session was taken over"
      ]);
   });

   it("a token DAWN doesn't know gets a new session, not an error", () => {
      const { evicted, session } = fake();
      const s = session("a", "reconnect", { token: "f".repeat(32) });
      expect(s.reconnected).toBe(false);
      expect(s.token).not.toBe("f".repeat(32));
      expect(evicted).toEqual([]);
   });

   it("a reload mid-reply: the rest of the reply goes to the connection that took over", () => {
      vi.useFakeTimers();
      const { pushed, send, session } = fake();
      const { token } = session("a");
      send("a", "text", { text: "a long one" });
      vi.advanceTimersByTime(15);
      session("a2", "reconnect", { token });
      const from = pushed.length;
      vi.runAllTimers();
      const rest = pushed.slice(from).filter((p) => "conn" in p.to);
      expect(rest.length).toBeGreaterThan(0);
      expect(rest.every((p) => (p.to as { conn: string }).conn === "a2")).toBe(true);
      expect(rest.some((p) => p.type === "stream_end")).toBe(true);
   });

   it("a reload mid-reply: the client hands the whole saved reply over to redraw the bubble", () => {
      vi.useFakeTimers();
      const { f, pushed, send, session } = fake();
      const { token } = session("a");
      send("a", "load_conversation", { conversation_id: CONVERSATION_ID });
      send("a", "text", { text: "a long one" });
      vi.advanceTimersByTime(15); // part of the reply has streamed to the first tab
      session("a2", "reconnect", { token });
      send("a2", "set_active_conversation", { conversation_id: CONVERSATION_ID });
      const from = pushed.length;
      vi.runAllTimers();
      const c = client();
      c.ing.convId = CONVERSATION_ID;
      for (const p of pushed.slice(from)) if ("conn" in p.to) c.frame(p);
      const saved = f.store.get(CONVERSATION_ID)!.messages.at(-1)!;
      const streamed = c
         .called("conversation", "appendDelta")
         .map((a) => a[0])
         .join("");
      expect(streamed.length).toBeLessThan(saved.content.length); // only its end streamed here
      const adopt = c.called("conversation", "adoptId");
      expect(adopt).toHaveLength(1);
      /* The same stream the client linked its bubble under. */
      const linked = c.called("conversation", "linkStream");
      expect(linked).toHaveLength(1);
      expect(adopt[0]).toEqual([CONVERSATION_ID, linked[0][1], saved.id, saved.content]);
   });

   it("at most 7 sessions (DAWN's first slot is its own); a full table refuses, then retries", () => {
      const { f, session, send } = fake();
      const tokens = Array.from({ length: 7 }, (_, i) => session(`c${i}`).token as string);
      expect(send("c7", "init")[0].payload).toMatchObject({
         code: "SESSION_LIMIT",
         message: "Maximum sessions reached"
      });
      /* Even a reconnect with a good token needs a slot first, as in DAWN. */
      f.closed("c0");
      expect(send("c8", "reconnect", { token: tokens[0] })[0].payload.code).toBe("SESSION_LIMIT");
      expect(f.violations).toHaveLength(2);
      /* Another idle session is freed for the next try (the fake's stand-in for DAWN's idle
         expiry), and the session the reconnect names is kept for it. */
      f.closed("c1");
      expect(session("c8", "reconnect", { token: tokens[0] })).toMatchObject({
         token: tokens[0],
         reconnected: true
      });
      /* The session c8's first frame made was dropped when it took c0's back: room again. */
      expect(session("c7", "init").reconnected).toBe(false);
   });

   it("a second init only syncs; a reconnect to another session drops the connection's own", () => {
      const { evicted, send, session } = fake();
      const first = session("a");
      expect(send("a", "init")).toEqual([]);
      const other = session("b");
      const moved = session("a", "reconnect", { token: other.token });
      expect(moved).toMatchObject({ token: other.token, reconnected: true });
      expect(evicted).toEqual(["b"]);
      /* The session it left is gone: its token now gets a new one. */
      expect(session("c", "reconnect", { token: first.token }).reconnected).toBe(false);
   });

   it("a request before init or reconnect is a violation (DAWN would make a session for it)", () => {
      const { f, send } = fake();
      const out = send("a", "ping");
      expect(out.map((o) => o.type)).toEqual([
         "session",
         "config",
         "server_features",
         "state",
         "pong"
      ]);
      expect(f.violations).toEqual(["ping before init or reconnect"]);
   });

   it("a store limit keeps the newest conversations and messages", () => {
      const f = new FakeDawn(SCENARIOS.signedIn, {
         timing: { firstTokenMs: 0, chunkMs: 0 },
         storeLimit: { conversations: 2, messages: 3 }
      });
      const send = (type: string, payload: object = {}) =>
         f.message(JSON.stringify({ type, payload }), "a") as Frame[];
      send("init");
      const first = send("new_conversation")[1].payload.conversation_id as number;
      for (let i = 0; i < 3; i++) send("text", { text: `turn ${i}` });
      expect(f.store.get(first)!.messages.map((m) => m.content.slice(0, 6))).toEqual([
         "This i",
         "turn 2",
         "This i"
      ]);
      const second = send("new_conversation")[1].payload.conversation_id as number;
      /* The seeded one (the least recently updated) went. */
      expect(
         f.store
            .list()
            .map((c) => c.id)
            .sort()
      ).toEqual([first, second].sort());
   });

   it("each user has their own conversations, kept across their logouts", () => {
      const f = new FakeDawn(SCENARIOS.signedIn, { timing: { firstTokenMs: 0, chunkMs: 0 } });
      const at = (path: string): URL => new URL(path, "https://localhost:5274");
      const signIn = (username: string): void => {
         f.http("POST", at("/api/auth/logout?app=aurora"));
         const { csrf_token } = f.http("GET", at("/api/auth/csrf?app=aurora")).body as {
            csrf_token: string;
         };
         const body = { csrf_token, username, password: "p", app: "aurora" };
         expect(f.http("POST", at("/api/auth/login?app=aurora"), JSON.stringify(body)).status).toBe(
            200
         );
      };
      let n = 0;
      const send = (type: string, payload: object = {}): Frame[] => {
         const conn = `c${++n}`;
         f.message(JSON.stringify({ type: "init" }), conn);
         return f.message(JSON.stringify({ type, payload }), conn) as Frame[];
      };
      signIn("first");
      const mine = send("new_conversation", { title: "First's chat" })[1].payload
         .conversation_id as number;
      const titles = (): string[] =>
         (send("list_conversations")[0].payload.conversations as Array<{ title: string }>).map(
            (c) => c.title
         );
      expect(titles()).toContain("First's chat");
      signIn("second");
      expect(titles()).not.toContain("First's chat");
      expect(send("load_conversation", { conversation_id: mine })[0].payload.success).not.toBe(
         true
      );
      signIn("first");
      expect(titles()).toContain("First's chat");
   });

   it("the store limit holds for conversations made in the same second", () => {
      const store = new FakeDawn(SCENARIOS.signedIn, {
         storeLimit: { conversations: 2, messages: 10 }
      }).store;
      const made = Array.from(
         { length: 5 },
         () => store.create("", { mode: "adaptive", effort: "medium" }).id
      );
      expect(store.list().map((c) => c.id)).toEqual([made[4], made[3]]);
   });

   it("a busy session with no socket is never freed for a new one", () => {
      vi.useFakeTimers();
      const { f, send, session } = fake();
      for (let i = 0; i < 7; i++) session(`c${i}`);
      send("c0", "text", { text: "still going" });
      f.closed("c0"); // its tab closes mid-reply
      expect(send("new", "init")[0].payload.code).toBe("SESSION_LIMIT");
      vi.runAllTimers(); // the turn ends; now it can go
      expect(session("new").reconnected).toBe(false);
   });

   it("the client: a session taken back re-anchors lightly, a new one restores in full", () => {
      for (const reconnected of [true, false]) {
         const c = client();
         c.ing.convId = CONVERSATION_ID;
         c.frame(
            connectFrames(SCENARIOS.signedIn, {
               token: "b2".repeat(16),
               reconnected,
               sessionId: 2
            })[0]
         );
         const types = c.sent.map((m) => m.type);
         expect(types).toContain(reconnected ? "set_active_conversation" : "load_conversation");
         expect(types).not.toContain(reconnected ? "load_conversation" : "set_active_conversation");
      }
   });

   it("the client: session_superseded backs off and offers the takeover", () => {
      const c = client();
      c.frame(superseded());
      expect(c.ing.superseded).toBe(true);
   });
});

it("every interactive request is exercised above", () => {
   expect([...INTERACTIVE].filter((v) => !interacted.has(v))).toEqual([]);
});
