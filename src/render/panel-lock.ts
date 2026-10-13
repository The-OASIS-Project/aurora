/*
 * "Leave it where it is": a panel's position lock. Each movable view gets a small padlock in
 * its top-left corner, or inline where that corner holds a control (shown on hover or keyboard
 * focus; a locked panel's corner brackets brighten); a locked view can't be dragged or resized.
 * The Panels menu's "Lock all panels" locks every one at once. Both persist in this browser alongside the positions they protect (a layout choice for
 * this screen, like the positions themselves, so not wiped at logout).
 */

const ALL_KEY = "dawn.hero.panelsLocked";

let allLocked = read(ALL_KEY);
const listeners = new Set<() => void>();
const refreshers = new Set<() => void>();

/* Follow another tab's lock changes. */
if (typeof window !== "undefined") {
   window.addEventListener("storage", (e) => {
      if (e.key !== null && e.key !== ALL_KEY && !e.key.endsWith(".locked")) return;
      allLocked = read(ALL_KEY);
      for (const cb of refreshers) cb();
   });
}

function read(key: string): boolean {
   try {
      return localStorage.getItem(key) === "1";
   } catch {
      return false;
   }
}

function write(key: string, on: boolean): void {
   try {
      if (on) localStorage.setItem(key, "1");
      else localStorage.removeItem(key);
   } catch {
      /* blocked: this tab remembers it */
   }
}

export function arePanelsLocked(): boolean {
   return allLocked;
}

export function setPanelsLocked(on: boolean): void {
   if (on === allLocked) return;
   allLocked = on;
   write(ALL_KEY, on);
   for (const cb of listeners) cb();
}

const SVG = "http://www.w3.org/2000/svg";
/* A padlock: the body, plus a shackle that is closed or swung open. */
const SHACKLE_CLOSED = "M8 11V7a4 4 0 0 1 8 0v4";
const SHACKLE_OPEN = "M8 11V7a4 4 0 0 1 7.5-2";

export interface PanelLock {
   locked(): boolean;
   dispose(): void;
}

/* Add the padlock to a movable view. `storageKey` is the view's position key (its lock is kept
   beside it). By default it sits in the view's top-left corner; `slot` places it inline instead
   (a header whose left edge holds a control, or a readout with no header). */
export function mountPanelLock(el: HTMLElement, storageKey: string, slot?: (btn: HTMLButtonElement) => void): PanelLock {
   const ownKey = `${storageKey}.locked`;
   let own = read(ownKey);
   const locked = (): boolean => allLocked || own;

   const btn = document.createElement("button");
   btn.type = "button";
   btn.className = "movable-lock";
   const svg = document.createElementNS(SVG, "svg");
   svg.setAttribute("viewBox", "0 0 24 24");
   svg.setAttribute("aria-hidden", "true");
   const body = document.createElementNS(SVG, "rect");
   body.setAttribute("x", "5");
   body.setAttribute("y", "11");
   body.setAttribute("width", "14");
   body.setAttribute("height", "10");
   body.setAttribute("rx", "2");
   const shackle = document.createElementNS(SVG, "path");
   svg.append(body, shackle);
   btn.appendChild(svg);

   const sync = (): void => {
      const on = locked();
      el.classList.toggle("movable-locked", on);
      shackle.setAttribute("d", on ? SHACKLE_CLOSED : SHACKLE_OPEN);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.disabled = allLocked; // "Lock all" holds every panel; unlock it there
      const label = allLocked
         ? "All panels are locked (Panels menu)"
         : own
           ? "Unlock position"
           : "Lock position";
      btn.setAttribute("aria-label", label);
      btn.title = label;
   };

   const toggle = (): void => {
      if (allLocked) return;
      own = !own;
      write(ownKey, own);
      sync();
   };
   btn.addEventListener("click", toggle);
   el.classList.add("movable-lockable");
   if (slot) {
      btn.classList.add("movable-lock-inline");
      slot(btn);
   } else {
      el.appendChild(btn);
   }
   /* Another tab changed this panel's lock (or "Lock all"). */
   const refresh = (): void => {
      own = read(ownKey);
      sync();
   };
   listeners.add(sync);
   refreshers.add(refresh);
   sync();

   return {
      locked,
      dispose: (): void => {
         listeners.delete(sync);
         refreshers.delete(refresh);
         btn.removeEventListener("click", toggle);
         btn.remove();
         el.classList.remove("movable-locked", "movable-lockable");
      }
   };
}
