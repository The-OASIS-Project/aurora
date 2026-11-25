// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DawnIngest } from "./dawn-ws.ts";

/* What the client writes when the local model list arrives (list_llm_models_response). A received
   frame may complete or restore what the user chose, never start a new action: the list completes
   a switch to local mode the user made before it came, and otherwise only follows the model a
   llama.cpp provider has loaded (it can't switch models), as DAWN's WebUI does, with from_restore
   so DAWN doesn't save it on the conversation. For other providers DAWN's current_model is the
   session's own model echoed back (even a cloud one), so it is never taken as a local pick. */

type Sent = { type: string; payload?: Record<string, unknown> };
const clients: Array<Record<string, any>> = [];

function client(mode: "local" | "cloud", model: string) {
   const sink = new Proxy({}, { get: () => () => undefined });
   const sinks = new Proxy({}, { get: () => sink });
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
   ing.modelFeed.llm.mode = mode;
   ing.modelFeed.llm.model = model;
   const frame = (type: string, payload: object): void =>
      ing.onFrame(JSON.stringify({ type, payload }));
   const llmWrites = (): Sent[] => sent.filter((m) => m.type === "set_session_llm");
   return { ing, sent, frame, llmWrites };
}

/* A list as DAWN sends it (webui_config.c): llama.cpp reports the loaded model as current_model;
   other providers echo the session's model there. */
const list = (provider: string, names: string[], current: string) => ({
   models: names.map((name) => ({ name })),
   provider,
   current_model: current,
   count: names.length
});

beforeEach(() => {
   localStorage.clear();
   vi.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => {
   for (const ing of clients.splice(0)) ing.dispose();
   vi.restoreAllMocks();
});

describe("the local model list arriving", () => {
   it("llama.cpp in local mode: the session follows the loaded model, not saved as a choice", () => {
      const c = client("local", "old-model");
      c.frame("list_llm_models_response", list("llama.cpp", ["loaded.gguf"], "loaded.gguf"));
      expect(c.llmWrites()).toEqual([
         {
            type: "set_session_llm",
            payload: { type: "local", model: "loaded.gguf", from_restore: true }
         }
      ]);
      expect(c.ing.modelFeed.llm.model).toBe("loaded.gguf");
   });

   it("Ollama: current_model is the session's own echoed back, so nothing is written", () => {
      const c = client("local", "llama3");
      c.frame("list_llm_models_response", list("Ollama", ["llama3", "qwen"], "llama3"));
      expect(c.llmWrites()).toEqual([]);
   });

   it("a late list never undoes a local model the user picked meanwhile", () => {
      const c = client("local", "llama3");
      c.ing.getModelControl().setModel("qwen"); // while the connect-time list was in flight
      c.frame("list_llm_models_response", list("Ollama", ["llama3", "qwen"], "llama3"));
      expect(c.llmWrites()).toEqual([
         { type: "set_session_llm", payload: { type: "local", model: "qwen" } }
      ]);
      expect(c.ing.modelFeed.llm.model).toBe("qwen");
   });

   it('leaves a stored model alone, and ignores DAWN\'s "(unknown)" placeholder', () => {
      const c = client("local", "removed-model");
      c.frame("list_llm_models_response", list("Ollama", [], "(unknown)"));
      expect(c.llmWrites()).toEqual([]);
      expect(c.ing.modelFeed.llm.model).toBe("removed-model");
   });

   it("writes nothing in cloud mode", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.frame("list_llm_models_response", list("llama.cpp", ["loaded.gguf"], "loaded.gguf"));
      expect(c.llmWrites()).toEqual([]);
   });
});

