// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { keepOutFloor, makeMovable, registerKeepOut } from "./movable.ts";
import { makeResizable } from "./resizable.ts";

/* Keep-outs (the menubar): no movable view is placed under one. jsdom has no layout, so each
   element's box is given by hand. */

beforeAll(() => {
   /* Records each observer's callback and targets, so a test can fire a size change. */
   class FakeObserver {
      targets: Element[] = [];
      constructor(readonly cb: () => void) {
         observers.add(this);
      }
      observe(t: Element): void {
         this.targets.push(t);
      }
      unobserve(): void {}
      disconnect(): void {
         observers.delete(this);
      }
   }
   Object.assign(globalThis, { ResizeObserver: FakeObserver });
});

const observers = new Set<{ targets: Element[]; cb: () => void }>();
/* Fires the size-change callbacks watching `el`. */
const resized = (el: Element): void => {
   for (const o of observers) if (o.targets.includes(el)) o.cb();
};

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

describe("more paths under a keep-out", () => {
   it("a top-corner resize of a view at its minimum height keeps the top below; the bottom moves", () => {
      menubar();
      /* A 300 x 360 view at (100, 28), already at its minimum height, left of the menubar. */
      const view = boxed(100, 28, 300, 360);
      Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
      vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => {
         f(0);
         return 1;
      });
      const r = makeResizable(view, {
         storageKey: "test.size3",
         minWidth: 200,
         minHeight: 360,
         defaultWidth: 300,
         defaultHeight: 360
      });
      cleanups.push(() => r.dispose());
      r.setEnabled(true);
      const grip = view.querySelector<HTMLElement>(".rs-ne")!;
      const at = (type: string, x: number, y: number) =>
         new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
      grip.dispatchEvent(at("pointerdown", 400, 28));
      window.dispatchEvent(at("pointermove", 600, 0)); // wider into 450..750, and up
      expect(parseFloat(view.style.top)).toBe(56);
      expect(parseFloat(view.style.height)).toBe(360);
      window.dispatchEvent(at("pointerup", 600, 0));
   });

   it("a view its caller placed (no saved spot) that grows into the column is lifted", () => {
      menubar();
      Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
      const card = document.createElement("div");
      document.body.appendChild(card);
      let width = 240;
      Object.defineProperty(card, "offsetWidth", { get: () => width, configurable: true });
      Object.defineProperty(card, "offsetHeight", { value: 120, configurable: true });
      card.getBoundingClientRect = () =>
         new DOMRect(parseFloat(card.style.left), parseFloat(card.style.top), width, 120);
      cleanups.push(makeMovable(card, { storageKey: "test.card", lockable: false }));
      /* Placed by its caller, as a notice's default spot is: clear of the menubar (190..430). */
      card.style.left = "190px";
      card.style.top = "28px";
      width = 304; // its actions widen it to 190..494, into 450..750
      resized(card);
      expect(card.style.left).toBe("190px");
      expect(card.style.top).toBe("56px");
   });

   it("a saved view that grows into the column is lifted even while hovered", () => {
      menubar();
      localStorage.setItem(
         "test.saved",
         JSON.stringify({ x: { a: "free", f: 0.15 }, y: { a: "lo" } })
      );
      Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
      const card = document.createElement("div");
      document.body.appendChild(card);
      let width = 240;
      Object.defineProperty(card, "offsetWidth", { get: () => width, configurable: true });
      Object.defineProperty(card, "offsetHeight", { value: 120, configurable: true });
      card.getBoundingClientRect = () =>
         new DOMRect(parseFloat(card.style.left), parseFloat(card.style.top), width, 120);
      cleanups.push(makeMovable(card, { storageKey: "test.saved", lockable: false }));
      resized(card); // its first real size: placed from the saved spot
      expect(card.style.left).toBe("192px"); // 0.15 of 1280, clear of 450..750
      Object.defineProperty(card, "matches", {
         value: (sel: string) => sel.includes(":hover"), // the pointer is on it
         configurable: true
      });
      width = 304; // an update adds actions: 192..496 reaches into 450..750
      resized(card);
      expect(card.style.left).toBe("192px");
      expect(card.style.top).toBe("56px");
      localStorage.removeItem("test.saved");
   });

   it("a view at its CSS default is lifted only while covered, then back to its default", () => {
      Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
      /* A readout docked by CSS to the top right (its default top 28): at 640..960. */
      const readout = document.createElement("div");
      document.body.appendChild(readout);
      Object.defineProperty(readout, "offsetWidth", { value: 320, configurable: true });
      Object.defineProperty(readout, "offsetHeight", { value: 280, configurable: true });
      readout.getBoundingClientRect = () =>
         new DOMRect(640, parseFloat(readout.style.top) || 28, 320, 280);
      cleanups.push(makeMovable(readout, { storageKey: "test.readout", lockable: false }));
      /* A narrow window: the centered menubar reaches it (450..750 over 640..960). */
      const bar = boxed(450, 24, 300, 26);
      const unregister = registerKeepOut(bar);
      expect(readout.style.top).toBe("56px");
      expect(readout.style.left).toBe(""); // its horizontal default stands
      /* Wider: the menubar no longer reaches it, and it goes back to its CSS default. */
      bar.getBoundingClientRect = () => new DOMRect(250, 24, 300, 26);
      resized(bar);
      expect(readout.style.top).toBe("");
      unregister();
   });
});
