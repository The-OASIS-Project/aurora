/*
 * Top-centre menu bar: the settings surface (brief S5 / S12.2 enable-disable
 * set). Fills the unused top-centre and lets the user toggle which panels the
 * dashboard shows (Panels) and which visual layers render (Display). Chrome, like
 * the HUD, so it lives outside the render seam and only reports intent; the store
 * and the anchor decide.
 */

import type { LlmMode, LlmProvider, ModelControl, Reasoning } from "../model/model.ts";

export interface MenuPanel {
   id: string;
   label: string;
   enabled: boolean;
}

/* A generic on/off setting (Display menu): reads and flips live state. */
export interface MenuToggle {
   label: string;
   get: () => boolean;
   toggle: () => void;
}

/* A stepped slider setting (Display menu): a discrete ladder of values with a live
   readout. `value`/`onChange` speak the real value (e.g. 1.05); `steps` is the ordered
   ladder the range input indexes into. `reset` returns to the neutral default. */
export interface MenuSlider {
   label: string;
   steps: readonly number[];
   get: () => number;
   format: (v: number) => string;
   onChange: (v: number) => void;
   reset: () => void;
}

export interface MenuOptions {
   getPanels: () => MenuPanel[];
   onTogglePanel: (id: string) => void;
   displayToggles: MenuToggle[];
   /* Optional stepped slider appended below the Display toggles (e.g. text/UI size). */
   displaySlider?: MenuSlider;
   /* System menu actions: open the Connection, Microphone, and About dialogs. Optional; a
      missing one renders its row as an inert stub. */
   onConnection?: () => void;
   onMicDevice?: () => void;
   onAbout?: () => void;
   /* LLM selection surface (MODEL menu). Optional. */
   model?: ModelControl;
}

export interface MenuController {
   destroy: () => void;
}

interface ToggleRow {
   label: string;
   checked: boolean;
   onChange: () => void;
}

export function mountMenu(root: HTMLElement, opts: MenuOptions): MenuController {
   const bar = document.createElement("nav");
   bar.id = "menubar";
   bar.setAttribute("aria-label", "Dashboard settings");

   /* Close every open dropdown. Query-based so action rows can call it too. */
   const closeAll = (): void =>
      bar.querySelectorAll<HTMLElement>(".menu-group.open").forEach((g) => g.classList.remove("open"));

   const panels = toggleMenu("Panels", () =>
      opts.getPanels().map((p) => ({
         label: p.label,
         checked: p.enabled,
         onChange: () => opts.onTogglePanel(p.id)
      }))
   );
   const display = displayMenu(
      () =>
         opts.displayToggles.map((t) => ({
            label: t.label,
            checked: t.get(),
            onChange: () => t.toggle()
         })),
      opts.displaySlider
   );
   /* System: the Connection, Microphone, and About dialogs (each active when wired).
      New Chat now lives in the conversation picker's header. */
   const system = actionMenu(
      "System",
      () => [
         { label: "Connection", onClick: opts.onConnection },
         { label: "Microphone", onClick: opts.onMicDevice },
         { label: "About D.A.W.N.", onClick: opts.onAbout }
      ],
      closeAll
   );

   const groups: { el: HTMLElement; refresh: () => void; onOpen?: () => void }[] = [panels, display];
   if (opts.model) groups.push(modelMenu(opts.model));
   groups.push(system);
   bar.append(...groups.map((g) => g.el));
   root.appendChild(bar);

   const onBarClick = (e: Event): void => {
      const group = (e.target as HTMLElement).closest<HTMLElement>(".menu-group");
      const btn = (e.target as HTMLElement).closest(".menu-btn");
      if (!group || !btn) return;
      const wasOpen = group.classList.contains("open");
      closeAll();
      if (!wasOpen) {
         group.classList.add("open");
         groups.forEach((g) => g.refresh()); // reflect current state
         groups.find((g) => g.el === group)?.onOpen?.(); // e.g. re-fetch the model list
      }
   };
   bar.addEventListener("click", onBarClick);

   /* Close on mousedown, not click: the MODEL panel rebuilds its rows during a
      change click, which detaches the clicked control before a document-level
      click handler would run, and `bar.contains` on a detached node reads as
      "outside" and closes the menu. mousedown fires before any such rebuild. */
   const onDocDown = (e: Event): void => {
      if (!bar.contains(e.target as Node)) closeAll();
   };
   document.addEventListener("mousedown", onDocDown);

   return {
      destroy: () => {
         document.removeEventListener("mousedown", onDocDown);
         bar.remove();
      }
   };
}