describe("switching to local mode", () => {
   it("never takes the cloud model DAWN echoed as the local pick", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.frame("list_llm_models_response", list("Ollama", ["llama3", "qwen"], "claude-sonnet-5-5"));
      c.ing.getModelControl().setMode("local");
      /* One message: the pick and its model (DAWN #137). */
      expect(c.llmWrites()).toEqual([
         { type: "set_session_llm", payload: { type: "local", model: "llama3" } }
      ]);
   });

   it("before the list arrives: the list completes it, as the user's choice", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.getModelControl().setMode("local"); // no local list yet
      expect(c.llmWrites()).toEqual([{ type: "set_session_llm", payload: { type: "local" } }]);
      c.frame("list_llm_models_response", list("Ollama", ["llama3", "qwen"], "claude-sonnet-5-5"));
      expect(c.llmWrites().at(-1)).toEqual({
         type: "set_session_llm",
         payload: { type: "local", model: "llama3" }
      });
   });

   it("with llama.cpp: picks the model it has loaded", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.frame("list_llm_models_response", list("llama.cpp", ["loaded.gguf"], "loaded.gguf"));
      c.ing.getModelControl().setMode("local");
      expect(c.llmWrites().at(-1)).toEqual({
         type: "set_session_llm",
         payload: { type: "local", model: "loaded.gguf" }
      });
   });

   it("isn't completed after the user went back, or opened a conversation, meanwhile", () => {
      const back = client("cloud", "claude-sonnet-5-5");
      back.ing.getModelControl().setMode("local");
      back.ing.getModelControl().setMode("cloud");
      const sentBack = back.llmWrites().length;
      back.frame("list_llm_models_response", list("Ollama", ["llama3"], "claude-sonnet-5-5"));
      expect(back.llmWrites()).toHaveLength(sentBack);

      const opened = client("cloud", "claude-sonnet-5-5");
      /* The curated cloud list lacks the conversation's older model, so a completed "pick" would
         replace it. */
      opened.ing.modelFeed.cloudModels.claude = ["claude-sonnet-5-5"];
      opened.ing.getModelControl().setMode("local");
      /* A conversation is loaded before the list comes: its own settings stand. */
      opened.ing.modelFeed.applyConvLlmSettings({
         llm_type: "cloud",
         cloud_provider: "claude",
         model: "claude-legacy-4"
      });
      const sentOpened = opened.llmWrites().length;
      opened.frame("list_llm_models_response", list("Ollama", ["llama3"], "claude-legacy-4"));
      expect(opened.llmWrites()).toHaveLength(sentOpened);
      expect(opened.ing.modelFeed.llm.model).toBe("claude-legacy-4");
   });

   it("a config reply asked before the switch doesn't undo it", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.askConfig(); // the connect-time get_config, still in flight
      c.ing.getModelControl().setMode("local");
      /* Its reply is a snapshot from before the switch. */
      c.frame("get_config_response", {
         success: true,
         llm_runtime: { type: "cloud", provider: "Claude", model: "claude-sonnet-5-5" }
      });
      expect(c.ing.modelFeed.llm.mode).toBe("local");
      c.frame("list_llm_models_response", list("Ollama", ["llama3"], "claude-sonnet-5-5"));
      expect(c.llmWrites().at(-1)).toEqual({
         type: "set_session_llm",
         payload: { type: "local", model: "llama3" }
      });
   });

   it("New Chat, or a load with no settings, ends a switch's wait", () => {
      for (const end of [
         (ing: Record<string, any>) => ing.newChat(),
         (ing: Record<string, any>) => ing.modelFeed.applyConvLlmSettings(undefined)
      ]) {
         const c = client("cloud", "claude-sonnet-5-5");
         c.ing.getModelControl().setMode("local");
         end(c.ing);
         c.frame("list_llm_models_response", list("Ollama", ["llama3"], "claude-sonnet-5-5"));
         expect(c.llmWrites().some((m) => m.payload?.model === "llama3")).toBe(false);
      }
   });

   it("a refused switch isn't retried when the list arrives", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.getModelControl().setMode("local");
      c.frame("set_session_llm_response", {
         success: false,
         error: "Local LLM not available",
         type: "cloud",
         provider: "claude",
         model: "claude-sonnet-5-5"
      });
      expect(c.ing.modelFeed.llm.mode).toBe("cloud"); // what the session still runs
      const before = c.llmWrites().length;
      c.frame("list_llm_models_response", list("Ollama", ["llama3"], "claude-sonnet-5-5"));
      expect(c.llmWrites()).toHaveLength(before);
   });

   it("from OpenRouter, the local pick is the first local model, not OpenRouter's default index", () => {
      const c = client("cloud", "openai/gpt-5.5");
      c.ing.modelFeed.llm.provider = "openrouter";
      c.ing.modelFeed.defaultModelIdx.openrouter = 1;
      c.frame("list_llm_models_response", list("Ollama", ["llama3", "qwen"], "openai/gpt-5.5"));
      c.ing.getModelControl().setMode("local");
      expect(c.llmWrites().at(-1)).toEqual({
         type: "set_session_llm",
         payload: { type: "local", model: "llama3" }
      });
   });

   it("follows llama.cpp's loaded model whichever of the list and the config comes first", () => {
      const runtime = {
         success: true,
         llm_runtime: { type: "local", provider: "", model: "old-model" }
      };
      const listFirst = client("cloud", ""); // nothing known yet on this connection
      listFirst.ing.askConfig();
      listFirst.frame(
         "list_llm_models_response",
         list("llama.cpp", ["loaded.gguf"], "loaded.gguf")
      );
      listFirst.frame("get_config_response", runtime);
      expect(listFirst.llmWrites()).toEqual([
         {
            type: "set_session_llm",
            payload: { type: "local", model: "loaded.gguf", from_restore: true }
         }
      ]);

      const configFirst = client("cloud", "");
      configFirst.ing.askConfig();
      configFirst.frame("get_config_response", runtime);
      configFirst.frame(
         "list_llm_models_response",
         list("llama.cpp", ["loaded.gguf"], "loaded.gguf")
      );
      expect(configFirst.llmWrites()).toEqual([
         {
            type: "set_session_llm",
            payload: { type: "local", model: "loaded.gguf", from_restore: true }
         }
      ]);
   });

   it("an older echo can't cancel a newer switch (local, cloud, local in quick succession)", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      const control = c.ing.getModelControl();
      control.setMode("local");
      control.setMode("cloud");
      control.setMode("local"); // the latest choice, still waiting for the list
      const echo = (type: string) =>
         c.frame("set_session_llm_response", {
            success: true,
            type,
            provider: "claude",
            model: "claude-sonnet-5-5"
         });
      echo("local");
      echo("cloud"); // older: mustn't undo the final switch
      expect(c.ing.modelFeed.llm.mode).toBe("local");
      echo("local");
      c.frame("list_llm_models_response", list("Ollama", ["llama3"], "claude-sonnet-5-5"));
      expect(c.llmWrites().at(-1)).toEqual({
         type: "set_session_llm",
         payload: { type: "local", model: "llama3" }
      });
   });

   it("a lists-only config reply never changes the selection, even after DAWN's tool switched it", () => {
      const c = client("local", "old-model");
      c.ing.requestConfigRefresh(); // the MODEL panel opened: a lists-only ask, in flight
      c.ing.modelFeed.applyLlmState(
         JSON.stringify({
            type: "llm_state_update",
            payload: { type: "cloud", provider: "Claude", model: "claude-opus-5-5" }
         })
      ); // a tool switched the model, and asks for the full config
      const snapshot = (type: string, model: string) =>
         c.frame("get_config_response", {
            success: true,
            llm_runtime: { type, provider: "Claude", model }
         });
      snapshot("local", "old-model"); // the lists-only reply, from before the switch
      expect([c.ing.modelFeed.llm.mode, c.ing.modelFeed.llm.model]).toEqual([
         "cloud",
         "claude-opus-5-5"
      ]);
      snapshot("cloud", "claude-opus-5-5"); // the full re-read
      expect([c.ing.modelFeed.llm.mode, c.ing.modelFeed.llm.model]).toEqual([
         "cloud",
         "claude-opus-5-5"
      ]);
      expect(c.llmWrites()).toEqual([]);
   });

   it("an older reply's reasoning doesn't overwrite the newer model's", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.modelFeed.llm.reasoning = "adaptive";
      c.ing.modelFeed.llm.effort = "medium";
      const control = c.ing.getModelControl();
      control.setModel("claude-a");
      control.setModel("claude-b");
      c.frame("set_session_llm_response", {
         success: true,
         model: "claude-a",
         thinking_mode: "disabled",
         reasoning_effort: "low"
      });
      expect([c.ing.modelFeed.llm.model, c.ing.modelFeed.llm.reasoning]).toEqual([
         "claude-b",
         "adaptive"
      ]);
      c.frame("set_session_llm_response", {
         success: true,
         model: "claude-b",
         thinking_mode: "adaptive",
         reasoning_effort: "high"
      });
      expect(c.ing.modelFeed.llm.effort).toBe("high");
   });

   it("a new connection forgets the old local list: a switch waits for the new one", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.modelFeed.localModels = ["gone-model"]; // from before DAWN restarted
      const sockets: Array<{ onopen: (() => void) | null }> = [];
      vi.stubGlobal(
         "WebSocket",
         Object.assign(
            class {
               static OPEN = 1;
               readyState = 1;
               binaryType = "";
               onopen: (() => void) | null = null;
               onmessage = null;
               onclose = null;
               onerror = null;
               constructor() {
                  sockets.push(this);
               }
               send(t: string): void {
                  c.sent.push(JSON.parse(t));
               }
               close(): void {}
            },
            { OPEN: 1 }
         )
      );
      vi.stubGlobal("__APP_VERSION__", "test"); // the build defines it; the handshake sends it
      c.ing.openSocket();
      sockets[0].onopen?.();
      const before = c.llmWrites().length;
      c.ing.getModelControl().setMode("local");
      expect(c.llmWrites().slice(before)).toEqual([
         { type: "set_session_llm", payload: { type: "local" } }
      ]);
      vi.unstubAllGlobals();
   });

   it("a refusal shows the session's reasoning as well as its model", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.modelFeed.llm.reasoning = "adaptive";
      c.ing.modelFeed.llm.effort = "medium";
      const control = c.ing.getModelControl();
      control.setModel("claude-a"); // accepted, but its reply is no longer the latest
      control.setProvider("openai"); // refused: no API key
      c.frame("set_session_llm_response", { success: true, model: "claude-a" });
      c.frame("set_session_llm_response", {
         success: false,
         error: "API key not configured for requested provider",
         type: "cloud",
         provider: "Claude",
         model: "claude-a",
         thinking_mode: "adaptive",
         reasoning_effort: "high"
      });
      expect([
         c.ing.modelFeed.llm.provider,
         c.ing.modelFeed.llm.model,
         c.ing.modelFeed.llm.effort
      ]).toEqual(["claude", "claude-a", "high"]);
   });

   it("a delayed echo doesn't undo a conversation load or a tool switch made after its write", () => {
      for (const after of [
         (ing: Record<string, any>) =>
            ing.modelFeed.applyConvLlmSettings({
               llm_type: "cloud",
               cloud_provider: "claude",
               model: "claude-opus-5-5",
               thinking_mode: "adaptive",
               reasoning_effort: "high"
            }),
         (ing: Record<string, any>) =>
            ing.modelFeed.applyLlmState(
               JSON.stringify({
                  type: "llm_state_update",
                  payload: { type: "cloud", provider: "Claude", model: "claude-opus-5-5" }
               })
            )
      ]) {
         const c = client("cloud", "claude-sonnet-5-5");
         c.ing.getModelControl().setModel("claude-a"); // its echo is still on the way
         after(c.ing);
         c.frame("set_session_llm_response", {
            success: true,
            type: "cloud",
            provider: "Claude",
            model: "claude-a",
            thinking_mode: "disabled",
            reasoning_effort: "low"
         });
         expect(c.ing.modelFeed.llm.model).toBe("claude-opus-5-5");
         expect(c.ing.modelFeed.llm.reasoning).not.toBe("disabled");
      }
   });

   it("a loaded conversation with no stored model reads the model that actually runs", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.modelFeed.applyConvLlmSettings({ llm_type: "local", model: "" });
      expect(c.sent.filter((m) => m.type === "get_config")).toHaveLength(1);
      c.frame("get_config_response", {
         success: true,
         llm_runtime: { type: "local", provider: "", model: "configured-local" }
      });
      expect([c.ing.modelFeed.llm.mode, c.ing.modelFeed.llm.model]).toEqual([
         "local",
         "configured-local"
      ]);
      expect(c.llmWrites()).toEqual([]);
   });

   it("waits for New Chat's reset before following llama.cpp's model, then follows its mode", () => {
      for (const resetTo of ["cloud", "local"]) {
         const c = client("local", "old.gguf");
         c.ing.newChat(); // the reset's reply, with the mode it restores, is still on the way
         c.frame("list_llm_models_response", list("llama.cpp", ["loaded.gguf"], "loaded.gguf"));
         const syncs = () => c.llmWrites().filter((m) => m.payload?.from_restore === true);
         expect(syncs()).toEqual([]); // not before the reset's mode is known
         c.frame("set_session_llm_response", {
            success: true,
            type: resetTo,
            provider: "Claude",
            model: resetTo === "cloud" ? "claude-sonnet-5-5" : ""
         });
         expect(syncs()).toEqual(
            resetTo === "cloud"
               ? []
               : [
                    {
                       type: "set_session_llm",
                       payload: { type: "local", model: "loaded.gguf", from_restore: true }
                    }
                 ]
         );
      }
   });

   it("waits for a conversation being opened before following llama.cpp's model", () => {
      /* The boot or reconnect re-open goes out after the model list, so DAWN would apply a sync
         the list triggers after the load: on a cloud conversation, it would put it back on local. */
      for (const convType of ["cloud", "local"]) {
         const c = client("local", "old.gguf");
         c.ing.loadConversation(7);
         c.frame("list_llm_models_response", list("llama.cpp", ["loaded.gguf"], "loaded.gguf"));
         const syncs = () => c.llmWrites().filter((m) => m.payload?.from_restore === true);
         expect(syncs()).toEqual([]); // not before the conversation's settings are known
         c.frame("load_conversation_response", {
            success: true,
            conversation_id: 7,
            messages: [],
            llm_settings: {
               llm_type: convType,
               cloud_provider: "claude",
               model: convType === "cloud" ? "claude-sonnet-5-5" : "old.gguf"
            }
         });
         expect(c.ing.modelFeed.llm.mode).toBe(convType);
         expect(syncs()).toEqual(
            convType === "cloud"
               ? []
               : [
                    {
                       type: "set_session_llm",
                       payload: { type: "local", model: "loaded.gguf", from_restore: true }
                    }
                 ]
         );
      }
   });

   it("a config read that couldn't be sent isn't waited for", () => {
      /* DAWN's tool switched the model while the socket was closed: its config read was dropped,
         so nothing should hold the llama.cpp sync for its reply. */
      const c = client("local", "old.gguf");
      c.ing.ws.readyState = WebSocket.CLOSED;
      c.ing.modelFeed.applyLlmState(
         JSON.stringify({ payload: { type: "local", model: "old.gguf" } })
      );
      c.ing.ws.readyState = WebSocket.OPEN;
      c.frame("list_llm_models_response", list("llama.cpp", ["loaded.gguf"], "loaded.gguf"));
      expect(c.llmWrites()).toEqual([
         {
            type: "set_session_llm",
            payload: { type: "local", model: "loaded.gguf", from_restore: true }
         }
      ]);
   });

   it("a local conversation opened after the list follows llama.cpp's loaded model again", () => {
      /* The boot order: the list's sync runs first, then the opened conversation restores the model
         it was saved with, which a llama.cpp provider can't switch to. */
      const c = client("local", "loaded.gguf");
      c.frame("list_llm_models_response", list("llama.cpp", ["loaded.gguf"], "loaded.gguf"));
      c.ing.loadConversation(7);
      c.frame("load_conversation_response", {
         success: true,
         conversation_id: 7,
         messages: [],
         llm_settings: { llm_type: "local", cloud_provider: "claude", model: "old.gguf" }
      });
      expect(c.ing.modelFeed.llm.model).toBe("loaded.gguf");
      expect(c.llmWrites()).toEqual([
         {
            type: "set_session_llm",
            payload: { type: "local", model: "loaded.gguf", from_restore: true }
         }
      ]);
   });

   it("a conversation that couldn't be opened leaves the session's mode to follow", () => {
      const c = client("local", "old.gguf");
      c.ing.loadConversation(7);
      c.frame("list_llm_models_response", list("llama.cpp", ["loaded.gguf"], "loaded.gguf"));
      c.frame("load_conversation_response", { success: false, error: "Conversation not found" });
      expect(c.llmWrites()).toEqual([
         {
            type: "set_session_llm",
            payload: { type: "local", model: "loaded.gguf", from_restore: true }
         }
      ]);
   });

   it("waits for the session's config before following llama.cpp's model", () => {
      /* The mode left from the last connection is stale until the new one's config says. */
      const c = client("local", "old.gguf");
      c.ing.askConfig();
      c.frame("list_llm_models_response", list("llama.cpp", ["loaded.gguf"], "loaded.gguf"));
      c.frame("get_config_response", {
         success: true,
         llm_runtime: { type: "cloud", provider: "Claude", model: "claude-sonnet-5-5" }
      });
      expect(c.llmWrites()).toEqual([]);
      expect([c.ing.modelFeed.llm.mode, c.ing.modelFeed.llm.model]).toEqual([
         "cloud",
         "claude-sonnet-5-5"
      ]);
   });

   it("opening another conversation ends a switch's wait at once, before its settings arrive", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.getModelControl().setMode("local");
      c.ing.loadConversation(7); // its load_conversation_response is still on the way
      c.frame("list_llm_models_response", list("Ollama", ["llama3"], "claude-sonnet-5-5"));
      expect(c.llmWrites().some((m) => m.payload?.model === "llama3")).toBe(false);
   });
});

