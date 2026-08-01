/*
 * The CSS-3D renderer (brief S6, S7.3): the faux-3D v1 paint. It reads abstract
 * RenderNodes and maps them to real DOM in a CSS perspective field. This is the
 * ONLY file in the system that knows what a pixel is. It holds no logic about
 * importance, contention, or timing; it is handed fully-resolved coordinates and
 * makes the screen match them.
 *
 * The mapping it owns:
 *   depth 0..1   -> translateZ + perspective scale + depth-of-field blur
 *   presence     -> opacity
 *   emphasis     -> accent glow bloom
 *   tone         -> which palette token the glow/text use
 *   proximity to the anchor -> extra glow (the "anchor is the light source"
 *                              signature, brief S3.4): panels near the center
 *                              light catch more of it.
 *
 * Swap this class for a WebGL one and the RenderNode contract is unchanged.
 */

import { ANCHOR_SIZE_FRAC } from "../design/tokens.ts";
import type { Renderer, RenderNode } from "./renderer.ts";

/* Depth -> translateZ pixels. Back sits deep behind the screen plane; front
   comes just in front of the anchor. The perspective on #field does the scaling
   for free, so we only translate in Z. */
const Z_BACK = -520;
const Z_FRONT = 70;
const MAX_BLUR = 2.0; // px on the farthest node; depth of field

/* Short channel codes shown in each panel head, HUD-readout style. */
const KIND_CODE: Record<string, string> = {
   calendar: "CAL",
   email: "MSG",
   homeassistant: "H·A",
   subsystems: "SYS"
};

interface Slot {
   root: HTMLElement;
   summaryEl: HTMLElement;
   detailEl: HTMLElement;
   metaEl: HTMLElement;
   /* Measured half-extent in px, cached so we do not read layout every frame.
      Used to keep panels clear of the anchor and the viewport edge. */
   halfW: number;
   halfH: number;
}

/* Anchor radius as a fraction of the smaller viewport dimension, DERIVED from
   the single anchor-size token (the canvas is a square of side min*frac, so its
   radius is half that). Panels are mapped to always sit beyond this central
   keep-out, at any resolution, and it can no longer drift from the real size. */
const ANCHOR_RADIUS_FRAC = ANCHOR_SIZE_FRAC / 2;
const KEEPOUT_GAP = 22; // px breathing room between a panel and the anchor/edge
/* Width reserved at each edge for the pinned side rails, so ambient floating
   panels stay in the mid-zone between the reactor and the rails (brief layout:
   pinned own the edges, ambient hover inward). */
const RAIL_RESERVE = 330;

interface DockSlot {
   root: HTMLElement;
   titleEl: HTMLElement;
   subEl: HTMLElement;
   metaEl: HTMLElement;
   progressFill: HTMLElement;
   listEl: HTMLElement;
   side: "left" | "right";
}

export class Css3dRenderer implements Renderer {
   private field: HTMLElement;
   private slots = new Map<string, Slot>();
   private dockSlots = new Map<string, DockSlot>();
   private leftRail: HTMLElement;
   private rightRail: HTMLElement;
   private onSelect?: (id: string) => void;
   private onHover?: (id: string, over: boolean) => void;
   private onClose?: (id: string) => void;
   private w = 0;
   private h = 0;

   /* `onSelect` reports keyboard activation; `onHover` reports the pointer
      entering/leaving a floating panel (used to hold a notice forward while read);
      `onClose` reports the × close control on a notification card (floating or docked).
      Pointer taps and drags are handled by PanelDrag (wired in the composition root).
      The renderer never resolves intent itself. */
   constructor(
      field: HTMLElement,
      docks: HTMLElement,
      onSelect?: (id: string) => void,
      onHover?: (id: string, over: boolean) => void,
      onClose?: (id: string) => void
   ) {
      this.field = field;
      this.leftRail = docks.querySelector(".dock-rail.left") as HTMLElement;
      this.rightRail = docks.querySelector(".dock-rail.right") as HTMLElement;
      this.onSelect = onSelect;
      this.onHover = onHover;
      this.onClose = onClose;
      this.resize(window.innerWidth, window.innerHeight);
   }

