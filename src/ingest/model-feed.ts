/* The model selection: what the session runs (mode, provider, model, reasoning and effort), the
   lists and capabilities it picks from, the MODEL panel's controls, and the HUD's model rows; kept
   from DAWN's config, model-list and set_session_llm replies, a loaded conversation's settings
   and the model tool's switches. Matching those replies to their requests (the owed queues and the
   revision they are stamped with) stays in the core, which conversation loading shares; this
   reads and bumps the revision through it. */

import type { IngestSinks, SpikeNotice } from "./ingest.ts";
import {
   effortOptionsForModel,
   nearestEffort,
   parseReasoningCaps,
   reasoningNote,
   toReasoning,
   type LlmMode,
   type LlmProvider,
   type ModelControl,
   type LlmState,
   type Reasoning,
   type ReasoningCaps
} from "../model/model.ts";
import { displayModelName } from "./telemetry-format.ts";

/* Narrow a server-provided provider string to the panel's LlmProvider set. DAWN
   sends it capitalized in llm_runtime ("OpenRouter") and lowercase in a
   conversation's llm_settings ("openrouter"), so callers lower-case first. An
   unknown value is rejected rather than coerced, so the panel never mislabels
   one provider as another. */
/* A provider name as DAWN may write it ("Claude", dawn.toml's "anthropic"), lowercased. */
function providerKey(name: string): string {
   const key = name.toLowerCase();
   return key === "anthropic" ? "claude" : key;
}

function isLlmProvider(v: string): v is LlmProvider {
   return v === "openai" || v === "claude" || v === "gemini" || v === "openrouter";
}

/* Display label for the HUD provider readout (the panel's own labels). */
function providerLabel(p: LlmProvider): string {
   switch (p) {
      case "openai":
         return "OpenAI";
      case "claude":
         return "Claude";
      case "gemini":
         return "Gemini";
      case "openrouter":
         return "OpenRouter";
   }
}

/* The views it drives. */
type Sinks = Pick<IngestSinks, "telemetry">;

/* What it reads and writes in the core. */
export interface ModelCore {
   send: (msg: object) => boolean;
   sinks: () => Sinks;
   spikeNotice: SpikeNotice;
   /* The selection's revision (stamped on the owed requests in the core's send). */
   getRev: () => number;
   setRev: (v: number) => void;
   /* A refused change left the selection to be read again (the core's recovery sends it). */
   getNeedsRead: () => boolean;
   setNeedsRead: (v: boolean) => void;
   /* The open conversation's privacy (the MODEL panel's Private switch). */
   getPrivate: () => boolean;
   setPrivate: (v: boolean) => void;
   convId: () => number;
   askConfig: (listsOnly?: boolean) => void;
   requestConfigRefresh: () => void;
   selectionSettled: () => boolean;
}

/* The owed request a reply settled (the core matched it). */
type ConfigAsk = { rev: number; listsOnly: boolean; req?: string };
type OwedWrite = { rev: number; req?: string; chosen?: boolean };

