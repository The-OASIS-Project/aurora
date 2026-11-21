// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { mountMenu, type MenuController } from "./menu.ts";
import type { LlmState, ModelControl } from "../model/model.ts";

/* The MODEL panel's parts for DAWN #137: the selected provider stays shown (and says so) without
   an API key, a cloud session with no provider asks for one, and "Use default model" is offered
   only while the conversation has a model of its own. */

beforeAll(() => {
   class NoopObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
   }
   Object.assign(globalThis, { ResizeObserver: NoopObserver });
});

let menu: MenuController | null = null;
afterEach(() => {
   menu?.destroy();
   menu = null;
   document.body.replaceChildren();
});

function open(state: Partial<LlmState>) {
   const full: LlmState = {
      mode: "cloud",
      provider: "claude",
      model: "claude-sonnet-5-5",
      reasoning: "adaptive",
      effort: "medium",
      providers: { openai: true, claude: true, gemini: false, openrouter: false },
      noProvider: false,
      followsDefault: true,
      models: ["claude-sonnet-5-5"],
      effortOptions: [],
      reasoningCaps: null,
      reasoningNote: "",
      isPrivate: false,
      ...state
   };
   const useDefault = vi.fn();
   const ctrl: ModelControl = {
      getState: () => full,
      onChange: () => {},
      setMode: () => {},
      setProvider: () => {},
      setModel: () => {},
      setReasoning: () => {},
      setEffort: () => {},
      setPrivate: () => {},
      useDefaultModel: useDefault
   };
   menu = mountMenu(document.body, {
      getPanels: () => [],
      onTogglePanel: () => {},
      displayToggles: [],
      model: ctrl
   });
   const btn = [...document.querySelectorAll<HTMLButtonElement>(".menu-btn")].find(
      (b) => b.textContent === "Model"
   )!;
   btn.click();
   const panel = document.querySelector(".model-panel")!;
   const text = (): string => panel.textContent ?? "";
   return { panel, text, useDefault };
}

it("offers Use default model only while the conversation has a model of its own", () => {
   const following = open({ followsDefault: true });
   expect(following.text()).not.toContain("Use default model");
   menu!.destroy();
   const own = open({ followsDefault: false });
   const btn = [...own.panel.querySelectorAll("button")].find(
      (b) => b.textContent === "Use default model"
   )!;
   btn.click();
   expect(own.useDefault).toHaveBeenCalledTimes(1);
   menu!.destroy();
   expect(open({ followsDefault: null }).text()).not.toContain("Use default model");
});

it("keeps the selected provider shown without a key, and says so", () => {
   const { panel, text } = open({ provider: "gemini", model: "g1", models: ["g1"] });
   const gemini = [...panel.querySelectorAll(".model-seg-btn")].find(
      (b) => b.textContent === "Gemini"
   )!;
   expect(gemini.classList.contains("active")).toBe(true);
   expect(gemini.classList.contains("nokey")).toBe(true);
   expect(text()).toContain("Gemini has no API key");
});

it("asks for a provider when none is selected", () => {
   const { panel, text } = open({ noProvider: true, models: [] });
   const providerRow = [...panel.querySelectorAll(".model-row")].find(
      (r) => r.querySelector(".model-label")?.textContent === "Provider"
   )!;
   expect(providerRow.querySelector(".model-seg-btn.active")).toBeNull();
   expect(text()).toContain("Pick a provider");
});
