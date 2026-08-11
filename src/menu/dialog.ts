/*
 * A small centered modal dialog: a frosted phosphor card over a dimmed backdrop, in
 * the same observatory language as the login overlay. Used by the System menu
 * (Connection, About). Chrome, outside the render seam. One dialog open at a time;
 * dismiss on backdrop click, Escape, or the close control.
 */

export interface DialogRow {
   label: string;
   value: string;
   tone?: "ok" | "alert"; // colors a leading status dot; omit for a plain row
}

export interface DialogAction {
   label: string;
   onClick: () => void;
   danger?: boolean; // a slightly destructive action (e.g. Disconnect), styled in the alert hue
}

/* A selectable option in a radio-style list (e.g. the microphone picker). */
export interface DialogChoice {
   label: string;
   value: string;
   selected?: boolean;
}

export interface DialogOptions {
   title: string;
   sub?: string;
   rows?: DialogRow[];
   /* A radio list; choosing one calls onChoose and closes the dialog. */
   choices?: DialogChoice[];
   onChoose?: (value: string) => void;
   link?: { label: string; href: string };
   actions?: DialogAction[];
}

let openOverlay: HTMLElement | null = null;

export function openDialog(opts: DialogOptions): void {
   closeDialog(); // only one at a time
   const prevFocus = document.activeElement as HTMLElement | null;

   const overlay = document.createElement("div");
   overlay.className = "dialog-overlay";

   const card = document.createElement("div");
   card.className = "dialog-card";
   card.setAttribute("role", "dialog");
   card.setAttribute("aria-modal", "true");
   card.setAttribute("aria-label", opts.title);

   const close = (): void => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      if (openOverlay === overlay) openOverlay = null;
      prevFocus?.focus?.();
   };
   const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
   };

   const closeBtn = document.createElement("button");
   closeBtn.type = "button";
   closeBtn.className = "dialog-close";
   closeBtn.setAttribute("aria-label", "Close");
   closeBtn.textContent = "×"; // ×
   closeBtn.addEventListener("click", close);

   const title = document.createElement("div");
   title.className = "dialog-title";
   title.textContent = opts.title;
   card.append(closeBtn, title);

   if (opts.sub) {
      const sub = document.createElement("div");
      sub.className = "dialog-sub";
      sub.textContent = opts.sub;
      card.append(sub);
   }

   if (opts.rows?.length) {
      const list = document.createElement("dl");
      list.className = "dialog-rows";
      for (const r of opts.rows) {
         const dt = document.createElement("dt");
         dt.textContent = r.label;
         const dd = document.createElement("dd");
         if (r.tone) {
            const dot = document.createElement("span");
            dot.className = `dialog-dot dialog-dot-${r.tone}`;
            dd.append(dot);
         }
         dd.append(document.createTextNode(r.value)); // WS/DAWN-sourced text -> textContent, never HTML
         list.append(dt, dd);
      }
      card.append(list);
   }

   if (opts.choices?.length) {
      const list = document.createElement("div");
      list.className = "dialog-choices";
      for (const c of opts.choices) {
         const row = document.createElement("button");
         row.type = "button";
         row.className = c.selected ? "dialog-choice selected" : "dialog-choice";
         row.setAttribute("role", "radio");
         row.setAttribute("aria-checked", c.selected ? "true" : "false");
         const dot = document.createElement("span");
         dot.className = "dialog-choice-dot";
         const label = document.createElement("span");
         label.textContent = c.label; // device labels are OS/WS-sourced -> textContent, never HTML
         row.append(dot, label);
         row.addEventListener("click", () => {
            opts.onChoose?.(c.value);
            close();
         });
         list.append(row);
      }
      card.append(list);
   }

   if (opts.link) {
      const a = document.createElement("a");
      a.className = "dialog-link";
      a.href = opts.link.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = opts.link.label;
      card.append(a);
   }

   if (opts.actions?.length) {
      const bar = document.createElement("div");
      bar.className = "dialog-actions";
      for (const act of opts.actions) {
         const btn = document.createElement("button");
         btn.type = "button";
         btn.className = act.danger ? "dialog-btn dialog-btn-danger" : "dialog-btn";
         btn.textContent = act.label;
         btn.addEventListener("click", () => {
            act.onClick();
            close();
         });
         bar.append(btn);
      }
      card.append(bar);
   }

   overlay.append(card);
   overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(); // backdrop only, not clicks inside the card
   });
   document.addEventListener("keydown", onKey);
   document.body.append(overlay);
   openOverlay = overlay;
   closeBtn.focus();
}

export function closeDialog(): void {
   openOverlay?.remove();
   openOverlay = null;
}