   resize(width: number, height: number): void {
      this.w = width;
      this.h = height;
      /* Panel sizes are viewport-relative (CSS clamp), so remeasure on resize. */
      for (const slot of this.slots.values()) {
         this.measure(slot);
      }
   }

   /* Remove all panel DOM (HMR / teardown). */
   dispose(): void {
      for (const slot of this.slots.values()) slot.root.remove();
      for (const slot of this.dockSlots.values()) slot.root.remove();
      this.slots.clear();
      this.dockSlots.clear();
   }

   render(nodes: RenderNode[]): void {
      const liveFloat = new Set<string>();
      const livePinned = new Set<string>();
      for (const n of nodes) {
         if (n.pinned) {
            livePinned.add(n.id);
            this.paintPinned(n);
         } else {
            liveFloat.add(n.id);
            this.paint(n);
         }
      }
      /* Remove DOM for floating nodes that are gone or became pinned. */
      for (const [id, slot] of this.slots) {
         if (!liveFloat.has(id)) {
            slot.root.remove();
            this.slots.delete(id);
         }
      }
      for (const [id, slot] of this.dockSlots) {
         if (!livePinned.has(id)) {
            slot.root.remove();
            this.dockSlots.delete(id);
         }
      }
   }

   private paint(n: RenderNode): void {
      const slot = this.slotFor(n);

      /* Abstract -> pixels through a central keep-out. A panel's horizontal
         offset starts BEYOND the anchor (radius + its own half-width + a gap)
         and spans whatever room is left to the viewport edge, so it clears the
         anchor at any resolution instead of colliding on a narrow viewport.
         Vertical is a plain fraction of the space left after its half-height. */
      const min = Math.min(this.w, this.h);
      const anchorR = min * ANCHOR_RADIUS_FRAC;

      const marginX = anchorR + slot.halfW + KEEPOUT_GAP;
      /* Outer bound leaves room for the pinned rails, so ambient panels sit in
         the mid-zone rather than colliding with the edges. */
      const maxX = Math.max(marginX, this.w / 2 - RAIL_RESERVE);
      const px = Math.sign(n.x) * (marginX + Math.abs(n.x) * (maxX - marginX));

      const maxY = Math.max(0, this.h / 2 - slot.halfH - KEEPOUT_GAP);
      const py = n.y * maxY;
      const z = Z_BACK + (Z_FRONT - Z_BACK) * n.depth;
      const blur = (1 - n.depth) * MAX_BLUR;

      slot.root.style.transform =
         `translate(-50%, -50%) translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, ${z.toFixed(1)}px)`;
      slot.root.style.opacity = n.presence.toFixed(3);
      slot.root.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "none";

      /* Anchor-as-light: closer to center (0,0) means more caught light. Combine
         planar proximity with how far forward the node is. */
      const planar = Math.hypot(n.x, n.y);
      const proximity = clamp01(1 - planar / 1.25) * (0.4 + 0.6 * n.depth);
      const glow = clamp01(0.18 + 0.55 * n.emphasis + 0.4 * proximity);

      const tone = n.tone === "attention" ? "alert" : "accent";
      slot.root.style.setProperty("--node-accent", `var(--${tone})`);
      slot.root.style.setProperty("--node-accent-glow", `var(--${tone}-glow)`);
      slot.root.style.setProperty("--node-glow", glow.toFixed(3));
      slot.root.style.setProperty("--node-signal", n.presence.toFixed(3));
      /* Reveal more detail the further forward the node is. */
      slot.detailEl.style.opacity = clamp01((n.depth - 0.55) / 0.45).toFixed(3);

      /* Meta readout: the panel's live status. */
      const meta = n.tone === "attention" ? "ALERT" : n.emphasis > 0.25 ? "LIVE" : "IDLE";
      if (slot.metaEl.textContent !== meta) slot.metaEl.textContent = meta;

      if (slot.summaryEl.textContent !== n.summary) {
         slot.summaryEl.textContent = n.summary;
      }
      const detail = n.detail ?? "";
      if (slot.detailEl.textContent !== detail) {
         slot.detailEl.textContent = detail;
      }
   }

