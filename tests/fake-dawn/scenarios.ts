/* The fake DAWN's scenarios and the frames it answers with, in DAWN's wire format.

   Provenance: each builder names the DAWN source it mirrors (checked against the DAWN commit in
   CHECKED_AGAINST below, 2026-11-02) and, where it has one, the section of DAWN's
   docs/WEBSOCKET_PROTOCOL.md. When DAWN changes one of these shapes, update the builder and its
   note together. Times are relative to now,
   so "today" views stay populated whenever the test runs. */

import {
   ConversationStore,
   DEFAULT_PICK,
   conversationRow,
   type ReasoningPick
} from "./conversations.ts";

/* The DAWN commit these fixtures were last checked against (`npm run check:fixtures` reports what
   has changed in DAWN's WebUI and protocol doc since). */
export const CHECKED_AGAINST = "d93ba620";

/* The behaviour flags this DAWN advertises (webui_protocol.c's always-on table; the email flags
   depend on the email service, which these scenarios leave out). */
export const CURRENT_FEATURES = [
   "logout_closes_sockets",
   "app_logins",
   "image_turns_by_id",
   "image_only_turns",
   "turn_refs",
   "document_attachments",
   "visual_prompt_guard",
   "login_unavailable"
];

export interface Scenario {
   name: string;
   /* Logged in, as far as /api/auth/status is concerned. */
   authenticated: boolean;
   username: string;
   protocol: number;
   /* The config frame's protocol, when it differs from the status reply's (a DAWN upgraded between
      the page's status check and its socket). */
   configProtocol?: number;
   /* undefined = a DAWN from before feature flags (no `features` anywhere). */
   features: string[] | undefined;
   /* localStorage the page starts with (a returning user's browser). */
   storage: Record<string, string>;
}

export const USERNAME = "operator";
export const CONVERSATION_ID = 42;

/* A returning user's browser: who signed in last (so a resume isn't a user switch, which wipes and
   reloads), and the conversation that was open (so the resume loads its transcript). */
const RETURNING: Record<string, string> = {
   "dawn.hero.lastUser": USERNAME,
   "dawn.hero.convId": String(CONVERSATION_ID)
};

export const SCENARIOS = {
   signedOut: {
      name: "signedOut",
      authenticated: false,
      username: "",
      protocol: 1,
      features: CURRENT_FEATURES,
      storage: {}
   },
   signedIn: {
      name: "signedIn",
      authenticated: true,
      username: USERNAME,
      protocol: 1,
      features: CURRENT_FEATURES,
      storage: RETURNING
   },
   legacyDawn: {
      name: "legacyDawn",
      authenticated: true,
      username: USERNAME,
      protocol: 1,
      features: undefined,
      storage: RETURNING
   },
   protocolMismatch: {
      name: "protocolMismatch",
      authenticated: true,
      username: USERNAME,
      protocol: 2,
      features: CURRENT_FEATURES,
      storage: RETURNING
   },
   upgradedMidLoad: {
      name: "upgradedMidLoad",
      authenticated: true,
      username: USERNAME,
      protocol: 1,
      configProtocol: 2,
      features: CURRENT_FEATURES,
      storage: RETURNING
   }
} satisfies Record<string, Scenario>;

/* `protocol` + `features` as DAWN adds them to the config frame and the status reply
   (webui_protocol.c webui_protocol_json_members; protocol doc, Protocol version and feature
   flags). An older DAWN sends neither. */
function contract(s: Scenario, protocol = s.protocol): Record<string, unknown> {
   return s.features === undefined ? {} : { protocol, features: s.features };
}

/* GET /api/auth/status (webui_http.c handle_auth_status). With per-app logins the untagged ask
   describes the WebUI's login, which these scenarios leave signed out: only the tagged ask says
   whether Aurora is logged in, so a client that trusts the wrong one shows the login card. */