export class ModelFeed {
   /* Vision capability, per provider-type, from get_config (llm.cloud/local.vision_enabled).
      isVisionCapable() picks by the active mode, so it tracks a cloud<->local switch. Gates
      the composer's image attach - images only go to a model that can see them. */
   private cloudVision = false;
   private localVision = false;
   /* LLM selection state (MODEL panel). All of it is server-authoritative: mode /
      provider / model / availability and now reasoning / effort come from
      get_config's llm_runtime on connect (DAWN reports the session's resolved
      thinking_mode + reasoning_effort as of signal-map §9.1a), and every change is
      echoed back by set_session_llm_response. The defaults below are placeholders
      until that first frame lands. */
   readonly llm = {
      mode: "cloud" as LlmMode,
      provider: "claude" as LlmProvider,
      model: "",
      reasoning: "enabled" as Reasoning,
      effort: "medium",
      providers: { openai: false, claude: false, gemini: false, openrouter: false } as Record<
         LlmProvider,
         boolean
      >,
      /* No cloud provider selected (DAWN's "none" for a cloud session): the panel asks for one,
         and nothing is sent until the user picks it. */
      noProvider: false,
      /* The conversation has no model of its own and follows the dawn.toml default (DAWN #137);
         null: an older DAWN that doesn't say. */
      followsDefault: null as boolean | null
   };
   /* The cloud provider dawn.toml names: what choosing Cloud means, never one guessed from which
      keys exist ("" when it names none). */
   private defaultCloudProvider: LlmProvider | "" | null = null; // null: not known (keep the last)
   /* The user chose Cloud and the panel asks for a provider (nothing sent yet): a refresh of
      DAWN's still-unchanged selection mustn't take that prompt away. */
   private pickingProvider = false;
   /* DAWN's per-model reasoning capabilities (P1.1b). cloudCaps is null until a server sends
      them (an older server never does: the panel then falls back to the name heuristic).
      frameCaps is the caps a per-conversation frame carried for ITS model, which covers a
      loaded conversation's model that isn't in the active list. */
   private cloudCaps: Record<LlmProvider, Record<string, ReasoningCaps>> | null = null;
   private localCaps: Record<string, ReasoningCaps> = {};
   private frameCaps: {
      mode: LlmMode;
      provider: LlmProvider;
      model: string;
      caps: ReasoningCaps;
   } | null = null;
   /* The stored reasoning pick (thinking_mode_pick / reasoning_effort_pick): what the user chose,
      which can differ from what runs. Display only - the panel shows the EFFECTIVE value and
      explains the difference; DAWN keeps and re-resolves the pick itself. */
   private reasoningPick: { mode: Reasoning | null; effort: string } = { mode: null, effort: "" };
   private readonly cloudModels: Record<LlmProvider, string[]> = {
      openai: [],
      claude: [],
      gemini: [],
      openrouter: []
   };
   /* Which openrouter_models entry to default to when switching onto OpenRouter
      (DAWN's curated default; parity with the old WebUI which snaps to it). */
   /* Each cloud provider's default model, as an index into its list (dawn.toml
      <provider>_default_model_idx): what a switch to that provider picks. */
   private defaultModelIdx: Record<LlmProvider, number> = {
      openai: 0,
      claude: 0,
      gemini: 0,
      openrouter: 0
   };
   /* A llama.cpp sync that waited for the session's selection to be known (selectionSettled). */
   private loadedSyncDeferred = false;
   private localModels: string[] = [];
   /* The model a llama.cpp local provider has loaded (it can't switch models). Only llama.cpp's
      current_model means that: other providers echo the session's own model there (even a cloud
      one), so for them this stays empty. Only a model in the list counts, never "(unknown)". */
   private localLoadedModel = "";
   /* The user switched to local mode before the local model list arrived: the list completes it. */
   private localPickPending = false;
   private readonly llmListeners: Array<() => void> = [];

   constructor(private readonly core: ModelCore) {}

   private get sinks(): Sinks {
      return this.core.sinks();
   }
   private send(msg: object): boolean {
      return this.core.send(msg);
   }
   private spikeNotice(...args: Parameters<SpikeNotice>): void {
      this.core.spikeNotice(...args);
   }
   private get llmRev(): number {
      return this.core.getRev();
   }
   private set llmRev(v: number) {
      this.core.setRev(v);
   }
   private get llmNeedsRead(): boolean {
      return this.core.getNeedsRead();
   }
   private set llmNeedsRead(v: boolean) {
      this.core.setNeedsRead(v);
   }
   private get isPrivate(): boolean {
      return this.core.getPrivate();
   }
   private set isPrivate(v: boolean) {
      this.core.setPrivate(v);
   }
   private get convId(): number {
      return this.core.convId();
   }
   private askConfig(listsOnly = false): void {
      this.core.askConfig(listsOnly);
   }
   private requestConfigRefresh(): void {
      this.core.requestConfigRefresh();
   }
   private selectionSettled(): boolean {
      return this.core.selectionSettled();
   }

   /* As the socket opens: the local model list is learned again from this connection. */
   linkUp(): void {
      /* Learned again from this connection's list (the local provider's models may have
         changed meanwhile): until it comes, a switch to local waits for it. */
      this.localModels = [];
      this.localLoadedModel = "";
      this.loadedSyncDeferred = false;
   }

   /* New Chat: it starts from DAWN's defaults, not a switch or a provider prompt left over. */
   newChat(): void {
      this.localPickPending = false;
      this.pickingProvider = false;
   }

   /* A switch to local still waiting for the model list no longer applies (another conversation
      opened, or DAWN refused the change). */
   cancelLocalPick(): void {
      this.localPickPending = false;
   }

