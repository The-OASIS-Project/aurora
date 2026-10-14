/*
 * makeMovable: let a standalone view (the music player, calendar card, and future
 * floating instruments) be grabbed and repositioned, rather than glued to a fixed
 * corner. This is the shared mechanism behind the "views are user-arrangeable"
 * convention.
 *
 * Snapping model, per axis, nearest-in-range wins:
 *   - three VIEWPORT dock stops (near-edge / center / far-edge), and
 *   - for every OTHER movable view: align to its matching edge (left/right or
 *     top/bottom) and sit flush (with a small gap) just outside it.
 * So a box docks to the screen like before AND clicks into a column/row with its
 * siblings. An axis only snaps if dropped within the magnetic distance, leaving free
 * bands between. While dragging, a glowing bar previews the viewport edge OR the
 * shared guide line between the box and the sibling it is aligning to.
 *
 * All movable views register here so each drag can see the others (a module-level
 * set, added on mount, removed on dispose; hidden views are skipped).
 *
 * Distinct from PanelDrag: that one drags a GHOST of a store-backed panel onto the
 * side rails and reports intent to the store; this moves a live self-owned view.
 */

import { mountPanelLock } from "./panel-lock.ts";
import { ANCHOR_SIZE_FRAC } from "../design/tokens.ts";

/* Whether an X snap stop may be used, given the card's width, where it is now, and the dead
   strip [lo, hi]. A stop that keeps the card clear of the strip is always fine. One that would
   leave it overlapping is refused for a card that is clear of the strip now (snapping never
   pulls a card into it), but allowed for a card the user already placed across it (a wide one),
   so it still docks to the screen edges and lines up with other views there: one rule for both,
   whatever the width. The grid stop over the atom (the viewport-center column) is never used
   while overlapping. For a view with the free-drop gesture (`freeOverAtom`, notices), neither is
   any stop that would put its center over the atom. A screen-edge dock made across the strip is
   stored `across` (see maxWidth). */
export function allowXStop(
   stopLeft: number,
   width: number,
   curLeft: number,
   strip: [number, number],
   grid: boolean,
   freeOverAtom = false
): boolean {
   const [lo, hi] = strip;
   const overlaps = (left: number): boolean => left < hi && left + width > lo;
   if (!overlaps(stopLeft)) return true;
   if (grid) return false;
   /* A view with the free-drop gesture (a notice) never snaps with its center over the atom. */
   if (freeOverAtom) {
      const center = stopLeft + width / 2;
      if (center >= lo && center <= hi) return false;
   }
   return overlaps(curLeft);
}

/* Central dead zone: a full-height vertical strip as wide as the reactor, centered on it.
   Reused from ANCHOR_SIZE_FRAC (the atom's real footprint) so it tracks the reactor at
   any resolution. No view snaps INTO this strip - drops resolve to the left/right regions
   flanking it (the two side columns); a card the user already placed across it keeps its
   edge snapping (allowXStop) - and a notice released with its center inside the strip stays
   free (unsnapped): that free drop over the atom is its undock gesture (`freeOverAtom`). */
const DEAD_ZONE_RADIUS_FRAC = ANCHOR_SIZE_FRAC / 2;
function deadZoneX(): [number, number] {
   const r = DEAD_ZONE_RADIUS_FRAC * Math.min(window.innerWidth, window.innerHeight);
   const cx = window.innerWidth / 2;
   return [cx - r, cx + r];
}

export interface MovableOptions {
   /* localStorage key for the persisted top-left position. */
   storageKey: string;
   /* If set, ONLY a pointerdown on a descendant matching this selector starts a drag
      (e.g. a header bar), leaving the rest of the card interactive. Without it the
      whole card is a drag surface. `ignore` still applies within the handle. */
   handle?: string;
   /* Selector for descendants that must NOT initiate a drag (controls). */
   ignore?: string;
   /* Keep this many px clear of the viewport edges when docked. */
   edge?: number;
   /* Magnetic distance around each axis stop, as a fraction of the smaller viewport
      dimension. Larger = stickier stops / narrower free bands. */
   snapZone?: number;
   /* Fired on drop with whether the view landed on a snap stop (a viewport dock OR a
      sibling edge, either axis) vs. a free band. Lets a caller behave differently when
      snapped - e.g. a notification stays persistent when snapped, transient when not. */
   onSnap?: (snapped: boolean) => void;
   /* Join the click-to-front stacking band (default true). Notification cards opt out: they
      sit in their own layer above every panel. */
   raise?: boolean;
   /* Give the view a position padlock (default true; src/render/panel-lock.ts). Notification
      cards opt out: they come and go on their own. */
   lockable?: boolean;
   /* Place the padlock inline (e.g. in a header) instead of the top-left corner. */
   lockSlot?: (btn: HTMLButtonElement) => void;
   /* Released with its center over the reactor, the view floats free (no snapping): the undock
      gesture for notification cards. Panels leave it off and snap wherever they are put. */
   freeOverAtom?: boolean;
}

/* A preview for one snapped axis: a short glowing bar, either at a viewport edge
   (screen dock) or at the coordinate the box is aligning to a sibling. Same short
   length in both cases, so a sibling snap reads like the original edge dock. */
