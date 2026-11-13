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
   ing.llm.mode = mode;
   ing.llm.model = model;
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
         { type: "set_session_llm", payload: { model: "loaded.gguf", from_restore: true } }
      ]);
      expect(c.ing.llm.model).toBe("loaded.gguf");
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
      expect(c.ing.llm.model).toBe("qwen");
   });

   it('leaves a stored model alone, and ignores DAWN\'s "(unknown)" placeholder', () => {
      const c = client("local", "removed-model");
      c.frame("list_llm_models_response", list("Ollama", [], "(unknown)"));
      expect(c.llmWrites()).toEqual([]);
      expect(c.ing.llm.model).toBe("removed-model");
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
      expect(c.llmWrites()).toEqual([
         { type: "set_session_llm", payload: { type: "local" } },
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
      opened.ing.cloudModels.claude = ["claude-sonnet-5-5"];
      opened.ing.getModelControl().setMode("local");
      /* A conversation is loaded before the list comes: its own settings stand. */
      opened.ing.applyConvLlmSettings({
         llm_type: "cloud",
         cloud_provider: "claude",
         model: "claude-legacy-4"
      });
      const sentOpened = opened.llmWrites().length;
      opened.frame("list_llm_models_response", list("Ollama", ["llama3"], "claude-legacy-4"));
      expect(opened.llmWrites()).toHaveLength(sentOpened);
      expect(opened.ing.llm.model).toBe("claude-legacy-4");
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
      expect(c.ing.llm.mode).toBe("local");
      c.frame("list_llm_models_response", list("Ollama", ["llama3"], "claude-sonnet-5-5"));
      expect(c.llmWrites().at(-1)).toEqual({
         type: "set_session_llm",
         payload: { type: "local", model: "llama3" }
      });
   });

   it("New Chat, or a load with no settings, ends a switch's wait", () => {
      for (const end of [
         (ing: Record<string, any>) => ing.newChat(),
         (ing: Record<string, any>) => ing.applyConvLlmSettings(undefined)
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
      expect(c.ing.llm.mode).toBe("cloud"); // what the session still runs
      const before = c.llmWrites().length;
      c.frame("list_llm_models_response", list("Ollama", ["llama3"], "claude-sonnet-5-5"));
      expect(c.llmWrites()).toHaveLength(before);
   });

   it("from OpenRouter, the local pick is the first local model, not OpenRouter's default index", () => {
      const c = client("cloud", "openai/gpt-5.5");
      c.ing.llm.provider = "openrouter";
      c.ing.openrouterDefaultIdx = 1;
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
         { type: "set_session_llm", payload: { model: "loaded.gguf", from_restore: true } }
      ]);

      const configFirst = client("cloud", "");
      configFirst.ing.askConfig();
      configFirst.frame("get_config_response", runtime);
      configFirst.frame(
         "list_llm_models_response",
         list("llama.cpp", ["loaded.gguf"], "loaded.gguf")
      );
      expect(configFirst.llmWrites()).toEqual([
         { type: "set_session_llm", payload: { model: "loaded.gguf", from_restore: true } }
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
      expect(c.ing.llm.mode).toBe("local");
      echo("local");
      c.frame("list_llm_models_response", list("Ollama", ["llama3"], "claude-sonnet-5-5"));
      expect(c.llmWrites().at(-1)).toEqual({
         type: "set_session_llm",
         payload: { type: "local", model: "llama3" }
      });
   });
});