   /* get_config_response's model part, with the ask it settled. */
   onConfig(p: Record<string, unknown>, ask: ConfigAsk): void {
      const cfg = (p.config ?? p) as {
         general?: { ai_name?: string };
         llm?: {
            cloud?: {
               openai_models?: string[];
               claude_models?: string[];
               gemini_models?: string[];
               openrouter_models?: string[];
               openrouter_default_model_idx?: number;
               vision_enabled?: boolean;
            };
            local?: { vision_enabled?: boolean };
            thinking?: { mode?: string; reasoning_effort?: string };
         };
      };
      const c = cfg.llm?.cloud;
      if (c) {
         const raw = (c as { provider?: unknown }).provider;
         const dp = typeof raw === "string" ? providerKey(raw) : null;
         this.defaultCloudProvider = dp === null ? null : isLlmProvider(dp) ? dp : "";
         this.cloudModels.openai = c.openai_models ?? [];
         this.cloudModels.claude = c.claude_models ?? [];
         this.cloudModels.gemini = c.gemini_models ?? [];
         /* OpenRouter's curated model list (operator-managed in dawn.toml).
            Absent -> [], and modelSelect still shows the live model string. */
         this.cloudModels.openrouter = c.openrouter_models ?? [];
         const idx = (v: unknown): number => (typeof v === "number" ? v : 0);
         const ci = c as Record<string, unknown>;
         this.defaultModelIdx = {
            openai: idx(ci.openai_default_model_idx),
            claude: idx(ci.claude_default_model_idx),
            gemini: idx(ci.gemini_default_model_idx),
            openrouter: idx(ci.openrouter_default_model_idx)
         };
      }
      /* Per-model reasoning capabilities, keyed exactly like the model lists above. */
      const rc = p.reasoning_capabilities;
      if (rc && typeof rc === "object") {
         const caps: Record<LlmProvider, Record<string, ReasoningCaps>> = {
            openai: {},
            claude: {},
            gemini: {},
            openrouter: {}
         };
         for (const [prov, models] of Object.entries(rc as Record<string, unknown>)) {
            if (!isLlmProvider(prov) || !models || typeof models !== "object") continue;
            for (const [model, raw] of Object.entries(models as Record<string, unknown>)) {
               const parsed = parseReasoningCaps(raw);
               if (parsed) caps[prov][model] = parsed;
            }
         }
         this.cloudCaps = caps;
      }
      /* Vision capability per provider-type (config flags). isVisionCapable() resolves
         these against the active mode, so it follows a later cloud<->local switch. */
      this.cloudVision = cfg.llm?.cloud?.vision_enabled === true;
      this.localVision = cfg.llm?.local?.vision_enabled === true;
      /* CURRENT session state: llm_runtime (payload level, resolved for this
         session) - the reliable source, since llm_state_update only fires on a
         switch_llm tool call, never on connect. Provider is capitalized here.
         As of signal-map §9.1a it also carries the session's resolved
         thinking_mode + reasoning_effort, so a fresh connection shows the real
         Reasoning/Effort with no client-side persistence. */
      const rt = (p.llm_runtime ?? {}) as {
         type?: string;
         provider?: string;
         model?: string;
         thinking_mode?: string;
         reasoning_effort?: string;
         openai_available?: boolean;
         claude_available?: boolean;
         gemini_available?: boolean;
         openrouter_available?: boolean;
      };
      /* A models-only refresh (MODEL panel open) must not touch the current
         selection - that could revert a loaded conversation's provider/model back to
         the session default. Update only the lists (above) + availability (below). */
      /* A lists-only refresh (config_changed, the panel opening) still updates a session
         that follows the default when DAWN says it still does: the default it shows may
         have changed in dawn.toml. An explicit pick, or an older DAWN, keeps it out. */
      const followsNow =
         !this.pickingProvider &&
         this.llm.followsDefault === true &&
         (rt as { follows_default?: unknown }).follows_default === true;
      const appliesSelection = ask.rev === this.llmRev && (!ask.listsOnly || followsNow);
      if (appliesSelection) this.llmNeedsRead = false; // the session's selection, as it is
      if (appliesSelection) {
         if (rt.type) this.llm.mode = rt.type === "local" ? "local" : "cloud";
         this.localPickPending = false; // DAWN's own state now stands
         this.applyProvider(rt.provider);
         if (rt.model) this.llm.model = rt.model;
         this.applyFollows((rt as { follows_default?: unknown }).follows_default);
         /* Reasoning/effort: the session's EFFECTIVE runtime values (+ the stored pick and
            this model's caps); fall back to the global config default only for older
            servers that omit them from llm_runtime. */
         this.applyReasoningFields(p.llm_runtime, {
            mode: rt.thinking_mode ?? cfg.llm?.thinking?.mode,
            effort: rt.reasoning_effort ?? cfg.llm?.thinking?.reasoning_effort
         });
      }
      this.applyAvailability(rt);
      /* The local model list may have come first on this connection: now that the mode is
         known, follow llama.cpp's loaded model (a no-op otherwise). */
      if (appliesSelection) this.syncLoadedLocalModel();
      else {
         this.notifyLlm();
         this.runDeferredLoadedSync(); // this read may have been the last owed
      }
   }

