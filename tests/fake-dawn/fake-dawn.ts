/* A fake DAWN at the protocol level: canned HTTP replies and WebSocket frames, in DAWN's own wire
   format, for the REAL client (DawnIngest) to talk to. Transport-agnostic: an adapter (Playwright
   for the smoke test, tests/smoke/fake-dawn-page.ts; a Node server for `npm run dev:fake`,
   node-adapter.ts) feeds it requests and frames and sends back what it returns. Plan:
   docs/FAKE_DAWN_PLAN.md.

   Every request is checked against what DAWN would accept, and anything the fake doesn't expect is
   recorded as a violation, so the test fails on it instead of the client quietly degrading. */

import {
   DEFAULT_PICK,
   type ConversationStore,
   type ReasoningPick,
   type StoreLimit
} from "./conversations.ts";
import {
   MODEL,
   VALID_EFFORTS,
   VALID_MODES,
   answerFrame,
   authStatus,
   connectFrames,
   defaultStore,
   reasoningFields,
   resolveReasoning,
   unknownType,
   type Scenario
} from "./scenarios.ts";
import { cannedReply, turnFrames, type TurnTiming } from "./turns.ts";

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

/* Requests that change the session, answered by the core from its state (turns.ts and below):
   a typed turn, a new chat, clearing the session, picking a model. */
export const INTERACTIVE = new Set([
   "text",
   "new_conversation",
   "clear_session",
   "set_session_llm"
]);

/* Who a pushed frame goes to: one connection, or every connection but one. */
export type Delivery = { conn: string } | { except: string };

/* The sockets a pushed frame goes to, from an adapter's main sockets by connection id. */
export function deliveryTargets<T>(sockets: ReadonlyMap<string, T>, to: Delivery): T[] {
   if ("conn" in to) {
      const one = sockets.get(to.conn);
      return one ? [one] : [];
   }
   return [...sockets].filter(([id]) => id !== to.except).map(([, ws]) => ws);
}

/* A session, as DAWN keeps one (session_manager.c, webui_server.c): made by `init` with a new
   token, taken over by a `reconnect` carrying that token, and kept when its socket closes (until
   the login ends). It holds the reasoning picks, the stream ids and the turn queue (turns run one
   at a time; turn_queue.c), and its frames go to whichever connection owns it now. */
interface Session {
   token: string;
   id: number;
   pick: ReasoningPick;
   streamId: number;
   busy: boolean;
   queue: Array<Record<string, unknown>>;
   owner: string | null;
   /* When it was last used (a counter): the fake's stand-in for DAWN's idle clock. */
   active: number;
}

/* One socket's own state (webui_internal.h ws_connection_t): its session, the conversation its
   turns run in (0 = none; a new socket starts without), and whether another connection has taken
   its session over (DAWN keeps the session on it until the socket closes, and still answers it). */
interface Connection {
   session: Session;
   conversation: number;
   evicted: boolean;
}

/* At most this many browser sessions at once: DAWN's table holds MAX_SESSIONS (8), and its first
   slot is the local session (session_manager.h, session_manager.c). */
const WEBUI_SESSIONS = 7;

/* A turn's text as DAWN reads it (json_object_get_string): a string as is, null or missing as
   none, anything else as its JSON. */
function turnText(v: unknown): string {
   if (v === undefined || v === null) return "";
   return typeof v === "string" ? v : JSON.stringify(v);
}

/* How many typed turns may wait behind the running one (turn_queue.c TURN_QUEUE_USER_CAP). */
const TURN_QUEUE_CAP = 16;