describe("opening a conversation that's gone", () => {
   it("goes back to the one still open, so turns don't go to a deleted conversation", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.convId = 7;
      c.ing.loadConversation(9); // a picker row or a batch's title, deleted meanwhile
      expect(c.ing.convId).toBe(9);
      c.frame("load_conversation_response", { success: false, error: "Conversation not found" });
      expect(c.ing.convId).toBe(7);
   });

   it("two refused in a row go back to the one on screen, not the first refused", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.convId = 7;
      c.ing.loadConversation(9);
      c.ing.loadConversation(11); // both deleted meanwhile
      c.frame("load_conversation_response", { success: false, error: "Conversation not found" });
      c.frame("load_conversation_response", { success: false, error: "Conversation not found" });
      expect(c.ing.convId).toBe(7);
   });

   it("opened twice, the first opens and the second is refused: it stays on that one", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.convId = 7;
      c.ing.loadConversation(9);
      c.ing.loadConversation(9); // a double-click
      c.frame("load_conversation_response", { success: true, conversation_id: 9, messages: [] });
      c.frame("load_conversation_response", { success: false, error: "Conversation not found" });
      expect(c.ing.convId).toBe(9);
   });

   it("leaves a view that moved on since alone", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.convId = 7;
      c.ing.loadConversation(9);
      c.ing.loadConversation(11); // opened another before the first was refused
      c.frame("load_conversation_response", { success: false, error: "Conversation not found" });
      expect(c.ing.convId).toBe(11);
   });
});

