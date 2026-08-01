/*
 * The choreography layer (brief S7.2). It turns state into target coordinates
 * over time and owns the rules that make many panels read as one living system:
 *
 *   - importance maps to a discrete depth tier (back / mid / front)
 *   - only ONE element holds the front at a time; the latest spike takes it
 *   - simultaneous spikes resolve into a paced sequence, not a flash mob (S9.1)
 *   - motion between tiers is eased on an abstract depth scalar (S9.3)
 *
 * It reads ElementState and writes RenderNodes. It decides WHERE things should
 * be; it does not draw. "Come forward" is a depth-target change here, nothing
 * more. Swap the renderer and every rule in this file still holds.
 *
 * On discrete-vs-continuous depth: the DECISION model is discrete tiers (logic
 * only ever names a tier). The continuous `depth` we ease is purely the visual
 * interpolation of that discrete target, and it lives here as a neutral scalar,
 * not as anything the renderer or the state layer reasons about.
 */

import { FEEL } from "../design/tokens.ts";
import type { ElementState } from "../state/types.ts";
import type { RenderNode } from "../render/renderer.ts";

/* The three depth tiers and their canonical abstract depth (0 far .. 1 near).
   Logic chooses a Tier; this table is the only place a tier becomes a scalar. */
const enum Tier {
   Back,
   Mid,
   Front
}
const TIER_DEPTH: Record<Tier, number> = {
   [Tier.Back]: 0.0,
   [Tier.Mid]: 0.52,
   [Tier.Front]: 1.0
};

/* Importance thresholds that map a signal onto a tier. Below `mid` an element
   sits back (quiet or invisible); at `front` it wants the front slot. */
const TIER_THRESHOLD = { mid: 0.8, front: 2.2 };

/* Floating (undocked) panels fade back a touch so docked cards read as the crisp
   foreground and floating ones sit behind them (user-requested depth). Applied to the
   resting state only: an actively spiking node (emphasis > 0) is exempted so a fresh
   "needs you" alert still comes forward at full strength. */
const FLOAT_DIM = 0.82;

function desiredTier(importance: number): Tier {
   if (importance >= TIER_THRESHOLD.front) return Tier.Front;
   if (importance >= TIER_THRESHOLD.mid) return Tier.Mid;
   return Tier.Back;
}

/* Per-element animated presentation, eased frame to frame. */
interface Node {
   depth: number;
   presence: number;
   emphasis: number;
   x: number;
   y: number;
}

export class Choreographer {
   private nodes = new Map<string, Node>();

   /* Contention (S9.1): who currently owns the single front slot, and how long
      they have held it. A held slot cannot be evicted until frontDwell elapses,
      which is what turns a burst of events into a graceful sequence. */
   private frontHolder: string | null = null;
   private frontHeld = 0;

   /* Attention budget (brief S3.3): when the user engages the input, the ambient
      field recedes so the exchange takes center. Eased so it breathes. */
   private engaged = false;
   private engageAmt = 0;

   private reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

   /*
    * Advance the choreography by dt seconds against the current state snapshot,
    * and return the RenderNodes for this frame. Pure function of (state, prior
    * node values, dt): no drawing, no DOM.
    */
   /* Called by the composition root when the user focuses/leaves the input. */
   setEngaged(engaged: boolean): void {
      this.engaged = engaged;
   }