export function authStatus(s: Scenario, tagged: boolean): Record<string, unknown> {
   const appLogins = s.features?.includes("app_logins") === true;
   const loggedIn = s.authenticated && (tagged || !appLogins);
   return loggedIn
      ? { authenticated: true, username: s.username, is_admin: false, ...contract(s) }
      : { authenticated: false, ...contract(s) };
}

/* The session a connect lands on: its token, whether it's the client's own session taken back
   (reconnected) or a new one, and its id. */
export interface SessionInfo {
   token: string;
   reconnected: boolean;
   sessionId: number;
}

/* The four frames DAWN queues on connect, in order (webui_send.c queue_init_messages; protocol doc,
   Session & State), for the session the connection landed on. */
export function connectFrames(
   s: Scenario,
   session: SessionInfo = { token: "0".repeat(32), reconnected: false, sessionId: 1 }
): object[] {
   return [
      {
         type: "session",
         payload: {
            token: session.token,
            authenticated: true,
            username: s.username,
            is_admin: false,
            reconnected: session.reconnected,
            session_id: session.sessionId,
            timezone: "UTC"
         }
      },
      {
         type: "config",
         payload: {
            audio_chunk_ms: 200,
            music_enabled: false, // no music socket in these scenarios
            music_port: 3001,
            version: "0.0.0-fake",
            ...contract(s, s.configProtocol ?? s.protocol)
         }
      },
      { type: "server_features", payload: { home_assistant: false } },
      { type: "state", payload: { state: "idle" } }
   ];
}

/* What DAWN sends a connection whose session another just took over, before closing it with 4001
   (webui_server.c webui_evict_session_owner). */
export function superseded(): object {
   return { type: "session_superseded", payload: { reason: "superseded" } };
}

/* What DAWN sends each socket of a login that just ended, before closing it with 4002
   (webui_login_sweep.c webui_conn_end_login, webui_send.c send_force_logout_impl). */
export function forceLogout(): object {
   return { type: "force_logout", payload: { reason: "Signed out" } };
}

/* DAWN echoes request_type and req only when they're short, clean text (webui_protocol.c
   webui_protocol_echo_ok: at most 64 bytes of valid UTF-8, no control characters). */
const echoOk = (v: string | undefined): v is string =>
   v !== undefined &&
   v !== "" &&
   new TextEncoder().encode(v).length <= 64 &&
   [...v].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f);

/* DAWN's answer to a type it doesn't handle (webui_protocol.c webui_protocol_unknown_type_json). */
export function unknownType(requestType: string, req?: string): object {
   return {
      type: "error",
      payload: {
         code: "UNKNOWN_TYPE",
         message: "This server doesn't handle that message type",
         severity: "error",
         recoverable: true,
         ...(echoOk(requestType) ? { request_type: requestType } : {}),
         ...(echoOk(req) ? { req } : {})
      }
   };
}

export const MODEL = "claude-sonnet-5-5";

/* A model whose reasoning can be off or adaptive (protocol doc §9.13 caps object). */
export const CAPS = {
   source: "builtin",
   modes: [
      { mode: "disabled", efforts: [], budget: false },
      { mode: "adaptive", efforts: ["low", "medium", "high"], budget: false }
   ],
   default: { mode: "adaptive", effort: "medium" }
};

/* The transcript of the conversation the user had open: markdown the renderer must turn into a
   heading, a list with a link, and a code block. */
export const TRANSCRIPT = {
   title: "Smoke test notes",
   user: "What's left before the release?",
   assistant: [
      "## Release checklist",
      "",
      "Two things remain:",
      "",
      "- Read the [release notes](https://example.com/notes)",
      "- Tag the build",
      "",
      "```sh",
      "git tag v1.0.0",
      "```"
   ].join("\n")
};

/* A store holding the conversation the user had open (TRANSCRIPT). */
export function defaultStore(): ConversationStore {
   return ConversationStore.seeded({
      id: CONVERSATION_ID,
      title: TRANSCRIPT.title,
      user: TRANSCRIPT.user,
      assistant: TRANSCRIPT.assistant
   });
}