   /* set_session_llm_response, with the write it settled (undefined: none owed). */
   onSessionLlm(p: Record<string, unknown>, owedWrite: OwedWrite | undefined): void {
      /* One naming a request this connection doesn't owe is never the latest. */
      const writeRev = owedWrite ? owedWrite.rev : typeof p.req === "string" ? -1 : undefined;
      /* A reply to a write whose revision has passed is older than newer state: it can't
         undo it. One with no write of ours recorded (none owed) can't be older than ours. */
      const latestReply = writeRev === undefined || writeRev === this.llmRev;
      if (p.success !== false) {
         if (latestReply) {
            /* type (local|cloud): a "reset" from New can move the session across it. */
            if (p.type === "local" || p.type === "cloud") this.llm.mode = p.type;
            /* Moved off local meanwhile (a "reset" from New): no local pick left to complete. */
            if (this.llm.mode !== "local") this.localPickPending = false;
            this.applyProvider(p.provider);
            this.applyFollows(p.follows_default);
            this.pickingProvider = false; // a selection DAWN confirmed ends any prompt
            /* A local session with no named model ("server decides", e.g. after New's reset
               to a local default) echoes model "". Show "local", as get_config's llm_runtime
               names it, rather than keeping the previous (cloud) model's name. */
            if (typeof p.model === "string" && p.model) this.llm.model = p.model;
            else if (this.llm.mode === "local" && p.model === "") this.llm.model = "local";
         }
         /* Availability only when the echo actually carries it (both builders
            do as of Phase 1); absent -> leave the current record untouched. */
         this.applyAvailability(p);
         /* An older reply's reasoning belongs to the model it was for, not the newer one. */
         if (latestReply) {
            this.applyReasoningFields(p);
            if (p.reasoning_adjusted === true) {
               this.spikeNotice("llm-adjusted", "notice", this.reasoningAdjustedText(), {
                  hold: 6
               });
            }
            /* Following the default on llama.cpp, DAWN's reply names the local LLM by its
               placeholder: show the model it has loaded (display only, nothing sent). */
            if (this.llm.followsDefault === true && this.llm.mode === "local")
               this.syncLoadedLocalModel();
         }
         this.notifyLlm();
      } else {
         /* The session LLM change was rejected (e.g. a provider/model DAWN could not
            select). Surface it instead of failing silently - a control-feedback notice,
            not a chat line. The session kept its previous LLM. */
         const err = (p as { error?: string }).error;
         console.warn("[dawn] set_session_llm rejected:", err);
         /* Nothing of a refused switch is left to complete, and the panel shows what the
            session still runs: DAWN's refusal echoes its config (unless a newer write is
            still owed a reply, which this refusal doesn't speak for). */
         if (latestReply) {
            this.localPickPending = false;
            if (p.type === "local" || p.type === "cloud") this.llm.mode = p.type;
            this.applyProvider(p.provider);
            if (typeof p.model === "string" && p.model) this.llm.model = p.model;
            this.applyFollows(p.follows_default);
            this.applyReasoningFields(p); // its reasoning too, as DAWN resolved it
         }
         this.applyAvailability(p); // which providers have a key, as DAWN says now
         this.notifyLlm();
         this.spikeNotice("llm-switch-error", "attention", err || "Could not switch model", {
            tone: "attention",
            hold: 9
         });
      }
      this.runDeferredLoadedSync(); // this reply may have been the last owed
   }

   /* list_llm_models_response (the core lists it in its switch). */
   onFrame(type: string, p: Record<string, unknown>): void {
      switch (type) {
         case "list_llm_models_response": {
            const models = (p.models ?? []) as Array<{
               name?: string;
               reasoning_capabilities?: unknown;
            }>;
            this.localModels = models.map((m) => m.name ?? "").filter(Boolean);
            const loaded = typeof p.current_model === "string" ? p.current_model : "";
            this.localLoadedModel =
               typeof p.provider === "string" &&
               p.provider.toLowerCase() === "llama.cpp" &&
               this.localModels.includes(loaded)
                  ? loaded
                  : "";
            this.localCaps = {};
            for (const m of models) {
               const parsed = m.name ? parseReasoningCaps(m.reasoning_capabilities) : null;
               if (m.name && parsed) this.localCaps[m.name] = parsed;
            }
            if (this.localPickPending && this.llm.mode === "local") {
               /* The user switched to local mode before this list arrived: complete their switch. */
               this.localPickPending = false;
               this.reconcileModel({ type: "local" }, true);
            } else {
               this.localPickPending = false;
               this.syncLoadedLocalModel();
            }
            break;
         }
      }
   }

   /* --- MODEL panel -------------------------------------------------------- */

   notifyLlm(): void {
      /* Persistent HUD readout of the current brain: model + effort (OFF when
         reasoning is disabled, else LOW/MEDIUM/HIGH/…). Do NOT push an empty model
         - llm_state_update can arrive after get_config, and an empty value would
         clobber the cached (persistent) reading. */
      const caps = this.currentCaps();
      const entry = caps?.modes.find((m) => m.mode === this.llm.reasoning);
      const effort =
         caps && !caps.modes.length
            ? "N/A" // the model has no reasoning control
            : this.llm.reasoning === "disabled"
              ? "OFF"
              : entry && !entry.efforts.length
                ? "ON" // a mode with no effort choice (e.g. Ollama think on)
                : this.llm.effort.toUpperCase();
      const update: Record<string, string> = {
         effort,
         provider: this.llm.mode === "local" ? "Local" : providerLabel(this.llm.provider)
      };
      if (this.llm.model) update.model = displayModelName(this.llm.model);
      this.sinks.telemetry.update(update);
      for (const cb of this.llmListeners) cb();
   }

