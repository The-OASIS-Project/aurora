/*
 * The edit-a-watch modal: a small themed form over a dimmed backdrop, for tuning one SAGE
 * watch (a threshold rule's direction + threshold, or an absence rule's silence window, plus
 * the notify level). Add and remove reuse the shared `openDialog` (a catalog picker and a
 * confirm); only this form needs custom fields, so it lives here.
 *
 * A watch is one-per-metric, so the metric itself is not editable - only its dials. Save sends
 * the FULL field state (a partial update would reset omitted fields to catalog defaults on the
 * server). Single instance; Esc / backdrop / Cancel close.
 */

import { addCorners } from "../render/corners.ts";
import type { WatchItem } from "../ingest/ingest.ts";

const NOTIFY_OPTIONS: Array<[string, string]> = [
   ["alert", "Alert"],
   ["ambient", "Ambient"],
   ["digest", "Digest"]
];
const DIRECTION_OPTIONS: Array<[string, string]> = [
   ["above", "Above"],
   ["below", "Below"],
   ["rising", "Rising"]
];

export interface EditWatchOpts {
   watch: WatchItem;
   /* Full field state (threshold rule: direction+threshold+notify; absence rule: threshold is
      the silence window in seconds + notify). */
   onSave(fields: { direction?: string; threshold?: number; notify?: string }): void;
   /* The panel gates this behind a confirm dialog before calling ingest.removeWatch. */
   onRemove(): void;
}

let overlay: HTMLElement | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let prevFocus: HTMLElement | null = null;

export function closeWatchModal(): void {
   if (!overlay) return;
   overlay.remove();
   overlay = null;
   if (keyHandler) document.removeEventListener("keydown", keyHandler);
   keyHandler = null;
   prevFocus?.focus?.();
   prevFocus = null;
}

/* A labelled row of segmented buttons; returns the current value via a getter. */
function segmentedField(label: string, options: Array<[string, string]>, initial: string): { row: HTMLElement; get: () => string } {
   let value = initial;
   const row = document.createElement("div");
   row.className = "watch-field";
   const lbl = document.createElement("span");
   lbl.className = "watch-field-label";
   lbl.textContent = label;
   const seg = document.createElement("div");
   seg.className = "watch-seg";
   const btns: HTMLButtonElement[] = [];
   for (const [val, text] of options) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = val === value ? "watch-seg-btn active" : "watch-seg-btn";
      b.textContent = text;
      b.addEventListener("click", () => {
         value = val;
         for (const x of btns) x.classList.toggle("active", x === b);
      });
      btns.push(b);
      seg.appendChild(b);
   }
   row.append(lbl, seg);
   return { row, get: () => value };
}

function numberField(label: string, initial: number | undefined, unit: string): { row: HTMLElement; get: () => number | undefined } {
   const row = document.createElement("div");
   row.className = "watch-field";
   const lbl = document.createElement("span");
   lbl.className = "watch-field-label";
   lbl.textContent = label;
   const wrap = document.createElement("div");
   wrap.className = "watch-num-wrap";
   const input = document.createElement("input");
   input.type = "number";
   input.className = "watch-num";
   input.inputMode = "decimal";
   if (typeof initial === "number") input.value = String(initial);
   wrap.appendChild(input);
   if (unit) {
      const u = document.createElement("span");
      u.className = "watch-num-unit";
      u.textContent = unit; // catalog unit, literal UTF-8 -> textContent
      wrap.appendChild(u);
   }
   row.append(lbl, wrap);
   return {
      row,
      get: () => {
         const n = parseFloat(input.value);
         return isFinite(n) ? n : undefined;
      }
   };
}

/* Keep Tab focus inside the card. */
function trapTab(e: KeyboardEvent, container: HTMLElement): void {
   const f = container.querySelectorAll<HTMLElement>('button, input, [href], [tabindex]:not([tabindex="-1"])');
   if (!f.length) return;
   const first = f[0];
   const last = f[f.length - 1];
   if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
   } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
   }
}

export function openEditWatch(opts: EditWatchOpts): void {
   closeWatchModal();
   prevFocus = document.activeElement as HTMLElement | null;
   const w = opts.watch;
   const isAbsence = w.ruleType === "absence";

   overlay = document.createElement("div");
   overlay.className = "watch-modal-overlay";
   const card = document.createElement("div");
   card.className = "watch-modal";
   card.setAttribute("role", "dialog");
   card.setAttribute("aria-modal", "true");
   card.setAttribute("aria-label", `Edit ${w.label}`);
   addCorners(card);

   const title = document.createElement("div");
   title.className = "watch-modal-title";
   title.textContent = w.label || w.metric;
   const sub = document.createElement("div");
   sub.className = "watch-modal-sub";
   sub.textContent = isAbsence ? "Absence watch" : "Threshold watch";
   card.append(title, sub);

   const body = document.createElement("div");
   body.className = "watch-modal-body";

   let getDirection: (() => string) | null = null;
   let getThreshold: (() => number | undefined) | null = null;
   if (isAbsence) {
      const f = numberField("Alert if silent for", w.absenceAfterSec, "s");
      getThreshold = f.get; // absence: threshold field carries the silence window (seconds)
      body.appendChild(f.row);
   } else {
      const dir = segmentedField("Direction", DIRECTION_OPTIONS, w.direction || "above");
      getDirection = dir.get;
      const thr = numberField("Threshold", w.threshold, w.unit);
      getThreshold = thr.get;
      body.append(dir.row, thr.row);
   }
   const notify = segmentedField("Notify", NOTIFY_OPTIONS, w.notify || "alert");
   body.appendChild(notify.row);
   card.append(body);

   const actions = document.createElement("div");
   actions.className = "watch-modal-actions";
   const removeBtn = document.createElement("button");
   removeBtn.type = "button";
   removeBtn.className = "watch-modal-btn danger";
   removeBtn.textContent = "Remove";
   removeBtn.addEventListener("click", () => {
      closeWatchModal();
      opts.onRemove(); // panel gates this behind a confirm
   });
   const spacer = document.createElement("div");
   spacer.className = "watch-modal-spacer";
   const cancelBtn = document.createElement("button");
   cancelBtn.type = "button";
   cancelBtn.className = "watch-modal-btn";
   cancelBtn.textContent = "Cancel";
   cancelBtn.addEventListener("click", closeWatchModal);
   const saveBtn = document.createElement("button");
   saveBtn.type = "button";
   saveBtn.className = "watch-modal-btn primary";
   saveBtn.textContent = "Save";
   saveBtn.addEventListener("click", () => {
      const fields: { direction?: string; threshold?: number; notify?: string } = { notify: notify.get() };
      if (getDirection) fields.direction = getDirection();
      if (getThreshold) fields.threshold = getThreshold();
      closeWatchModal();
      opts.onSave(fields);
   });
   actions.append(removeBtn, spacer, cancelBtn, saveBtn);
   card.append(actions);

   overlay.append(card);
   overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeWatchModal();
   });
   keyHandler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
         e.preventDefault();
         closeWatchModal();
      } else if (e.key === "Tab") {
         trapTab(e, card);
      }
   };
   document.addEventListener("keydown", keyHandler);
   document.body.append(overlay);
   saveBtn.focus();
}