type AxisPreview =
   | { type: "edge"; side: "lo" | "hi" }
   | { type: "guide"; coord: number }
   | null;

interface Snap {
   left: number;
   top: number;
   xPrev: AxisPreview;
   yPrev: AxisPreview;
   /* Whether each axis actually landed on a stop (true even for the preview-less
      viewport-center dock, where xPrev/yPrev are null). Drives onSnap. */
   xSnapped: boolean;
   ySnapped: boolean;
}

/* Persisted position is per-axis INTENT, not a resolved pixel, so it survives a
   viewport resize AND the element scaling itself (a right/bottom dock stays flush as
   the card grows). `lo`/`hi` = flush to the near/far viewport edge (the `edge` gutter);
   `center` = viewport-centered; `free` = the top-left corner as a fraction of the
   VIEWPORT (`f` in 0..1, `top = f * V`), which is where sibling snaps and un-snapped
   drops land (siblings are NOT persisted as references - they re-snap live on the next
   drag). X never persists `center` (the central dead zone filters it), but the type
   allows it so one axisPos covers both.

   `free` is VIEWPORT-relative, NOT travel-relative (`f * (V - size)`), on purpose: the
   corner must not depend on the element's own current size. That decoupling is what makes
   a same-resolution restore land pixel-exact even when the card is a different height at
   restore than at drop (e.g. the Stocks panel restores EMPTY, then grows once the feed
   arrives - a travel-relative anchor resolved against the empty height and then froze the
   card at the wrong spot). A resolution change still repositions proportionally (`f * newV`).
   NOTE: this changed the `free` meaning, so a `free` position saved by the older
   travel-relative build shifts ONCE on first load (by V/(V-size)); the next drag re-saves
   it correctly. Edge docks (lo/hi/center) are unchanged and never shift. */
/* `across`: docked to a screen edge while reaching across the reactor's dead strip (a wide view
   the user placed there): its width may span the strip (maxWidth), where a normal dock keeps
   to the space beside the reactor. */
type Anchor = { a: "lo" | "hi"; across?: boolean } | { a: "center" } | { a: "free"; f: number };
interface StoredPos {
   x: Anchor;
   y: Anchor;
}

const THRESHOLD = 4; // px of movement before a press becomes a drag (taps still click)
const GLIDE_MS = 180; // how long the view takes to slide into a snapped spot
const IND_INSET = 14; // preview bar inset from the viewport edge
const IND_THICK = 5; // preview bar thickness (a rounded rod, so give the shade + caps room)
const SNAP_GAP = 12; // flush-stack gap between two sibling views
const MIN_ONSCREEN = 130; // px of a card that must stay on screen (roughly a header + a
// minimal list body): the vertical clamp keeps at least this much visible so a tall card
// can sit low without its top being pulled up (the body caps itself to fit via list-card)

/* Every live movable view, so a drag can snap to the others' edges. */
const movables = new Set<HTMLElement>();

/* Click-to-front: the views that take part, back to front. Each gets an inline z-index in the
   panel band (RAISE_BASE.. RAISE_BASE + RAISE_SPAN), so the one last touched draws on top. Mount
   order seeds it, so nothing changes until a click. The band sits below the menubar, the dock
   layer, and notification cards (their CSS z-index starts above RAISE_BASE + RAISE_SPAN). */
const RAISE_BASE = 5;
const RAISE_SPAN = 15;
const raiseOrder: HTMLElement[] = [];
const restack = (): void => {
   raiseOrder.forEach((v, i) => (v.style.zIndex = String(RAISE_BASE + Math.min(i, RAISE_SPAN))));
};

/* A non-movable surface that still takes part in click-to-front (the conversation window): a
   press on it brings it in front of the panels. Returns its dispose. */
export function registerRaisable(el: HTMLElement): () => void {
   raiseOrder.push(el);
   restack();
   const onRaise = (): void => raiseMovable(el);
   el.addEventListener("pointerdown", onRaise, { capture: true });
   return (): void => {
      el.removeEventListener("pointerdown", onRaise, { capture: true });
      const i = raiseOrder.indexOf(el);
      if (i >= 0) raiseOrder.splice(i, 1);
      restack();
   };
}

/* Bring a view to the front of the panel band (a click on it, or a view opening itself). */
export function raiseMovable(el: HTMLElement): void {
   const i = raiseOrder.indexOf(el);
   if (i < 0 || i === raiseOrder.length - 1) return;
   raiseOrder.splice(i, 1);
   raiseOrder.push(el);
   restack();
}

/* On-screen rects of every visible movable view (optionally minus one), for callers that need
   to place something clear of them (src/render/placement.ts). */
export function visibleMovableRects(exclude?: HTMLElement): DOMRect[] {
   /* LAYOUT boxes, not the on-screen ones: a receded notice is drawn scaled down by its 3D
      transform and grows back when it comes forward, so its full-size box is what must stay clear. */
   return [...movables]
      .filter((o) => o !== exclude && o.offsetParent !== null)
      .map((o) => {
         const p = (o.offsetParent as HTMLElement).getBoundingClientRect();
         return new DOMRect(p.left + o.offsetLeft, p.top + o.offsetTop, o.offsetWidth, o.offsetHeight);
      });
}