   /* A frame's provider, after its type: a known one is selected; DAWN's "none" (or "") on a
      cloud session means none is. An unknown name changes nothing. */
   private applyProvider(raw: unknown): void {
      if (typeof raw !== "string") return;
      const prov = providerKey(raw);
      if (isLlmProvider(prov)) {
         this.llm.provider = prov;
         this.llm.noProvider = false;
      } else if (prov === "none" || prov === "") {
         this.llm.noProvider = this.llm.mode === "cloud";
      }
   }

   /* A frame's follows_default (DAWN #137), when it carries one. */
   private applyFollows(raw: unknown): void {
      if (typeof raw === "boolean") this.llm.followsDefault = raw;
   }

   /* Which providers have a key: for showing which can be picked, never for choosing one. An
      older DAWN without openrouter_available counts OpenRouter as keyed when it runs. */
   private applyAvailability(p: Record<string, unknown>): void {
      if (p.openai_available === undefined) return;
      this.llm.providers = {
         openai: p.openai_available === true,
         claude: p.claude_available === true,
         gemini: p.gemini_available === true,
         openrouter:
            p.openrouter_available === undefined
               ? this.llm.provider === "openrouter"
               : p.openrouter_available === true
      };
   }

   /* Apply an llm_state_update (mode/provider/model + provider availability). */
   applyLlmState(json: string): void {
      let msg: { payload?: Record<string, unknown> };
      try {
         msg = JSON.parse(json) as { payload?: Record<string, unknown> };
      } catch {
         return;
      }
      const pl = msg && typeof msg === "object" ? msg.payload : undefined;
      if (!pl || typeof pl !== "object") return;
      this.llm.mode = pl.type === "local" ? "local" : "cloud";
      this.localPickPending = false; // a tool switched the model: nothing of the user's to complete
      this.llmRev++; // older config snapshots no longer describe the selection
      this.applyProvider(pl.provider);
      if (typeof pl.model === "string" && pl.model) this.llm.model = pl.model;
      this.applyFollows(pl.follows_default);
      this.applyAvailability(pl);
      /* A switch_llm tool call changed the session model, and reasoning now depends on the model
         (P1.1b), but this frame carries no reasoning fields or caps. Re-read the session's
         runtime (a full get_config, not a lists-only refresh) for the effective values. */
      this.askConfig();
      this.notifyLlm();
   }

   /* Send a session-only LLM change, then reflect it optimistically. A pick of a type, provider
      or model gives the conversation a selection of its own (the echo confirms it). */
   private applyLlm(fields: Record<string, string>): void {
      /* Only once DAWN has said (an older one never does). */
      if ((fields.type === "local" || fields.type === "cloud") && this.llm.followsDefault !== null)
         this.llm.followsDefault = false;
      this.send({ type: "set_session_llm", payload: fields });
      this.notifyLlm();
   }

   /* Reflect a loaded conversation's stamped LLM settings on the MODEL panel.
      load_conversation_response carries an llm_settings object (DAWN's
      build_conv_llm_settings_json) with the mode/provider/model/reasoning the
      daemon actually runs THAT conversation with. Without applying it the panel
      keeps the connect-time llm_runtime snapshot and lies once a conversation with
      different settings is opened (e.g. shows native Claude / haiku / Off while the
      conversation runs on OpenRouter / sonnet-5 / thinking-low). Display only: it
      issues no set_session_llm (the daemon already resolved these server-side), and
      reconcileModel is deliberately NOT called - the stamped model is the truth even
      when it is absent from the active provider's list (as an OpenRouter model is). */
   applyConvLlmSettings(settings: unknown): void {
      this.pickingProvider = false; // another conversation's selection: no prompt carries over
      this.localPickPending = false; // a loaded conversation ends any earlier switch's wait
      this.llmRev++; // its settings are newer than any config snapshot in flight
      if (!settings || typeof settings !== "object") return;
      const s = settings as {
         llm_type?: string;
         cloud_provider?: string;
         model?: string;
         thinking_mode?: string;
         reasoning_effort?: string;
      };
      if (s.llm_type) this.llm.mode = s.llm_type === "local" ? "local" : "cloud";
      /* Its provider as DAWN reports it; one without a key shows as that (the panel says so),
         never lit as if it had one. */
      this.applyProvider(s.cloud_provider);
      this.applyFollows((settings as { follows_default?: unknown }).follows_default);
      /* An empty model (DAWN PR #113) means that type's or provider's own default, which DAWN
         restored the session to: read the model that actually runs (a read, not a write). */
      if (s.model) this.llm.model = s.model;
      else if (s.model === "") this.askConfig();
      this.applyReasoningFields(settings);
   }

