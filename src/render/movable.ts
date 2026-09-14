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

import { ANCHOR_SIZE_FRAC } from "../design/tokens.ts";

/* Central dead zone: a full-height vertical strip as wide as the reactor, centered on it.
   Reused from ANCHOR_SIZE_FRAC (the atom's real footprint) so it tracks the reactor at
   any resolution. No view snaps INTO this strip - drops resolve to the left/right regions
   flanking it (the two side columns) - and a card released with its center inside the
   strip stays free (unsnapped): that free drop over the atom is the undock gesture. */
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
   `center` = viewport-centered; `free` = a fraction of the free travel (`f` in 0..1),
   which is where sibling snaps and un-snapped drops land (siblings are NOT persisted as
   references - they re-snap live on the next drag). X never persists `center` (the
   central dead zone filters it), but the type allows it so one axisPos covers both. */
type Anchor = { a: "lo" | "hi" | "center" } | { a: "free"; f: number };
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

/* The gutter a docked view keeps from the viewport edge. Read from the
   --movable-edge CSS custom property so the snap inset and the cards' default CSS
   position (which use the same property) can never drift apart. */
export function cssMovableEdge(): number {
   const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--movable-edge"));
   return Number.isFinite(v) ? v : 24;
}

export function makeMovable(el: HTMLElement, opts: MovableOptions): () => void {
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
      element's current layout SIZE. lo/center/hi track the viewport + size; free scales
      with the free travel. `V - size` can go <= 0 on a tiny viewport, so clamp it. */
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
            return anc.f * travel;
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

      type Stop = { pos: number; preview: AxisPreview };
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
         { pos: (W - w) / 2, preview: null },
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

      /* Reject any X stop that would land the card overlapping the central dead strip
         (this also drops the viewport-center stop, whose card sits over the atom): a view
         can only snap into the left or right region flanking the reactor. */
      const [dxMin, dxMax] = deadZoneX();
      const validXStops = xStops.filter((s) => !(s.pos < dxMax && s.pos + w > dxMin));

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
            stored = { x: p.x, y: p.y }; // v2 anchor schema
            if (applyStored("all")) appliedRealSize = true;
            return;
         }
         /* Legacy px `{x, y}`: convert to free-fractions against the CURRENT viewport +
            size so it lands roughly where it was. Not written back here (applyStored never
            persists); the next drop upgrades it to a real anchor. */
         if (typeof p.x === "number" && typeof p.y === "number") {
            const w = el.offsetWidth;
            const h = el.offsetHeight;
            const frac = (px: number, V: number, size: number): number =>
               Math.min(1, Math.max(0, px / Math.max(1, V - size)));
            stored = {
               x: { a: "free", f: frac(p.x, window.innerWidth, w) },
               y: { a: "free", f: frac(p.y, window.innerHeight, h) }
            };
            if (applyStored("all")) appliedRealSize = true;
         }
      } catch {
         /* ignore a corrupt entry */
      }
   };

   /* True when the view's horizontal centre sits inside the central dead strip: a drop
      here does not snap (it floats free), which is the undock gesture for a notice. */
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
      if (inDeadZone(r)) {
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
      const snap = inDeadZone(rect) ? freeSnap(rect) : (pending ?? computeSnap(rect, otherRects));
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
      const anchorFor = (prev: AxisPreview, snapped: boolean, placed: number, V: number, size: number): Anchor => {
         if (prev && prev.type === "edge") return { a: prev.side === "lo" ? "lo" : "hi" };
         if (snapped && !prev) return { a: "center" };
         const travel = Math.max(1, V - size); // divisor floor of 1 (axisPos's multiplier floors at 0)
         return { a: "free", f: Math.min(1, Math.max(0, placed / travel)) };
      };
      stored = {
         x: anchorFor(snap.xPrev, snap.xSnapped, parseFloat(el.style.left) || 0, window.innerWidth, w),
         y: anchorFor(snap.yPrev, snap.ySnapped, parseFloat(el.style.top) || 0, window.innerHeight, h)
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
   el.addEventListener("pointerdown", onDown);
   el.addEventListener("pointerleave", onSelfResize); // settle a hi/center dock the hover gate deferred
   window.addEventListener("resize", onResize);
   ro.observe(el); // re-dock on element self-scaling (fires once immediately - a no-op if unplaced)

   return (): void => {
      movables.delete(el);
      window.clearTimeout(glideTimer);
      hidePreview();
      ro.disconnect();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerleave", onSelfResize);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
   };
}