/* A menu whose dropdown is a list of checkbox rows, rebuilt from `getRows`. */
function toggleMenu(
   title: string,
   getRows: () => ToggleRow[]
): { el: HTMLElement; refresh: () => void } {
   const { el, dropdown } = menuGroup(title);
   const refresh = (): void => {
      dropdown.replaceChildren(
         ...getRows().map((r) => {
            const row = document.createElement("label");
            row.className = "menu-row";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.className = "menu-check";
            cb.checked = r.checked;
            cb.addEventListener("change", r.onChange);
            const span = document.createElement("span");
            span.textContent = r.label;
            row.append(cb, span);
            return row;
         })
      );
   };
   refresh();
   return { el, refresh };
}

/* The Display menu: the visual-layer toggles plus an optional stepped slider (text/UI
   size) below a divider. Like toggleMenu but with the extra control kind. */
function displayMenu(
   getRows: () => ToggleRow[],
   slider?: MenuSlider
): { el: HTMLElement; refresh: () => void } {
   const { el, dropdown } = menuGroup("Display");
   const refresh = (): void => {
      const rows: HTMLElement[] = getRows().map((r) => {
         const row = document.createElement("label");
         row.className = "menu-row";
         const cb = document.createElement("input");
         cb.type = "checkbox";
         cb.className = "menu-check";
         cb.checked = r.checked;
         cb.addEventListener("change", r.onChange);
         const span = document.createElement("span");
         span.textContent = r.label;
         row.append(cb, span);
         return row;
      });
      if (slider) {
         const divider = document.createElement("div");
         divider.className = "menu-divider";
         rows.push(divider, sliderRow(slider));
      }
      dropdown.replaceChildren(...rows);
   };
   refresh();
   return { el, refresh };
}

/* A labelled stepped-slider row: label, a range input snapped to the ladder, and a
   live readout that doubles as a reset-to-default control (click / Enter). */
function sliderRow(s: MenuSlider): HTMLElement {
   const row = document.createElement("div");
   row.className = "menu-row menu-slider-row";

   const lbl = document.createElement("span");
   lbl.className = "menu-slider-label";
   lbl.textContent = s.label;

   const range = document.createElement("input");
   range.type = "range";
   range.className = "menu-slider";
   range.min = "0";
   range.max = String(s.steps.length - 1);
   range.step = "1";
   /* Nearest ladder index for the current value (tolerates a value off the ladder). */
   const idxOf = (v: number): number => {
      let best = 0;
      let bestD = Infinity;
      s.steps.forEach((step, i) => {
         const d = Math.abs(step - v);
         if (d < bestD) {
            best = i;
            bestD = d;
         }
      });
      return best;
   };

   const readout = document.createElement("button");
   readout.type = "button";
   readout.className = "menu-slider-val";
   readout.title = "Reset to default";

   const paint = (v: number): void => {
      range.value = String(idxOf(v));
      readout.textContent = s.format(v);
   };
   paint(s.get());

   range.addEventListener("input", () => {
      const v = s.steps[Number(range.value)];
      readout.textContent = s.format(v);
      s.onChange(v);
   });
   readout.addEventListener("click", (e) => {
      e.preventDefault();
      s.reset();
      paint(s.get());
   });

   row.append(lbl, range, readout);
   return row;
}

/* A menu of rows that are either clickable actions (onClick set) or inert stubs.
   An action closes the menu after firing. */
interface ActionRow {
   label: string;
   onClick?: () => void;
}

function actionMenu(
   title: string,
   getRows: () => ActionRow[],
   close: () => void
): { el: HTMLElement; refresh: () => void } {
   const { el, dropdown } = menuGroup(title);
   const refresh = (): void => {
      dropdown.replaceChildren(
         ...getRows().map((r) => {
            const row = document.createElement("div");
            if (r.onClick) {
               row.className = "menu-row menu-row-action";
               row.setAttribute("role", "button");
               row.tabIndex = 0;
               const fire = (): void => {
                  r.onClick!();
                  close();
               };
               row.addEventListener("click", fire);
               row.addEventListener("keydown", (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                     e.preventDefault();
                     fire();
                  }
               });
            } else {
               row.className = "menu-row menu-row-stub";
            }
            row.textContent = r.label;
            return row;
         })
      );
   };
   refresh();
   return { el, refresh };
}

