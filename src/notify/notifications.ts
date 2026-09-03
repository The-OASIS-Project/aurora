/*
 * The notification layer. Notices (proactive alerts, ringing alarms, job/observation
 * toasts, and the sticky jobs card) are self-owned MOVABLE cards, positioned exactly
 * like the music/calendar/HA instruments: each is wrapped in makeMovable and joins the
 * shared snap set, so it docks to the viewport edges and flush to the instruments (and
 * they snap to it), with the same preview bars, the central dead zone, and a persisted
 * position.
 *
 * A notice behaves like an instrument only while SNAPPED (or sticky):
 *   - Unsnapped (its default, and after a drag into free space): a transient card driven
 *     by an IMPORTANCE value that spikes on arrival and decays. Importance maps to DEPTH
 *     (translateZ + depth-of-field blur) + opacity, so an older / lower-priority notice
 *     recedes and blurs - you can see what is fading away. A toast recedes to nothing and
 *     is removed; a `persist` notice settles to a quiet receded float and stays.
 *   - Snapped / sticky: persistent, full presence, no recede, until closed (× ) or, for
 *     the sticky jobs card, removed by its source.
 *
 * Contention: among unsnapped notices only the strongest-and-newest holds the front; the
 * others are clamped one depth tier back, and a challenger only takes over after a dwell,
 * so a burst reads as a paced sequence in depth rather than a pile-up. Engagement: while
 * the chat input is focused, unsnapped notices dim and push back so the conversation
 * holds attention. Both are just extra inputs to the same depth model.
 *
 * X/Y is makeMovable's (left/top); Z/blur/opacity is this model's (transform/filter/
 * opacity). The two axes are orthogonal, so a card keeps its placement while it recedes.
 * This lives OUTSIDE the store -> choreography -> render seam: it is ticked directly from
 * the frame loop.
 */

import { addCorners } from "../render/corners.ts";
import { cssMovableEdge, makeMovable } from "../render/movable.ts";
import type { Notice, NotificationsSink } from "../ingest/ingest.ts";

const DEFAULT_HOLD = 6; // seconds a notice holds at peak before it begins to recede

/* Depth -> pixels (mirrors the css3d floating field, softened for a placed card: front
   sits at its natural size, receding pushes it back + blurs it). */
const PERSPECTIVE = 1100;
const Z_FRONT = 0;
const Z_BACK = -340;
const MAX_BLUR = 3.5; // px on a fully receded card (depth of field)

/* Depth tiers + importance thresholds + easing: the same values the choreographer used,
   so notices recede with the identical feel. */
const DEPTH_FRONT = 1.0;
const DEPTH_MID = 0.52;
const DEPTH_BACK = 0.0;
const FRONT_THRESHOLD = 2.2;
const MID_THRESHOLD = 0.8;
const FRONT_DWELL = 2.8; // seconds the front holder keeps the slot before a handoff
const DEPTH_EASE = 3.4;
const FADE_EASE = 4.0;
const ENGAGE_DIM = 0.72; // opacity cut on the ambient notices while the input is engaged
const ENGAGE_PUSH = 0.5; // depth pushed back by this fraction while engaged

const PEAK_ATTENTION = 3; // a warm needs-you notice spikes fully forward
const PEAK_NOMINAL = 2.4; // a cool notice still reaches the front tier, just under an alert
const REST_PERSIST = 1.0; // a persist notice settles to this ambient floor (mid depth, dim)
/* A toast recedes to a lower - but still VISIBLE and grabbable - floor (back tier, faint)
   rather than fading to nothing, so it is never lost while you're not watching. It is
   removed by a separate life timer, not by importance hitting zero. */
