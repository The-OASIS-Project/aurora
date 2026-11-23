/* The HUD's telemetry readout, fed from DAWN: the token rate (a smoothed average), the prompt-cache
   rows, the context fill, TTFT and latency, and the uptime counted between polls; and the reactor's
   strain and hesitation gauges, from the same metrics frames. */

import type { IngestSinks } from "./ingest.ts";
import type { LlmMode } from "../model/model.ts";
import { formatCacheState } from "../util/cache-state.ts";
import { fmtUptime, formatCacheAvg, formatCacheTurn, formatCtx } from "./telemetry-format.ts";

/* Exponential moving average of the live token rate: a smooth figure that leans
   toward recent generations. Persisted so it survives a refresh. */
const RATE_EMA_KEY = "dawn.hero.rateEma";
const RATE_EMA_ALPHA = 0.15; // higher = more responsive to the latest samples

/* Cumulative cache accounting for the CACHE / CACHE AVG HUD rows: cached / input / saved token
   sums folded from each idle metrics_update frame, so the average is a token-weighted session
   hit/savings rate. Persisted so it survives a refresh (like the token-rate EMA). */
const CACHE_SUM_KEY = "dawn.hero.cacheSums";

/* The two views it drives. */
type Sinks = Pick<IngestSinks, "reactor" | "telemetry">;

export class TelemetryFeed {
   private metricsTimer = 0; // polls get_metrics to keep the HUD readout live
   private uptimeTimer = 0; // ticks the uptime display every second between polls
   private uptimeBaseSec = 0; // last authoritative uptime from get_metrics
   private uptimeBaseAt = 0; // performance.now() when that uptime was received
   private rateEma = Number(localStorage.getItem(RATE_EMA_KEY) ?? 0); // 0 = no samples yet
   /* Cumulative cache token sums for the CACHE AVG row, restored across a refresh. Corrupt or
      absent storage starts fresh at zero. */
   /* A turn's stream ended and its cache figures haven't been added to the session sums yet: DAWN
      repeats the last call's figures on every metrics_update (several idle frames can carry the
      same call), so CACHE AVG adds each turn ONCE, on the first idle frame after its stream_end. */
   private cacheTurnPending = false;
   private cacheSum = ((): { cached: number; input: number; saved: number } => {
      try {
         const v = localStorage.getItem(CACHE_SUM_KEY);
         if (v) {
            const o = JSON.parse(v) as Record<string, unknown>;
            return {
               cached: Number(o.cached) || 0,
               input: Number(o.input) || 0,
               saved: Number(o.saved) || 0
            };
         }
      } catch {
         /* ignore corrupt persisted sums */
      }
      return { cached: 0, input: 0, saved: 0 };
   })();

   constructor(
      private readonly send: (msg: object) => boolean,
      private readonly getSinks: () => Sinks,
      private readonly getLlm: () => { mode: LlmMode }
   ) {}

   private get sinks(): Sinks {
      return this.getSinks();
   }

   private get llm(): { mode: LlmMode } {
      return this.getLlm();
   }

   /* At start, before any socket. */
   showRate(): void {
      /* Surface the persisted token-rate EMA immediately (survives refresh). */
      if (this.rateEma > 0) {
         this.sinks.telemetry.update({ rate: `${Math.round(this.rateEma)}/s` });
      }
   }

   /* As the socket opens, after its first get_metrics. */
   startPolling(): void {
      window.clearInterval(this.metricsTimer);
      window.clearInterval(this.uptimeTimer);
      this.metricsTimer = window.setInterval(() => this.send({ type: "get_metrics" }), 8000);
      /* Count uptime locally every second; each poll re-syncs the base so it
         never drifts from DAWN. */
      this.uptimeTimer = window.setInterval(() => this.tickUptime(), 1000);
   }

