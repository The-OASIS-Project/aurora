/*
 * onActivate: make a non-button element behave like a button for both pointer and
 * keyboard. Sets role="button" + tabindex and fires `fn` on click AND on Enter/Space
 * (with the Space default-scroll suppressed). The same role/tabindex/keydown idiom was
 * hand-rolled in css3d.ts, menu.ts, and ha-panel.ts; this is the one copy. Returns a
 * disposer that removes both listeners (for a component's destroy()).
 */
export function onActivate(el: HTMLElement, fn: (e: Event) => void): () => void {
   el.setAttribute("role", "button");
   if (!el.hasAttribute("tabindex")) el.tabIndex = 0;

   const onClick = (e: Event): void => fn(e);
   const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Enter" || e.key === " ") {
         e.preventDefault();
         fn(e);
      }
   };
   el.addEventListener("click", onClick);
   el.addEventListener("keydown", onKey);
   return () => {
      el.removeEventListener("click", onClick);
      el.removeEventListener("keydown", onKey);
   };
}