/* How a turn is paced by default: a short pause before the reply, then a chunk every 40 ms. */
const TURN_TIMING: TurnTiming = { firstTokenMs: 400, chunkMs: 40 };

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
   /* The transport's hook for frames the fake sends on its own (a streamed reply, another tab's
      message_appended), with who gets each. */
   onPush: ((frame: object, to: Delivery) => void) | null = null;
   /* The transport's hook for a connection another took its session from: DAWN sends it
      session_superseded, then closes it with 4001 (webui_server.c webui_evict_session_owner). */
   onEvict: ((conn: string) => void) | null = null;

   /* The user's saved conversations, the sessions by token, and each connection's state. The
      connections of a login that ended are remembered until they close, so a frame racing the
      logout is dropped rather than starting anything. */
   readonly store: ConversationStore = defaultStore();
   private readonly sessions = new Map<string, Session>();
   private readonly conns = new Map<string, Connection>();
   private readonly ended = new Set<string>();
   private sessionCount = 0;
   private activity = 0;
   private readonly timers = new Set<ReturnType<typeof setTimeout>>();
   private readonly timing: TurnTiming;

   /* At most this many log entries are kept (the oldest dropped), and the request and socket
      lists are bounded the same way; a long `npm run dev:fake` session sets it. Unbounded by
      default: the smoke test reads the whole transcript. */
   private readonly maxLog: number;

   constructor(
      scenario: Scenario,
      opts: { maxLog?: number; timing?: TurnTiming; storeLimit?: StoreLimit } = {}
   ) {
      if (opts.storeLimit) this.store.limit = opts.storeLimit;
      this.scenario = scenario;
      this.maxLog = opts.maxLog ?? Infinity;
      this.timing = opts.timing ?? TURN_TIMING;
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
            this.endSessions();
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
      if (this.signedIn.authenticated) {
         this.endSessions(); // the browser's previous login, and its sessions
         this.onSessionEnd?.();
      }
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

   /* A connection's first frame, whatever it is, gets it a session, as DAWN does for a socket
      its login cookie authenticated (webui_server.c webui_conn_create_session): a new one, with
      its session frame and the rest of the connect frames. None when every slot is taken; DAWN
      then refuses with SESSION_LIMIT and tries again on the connection's next frame. `keep` is a
      session that mustn't be freed to make room (the one a reconnect is about to take back). */
   private firstFrame(conn: string, keep?: Session): Connection | undefined {
      const s = this.newSession(keep);
      if (!s) return undefined;
      s.owner = conn;
      const c: Connection = { session: s, conversation: 0, evicted: false };
      this.conns.set(conn, c);
      return c;
   }

   /* `reconnect` (webui_message_dispatch.c): a token naming another session of this login takes
      that session over. The connection's own session is dropped (DAWN destroys the one it just
      made, with its connect frames, which are replaced), the connection that owned the session is
      evicted, and the session frame says reconnected. A token naming the connection's own session,
      or one DAWN doesn't know, changes nothing: `made` (the connect frames of a session the first
      frame just made, or none) stands. */
   private reconnect(token: string, conn: string, c: Connection, made: object[]): object[] {
      const target = token ? this.sessions.get(token) : undefined;
      if (!target || target === c.session) return made;
      const abandoned = c.session;
      abandoned.owner = null;
      abandoned.queue.length = 0;
      this.sessions.delete(abandoned.token);
      if (target.owner !== null && target.owner !== conn) this.evict(target.owner);
      target.owner = conn;
      c.session = target;
      c.evicted = false;
      return this.sessionFrames(target, true);
   }

   private sessionFrames(s: Session, reconnected: boolean): object[] {
      return connectFrames(this.current(), { token: s.token, reconnected, sessionId: s.id });
   }

   /* A new session, or none when all WEBUI_SESSIONS are in use. DAWN frees a session that has
      gone unused for its idle timeout (and has no turn running); this fake has no clock, so when
      full it frees the least recently used session with no socket and no turn instead. */
   private newSession(keep?: Session): Session | undefined {
      if (this.sessions.size >= WEBUI_SESSIONS) {
         const idle = [...this.sessions.values()]
            .filter((x) => x.owner === null && !x.busy && x !== keep)
            .sort((a, b) => a.active - b.active)[0];
         if (!idle) return undefined;
         this.sessions.delete(idle.token);
      }
      const s: Session = {
         /* 32 hex characters, like DAWN's (webui_server.h WEBUI_SESSION_TOKEN_LEN). */
         token: [...crypto.getRandomValues(new Uint8Array(16))]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(""),
         id: ++this.sessionCount,
         pick: { ...DEFAULT_PICK },
         streamId: 0,
         busy: false,
         queue: [],
         owner: null,
         active: ++this.activity
      };
      this.sessions.set(s.token, s);
      return s;
   }

   /* Another connection took this one's session: the transport tells it, then closes it. */
   private evict(conn: string): void {
      const c = this.conns.get(conn);
      if (c) c.evicted = true;
      this.note("ws", `evict ${conn} (its session was taken over)`);
      this.onEvict?.(conn);
   }

   /* A login ended: its sessions go, and nothing they had scheduled is sent. */
   private endSessions(): void {
      this.dispose();
      this.sessions.clear();
      for (const conn of this.conns.keys()) this.ended.add(conn);
      this.conns.clear();
   }

   /* A connection closed. Its session stays (a reconnect with its token takes it back), and a
      turn running in it, with any queued behind it, still runs and is saved (DAWN finishes a
      turn whose sender left), but nothing goes to the closed connection. */
   closed(conn: string): void {
      const s = this.conns.get(conn)?.session;
      if (s?.owner === conn) s.owner = null;
      this.conns.delete(conn);
      this.ended.delete(conn);
   }

   /* One text frame from connection `conn` (the adapter's id for it); returns the frames to send
      back to it, in order. Frames for later, or for the user's other tabs, go through onPush. */
   message(text: string, conn = "default"): object[] {
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
      const payload: Record<string, unknown> = isObject(msg.payload) ? msg.payload : {};
      /* A frame from a connection whose login ended, racing its close: DAWN ignores it. */
      if (this.ended.has(conn)) {
         this.note("ws", `dropped: ${type} from ${conn}, whose login ended`);
         return [];
      }
      let c = this.conns.get(conn);
      let made: object[] = [];
      if (!c) {
         /* The client sends init or reconnect first, always (DAWN would cope, as below). */
         if (type !== "init" && type !== "reconnect")
            this.violate(`${type} before init or reconnect`);
         const token = typeof payload.token === "string" ? payload.token : "";
         c = this.firstFrame(conn, type === "reconnect" ? this.sessions.get(token) : undefined);
         if (!c) {
            this.violate(`no session for a new connection: all ${WEBUI_SESSIONS} are in use`);
            const refused = {
               type: "error",
               payload: {
                  code: "SESSION_LIMIT",
                  message: "Maximum sessions reached",
                  severity: "error",
                  recoverable: true
               }
            };
            this.note("out", JSON.stringify(refused));
            return [refused];
         }
         made = this.sessionFrames(c.session, false);
      }
      /* What an evicted connection sends still acts on the session (DAWN answers it until its
         socket closes), but a client backs off once evicted, so a change from one is a fault. */
      if (c.evicted && INTERACTIVE.has(type))
         this.violate(`${type} from a connection whose session was taken over`);
      c.session.active = ++this.activity;
      let out: object[];
      if (type === "init")
         out = made; // only syncs capabilities once there's a session
      else if (type === "reconnect")
         out = this.reconnect(
            typeof payload.token === "string" ? payload.token : "",
            conn,
            c,
            made
         );
      else if (ANSWERED.has(type)) {
         const s = c.session;
         out = answerFrame(type, payload, this.store, s.pick);
         /* A conversation the connection loaded or re-anchored to is where its turns run; a load
            also restores its reasoning on the session (webui_restore.c). */
         const ok = (out[0] as { payload?: { success?: unknown } }).payload?.success === true;
         if (ok && (type === "load_conversation" || type === "set_active_conversation")) {
            c.conversation = Number(payload.conversation_id);
            const saved = this.store.get(c.conversation);
            if (type === "load_conversation" && saved) s.pick = { ...saved.pick };
         }
      } else if (INTERACTIVE.has(type)) out = this.interact(type, payload, conn, c);
      else if (SILENT.has(type)) out = [];
      /* DAWN reads `req` from the payload (webui_protocol.c webui_protocol_payload_req). */
      else if (OPTIONAL.includes(type))
         out = [unknownType(type, typeof payload.req === "string" ? payload.req : undefined)];
      else {
         /* A request the fake has no rule for: a new client request needs a decision here. */
         this.violate(`unexpected request: ${type || "(no type)"}`);
         out = [unknownType(type)];
      }
      /* A session the first frame made sends its connect frames before the answer. */
      if (type !== "init" && type !== "reconnect") out = [...made, ...out];
      for (const f of out) this.note("out", JSON.stringify(f));
      return out;
   }

   /* Stops every frame still scheduled (a transport closing down). The turns they belonged to
      are over, so no session is left waiting on one. */
   dispose(): void {
      for (const t of this.timers) clearTimeout(t);
      this.timers.clear();
      for (const s of this.sessions.values()) {
         s.busy = false;
         s.queue.length = 0;
      }
   }

   /* Pushes a frame through the transport now. */
   private push(frame: object, to: Delivery): void {
      this.note("out", JSON.stringify(frame));
      this.onPush?.(frame, to);
   }

   /* Runs `fn` after `ms`; a fault in it is a violation, never a throw out of a timer (which
      would stop a dev server). */
   private later(ms: number, fn: () => void): void {
      const t = setTimeout(() => {
         this.timers.delete(t);
         try {
            fn();
         } catch (e) {
            this.violate(`the fake failed in a scheduled frame: ${(e as Error).message}`);
         }
      }, ms);
      this.timers.add(t);
   }

   /* The requests that change the session (INTERACTIVE). */
   private interact(
      type: string,
      payload: Record<string, unknown>,
      conn: string,
      c: Connection
   ): object[] {
      const s = c.session;
      switch (type) {
         /* webui_history.c: the conversation is created with the title given (not echoed) and the
            session's reasoning; every tab's list hears of it first, then the reply; the
            connection's turns now run in it. */
         case "new_conversation": {
            const made = this.store.create(
               typeof payload.title === "string" ? payload.title : "",
               s.pick
            );
            c.conversation = made.id;
            const created = {
               type: "conversation_list_changed",
               payload: { conversation_id: made.id, reason: "created" }
            };
            this.push(created, { except: conn });
            return [
               created,
               {
                  type: "new_conversation_response",
                  payload: { success: true, conversation_id: made.id, is_private: false }
               }
            ];
         }
         /* webui_history.c: the connection leaves its conversation; nothing else is sent. */
         case "clear_session":
            c.conversation = 0;
            return [{ type: "clear_session_response", payload: { success: true } }];
         case "set_session_llm":
            return this.setSessionLlm(payload, s, c);
         case "text":
            return this.textTurn(payload, c);
         default:
            throw new Error(`fake DAWN: no handler for ${type}`);
      }
   }

   /* A typed turn arrives. Refused when empty (webui_message_dispatch.c: only space, tab, CR and
      LF count as empty) or when too many are already waiting; queued behind a running turn; run
      at once otherwise. A turn naming a conversation the user has runs there (DAWN re-anchors
      the session to it, webui_history.c conn_reanchor_conversation). */
   private textTurn(payload: Record<string, unknown>, c: Connection): object[] {
      const s = c.session;
      /* webui_turn_ref.c: a client_ref present must be 1 to 64 printable ASCII characters; any
         other is refused before anything runs, and that error names no turn. */
      const clientRef = payload.client_ref;
      if (
         clientRef !== undefined &&
         !(typeof clientRef === "string" && /^[ -~]{1,64}$/.test(clientRef))
      ) {
         this.violate(`a text frame with an invalid client_ref: ${JSON.stringify(clientRef)}`);
         return [
            {
               type: "error",
               payload: {
                  code: "INVALID_CLIENT_REF",
                  message: "client_ref must be 1 to 64 printable ASCII characters",
                  severity: "error",
                  recoverable: true
               }
            }
         ];
      }
      const text = turnText(payload.text);
      /* The re-anchor comes first, even for a turn then refused (webui_message_dispatch.c). */
      const named = Number(payload.conversation_id);
      if (named > 0 && this.store.get(named)) c.conversation = named;
      const refuse = (code: string, message: string): object[] => [
         {
            type: "error",
            payload: {
               code,
               message,
               severity: "error",
               recoverable: true,
               ...(clientRef ? { client_ref: clientRef } : {})
            }
         }
      ];
      if (!text.replace(/[ \t\r\n]/g, ""))
         return refuse("EMPTY_MESSAGE", "A message needs text or at least one image");
      if (s.busy) {
         if (s.queue.length >= TURN_QUEUE_CAP)
            return refuse(
               "TURN_QUEUE_FULL",
               /* DAWN's own text, with its em dash, escaped so this source stays free of one. */
               "You have too many messages queued \u2014 wait for the current reply."
            );
         s.queue.push({ ...payload, text, conversation_id: c.conversation });
         return [];
      }
      return this.runTurn({ ...payload, text, conversation_id: c.conversation }, s, true);
   }

   /* Runs a turn (turns.ts): its frames at time 0 go out at once (returned when the turn is the
      request being answered, pushed when it comes off the queue), the rest when due; the reply
      row is saved when the turn finishes, and the next queued turn starts then. */
   private runTurn(payload: Record<string, unknown>, s: Session, answering: boolean): object[] {
      const text = payload.text as string;
      const clientRef = typeof payload.client_ref === "string" ? payload.client_ref : undefined;
      /* The conversation the turn was sent in (fixed when it arrived), if it's still there. */
      const want = Number(payload.conversation_id);
      const conv = want > 0 && this.store.get(want) ? want : 0;
      const user = conv ? this.store.reserve("user", text) : undefined;
      if (user) this.store.add(conv, user);
      const reply = conv ? this.store.reserve("assistant", cannedReply(text)) : undefined;
      const frames = turnFrames(
         {
            text,
            clientRef,
            conversationId: conv,
            userMessageId: user?.id,
            replyMessageId: reply?.id,
            streamId: ++s.streamId
         },
         this.timing
      );
      s.busy = true;
      const last = frames.reduce((max, f) => Math.max(max, f.at), 0);
      /* The turn is over: the next queued turn starts. */
      const finish = (): void => {
         s.busy = false;
         const next = s.queue.shift();
         if (next) this.runTurn(next, s, false);
      };
      const now: object[] = [];
      /* The sender is whichever connection owns the session when a frame goes out (a reload's
         reconnect gets the rest of the reply; with none, the frame goes nowhere). The other tabs
         are every other connection of the user. */
      const deliver = (frame: object, to: "sender" | "others", at: number): void => {
         if (to === "others") this.push(frame, { except: s.owner ?? "" });
         else if (answering && at === 0) now.push(frame);
         else if (s.owner !== null) this.push(frame, { conn: s.owner });
      };
      /* Frames due together go in one timer, in order; the reply is saved just before the
         turn's last frames go out (DAWN saves it, then sends message_appended). */
      const byTime = new Map<number, typeof frames>();
      for (const f of frames) byTime.set(f.at, [...(byTime.get(f.at) ?? []), f]);
      for (const [at, group] of byTime) {
         const send = (): void => {
            if (at === last && reply) this.store.add(conv, reply);
            try {
               for (const f of group) deliver(f.frame, f.to, at);
            } finally {
               if (at === last) finish(); // a fault sending can't leave the session stuck busy
            }
         };
         if (at === 0) send();
         else this.later(at, send);
      }
      return now;
   }

   /* set_session_llm (webui_message_dispatch.c, webui_reasoning.c): a valid mode or effort name
      becomes the pick (an unknown one is ignored); the effective value is resolved against this
      fake's one model, and reasoning_adjusted says a field this request set was fitted. The
      picks are stamped on the connection's conversation. The reply echoes the effective values
      (and on a refusal still the current config), then the model's context frame follows. */
   private setSessionLlm(payload: Record<string, unknown>, s: Session, c: Connection): object[] {
      const config = (pick: ReasoningPick): Record<string, unknown> => ({
         type: "cloud",
         provider: "claude",
         model: MODEL,
         ...reasoningFields(pick),
         openai_available: false,
         claude_available: true,
         gemini_available: false,
         openrouter_available: false
      });
      /* Provider names match exactly; one DAWN doesn't know is ignored, and only Claude has a
         key here. */
      if (["openai", "gemini", "openrouter"].includes(payload.provider as string))
         return [
            {
               type: "set_session_llm_response",
               payload: {
                  success: false,
                  error: "API key not configured for requested provider",
                  ...config(s.pick),
                  reasoning_adjusted: false
               }
            }
         ];
      if (payload.type === "reset") s.pick = { ...DEFAULT_PICK };
      const setMode =
         typeof payload.thinking_mode === "string" && VALID_MODES.includes(payload.thinking_mode);
      const setEffort =
         typeof payload.reasoning_effort === "string" &&
         VALID_EFFORTS.includes(payload.reasoning_effort);
      if (setMode) s.pick.mode = payload.thinking_mode as string;
      if (setEffort) s.pick.effort = payload.reasoning_effort as string;
      const effective = resolveReasoning(s.pick);
      /* llm_capabilities.c: only a named mode the model lacks is a fit; "enabled" (older
         clients' "reasoning on") and "auto" never are. */
      const namedMode = s.pick.mode === "disabled" || s.pick.mode === "adaptive";
      const adjusted =
         (setMode && namedMode && effective.mode !== s.pick.mode) ||
         (setEffort && effective.mode !== "disabled" && effective.effort !== s.pick.effort);
      const saved = this.store.get(c.conversation);
      if (saved) saved.pick = { ...s.pick };
      return [
         {
            type: "set_session_llm_response",
            payload: { success: true, ...config(s.pick), reasoning_adjusted: adjusted }
         },
         { type: "context", payload: { current: 0, max: 200000, usage: 0, threshold: 80 } }
      ];
   }

   /* The frame log, one line per entry, for the test report. */
   transcript(): string {
      return this.log
         .map((e) => `${String(e.at).padStart(6)}ms ${e.dir.padEnd(4)} ${e.text}`)
         .join("\n");
   }
}
