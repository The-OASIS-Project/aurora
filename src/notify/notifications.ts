/*
 * The notification layer. Notices (proactive alerts, ringing alarms, job/observation
 * toasts) are self-owned MOVABLE cards, positioned exactly like the music/calendar/HA
 * instruments: each is wrapped in makeMovable and registered in the shared snap set, so
 * it snaps to the viewport docks AND flush to the instruments (and they snap to it) with
 * the same preview bars, and its position persists.
 *
 * The twist (per the design): a notice behaves like an instrument only while SNAPPED.
 *   - Unsnapped (its default, and after a drag into a free band): a transient toast. It
 *     spikes in, holds, then either fades and auto-dismisses (a plain toast) or settles
 *     to a quiet dim float (a `persist` needs-you notice), staying until closed.
 *   - Snapped (dropped on a viewport dock or flush to a sibling): persistent, full
 *     presence, no fade, until the user closes it with the x.
 * makeMovable's onSnap tells the card which it is; the snapped flag persists per id.
 *
 * This lives OUTSIDE the store -> choreography -> render seam on purpose: makeMovable
 * owns pixel position, and a card cannot be positioned by both it and the choreographer.
 * The store still holds the jobs card and stub panels; notices route here instead.
 */

import { addCorners } from "../render/corners.ts";
import { makeMovable } from "../render/movable.ts";
import type { Notice, NotificationsSink } from "../ingest/ingest.ts";

const DEFAULT_HOLD = 6; // seconds a toast holds at full presence before it settles/fades
const FADE_MS = 1400; // fade-out duration for an auto-dismissing toast
const DEFAULT_EDGE = 28; // fallback default-position inset (matches --movable-edge)

interface Card {
   notice: Notice;
   root: HTMLElement;
   kindEl: HTMLElement;
   titleEl: HTMLElement;
   subEl: HTMLElement;
   listEl: HTMLElement;
   disposeMovable: () => void;
   snapped: boolean;
   hovered: boolean;
   holdTimer: number; // hold elapsed -> settle (fade or quiet)
   fadeTimer: number; // fade elapsed -> remove
}

export class Notifications implements NotificationsSink {
   private readonly cards = new Map<string, Card>();
   private readonly container: HTMLElement;
   /* User closed a notice with the x: propagate to DAWN (a ringing alarm needs a real
      dismiss). Auto-fade of a toast does NOT call this - it isn't a user dismissal. */
   private readonly onDismiss: (id: string) => void;

   constructor(container: HTMLElement, onDismiss: (id: string) => void) {
      this.container = container;
      this.onDismiss = onDismiss;
   }

   notify(notice: Notice): void {
      const existing = this.cards.get(notice.id);
      if (existing) this.update(existing, notice);
      else this.mount(notice);
   }

   remove(id: string): void {
      const c = this.cards.get(id);
      if (c) this.teardown(c);
   }

   /* HMR / unmount: drop every card and its makeMovable registration. */
   dispose(): void {
      for (const c of [...this.cards.values()]) this.teardown(c);
   }

   /* ---- storage keys ---- */
   private posKey(id: string): string {
      return `aurora.notice.${id}.pos`;
   }
   private snapKey(id: string): string {
      return `aurora.notice.${id}.snap`;
   }

   /* ---- mount / update / teardown ---- */

   private mount(notice: Notice): void {
      const root = document.createElement("div");
      root.className = "notice-card";
      addCorners(root);

      const head = document.createElement("div");
      head.className = "notice-head";
      const dot = document.createElement("span");
      dot.className = "notice-dot";
      const kindEl = document.createElement("span");
      kindEl.className = "notice-kind";
      head.append(dot, kindEl);
      /* A sticky status widget (jobs card) has no close control - it is shown/removed by
         its source, not dismissed by the user. */
      let close: HTMLButtonElement | null = null;
      if (!notice.sticky) {
         close = document.createElement("button");
         close.className = "notice-close";
         close.type = "button";
         close.setAttribute("aria-label", "Dismiss notification");
         close.textContent = "×"; // ×
         head.append(close);
      }

      const titleEl = document.createElement("div");
      titleEl.className = "notice-title";
      const subEl = document.createElement("div");
      subEl.className = "notice-sub";
      const listEl = document.createElement("ul");
      listEl.className = "notice-list";

      root.append(head, titleEl, subEl, listEl);
      this.container.appendChild(root);

      const card: Card = {
         notice,
         root,
         kindEl,
         titleEl,
         subEl,
         listEl,
         disposeMovable: () => {},
         snapped: localStorage.getItem(this.snapKey(notice.id)) === "1",
         hovered: false,
         holdTimer: 0,
         fadeTimer: 0
      };
      this.cards.set(notice.id, card);

      this.paint(card); // content first, so the default-position measure has real size
      this.placeDefault(card);

      card.disposeMovable = makeMovable(root, {
         storageKey: this.posKey(notice.id),
         ignore: ".notice-close",
         onSnap: (snapped) => this.onSnap(card, snapped)
      });

      close?.addEventListener("click", (e) => {
         e.stopPropagation();
         this.dismiss(card);
      });
      root.addEventListener("pointerenter", () => this.setHover(card, true));
      root.addEventListener("pointerleave", () => this.setHover(card, false));

      requestAnimationFrame(() => root.classList.add("notice-in"));
      /* Sticky widgets are always full-presence (no transient life); notices run the
         lifecycle for their snapped state. */
      if (notice.sticky) root.classList.add("notice-snapped");
      else if (card.snapped) this.applySnapped(card);
      else this.startTransient(card);
   }

