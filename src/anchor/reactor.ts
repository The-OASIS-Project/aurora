/* The center reactor, or nothing when this browser can't draw it. The reactor needs WebGL2
   (Three.js dropped WebGL1), which a browser can lack: a privacy-hardened browser that turns
   WebGL off, an extension or IT policy blocking it, or an older browser without WebGL2 (Safari
   before 15). (Hardware acceleration turned off isn't one: Chrome then renders WebGL in
   software.) Aurora then runs without its centerpiece instead
   of failing to start: everything else (the login, the conversation, the panels) works, and the
   composition root tells the user why the center is empty. */

import { Anchor, type Reactor } from "./anchor.ts";

export type { Reactor };

/* The stand-in when there is no reactor: every call does nothing. */
const NO_REACTOR: Reactor = {
   resize: () => {},
   setState: () => {},
   startBoot: () => {},
   setStarfield: () => {},
   setClouds: () => {},
   setBloom: () => {},
   setStandby: () => {},
   frame: () => {},
   dispose: () => {},
   setLevels: () => {},
   setStrain: () => {},
   setHesitation: () => {},
   onLiveChange: () => {}
};

/* Whether this browser gives out a WebGL2 context. Asked on a throwaway canvas, so a browser
   without one doesn't make Three.js log an error for what is a supported setup; the probe's context
   is handed straight back. */
function webgl2Available(): boolean {
   try {
      const gl = document.createElement("canvas").getContext("webgl2");
      if (!gl) return false;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return true;
   } catch {
      return false;
   }
}

/* The reactor on this canvas, and whether it is real. A context lost later on (a GPU reset, a
   driver update) is the Anchor's to report (onLiveChange): Three.js keeps it restorable and
   rebuilds its GPU state when the browser gives it back. */
export function createReactor(canvas: HTMLCanvasElement): { reactor: Reactor; live: boolean } {
   if (!webgl2Available()) return { reactor: NO_REACTOR, live: false };
   try {
      return { reactor: new Anchor(canvas), live: true };
   } catch {
      /* The context was refused after all (e.g. the browser hit its context limit): Three.js has
         logged why. */
      return { reactor: NO_REACTOR, live: false };
   }
}
