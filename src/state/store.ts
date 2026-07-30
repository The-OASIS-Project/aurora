/*
 * The state store (brief S7.1). Holds element data and the rules for how a raw
 * signal becomes state: spike() raises importance, tick() decays it back toward
 * the floor. That is the whole "spike then recede" behavior expressed as pure
 * data evolution, with no idea how it looks. The choreography layer reads this
 * and decides depth; the render layer never sees it.
 *
 * It is intentionally not an event emitter. main.ts pulls the current snapshot
 * each frame and hands it to choreography. A dashboard ticking at 60fps has no
 * use for change-notification plumbing; polling the snapshot is simpler and has
 * no ordering surprises.
 */

import type { ElementState } from "./types.ts";

/* Sort pinned elements by their rail order. */
function byOrder(a: ElementState, b: ElementState): number {
   return (a.dockOrder ?? 0) - (b.dockOrder ?? 0);
}

export class Store {
   private elements = new Map<string, ElementState>();
   private revision = 0;
   /* Seconds each spiked element holds at peak before it begins to recede, so a
      pop-up lingers long enough to actually read (the plateau). Keyed by id. */
   private holds = new Map<string, number>();
   /* Elements the pointer is currently over: held forward (decay paused) so a
      receding notice can be brought back and read without dismissing it. */
   private hovered = new Set<string>();

   /* Insert or replace an element. Ingest builds these; nothing here inspects
      visuals. Defaults keep call sites terse. */
   upsert(el: Partial<ElementState> & Pick<ElementState, "id" | "kind">): void {
      const existing = this.elements.get(el.id);
      const merged: ElementState = {
         summary: "",
         importance: 0,
         restImportance: 0,
         position: { x: 0, y: 0 },
         tone: "nominal",
         pinned: false,
         revision: ++this.revision,
         ...existing,
         ...el
      };
      this.elements.set(el.id, merged);
   }

   /*
    * A relevant event happened to this element: push importance up to `to`
    * (default alert) and bump revision so it wins recency tiebreaks. This is
    * the ONLY thing an event does at the state layer. How far forward that
    * moves it, and whether it beats a competing spike, is choreography's call.
    */
   spike(id: string, to = 3, tone?: ElementState["tone"], hold = 4): void {
      const el = this.elements.get(id);
      if (!el) return;
      el.importance = Math.max(el.importance, to);
      el.revision = ++this.revision;
      if (tone) el.tone = tone;
      /* Hold at peak for `hold` seconds before the recede begins. */
      this.holds.set(id, Math.max(this.holds.get(id) ?? 0, hold));
   }

   /*
    * Toggle whether an element is pinned to a side rail. On pin it docks to the
    * side its floating position leans toward; on unpin it returns to the field.
    * `dockOnly` widgets (music/documents) never toggle. This is what a click on a
    * panel resolves to: the render layer reports the click, the store decides what
    * pinning means.
    */
   /*
    * Pointer entered/left a floating element. While hovered it is pulled to the
    * front (importance up to the alert tier) and held there — tick() skips its
    * decay — so a notice mid-recede returns and stays readable until the pointer
    * leaves, at which point it resumes receding. Distinct from a spike: no plateau
    * timer, it simply tracks the pointer.
    */
   setHovered(id: string, on: boolean): void {
      const el = this.elements.get(id);
      if (!el) return;
      if (on) {
         this.hovered.add(id);
         el.importance = Math.max(el.importance, 3); // alert tier — bring to front
         el.revision = ++this.revision;
      } else {
         this.hovered.delete(id);
      }
   }

   /* Show/hide an element (menu toggle). Undefined/true -> hidden; false -> shown. */
   toggleEnabled(id: string): void {
      const el = this.elements.get(id);
      if (!el) return;
      el.enabled = el.enabled === false;
      el.revision = ++this.revision;
   }

   togglePin(id: string): void {
      const el = this.elements.get(id);
      if (!el || el.dockOnly) return;
      el.pinned = !el.pinned;
      if (el.pinned) {
         el.dock = el.position.x < 0 ? "left" : "right";
         /* Append to the end of that rail. */
         el.dockOrder = this.pinnedOn(el.dock, id).length;
      } else {
         el.dock = undefined;
         el.dockOrder = undefined;
      }
      el.revision = ++this.revision;
   }

   /*
    * Dock an element to `side` at `index` (the user dragged it there). PINS it if
    * it was floating, so a floating panel dragged onto a rail lands pinned. The
    * target rail is renumbered with the element inserted at `index`; the rail it
    * left is renumbered too, so every rail's orders stay contiguous. Works for
    * dockOnly widgets as well: they can be rearranged, just not unpinned.
    */
   dockTo(id: string, side: "left" | "right", index: number): void {
      const el = this.elements.get(id);
      if (!el) return;
      const from = el.pinned ? el.dock : undefined;
      el.pinned = true;
      el.dock = side;

      const target = this.pinnedOn(side, id).sort(byOrder);
      target.splice(Math.max(0, Math.min(index, target.length)), 0, el);
      target.forEach((e, i) => (e.dockOrder = i));

      if (from && from !== side) {
         this.pinnedOn(from, id).sort(byOrder).forEach((e, i) => (e.dockOrder = i));
      }
      el.revision = ++this.revision;
   }

   /* Pinned elements docked to `side`, excluding `exceptId`. */
   private pinnedOn(side: "left" | "right", exceptId?: string): ElementState[] {
      const out: ElementState[] = [];
      for (const e of this.elements.values()) {
         if (e.pinned && e.dock === side && e.id !== exceptId) out.push(e);
      }
      return out;
   }

   /*
    * Advance time by dt seconds: every element's importance eases toward its
    * floor. Exponential decay reads as a natural recede. restImportance is the
    * floor a persistent element never drops below, so persistent things settle
    * at their ambient summary while event things fade to invisible.
    */
   tick(dt: number): void {
      const k = 1 - Math.exp(-dt / 3.4); // ~3.4s recede: a slow, graceful drift
      for (const el of this.elements.values()) {
         if (this.hovered.has(el.id)) continue; // held forward under the pointer
         if (el.importance > el.restImportance) {
            /* Hold at peak first (the plateau), then recede. */
            const hold = this.holds.get(el.id) ?? 0;
            if (hold > 0) {
               const next = hold - dt;
               if (next <= 0) this.holds.delete(el.id);
               else this.holds.set(el.id, next);
               continue;
            }
            el.importance += (el.restImportance - el.importance) * k;
            if (el.importance - el.restImportance < 0.001) {
               el.importance = el.restImportance;
            }
         }
      }
   }

   /*
    * Remove an element and its transient hold. The real ingest calls this when a
    * source drops.
    *
    * Identity model: the ingest reuses ONE element id per kind (calendar, email,
    * homeassistant, subsystems, music, documents), so `elements`/`holds` are
    * bounded for the process lifetime. If a future ingest mints a distinct id per
    * item (per email or per HA entity), it MUST evict here (or on a TTL), or the
    * maps grow without bound on a 24/7 display.
    */
   remove(id: string): void {
      this.elements.delete(id);
      this.holds.delete(id);
      this.hovered.delete(id);
   }

   /* Current snapshot. Returns the live objects as readonly; consumers read,
      never mutate (the choreographer honors this). */
   snapshot(): readonly Readonly<ElementState>[] {
      return [...this.elements.values()];
   }

   get(id: string): ElementState | undefined {
      return this.elements.get(id);
   }
}
