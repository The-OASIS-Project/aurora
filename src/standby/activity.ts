/*
 * Global activity monitor for ambient standby. Window-level, capture-phase so no view can
 * swallow a wake gesture first. It reports genuine USER gestures (mouse / key / wheel /
 * tab-visible) to the standby controller, and while asleep it SWALLOWS the waking gesture so
 * the keystroke that wakes the display does not type into the composer and the tap that wakes
 * it does not actuate a control underneath.
 *
 * Two deliberate policies:
 *  - a pointermove counts only after the pointer travels >= THRESHOLD from the last counted
 *    position (wireless-dongle / IR-receiver jitter is sub-pixel). This gates BOTH waking a
 *    sleeping TV AND keeping an awake one awake - jitter while you are away must neither wake
 *    the display nor hold off the inactivity timeout.
 *  - a pointerdown INSIDE a notice card (Snooze/Dismiss on a ringing alarm) does NOT count as
 *    a user gesture: it acknowledges the alarm but must not promote a peek to a full session
 *    (the "acknowledge only" decision). Moving a mouse to reach the card is itself presence,
 *    so only the direct press on the card is exempt.
 */

export interface ActivityMonitor {
   destroy(): void;
}

const THRESHOLD = 10; // px of pointer travel from the sleep reference before a move wakes

export function mountActivity(opts: {
   onUserGesture: () => void; // a genuine user gesture: wake + reset the inactivity window
   isAsleep: () => boolean; // to swallow the waking gesture and gate the move threshold
}): ActivityMonitor {
   /* The last pointer position that counted as a real move; jitter within THRESHOLD of it is
      ignored (awake or asleep). */
   let refX = 0;
   let refY = 0;

   /* The one-shot capture-phase click suppressor after a waking tap (tracked so destroy() can
      drop a pending one deterministically; only ever one at a time). */
   let suppressClick: ((e: Event) => void) | null = null;
   let suppressTimer = 0;
   const clearSuppress = (): void => {
      if (suppressClick) window.removeEventListener("click", suppressClick, true);
      window.clearTimeout(suppressTimer);
      suppressClick = null;
   };

   /* Wake, and (for a pointer/tap) eat the immediate follow-up click so the wake tap does not
      actuate whatever control it landed over as the chrome blooms back in. */
   const wake = (swallowClick: boolean): void => {
      const wasAsleep = opts.isAsleep();
      opts.onUserGesture();
      if (wasAsleep && swallowClick) {
         clearSuppress();
         suppressClick = (e: Event): void => {
            e.preventDefault();
            e.stopPropagation();
            clearSuppress();
         };
         window.addEventListener("click", suppressClick, true);
         suppressTimer = window.setTimeout(clearSuppress, 700); // drop it if no click follows
      }
   };

   const onPointerDown = (e: PointerEvent): void => {
      /* Re-anchor the move threshold to this press, so the tap's own co-incident pointermove
         (measured from here, not a stale reference) stays sub-threshold - otherwise a touch tap
         on a notice card would promote the peek via that move, defeating the exemption below. */
      refX = e.clientX;
      refY = e.clientY;
      if ((e.target as Element)?.closest?.(".notice-card")) return; // acknowledge, don't promote
      wake(true);
   };

   const onPointerMove = (e: PointerEvent): void => {
      if (Math.hypot(e.clientX - refX, e.clientY - refY) < THRESHOLD) return; // jitter: ignore
      refX = e.clientX;
      refY = e.clientY;
      wake(false); // a real move: reset the inactivity window, and wake if asleep
   };

   const onKeyDown = (e: KeyboardEvent): void => {
      if (opts.isAsleep()) {
         /* Swallow input-producing keys so the wake keystroke does not reach the composer.
            Leave bare modifiers, function keys, and modifier-combo shortcuts (Ctrl+F, Cmd+V)
            alone so a shortcut used to wake still fires - but still wake in all cases. */
         const bare = e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta";
         const fkey = /^F\d{1,2}$/.test(e.key);
         const combo = e.ctrlKey || e.metaKey || e.altKey;
         if (!bare && !fkey && !combo) {
            e.preventDefault();
            e.stopPropagation();
         }
      }
      wake(false);
   };

   const onWheel = (): void => wake(false);
   const onVisibility = (): void => {
      if (!document.hidden) wake(false); // a tab hidden for hours must not snap to black on return
   };

   window.addEventListener("pointerdown", onPointerDown, true);
   window.addEventListener("pointermove", onPointerMove, true);
   window.addEventListener("keydown", onKeyDown, true);
   window.addEventListener("wheel", onWheel, true);
   document.addEventListener("visibilitychange", onVisibility);

   return {
      destroy(): void {
         clearSuppress();
         window.removeEventListener("pointerdown", onPointerDown, true);
         window.removeEventListener("pointermove", onPointerMove, true);
         window.removeEventListener("keydown", onKeyDown, true);
         window.removeEventListener("wheel", onWheel, true);
         document.removeEventListener("visibilitychange", onVisibility);
      }
   };
}
