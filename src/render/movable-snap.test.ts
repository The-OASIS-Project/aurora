// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { allowXStop, resizeSnapTarget } from "./movable.ts";

/* A 1000-px-wide screen with the dead strip at 400..600, and a 300-px card. */
const strip: [number, number] = [400, 600];
const W = 300;

describe("snapping near the reactor's dead strip", () => {
   it("always allows a stop that keeps the card clear of the strip", () => {
      expect(allowXStop(50, W, 60, strip, false)).toBe(true); // left column
      expect(allowXStop(650, W, 640, strip, false)).toBe(true); // right column
      expect(allowXStop(50, W, 250, strip, false)).toBe(true); // already across: snapping out is fine
   });

   it("never pulls a card that is clear of the strip into it", () => {
      expect(allowXStop(150, W, 60, strip, false)).toBe(false); // right edge would land at 450
   });

   it("keeps edge snapping for a card already placed across the strip", () => {
      expect(allowXStop(160, W, 150, strip, false)).toBe(true); // a sibling edge, still across
      const wide = 500; // wider than the space beside the reactor: a screen-edge dock still crosses
      expect(allowXStop(24, wide, 60, strip, false)).toBe(true);
   });

   it("never uses the viewport-center column, which sits over the atom", () => {
      expect(allowXStop(350, W, 340, strip, true)).toBe(false);
   });

   it("a panel can snap with its center over the atom; a notice can't (its free-drop gesture)", () => {
      expect(allowXStop(380, W, 340, strip, false)).toBe(true); // center at 530: a panel's edge snap
      expect(allowXStop(380, W, 340, strip, false, true)).toBe(false); // a notice floats free there
   });
});

describe("snapping a resized edge", () => {
   const vp = { w: 1000, h: 800, edge: 24 };
   const neighbor = new DOMRect(600, 100, 300, 200); // left 600, right 900, top 100, bottom 300

   it("snaps a right edge flush against a neighbor, with the gap", () => {
      expect(resizeSnapTarget("right", 580, [neighbor], vp)).toEqual({ pos: 588, guide: 588, screen: false });
   });

   it("snaps a bottom edge flush above a neighbor, or level with its bottom", () => {
      expect(resizeSnapTarget("bottom", 95, [neighbor], vp).pos).toBe(88);
      expect(resizeSnapTarget("bottom", 310, [neighbor], vp).pos).toBe(300);
   });

   it("snaps to the screen edge", () => {
      expect(resizeSnapTarget("right", 970, [], vp)).toEqual({ pos: 976, guide: 976, screen: true });
   });

   it("leaves an edge alone when nothing is close", () => {
      expect(resizeSnapTarget("left", 400, [neighbor], vp)).toEqual({ pos: 400, guide: null, screen: false });
   });

   it("ignores a stop the size limits wouldn't let the edge reach", () => {
      expect(resizeSnapTarget("right", 580, [neighbor], vp, 24, [300, 560]).guide).toBeNull();
   });
});