describe("with request_refs, model requests are settled by the request they name", () => {
   const refs = () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.serverFeatures = new Set(["request_refs"]);
      return c;
   };

   it("tags each with a req", () => {
      const c = refs();
      c.ing.askConfig();
      c.ing.getModelControl().setModel("claude-opus-5-5");
      c.ing.loadConversation(9);
      const tagged = c.sent
         .filter((m) => ["get_config", "set_session_llm", "load_conversation"].includes(m.type))
         .map((m) => [m.type, m.payload?.req]);
      expect(tagged).toEqual([
         ["get_config", "llm-1"],
         ["set_session_llm", "llm-2"],
         ["load_conversation", "llm-3"]
      ]);
   });

   it("a refused model change reads the session's selection again", () => {
      const c = refs();
      c.ing.getModelControl().setModel("claude-opus-5-5");
      const before = c.sent.length;
      c.frame("error", {
         code: "SERVICE_UNAVAILABLE",
         message: "Couldn't check the login; try again",
         severity: "error",
         req: "llm-1"
      });
      expect(c.ing.llmWritesOwed).toEqual([]);
      expect(c.sent.slice(before).map((m) => m.type)).toEqual(["get_config"]);
   });

   it("a refused open goes back to the conversation on screen", () => {
      const c = refs();
      c.ing.convId = 7;
      c.ing.loadConversation(9);
      c.frame("error", { code: "SERVICE_UNAVAILABLE", severity: "error", req: "llm-1" });
      expect(c.ing.convId).toBe(7);
      expect(c.ing.convLoadsOwed).toEqual([]);
   });

   it("a refused read stops holding the llama.cpp sync", () => {
      const c = refs();
      c.ing.askConfig();
      c.frame("list_llm_models_response", list("llama.cpp", ["loaded.gguf"], "loaded.gguf"));
      c.ing.modelFeed.llm.mode = "local";
      expect(c.llmWrites()).toEqual([]); // waiting for the read
      c.frame("error", { code: "SERVICE_UNAVAILABLE", severity: "error", req: "llm-1" });
      expect(c.llmWrites()).toEqual([
         {
            type: "set_session_llm",
            payload: { type: "local", model: "loaded.gguf", from_restore: true, req: "llm-2" }
         }
      ]);
   });

   it("a refused resume keeps the conversation, and resumes it once DAWN answers again", () => {
      const c = refs();
      localStorage.setItem("dawn.hero.convId", "42");
      c.ing.convId = 42;
      c.ing.resumingStored = true;
      c.ing.send({ type: "load_conversation", payload: { conversation_id: 42 } }); // llm-1
      c.frame("error", { code: "SERVICE_UNAVAILABLE", severity: "error", req: "llm-1" });
      expect(c.ing.convId).toBe(42);
      expect(localStorage.getItem("dawn.hero.convId")).toBe("42");
      c.sent.length = 0;
      c.ing.pendingPingSeq = 5;
      c.frame("pong", { seq: 5 });
      expect(c.sent.find((m) => m.type === "load_conversation")?.payload).toMatchObject({
         conversation_id: 42
      });
      expect(c.ing.resumingStored).toBe(true);
   });

   it("a refused model change is read again once DAWN answers, if its read was refused too", () => {
      const c = refs();
      c.ing.getModelControl().setModel("claude-opus-5-5"); // llm-1
      c.frame("error", { code: "SERVICE_UNAVAILABLE", severity: "error", req: "llm-1" });
      c.frame("error", { code: "SERVICE_UNAVAILABLE", severity: "error", req: "llm-2" }); // its read
      c.sent.length = 0;
      c.ing.pendingPingSeq = 5;
      c.frame("pong", { seq: 5 });
      expect(c.sent.map((m) => m.type)).toEqual(["get_config"]);
   });

   it("New Chat's refused reset isn't announced as the user's model change", () => {
      const c = refs();
      const notices: string[] = [];
      c.ing.spikeNotice = (id: string) => notices.push(id);
      c.ing.send({ type: "set_session_llm", payload: { type: "reset" } }); // llm-1
      c.frame("error", { code: "SERVICE_UNAVAILABLE", severity: "error", req: "llm-1" });
      expect(notices).not.toContain("llm-switch-error");
      expect(c.sent.at(-1)?.type).toBe("get_config"); // the selection is read all the same
   });

   it("an older read answered meanwhile doesn't end the wait for the selection", () => {
      const c = refs();
      c.ing.askConfig(); // llm-1, an older read still on its way
      c.ing.getModelControl().setModel("claude-opus-5-5"); // llm-2
      c.frame("error", { code: "SERVICE_UNAVAILABLE", severity: "error", req: "llm-2" });
      c.frame("error", { code: "SERVICE_UNAVAILABLE", severity: "error", req: "llm-3" }); // its read
      c.frame("get_config_response", {
         success: true,
         llm_runtime: { type: "cloud", provider: "Claude", model: "claude-sonnet-5-5" },
         req: "llm-1"
      }); // from before the change: applies nothing
      c.sent.length = 0;
      c.ing.pendingPingSeq = 5;
      c.frame("pong", { seq: 5 });
      expect(c.sent.map((m) => m.type)).toEqual(["get_config"]);
   });

   it("a load reply naming a request this connection doesn't owe opens nothing", () => {
      const c = refs();
      c.ing.convId = 7;
      c.frame("load_conversation_response", {
         success: true,
         conversation_id: 99,
         messages: [],
         req: "llm-41"
      });
      expect(c.ing.convId).toBe(7);
   });

   it("a refused reconnect restore or reload is sent again the same way once DAWN answers", () => {
      for (const purpose of ["reanchor", "reload"] as const) {
         const c = refs();
         c.ing.convId = 42;
         if (purpose === "reanchor") c.ing.reanchoring = true;
         c.ing.send({ type: "load_conversation", payload: { conversation_id: 42 } }); // llm-1
         c.frame("error", { code: "SERVICE_UNAVAILABLE", severity: "error", req: "llm-1" });
         expect(c.ing.reanchoring).toBe(false);
         c.sent.length = 0;
         c.ing.pendingPingSeq = 5;
         c.frame("pong", { seq: 5 });
         expect(c.sent.find((m) => m.type === "load_conversation")?.payload).toMatchObject({
            conversation_id: 42
         });
         expect(c.ing.reanchoring).toBe(purpose === "reanchor"); // a restore doesn't redraw
      }
   });

   it("while a refused load waits to be resent, pings go out despite steady traffic", () => {
      const c = refs();
      c.ing.convId = 42;
      c.ing.resumingStored = true;
      c.ing.send({ type: "load_conversation", payload: { conversation_id: 42 } }); // llm-1
      c.frame("error", { code: "SERVICE_UNAVAILABLE", severity: "error", req: "llm-1" });
      c.ing.pongSupported = true;
      c.ing.lastInboundAt = performance.now(); // music progress just arrived
      c.sent.length = 0;
      c.ing.heartbeatTick();
      expect(c.sent.map((m) => m.type)).toEqual(["ping"]);
   });

   it("an open of the user's supersedes a refused resume still to resend", () => {
      const c = refs();
      c.ing.convId = 42;
      c.ing.resumingStored = true;
      c.ing.send({ type: "load_conversation", payload: { conversation_id: 42 } }); // llm-1
      c.frame("error", { code: "SERVICE_UNAVAILABLE", severity: "error", req: "llm-1" });
      c.ing.loadConversation(42); // opened from the picker meanwhile
      c.sent.length = 0;
      c.ing.pendingPingSeq = 5;
      c.frame("pong", { seq: 5 });
      expect(c.sent.map((m) => m.type)).not.toContain("load_conversation");
   });

   it("a refused switch to local isn't sent again as llama.cpp's follow while unread", () => {
      const c = refs();
      c.ing.getModelControl().setMode("local"); // llm-1, optimistic local
      c.frame("error", { code: "SERVICE_UNAVAILABLE", severity: "error", req: "llm-1" });
      c.frame("error", { code: "SERVICE_UNAVAILABLE", severity: "error", req: "llm-2" }); // its read
      c.frame("list_llm_models_response", list("llama.cpp", ["loaded.gguf"], "loaded.gguf"));
      expect(c.llmWrites().filter((m) => m.payload?.from_restore === true)).toEqual([]);
   });

   it("a refused open ahead of a resume's reply goes back without ending the resume", () => {
      const c = refs();
      localStorage.setItem("dawn.hero.convId", "42");
      c.ing.convId = 42;
      c.ing.resumingStored = true;
      c.ing.send({ type: "load_conversation", payload: { conversation_id: 42 } }); // llm-1
      c.ing.loadConversation(9); // llm-2, opened before the resume answered
      c.frame("error", { code: "SERVICE_UNAVAILABLE", severity: "error", req: "llm-2" });
      expect(c.ing.convId).toBe(42); // back, not cleared
      expect(localStorage.getItem("dawn.hero.convId")).toBe("42");
      expect(c.ing.resumingStored).toBe(true); // the resume's own reply still decides
   });

   it("a reconnect's replay refused by name goes back and restores the one on screen", () => {
      const c = refs();
      c.ing.showConversation(7);
      c.ing.convId = 7;
      c.ing.loadConversation(9);
      c.ing.convLoadsOwed = []; // the link dropped
      c.frame("session", { authenticated: true, reconnected: false }); // replays 9, tagged
      const replay = c.sent.filter((m) => m.type === "load_conversation").at(-1);
      c.sent.length = 0;
      c.frame("error", {
         code: "SERVICE_UNAVAILABLE",
         severity: "error",
         req: replay?.payload?.req
      });
      expect(c.ing.convId).toBe(7);
      expect(c.sent.find((m) => m.type === "load_conversation")?.payload).toMatchObject({
         conversation_id: 7
      });
      expect(c.ing.reanchoring).toBe(true);
   });

   it("a model chosen while a refused resume waits is sent again after the resume", () => {
      const c = refs();
      c.ing.convId = 42;
      c.ing.resumingStored = true;
      c.ing.send({ type: "load_conversation", payload: { conversation_id: 42 } }); // llm-1
      c.frame("error", { code: "SERVICE_UNAVAILABLE", severity: "error", req: "llm-1" });
      c.ing.getModelControl().setModel("claude-opus-5-5"); // no conversation attached yet
      c.sent.length = 0;
      c.ing.pendingPingSeq = 5;
      c.frame("pong", { seq: 5 });
      const load = c.sent.find((m) => m.type === "load_conversation");
      expect(load?.payload).toMatchObject({ conversation_id: 42 });
      expect(c.sent.map((m) => m.type)).not.toContain("set_session_llm"); // not before the load
      /* The load restores the conversation's own model; then the choice goes, on it. */
      c.frame("load_conversation_response", {
         success: true,
         conversation_id: 42,
         messages: [],
         llm_settings: { llm_type: "cloud", cloud_provider: "claude", model: "claude-sonnet-5-5" },
         req: load?.payload?.req
      });
      const write = c.sent.find((m) => m.type === "set_session_llm");
      expect(write?.payload).toMatchObject({ model: "claude-opus-5-5" });
      c.frame("set_session_llm_response", {
         success: true,
         type: "cloud",
         provider: "Claude",
         model: "claude-opus-5-5",
         req: write?.payload?.req
      });
      expect(c.ing.modelFeed.llm.model).toBe("claude-opus-5-5"); // the panel shows what DAWN runs
   });

   it("an open refused while a refused resume waits puts the resume back", () => {
      const c = refs();
      c.ing.convId = 42;
      c.ing.resumingStored = true;
      c.ing.send({ type: "load_conversation", payload: { conversation_id: 42 } }); // llm-1
      c.frame("error", { code: "SERVICE_UNAVAILABLE", severity: "error", req: "llm-1" });
      c.ing.loadConversation(9); // llm-2
      c.frame("load_conversation_response", { success: false, error: "Conversation not found" });
      expect(c.ing.convId).toBe(42);
      c.sent.length = 0;
      c.ing.pendingPingSeq = 5;
      c.frame("pong", { seq: 5 });
      expect(c.sent.find((m) => m.type === "load_conversation")?.payload).toMatchObject({
         conversation_id: 42
      });
   });

   it("a reply settles the request it names, not the oldest", () => {
      const c = refs();
      c.ing.getModelControl().setModel("claude-opus-5-5"); // llm-1
      c.ing.getModelControl().setModel("claude-haiku-5-5"); // llm-2
      c.frame("set_session_llm_response", {
         success: true,
         type: "cloud",
         provider: "Claude",
         model: "claude-haiku-5-5",
         req: "llm-2"
      });
      expect(c.ing.llmWritesOwed.map((e: { req: string }) => e.req)).toEqual(["llm-1"]);
      expect(c.ing.modelFeed.llm.model).toBe("claude-haiku-5-5");
   });
});

