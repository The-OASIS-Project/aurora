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

export interface MenuOptions {
   getPanels: () => MenuPanel[];
   onTogglePanel: (id: string) => void;
   displayToggles: MenuToggle[];
   /* Start a fresh conversation (clears context + transcript). Optional. */
   onNewChat?: () => void;
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
   const display = toggleMenu("Display", () =>
      opts.displayToggles.map((t) => ({
         label: t.label,
         checked: t.get(),
         onChange: () => t.toggle()
      }))
   );
   /* System: New Chat plus the Connection and About dialogs (each active when wired). */
   const system = actionMenu(
      "System",
      () => [
         ...(opts.onNewChat ? [{ label: "New Chat", onClick: opts.onNewChat }] : []),
         { label: "Connection", onClick: opts.onConnection },
         { label: "Microphone", onClick: opts.onMicDevice },
         { label: "About D.A.W.N.", onClick: opts.onAbout }
      ],
      closeAll
   );

   const groups = [panels, display];
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
function modelMenu(ctrl: ModelControl): { el: HTMLElement; refresh: () => void } {
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
               [["openai", "OpenAI"], ["claude", "Claude"], ["gemini", "Gemini"]],
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
   return { el, refresh: build };
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

/* The model dropdown (long lists). Shows the current value even if it is not in the
   available list yet (state can arrive before the list). */
function modelSelect(options: string[], current: string, onSelect: (value: string) => void): HTMLElement {
   const row = document.createElement("div");
   row.className = "model-row";
   const lbl = document.createElement("span");
   lbl.className = "model-label";
   lbl.textContent = "Model";
   const sel = document.createElement("select");
   sel.className = "model-select";
   const values = options.includes(current) || !current ? options : [current, ...options];
   if (values.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "—";
      sel.appendChild(opt);
      sel.disabled = true;
   } else {
      for (const v of values) {
         const opt = document.createElement("option");
         opt.value = v;
         opt.textContent = v;
         if (v === current) opt.selected = true;
         sel.appendChild(opt);
      }
      sel.addEventListener("change", () => onSelect(sel.value));
   }
   row.append(lbl, sel);
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
