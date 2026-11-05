// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DawnIngest } from "./dawn-ws.ts";
import { setAppLogins } from "../util/dawn-app.ts";
import { ANSWERED, FakeDawn } from "../../tests/fake-dawn/fake-dawn.ts";
import {
   CONVERSATION_ID,
   SCENARIOS,
   TRANSCRIPT,
   USERNAME,
   answerFrame,
   connectFrames,
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
      c.frame(connectFrames(SCENARIOS.signedIn)[0]);
      expect(localStorage.getItem("dawn.hero.sessionToken")).toBe("fake-session-token");
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