   private update(card: Card, notice: Notice): void {
      card.notice = notice;
      this.paint(card);
      if (notice.sticky) return; // persistent widget: content updates, presence unchanged
      /* A fresh notice on the same channel re-spikes; snapped cards stay put and full,
         unsnapped ones restart their transient life (brought back from any fade/rest). */
      if (card.snapped) this.applySnapped(card);
      else this.startTransient(card);
   }

   private teardown(card: Card): void {
      this.clearTimers(card);
      card.disposeMovable();
      card.root.remove();
      this.cards.delete(card.notice.id);
   }

   /* User closed it: remove and tell DAWN (dismiss). The persisted position + snap flag
      are kept, so the next notice on this channel returns to the same spot. */
   private dismiss(card: Card): void {
      const id = card.notice.id;
      this.teardown(card);
      this.onDismiss(id);
   }

   /* ---- lifecycle ---- */

   private startTransient(card: Card): void {
      /* A sticky widget never goes transient - keep it full-presence. */
      if (card.notice.sticky) {
         this.clearTimers(card);
         card.root.classList.remove("notice-rest", "notice-leaving");
         card.root.classList.add("notice-snapped");
         return;
      }
      this.clearTimers(card);
      card.root.classList.remove("notice-snapped", "notice-rest", "notice-leaving");
      const hold = (card.notice.hold ?? DEFAULT_HOLD) * 1000;
      card.holdTimer = window.setTimeout(() => this.settle(card), hold);
   }

   private settle(card: Card): void {
      card.holdTimer = 0;
      if (card.hovered) return; // pointer holds it forward; resume on leave
      if (card.notice.persist) {
         /* Needs-you notice: recede to a quiet dim float, but stay until closed/docked. */
         card.root.classList.add("notice-rest");
      } else {
         this.fadeOut(card);
      }
   }

   private fadeOut(card: Card): void {
      card.root.classList.remove("notice-rest");
      card.root.classList.add("notice-leaving");
      card.fadeTimer = window.setTimeout(() => this.teardown(card), FADE_MS);
   }

   private applySnapped(card: Card): void {
      this.clearTimers(card);
      card.snapped = true;
      card.root.classList.remove("notice-rest", "notice-leaving");
      card.root.classList.add("notice-snapped");
   }

   private onSnap(card: Card, snapped: boolean): void {
      if (card.notice.sticky) return; // stays persistent wherever dropped (position persists)
      localStorage.setItem(this.snapKey(card.notice.id), snapped ? "1" : "0");
      if (snapped) {
         this.applySnapped(card);
      } else {
         card.snapped = false;
         card.root.classList.remove("notice-snapped");
         this.startTransient(card);
      }
   }

   private setHover(card: Card, on: boolean): void {
      card.hovered = on;
      if (on) {
         /* Pause any fade/settle and bring it back to full so it can be read and grabbed. */
         this.clearTimers(card);
         card.root.classList.remove("notice-leaving", "notice-rest");
      } else if (!card.snapped && !card.notice.sticky) {
         this.startTransient(card);
      }
   }

   /* ---- helpers ---- */

   private paint(card: Card): void {
      const { notice } = card;
      card.root.classList.toggle("notice-attention", notice.tone === "attention");
      const kind = (notice.kind || "notice").toUpperCase();
      if (card.kindEl.textContent !== kind) card.kindEl.textContent = kind;
      if (card.titleEl.textContent !== notice.summary) card.titleEl.textContent = notice.summary;
      const sub = notice.detail ?? "";
      card.subEl.style.display = sub ? "" : "none";
      if (card.subEl.textContent !== sub) card.subEl.textContent = sub;

      const items = notice.items ?? [];
      if (items.length) {
         card.listEl.style.display = "";
         const sig = items.join("\n");
         if (card.listEl.dataset.sig !== sig) {
            card.listEl.dataset.sig = sig;
            card.listEl.replaceChildren(
               ...items.map((it) => {
                  const li = document.createElement("li");
                  li.textContent = it;
                  return li;
               })
            );
         }
      } else {
         card.listEl.style.display = "none";
      }
   }

   /* Initial spot from the notice's abstract x/y (-1..1), used ONLY when the card has no
      persisted position yet. Once the user moves/snaps it, makeMovable's storage wins. */
   private placeDefault(card: Card): void {
      if (localStorage.getItem(this.posKey(card.notice.id))) return; // makeMovable restores it
      const W = window.innerWidth;
      const H = window.innerHeight;
      const r = card.root.getBoundingClientRect();
      const cw = r.width || 260;
      const ch = r.height || 96;
      const nx = (card.notice.x + 1) / 2;
      const ny = (card.notice.y + 1) / 2;
      const left = Math.round(DEFAULT_EDGE + nx * Math.max(0, W - cw - 2 * DEFAULT_EDGE));
      const top = Math.round(DEFAULT_EDGE + ny * Math.max(0, H - ch - 2 * DEFAULT_EDGE));
      card.root.style.left = `${left}px`;
      card.root.style.top = `${top}px`;
      card.root.style.right = "auto";
      card.root.style.bottom = "auto";
   }

   private clearTimers(card: Card): void {
      if (card.holdTimer) window.clearTimeout(card.holdTimer);
      if (card.fadeTimer) window.clearTimeout(card.fadeTimer);
      card.holdTimer = 0;
      card.fadeTimer = 0;
   }
}
