// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DawnIngest } from "./dawn-ws.ts";
import { setAppLogins } from "../util/dawn-app.ts";
import { CONVERSATION_ID, answerFrame, reasoningFields } from "../../tests/fake-dawn/scenarios.ts";

/* The MODEL panel's controls that no other test runs: the reasoning and effort pickers, the
   Private switch, the clamp notice, and the vision gate after a mode switch. Driven only through
   DAWN's frames and getModelControl(), as the panel uses them. */

type Sent = { type: string; payload?: Record<string, unknown> };
let ing: Record<string, any> | null = null;
let sent: Sent[] = [];
let notices: Array<{ id: string; summary: string }> = [];

beforeEach(() => {
   localStorage.clear();
   setAppLogins(false);
   sent = [];
   notices = [];
   vi.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => {
   ing?.dispose();
   ing = null;
   vi.restoreAllMocks();
});

/* Sinks that do nothing, except notices, which are recorded. */
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
                     if (sink === "notifications" && method === "notify") {
                        const n = args[0] as { id: string; summary: string };
                        notices.push({ id: n.id, summary: n.summary });
                     }
                     return undefined;
                  }
            }
         )
   }
);

/* Connected to the fake DAWN's session: cloud Claude, a model whose reasoning can be off or
   adaptive (low / medium / high), vision on for cloud only. */
function connect(withCaps = true) {
   ing = new DawnIngest();
   ing.start(sinks);
   ing.ws = {
      readyState: WebSocket.OPEN,
      send: (t: string) => sent.push(JSON.parse(t) as Sent),
      close: () => {}
   };
   const [config] = answerFrame("get_config", {}) as Array<{
      type: string;
      payload: Record<string, unknown>;
   }>;
   if (!withCaps) {
      delete config.payload.reasoning_capabilities;
      delete (config.payload.llm_runtime as Record<string, unknown>).reasoning_capabilities;
   }
   ing.onFrame(JSON.stringify(config));
   sent.length = 0;
   const control = ing.getModelControl();
   return { control, writes: (): Sent[] => sent.filter((m) => m.type === "set_session_llm") };
}

it("the reasoning picker sends the mode", () => {
   const { control, writes } = connect();
   expect(control.getState().reasoning).toBe("adaptive");
   control.setReasoning("disabled");
   expect(writes()).toEqual([{ type: "set_session_llm", payload: { thinking_mode: "disabled" } }]);
   expect(control.getState().reasoning).toBe("disabled");
});

it("the effort picker sends the mode shown alongside it, or alone without capabilities", () => {
   const capped = connect();
   capped.control.setEffort("high");
   expect(capped.writes()).toEqual([
      { type: "set_session_llm", payload: { thinking_mode: "adaptive", reasoning_effort: "high" } }
   ]);
   ing!.dispose();
   sent = [];
   const bare = connect(false);
   bare.control.setEffort("high");
   expect(bare.writes()).toEqual([
      { type: "set_session_llm", payload: { reasoning_effort: "high" } }
   ]);
});

it("a reply DAWN adjusted to fit the model says so", () => {
   const { control } = connect();
   control.setEffort("high");
   ing!.onFrame(
      JSON.stringify({
         type: "set_session_llm_response",
         payload: {
            success: true,
            type: "cloud",
            provider: "claude",
            model: "claude-sonnet-5-5",
            ...reasoningFields({ mode: "adaptive", effort: "high" }),
            reasoning_adjusted: true
         }
      })
   );
   expect(notices.map((n) => n.id)).toContain("llm-adjusted");
});

it("the Private switch writes the open conversation, and follows what DAWN says", () => {
   const { control } = connect();
   const changed = vi.fn();
   control.onChange(changed);
   ing!.loadConversation(CONVERSATION_ID);
   const [loaded] = answerFrame("load_conversation", {
      conversation_id: CONVERSATION_ID
   }) as Array<{
      type: string;
      payload: Record<string, unknown>;
   }>;
   ing!.onFrame(JSON.stringify({ ...loaded, payload: { ...loaded.payload, is_private: true } }));
   expect(control.getState().isPrivate).toBe(true); // what DAWN said
   sent.length = 0;
   changed.mockClear();
   control.setPrivate(false);
   expect(sent).toEqual([
      { type: "set_private", payload: { conversation_id: CONVERSATION_ID, is_private: false } }
   ]);
   expect(control.getState().isPrivate).toBe(false);
   expect(changed).toHaveBeenCalled();
});

it("image attach follows the mode: cloud can see images here, local can't", () => {
   const { control } = connect();
   expect(ing!.isVisionCapable()).toBe(true);
   control.setMode("local");
   expect(ing!.isVisionCapable()).toBe(false);
});
