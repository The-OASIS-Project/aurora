/*
 * Model-selection contract (brief: the MODEL menu). The panel is a passive view:
 * it reads the current LLM state and reports each change, which the ingest turns
 * into a `set_session_llm` (session-only) or `set_private`. It never talks to DAWN
 * directly — same seam as the rest of the UI.
 */

export type LlmMode = "local" | "cloud";
/* DAWN's cloud provider is either a native SDK (OpenAI/Claude/Gemini) or the
   OpenRouter gateway, which fronts many models under one key. OpenRouter is a
   peer of the three natives, not a sub-mode. */
export type LlmProvider = "openai" | "claude" | "gemini" | "openrouter";
/* Only two live values (legacy "auto" was folded into "enabled" server-side). */
export type Reasoning = "disabled" | "enabled";

export interface LlmState {
   mode: LlmMode;
   provider: LlmProvider;
   model: string;
   reasoning: Reasoning;
   effort: string; // one of effortOptions
   /* Which cloud providers have a key configured (dim the rest). */
   providers: Record<LlmProvider, boolean>;
   /* Models available for the current mode+provider. */
   models: string[];
   /* Reasoning-effort values the current model accepts. */
   effortOptions: string[];
   /* The current conversation's privacy (set_private). */
   isPrivate: boolean;
}

/* What the MODEL panel drives. main.ts backs this with the DAWN ingest. */
export interface ModelControl {
   getState(): LlmState;
   /* Called whenever the LLM state changes (e.g. an llm_state_update push), so an
      open panel can re-render. */
   onChange(cb: () => void): void;
   setMode(mode: LlmMode): void;
   setProvider(provider: LlmProvider): void;
   setModel(model: string): void;
   setReasoning(reasoning: Reasoning): void;
   setEffort(effort: string): void;
   setPrivate(on: boolean): void;
}

/*
 * Reasoning-effort values a model accepts. Mirrors the daemon's
 * llm_openai_clamp_effort_for_model() rules (see the old WebUI's llm.js):
 *   gpt-5 / -mini / -nano:  low | medium | high
 *   gpt-5.1:                none | low | medium | high
 *   gpt-5.2+ / gpt-5.4*:    none | low | medium | high | xhigh
 * Everything else (Claude, Gemini, local) uses low | medium | high (token budget).
 *
 * An OpenRouter model carries a vendor-slug prefix (openai/gpt-5.5); strip it
 * before matching so the gpt-5.x rules still apply. The displayed/sent string is
 * never altered - this parse is detection-only.
 */
export function effortOptionsForModel(model: string): string[] {
   const m = model.toLowerCase().replace(/^.*\//, "");
   const minor = m.match(/^gpt-5\.(\d+)/);
   if (minor) {
      return Number(minor[1]) >= 2
         ? ["none", "low", "medium", "high", "xhigh"]
         : ["none", "low", "medium", "high"];
   }
   return ["low", "medium", "high"];
}
