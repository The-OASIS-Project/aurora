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
   /* Take initial focus instead of the close control. A dialog that can open unprompted (after a
      server reply) and offers a destructive action sets this on its SAFE choice, so a stray
      Enter keeps rather than destroys. */
   autofocus?: boolean;
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
   /* A paragraph of readable body prose (e.g. a consent explanation). Distinct from `sub`,
      which is a short uppercase subtitle - a sentence in `sub` renders as tracked all-caps. */
   body?: string;
   /* A smaller, dimmer paragraph under the body: the fine print (scope, caveats). */
   note?: string;
   rows?: DialogRow[];
   /* A radio list; choosing one calls onChoose and closes the dialog. */
   choices?: DialogChoice[];
   onChoose?: (value: string) => void;
   link?: { label: string; href: string };
   actions?: DialogAction[];
   /* Keep the danger actions inert for this long after mount. For a dialog that opens unprompted,
      so a click already on its way to something else can't land on a destructive button. */
   armDelayMs?: number;
   /* For a queued unprompted dialog (openDialogWhenFree): re-checked when it would open, and
      dropped if false (what it asks about may no longer hold by then). */
   stillValid?: () => boolean;
   /* Queue identity: a second queued dialog with the same key is dropped as a duplicate. */
   key?: string;
}

/* The open dialog's own close: it also drops that dialog's keydown listener and restores
   focus, so replacing one dialog with another tears the first down fully. */
let closeOpen: (() => void) | null = null;
/* Dialogs that open unprompted wait here while the user has one open (openDialogWhenFree). */
const waiting: DialogOptions[] = [];
/* Set while openDialog closes the old dialog to replace it: the queue must not drain into
   that gap (the replacement is about to take the slot). */
let replacing = false;

/* Open a dialog that was NOT asked for by a gesture (e.g. after a server reply). Never
   replaces a dialog the user already has open: it queues and opens once that one closes. */
export function openDialogWhenFree(opts: DialogOptions): void {
   if (!closeOpen) {
      openDialog(opts);
      return;
   }
   if (opts.key && waiting.some((w) => w.key === opts.key)) return;
   waiting.push(opts);
}

/* Open the next queued dialog that still holds, dropping any whose moment has passed. */
function drainWaiting(): void {
   while (waiting.length) {
      const next = waiting.shift()!;
      if (!next.stillValid || next.stillValid()) {
         openDialog(next);
         return;
      }
   }
}

export function openDialog(opts: DialogOptions): void {
   replacing = true;
   closeOpen?.(); // only one at a time
   replacing = false;
   const prevFocus = document.activeElement as HTMLElement | null;

   const overlay = document.createElement("div");
   overlay.className = "dialog-overlay";

   const card = document.createElement("div");
   card.className = "dialog-card";
   card.setAttribute("role", "dialog");
   card.setAttribute("aria-modal", "true");
   card.setAttribute("aria-label", opts.title);

   /* Idempotent: an action's onClick may already have replaced this dialog (openDialog closes
      it), and a second run would steal focus back from the new dialog's autofocus target. */
   let closed = false;
   const close = (): void => {
      if (closed) return;
      closed = true;
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      if (closeOpen === close) closeOpen = null;
      prevFocus?.focus?.();
      /* A queued unprompted dialog opens only once nothing replaced this one. */
      if (!closeOpen && !replacing) drainWaiting();
   };
   const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
      /* Modal: Tab cycles within the card, so focus can't leave it (or wander from a safe
         initial choice to a destructive one and then out of sight). */
      if (e.key === "Tab") {
         const items = Array.from(
            card.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]")
         );
         if (!items.length) return;
         const i = items.indexOf(document.activeElement as HTMLElement);
         const next = e.shiftKey
            ? i <= 0
               ? items.length - 1
               : i - 1
            : i < 0 || i === items.length - 1
              ? 0
              : i + 1;
         e.preventDefault();
         items[next].focus();
      }
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

   if (opts.body) {
      const body = document.createElement("p");
      body.className = "dialog-body";
      body.textContent = opts.body;
      card.append(body);
   }

   if (opts.note) {
      const note = document.createElement("p");
      note.className = "dialog-note";
      note.textContent = opts.note;
      card.append(note);
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

   let focusTarget: HTMLElement = closeBtn;
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
         if (act.autofocus) focusTarget = btn;
         if (act.danger && opts.armDelayMs && opts.armDelayMs > 0) {
            btn.disabled = true;
            window.setTimeout(() => {
               btn.disabled = false;
            }, opts.armDelayMs);
         }
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
   closeOpen = close;
   focusTarget.focus();
}

/* Close everything, queued unprompted dialogs included (teardown). */
export function closeDialog(): void {
   waiting.length = 0;
   closeOpen?.();
}