const REST_TOAST = 0.7;
const TOAST_LIFE = 60; // seconds an unattended toast lingers before removal; reset on hover
const MAX_PERSIST = 6; // un-snapped persist alerts kept live at once; beyond this the oldest is
// evicted, so a days-long session can't accumulate unbounded cards. Snapped/sticky cards are
// user-docked and exempt; toasts self-limit via their life timer.

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
   rev: number; // recency, bumped on each spike; breaks front-contention ties
   imp: number; // logical importance (decays)
   holdLeft: number; // seconds of plateau remaining before decay begins
   peak: number;
   rest: number; // importance floor it recedes to (REST_TOAST / REST_PERSIST)
   autoRemove: boolean; // a toast: removed when `life` runs out. persist/sticky never do.
   life: number; // seconds until an unattended toast is removed; reset on spawn/hover
   depth: number; // eased 0..1
   presence: number; // eased 0..1 (opacity before engagement dim)
   emphasis: number; // eased 0..1 (front-holder glow)
}

function clamp01(v: number): number {
   return v < 0 ? 0 : v > 1 ? 1 : v;
}
function ease(cur: number, target: number, rate: number, dt: number): number {
   const k = 1 - Math.exp(-rate * dt);
   const n = cur + (target - cur) * k;
   return Math.abs(n - target) < 0.0005 ? target : n;
}
function presenceFor(imp: number): number {
   return clamp01(0.2 + 0.34 * imp);
}
function tierDepth(imp: number): number {
   return imp >= FRONT_THRESHOLD ? DEPTH_FRONT : imp >= MID_THRESHOLD ? DEPTH_MID : DEPTH_BACK;
}
function emphasisFor(imp: number): number {
   return clamp01((imp - FRONT_THRESHOLD) / (3 - FRONT_THRESHOLD));
}

export class Notifications implements NotificationsSink {
   private readonly cards = new Map<string, Card>();
   private readonly container: HTMLElement;
   private readonly onDismiss: (id: string) => void;
   private readonly onAction: (id: string, action: string, value?: string) => void;
   private engaged = false;
   private engageAmt = 0; // eased 0..1
   private frontHolder: string | null = null;
   private frontHeld = 0;
   private rev = 0;
   /* Honor the OS reduced-motion setting like the anchor/choreographer: no depth slide or
      DOF blur, and no eased drift - notices settle to their target opacity directly. */
   private readonly reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

   constructor(
      container: HTMLElement,
      onDismiss: (id: string) => void,
      onAction: (id: string, action: string, value?: string) => void = () => {}
   ) {
      this.container = container;
      this.onDismiss = onDismiss;
      this.onAction = onAction;
   }

   notify(notice: Notice): void {
      const existing = this.cards.get(notice.id);
      if (existing) this.update(existing, notice);
      else this.mount(notice);
      if (notice.persist) this.capPersist();
   }

   /* Bound the un-snapped persist population. A persist alert recedes to a quiet float but never
      auto-removes (only a user dismiss does), so without a cap a days-long session accumulates
      unbounded cards (DOM + makeMovable + listeners) and scales the per-frame tick. Beyond
      MAX_PERSIST, evict the oldest un-snapped, un-hovered persist card. Snapped/sticky cards are
      user-docked (exempt); toasts self-limit via their life timer, so neither is counted. */
   private capPersist(): void {
      const live = [...this.cards.values()].filter(
         (c) => c.notice.persist && !c.snapped && !c.notice.sticky && !c.notice.critical
      );
      let overflow = live.length - MAX_PERSIST; // insertion order => live[0] is oldest
      for (const c of live) {
         if (overflow <= 0) break;
         if (c.hovered) continue; // don't yank a card the user is reading
         this.teardown(c);
         overflow--;
      }
   }

   remove(id: string): void {
      const c = this.cards.get(id);
      if (c) this.teardown(c);
   }

   /* Chat input focused/blurred: unsnapped notices dim + push back while engaged. */
   setEngaged(on: boolean): void {
      this.engaged = on;
   }

   /* HMR / unmount: drop every card and its makeMovable registration. */
   dispose(): void {
      for (const c of [...this.cards.values()]) this.teardown(c);
   }

   /* ---- per-frame model (called from the main frame loop) ---- */

