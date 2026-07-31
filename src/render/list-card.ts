/*
 * The list body shared by the movable ambient cards (the calendar and Home
 * Assistant boards today, any future capped/growable list card tomorrow). The panel
 * owns its rows and their styling; this owns how the list SIZES, spills, and reveals:
 *
 * - Resting height: content up to a default cap (40vh), or a user-set height dragged
 *   from the bottom grip and persisted under `storageKey`. Stored as CSS custom
 *   properties (--list-h / --list-cap) the stylesheet reads, NOT an inline height, so
 *   the :hover rule can still override it (an inline height would win and freeze it).
 * - Overflow: the scrollbar is hidden; a bottom mask-fade cue (.overflowing) stands
 *   in for it.
 * - Hover-expand: hovering grows the list to reveal more, CLAMPED so the card can
 *   never spill past the bottom of the viewport - if it did, the resize grip would go
 *   off-screen and strand the user (that was the "bad UI" you hit). Suppressed while
 *   the card is being moved or resized.
 *
 * The host element also gets `lcard-host`; the list gets `lcard`; the grip is created
 * here as `lcard-grip`. Panels that reveal extra content when resized (e.g. the
 * calendar's wrapped location text) can key off the `lcard-resized` class this toggles
 * on the host. Exclude the grip from a card's move-drag via the `.lcard-grip` selector.
 */

const GRIP_RESERVE = 22; // px kept clear below the list (grip + a little breathing room)
const DEFAULT_CAP_VH = 40; // resting cap when not resized; MUST match the CSS --list-cap fallback
const MAX_VH = 80; // hover / resize ceiling
const MIN_PX = 72; // resize floor

export interface ListCard {
   /* Recompute the overflow cue after the list's content changes. */
   refresh(): void;
   destroy(): void;
}

export interface ListCardOpts {
   /* localStorage key for the grip-set resting height. */
   storageKey: string;
}

export function makeListCard(host: HTMLElement, list: HTMLElement, opts: ListCardOpts): ListCard {
   host.classList.add("lcard-host");
   list.classList.add("lcard");

   const grip = document.createElement("div");
   grip.className = "lcard-grip";
   grip.setAttribute("aria-hidden", "true");
   host.appendChild(grip);

   /* User-set resting height (grip), or null for default content sizing. */
   let restingH: number | null = null;

   /* The ceiling in px: how tall the list may get before its bottom would pass the
      viewport bottom. Measured from the list's own top (the header sits above it), so it
      tracks wherever the card has been dragged. This is the INVARIANT that keeps the
      card's top fixed: the body caps to fit rather than the card moving up. Also bounded
      by MAX_VH so a card near the top doesn't balloon to the whole screen on hover. */
   const ceilingPx = (): number => {
      const top = list.getBoundingClientRect().top;
      const toViewportBottom = window.innerHeight - top - GRIP_RESERVE;
      return Math.max(MIN_PX, Math.min(window.innerHeight * (MAX_VH / 100), toViewportBottom));
   };
   /* The height the user configured at rest: the grip height, else the default cap. */
   const configuredCapPx = (): number => restingH ?? window.innerHeight * (DEFAULT_CAP_VH / 100);

   const updateOverflow = (): void => {
      const cap = Math.min(configuredCapPx(), ceilingPx());
      list.classList.toggle("overflowing", list.scrollHeight > cap + 1);
   };

   /* Apply resting height + hover ceiling, both clamped to `ceilingPx` so the card can
      never grow past the viewport bottom (which would either strand the grip or make
      makeMovable pull the card's top up). Recomputed whenever the card may have moved. */
   const applySizing = (): void => {
      const ceil = ceilingPx();
      list.style.setProperty("--lcard-hover-cap", `${Math.round(ceil)}px`);
      if (restingH != null) {
         const eff = Math.round(Math.min(restingH, ceil)); // visible resting height, capped
         list.style.setProperty("--list-h", `${eff}px`);
         list.style.setProperty("--list-cap", `${eff}px`);
         host.classList.add("lcard-resized");
      } else {
         list.style.removeProperty("--list-h");
         const def = window.innerHeight * (DEFAULT_CAP_VH / 100);
         list.style.setProperty("--list-cap", `${Math.round(Math.min(def, ceil))}px`);
         host.classList.remove("lcard-resized");
      }
      updateOverflow();
   };

   /* Recompute the ceiling for the card's current position right before a hover-expand. */
   const onEnter = (): void => applySizing();
   host.addEventListener("pointerenter", onEnter);

   /* The card's top can change without a resize event (a makeMovable drag), which moves
      the list's top and so its ceiling. Recompute after any pointer release. Cheap: a
      couple of measurements + style writes. */
   const onWindowPointerUp = (): void => applySizing();
   window.addEventListener("pointerup", onWindowPointerUp);

   /* Grip resize: set the resting height between the floor and the on-screen ceiling,
      persisted. Suppress hover expansion for the duration (lcard-resizing) so the drag
      adjusts a stable height instead of fighting the hover rule. */
   let rStartY = 0;
   let rStartH = 0;
   let resizing = false;
   const onGripMove = (e: PointerEvent): void => {
      if (!resizing) return;
      restingH = Math.max(MIN_PX, Math.min(ceilingPx(), rStartH + (e.clientY - rStartY)));
      applySizing();
   };
   const onGripUp = (): void => {
      resizing = false;
      host.classList.remove("lcard-resizing");
      window.removeEventListener("pointermove", onGripMove);
      window.removeEventListener("pointerup", onGripUp);
      if (restingH != null) localStorage.setItem(opts.storageKey, String(Math.round(restingH)));
   };
   const onGripDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      e.preventDefault();
      rStartY = e.clientY;
      rStartH = list.getBoundingClientRect().height;
      restingH = rStartH;
      host.classList.add("lcard-resizing");
      applySizing();
      resizing = true;
      window.addEventListener("pointermove", onGripMove);
      window.addEventListener("pointerup", onGripUp);
   };
   grip.addEventListener("pointerdown", onGripDown);

   const onResize = (): void => applySizing();
   window.addEventListener("resize", onResize);

   const saved = Number(localStorage.getItem(opts.storageKey));
   if (Number.isFinite(saved) && saved > 0) restingH = saved;
   applySizing();

   return {
      /* Full re-size, not just the overflow cue: the panel calls this from render(),
         which runs AFTER makeMovable has positioned the card, so this is where the
         ceiling first sees the card's real on-screen top. */
      refresh: applySizing,
      destroy: (): void => {
         grip.removeEventListener("pointerdown", onGripDown);
         host.removeEventListener("pointerenter", onEnter);
         window.removeEventListener("pointermove", onGripMove);
         window.removeEventListener("pointerup", onGripUp);
         window.removeEventListener("pointerup", onWindowPointerUp);
         window.removeEventListener("resize", onResize);
         grip.remove();
      }
   };
}