/* DAWN's reasoning resolution for this fake's one model (webui_reasoning.c, llm_capabilities.c):
   the pick is what was asked for; the effective value is the pick when the model offers it, else
   the nearest it does (a mode it lacks becomes its adaptive; an effort snaps to the nearest
   offered). While reasoning is off the effort keeps the pick. */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
export const VALID_MODES = ["disabled", "adaptive", "enabled", "auto"];
export const VALID_EFFORTS = EFFORT_ORDER;
export function resolveReasoning(pick: ReasoningPick): ReasoningPick {
   const offered = CAPS.modes.map((m) => m.mode);
   const mode = offered.includes(pick.mode) ? pick.mode : "adaptive";
   if (mode === "disabled") return { mode, effort: pick.effort };
   const efforts = CAPS.modes.find((m) => m.mode === mode)?.efforts ?? [];
   const at = EFFORT_ORDER.indexOf(pick.effort);
   const effort = efforts.reduce((best, e) =>
      Math.abs(EFFORT_ORDER.indexOf(e) - at) < Math.abs(EFFORT_ORDER.indexOf(best) - at) ? e : best
   );
   return { mode, effort };
}

/* The model fields a set_session_llm reply and a conversation's llm_settings carry: effective
   values, the picks, and this model's capabilities (signal map §9.13). */
export function reasoningFields(pick: ReasoningPick): Record<string, unknown> {
   const effective = resolveReasoning(pick);
   return {
      thinking_mode: effective.mode,
      reasoning_effort: effective.effort,
      thinking_mode_pick: pick.mode,
      reasoning_effort_pick: pick.effort,
      reasoning_capabilities: CAPS
   };
}

/* The conversation settings load_conversation reports (build_conv_llm_settings_json). */
export function conversationLlm(pick: ReasoningPick): Record<string, unknown> {
   return { llm_type: "cloud", cloud_provider: "claude", model: MODEL, ...reasoningFields(pick) };
}

/* Replies to the requests the fake answers. Saved conversations come from `store` (a FakeDawn
   passes its own; a fresh seeded one otherwise), and the session's reasoning from `pick`. */
