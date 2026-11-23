/* Formatting for the HUD's telemetry readout: uptime, model name, token counts, context and cache
   rows. */

export function fmtUptime(seconds: number): string {
   const s = Math.max(0, Math.floor(seconds));
   const hh = String(Math.floor(s / 3600)).padStart(2, "0");
   const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
   const ss = String(s % 60).padStart(2, "0");
   return `${hh}:${mm}:${ss}`;
}

/* Model name for the HUD readout. A local model is often a filesystem PATH (e.g.
   /home/user/models/Qwen3-30B-A3B-Q4_K_M.gguf or C:\models\...\model.gguf) whose directory
   prefix stretches the box; keep just the filename (the meaningful part). Guard the path strip on
   real path signals - an absolute/drive/~ prefix or a model file extension - so a provider slug
   like "openai/gpt-5.5" keeps its vendor. Then cap the length, cutting the FRONT (leading
   ellipsis) so the distinctive tail (a quant suffix / version) survives. Display-only; the raw
   model string is still what we send to DAWN. */
export function displayModelName(model: string, max = 26): string {
   let name = model.trim();
   const looksLikePath =
      /[\\/]/.test(name) &&
      (/^([a-zA-Z]:[\\/]|[\\/~])/.test(name) || /\.(gguf|bin|safetensors|pt|onnx)$/i.test(name));
   if (looksLikePath) name = name.split(/[\\/]/).pop() || name;
   if (name.length > max) name = `…${name.slice(name.length - (max - 1))}`;
   return name;
}

/* Compact a token count for the HUD: 12345 -> "12.3k", 200000 -> "200k", 640 -> "640". */
function abbrevTokens(n: number): string {
   if (n >= 1000) {
      const k = n / 1000;
      // >= 99.95 rounds to a 3-digit k, so drop the decimal (avoids "100.0k").
      return k >= 99.95 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
   }
   return String(Math.round(n));
}

/* The CONTEXT USAGE readout: token counts first, percent last ("12.3k/200k · 45%"). `usagePct`
   comes from the live `context` frame; on a conversation load we only have current/max (stored),
   so it is derived. Falls back to just the percent, then a placeholder, when counts are absent. */
export function formatCtx(current: number, max: number, usagePct?: number): string {
   if (!(max > 0)) return usagePct !== undefined ? `${Math.round(usagePct)}%` : "--";
   const pct = usagePct !== undefined ? Math.round(usagePct) : Math.round((current / max) * 100);
   return `${abbrevTokens(current)}/${abbrevTokens(max)} · ${pct}%`;
}

/* Round n/d as a percent; "--" when the denominator is missing. */
function cachePct(n: number, d: number): string {
   return d > 0 ? `${Math.round((n / d) * 100)}%` : "--";
}

/* This turn's CACHE row: hit rate (cached / input prompt tokens) and estimated billing
   savings (saved / input). Savings is a server-side ESTIMATE from provider list prices, so
   it is marked "~"; a local model has no billing, so it reads "n/a". It can be negative on a
   cold cache-WRITE turn (the write is an up-front cost that pays back on later reads) - shown
   honestly. */
export function formatCacheTurn(
   cached: number,
   input: number,
   saved: number,
   local: boolean
): string {
   if (input <= 0) return "--";
   const hit = `${cachePct(cached, input)} hit`;
   return local ? `${hit} · n/a` : `${hit} · ~${cachePct(saved, input)} saved`;
}

/* The CACHE AVG row: cumulative session hit rate + estimated savings across turns. Savings is
   always shown (local turns just fold 0 into the sums), so a mixed cloud/local session stays
   honest. */
export function formatCacheAvg(s: { cached: number; input: number; saved: number }): string {
   if (s.input <= 0) return "--";
   return `${cachePct(s.cached, s.input)} hit · ~${cachePct(s.saved, s.input)} saved`;
}
