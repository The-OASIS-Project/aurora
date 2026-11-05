/* A fake DAWN at the protocol level: canned HTTP replies and WebSocket frames, in DAWN's own wire
   format, for the REAL client (DawnIngest) to talk to. Transport-agnostic: an adapter (Playwright
   for the smoke test, tests/smoke/fake-dawn-page.ts; a Node server for `npm run dev:fake`,
   node-adapter.ts) feeds it requests and frames and sends back what it returns. Plan:
   docs/FAKE_DAWN_PLAN.md.

   Every request is checked against what DAWN would accept, and anything the fake doesn't expect is
   recorded as a violation, so the test fails on it instead of the client quietly degrading. */

import { answerFrame, authStatus, connectFrames, unknownType, type Scenario } from "./scenarios.ts";

/* Requests DAWN answers that the fake models (the client's core boot verbs, plus the heartbeat). */
export const ANSWERED = new Set([
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
export const SILENT = new Set(["phone_status"]);

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

/* A JSON object (not null, not an array, not a scalar). */
function isObject(v: unknown): v is Record<string, unknown> {
   return typeof v === "object" && v !== null && !Array.isArray(v);
}

/* How long a CSRF token is good for, and how many issued and used tokens are remembered. */
const CSRF_TTL_MS = 600_000;
const CSRF_KEEP = 1024;

/* Adds to an insertion-ordered set or map's key list, dropping the oldest past `max`. */
function remember(keys: Set<string> | Map<string, number>, max: number): void {
   while (keys.size > max) {
      const oldest = keys.keys().next().value;
      if (oldest === undefined) break;
      keys.delete(oldest);
   }
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

   readonly scenario: Scenario;
   /* Who is signed in now: starts as the scenario says, and changes with a login or logout. */
   private signedIn: { authenticated: boolean; username: string };
   /* CSRF tokens handed out by /api/auth/csrf (with when), and the ones a login has used. Like
      DAWN's signed tokens, several can be valid at once (two tabs), each works for one login
      attempt, and each expires; both records are bounded like DAWN's, so a dev server on the LAN
      can't be grown without limit (auth_crypto.h AUTH_CSRF_TIMEOUT_SEC, webui_http.c
      CSRF_USED_NONCE_COUNT). */
   private readonly csrfIssued = new Map<string, number>();
   private readonly csrfUsed = new Set<string>();
   private csrfCount = 0;
   /* The transport's hook for a login ending (logout): DAWN then tells each of the login's
      sockets (force_logout) and closes it with 4002. */
   onSessionEnd: (() => void) | null = null;
   /* Called with each violation as it happens (a dev server logs it; the smoke test reads the
      list at the end). */
   onViolation: ((what: string) => void) | null = null;

   /* At most this many log entries are kept (the oldest dropped), and the request and socket
      lists are bounded the same way; a long `npm run dev:fake` session sets it. Unbounded by
      default: the smoke test reads the whole transcript. */
   private readonly maxLog: number;

   constructor(scenario: Scenario, opts: { maxLog?: number } = {}) {
      this.scenario = scenario;
      this.maxLog = opts.maxLog ?? Infinity;
      this.appLogins = scenario.features?.includes("app_logins") === true;
      this.signedIn = { authenticated: scenario.authenticated, username: scenario.username };
   }

   /* The scenario as it stands now (who is signed in may have changed since it started). */
   private current(): Scenario {
      return { ...this.scenario, ...this.signedIn };
   }

   /* Appends to a list, dropping the oldest past maxLog. */
   private keep<T>(list: T[], item: T): void {
      list.push(item);
      if (list.length > this.maxLog) list.splice(0, list.length - this.maxLog);
   }

   private note(dir: LogEntry["dir"], text: string): void {
      this.keep(this.log, { dir, at: Date.now() - this.started, text });
   }

   violate(what: string): void {
      this.keep(this.violations, what);
      this.note("ws", `VIOLATION: ${what}`);
      this.onViolation?.(what);
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

   /* An HTTP request to DAWN, with its body for a POST. Routed by pathname: the query only
      carries the app tag. */
   http(method: string, url: URL, body?: string): HttpReply {
      this.note("http", `${method} ${url.pathname}${url.search}`);
      if (method === "GET" && url.pathname === "/api/auth/status") {
         this.checkTag(url, true);
         const tagged = url.searchParams.get("app") === "aurora";
         if (tagged) this.askedTagged = true;
         return { status: 200, body: authStatus(this.current(), tagged) };
      }
      this.checkTag(url, false);
      /* The login flow (webui_http.c handle_auth_csrf / handle_auth_login / handle_auth_logout). */
      if (method === "GET" && url.pathname === "/api/auth/csrf") {
         const token = `fake-csrf-${++this.csrfCount}-${Date.now()}`;
         this.csrfIssued.set(token, Date.now());
         remember(this.csrfIssued, CSRF_KEEP);
         return { status: 200, body: { csrf_token: token } };
      }
      if (method === "POST" && url.pathname === "/api/auth/login") return this.login(body);
      /* DAWN always answers 200 and clears the cookie, signed in or not; only a login that
         existed has sockets to end. */
      if (method === "POST" && url.pathname === "/api/auth/logout") {
         this.askedTagged = false;
         if (this.signedIn.authenticated) {
            this.signedIn = { authenticated: false, username: "" };
            this.onSessionEnd?.();
         }
         return { status: 200, body: { success: true } };
      }
      this.violate(`unanswered HTTP request: ${method} ${url.pathname}`);
      return { status: 404, body: { error: "Not found (fake DAWN)" } };
   }

   /* POST /api/auth/login, checked in DAWN's order with its statuses and text (webui_http.c
      handle_auth_login): the JSON, the CSRF token (missing, not one handed out, already used;
      it's spent before the credentials are looked at), the fields, the app. Any username is a
      user here (this is a fake) except one DAWN couldn't have (empty, or padded with spaces:
      DAWN looks names up exactly), and any non-empty password is right. A new login ends the
      browser's previous one, as DAWN's does. */
   private login(body: string | undefined): HttpReply {
      const refuse = (status: number, error: string): HttpReply => ({
         status,
         body: { success: false, error }
      });
      let parsed: unknown;
      try {
         parsed = JSON.parse(body ?? "");
      } catch {
         parsed = null;
      }
      /* json-c gives DAWN no object for unparseable text or a bare `null` ("Invalid JSON"); any
         other value that isn't an object has no fields, so its token is missing. */
      if (parsed === null) {
         this.violate("a login whose body isn't JSON");
         return refuse(400, "Invalid JSON");
      }
      if (!isObject(parsed)) {
         this.violate("a login whose body isn't a JSON object");
         return refuse(400, "Missing CSRF token");
      }
      const req = parsed as {
         csrf_token?: unknown;
         username?: unknown;
         password?: unknown;
         app?: unknown;
      };
      if (!("csrf_token" in req)) {
         this.violate("a login without a CSRF token");
         return refuse(400, "Missing CSRF token");
      }
      const token = typeof req.csrf_token === "string" ? req.csrf_token : "";
      const issuedAt = this.csrfIssued.get(token);
      if (issuedAt === undefined || Date.now() - issuedAt > CSRF_TTL_MS) {
         this.violate("a login with a CSRF token this DAWN didn't hand out");
         return refuse(403, "Invalid or expired token. Please refresh.");
      }
      if (this.csrfUsed.has(token)) {
         this.violate("a login reusing a CSRF token (fetch a new one per attempt)");
         return refuse(403, "Token already used. Please refresh.");
      }
      this.csrfUsed.add(token);
      remember(this.csrfUsed, CSRF_KEEP);
      if (typeof req.username !== "string" || typeof req.password !== "string")
         return refuse(400, "Missing username or password");
      if (req.app !== undefined && req.app !== "aurora") return refuse(400, "Invalid app");
      if (this.appLogins && req.app !== "aurora")
         this.violate('a login without "app":"aurora" (this DAWN keeps per-app logins)');
      const username = req.username;
      if (!username || username !== username.trim() || !req.password)
         return refuse(401, "Invalid credentials");
      if (this.signedIn.authenticated) this.onSessionEnd?.(); // the browser's previous login
      this.signedIn = { authenticated: true, username };
      return { status: 200, body: { success: true, username, is_admin: false } };
   }

   /* The client opened a socket, asking for these subprotocols. `origin` is where DAWN serves its
      socket (the page's own origin, as ws/wss): the client must open it same-origin, since the
      login cookie rides the handshake and DAWN checks the Origin. Returns false to refuse it. */
   open(url: URL, protocols: string[], origin: string): boolean {
      this.keep(this.sockets, url.href);
      this.note("ws", `open ${url.href} [${protocols.join(", ")}]`);
      if (url.origin !== origin) {
         this.violate(`socket opened on ${url.origin}, not DAWN's ${origin}`);
         return false;
      }
      if (url.pathname !== "/ws") {
         this.violate(`unexpected socket: ${url.pathname}`);
         return false;
      }
      if (!this.signedIn.authenticated) {
         /* DAWN authenticates the socket from the login cookie: without a login there is no
            session for it. */
         this.violate("a socket opened while signed out");
         return false;
      }
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
      let parsed: unknown;
      try {
         parsed = JSON.parse(text);
      } catch {
         this.violate(`a frame that isn't JSON: ${text.slice(0, 80)}`);
         return [];
      }
      /* Valid JSON isn't always a message: `null`, `1` and `[]` are dropped as DAWN drops them. */
      if (!isObject(parsed)) {
         this.violate(`a frame that isn't a JSON object: ${text.slice(0, 80)}`);
         return [];
      }
      const msg = parsed as { type?: unknown; payload?: unknown };
      const type = typeof msg.type === "string" ? msg.type : "";
      this.keep(this.requests, type);
      const payload = (msg.payload ?? {}) as Record<string, unknown>;
      let out: object[];
      if (type === "init" || type === "reconnect") out = connectFrames(this.current());
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