   tick(state: readonly Readonly<ElementState>[], dt: number): RenderNode[] {
      this.engageAmt = this.reducedMotion
         ? this.engaged
            ? 1
            : 0
         : ease(this.engageAmt, this.engaged ? 1 : 0, 3, dt);
      this.arbitrateFront(state, dt);

      const out: RenderNode[] = [];
      for (const el of state) {
         /* Disabled from the menu: emit nothing, so it leaves the dashboard. */
         if (el.enabled === false) continue;

         /* Pinned elements dock to a side rail: fully present, calm, exempt from
            depth/contention. The renderer places them; we just pass content. */
         if (el.pinned) {
            const node = this.nodeFor(el);
            const target = 1;
            node.presence = this.reducedMotion
               ? target
               : ease(node.presence, target, FEEL.fadeEase, dt);
            node.depth = 1;
            node.emphasis = 0;
            out.push({
               id: el.id,
               kind: el.kind,
               summary: el.summary,
               detail: el.detail,
               x: el.position.x,
               y: el.position.y,
               depth: 1,
               presence: node.presence,
               emphasis: 0,
               tone: el.tone,
               pinned: true,
               dock: el.dock,
               dockOrder: el.dockOrder,
               dockOnly: el.dockOnly,
               progress: el.progress,
               items: el.items,
               closeable: el.closeable
            });
            continue;
         }

         let tier = desiredTier(el.importance);
         /* Lost the front contention: a node that wants front but is not the
            holder is clamped one tier back, so only the winner comes fully
            forward. This is the depth model doubling as the priority queue. */
         if (tier === Tier.Front && el.id !== this.frontHolder) {
            tier = Tier.Mid;
         }

         const node = this.nodeFor(el);
         const targetDepth = TIER_DEPTH[tier];
         const targetPresence = presenceFor(el.importance);
         const targetEmphasis =
            el.id === this.frontHolder ? emphasisFor(el.importance) : 0;

         if (this.reducedMotion) {
            node.depth = targetDepth;
            node.presence = targetPresence;
            node.emphasis = targetEmphasis;
            node.x = el.position.x;
            node.y = el.position.y;
         } else {
            node.depth = ease(node.depth, targetDepth, FEEL.depthEase, dt);
            node.presence = ease(node.presence, targetPresence, FEEL.fadeEase, dt);
            node.emphasis = ease(node.emphasis, targetEmphasis, FEEL.fadeEase, dt);
            /* Planar position eases too, so a future user-drag glides. */
            node.x = ease(node.x, el.position.x, FEEL.depthEase, dt);
            node.y = ease(node.y, el.position.y, FEEL.depthEase, dt);
         }

         /* Ambient field recedes while the user is engaged: dimmer and pushed
            back, so the exchange and reactor hold the attention (S3.3). */
         const dim = 1 - 0.72 * this.engageAmt;
         /* Floating depth fade, lifted back toward full as the node spikes (emphasis),
            so resting cards sit behind the docked foreground but an alert still pops. */
         const floatDim = FLOAT_DIM + (1 - FLOAT_DIM) * clamp01(node.emphasis);
         out.push({
            id: el.id,
            kind: el.kind,
            summary: el.summary,
            detail: el.detail,
            x: node.x,
            y: node.y,
            depth: node.depth * (1 - 0.5 * this.engageAmt),
            presence: node.presence * dim * floatDim,
            emphasis: node.emphasis * dim,
            tone: el.tone,
            pinned: false,
            closeable: el.closeable
         });
      }

      /* Drop nodes whose element vanished so the map does not grow forever. */
      if (this.nodes.size > state.length) {
         const live = new Set(state.map((e) => e.id));
         for (const id of this.nodes.keys()) {
            if (!live.has(id)) this.nodes.delete(id);
         }
      }
      return out;
   }

   /* Decide who holds the front slot this frame. */
   private arbitrateFront(state: readonly Readonly<ElementState>[], dt: number): void {
      this.frontHeld += dt;

      /* Candidates that currently want the front, strongest and most recent
         first. Recency (revision) breaks ties so the LATEST spike wins. */
      const wants = state
         .filter(
            (e) => e.enabled !== false && !e.pinned && desiredTier(e.importance) === Tier.Front
         )
         .sort((a, b) =>
            b.importance !== a.importance
               ? b.importance - a.importance
               : b.revision - a.revision
         );

      const holder = this.frontHolder
         ? state.find((e) => e.id === this.frontHolder)
         : undefined;
      const holderStillWants = holder && desiredTier(holder.importance) === Tier.Front;

      if (!holderStillWants) {
         /* Slot is free (holder receded or gone): the top candidate takes it
            immediately. No dwell gate on claiming an empty slot. */
         const next = wants[0]?.id ?? null;
         if (next !== this.frontHolder) {
            this.frontHolder = next;
            this.frontHeld = 0;
         }
         return;
      }

      /* Holder still wants the slot. A stronger, newer challenger may take it,
         but only after the holder has had its dwell: that pacing is what makes
         contention read as a sequence instead of a flicker. */
      const challenger = wants[0];
      if (
         challenger &&
         challenger.id !== this.frontHolder &&
         this.frontHeld >= FEEL.frontDwell
      ) {
         this.frontHolder = challenger.id;
         this.frontHeld = 0;
      }
   }

   private nodeFor(el: Readonly<ElementState>): Node {
      let n = this.nodes.get(el.id);
      if (!n) {
         /* Born at its resting depth so it does not fly in from the front on
            first appearance. */
         n = {
            depth: TIER_DEPTH[desiredTier(el.restImportance)],
            presence: presenceFor(el.restImportance),
            emphasis: 0,
            x: el.position.x,
            y: el.position.y
         };
         this.nodes.set(el.id, n);
      }
      return n;
   }
}

/* Frame-rate-independent exponential approach of `current` toward `target`. */
function ease(current: number, target: number, rate: number, dt: number): number {
   const k = 1 - Math.exp(-rate * dt);
   const next = current + (target - current) * k;
   return Math.abs(next - target) < 0.0005 ? target : next;
}

/* Importance -> overall presence (0..1). An event at rest (0) is faint; an
   ambient element (1) sits at a readable resting presence (its HUD frame keeps
   it legible even when the text is quiet); a spike (3) is full. */
function presenceFor(importance: number): number {
   return clamp01(0.2 + 0.34 * importance);
}

/* Importance above the front threshold -> spike emphasis (0..1 glow bloom). */
function emphasisFor(importance: number): number {
   return clamp01((importance - TIER_THRESHOLD.front) / (3 - TIER_THRESHOLD.front));
}

function clamp01(v: number): number {
   return v < 0 ? 0 : v > 1 ? 1 : v;
}
