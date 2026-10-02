/*
 * Where a new card (a notification) should appear: the free spot nearest the top center of the
 * display, clear of every visible movable view (instruments, panels, other cards), the menubar,
 * the conversation window, and the reactor. If nothing is free, top center anyway. Pure DOM
 * geometry, so it lives in the render layer; callers pass only the card's size.
 */

import { ANCHOR_SIZE_FRAC } from "../design/tokens.ts";
import { cssMovableEdge, visibleMovableRects } from "./movable.ts";

const STEP = 16; // candidate grid spacing, px
const GAP = 10; // clearance kept around every obstacle, px

interface Box {
   left: number;
   top: number;
   right: number;
   bottom: number;
}

function boxOf(el: Element | null): Box | null {
   if (!el || !(el instanceof HTMLElement) || el.offsetParent === null) return null;
   const r = el.getBoundingClientRect();
   if (r.width === 0 || r.height === 0) return null;
   return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/* The reactor's footprint (the anchor canvas draws it centered at ANCHOR_SIZE_FRAC of the smaller
   viewport side), as its bounding square. */
function reactorBox(W: number, H: number): Box {
   const r = (ANCHOR_SIZE_FRAC * Math.min(W, H)) / 2;
   return { left: W / 2 - r, top: H / 2 - r, right: W / 2 + r, bottom: H / 2 + r };
}

const hits = (l: number, t: number, w: number, h: number, b: Box): boolean =>
   l < b.right + GAP && l + w > b.left - GAP && t < b.bottom + GAP && t + h > b.top - GAP;

/* Top-left for a w x h card. `exclude` is the card itself (already in the movable set). */
export function findOpenSpot(w: number, h: number, exclude?: HTMLElement): { left: number; top: number } {
   const W = window.innerWidth;
   const H = window.innerHeight;
   const edge = cssMovableEdge();
   const menubar = boxOf(document.getElementById("menubar"));
   const obstacles: Box[] = [
      ...visibleMovableRects(exclude).map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })),
      reactorBox(W, H)
   ];
   if (menubar) obstacles.push(menubar);
   const consoleBox = boxOf(document.getElementById("console"));
   if (consoleBox) obstacles.push(consoleBox);

   /* The preferred spot: centered, just under the menubar. */
   const prefLeft = Math.round((W - w) / 2);
   const prefTop = Math.round(Math.max(edge, (menubar?.bottom ?? 0) + GAP));
   const maxLeft = Math.max(edge, W - w - edge);
   const maxTop = Math.max(edge, H - h - edge);

   /* The common case first: top center is free. */
   if (!obstacles.some((b) => hits(prefLeft, prefTop, w, h, b))) return { left: prefLeft, top: prefTop };

   let best: { left: number; top: number; d: number } | null = null;
   for (let top = edge; top <= maxTop; top += STEP) {
      for (let left = edge; left <= maxLeft; left += STEP) {
         if (obstacles.some((b) => hits(left, top, w, h, b))) continue;
         const d = Math.hypot(left - prefLeft, top - prefTop);
         if (!best || d < best.d) best = { left, top, d };
      }
   }
   return best ? { left: best.left, top: best.top } : { left: Math.min(prefLeft, maxLeft), top: Math.min(prefTop, maxTop) };
}