/* The MODEL panel: a richer dropdown of segmented controls + a model select + a
   privacy toggle. Rebuilt from the control's state on open and on any change push. */
function modelMenu(ctrl: ModelControl): { el: HTMLElement; refresh: () => void; onOpen: () => void } {
   const { el, dropdown } = menuGroup("Model");
   dropdown.classList.add("model-panel");

   const build = (): void => {
      const s = ctrl.getState();
      const rows: HTMLElement[] = [];
      rows.push(
         segmented("Mode", [["local", "Local"], ["cloud", "Cloud"]], s.mode, (v) =>
            ctrl.setMode(v as LlmMode)
         )
      );
      if (s.mode === "cloud") {
         rows.push(
            segmented(
               "Provider",
               [
                  ["openai", "OpenAI"],
                  ["claude", "Claude"],
                  ["gemini", "Gemini"],
                  ["openrouter", "OpenRouter"]
               ],
               s.provider,
               (v) => ctrl.setProvider(v as LlmProvider),
               { enabled: (v) => s.providers[v as LlmProvider] }
            )
         );
      }
      rows.push(modelSelect(s.models, s.model, (v) => ctrl.setModel(v)));
      rows.push(
         segmented(
            "Reasoning",
            [["disabled", "Off"], ["enabled", "On"]],
            s.reasoning,
            (v) => ctrl.setReasoning(v as Reasoning)
         )
      );
      const effortOff = s.reasoning === "disabled";
      rows.push(
         segmented(
            "Effort",
            s.effortOptions.map((o) => [o, cap(o)] as [string, string]),
            s.effort,
            (v) => ctrl.setEffort(v),
            { allDisabled: effortOff }
         )
      );
      const divider = document.createElement("div");
      divider.className = "model-divider";
      rows.push(divider);
      rows.push(privacyToggle(s.isPrivate, (on) => ctrl.setPrivate(on)));
      dropdown.replaceChildren(...rows);
   };

   ctrl.onChange(() => {
      if (el.classList.contains("open")) build();
   });
   /* On open, re-fetch the LLM config so a backend model-list edit shows up without a
      page reload (the response fires onChange -> build). */
   return { el, refresh: build, onOpen: () => ctrl.refreshModels?.() };
}

/* A labelled segmented control: one active option, the rest selectable (or dimmed
   when unavailable / all disabled). */
function segmented(
   label: string,
   options: [string, string][],
   current: string,
   onSelect: (value: string) => void,
   opts: { enabled?: (value: string) => boolean; allDisabled?: boolean } = {}
): HTMLElement {
   const row = document.createElement("div");
   row.className = "model-row";
   const lbl = document.createElement("span");
   lbl.className = "model-label";
   lbl.textContent = label;
   const seg = document.createElement("div");
   seg.className = "model-seg";
   for (const [value, text] of options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "model-seg-btn";
      btn.textContent = text;
      const off = opts.allDisabled || (opts.enabled ? !opts.enabled(value) : false);
      if (value === current) btn.classList.add("active");
      if (off) {
         btn.disabled = true;
         btn.classList.add("off");
      } else {
         btn.addEventListener("click", () => onSelect(value));
      }
      seg.appendChild(btn);
   }
   row.append(lbl, seg);
   return row;
}

/* The model dropdown (long lists). A custom on-theme control (a native <select> renders an
   OS-styled option list that breaks the design); shows the current value even if it is not
   in the available list yet (state can arrive before the list). Keyboard: Enter/Space/Down
   opens, Up/Down move, Enter selects, Esc closes; a mousedown outside closes. Selecting fires
   onSelect, which rebuilds the whole panel, so this control is short-lived - no teardown
   beyond the open-only document listener it removes on close. */