export function answerFrame(
   type: string,
   payload: Record<string, unknown>,
   store: ConversationStore = defaultStore(),
   pick: ReasoningPick = DEFAULT_PICK
): object[] {
   switch (type) {
      /* webui_config.c (get_config); protocol doc, get_config + §9.1a/§9.13 of the signal map. */
      case "get_config":
         return [
            {
               type: "get_config_response",
               payload: {
                  success: true,
                  config: {
                     general: { ai_name: "friday" },
                     llm: { cloud: { claude_models: [MODEL], vision_enabled: true } }
                  },
                  llm_runtime: {
                     type: "cloud",
                     provider: "Claude",
                     model: MODEL,
                     thinking_mode: resolveReasoning(pick).mode,
                     reasoning_effort: resolveReasoning(pick).effort,
                     openai_available: false,
                     claude_available: true,
                     gemini_available: false,
                     openrouter_available: false,
                     reasoning_capabilities: CAPS
                  },
                  reasoning_capabilities: { claude: { [MODEL]: CAPS } }
               }
            }
         ];
      /* Protocol doc, get_my_settings. */
      case "get_my_settings":
         return [
            {
               type: "get_my_settings_response",
               payload: { success: true, timezone: "", server_timezone: "UTC", units: "metric" }
            }
         ];
      /* webui_config.c (list_llm_models_response): no local models on this DAWN. */
      case "list_llm_models":
         return [
            {
               type: "list_llm_models_response",
               payload: { models: [], provider: "Unknown", endpoint: "http://127.0.0.1:8080" }
            }
         ];
      /* webui_history.c (conversation row serializer, list_conversations). */
      /* One page, as DAWN pages it (auth_db_conv.c conv_db_list): `limit` 1 to 100, else 50; a
         negative `offset` is 0; `total` counts them all. */
      case "list_conversations": {
         const rows = store.list();
         const asked = Math.trunc(Number(payload.limit));
         const limit = asked > 0 && asked <= 100 ? asked : 50;
         const offset = Math.max(0, Math.trunc(Number(payload.offset)) || 0);
         return [
            {
               type: "list_conversations_response",
               payload: {
                  success: true,
                  conversations: rows.slice(offset, offset + limit).map(conversationRow),
                  total: rows.length
               }
            }
         ];
      }
      /* webui_history.c (load_conversation, load_msg_callback, build_conv_llm_settings_json; a
         failure carries only success + error). */
      case "load_conversation": {
         const c = store.get(Number(payload.conversation_id));
         if (!c)
            return [
               {
                  type: "load_conversation_response",
                  payload: {
                     success: false,
                     error: "Conversation not found"
                  }
               }
            ];
         return [
            {
               type: "load_conversation_response",
               payload: {
                  success: true,
                  conversation_id: c.id,
                  title: c.title,
                  message_count: c.messages.length,
                  total: c.messages.length,
                  is_archived: false,
                  is_private: false,
                  llm_locked: c.messages.length > 0,
                  context_tokens: 0,
                  context_max: 200000,
                  llm_settings: conversationLlm(c.pick),
                  messages: c.messages.map((m) => ({ ...m }))
               }
            }
         ];
      }
      /* webui_attention.c (watch_list_response): no watches. */
      case "watch_list":
         return [
            {
               type: "watch_list_response",
               payload: { success: true, attention_enabled: true, watches: [], catalog: [] }
            }
         ];
      /* webui_attention.c (handle_watch_readings_subscribe -> respond_status). */
      case "watch_readings_subscribe":
         return [{ type: "watch_readings_subscribe_response", payload: { success: true } }];
      /* webui_doc_library.c (doc_library_list_response): an empty library. */
      case "doc_library_list":
         return [
            {
               type: "doc_library_list_response",
               payload: { success: true, count: 0, has_more: false, documents: [] }
            }
         ];
      /* Protocol doc, set_active_conversation: owner-scoped, one generic refusal for a
         conversation that isn't there (webui_history.c). */
      case "set_active_conversation": {
         const id = Number(payload.conversation_id);
         return [
            {
               type: "set_active_conversation_response",
               payload: !(id > 0)
                  ? { success: false, error: "Missing conversation id" }
                  : store.get(id)
                    ? { success: true, conversation_id: id, is_private: false }
                    : { success: false, conversation_id: id, error: "Conversation unavailable" }
            }
         ];
      }
      /* Protocol doc, jobs_snapshot: no active jobs. */
      case "jobs_request":
         return [{ type: "jobs_snapshot", payload: { jobs: [], truncated: false } }];
      /* webui_music.c (music_state); protocol doc, music_state: nothing queued. */
      case "music_subscribe":
         return [
            {
               type: "music_state",
               payload: {
                  playing: false,
                  paused: false,
                  track: null,
                  position_sec: 0,
                  queue_length: 0,
                  queue_index: 0,
                  queue_rev: 0,
                  repeat_mode: 0,
                  shuffle: false,
                  quality: "standard"
               }
            }
         ];
      /* webui_server.c (get_metrics_response). */
      case "get_metrics":
         return [
            {
               type: "get_metrics_response",
               payload: {
                  session: { uptime_seconds: 3600 },
                  last: { llm_ttft_ms: 420, llm_total_ms: 1800 },
                  averages: { llm_ttft_ms: 400, llm_total_ms: 1700 }
               }
            }
         ];
      /* Protocol doc, ping: seq echoed, plus the server time. */
      case "ping":
         return [
            {
               type: "pong",
               payload: {
                  ...(typeof payload.seq === "number" ? { seq: payload.seq } : {}),
                  server_time_ms: Date.now()
               }
            }
         ];
      default:
         throw new Error(`fake DAWN: no answer for ${type}`);
   }
}