   /* Read a frame's reasoning fields (llm_runtime / set_session_llm_response /
      load_conversation llm_settings): the EFFECTIVE thinking_mode + reasoning_effort shown on the
      panel, the stored pick (for the "not available here" note), and the caps for the frame's
      model. Call AFTER this.llm.model is updated from the same frame. `fallback` covers an older
      server whose frame omits the fields. A missing field leaves the current value untouched. */
   private applyReasoningFields(
      raw: unknown,
      fallback: { mode?: string; effort?: string } = {}
   ): void {
      const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const mode = toReasoning(f.thinking_mode ?? fallback.mode);
      if (mode) this.llm.reasoning = mode;
      const effort =
         typeof f.reasoning_effort === "string" && f.reasoning_effort
            ? f.reasoning_effort
            : fallback.effort;
      if (effort) this.llm.effort = effort;
      if ("thinking_mode_pick" in f || "reasoning_effort_pick" in f) {
         this.reasoningPick = {
            mode: toReasoning(f.thinking_mode_pick),
            effort: typeof f.reasoning_effort_pick === "string" ? f.reasoning_effort_pick : ""
         };
      }
      /* Bind the caps only to the model this frame itself names (a frame with no/empty model
         says nothing about which model they describe). */
      const caps = parseReasoningCaps(f.reasoning_capabilities);
      if (caps && typeof f.model === "string" && f.model && f.model === this.llm.model) {
         this.frameCaps = {
            mode: this.llm.mode,
            provider: this.llm.provider,
            model: f.model,
            caps
         };
      }
   }

   /* The current model's caps: the list tables first, then what a frame carried for this
      model. null = unknown (an older server): the panel uses the name heuristic. */
   private currentCaps(): ReasoningCaps | null {
      const m = this.llm.model;
      const listed =
         this.llm.mode === "local" ? this.localCaps[m] : this.cloudCaps?.[this.llm.provider]?.[m];
      if (listed) return listed;
      const fc = this.frameCaps;
      return fc &&
         fc.model === m &&
         fc.mode === this.llm.mode &&
         (fc.mode === "local" || fc.provider === this.llm.provider)
         ? fc.caps
         : null;
   }

   /* After an optimistic model/provider/mode change: keep the shown mode + effort inside what
      the new model offers until the server's echo (the authority) lands, so the panel never
      shows a mode the model lacks. Falls back to the effort heuristic without caps. */
   private fitReasoningToModel(): void {
      const caps = this.currentCaps();
      if (!caps) {
         const opts = effortOptionsForModel(this.llm.model);
         if (!opts.includes(this.llm.effort))
            this.llm.effort = opts.includes("medium") ? "medium" : opts[0];
         return;
      }
      if (!caps.modes.length) return;
      if (!caps.modes.some((m) => m.mode === this.llm.reasoning)) {
         this.llm.reasoning =
            caps.default.mode && caps.modes.some((m) => m.mode === caps.default.mode)
               ? caps.default.mode
               : caps.modes[0].mode;
      }
      this.fitEffortToMode(caps);
   }

   /* Keep the effort inside the current mode's list (a disabled mode keeps its kept pick). */
   private fitEffortToMode(caps: ReasoningCaps): void {
      const entry = caps.modes.find((m) => m.mode === this.llm.reasoning);
      if (!entry || !entry.efforts.length || entry.efforts.includes(this.llm.effort)) return;
      /* Same rule DAWN resolves with: the nearest offered effort to the pick, ties lower. */
      this.llm.effort = nearestEffort(entry.efforts, this.reasoningPick.effort || this.llm.effort);
   }

   /* The pick-vs-effective explanation, "" when they match (or no pick is known). */
   private reasoningNoteText(): string {
      return reasoningNote(
         this.reasoningPick,
         { mode: this.llm.reasoning, effort: this.llm.effort },
         this.currentCaps()
      );
   }

   /* The clamp notice for a reasoning_adjusted set_session_llm_response. */
   private reasoningAdjustedText(): string {
      return this.reasoningNoteText() || "Reasoning adjusted to what this model supports.";
   }

   private modelsFor(mode: LlmMode, provider: LlmProvider): string[] {
      return mode === "local" ? this.localModels : this.cloudModels[provider];
   }