   tick(dt: number): void {
      this.engageAmt = ease(this.engageAmt, this.engaged ? 1 : 0, 3, dt);
      this.arbitrateFront(dt);
      for (const card of [...this.cards.values()]) {
         if (this.exempt(card)) {
            /* Snapped / sticky: sit flat at full presence, no recede or dim. */
            card.depth = ease(card.depth, DEPTH_FRONT, DEPTH_EASE, dt);
            card.presence = ease(card.presence, 1, FADE_EASE, dt);
            card.emphasis = 0;
            this.applyVisual(card, 0);
            continue;
         }

         /* Decay importance: hovered holds it at peak; otherwise plateau then ease to
            the floor. */
         if (card.hovered) {
            card.imp = card.peak;
         } else if (card.holdLeft > 0) {
            card.holdLeft -= dt;
         } else {
            card.imp = ease(card.imp, card.rest, 1 / 3.4, dt); // ~3.4s exponential recede
         }

         /* Contention expressed in depth: a front-wanting non-holder is clamped a tier
            back. */
         let depthTarget = tierDepth(card.imp);
         if (card.imp >= FRONT_THRESHOLD && this.frontHolder !== card.notice.id) {
            depthTarget = Math.min(depthTarget, DEPTH_MID);
         }
         const presTarget = presenceFor(card.imp);
         const empTarget = this.frontHolder === card.notice.id ? emphasisFor(card.imp) : 0;

         card.depth = ease(card.depth, depthTarget, DEPTH_EASE, dt);
         card.presence = ease(card.presence, presTarget, FADE_EASE, dt);
         card.emphasis = ease(card.emphasis, empTarget, FADE_EASE, dt);
         /* Hovering a notice to read/grab it lifts the engagement dim so it's legible even
            while the chat input is focused. */
         this.applyVisual(card, card.hovered ? 0 : this.engageAmt);

         /* A toast lingers - receded but visible and grabbable - for TOAST_LIFE seconds,
            then leaves; hovering restarts that timer so it is never lost while unwatched.
            Persist/sticky cards have autoRemove=false and stay until closed. */
         if (card.autoRemove) {
            if (card.hovered) card.life = TOAST_LIFE;
            else card.life -= dt;
            if (card.life <= 0) this.teardown(card);
         }
      }
   }

   /* Decide the single front holder among unsnapped notices (strongest, then newest);
      the holder keeps the slot for a dwell so a burst resolves as a sequence. */
   private arbitrateFront(dt: number): void {
      this.frontHeld += dt;
      const wants = [...this.cards.values()]
         .filter((c) => !this.exempt(c) && c.imp >= FRONT_THRESHOLD)
         .sort((a, b) => (b.imp !== a.imp ? b.imp - a.imp : b.rev - a.rev));

      const holder = this.frontHolder ? this.cards.get(this.frontHolder) : undefined;
      const holderWants = !!holder && !this.exempt(holder) && holder.imp >= FRONT_THRESHOLD;

      if (!holderWants) {
         const next = wants[0]?.notice.id ?? null;
         if (next !== this.frontHolder) {
            this.frontHolder = next;
            this.frontHeld = 0;
         }
         return;
      }
      const challenger = wants[0];
      if (challenger && challenger.notice.id !== this.frontHolder) {
         /* A genuinely higher-severity notice (e.g. an attention alert over a nominal
            toast) preempts immediately; same-severity peers still wait out the dwell so a
            burst of equals reads as a paced sequence rather than a flicker. */
         const higherSeverity = !!holder && challenger.peak > holder.peak + 0.001;
         if (higherSeverity || this.frontHeld >= FRONT_DWELL) {
            this.frontHolder = challenger.notice.id;
            this.frontHeld = 0;
         }
      }
   }