describe("a reconnect while an opened conversation hasn't loaded", () => {
   it("loads it in full instead of re-anchoring to it under another transcript", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.showConversation(7); // A's transcript is on screen
      c.ing.convId = 7;
      c.ing.loadConversation(9); // B opened; the link drops before its reply
      c.sent.length = 0;
      c.frame("session", { authenticated: true, reconnected: true });
      const types = c.sent.map((m) => m.type);
      expect(types).toContain("load_conversation");
      expect(types).not.toContain("set_active_conversation");
      expect(c.sent.find((m) => m.type === "load_conversation")?.payload).toEqual({
         conversation_id: 9
      });
   });

   it("refused, the replay goes back to the conversation on screen and restores its context", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.showConversation(7);
      c.ing.convId = 7;
      c.ing.loadConversation(9);
      c.ing.convLoadsOwed = []; // the link dropped: a new socket owes nothing of the old one's
      c.frame("session", { authenticated: true, reconnected: false }); // a fresh session
      c.sent.length = 0;
      c.frame("load_conversation_response", { success: false, error: "Conversation not found" });
      expect(c.ing.convId).toBe(7);
      expect(c.sent.find((m) => m.type === "load_conversation")?.payload).toEqual({
         conversation_id: 7
      });
      expect(c.ing.reanchoring).toBe(true); // rebuilt server-side, not redrawn
   });

   it("an open made while the replay is unanswered also restores, if both are refused", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.showConversation(7);
      c.ing.convId = 7;
      c.ing.loadConversation(9);
      c.ing.convLoadsOwed = []; // the link dropped
      c.frame("session", { authenticated: true, reconnected: false }); // replays 9
      c.ing.loadConversation(11); // opened before the replay is answered
      c.frame("load_conversation_response", { success: false, error: "Conversation not found" });
      c.sent.length = 0;
      c.frame("load_conversation_response", { success: false, error: "Conversation not found" });
      expect(c.ing.convId).toBe(7);
      expect(c.sent.find((m) => m.type === "load_conversation")?.payload).toEqual({
         conversation_id: 7
      }); // its context rebuilt, as the fresh session holds none
   });

   it("re-anchors lightly when the conversation on screen is the active one", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.showConversation(7);
      c.ing.convId = 7;
      c.sent.length = 0;
      c.frame("session", { authenticated: true, reconnected: true });
      expect(c.sent.map((m) => m.type)).not.toContain("load_conversation");
   });
});

