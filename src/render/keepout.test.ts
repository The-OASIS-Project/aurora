// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { keepOutFloor, makeMovable, registerKeepOut } from "./movable.ts";
import { makeResizable } from "./resizable.ts";

/* Keep-outs (the menubar): no movable view is placed under one. jsdom has no layout, so each
   element's box is given by hand. */

beforeAll(() => {
   class NoopObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
   }
   Object.assign(globalThis, { ResizeObserver: NoopObserver });
});

const cleanups: Array<() => void> = [];
afterEach(() => {
   for (const c of cleanups.splice(0)) c();
   document.body.replaceChildren();
   vi.unstubAllGlobals();
});

/* An element with this box (left, top, width, height), shown or not. */
function boxed(
   left: number,
   top: number,
   width: number,
   height: number,
   shown = true
): HTMLElement {
   const el = document.createElement("div");
   document.body.appendChild(el);
   el.getBoundingClientRect = () => new DOMRect(left, top, width, height);
   el.getClientRects = () =>
      (shown ? [new DOMRect(left, top, width, height)] : []) as unknown as DOMRectList;
   return el;
}

/* A menubar across 450..750, from 24 to 50: views below it start at 56 (a 6 px gap). */
const menubar = (shown = true): HTMLElement => {
   const bar = boxed(450, 24, 300, 26, shown);
   cleanups.push(registerKeepOut(bar));
   return bar;
};

describe("the floor under a keep-out", () => {
   it("applies to a view whose span overlaps it, and only to one", () => {
      menubar();
      expect(keepOutFloor(400, 100)).toBe(56); // overlaps 450..500
      expect(keepOutFloor(700, 300)).toBe(56); // overlaps 700..750
      expect(keepOutFloor(100, 300)).toBe(-Infinity); // ends at 400
      expect(keepOutFloor(750, 200)).toBe(-Infinity); // starts at its right edge
   });

   it("doesn't apply while the keep-out isn't shown, or once it's unregistered", () => {
      menubar(false);
      expect(keepOutFloor(400, 300)).toBe(-Infinity);
      for (const c of cleanups.splice(0)) c();
      menubar();
      for (const c of cleanups.splice(0)) c();
      expect(keepOutFloor(400, 300)).toBe(-Infinity);
   });
});

describe("resizing from the top under a keep-out", () => {
   it("the top grip stops at the floor; the bottom stays put", () => {
      menubar();
      /* A 300 x 400 view at (500, 100): in the menubar's column. */
      const view = boxed(500, 100, 300, 400);
      Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
      vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => {
         f(0);
         return 1;
      });
      const r = makeResizable(view, {
         storageKey: "test.size",
         minWidth: 200,
         minHeight: 100,
         defaultWidth: 300,
         defaultHeight: 400
      });
      cleanups.push(() => r.dispose());
      r.setEnabled(true);
      const grip = view.querySelector<HTMLElement>(".rs-n")!;
      const at = (type: string, y: number) =>
         new MouseEvent(type, { bubbles: true, button: 0, clientX: 650, clientY: y });
      grip.dispatchEvent(at("pointerdown", 100));
      window.dispatchEvent(at("pointermove", 0)); // dragged up past the menubar
      expect(parseFloat(view.style.top)).toBe(56);
      expect(parseFloat(view.style.top) + parseFloat(view.style.height)).toBe(500); // bottom unmoved
      window.dispatchEvent(at("pointerup", 0));
   });

   it("a side grip widening the view into the column moves its top below, bottom put", () => {
      menubar();
      /* A 300 x 400 view at (100, 28), top-docked left of the menubar. */
      const view = boxed(100, 28, 300, 400);
      Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
      vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => {
         f(0);
         return 1;
      });
      const r = makeResizable(view, {
         storageKey: "test.size2",
         minWidth: 200,
         minHeight: 100,
         defaultWidth: 300,
         defaultHeight: 400
      });
      cleanups.push(() => r.dispose());
      r.setEnabled(true);
      const grip = view.querySelector<HTMLElement>(".rs-e")!;
      const at = (type: string, x: number) =>
         new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 200 });
      grip.dispatchEvent(at("pointerdown", 400));
      window.dispatchEvent(at("pointermove", 600)); // right edge to 600: into 450..750
      expect(parseFloat(view.style.top)).toBe(56);
      expect(parseFloat(view.style.top) + parseFloat(view.style.height)).toBe(428); // bottom put
      window.dispatchEvent(at("pointerup", 600));
   });
});

describe("registering a keep-out", () => {
   it("lifts a view restored under it before it existed, without moving it sideways", () => {
      localStorage.setItem(
         "test.pos",
         JSON.stringify({ x: { a: "free", f: 0.4 }, y: { a: "lo" } })
      );
      Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
      const view = document.createElement("div");
      document.body.appendChild(view);
      Object.defineProperty(view, "offsetWidth", { value: 300, configurable: true });
      Object.defineProperty(view, "offsetHeight", { value: 200, configurable: true });
      view.getBoundingClientRect = () =>
         new DOMRect(parseFloat(view.style.left) || 0, parseFloat(view.style.top) || 0, 300, 200);
      cleanups.push(makeMovable(view, { storageKey: "test.pos", lockable: false }));
      expect(view.style.left).toBe("512px"); // 0.4 of 1280
      expect(view.style.top).toBe("24px"); // the top gutter (24 without the stylesheet): no menubar yet
      menubar(); // 450..750 overlaps 512..812
      expect(view.style.left).toBe("512px");
      expect(view.style.top).toBe("56px");
      localStorage.removeItem("test.pos");
   });
});
