/*
 * Drag interaction for panels (brief S5 / S9.2 user-arranged layout). Handles
 * BOTH floating ambient panels and pinned dock cards:
 *
 *   - grab a floating panel and drag it to a side rail -> it pins there
 *   - grab a pinned card and drag it -> reorder within a rail or move rails
 *   - a tap (no drag) on a floating panel -> pin it (click-to-pin)
 *
 * It drags a GHOST (a clone that follows the pointer), never the live element,
 * so the render layer can keep repainting the original without fighting the drag
 * (a floating panel's transform is rewritten every frame). Like the rest of the
 * interaction plumbing it only REPORTS intent: onTap / onDrop; the store decides.
 */

type TapHandler = (id: string) => void;
type DropHandler = (id: string, side: "left" | "right", index: number) => void;

const THRESHOLD = 5; // px before a press becomes a drag (so taps still register)
const ZONE = 0.3; // a drop counts when the pointer is within this fraction of an edge

export class PanelDrag {
   private onTap: TapHandler;
   private onDrop: DropHandler;
   private indicator: HTMLElement;

   private el: HTMLElement | null = null;
   private id = "";
   private floating = false;
   private ghost: HTMLElement | null = null;
   private width = 0;
   private offsetX = 0;
   private offsetY = 0;
   private startX = 0;
   private startY = 0;
   private dragging = false;
   private validDrop = false;
   private side: "left" | "right" = "left";
   private index = 0;

   constructor(root: HTMLElement, opts: { onTap: TapHandler; onDrop: DropHandler }) {
      this.onTap = opts.onTap;
      this.onDrop = opts.onDrop;
      this.indicator = document.createElement("div");
      this.indicator.className = "dock-drop-indicator";
      root.addEventListener("pointerdown", this.onDown);
   }

   private onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest(".dock-close")) return; // the unpin control is not a handle
      const el = target.closest<HTMLElement>(".panel, .dock-card");
      if (!el || !el.dataset.id) return;

      this.el = el;
      this.id = el.dataset.id;
      this.floating = el.classList.contains("panel");
      const r = el.getBoundingClientRect();
      this.width = r.width;
      this.offsetX = e.clientX - r.left;
      this.offsetY = e.clientY - r.top;
      this.startX = e.clientX;
      this.startY = e.clientY;
      /* Kill text selection for the whole press (both the source text and any
         text the pointer sweeps over while dragging). */
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", this.onMove);
      window.addEventListener("pointerup", this.onUp);
   };

   private onMove = (e: PointerEvent): void => {
      if (!this.el) return;
      if (!this.dragging) {
         if (Math.hypot(e.clientX - this.startX, e.clientY - this.startY) < THRESHOLD) return;
         this.begin();
      }
      if (this.ghost) {
         this.ghost.style.left = `${e.clientX - this.offsetX}px`;
         this.ghost.style.top = `${e.clientY - this.offsetY}px`;
      }
      this.updateTarget(e.clientX, e.clientY);
   };

   private begin(): void {
      if (!this.el) return;
      this.dragging = true;
      window.getSelection()?.removeAllRanges();

      const r = this.el.getBoundingClientRect();
      const ghost = this.el.cloneNode(true) as HTMLElement;
      ghost.classList.add("drag-ghost");
      ghost.style.transform = "none";
      ghost.style.filter = "none";
      ghost.style.position = "fixed";
      ghost.style.margin = "0";
      ghost.style.left = `${r.left}px`;
      ghost.style.top = `${r.top}px`;
      ghost.style.width = `${this.width}px`;
      ghost.style.opacity = "0.96";
      ghost.style.pointerEvents = "none";
      document.body.appendChild(ghost);
      this.ghost = ghost;

      /* Hide the live original while its ghost is out (renderer does not touch
         visibility, so this sticks; restored on drop). */
      this.el.style.visibility = "hidden";
      document.body.appendChild(this.indicator);
   }

   /* Decide the target rail + index and place the drop indicator. */
   private updateTarget(x: number, y: number): void {
      const w = window.innerWidth;
      this.side = x < w / 2 ? "left" : "right";
      this.validDrop = x < w * ZONE || x > w * (1 - ZONE);

      const rail = document.querySelector<HTMLElement>(`.dock-rail.${this.side}`);
      if (!rail || !this.validDrop) {
         this.indicator.style.display = "none";
         return;
      }
      this.indicator.style.display = "block";

      /* Sort by on-screen position, NOT DOM order: cards are laid out by flex
         `order`, so DOM order does not match visual order once a rail has been
         reordered. Without this, "below the last card" points at the wrong card
         and the indicator misses the bottom slot. */
      const rects = [...rail.querySelectorAll<HTMLElement>(".dock-card")]
         .filter((c) => c.dataset.id !== this.id)
         .map((c) => c.getBoundingClientRect())
         .sort((a, b) => a.top - b.top);
      this.index = rects.filter((r) => r.top + r.height / 2 < y).length;

      const railRect = rail.getBoundingClientRect();
      let top: number;
      if (rects.length === 0) top = window.innerHeight / 2 - 30;
      else if (this.index >= rects.length) top = rects[rects.length - 1].bottom + 4;
      else top = rects[this.index].top - 5;

      this.indicator.style.left = `${railRect.left}px`;
      this.indicator.style.width = `${railRect.width}px`;
      this.indicator.style.top = `${top}px`;
   }

   private onUp = (): void => {
      window.removeEventListener("pointermove", this.onMove);
      window.removeEventListener("pointerup", this.onUp);
      document.body.style.userSelect = "";

      if (this.dragging) {
         this.ghost?.remove();
         this.ghost = null;
         this.indicator.remove();
         if (this.el) this.el.style.visibility = "";
         if (this.validDrop) this.onDrop(this.id, this.side, this.index);
      } else if (this.el && this.floating) {
         /* A tap on a floating panel pins it. */
         this.onTap(this.id);
      }
      this.el = null;
      this.dragging = false;
      this.validDrop = false;
   };

   dispose(): void {
      this.indicator.remove();
   }
}