/* --- Snap on resize -------------------------------------------------------------------
   While a view is resized (Mail's edge grips, a list card's bottom grip), the moving edge snaps
   to the screen edges and to other views' edges: flush against a neighbor (with the move gap)
   or aligned with its matching edge. Closer than a move snaps (a fine resize shouldn't jump),
   with the same glowing tick. No viewport-center stop, as for moves. */

export type ResizeSide = "left" | "right" | "top" | "bottom";
const RESIZE_SNAP_PX = 24;

/* Where a moving edge at `pos` should land: the nearest stop within `threshold`, else `pos`.
   `guide` is the coordinate to mark (null when not snapped); `screen` = a viewport edge. */
export function resizeSnapTarget(
   side: ResizeSide,
   pos: number,
   others: DOMRect[],
   viewport: { w: number; h: number; edge: number },
   threshold = RESIZE_SNAP_PX,
   range: [number, number] = [-Infinity, Infinity] // where the edge can actually go (size limits)
): { pos: number; guide: number | null; screen: boolean } {
   const horizontal = side === "left" || side === "right";
   const stops: Array<{ pos: number; guide: number; screen: boolean }> = [];
   if (horizontal) {
      stops.push({ pos: viewport.edge, guide: viewport.edge, screen: true });
      stops.push({ pos: viewport.w - viewport.edge, guide: viewport.w - viewport.edge, screen: true });
   } else {
      stops.push({ pos: viewport.edge, guide: viewport.edge, screen: true });
      stops.push({ pos: viewport.h - viewport.edge, guide: viewport.h - viewport.edge, screen: true });
   }
   for (const o of others) {
      if (side === "right") {
         stops.push({ pos: o.left - SNAP_GAP, guide: o.left - SNAP_GAP, screen: false }); // flush before it
         stops.push({ pos: o.right, guide: o.right, screen: false }); // right edges aligned
      } else if (side === "left") {
         stops.push({ pos: o.right + SNAP_GAP, guide: o.right + SNAP_GAP, screen: false }); // flush after it
         stops.push({ pos: o.left, guide: o.left, screen: false }); // left edges aligned
      } else if (side === "bottom") {
         stops.push({ pos: o.top - SNAP_GAP, guide: o.top - SNAP_GAP, screen: false }); // flush above it
         stops.push({ pos: o.bottom, guide: o.bottom, screen: false }); // bottoms aligned
      } else {
         stops.push({ pos: o.bottom + SNAP_GAP, guide: o.bottom + SNAP_GAP, screen: false }); // flush below it
         stops.push({ pos: o.top, guide: o.top, screen: false }); // tops aligned
      }
   }
   let best: { pos: number; guide: number; screen: boolean } | null = null;
   let bestD = threshold;
   for (const st of stops) {
      if (st.pos < range[0] || st.pos > range[1]) continue; // the size limits wouldn't let it land there
      const d = Math.abs(st.pos - pos);
      if (d <= bestD) {
         best = st;
         bestD = d;
      }
   }
   return best ? { pos: best.pos, guide: best.guide, screen: best.screen } : { pos, guide: null, screen: false };
}

export interface ResizeSnap {
   /* Snap the moving edge at `pos` and mark it; returns the coordinate to use. `range` is where
      the size limits let that edge go, so a stop it can't reach is neither used nor marked. */
   snap(side: ResizeSide, pos: number, range?: [number, number]): number;
   /* The resize ended: take the marks down. */
   end(): void;
}

/* Start snapping one resize. Everything a move needs is measured ONCE here (the other views
   don't move during a resize, nor does the viewport): reading layout on every pointermove,
   right after the previous move wrote a new size, forced a synchronous reflow each time. */
export function beginResizeSnap(el: HTMLElement): ResizeSnap {
   const edge = cssMovableEdge();
   const W = window.innerWidth;
   const H = window.innerHeight;
   /* On-screen rects, as for moves (a receded notice is drawn smaller than its layout box). */
   const others = [...movables].filter((o) => o !== el && o.offsetParent !== null).map((o) => o.getBoundingClientRect());
   const start = el.getBoundingClientRect(); // centers the marks along the panel
   /* One mark per orientation, so a corner resize can show both. */
   const bars: { v: HTMLDivElement | null; h: HTMLDivElement | null } = { v: null, h: null };
   const lastGuide: { v: number | null; h: number | null } = { v: null, h: null };

   return {
      snap: (side, pos, range) => {
         const t = resizeSnapTarget(side, pos, others, { w: W, h: H, edge }, RESIZE_SNAP_PX, range);
         const horizontal = side === "left" || side === "right";
         const key = horizontal ? "v" : "h";
         if (t.guide === lastGuide[key]) return t.pos; // the mark is already right
         lastGuide[key] = t.guide;
         let bar = bars[key];
         if (t.guide === null) {
            if (bar) bar.style.display = "none";
            return pos;
         }
         if (!bar) {
            bar = document.createElement("div");
            bar.className = `movable-snap-bar movable-snap-bar-${key}`;
            document.body.appendChild(bar);
            bars[key] = bar;
         }
         const g = bar.style;
         g.display = "block";
         if (horizontal) {
            const len = Math.min(160, Math.round(start.height * 0.9));
            const x = t.screen ? (t.guide <= edge ? IND_INSET : W - IND_INSET - IND_THICK) : t.guide - IND_THICK / 2;
            g.width = `${IND_THICK}px`;
            g.height = `${len}px`;
            g.left = `${Math.round(x)}px`;
            g.top = `${Math.round(Math.min(H - len, Math.max(0, start.top + start.height / 2 - len / 2)))}px`;
         } else {
            const len = Math.min(200, Math.round(start.width * 0.9));
            const y = t.screen ? (t.guide <= edge ? IND_INSET : H - IND_INSET - IND_THICK) : t.guide - IND_THICK / 2;
            g.height = `${IND_THICK}px`;
            g.width = `${len}px`;
            g.top = `${Math.round(y)}px`;
            g.left = `${Math.round(Math.min(W - len, Math.max(0, start.left + start.width / 2 - len / 2)))}px`;
         }
         return t.pos;
      },
      end: () => {
         bars.v?.remove();
         bars.h?.remove();
         bars.v = bars.h = null;
      }
   };
}

