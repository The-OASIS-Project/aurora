/*
 * makeResizable: let a movable view be resized from any edge or corner, with its size
 * persisted. A sibling of makeMovable and built to cooperate with it: the size lives here, the
 * placement (dock anchors) stays in movable.ts, and on release this reports which edges moved
 * (onCommit -> MovableHandle.commitResize) so a docked view stays docked.
 *
 * During a drag it sets the size (and left/top for a left/top-edge grip) directly; movable's
 * ResizeObserver re-dock is gated off while the element is :active, so the two never fight.
 * Size is per-machine layout (like every view's position), clamped to the viewport on restore
 * and on window resize. Pure DOM geometry: nothing above the render layer is involved.
 */

import type { ResizeEdges } from "./movable.ts";
import { beginResizeSnap, cssMovableEdge, type ResizeSnap } from "./movable.ts";

export interface ResizableOptions {
   storageKey: string;
   minWidth: number;
   minHeight: number;
   defaultWidth: number;
   defaultHeight: number;
   /* The widest the view may grow right now (from MovableHandle.maxWidth). */
   maxWidth?: () => number;
   /* True while the view is locked in place (no resizing then). */
   isLocked?: () => boolean;
   /* Released after a resize: which edges moved. */
   onCommit?: (edges: ResizeEdges) => void;
   /* The size changed (live, during a drag too). */
   onResize?: (width: number, height: number) => void;
}

export interface Resizable {
   /* Off = the view sizes itself (e.g. collapsed to a bar): no inline size, no grips. */
   setEnabled(on: boolean): void;
   size(): { width: number; height: number };
   dispose(): void;
}

const GRIPS: Array<{ cls: string; edges: ResizeEdges; cursor: string }> = [
   { cls: "n", edges: { top: true }, cursor: "ns-resize" },
   { cls: "s", edges: { bottom: true }, cursor: "ns-resize" },
   { cls: "e", edges: { right: true }, cursor: "ew-resize" },
   { cls: "w", edges: { left: true }, cursor: "ew-resize" },
   { cls: "ne", edges: { top: true, right: true }, cursor: "nesw-resize" },
   { cls: "sw", edges: { bottom: true, left: true }, cursor: "nesw-resize" },
   { cls: "nw", edges: { top: true, left: true }, cursor: "nwse-resize" },
   { cls: "se", edges: { bottom: true, right: true }, cursor: "nwse-resize" }
];

