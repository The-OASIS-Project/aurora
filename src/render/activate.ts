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
      /* Don't hijack Space/Enter typed into a nested editable (e.g. an inline-rename input
         inside an activatable row): the keystroke bubbles up here, and a preventDefault would
         eat the space or fire the row action mid-edit. Let the editable have its own keys. */
      const t = e.target as HTMLElement | null;
      if (t && t !== el && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) {
         return;
      }
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
