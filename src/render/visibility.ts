/*
 * Operator show/hide for a standalone view (the music player, calendar card, HA board),
 * persisted per machine. Defaults to SHOWN unless localStorage explicitly holds "false",
 * so a newly added view appears the first time rather than starting hidden. Pass
 * `defaultVisible: false` for a view that should be opt-in (e.g. the stocks panel, whose
 * financial data should not auto-appear). `offClass` is the class whose CSS hides the
 * element (display:none); toggling it is the whole behavior.
 */
export interface Visibility {
   isVisible(): boolean;
   setVisible(on: boolean): void;
}

export function makeVisibility(
   el: HTMLElement,
   opts: { storageKey: string; offClass: string; defaultVisible?: boolean }
): Visibility {
   const stored = localStorage.getItem(opts.storageKey);
   let visible = stored === null ? opts.defaultVisible !== false : stored !== "false";
   const apply = (): void => {
      el.classList.toggle(opts.offClass, !visible);
   };
   apply();
   return {
      isVisible: () => visible,
      setVisible: (on: boolean): void => {
         visible = on;
         localStorage.setItem(opts.storageKey, on ? "true" : "false");
         apply();
      }
   };
}