function modelSelect(options: string[], current: string, onSelect: (value: string) => void): HTMLElement {
   const row = document.createElement("div");
   row.className = "model-row";
   const lbl = document.createElement("span");
   lbl.className = "model-label";
   lbl.textContent = "Model";

   const dd = document.createElement("div");
   dd.className = "model-dd";
   const btn = document.createElement("button");
   btn.type = "button";
   btn.className = "model-dd-btn";
   btn.setAttribute("aria-haspopup", "listbox");
   btn.setAttribute("aria-expanded", "false");
   const valEl = document.createElement("span");
   valEl.className = "model-dd-value";
   const caret = document.createElement("span");
   caret.className = "model-dd-caret";
   caret.textContent = "▾"; // ▾
   btn.append(valEl, caret);
   dd.appendChild(btn);

   const values = options.includes(current) || !current ? options : [current, ...options];
   if (values.length === 0) {
      valEl.textContent = "—"; // —
      btn.disabled = true;
      row.append(lbl, dd);
      return row;
   }
   valEl.textContent = current || values[0];

   const list = document.createElement("ul");
   list.className = "model-dd-list";
   list.setAttribute("role", "listbox");
   list.hidden = true;
   const opts: HTMLElement[] = values.map((v, i) => {
      const li = document.createElement("li");
      li.className = "model-dd-opt";
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", v === current ? "true" : "false");
      if (v === current) li.classList.add("selected");
      li.textContent = v; // model string is trusted config text, but bind as text regardless
      li.dataset.index = String(i);
      list.appendChild(li);
      return li;
   });
   dd.appendChild(list);

   let open = false;
   let active = Math.max(0, values.indexOf(current));
   let onDocDown: ((e: Event) => void) | null = null;

   const setActive = (i: number): void => {
      active = (i + values.length) % values.length;
      opts.forEach((o, idx) => o.classList.toggle("active", idx === active));
      opts[active].scrollIntoView({ block: "nearest" });
   };
   const close = (): void => {
      if (!open) return;
      open = false;
      list.hidden = true;
      dd.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
      if (onDocDown) document.removeEventListener("mousedown", onDocDown);
      onDocDown = null;
   };
   const openList = (): void => {
      if (open) return;
      open = true;
      list.hidden = false;
      dd.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
      setActive(Math.max(0, values.indexOf(current)));
      onDocDown = (e: Event): void => {
         if (!dd.contains(e.target as Node)) close();
      };
      document.addEventListener("mousedown", onDocDown);
   };
   const choose = (i: number): void => {
      const v = values[i];
      close();
      if (v !== current) onSelect(v); // rebuilds the panel via onChange
   };

   btn.addEventListener("click", () => (open ? close() : openList()));
   /* mousedown (not click) so it fires before the open-only outside-close listener. */
   list.addEventListener("mousedown", (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>(".model-dd-opt");
      if (li && li.dataset.index) {
         e.preventDefault();
         choose(Number(li.dataset.index));
      }
   });
   dd.addEventListener("keydown", (e) => {
      if (!open) {
         if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
            e.preventDefault();
            openList();
         }
         return;
      }
      if (e.key === "Escape") {
         e.preventDefault();
         close();
         btn.focus();
      } else if (e.key === "ArrowDown") {
         e.preventDefault();
         setActive(active + 1);
      } else if (e.key === "ArrowUp") {
         e.preventDefault();
         setActive(active - 1);
      } else if (e.key === "Enter" || e.key === " ") {
         e.preventDefault();
         choose(active);
      }
   });

   row.append(lbl, dd);
   return row;
}

function privacyToggle(checked: boolean, onChange: (on: boolean) => void): HTMLElement {
   const row = document.createElement("label");
   row.className = "menu-row model-privacy";
   const cb = document.createElement("input");
   cb.type = "checkbox";
   cb.className = "menu-check";
   cb.checked = checked;
   cb.addEventListener("change", () => onChange(cb.checked));
   const span = document.createElement("span");
   span.textContent = "Private conversation";
   row.append(cb, span);
   return row;
}

function cap(s: string): string {
   return s.charAt(0).toUpperCase() + s.slice(1);
}

/* A menu group: a button + its dropdown container. */
function menuGroup(title: string): { el: HTMLElement; dropdown: HTMLElement } {
   const el = document.createElement("div");
   el.className = "menu-group";
   const btn = document.createElement("button");
   btn.type = "button";
   btn.className = "menu-btn";
   btn.textContent = title;
   const dropdown = document.createElement("div");
   dropdown.className = "menu-dropdown";
   el.append(btn, dropdown);
   return { el, dropdown };
}
