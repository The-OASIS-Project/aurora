/*
 * "Has the user left this tab?" with a grace period. A hidden tab counts as away only after
 * TAB_AWAY_GRACE_MS, so a quick hop to another tab and back doesn't make a panel unsubscribe and
 * refetch; coming back counts at once. A tab that loads hidden is away from the start (there is
 * nothing on screen to keep warm). Panels that pause while nobody is looking gate on this instead
 * of document.hidden.
 */

export const TAB_AWAY_GRACE_MS = 3 * 60_000;

export interface TabAway {
   away(): boolean;
   dispose(): void;
}

export function watchTabAway(
   onChange: (away: boolean) => void,
   graceMs = TAB_AWAY_GRACE_MS
): TabAway {
   let away = document.hidden;
   let timer = 0;
   const set = (next: boolean): void => {
      if (next === away) return;
      away = next;
      onChange(away);
   };
   const onVisibility = (): void => {
      window.clearTimeout(timer);
      timer = 0;
      /* Re-checked when it fires: a frozen tab can run an overdue timer just before it's shown. */
      if (document.hidden) timer = window.setTimeout(() => document.hidden && set(true), graceMs);
      else set(false);
   };
   document.addEventListener("visibilitychange", onVisibility);
   return {
      away: () => away,
      dispose: () => {
         window.clearTimeout(timer);
         document.removeEventListener("visibilitychange", onVisibility);
      }
   };
}