export function makeResizable(el: HTMLElement, opts: ResizableOptions): Resizable {
   let width = opts.defaultWidth;
   let height = opts.defaultHeight;
   let enabled = false;
   try {
      const raw = localStorage.getItem(opts.storageKey);
      if (raw) {
         const p = JSON.parse(raw) as { w?: unknown; h?: unknown };
         if (typeof p.w === "number" && Number.isFinite(p.w)) width = p.w;
         if (typeof p.h === "number" && Number.isFinite(p.h)) height = p.h;
      }
   } catch {
      /* corrupt or blocked: defaults stand */
   }

   const edge = (): number => cssMovableEdge();
   const maxW = (): number => Math.max(opts.minWidth, Math.min(window.innerWidth - 2 * edge(), opts.maxWidth?.() ?? Infinity));
   const maxH = (): number => Math.max(opts.minHeight, window.innerHeight - 2 * edge());
   const clampW = (w: number): number => Math.round(Math.min(maxW(), Math.max(opts.minWidth, w)));
   const clampH = (h: number): number => Math.round(Math.min(maxH(), Math.max(opts.minHeight, h)));

   const apply = (): void => {
      if (!enabled) return;
      width = clampW(width);
      height = clampH(height);
      el.style.width = `${width}px`;
      el.style.height = `${height}px`;
      opts.onResize?.(width, height);
   };

   const save = (): void => {
      try {
         localStorage.setItem(opts.storageKey, JSON.stringify({ w: width, h: height }));
      } catch {
         /* blocked: the size still applies this session */
      }
   };

   /* --- grips -------------------------------------------------------------- */
   const grips: HTMLElement[] = GRIPS.map((g) => {
      const d = document.createElement("div");
      d.className = `rs-grip rs-${g.cls}`;
      d.style.cursor = g.cursor;
      d.setAttribute("aria-hidden", "true");
      d.dataset.grip = g.cls;
      return d;
   });

   /* One resize in progress. Its limits and snap targets are measured once at the press: re-reading
      layout on every pointermove, right after the last move wrote a size, forced a reflow each time. */
   let active: {
      edges: ResizeEdges;
      x: number;
      y: number;
      left: number;
      top: number;
      w: number;
      h: number;
      edge: number;
      maxW: number;
      maxH: number;
      snap: ResizeSnap;
   } | null = null;
   let moveFrame = 0;
   let lastMove: PointerEvent | null = null;

   const onDown = (e: PointerEvent): void => {
      if (e.button !== 0 || !enabled || opts.isLocked?.()) return;
      const g = GRIPS.find((x) => x.cls === (e.currentTarget as HTMLElement).dataset.grip);
      if (!g) return;
      e.preventDefault();
      e.stopPropagation(); // never also start a makeMovable drag
      const r = el.getBoundingClientRect();
      active = {
         edges: g.edges,
         x: e.clientX,
         y: e.clientY,
         left: r.left,
         top: r.top,
         w: r.width,
         h: r.height,
         edge: edge(),
         maxW: maxW(),
         maxH: maxH(),
         snap: beginResizeSnap(el)
      };
      el.style.transition = "";
      el.classList.add("resizing");
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
   };

   /* Pointer moves are coalesced to one resize step per frame (a fast mouse fires several). */
   const onMove = (e: PointerEvent): void => {
      if (!active) return;
      lastMove = e;
      if (!moveFrame) moveFrame = requestAnimationFrame(step);
   };

   const step = (): void => {
      moveFrame = 0;
      const e = lastMove;
      const a = active;
      if (!a || !e) return;
      const dx = e.clientX - a.x;
      const dy = e.clientY - a.y;
      const W = window.innerWidth;
      const H = window.innerHeight;
      const cW = (w: number): number => Math.round(Math.min(a.maxW, Math.max(opts.minWidth, w)));
      const cH = (h: number): number => Math.round(Math.min(a.maxH, Math.max(opts.minHeight, h)));
      /* The moving edge snaps to the screen edges and other views' edges (movable.ts). */
      if (a.edges.right) {
         /* Pin the left edge, so a view placed by CSS `right:` grows toward the pointer. */
         const right = a.snap.snap("right", a.left + a.w + dx, [a.left + opts.minWidth, a.left + a.maxW]);
         width = cW(Math.min(right - a.left, W - a.edge - a.left));
         el.style.left = `${Math.round(a.left)}px`;
         el.style.right = "auto";
      }
      if (a.edges.left) {
         /* Growing left: the right edge stays put; never past the viewport's left gutter. */
         const left = a.snap.snap("left", a.left + dx, [a.left + a.w - a.maxW, a.left + a.w - opts.minWidth]);
         width = cW(Math.min(a.left + a.w - left, a.left + a.w - a.edge));
         el.style.left = `${Math.round(a.left + a.w - width)}px`;
         el.style.right = "auto";
      }
      if (a.edges.bottom) {
         const bottom = a.snap.snap("bottom", a.top + a.h + dy, [a.top + opts.minHeight, a.top + a.maxH]);
         height = cH(Math.min(bottom - a.top, H - a.edge - a.top));
         el.style.top = `${Math.round(a.top)}px`;
         el.style.bottom = "auto";
      }
      if (a.edges.top) {
         const top = a.snap.snap("top", a.top + dy, [a.top + a.h - a.maxH, a.top + a.h - opts.minHeight]);
         height = cH(Math.min(a.top + a.h - top, a.top + a.h - a.edge));
         el.style.top = `${Math.round(a.top + a.h - height)}px`;
         el.style.bottom = "auto";
      }
      el.style.width = `${width}px`;
      el.style.height = `${height}px`;
      opts.onResize?.(width, height);
   };

   /* End a drag without landing or committing it. */
   const abort = (): void => {
      if (!active) return;
      cancelAnimationFrame(moveFrame);
      moveFrame = 0;
      lastMove = null;
      active.snap.end();
      active = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      el.classList.remove("resizing");
      document.body.style.userSelect = "";
   };

   const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!active) return;
      if (moveFrame) {
         cancelAnimationFrame(moveFrame);
         step(); // land the last move before committing
      }
      lastMove = null;
      active.snap.end();
      const edges = active.edges;
      active = null;
      el.classList.remove("resizing");
      document.body.style.userSelect = "";
      save();
      opts.onCommit?.(edges);
   };

   for (const g of grips) {
      g.addEventListener("pointerdown", onDown);
      el.appendChild(g);
   }

   const onWinResize = (): void => apply();
   window.addEventListener("resize", onWinResize);

   return {
      setEnabled: (on: boolean): void => {
         enabled = on;
         el.classList.toggle("rs-enabled", on);
         if (on) {
            apply();
         } else {
            abort(); // collapsed mid-drag: drop the drag, never write a size onto the collapsed view
            el.style.width = "";
            el.style.height = "";
         }
      },
      size: () => ({ width, height }),
      dispose: (): void => {
         onUp();
         window.removeEventListener("resize", onWinResize);
         for (const g of grips) {
            g.removeEventListener("pointerdown", onDown);
            g.remove();
         }
      }
   };
}
