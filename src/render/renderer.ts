/*
 * The coordinate seam (brief S7, "the load-bearing part").
 *
 * This file defines the ONLY contract between the choreography layer and the
 * render layer. Choreography WRITES RenderNodes in abstract coordinates; a
 * Renderer READS them and paints. Neither knows the other's internals. Swapping
 * CSS-3D for WebGL later means writing a new class that implements Renderer and
 * consumes the exact same RenderNode. Nothing above this line changes.
 *
 * The discipline that makes the swap free: every field here is abstract. `depth`
 * is 0..1, not translateZ pixels. `x`/`y` are roughly -1..1, not left/top. The
 * renderer decides what a pixel is; logic never does.
 */

import type { Tone } from "../state/types.ts";

/*
 * One element's fully-resolved presentation intent, in renderer-neutral units.
 * This is the abstract coordinate the whole architecture is built to protect.
 */
export interface RenderNode {
   id: string;
   kind: string;

   /* Content to show. The renderer owns how much of `detail` it reveals based
      on how far forward the node is; choreography just supplies both. */
   summary: string;
   detail?: string;

   /* Planar position, ~ -1..1, (0,0) center. */
   x: number;
   y: number;
   /* Depth, 0 = far/back, 1 = near/front. The priority axis. A CSS renderer
      maps this to translateZ + scale + blur; a WebGL renderer maps it to a
      camera-space Z. Same number, different paint. */
   depth: number;

   /* 0..1 overall presence. Drives opacity and how loudly the node shows. */
   presence: number;
   /* 0..1 extra emphasis on a fresh spike (glow bloom above resting presence).
      Separate from presence so a node can be fully visible yet not shouting. */
   emphasis: number;

   /* Cool vs warm. The renderer maps this to a palette token, not a literal. */
   tone: Tone;

   /* Pinned nodes dock to a side rail (flat, always present) instead of hovering
      in the depth field. `dock` picks the side; `progress`/`items` carry the
      richer pinned content (music now-playing, document lists). */
   pinned: boolean;
   dock?: "left" | "right";
   /* Order within the rail (the render layer maps it to flex order). */
   dockOrder?: number;
   /* Docked widget that cannot be unpinned (music/documents): the renderer omits
      its unpin control. */
   dockOnly?: boolean;
   progress?: number;
   items?: string[];
}

/*
 * The swappable layer (brief S7.3). Thin and dumb by design: it is handed a full
 * set of RenderNodes each frame and makes the screen match. It may keep its own
 * DOM/GPU bookkeeping, but it holds NO application logic and never decides what
 * is important or where things should go.
 */
export interface Renderer {
   /* Paint this frame's nodes. Called once per animation frame. */
   render(nodes: RenderNode[]): void;
   /* Viewport changed. */
   resize(width: number, height: number): void;
}
