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
/* DAWN's reasoning modes (P1.1b): off, adaptive (the model decides how much to think, up to
   the effort), and enabled (a fixed budget on Claude/local; reasoning at the chosen effort on
   OpenAI/Gemini/OpenRouter). Which ones a model offers comes from its capabilities. */
export type Reasoning = "disabled" | "adaptive" | "enabled";

/* One mode a model offers, from DAWN's per-model capabilities. `efforts` is lowest first
   ([] = no effort choice in this mode); `budget` means the efforts pick a thinking-budget
   size (`budgetTokens`), labelled "Budget" rather than "Effort". */
export interface ReasoningMode {
   mode: Reasoning;
   efforts: string[];
   budget: boolean;
   budgetTokens: Record<string, number>;
}

/* A model's reasoning capabilities. `modes` is in display order; [] = no reasoning control
   (explicitly unsupported, not unknown). `default` is what a new conversation gets. */
export interface ReasoningCaps {
   modes: ReasoningMode[];
   default: { mode: Reasoning | ""; effort: string };
}

const REASONING_MODES: readonly Reasoning[] = ["disabled", "adaptive", "enabled"];

export function isReasoning(v: unknown): v is Reasoning {
   return typeof v === "string" && (REASONING_MODES as readonly string[]).includes(v);
}

/* Map a server thinking_mode to a Reasoning. Legacy "auto" (older servers) means on. */
export function toReasoning(v: unknown): Reasoning | null {
   if (v === "auto") return "enabled";
   return isReasoning(v) ? v : null;
}

/* Validate a wire `reasoning_capabilities` object. null = absent/malformed (an older server:
   the caller falls back to the name heuristic). Unknown modes are skipped, never guessed. */
export function parseReasoningCaps(raw: unknown): ReasoningCaps | null {
   if (!raw || typeof raw !== "object") return null;
   const r = raw as { modes?: unknown; default?: unknown };
   if (!Array.isArray(r.modes)) return null;
   const modes: ReasoningMode[] = [];
   for (const m of r.modes) {
      if (!m || typeof m !== "object") continue;
      const e = m as { mode?: unknown; efforts?: unknown; budget?: unknown; budget_tokens?: unknown };
      if (!isReasoning(e.mode) || modes.some((x) => x.mode === e.mode)) continue;
      const efforts = Array.isArray(e.efforts)
         ? e.efforts.filter((x): x is string => typeof x === "string" && x !== "" && x !== "none")
         : [];
      const budgetTokens: Record<string, number> = {};
      if (e.budget_tokens && typeof e.budget_tokens === "object") {
         for (const [k, v] of Object.entries(e.budget_tokens as Record<string, unknown>)) {
            if (typeof v === "number" && Number.isFinite(v) && v > 0) budgetTokens[k] = v;
         }
      }
      modes.push({ mode: e.mode, efforts, budget: e.budget === true, budgetTokens });
   }
   const d = (r.default && typeof r.default === "object" ? r.default : {}) as { mode?: unknown; effort?: unknown };
   return {
      modes,
      default: {
         mode: isReasoning(d.mode) ? d.mode : "",
         effort: typeof d.effort === "string" ? d.effort : ""
      }
   };
}

/* Display labels (parity with DAWN's WebUI). An enabled mode that picks a budget is "Budget". */
export function reasoningModeLabel(m: Reasoning, budget = false): string {
   if (m === "disabled") return "Off";
   if (m === "adaptive") return "Adaptive";
   return budget ? "Budget" : "On";
}

const EFFORT_LABELS: Record<string, string> = {
   none: "None",
   minimal: "Minimal",
   low: "Low",
   medium: "Medium",
   high: "High",
   xhigh: "Extra high",
   max: "Max"
};
export function effortLabel(e: string): string {
   return EFFORT_LABELS[e] ?? e.charAt(0).toUpperCase() + e.slice(1);
}

/* Why the running reasoning differs from the stored pick ("" when they match or no pick is
   known): e.g. Off on a model that can't turn reasoning off, or an effort it doesn't offer. */
export function reasoningNote(
   pick: { mode: Reasoning | null; effort: string },
   effective: { mode: Reasoning; effort: string },
   caps: ReasoningCaps | null
): string {
   const budgetOf = (mode: Reasoning): boolean => caps?.modes.find((m) => m.mode === mode)?.budget === true;
   /* A stored "enabled" (or legacy "auto") on a model without an enabled mode just means
      "reasoning on" to DAWN (no clamp), so it's no mismatch unless reasoning actually runs off. */
   const legacyOn = pick.mode === "enabled" && effective.mode !== "disabled";
   if (pick.mode && pick.mode !== effective.mode && !legacyOn) {
      return `${reasoningModeLabel(pick.mode, budgetOf(pick.mode))} isn't available on this model; running ${reasoningModeLabel(effective.mode, budgetOf(effective.mode))}.`;
   }
   if (effective.mode !== "disabled" && pick.effort && pick.effort !== "none" && pick.effort !== effective.effort) {
      return `${effortLabel(pick.effort)} isn't available on this model; running ${effortLabel(effective.effort)}.`;
   }
   return "";
}

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/* The offered effort closest to `want` (ties go lower), as DAWN resolves it. `want` itself
   when offered; the first offered when `want` is unknown. "" for an empty list. */
export function nearestEffort(efforts: string[], want: string): string {
   if (!efforts.length) return "";
   if (efforts.includes(want)) return want;
   const w = EFFORT_ORDER.indexOf(want);
   if (w < 0) return efforts[0];
   let best = efforts[0];
   let bestDist = Infinity;
   for (const e of efforts) {
      const i = EFFORT_ORDER.indexOf(e);
      if (i < 0) continue;
      const d = Math.abs(i - w);
      if (d < bestDist || (d === bestDist && i < EFFORT_ORDER.indexOf(best))) {
         best = e;
         bestDist = d;
      }
   }
   return best;
}

/* "8K" / "1K" / "1.5K" / "512" for a budget-size hint. */
export function formatBudgetTokens(n: number): string {
   if (n < 1000) return String(n);
   return `${Math.round(n / 102.4) / 10}K`; // 1024 -> 1K, 1536 -> 1.5K, 8192 -> 8K
}

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
   /* Reasoning-effort values the current model accepts (the heuristic, for an older server
      that sends no capabilities; with capabilities the panel renders from `reasoningCaps`). */
   effortOptions: string[];
   /* The current model's capabilities from DAWN, or null when the server sent none. */
   reasoningCaps: ReasoningCaps | null;
   /* When the stored pick differs from what runs (e.g. Off on a model that can't turn
      reasoning off), a one-line explanation; "" when they match. */
   reasoningNote: string;
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
   /* Re-fetch the LLM config (the cloud model lists come from get_config and are read
      only on connect). Called when the MODEL panel opens so a backend config edit shows
      up without a page reload; the response updates the lists and fires onChange. */
   refreshModels?(): void;
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
