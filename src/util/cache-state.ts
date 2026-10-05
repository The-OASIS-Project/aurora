/*
 * The HUD's CACHE STATE row: DAWN's per-turn cache_state, as a short label.
 */

/* DAWN's cache_state (the idle metrics_update): why this turn's last call did or didn't read the
   cache. Only "warm_miss" is a problem; every cold state is an explained miss. An unknown or
   untracked state shows nothing to judge. */
const CACHE_STATE_LABELS: Record<string, string> = {
   warm: "Warm",
   warm_miss: "Missed",
   first: "First call",
   ttl: "Expired",
   model: "Model changed",
   tools: "Tools changed",
   system: "Prompt changed",
   thinking: "Reasoning changed",
   images: "Image added",
   rewritten: "History changed",
   shared: "Shared server"
};
export function formatCacheState(state: unknown): { text: string; flag: boolean } {
   const label = typeof state === "string" ? CACHE_STATE_LABELS[state] : undefined;
   return { text: label ?? "--", flag: state === "warm_miss" };
}