   /* metrics_update, context and get_metrics_response. */
   onFrame(type: string, p: Record<string, unknown>): void {
      switch (type) {
         case "metrics_update": {
            /* token_rate -> throughput strain (gauge, live) AND an EMA for the HUD (a
               smooth figure that tracks recent generations, not the fluctuating
               instantaneous rate). Strain normalized against a brisk ~50 tok/s. */
            const rate = Number(p.token_rate ?? 0);
            this.sinks.reactor.setStrain(Math.min(rate / 50, 1));
            /* ttft_ms -> hesitation (the pause before the first token), full at ~2s. Only
               when reported (>0); metrics_update sometimes omits it mid-generation. */
            const ttft = Number(p.ttft_ms ?? 0);
            if (ttft > 0) this.sinks.reactor.setHesitation(Math.min(ttft / 2000, 1));
            if (rate > 0) {
               this.rateEma =
                  this.rateEma > 0 ? this.rateEma + RATE_EMA_ALPHA * (rate - this.rateEma) : rate;
               localStorage.setItem(RATE_EMA_KEY, String(this.rateEma));
               this.sinks.telemetry.update({ rate: `${Math.round(this.rateEma)}/s` });
            }
            /* Cache hit-rate + savings for the CACHE / CACHE AVG rows, sampled off the FINAL/idle
               frame ONLY: the mid-stream "thinking" frames fire before usage is parsed and carry
               the PREVIOUS turn's numbers. On the idle frame input_tokens/cached_tokens are
               always present (a cache-miss turn honestly reports 0); cache_saved_tokens too (may
               be negative on a cold write turn). Gate on a NUMERIC input_tokens (the denominator):
               an older daemon omits it, so the rows stay "--" rather than skewing the session
               sums; the typeof check also rejects a stray null that would fold a 0 denominator. */
            if (p.state === "idle" && typeof p.input_tokens === "number") {
               const cached = Math.max(0, Number(p.cached_tokens ?? 0) || 0);
               const input = Math.max(0, Number(p.input_tokens) || 0);
               const saved = Number(p.cache_saved_tokens ?? 0) || 0; // may be negative
               const local = this.llm.mode === "local"; // local models report no billing savings
               /* Sum each turn once (the first idle after its stream_end); later idle frames repeat
                  the same call's figures, and only refresh the per-turn rows. */
               if (this.cacheTurnPending) {
                  this.cacheTurnPending = false;
                  this.cacheSum = {
                     cached: this.cacheSum.cached + cached,
                     input: this.cacheSum.input + input,
                     saved: this.cacheSum.saved + saved
                  };
                  try {
                     localStorage.setItem(CACHE_SUM_KEY, JSON.stringify(this.cacheSum));
                  } catch {
                     /* storage full/disabled - the rows still update in-memory */
                  }
               }
               /* Why the cache did or didn't hit (DAWN 8ed2552d; absent on an older daemon -> "--"). */
               const cs = formatCacheState((p as { cache_state?: unknown }).cache_state);
               this.sinks.telemetry.update({
                  cache: formatCacheTurn(cached, input, saved, local),
                  cachestate: cs.text,
                  cachestate_flag: cs.flag ? "1" : "",
                  cacheavg: formatCacheAvg(this.cacheSum)
               });
            }
            break;
         }

         case "context": {
            /* Context-window usage, last known (pushed during turns): percent plus the raw
               token counts (current / max) from the same frame. */
            const cp = p as { usage?: number; current?: number; max?: number };
            const usage = cp.usage !== undefined ? Number(cp.usage) : undefined; // let formatCtx derive it if absent
            const cur = Number(cp.current ?? 0);
            const max = Number(cp.max ?? 0);
            this.sinks.telemetry.update({ ctx: formatCtx(cur, max, usage) });
            break;
         }

         case "get_metrics_response": {
            /* HUD: TTFT (time to first token) and LATENCY (full LLM response), both
               averaged for stability; token rate + context usage come from their own
               push frames. */
            const m = p as {
               session?: { uptime_seconds?: number };
               last?: { llm_ttft_ms?: number; llm_total_ms?: number };
               averages?: { llm_ttft_ms?: number; llm_total_ms?: number };
            };
            const ttft = m.averages?.llm_ttft_ms || m.last?.llm_ttft_ms || 0;
            const latency = m.averages?.llm_total_ms || m.last?.llm_total_ms || 0;
            /* Re-sync the uptime base; the 1 Hz ticker carries it between polls. */
            this.uptimeBaseSec = m.session?.uptime_seconds ?? 0;
            this.uptimeBaseAt = performance.now();
            this.sinks.telemetry.update({
               ttft: ttft > 0 ? `${Math.round(ttft)}ms` : "--",
               lat: latency > 0 ? `${Math.round(latency)}ms` : "--"
            });
            this.tickUptime();
            break;
         }
      }
   }

   /* A terminal stream_end. */
   turnEnded(): void {
      this.cacheTurnPending = true;
   }

   /* Advance the displayed uptime from the last synced base, so it counts up every
      second like the clock instead of jumping each 8s poll. */
   private tickUptime(): void {
      if (this.uptimeBaseAt === 0) return;
      const elapsed = (performance.now() - this.uptimeBaseAt) / 1000;
      this.sinks.telemetry.update({ up: fmtUptime(this.uptimeBaseSec + elapsed) });
   }

   stopPolling(): void {
      window.clearInterval(this.metricsTimer);
      window.clearInterval(this.uptimeTimer);
   }
}