   private applyVisual(card: Card, engageAmt: number): void {
      const depth = card.depth * (1 - ENGAGE_PUSH * engageAmt);
      const presence = clamp01(card.presence * (1 - ENGAGE_DIM * engageAmt));
      if (this.reducedMotion) {
         /* No depth slide or DOF blur: convey state through opacity alone. */
         card.root.style.transform = "";
         card.root.style.filter = "";
      } else {
         const z = Z_BACK + (Z_FRONT - Z_BACK) * depth;
         const blur = (1 - depth) * MAX_BLUR;
         card.root.style.transform = `perspective(${PERSPECTIVE}px) translateZ(${z.toFixed(1)}px)`;
         card.root.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "";
      }
      card.root.style.opacity = presence.toFixed(3);
      card.root.style.setProperty("--notice-glow", card.emphasis.toFixed(3));
      /* A near-invisible card must not swallow clicks meant for what's behind it (the old
         fading toast set pointer-events:none). Above the threshold it stays grabbable so a
         receded toast can still be hovered back. */
      card.root.style.pointerEvents = presence < 0.18 ? "none" : "";
   }

   private exempt(card: Card): boolean {
      return card.snapped || card.notice.sticky === true;
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
      /* Action buttons (a ringing alarm's Snooze/Dismiss) replace the plain close: an
         action carries the dismiss, so no redundant x. */
      const hasActions = !!notice.actions?.length;
      if (hasActions) root.classList.add("notice-has-actions"); // wider card for the action row
      let close: HTMLButtonElement | null = null;
      if (!notice.sticky && !hasActions) {
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

      /* Actions are fixed at mount: a notice's action set is immutable for its lifetime.
         update()/paint() do NOT reconcile them, because a given notice id never changes its
         action shape in practice (a scheduler event's type is fixed per event_id). The only
         theoretical exception - a missed replay (no actions) reusing an id that later rings
         live - degrades safely: the plain x rendered at that first mount still dismisses and
         stops the loop, just without the Snooze option. */
      let actionsEl: HTMLDivElement | null = null;
      if (hasActions) {
         actionsEl = document.createElement("div");
         actionsEl.className = "notice-actions";
         for (const a of notice.actions!) {
            /* Each action is a group: an optional value dropdown (e.g. snooze minutes) plus
               the button. The delegated click handler reads the group's select on fire. */
            const grp = document.createElement("span");
            grp.className = "notice-action-group";
            if (a.options?.length) {
               const sel = document.createElement("select");
               sel.className = "notice-action-select";
               for (const o of a.options) {
                  const opt = document.createElement("option");
                  opt.value = o.value;
                  opt.textContent = o.label;
                  if (o.value === a.defaultValue) opt.selected = true;
                  sel.append(opt);
               }
               grp.append(sel);
            }
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "notice-action";
            btn.dataset.action = a.id;
            btn.textContent = a.label;
            grp.append(btn);
            actionsEl.append(grp);
         }
      }

      root.append(head, titleEl, subEl, listEl);
      if (actionsEl) root.append(actionsEl);
      this.container.appendChild(root);

      const snapped = localStorage.getItem(this.snapKey(notice.id)) === "1";
      const peak = notice.tone === "attention" ? PEAK_ATTENTION : PEAK_NOMINAL;
      const card: Card = {
         notice,
         root,
         kindEl,
         titleEl,
         subEl,
         listEl,
         disposeMovable: () => {},
         snapped,
         hovered: false,
         rev: ++this.rev,
         imp: peak,
         holdLeft: notice.hold ?? DEFAULT_HOLD,
         peak,
         rest: notice.persist ? REST_PERSIST : REST_TOAST,
         autoRemove: !notice.persist && !notice.sticky,
         life: TOAST_LIFE,
         /* Born at the back and eased forward: the spike IS the entrance. Exempt cards
            (snapped/sticky) start at the front. */
         depth: this.exempt({ snapped, notice } as Card) ? DEPTH_FRONT : DEPTH_BACK,
         presence: this.exempt({ snapped, notice } as Card) ? 1 : 0.05,
         emphasis: 0
      };
      if (snapped) root.classList.add("notice-snapped");
      this.cards.set(notice.id, card);

      this.paint(card); // content first, so the default-position measure has real size
      this.placeDefault(card);
      this.applyVisual(card, 0); // set the initial (back) transform before first paint

      card.disposeMovable = makeMovable(root, {
         storageKey: this.posKey(notice.id),
         ignore: ".notice-close, .notice-action, .notice-action-select",
         onSnap: (s) => this.onSnap(card, s)
      });

      close?.addEventListener("click", (e) => {
         e.stopPropagation();
         this.dismiss(card);
      });
      actionsEl?.addEventListener("click", (e) => {
         const btn = (e.target as HTMLElement).closest<HTMLElement>(".notice-action");
         if (!btn?.dataset.action) return;
         e.stopPropagation();
         const sel = btn
            .closest(".notice-action-group")
            ?.querySelector<HTMLSelectElement>(".notice-action-select");
         this.act(card, btn.dataset.action, sel?.value);
      });
      root.addEventListener("pointerenter", () => (card.hovered = true));
      root.addEventListener("pointerleave", () => (card.hovered = false));
   }

   private update(card: Card, notice: Notice): void {
      card.notice = notice;
      this.paint(card);
      if (notice.sticky || card.snapped) return; // persistent: content updates, no re-spike
      this.spike(card); // a fresh notice on the channel comes forward again
   }

   /* Re-arm the spike: full importance, fresh plateau, fresh life timer, newest for
      contention. */
   private spike(card: Card): void {
      card.imp = card.peak;
      card.holdLeft = card.notice.hold ?? DEFAULT_HOLD;
      card.life = TOAST_LIFE;
      card.rev = ++this.rev;
   }

   private teardown(card: Card): void {
      if (this.frontHolder === card.notice.id) this.frontHolder = null;
      card.disposeMovable();
      card.root.remove();
      this.cards.delete(card.notice.id);
   }

   /* User closed it: remove and tell DAWN (dismiss). Position + snap flag are kept, so
      the next notice on this channel returns to the same spot. */
   private dismiss(card: Card): void {
      const id = card.notice.id;
      this.teardown(card);
      this.onDismiss(id);
   }

   /* User clicked a named action (a ringing alarm's Snooze/Dismiss): remove the card and
      report the action. Routed through onAction, NOT onDismiss, so it isn't double-handled. */
   private act(card: Card, action: string, value?: string): void {
      const id = card.notice.id;
      this.teardown(card);
      this.onAction(id, action, value);
   }

   private onSnap(card: Card, snapped: boolean): void {
      if (card.notice.sticky) return; // sticky stays persistent wherever dropped
      localStorage.setItem(this.snapKey(card.notice.id), snapped ? "1" : "0");
      card.snapped = snapped;
      card.root.classList.toggle("notice-snapped", snapped);
      if (!snapped) this.spike(card); // undocked -> comes forward, then recedes as a toast
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
      const edge = cssMovableEdge(); // same inset makeMovable docks to (the --movable-edge token)
      /* Cascade: cards born at the SAME spawn origin (a burst of alerts) fan down-and-right by a
         step each, so they don't render exactly on top of one another. Bounded by a wrap so a
         long burst can't march off-screen; count only current, un-placed same-origin cards, so
         the cascade self-limits as older toasts fade. */
      let cohort = 0;
      for (const other of this.cards.values()) {
         if (other === card) continue;
         if (other.notice.x === card.notice.x && other.notice.y === card.notice.y && !localStorage.getItem(this.posKey(other.notice.id))) cohort++;
      }
      const cascade = (cohort % 6) * 18;
      /* Clamp AFTER adding the cascade so a burst can't push a card past the docking inset /
         off-screen (the base term alone is clamped; the +cascade would escape it). */
      const left = Math.min(Math.round(edge + nx * Math.max(0, W - cw - 2 * edge)) + cascade, Math.max(edge, W - cw - edge));
      const top = Math.min(Math.round(edge + ny * Math.max(0, H - ch - 2 * edge)) + cascade, Math.max(edge, H - ch - edge));
      card.root.style.left = `${left}px`;
      card.root.style.top = `${top}px`;
      card.root.style.right = "auto";
      card.root.style.bottom = "auto";
   }
}