   private slotFor(n: RenderNode): Slot {
      let slot = this.slots.get(n.id);
      if (!slot) {
         const root = document.createElement("div");
         root.className = "panel";
         root.dataset.kind = n.kind;
         root.dataset.id = n.id; // read by the drag controller (pointer + drag)

         /* Keyboard activation pins this panel (pointer taps/drags are PanelDrag's
            job). Accessible: it is a real button in the tab order. */
         root.setAttribute("role", "button");
         root.tabIndex = 0;
         root.setAttribute("aria-label", `Pin ${n.kind}`);
         root.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
               e.preventDefault();
               this.onSelect?.(n.id);
            }
         });
         /* Hover brings a floating panel to the front and holds it there (the store
            pauses its recede) so a receding notice can be read without dismissing. */
         root.addEventListener("pointerenter", () => this.onHover?.(n.id, true));
         root.addEventListener("pointerleave", () => this.onHover?.(n.id, false));

         /* Corner brackets: the HUD frame. */
         for (const c of ["tl", "tr", "bl", "br"]) {
            const corner = document.createElement("span");
            corner.className = `panel-corner ${c}`;
            root.appendChild(corner);
         }
         /* Left indicator bar (glows on spike, colored by tone). */
         const ind = document.createElement("span");
         ind.className = "panel-ind";
         root.appendChild(ind);

         /* Head row: status dot + channel code + right-aligned meta. */
         const head = document.createElement("div");
         head.className = "panel-head";
         const dot = document.createElement("span");
         dot.className = "panel-dot";
         const kindEl = document.createElement("span");
         kindEl.className = "panel-kind";
         kindEl.textContent = KIND_CODE[n.kind] ?? n.kind.slice(0, 3).toUpperCase();
         const metaEl = document.createElement("span");
         metaEl.className = "panel-meta";
         head.append(dot, kindEl, metaEl);

         const summaryEl = document.createElement("div");
         summaryEl.className = "panel-summary";

         /* Signal underline: a level meter that pulses with the spike. */
         const signal = document.createElement("span");
         signal.className = "panel-signal";

         const detailEl = document.createElement("div");
         detailEl.className = "panel-detail";

         root.append(head, summaryEl, signal, detailEl);

         /* Notification cards carry an × close control (revealed on hover, since the
            resting card is faded back). Closing removes the notice (and, for a ringing
            alarm, dismisses it on DAWN via the composition root's handler). */
         if (n.closeable) {
            const close = document.createElement("button");
            close.className = "panel-close";
            close.type = "button";
            close.setAttribute("aria-label", `Close ${n.kind}`);
            close.textContent = "×";
            close.addEventListener("click", (e) => {
               e.stopPropagation();
               this.onClose?.(n.id);
            });
            root.appendChild(close);
         }

         this.field.appendChild(root);
         slot = { root, summaryEl, detailEl, metaEl, halfW: 120, halfH: 60 };
         this.slots.set(n.id, slot);
         this.measure(slot);
      }
      return slot;
   }

   /* Paint a pinned, side-docked card: flat (no perspective), always present,
      with richer kind-specific content (music progress, document list). */
   private paintPinned(n: RenderNode): void {
      const slot = this.dockSlotFor(n);
      slot.root.style.opacity = n.presence.toFixed(3);
      /* Rail order is user-set (drag); flex `order` lays them out accordingly. */
      slot.root.style.order = String(n.dockOrder ?? 0);

      const tone = n.tone === "attention" ? "alert" : "accent";
      slot.root.style.setProperty("--node-accent", `var(--${tone})`);
      slot.root.style.setProperty("--node-accent-glow", `var(--${tone}-glow)`);

      slot.metaEl.textContent = KIND_CODE[n.kind] ?? n.kind.slice(0, 3).toUpperCase();
      if (slot.titleEl.textContent !== n.summary) slot.titleEl.textContent = n.summary;
      const sub = n.detail ?? "";
      if (slot.subEl.textContent !== sub) slot.subEl.textContent = sub;

      /* Music progress bar. */
      if (n.progress !== undefined) {
         slot.progressFill.parentElement!.style.display = "";
         slot.progressFill.style.transform = `scaleX(${clamp01(n.progress).toFixed(3)})`;
      } else {
         slot.progressFill.parentElement!.style.display = "none";
      }

      /* Document/list rows. */
      if (n.items && n.items.length) {
         slot.listEl.style.display = "";
         const want = n.items.join("\n");
         if (slot.listEl.dataset.sig !== want) {
            slot.listEl.dataset.sig = want;
            slot.listEl.replaceChildren(
               ...n.items.map((it) => {
                  const li = document.createElement("li");
                  li.textContent = it;
                  return li;
               })
            );
         }
      } else {
         slot.listEl.style.display = "none";
      }
   }

   private dockSlotFor(n: RenderNode): DockSlot {
      let slot = this.dockSlots.get(n.id);
      const side = n.dock ?? "left";
      if (!slot) {
         const root = document.createElement("div");
         root.className = "dock-card";
         root.dataset.kind = n.kind;
         root.dataset.id = n.id; // read by the drag controller
         for (const c of ["tl", "tr", "bl", "br"]) {
            const corner = document.createElement("span");
            corner.className = `panel-corner ${c}`;
            root.appendChild(corner);
         }
         const head = document.createElement("div");
         head.className = "panel-head";
         const dot = document.createElement("span");
         dot.className = "panel-dot";
         const kindEl = document.createElement("span");
         kindEl.className = "panel-kind";
         kindEl.textContent = n.kind;
         const metaEl = document.createElement("span");
         metaEl.className = "panel-meta";
         head.append(dot, kindEl, metaEl);

         const titleEl = document.createElement("div");
         titleEl.className = "dock-title";
         const subEl = document.createElement("div");
         subEl.className = "dock-sub";

         const progress = document.createElement("div");
         progress.className = "dock-progress";
         const progressFill = document.createElement("span");
         progressFill.className = "dock-progress-fill";
         progress.appendChild(progressFill);

         const listEl = document.createElement("ul");
         listEl.className = "dock-list";

         root.append(head, titleEl, subEl, progress, listEl);

         /* A docked notification keeps its × close control (removes it, same as
            floating); dockOnly widgets (jobs card) have none. To return a docked
            notification to floating, drag it off the rails (PanelDrag reports it). */
         if (n.closeable) {
            const close = document.createElement("button");
            close.className = "dock-close";
            close.type = "button";
            close.setAttribute("aria-label", `Close ${n.kind}`);
            close.textContent = "×";
            close.addEventListener("click", () => this.onClose?.(n.id));
            root.appendChild(close);
         }

         (side === "right" ? this.rightRail : this.leftRail).appendChild(root);
         slot = { root, titleEl, subEl, metaEl, progressFill, listEl, side };
         this.dockSlots.set(n.id, slot);
      } else if (slot.side !== side) {
         /* Docked to the other side now: move it. */
         (side === "right" ? this.rightRail : this.leftRail).appendChild(slot.root);
         slot.side = side;
      }
      return slot;
   }

   /* Cache a slot's half-extent from layout. Called on create and on resize,
      never per frame, so it does not thrash layout. */
   private measure(slot: Slot): void {
      const w = slot.root.offsetWidth;
      const h = slot.root.offsetHeight;
      if (w > 0) slot.halfW = w / 2;
      if (h > 0) slot.halfH = h / 2;
   }
}

function clamp01(v: number): number {
   return v < 0 ? 0 : v > 1 ? 1 : v;
}
