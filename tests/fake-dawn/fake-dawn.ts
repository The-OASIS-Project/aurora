/* A fake DAWN at the protocol level: canned HTTP replies and WebSocket frames, in DAWN's own wire
   format, for the REAL client (DawnIngest) to talk to. Transport-agnostic: an adapter (Playwright
   today, a Node server later) feeds it requests and frames and sends back what it returns. Plan:
   docs/FAKE_DAWN_PLAN.md.

   Every request is checked against what DAWN would accept, and anything the fake doesn't expect is
   recorded as a violation, so the test fails on it instead of the client quietly degrading. */

import { answerFrame, authStatus, connectFrames, unknownType, type Scenario } from "./scenarios.ts";

/* Requests DAWN answers that the fake models (the client's core boot verbs, plus the heartbeat). */
const ANSWERED = new Set([
   "init",
   "reconnect",
   "get_config",
   "get_my_settings",
   "list_llm_models",
   "list_conversations",
   "load_conversation",
   "set_active_conversation",
   "jobs_request",
   "music_subscribe",
   "get_metrics",
   "ping",
   /* Always in DAWN (no build switch, unlike the optional subsystems below): answered empty. */
   "watch_list",
   "watch_readings_subscribe",
   "doc_library_list"
]);

/* Requests DAWN takes without a reply in these scenarios. phone_status: DAWN answers only while a
   call is live (WEBSOCKET_PROTOCOL.md, Phone; checked in webui_phone.c). */
const SILENT = new Set(["phone_status"]);

/* Requests of the optional subsystems these scenarios build DAWN without (Home Assistant and the
   calendar, each behind a build switch in webui_message_dispatch.c), listed by exact verb so a
   misspelled one is caught: answered with DAWN's real UNKNOWN_TYPE, which the client handles
   quietly, as on a DAWN without them. */
export const OPTIONAL = [
   "ha_status",
   "ha_list_entities",
   "ha_refresh_entities",
   "calendar_list_my_calendars",
   "calendar_upcoming_events"
];

export interface LogEntry {
   dir: "http" | "in" | "out" | "ws";
   at: number; // ms since the fake started
   text: string;
}

export interface HttpReply {
   status: number;
   body: unknown;
}

export class FakeDawn {
   readonly violations: string[] = [];
   readonly log: LogEntry[] = [];
   /* Every WebSocket request type the client sent, in order (for assertions). */
   readonly requests: string[] = [];
   /* Every socket the client opened (its URL), whether or not it went on to send anything. */
   readonly sockets: string[] = [];
   private readonly started = Date.now();
   private readonly appLogins: boolean;
   /* Whether the client has asked /api/auth/status tagged (Aurora's own login, with app_logins). */
   private askedTagged = false;

   constructor(readonly scenario: Scenario) {
      this.appLogins = scenario.features?.includes("app_logins") === true;
   }

   private note(dir: LogEntry["dir"], text: string): void {
      this.log.push({ dir, at: Date.now() - this.started, text });
   }

   violate(what: string): void {
      this.violations.push(what);
      this.note("ws", `VIOLATION: ${what}`);
   }

   /* Whether a DAWN URL carries the app tag, and whether it should. The first /api/auth/status is
      asked untagged on purpose (to learn the flags), so status may go either way. */
   private checkTag(url: URL, mayBeUntagged: boolean): void {
      const app = url.searchParams.get("app");
      if (app !== null && app !== "aurora") this.violate(`${url.pathname}: unexpected app=${app}`);
      const tagged = app === "aurora";
      if (tagged && !this.appLogins)
         this.violate(`${url.pathname} is tagged ?app=aurora, but this DAWN has no app_logins`);
      if (!tagged && this.appLogins && !mayBeUntagged)
         this.violate(`${url.pathname} is missing ?app=aurora (this DAWN keeps per-app logins)`);
   }

   /* An HTTP request to DAWN. Routed by pathname: the query only carries the app tag. */
   http(method: string, url: URL): HttpReply {
      this.note("http", `${method} ${url.pathname}${url.search}`);
      if (method === "GET" && url.pathname === "/api/auth/status") {
         this.checkTag(url, true);
         const tagged = url.searchParams.get("app") === "aurora";
         if (tagged) this.askedTagged = true;
         return { status: 200, body: authStatus(this.scenario, tagged) };
      }
      this.checkTag(url, false);
      this.violate(`unanswered HTTP request: ${method} ${url.pathname}`);
      return { status: 404, body: { error: "Not found (fake DAWN)" } };
   }

   /* The client opened a socket, asking for these subprotocols. `origin` is where DAWN serves its
      socket (the page's own origin, as ws/wss): the client must open it same-origin, since the
      login cookie rides the handshake and DAWN checks the Origin. Returns false to refuse it. */
   open(url: URL, protocols: string[], origin: string): boolean {
      this.sockets.push(url.href);
      this.note("ws", `open ${url.href} [${protocols.join(", ")}]`);
      if (url.origin !== origin) {
         this.violate(`socket opened on ${url.origin}, not DAWN's ${origin}`);
         return false;
      }
      if (url.pathname !== "/ws") {
         this.violate(`unexpected socket: ${url.pathname}`);
         return false;
      }
      if (!this.scenario.authenticated) this.violate("a socket opened while signed out");
      this.checkTag(url, false);
      /* Without dawn-1.0, real DAWN routes the socket to its HTTP handler and silently drops
         every frame. */
      if (!protocols.includes("dawn-1.0"))
         this.violate("/ws opened without the dawn-1.0 subprotocol");
      /* With per-app logins the untagged status answer is the WebUI's login, not Aurora's: the
         client must have asked for its own before opening the socket. */
      if (this.appLogins && !this.askedTagged)
         this.violate("/ws opened without first asking /api/auth/status?app=aurora");
      return true;
   }

   /* One text frame from the client; returns the frames to send back, in order. */
   message(text: string): object[] {
      this.note("in", text);
      let msg: { type?: unknown; payload?: unknown };
      try {
         msg = JSON.parse(text) as typeof msg;
      } catch {
         this.violate(`a frame that isn't JSON: ${text.slice(0, 80)}`);
         return [];
      }
      const type = typeof msg.type === "string" ? msg.type : "";
      this.requests.push(type);
      const payload = (msg.payload ?? {}) as Record<string, unknown>;
      let out: object[];
      if (type === "init" || type === "reconnect") out = connectFrames(this.scenario);
      else if (ANSWERED.has(type)) out = answerFrame(type, payload);
      else if (SILENT.has(type)) out = [];
      /* DAWN reads `req` from the payload (webui_protocol.c webui_protocol_payload_req). */
      else if (OPTIONAL.includes(type))
         out = [unknownType(type, typeof payload.req === "string" ? payload.req : undefined)];
      else {
         /* A request the fake has no rule for: a new client request needs a decision here. */
         this.violate(`unexpected request: ${type || "(no type)"}`);
         out = [unknownType(type)];
      }
      for (const f of out) this.note("out", JSON.stringify(f));
      return out;
   }

   /* The frame log, one line per entry, for the test report. */
   transcript(): string {
      return this.log
         .map((e) => `${String(e.at).padStart(6)}ms ${e.dir.padEnd(4)} ${e.text}`)
         .join("\n");
   }
}