   /* After the user picks a mode or provider: if the current model isn't in that list, switch to
      its default, as the user's own choice. Local mode prefers the model llama.cpp has loaded
      (localLoadedModel), else the first; a cloud provider uses its dawn.toml default index
      (<provider>_default_model_idx, parity with DAWN's WebUI), else the first. Local mode with no list yet waits for it
      (localPickPending), and the list's arrival completes the switch. */
   /* `pick`: the pick's type (and provider), sent with the model in ONE message (DAWN #137: a
      provider change clears the model, and the server checks the whole pick). */
   /* `fromList`: completing a switch to local as its model list arrives (the pick itself was
      already sent). */
   private reconcileModel(pick: Record<string, string>, fromList = false): void {
      if (this.llm.mode !== "local") this.localPickPending = false; // switched away meanwhile
      const models = this.modelsFor(this.llm.mode, this.llm.provider);
      if (this.llm.mode === "local" && models.length === 0 && !this.localLoadedModel) {
         /* Local with no list yet: the server's local LLM now; its model when a list comes. */
         this.localPickPending = true;
         if (fromList) this.notifyLlm();
         else this.applyLlm(pick);
         return;
      }
      const preferred =
         this.llm.mode === "local" && this.localLoadedModel ? this.localLoadedModel : "";
      if (!models.includes(this.llm.model) && (models.length > 0 || preferred)) {
         /* The provider's configured default (each indexes only its own list), else the first. */
         const want = this.llm.mode === "cloud" ? this.defaultModelIdx[this.llm.provider] : 0;
         const idx = want >= 0 && want < models.length ? want : 0;
         this.llm.model = preferred || models[idx];
         /* Keep reasoning valid for the new model so the panel's segmented controls always have
            an active value (the server resolves + echoes too, but this avoids a transient
            no-selection state until the echo lands). */
         this.fitReasoningToModel();
      }
      /* A model goes with the pick only when it belongs to the picked list (or is what llama.cpp
         has loaded): with no list, the pick goes alone and DAWN names the model, so one vendor's
         model never goes to another. */
      if (this.llm.model && (models.includes(this.llm.model) || this.llm.model === preferred)) {
         this.applyLlm({ ...pick, model: this.llm.model });
      } else {
         this.llm.model = ""; // DAWN's reply names it
         this.applyLlm(pick);
      }
   }

   /* The local model list arrived with no switch of the user's waiting on it: in local mode with
      llama.cpp, which can't switch models, the session follows the one it has loaded, as DAWN's
      WebUI does. That is DAWN reporting its own state, not a choice, so it goes with from_restore
      (DAWN applies it to the session without saving it on the conversation). For other providers
      current_model is only the session's own model echoed back, so there is nothing to follow.
      Nothing else is changed on the user's behalf. */
   syncLoadedLocalModel(): void {
      /* Until the session's selection is known, the mode here may be stale: sync once the last
         reply that could change it has come (runDeferredLoadedSync). */
      if (!this.selectionSettled()) {
         this.loadedSyncDeferred = true;
         this.notifyLlm();
         return;
      }
      this.loadedSyncDeferred = false;
      const loaded = this.localLoadedModel;
      /* A conversation following the default isn't pinned to what's loaded (DAWN #137): sending
         the model would give the session a selection of its own. */
      if (this.llm.mode === "local" && loaded && this.llm.followsDefault === true) {
         this.llm.model = loaded; // shown, not sent: it's what the default runs here
         this.fitReasoningToModel();
      } else if (this.llm.mode === "local" && loaded && loaded !== this.llm.model) {
         this.llm.model = loaded;
         this.fitReasoningToModel();
         /* type with the model: without it, a local name that starts like a cloud one (Ollama's
            gpt-oss:20b) is taken for a cloud model, and DAWN moves the session to cloud. */
         this.send({
            type: "set_session_llm",
            payload: { type: "local", model: loaded, from_restore: true }
         });
      }
      this.notifyLlm();
   }

   /* A sync that waited (syncLoadedLocalModel) runs once the selection is known. */
   runDeferredLoadedSync(): void {
      if (this.loadedSyncDeferred && this.selectionSettled()) this.syncLoadedLocalModel();
   }