/* The gutter a docked view keeps from the viewport edge. Read from the
   --movable-edge CSS custom property so the snap inset and the cards' default CSS
   position (which use the same property) can never drift apart. */
export function cssMovableEdge(): number {
   const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--movable-edge"));
   return Number.isFinite(v) ? v : 24;
}

/* Which edges a resize moved (makeResizable reports this on release). */
export interface ResizeEdges {
   left?: boolean;
   right?: boolean;
   top?: boolean;
   bottom?: boolean;
}

/* The full movable API, for a view that is also resizable: the anchor rules stay here. */
export interface MovableHandle {
   dispose(): void;
   /* After a user resize: re-derive each axis anchor from which edges moved (a right-docked
      view grown from its left edge stays right-docked; grown from its right edge it goes
      free; a centered axis goes free) and persist. */
   commitResize(edges: ResizeEdges): void;
   /* The widest this view may grow from where it sits without a docked edge entering the
      reactor's dead zone (or leaving the viewport). A view docked across the strip (`across`,
      a wide view the user placed there) may span it: the full viewport width. */
   maxWidth(): number;
   /* The user locked this view in place (its padlock or "Lock all panels"): no drag, no resize. */
   isLocked(): boolean;
}

export function makeMovable(el: HTMLElement, opts: MovableOptions): () => void {
   return makeMovableHandle(el, opts).dispose;
}

