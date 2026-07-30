/*
 * makeMovable: let a standalone view (the music player, and future floating
 * instruments) be grabbed and repositioned, rather than glued to a fixed corner.
 * This is the shared mechanism behind the "views are user-arrangeable" convention.
 *
 * Snapping model: each axis has three dock stops (near-edge / center / far-edge).
 * On release an axis snaps to its nearest stop only if the view was dropped within
 * the magnetic distance of it, leaving free bands between. So corners, side-centers,
 * and the center are all equally easy to hit, and an in-between drop stays put.
 * While dragging, a glowing bar previews each edge the view is about to dock to.
 *
 * Distinct from PanelDrag: that one drags a GHOST of a store-backed panel onto the
 * side rails and reports intent to the store; this moves a live self-owned view.
 */

export interface MovableOptions {
   /* localStorage key for the persisted top-left position. */
   storageKey: string;
   /* Selector for descendants that must NOT initiate a drag (controls). */
   ignore?: string;
   /* Keep this many px clear of the viewport edges when docked. */
   edge?: number;
   /* Magnetic distance around each axis stop, as a fraction of the smaller viewport
      dimension. Larger = stickier stops / narrower free bands. */
   snapZone?: number;
}

interface Snap {
   left: number;
   top: number;
   xEdge: "left" | "right" | null; // an actual edge dock (not center / free), for the preview
   yEdge: "top" | "bottom" | null;
}

const THRESHOLD = 4; // px of movement before a press becomes a drag (taps still click)
const GLIDE_MS = 180; // how long the view takes to slide into a snapped spot
const IND_INSET = 14; // preview bar inset from the viewport edge
const IND_THICK = 3; // preview bar thickness

export function makeMovable(el: HTMLElement, opts: MovableOptions): () => void {
   const edge = opts.edge ?? 24;
   const zone = opts.snapZone ?? 0.16;
   let glideTimer = 0;

   let startX = 0;
   let startY = 0;
   let originLeft = 0;
   let originTop = 0;
   let dragging = false;
   let pending: Snap | null = null;

   /* Two preview bars (one per edge the view is about to dock to). */
   const vbar = document.createElement("div");
   const hbar = document.createElement("div");
   vbar.className = "movable-snap-bar";
   hbar.className = "movable-snap-bar";

   const place = (left: number, top: number): void => {
      const r = el.getBoundingClientRect();
      const maxLeft = Math.max(edge, window.innerWidth - r.width - edge);
      const maxTop = Math.max(edge, window.innerHeight - r.height - edge);
      const x = Math.min(maxLeft, Math.max(edge, left));
      const y = Math.min(maxTop, Math.max(edge, top));
      el.style.left = `${Math.round(x)}px`;
      el.style.top = `${Math.round(y)}px`;
      el.style.right = "auto";
      el.style.bottom = "auto";
   };

   /* Nearest in-range stop per axis. Returns the (possibly snapped) target plus
      which real edges snapped, for the preview. */
   const computeSnap = (r: DOMRect): Snap => {
      const W = window.innerWidth;
      const H = window.innerHeight;
      const th = zone * Math.min(W, H);
      const nearest = (
         cur: number,
         stops: [number, "lo" | "mid" | "hi"][]
      ): { pos: number; kind: "lo" | "mid" | "hi" | null } => {
         let best: { pos: number; kind: "lo" | "mid" | "hi"; d: number } | null = null;
         for (const [pos, kind] of stops) {
            const d = Math.abs(cur - pos);
            if (d <= th && (!best || d < best.d)) best = { pos, kind, d };
         }
         return best ? { pos: best.pos, kind: best.kind } : { pos: cur, kind: null };
      };
      const sx = nearest(r.left, [
         [edge, "lo"],
         [(W - r.width) / 2, "mid"],
         [W - r.width - edge, "hi"]
      ]);
      const sy = nearest(r.top, [
         [edge, "lo"],
         [(H - r.height) / 2, "mid"],
         [H - r.height - edge, "hi"]
      ]);
      return {
         left: sx.pos,
         top: sy.pos,
         xEdge: sx.kind === "lo" ? "left" : sx.kind === "hi" ? "right" : null,
         yEdge: sy.kind === "lo" ? "top" : sy.kind === "hi" ? "bottom" : null
      };
   };

   /* Show a glowing bar on each edge the view is about to dock to, centered on where
      the view will land along that edge. */
   const showPreview = (snap: Snap, r: DOMRect): void => {
      const W = window.innerWidth;
      const H = window.innerHeight;
      const cx = snap.left + r.width / 2;
      const cy = snap.top + r.height / 2;
      if (snap.xEdge) {
         const len = Math.min(160, Math.round(r.height * 0.9));
         vbar.style.width = `${IND_THICK}px`;
         vbar.style.height = `${len}px`;
         vbar.style.left = `${snap.xEdge === "left" ? IND_INSET : W - IND_INSET - IND_THICK}px`;
         vbar.style.top = `${Math.round(Math.min(H - len, Math.max(0, cy - len / 2)))}px`;
         vbar.style.display = "block";
      } else {
         vbar.style.display = "none";
      }
      if (snap.yEdge) {
         const len = Math.min(200, Math.round(r.width * 0.9));
         hbar.style.height = `${IND_THICK}px`;
         hbar.style.width = `${len}px`;
         hbar.style.top = `${snap.yEdge === "top" ? IND_INSET : H - IND_INSET - IND_THICK}px`;
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

   const restore = (): void => {
      try {
         const raw = localStorage.getItem(opts.storageKey);
         if (!raw) return;
         const pos = JSON.parse(raw) as { x?: number; y?: number };
         if (typeof pos.x === "number" && typeof pos.y === "number") place(pos.x, pos.y);
      } catch {
         /* ignore a corrupt entry */
      }
   };

   const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
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
         window.clearTimeout(glideTimer);
         el.style.transition = ""; // drop any in-flight snap glide so the drag is 1:1
         el.classList.add("movable-dragging");
         document.body.style.userSelect = "none";
         document.body.append(vbar, hbar);
      }
      place(originLeft + dx, originTop + dy);
      const r = el.getBoundingClientRect();
      pending = computeSnap(r);
      showPreview(pending, r);
   };

   const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!dragging) return;
      dragging = false;
      el.classList.remove("movable-dragging");
      document.body.style.userSelect = "";
      hidePreview();

      const snap = pending ?? computeSnap(el.getBoundingClientRect());
      pending = null;
      const moved = Math.round(snap.left) !== Math.round(parseFloat(el.style.left || "0"));
      if (moved || snap.xEdge || snap.yEdge) {
         el.style.transition = `left ${GLIDE_MS}ms ease, top ${GLIDE_MS}ms ease`;
         window.clearTimeout(glideTimer);
         glideTimer = window.setTimeout(() => (el.style.transition = ""), GLIDE_MS + 20);
      }
      place(snap.left, snap.top);
      localStorage.setItem(
         opts.storageKey,
         JSON.stringify({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) })
      );
   };

   const onResize = (): void => {
      if (el.style.left) place(parseFloat(el.style.left), parseFloat(el.style.top));
   };

   restore();
   el.addEventListener("pointerdown", onDown);
   window.addEventListener("resize", onResize);

   return (): void => {
      window.clearTimeout(glideTimer);
      hidePreview();
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
   };
}