   getModelControl(): ModelControl {
      return {
         getState: (): LlmState => ({
            mode: this.llm.mode,
            provider: this.llm.provider,
            model: this.llm.model,
            reasoning: this.llm.reasoning,
            effort: this.llm.effort,
            providers: this.llm.providers,
            noProvider: this.llm.mode === "cloud" && this.llm.noProvider,
            followsDefault: this.llm.followsDefault,
            models:
               this.llm.mode === "cloud" && this.llm.noProvider
                  ? []
                  : this.modelsFor(this.llm.mode, this.llm.provider),
            effortOptions: effortOptionsForModel(this.llm.model),
            reasoningCaps: this.currentCaps(),
            reasoningNote: this.reasoningNoteText(),
            isPrivate: this.isPrivate
         }),
         onChange: (cb) => this.llmListeners.push(cb),
         setMode: (mode) => {
            /* The active one clicked again picks nothing (it would pin the conversation). */
            if (mode === this.llm.mode) return;
            this.pickingProvider = false; // a new choice of mode ends an earlier prompt
            this.llm.mode = mode;
            if (mode === "local") {
               this.llm.noProvider = false;
               this.reconcileModel({ type: "local" });
               return;
            }
            /* Cloud means the provider dawn.toml names, never one guessed from which keys exist;
               with none named, the panel asks for one and nothing is sent until it's picked. */
            /* Nothing of the previous mode carries over: an older reply or a pending local
               switch isn't the selection now, and the model is the new provider's default. */
            this.localPickPending = false;
            this.llm.model = "";
            if (this.defaultCloudProvider === "") {
               this.llm.noProvider = true;
               this.pickingProvider = true;
               this.llmRev++; // replies to the earlier pick no longer describe what's shown
               this.notifyLlm();
               return;
            }
            if (this.defaultCloudProvider) this.llm.provider = this.defaultCloudProvider;
            this.llm.noProvider = false;
            this.reconcileModel({ type: "cloud", provider: this.llm.provider });
         },
         setProvider: (provider) => {
            if (provider === this.llm.provider && !this.llm.noProvider) return; // already picked
            this.pickingProvider = false;
            this.llm.provider = provider;
            this.llm.noProvider = false;
            /* The whole pick in one message: type (it wins at dispatch), the provider, and that
               provider's model (a provider change clears the model). */
            this.reconcileModel({ type: "cloud", provider });
         },
         setModel: (model) => {
            if (this.llm.mode === "cloud" && this.llm.noProvider) return; // pick a provider first
            this.llm.model = model;
            this.fitReasoningToModel();
            /* type with the model always: a model alone can move the session (DAWN #137). */
            this.applyLlm(
               this.llm.mode === "cloud"
                  ? { type: "cloud", provider: this.llm.provider, model }
                  : { type: "local", model }
            );
         },
         useDefaultModel: () => {
            /* Save the conversation as following the dawn.toml default again, keeping its
               reasoning (DAWN #137: a reset with the reasoning fields, never from_restore). The
               echo carries the model it now runs. */
            if (this.llm.followsDefault !== null) this.llm.followsDefault = true;
            this.pickingProvider = false; // the default replaces the provider prompt
            /* It replaces a switch to local still waiting for the model list: the list mustn't
               complete that one now. */
            this.localPickPending = false;
            this.send({
               type: "set_session_llm",
               payload: {
                  type: "reset",
                  thinking_mode: this.reasoningPick.mode || this.llm.reasoning,
                  reasoning_effort: this.reasoningPick.effort || this.llm.effort
               }
            });
            this.notifyLlm();
         },
         setReasoning: (reasoning) => {
            /* Optimistic; the set_session_llm_response echo confirms or adjusts it. */
            this.llm.reasoning = reasoning;
            this.reasoningPick = { ...this.reasoningPick, mode: reasoning }; // the new pick (no stale-pick note flash)
            const caps = this.currentCaps();
            if (caps) this.fitEffortToMode(caps);
            this.applyLlm({ thinking_mode: reasoning });
         },
         setEffort: (effort) => {
            this.llm.effort = effort;
            this.reasoningPick = {
               mode: this.currentCaps() ? this.llm.reasoning : this.reasoningPick.mode,
               effort
            };
            /* With caps, send the mode the panel shows alongside: on a model that can't turn
               reasoning off, a stale stored "disabled" pick must be replaced by what's shown
               (DAWN's P1.1b contract). */
            this.applyLlm(
               this.currentCaps()
                  ? { thinking_mode: this.llm.reasoning, reasoning_effort: effort }
                  : { reasoning_effort: effort }
            );
         },
         setPrivate: (on) => {
            this.isPrivate = on;
            if (this.convId > 0) {
               this.send({
                  type: "set_private",
                  payload: { conversation_id: this.convId, is_private: on }
               });
            }
            this.notifyLlm();
         },
         refreshModels: () => {
            /* Re-request get_config so a backend model-list edit is picked up live when the
               MODEL panel opens. The get_config_response handler refreshes this.cloudModels
               + availability and rebuilds the open panel, skipping the session selection (see
               a lists-only ask). Complements the config_changed push (which also fires this
               when the panel is closed); keeping both is belt-and-suspenders. */
            this.requestConfigRefresh();
         }
      };
   }

   /* Whether the active model can see images (resolved from get_config's cloud/local
      vision_enabled against the current mode, so it follows a cloud<->local switch). */
   isVisionCapable(): boolean {
      return this.llm.mode === "local" ? this.localVision : this.cloudVision;
   }
}