export function makeMovableHandle(el: HTMLElement, opts: MovableOptions): MovableHandle {
   const edge = opts.edge ?? cssMovableEdge();
   const zone = opts.snapZone ?? 0.16;
   let glideTimer = 0;

   let startX = 0;
   let startY = 0;
   let originLeft = 0;
   let originTop = 0;
   let dragging = false;
   let pending: Snap | null = null;
   let otherRects: DOMRect[] = []; // sibling views, captured at drag start (they don't move)
   let stored: StoredPos | null = null; // per-axis anchor intent, once the user has placed it

   /* Two preview bars (one per edge the view is about to dock to). */
   const vbar = document.createElement("div");
   const hbar = document.createElement("div");
   vbar.className = "movable-snap-bar movable-snap-bar-v";
   hbar.className = "movable-snap-bar movable-snap-bar-h";

   const place = (left: number, top: number): void => {
      const r = el.getBoundingClientRect();
      const maxLeft = Math.max(edge, window.innerWidth - r.width - edge);
      /* Vertically, a card's TOP is its anchor: it must never be pulled UP just because
         its body is tall (the body caps itself to the viewport via list-card instead).
         So clamp the top only enough to keep a header's worth on screen, not the whole
         height. For short cards (<= MIN_ONSCREEN) this is the full height, i.e. fully on
         screen as before; tall cards may sit lower without the top jumping. */
      const keepVisible = Math.min(r.height, MIN_ONSCREEN);
      const maxTop = Math.max(edge, window.innerHeight - keepVisible - edge);
      const x = Math.min(maxLeft, Math.max(edge, left));
      const y = Math.min(maxTop, Math.max(edge, top));
      el.style.left = `${Math.round(x)}px`;
      el.style.top = `${Math.round(y)}px`;
      el.style.right = "auto";
      el.style.bottom = "auto";
   };

   /* Resolve one axis anchor to a pixel, given the current viewport dimension V and the
      element's current layout SIZE. lo/hi/center track the viewport + size; free is a
      fraction of the viewport (`f * V`), size-independent. `V - size` (the `travel`, used
      only by center now) can go <= 0 on a tiny viewport, so it is floored at 0. */
   const axisPos = (anc: Anchor, V: number, size: number): number => {
      const travel = Math.max(0, V - size);
      switch (anc.a) {
         case "lo":
            return edge;
         case "hi":
            return V - size - edge;
         case "center":
            return travel / 2;
         case "free":
            return anc.f * V; // top-left as a fraction of the viewport (size-independent)
      }
   };

   /* Re-derive the element's pixel position from the stored anchors. Measured with the
      LAYOUT box (offsetWidth/Height), not getBoundingClientRect, so a CSS-3D-transformed
      element (a receded notice) is not measured at its scaled-down on-screen size.
      mode "all" recomputes both axes (viewport change / restore); "dockOnly" recomputes
      only the size-sensitive far-edge/center anchors and holds lo/free at their current
      pixel - so an element scaling itself (e.g. a list card hover-expanding) keeps its
      flush dock without a free/proportional axis drifting. */
   const applyStored = (mode: "all" | "dockOnly" = "all"): boolean => {
      if (!stored) return false;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      /* A hidden view (display:none) measures 0x0, which would resolve a size-dependent
         anchor (hi / center / free) to the wrong pixel. Don't place it; defer to the
         ResizeObserver's first real-size fire once it is shown. */
      if (w === 0 && h === 0) return false;
      const curLeft = parseFloat(el.style.left);
      const curTop = parseFloat(el.style.top);
      const resolve = (anc: Anchor, V: number, size: number, cur: number): number => {
         if (mode === "dockOnly" && (anc.a === "lo" || anc.a === "free")) {
            return Number.isFinite(cur) ? cur : axisPos(anc, V, size);
         }
         return axisPos(anc, V, size);
      };
      place(
         resolve(stored.x, window.innerWidth, w, curLeft),
         resolve(stored.y, window.innerHeight, h, curTop)
      );
      return true;
   };
   /* Whether applyStored has ever run against a real (nonzero) measurement. Until it has,
      a genuine 0 -> nonzero size transition (the view being shown) must do a FULL "all"
      recompute so a free/proportional axis is derived correctly, not held by dockOnly. */
   let appliedRealSize = false;

   /* Visible sibling rects (every other movable view that is currently shown). */
   const siblingRects = (): DOMRect[] =>
      [...movables]
         .filter((o) => o !== el && o.offsetParent !== null)
         .map((o) => o.getBoundingClientRect());

   /* Nearest in-range stop per axis, across the viewport docks AND each sibling's
      edges. Returns the snapped target plus a preview descriptor for that axis. */
   const computeSnap = (r: DOMRect, others: DOMRect[]): Snap => {
      const W = window.innerWidth;
      const H = window.innerHeight;
      const th = zone * Math.min(W, H);
      const w = r.width;
      const h = r.height;

      /* grid: the viewport-center column, which sits over the atom (never used across the strip). */
      type Stop = { pos: number; preview: AxisPreview; grid?: boolean };
      const nearest = (
         cur: number,
         stops: Stop[]
      ): { pos: number; preview: AxisPreview; snapped: boolean } => {
         let best: { stop: Stop; d: number } | null = null;
         for (const s of stops) {
            const d = Math.abs(cur - s.pos);
            if (d <= th && (!best || d < best.d)) best = { stop: s, d };
         }
         return best
            ? { pos: best.stop.pos, preview: best.stop.preview, snapped: true }
            : { pos: cur, preview: null, snapped: false };
      };

      /* X: viewport docks + per-sibling (left-align / right-align / flush-right /
         flush-left). The preview marks the edge the box is aligning to. */
      const xStops: Stop[] = [
         { pos: edge, preview: { type: "edge", side: "lo" } },
         { pos: (W - w) / 2, preview: null, grid: true },
         { pos: W - w - edge, preview: { type: "edge", side: "hi" } }
      ];
      for (const o of others) {
         xStops.push({ pos: o.left, preview: { type: "guide", coord: o.left } });
         xStops.push({ pos: o.right - w, preview: { type: "guide", coord: o.right } });
         xStops.push({ pos: o.right + SNAP_GAP, preview: { type: "guide", coord: o.right + SNAP_GAP } });
         xStops.push({ pos: o.left - w - SNAP_GAP, preview: { type: "guide", coord: o.left - SNAP_GAP } });
      }

      /* Y: viewport docks + per-sibling (top-align / bottom-align / flush-below /
         flush-above). */
      const yStops: Stop[] = [
         { pos: edge, preview: { type: "edge", side: "lo" } },
         { pos: (H - h) / 2, preview: null },
         { pos: H - h - edge, preview: { type: "edge", side: "hi" } }
      ];
      for (const o of others) {
         yStops.push({ pos: o.top, preview: { type: "guide", coord: o.top } });
         yStops.push({ pos: o.bottom - h, preview: { type: "guide", coord: o.bottom } });
         yStops.push({ pos: o.bottom + SNAP_GAP, preview: { type: "guide", coord: o.bottom + SNAP_GAP } });
         yStops.push({ pos: o.top - h - SNAP_GAP, preview: { type: "guide", coord: o.top - SNAP_GAP } });
      }

      /* The central dead strip: snapping never pulls a card INTO it (see allowXStop). */
      const dz = deadZoneX();
      const validXStops = xStops.filter((s) => allowXStop(s.pos, w, r.left, dz, s.grid === true, opts.freeOverAtom === true));

      const sx = nearest(r.left, validXStops);
      const sy = nearest(r.top, yStops);
      return {
         left: sx.pos,
         top: sy.pos,
         xPrev: sx.preview,
         yPrev: sy.preview,
         xSnapped: sx.snapped,
         ySnapped: sy.snapped
      };
   };

   /* Show a glowing bar for each snapped axis: at the viewport edge for a screen
      dock, or along the shared guide line for a sibling snap. */
   const showPreview = (snap: Snap, r: DOMRect): void => {
      const W = window.innerWidth;
      const H = window.innerHeight;
      const cx = snap.left + r.width / 2;
      const cy = snap.top + r.height / 2;

      /* A short vertical bar: at the viewport edge for a screen dock, or at the
         aligned coordinate for a sibling snap. Same length either way, centered on
         where the box lands, so both read as the same brief tick. */
      if (snap.xPrev) {
         const len = Math.min(160, Math.round(r.height * 0.9));
         const x =
            snap.xPrev.type === "edge"
               ? snap.xPrev.side === "lo"
                  ? IND_INSET
                  : W - IND_INSET - IND_THICK
               : snap.xPrev.coord - IND_THICK / 2;
         vbar.style.width = `${IND_THICK}px`;
         vbar.style.height = `${len}px`;
         vbar.style.left = `${Math.round(x)}px`;
         vbar.style.top = `${Math.round(Math.min(H - len, Math.max(0, cy - len / 2)))}px`;
         vbar.style.display = "block";
      } else {
         vbar.style.display = "none";
      }

      /* A short horizontal bar, same idea on the other axis. */
      if (snap.yPrev) {
         const len = Math.min(200, Math.round(r.width * 0.9));
         const y =
            snap.yPrev.type === "edge"
               ? snap.yPrev.side === "lo"
                  ? IND_INSET
                  : H - IND_INSET - IND_THICK
               : snap.yPrev.coord - IND_THICK / 2;
         hbar.style.height = `${IND_THICK}px`;
         hbar.style.width = `${len}px`;
         hbar.style.top = `${Math.round(y)}px`;
         hbar.style.left = `${Math.round(Math.min(W - len, Math.max(0, cx - len / 2)))}px`;
         hbar.style.display = "block";
      } else {
         hbar.style.display = "none";
      }
   };

   const hidePreview = (): void => {
      vbar.remove();
      hbar.remove();
   };

   const isAnchor = (v: unknown): v is Anchor =>
      !!v &&
      typeof v === "object" &&
      (((v as Anchor).a === "lo" || (v as Anchor).a === "hi" || (v as Anchor).a === "center") ||
         ((v as { a?: string }).a === "free" && Number.isFinite((v as { f?: unknown }).f)));

   const restore = (): void => {
      try {
         const raw = localStorage.getItem(opts.storageKey);
         if (!raw) return;
         const parsed = JSON.parse(raw) as unknown;
         if (!parsed || typeof parsed !== "object") return;
         const p = parsed as { x?: unknown; y?: unknown };
         if (isAnchor(p.x) && isAnchor(p.y)) {
            /* v2 anchor schema; `across` only ever as a real true (untrusted storage). */
            const clean = (a: Anchor): Anchor =>
               a.a === "lo" || a.a === "hi" ? ((a as { across?: unknown }).across === true ? { a: a.a, across: true } : { a: a.a }) : a;
            stored = { x: clean(p.x), y: clean(p.y) };
            if (applyStored("all")) appliedRealSize = true;
            return;
         }
         /* Legacy px `{x, y}`: convert to a free VIEWPORT-fraction so it lands roughly
            where it was. Not written back here (applyStored never persists); the next drop
            upgrades it to a real anchor. */
         if (typeof p.x === "number" && typeof p.y === "number") {
            const frac = (px: number, V: number): number => Math.min(1, Math.max(0, px / Math.max(1, V)));
            stored = {
               x: { a: "free", f: frac(p.x, window.innerWidth) },
               y: { a: "free", f: frac(p.y, window.innerHeight) }
            };
            if (applyStored("all")) appliedRealSize = true;
         }
      } catch {
         /* ignore a corrupt entry */
      }
   };

   /* A card at this left edge and width reaching across the strip (the one test behind an
      `across` dock, wherever a dock is decided: a drop, a resize, a CSS default). */
   const acrossFor = (left: number, width: number): boolean => {
      const [lo, hi] = deadZoneX();
      return left < hi && left + width > lo;
   };
   const withAcross = (anc: Anchor, left: number, width: number): Anchor =>
      anc.a === "lo" || anc.a === "hi" ? (acrossFor(left, width) ? { a: anc.a, across: true } : { a: anc.a }) : anc;

   /* True when the view's horizontal centre sits inside the central dead strip: with
      `freeOverAtom` (a notice) a drop here does not snap (it floats free), its undock gesture. */
   const inDeadZone = (r: DOMRect): boolean => {
      const [lo, hi] = deadZoneX();
      const cx = r.left + r.width / 2;
      return cx >= lo && cx <= hi;
   };
   /* A "no snap" result: stay exactly where dropped, report unsnapped. */
   const freeSnap = (r: DOMRect): Snap => ({
      left: r.left,
      top: r.top,
      xPrev: null,
      yPrev: null,
      xSnapped: false,
      ySnapped: false
   });

   const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (opts.handle && !target.closest(opts.handle)) return; // only the handle drags
      if (opts.ignore && target.closest(opts.ignore)) return; // let controls handle it
      if (target.closest(".movable-lock")) return; // the padlock is a button, never a drag
      if (lock?.locked()) return; // locked in place: the press is just a press
      const r = el.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      originLeft = r.left;
      originTop = r.top;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
   };

   const onMove = (e: PointerEvent): void => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragging) {
         if (Math.hypot(dx, dy) < THRESHOLD) return;
         dragging = true;
         otherRects = siblingRects(); // snapshot siblings once; they stay put during the drag
         window.clearTimeout(glideTimer);
         el.style.transition = ""; // drop any in-flight snap glide so the drag is 1:1
         el.classList.add("movable-dragging");
         document.body.style.userSelect = "none";
         document.body.append(vbar, hbar);
      }
      place(originLeft + dx, originTop + dy);
      const r = el.getBoundingClientRect();
      if (opts.freeOverAtom && inDeadZone(r)) {
         /* Over the atom: no snapping - it drops free here (the undock region). */
         pending = freeSnap(r);
         vbar.style.display = "none";
         hbar.style.display = "none";
      } else {
         pending = computeSnap(r, otherRects);
         showPreview(pending, r);
      }
   };

   const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!dragging) return;
      dragging = false;
      el.classList.remove("movable-dragging");
      document.body.style.userSelect = "";
      hidePreview();

      const rect = el.getBoundingClientRect();
      const snap = opts.freeOverAtom && inDeadZone(rect) ? freeSnap(rect) : (pending ?? computeSnap(rect, otherRects));
      pending = null;
      const moved = Math.round(snap.left) !== Math.round(parseFloat(el.style.left || "0"));
      if (moved || snap.xPrev || snap.yPrev) {
         el.style.transition = `left ${GLIDE_MS}ms ease, top ${GLIDE_MS}ms ease`;
         window.clearTimeout(glideTimer);
         glideTimer = window.setTimeout(() => (el.style.transition = ""), GLIDE_MS + 20);
      }
      place(snap.left, snap.top);

      /* Persist the INTENT, not the pixel. Classify each axis from the snap result: a
         viewport-edge dock -> lo/hi; a preview-less snap -> center (viewport-center, Y
         only - X center is dead-zone-filtered); a sibling guide OR an un-snapped drop ->
         free, with the fraction read from the PLACED (post-clamp) pixel so it round-trips. */
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const placedLeft = parseFloat(el.style.left) || 0;
      const acrossStrip = acrossFor(placedLeft, w);
      const anchorFor = (prev: AxisPreview, snapped: boolean, placed: number, V: number, _size: number, horizontal: boolean): Anchor => {
         if (prev && prev.type === "edge") {
            const side = prev.side === "lo" ? "lo" : "hi";
            return horizontal && acrossStrip ? { a: side, across: true } : { a: side };
         }
         if (snapped && !prev) return { a: "center" };
         /* free = the placed top-left corner as a fraction of the viewport (size-independent),
            so a same-resolution restore reproduces this exact pixel. */
         return { a: "free", f: Math.min(1, Math.max(0, placed / Math.max(1, V))) };
      };
      stored = {
         x: anchorFor(snap.xPrev, snap.xSnapped, placedLeft, window.innerWidth, w, true),
         y: anchorFor(snap.yPrev, snap.ySnapped, parseFloat(el.style.top) || 0, window.innerHeight, h, false)
      };
      localStorage.setItem(opts.storageKey, JSON.stringify(stored));
      opts.onSnap?.(snap.xSnapped || snap.ySnapped);
   };

   const onResize = (): void => {
      /* A user-placed view re-derives from its anchors (re-docks flush, re-centers,
         re-proportions free). A view positioned by the caller with no stored anchor (e.g.
         a notice placed by placeDefault) keeps the old px re-clamp so it stays on screen. */
      if (stored) {
         if (applyStored("all")) appliedRealSize = true;
      } else if (el.style.left) {
         place(parseFloat(el.style.left), parseFloat(el.style.top));
      }
   };

   /* Element self-scaling (a card hover-expanding, the music player growing as a track
      loads) does NOT fire window.resize, so a ResizeObserver re-docks to the new size.
      Gated: never mid-drag; never while the element is pressed (its own grip) or hovered
      (a hovered list card is expanding - re-anchoring there would drift the header; a
      pointerleave re-fires this to settle it). The first REAL-size fire (a hidden view
      being shown) does a full "all" recompute so a free axis is derived correctly; after
      that only size-sensitive hi/center anchors re-dock ("dockOnly"), leaving lo/free put.
      A transition back to 0x0 (the view hidden) re-arms the "all" recompute for next show. */
   const onSelfResize = (): void => {
      if (!stored || dragging) return;
      if (el.offsetWidth === 0 && el.offsetHeight === 0) {
         appliedRealSize = false; // hidden again: next real-size fire recomputes fully
         return;
      }
      if (!appliedRealSize) {
         if (applyStored("all")) appliedRealSize = true;
         return;
      }
      if (el.matches(":hover, :active")) return;
      const sizeSensitive = (a: Anchor): boolean => a.a === "hi" || a.a === "center";
      if (!sizeSensitive(stored.x) && !sizeSensitive(stored.y)) return;
      applyStored("dockOnly");
   };
   const ro = new ResizeObserver(onSelfResize);

   /* The card is a drag surface, so suppress text selection on it: without this a
      press-and-move can start a text highlight before the drag threshold trips (the
      <body> userSelect toggle below only covers the active drag, not that first
      press). */
   el.style.userSelect = "none";
   el.style.setProperty("-webkit-user-select", "none");

   restore();
   movables.add(el); // visible to other movable views as a snap target
   const lock = opts.lockable === false ? null : mountPanelLock(el, opts.storageKey, opts.lockSlot);
   const raises = opts.raise !== false;
   const onRaise = (): void => raiseMovable(el);
   if (raises) {
      raiseOrder.push(el);
      restack();
      el.addEventListener("pointerdown", onRaise, { capture: true }); // any press, even on a control
   }
   el.addEventListener("pointerdown", onDown);
   el.addEventListener("pointerleave", onSelfResize); // settle a hi/center dock the hover gate deferred
   window.addEventListener("resize", onResize);
   ro.observe(el); // re-dock on element self-scaling (fires once immediately - a no-op if unplaced)

   const commitResize = (edges: ResizeEdges): void => {
      const r = el.getBoundingClientRect();
      const W = window.innerWidth;
      const H = window.innerHeight;
      const free = (px: number, V: number): Anchor => ({ a: "free", f: Math.min(1, Math.max(0, px / Math.max(1, V))) });
      /* A view never placed by the user sits at its CSS default: read the dock that default
         expresses (flush to an edge gutter = docked there), so the first resize of a CSS
         right-docked card keeps it right-docked. */
      const fromCss = (lo: number, hi: number, V: number): Anchor =>
         Math.abs(hi - (V - edge)) <= 2 ? { a: "hi" } : Math.abs(lo - edge) <= 2 ? { a: "lo" } : free(lo, V);
      const cur: StoredPos = stored ?? { x: fromCss(r.left, r.right, W), y: fromCss(r.top, r.bottom, H) };
      const axis = (anc: Anchor, lo: boolean | undefined, hi: boolean | undefined, px: number, far: number, V: number): Anchor => {
         if (!lo && !hi) return anc;
         if (anc.a === "hi" && lo && !hi) return anc; // grown away from its dock: still docked
         if (anc.a === "lo" && hi && !lo) return anc;
         /* The moved edge left flush to the screen gutter (a resize snap to the screen edge):
            docked there, like a move to that edge. */
         if (lo && !hi && Math.abs(px - edge) <= 2) return { a: "lo" };
         if (hi && !lo && Math.abs(far - (V - edge)) <= 2) return { a: "hi" };
         return free(px, V);
      };
      stored = {
         /* A dock that survives the resize re-reads `across` from the new size (narrowed clear of
            the strip: a normal dock again; grown across it: an across dock). */
         x: withAcross(axis(cur.x, edges.left, edges.right, r.left, r.right, W), r.left, r.width),
         y: axis(cur.y, edges.top, edges.bottom, r.top, r.bottom, H)
      };
      try {
         localStorage.setItem(opts.storageKey, JSON.stringify(stored));
      } catch {
         /* storage blocked: the placement still applies this session */
      }
      applyStored("all");
      appliedRealSize = true;
   };

   const maxWidth = (): number => {
      const W = window.innerWidth;
      const r = el.getBoundingClientRect();
      const [dLo, dHi] = deadZoneX();
      /* Docked across the strip on purpose (a wide view): it may span it. */
      if (stored && (stored.x.a === "lo" || stored.x.a === "hi") && stored.x.across) return Math.max(0, W - 2 * edge);
      const dockedLo = stored ? stored.x.a === "lo" : Math.abs(r.left - edge) <= 2;
      const dockedHi = stored ? stored.x.a === "hi" : Math.abs(r.right - (W - edge)) <= 2;
      /* Never placed by the user: a CSS-default dock already reaching across the strip (its
         minimum width is wider than the space beside the reactor) is an across dock too. */
      if (!stored && (dockedLo || dockedHi) && acrossFor(r.left, r.width)) return Math.max(0, W - 2 * edge);
      if (dockedLo) return Math.max(0, dLo - edge);
      if (dockedHi) return Math.max(0, W - dHi - edge);
      return Math.max(0, W - 2 * edge);
   };

   return {
      commitResize,
      maxWidth,
      isLocked: () => lock?.locked() ?? false,
      dispose: (): void => {
         lock?.dispose();
         movables.delete(el);
         if (raises) {
            el.removeEventListener("pointerdown", onRaise, { capture: true });
            const i = raiseOrder.indexOf(el);
            if (i >= 0) raiseOrder.splice(i, 1);
            restack();
         }
         window.clearTimeout(glideTimer);
         hidePreview();
         ro.disconnect();
         el.removeEventListener("pointerdown", onDown);
         el.removeEventListener("pointerleave", onSelfResize);
         window.removeEventListener("resize", onResize);
         window.removeEventListener("pointermove", onMove);
         window.removeEventListener("pointerup", onUp);
      }
   };
}