/* DAWN #137: a key is used only for the provider the user picked; a conversation with no pick of
   its own follows the dawn.toml default (follows_default). */
describe("following the default model", () => {
   const runtime = (rt: object) => ({ success: true, config: {}, llm_runtime: rt });
   /* DAWN sends llm_state_update inside a transcript with role __llm_state__ (webui_server.c). */
   const llmState = (c: ReturnType<typeof client>, payload: object): void =>
      c.frame("transcript", {
         role: "__llm_state__",
         text: JSON.stringify({ type: "llm_state_update", payload })
      });

   it("reads follows_default from every frame that carries it", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      const state = () => c.ing.getModelControl().getState();
      expect(state().followsDefault).toBeNull(); // an older DAWN says nothing
      c.frame(
         "get_config_response",
         runtime({ type: "cloud", provider: "Claude", follows_default: true })
      );
      expect(state().followsDefault).toBe(true);
      c.frame("load_conversation_response", {
         success: true,
         conversation_id: 7,
         messages: [],
         llm_settings: {
            follows_default: false,
            llm_type: "cloud",
            cloud_provider: "claude",
            model: "m"
         }
      });
      expect(state().followsDefault).toBe(false);
      c.frame("set_session_llm_response", {
         success: true,
         type: "cloud",
         provider: "Claude",
         follows_default: true
      });
      expect(state().followsDefault).toBe(true);
      llmState(c, {
         type: "cloud",
         provider: "claude",
         model: "m",
         follows_default: false
      });
      expect(state().followsDefault).toBe(false);
   });

   it("a conversation following the default isn't pinned to llama.cpp's loaded model", () => {
      const c = client("local", "");
      c.frame("load_conversation_response", {
         success: true,
         conversation_id: 7,
         messages: [],
         llm_settings: {
            follows_default: true,
            llm_type: "local",
            cloud_provider: "none",
            model: ""
         }
      });
      /* The empty model re-reads the session's runtime; the default it follows runs. */
      c.frame("get_config_response", {
         success: true,
         config: {},
         llm_runtime: { type: "local", provider: "none", model: "", follows_default: true }
      });
      c.frame("list_llm_models_response", list("llama.cpp", ["loaded.gguf"], "loaded.gguf"));
      expect(c.llmWrites()).toEqual([]);
   });

   it("a provider pick is one message, with that provider's model", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.modelFeed.cloudModels.openai = ["gpt-6", "gpt-6-mini"];
      c.ing.modelFeed.llm.followsDefault = true; // DAWN said so
      c.ing.getModelControl().setProvider("openai");
      expect(c.llmWrites()).toEqual([
         { type: "set_session_llm", payload: { type: "cloud", provider: "openai", model: "gpt-6" } }
      ]);
      expect(c.ing.getModelControl().getState().followsDefault).toBe(false);
   });

   it("a model pick names its type and provider", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.getModelControl().setModel("claude-opus-5-5");
      expect(c.llmWrites()).toEqual([
         {
            type: "set_session_llm",
            payload: { type: "cloud", provider: "claude", model: "claude-opus-5-5" }
         }
      ]);
   });

   it("Use default model saves a reset keeping the reasoning, never as a restore", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.modelFeed.llm.followsDefault = false;
      c.ing.modelFeed.reasoningPick = { mode: "adaptive", effort: "high" };
      c.ing.getModelControl().useDefaultModel();
      expect(c.llmWrites()).toEqual([
         {
            type: "set_session_llm",
            payload: { type: "reset", thinking_mode: "adaptive", reasoning_effort: "high" }
         }
      ]);
      expect(c.ing.getModelControl().getState().followsDefault).toBe(true);
   });

   it("a provider with no model list gets the pick alone, never the previous vendor's model", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.modelFeed.cloudModels.gemini = [];
      c.ing.getModelControl().setProvider("gemini");
      expect(c.llmWrites()).toEqual([
         { type: "set_session_llm", payload: { type: "cloud", provider: "gemini" } }
      ]);
      expect(c.ing.modelFeed.llm.model).toBe("");
   });

   it("an older DAWN that never says follows_default isn't given one", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.getModelControl().setModel("claude-opus-5-5");
      c.ing.getModelControl().useDefaultModel();
      expect(c.ing.getModelControl().getState().followsDefault).toBeNull();
   });

   it("clicking the mode or provider already picked sends nothing", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.getModelControl().setMode("cloud");
      c.ing.getModelControl().setProvider("claude");
      expect(c.llmWrites()).toEqual([]);
   });

   it("an empty local list while a switch to local waits doesn't send it again", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.getModelControl().setMode("local");
      c.frame("list_llm_models_response", list("Ollama", [], ""));
      c.frame("list_llm_models_response", list("Ollama", [], ""));
      expect(c.llmWrites()).toEqual([{ type: "set_session_llm", payload: { type: "local" } }]);
   });

   it("following the default on llama.cpp shows the loaded model without sending it", () => {
      const c = client("local", "local");
      c.ing.modelFeed.llm.followsDefault = true;
      c.frame("list_llm_models_response", list("llama.cpp", ["loaded.gguf"], "loaded.gguf"));
      expect(c.llmWrites()).toEqual([]);
      expect(c.ing.modelFeed.llm.model).toBe("loaded.gguf");
   });

   it("Use default model on llama.cpp shows the loaded model, not DAWN's placeholder", () => {
      const c = client("local", "loaded.gguf");
      c.ing.modelFeed.llm.followsDefault = false;
      c.frame("list_llm_models_response", list("llama.cpp", ["loaded.gguf"], "loaded.gguf"));
      c.ing.getModelControl().useDefaultModel();
      const sent = c.llmWrites().length;
      c.frame("set_session_llm_response", {
         success: true,
         type: "local",
         provider: "none",
         model: "local",
         follows_default: true
      });
      expect(c.ing.modelFeed.llm.model).toBe("loaded.gguf");
      expect(c.llmWrites()).toHaveLength(sent); // shown, not sent
   });

   it("a lists-only refresh doesn't take away the provider prompt the user is in", () => {
      const c = client("local", "llama3");
      c.ing.modelFeed.llm.followsDefault = true;
      c.frame("get_config_response", {
         success: true,
         config: { llm: { cloud: { provider: "" } } },
         llm_runtime: { type: "local", provider: "none", model: "llama3", follows_default: true }
      });
      c.ing.getModelControl().setMode("cloud"); // "Pick a provider"
      c.ing.getModelControl().refreshModels(); // the panel reopened
      c.frame("get_config_response", {
         success: true,
         config: {},
         llm_runtime: { type: "local", provider: "none", model: "llama3", follows_default: true }
      });
      const s = c.ing.getModelControl().getState();
      expect([s.mode, s.noProvider]).toEqual(["cloud", true]);
   });

   it("Use default model ends the provider prompt, so a changed default shows again", () => {
      const c = client("local", "llama3");
      c.ing.modelFeed.llm.followsDefault = false;
      c.frame("get_config_response", {
         success: true,
         config: { llm: { cloud: { provider: "" } } },
         llm_runtime: { type: "local", provider: "none", model: "llama3", follows_default: false }
      });
      c.ing.getModelControl().setMode("cloud"); // "Pick a provider"
      c.ing.getModelControl().useDefaultModel();
      c.frame("set_session_llm_response", {
         success: true,
         type: "local",
         provider: "none",
         model: "llama3",
         follows_default: true
      });
      c.ing.getModelControl().refreshModels();
      c.frame("get_config_response", {
         success: true,
         config: {},
         llm_runtime: { type: "local", provider: "none", model: "qwen", follows_default: true }
      });
      expect(c.ing.modelFeed.llm.model).toBe("qwen"); // dawn.toml's default changed meanwhile
   });

   it("dawn.toml's anthropic is Claude", () => {
      const c = client("local", "llama3");
      c.frame("get_config_response", {
         success: true,
         config: { llm: { cloud: { provider: "anthropic", claude_models: ["c1"] } } },
         llm_runtime: { type: "local" }
      });
      c.ing.getModelControl().setMode("cloud");
      expect(c.llmWrites().at(-1)?.payload).toEqual({
         type: "cloud",
         provider: "claude",
         model: "c1"
      });
   });

   it("back to Cloud lands on the default provider's configured default model, not its first", () => {
      const c = client("local", "llama3");
      c.frame("get_config_response", {
         success: true,
         config: {
            llm: {
               cloud: {
                  provider: "claude",
                  claude_models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
                  claude_default_model_idx: 1
               }
            }
         },
         llm_runtime: { type: "local" }
      });
      c.ing.getModelControl().setMode("cloud");
      expect(c.llmWrites().at(-1)?.payload).toEqual({
         type: "cloud",
         provider: "claude",
         model: "claude-sonnet-5-5"
      });
   });

   it("a lists-only refresh updates a conversation that follows the default, not one with its own pick", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.modelFeed.llm.followsDefault = true;
      c.ing.getModelControl().refreshModels(); // MODEL panel opened: a lists-only read
      c.frame("get_config_response", {
         success: true,
         config: {},
         llm_runtime: {
            type: "cloud",
            provider: "Claude",
            model: "claude-opus-5-5",
            follows_default: true
         }
      });
      expect(c.ing.modelFeed.llm.model).toBe("claude-opus-5-5"); // dawn.toml's default changed

      const own = client("cloud", "claude-sonnet-5-5");
      own.ing.modelFeed.llm.followsDefault = false;
      own.ing.getModelControl().refreshModels();
      own.frame("get_config_response", {
         success: true,
         config: {},
         llm_runtime: {
            type: "cloud",
            provider: "Claude",
            model: "claude-opus-5-5",
            follows_default: false
         }
      });
      expect(own.ing.modelFeed.llm.model).toBe("claude-sonnet-5-5");
   });

   it("Local then Cloud before Local's reply: Cloud lands on the default model, and Local's reply is stale", () => {
      const c = client("cloud", "claude-opus-5-5");
      c.frame("get_config_response", {
         success: true,
         config: {
            llm: {
               cloud: {
                  provider: "claude",
                  claude_models: ["claude-opus-5-5", "claude-sonnet-5-5"],
                  claude_default_model_idx: 1
               }
            }
         },
         llm_runtime: { type: "cloud", provider: "Claude", model: "claude-opus-5-5" }
      });
      c.ing.getModelControl().setMode("local"); // no local list yet: waits
      c.ing.getModelControl().setMode("cloud");
      expect(c.llmWrites().at(-1)?.payload).toEqual({
         type: "cloud",
         provider: "claude",
         model: "claude-sonnet-5-5"
      });
      /* The abandoned local switch isn't completed by a later list. */
      const sent = c.llmWrites().length;
      c.frame("list_llm_models_response", list("Ollama", ["llama3"], "claude-sonnet-5-5"));
      expect(c.llmWrites()).toHaveLength(sent);
   });

   it("Local then Cloud with no default provider: nothing pending, and Local's reply doesn't switch back", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.frame("get_config_response", {
         success: true,
         config: { llm: { cloud: { provider: "" } } },
         llm_runtime: { type: "cloud", provider: "Claude", model: "claude-sonnet-5-5" }
      });
      c.ing.getModelControl().setMode("local");
      c.ing.getModelControl().setMode("cloud");
      c.frame("set_session_llm_response", {
         success: true,
         type: "local",
         provider: "none",
         model: ""
      });
      expect(c.ing.modelFeed.llm.mode).toBe("cloud");
      const sent = c.llmWrites().length;
      c.frame("list_llm_models_response", list("Ollama", ["llama3"], ""));
      expect(c.llmWrites()).toHaveLength(sent);
   });

   it("Use default model replaces a switch to local still waiting for the list", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      c.ing.getModelControl().setMode("local"); // no local list yet
      c.ing.getModelControl().useDefaultModel();
      const sent = c.llmWrites().length;
      c.frame("list_llm_models_response", list("Ollama", ["llama3"], "claude-sonnet-5-5"));
      expect(c.llmWrites()).toHaveLength(sent);
   });

   it("Cloud means the provider dawn.toml names; with none named, nothing is sent until one is picked", () => {
      const named = client("local", "llama3");
      named.frame("get_config_response", {
         success: true,
         config: { llm: { cloud: { provider: "gemini", gemini_models: ["g1"] } } },
         llm_runtime: { type: "local" }
      });
      named.ing.getModelControl().setMode("cloud");
      expect(named.llmWrites().at(-1)).toEqual({
         type: "set_session_llm",
         payload: { type: "cloud", provider: "gemini", model: "g1" }
      });

      const none = client("local", "llama3");
      none.frame("get_config_response", {
         success: true,
         config: { llm: { cloud: { provider: "" } } },
         llm_runtime: { type: "local" }
      });
      const before = none.llmWrites().length;
      none.ing.getModelControl().setMode("cloud");
      none.ing.getModelControl().setModel("anything");
      expect(none.llmWrites()).toHaveLength(before);
      const s = none.ing.getModelControl().getState();
      expect(s.noProvider).toBe(true);
      expect(s.models).toEqual([]);
   });

   it("the selected provider stays shown without a key, never lit as if it had one", () => {
      const c = client("cloud", "g1");
      c.frame("load_conversation_response", {
         success: true,
         conversation_id: 7,
         messages: [],
         llm_settings: {
            follows_default: false,
            llm_type: "cloud",
            cloud_provider: "gemini",
            model: "g1"
         }
      });
      llmState(c, {
         type: "cloud",
         provider: "gemini",
         model: "g1",
         openai_available: true,
         claude_available: true,
         gemini_available: false,
         openrouter_available: false
      });
      const s = c.ing.getModelControl().getState();
      expect(s.provider).toBe("gemini");
      expect(s.providers.gemini).toBe(false);
   });

   it("a refused pick shows DAWN's reason and resyncs the picker from the reply", () => {
      const c = client("cloud", "claude-sonnet-5-5");
      const notices: string[] = [];
      c.ing.spikeNotice = (_id: string, _k: string, text: string) => notices.push(text);
      c.ing.getModelControl().setProvider("gemini");
      c.frame("set_session_llm_response", {
         success: false,
         error: "Gemini is selected, but it has no API key. Add one in Settings, or pick another provider.",
         type: "cloud",
         provider: "Claude",
         model: "claude-sonnet-5-5",
         follows_default: true,
         openai_available: false,
         claude_available: true,
         gemini_available: false,
         openrouter_available: false
      });
      const s = c.ing.getModelControl().getState();
      expect(notices).toContain(
         "Gemini is selected, but it has no API key. Add one in Settings, or pick another provider."
      );
      expect([s.provider, s.model, s.followsDefault]).toEqual([
         "claude",
         "claude-sonnet-5-5",
         true
      ]);
      expect(s.providers.gemini).toBe(false);
   });
});
