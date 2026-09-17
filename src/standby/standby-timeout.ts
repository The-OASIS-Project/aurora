/*
 * Screen-saver timeout: the persisted inactivity delay (minutes) before the ambient
 * standby / "Deep Idle" mode engages. Stepped, not continuous, so it drives the same
 * on-theme MenuSlider the Display "Text Size" uses. 0 = Off (feature disabled). Purely a
 * client display concern - no DAWN verb. Modeled on design/ui-scale.ts.
 */

const KEY = "aurora.standbyMin";

/* 0 (Off), then 10/15/20/30 minutes - the ladder the System-menu picker snaps across. */
export const STANDBY_STEPS: readonly number[] = [0, 10, 15, 20, 30];
export const STANDBY_DEFAULT = 0; // Off by default: opt-in, no surprise blackout on upgrade

/* Snap an arbitrary (possibly hand-edited) value to the nearest allowed step. */
export function snapStandby(v: number): number {
   let best = STANDBY_STEPS[0];
   let bestD = Math.abs(v - best);
   for (const s of STANDBY_STEPS) {
      const d = Math.abs(v - s);
      if (d < bestD) {
         best = s;
         bestD = d;
      }
   }
   return best;
}

export function getStandbyMin(): number {
   const raw = Number(localStorage.getItem(KEY));
   return Number.isFinite(raw) && raw >= 0 ? snapStandby(raw) : STANDBY_DEFAULT;
}

export function setStandbyMin(v: number): void {
   localStorage.setItem(KEY, String(snapStandby(v)));
}

/* "Off" / "10 min" for the slider readout. */
export function formatStandbyMin(v: number): string {
   return v === 0 ? "Off" : `${v} min`;
}

/* DEV-only fast-timeout override so the mode can be exercised in seconds, not minutes.
   Reads `aurora.standbyDebugSec` (localStorage) - a raw seconds value that bypasses the
   ladder. Returns the timeout in MILLISECONDS for a given minutes setting, honoring the
   override in dev builds only. Never active in a production bundle. */
export function standbyTimeoutMs(minutes: number): number {
   if (minutes === 0) return 0; // Off is off - the dev override never re-enables a disabled saver
   if (import.meta.env.DEV) {
      const dbg = Number(localStorage.getItem("aurora.standbyDebugSec"));
      if (Number.isFinite(dbg) && dbg > 0) return dbg * 1000;
   }
   return minutes * 60_000;
}
