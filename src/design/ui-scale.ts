/*
 * UI scale: a single user-set multiplier on the root font-size, layered on top of the
 * responsive clamp() in main.css (html { font-size: calc(clamp(...) * var(--ui-scale)) }).
 * Because the whole UI is rem-based - type AND spacing - one factor scales it as a
 * coherent zoom while px borders and the viewport-relative reactor stay put. Persisted
 * so it survives reloads; applied to --ui-scale on documentElement before first paint.
 *
 * Stepped, not continuous: discrete factors keep text off fractional sub-pixel sizes.
 */

const KEY = "aurora.uiScale";

/* 80% .. 130% in 5% steps. 1.0 (index 4) is the neutral default and a real step, so a
   reset lands exactly on it. */
export const UI_SCALE_STEPS: readonly number[] = [
   0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3
];
export const UI_SCALE_DEFAULT = 1.0;

/* Snap an arbitrary value to the nearest allowed step (guards against a stale/hand-edited
   localStorage value drifting off the ladder). */
export function snapUiScale(v: number): number {
   let best = UI_SCALE_STEPS[0];
   let bestD = Math.abs(v - best);
   for (const s of UI_SCALE_STEPS) {
      const d = Math.abs(v - s);
      if (d < bestD) {
         best = s;
         bestD = d;
      }
   }
   return best;
}

export function getUiScale(): number {
   const raw = Number(localStorage.getItem(KEY));
   return Number.isFinite(raw) && raw > 0 ? snapUiScale(raw) : UI_SCALE_DEFAULT;
}

/* Mirror the current factor to the CSS var. Only writes the property when off the
   default so a neutral 1.0 leaves the stylesheet's own `var(--ui-scale, 1)` fallback. */
export function applyUiScale(v: number = getUiScale()): void {
   document.documentElement.style.setProperty("--ui-scale", String(snapUiScale(v)));
}

export function setUiScale(v: number): void {
   const snapped = snapUiScale(v);
   localStorage.setItem(KEY, String(snapped));
   applyUiScale(snapped);
}

/* "100%" for the readout. */
export function formatUiScale(v: number): string {
   return `${Math.round(v * 100)}%`;
}
