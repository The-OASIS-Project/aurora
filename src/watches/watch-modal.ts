/*
 * The edit-a-watch modal: a small themed form over a dimmed backdrop, for tuning one SAGE
 * watch. A watch has one of three condition kinds:
 *   - threshold: a value crosses a band edge   -> direction above/below + a threshold (units)
 *   - slope:     a rate of change over a window -> direction rising/falling + a rate (units/min)
 *   - absence:   a feed went silent            -> a silence window (seconds)
 *
 * A threshold and a slope watch are interconvertible in place (the kind toggle sends
 * `ruleType`, which DAWN's watch_update converts and persists); absence is a fixed kind and
 * is not switchable, so it shows no toggle. DAWN speaks a rule-type-specific direction
 * vocabulary and REJECTS cross-vocabulary (above/below only on threshold, rising/falling only
 * on slope), so the direction options swap with the kind.
 *
 * A watch is one-per-metric, so the metric itself is not editable - only its dials. Save
 * sends the FULL field state (a partial update would reset omitted fields to catalog defaults
 * on the server). Single instance; Esc / backdrop / Cancel close.
 */

import { addCorners } from "../render/corners.ts";
import type { WatchItem, WatchFields } from "../ingest/ingest.ts";

const NOTIFY_OPTIONS: Array<[string, string]> = [
   ["alert", "Alert"],
   ["ambient", "Ambient"]
   /* Digest is log-only in DAWN P0 (attention_policy.c: "No briefing in P0 - digest is
      log-only"), so a watch set to it fires nothing visible. Omitted until DAWN wires it. */
];
/* Direction vocabulary is rule-type-specific (the server rejects cross-vocabulary). */
const THRESH_DIR_OPTIONS: Array<[string, string]> = [
   ["above", "Above"],
   ["below", "Below"]
];
const SLOPE_DIR_OPTIONS: Array<[string, string]> = [
   ["rising", "Rising"],
   ["falling", "Falling"]
];
/* The interconvertible condition kinds (absence is fixed, so it never shows this toggle). */
const KIND_OPTIONS: Array<[string, string]> = [
   ["threshold", "Threshold"],
   ["slope", "Rate"]
];

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

/* A labelled row of segmented buttons; returns the current value via a getter. `onChange`
   fires on a user pick (used to re-render the condition section when the kind flips). */
function segmentedField(
   label: string,
   options: Array<[string, string]>,
   initial: string,
   onChange?: (value: string) => void
): { row: HTMLElement; get: () => string } {
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
         if (value === val) return;
         value = val;
         for (const x of btns) x.classList.toggle("active", x === b);
         onChange?.(value);
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

/* A free-text field (the watch name). `placeholder` shows the server auto-name when the watch
   isn't user-named, so leaving it blank keeps auto-naming. */
function textField(label: string, initial: string, placeholder: string): { row: HTMLElement; get: () => string } {
   const row = document.createElement("div");
   row.className = "watch-field";
   const lbl = document.createElement("span");
   lbl.className = "watch-field-label";
   lbl.textContent = label;
   const input = document.createElement("input");
   input.type = "text";
   input.className = "watch-text";
   input.value = initial; // property assignment, not markup - safe for a DAWN/user string
   if (placeholder) input.placeholder = placeholder;
   row.append(lbl, input);
   return { row, get: () => input.value };
}

/* A rate field: a number plus a clickable per-min / per-sec unit toggle. The wire is always
   canonical per-MINUTE, so get() converts a per-second display value back (x60). The toggle
   rescales the shown number so the underlying rate is unchanged by a unit flip. `baseUnit` is
   the metric unit ("°C", "%", "" for a bare count); the displayed unit is "<baseUnit>/min". */
function slopeField(label: string, initialPerMin: number | undefined, baseUnit: string): { row: HTMLElement; get: () => number | undefined } {
   let per: "min" | "sec" = "min";
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
   if (typeof initialPerMin === "number") input.value = String(initialPerMin);
   const unitBtn = document.createElement("button");
   unitBtn.type = "button";
   unitBtn.className = "watch-num-unit watch-unit-toggle";
   unitBtn.title = "Switch between per-minute and per-second";
   const unitLabel = (): string => `${baseUnit ? baseUnit : ""}/${per === "min" ? "min" : "s"}`;
   unitBtn.textContent = unitLabel(); // built from catalog unit + a literal suffix -> textContent
   unitBtn.addEventListener("click", () => {
      const n = parseFloat(input.value);
      if (isFinite(n)) {
         /* Keep the underlying rate constant across the flip: min->sec divides by 60. */
         input.value = String(per === "min" ? n / 60 : n * 60);
      }
      per = per === "min" ? "sec" : "min";
      unitBtn.textContent = unitLabel();
   });
   wrap.append(input, unitBtn);
   row.append(lbl, wrap);
   return {
      row,
      get: () => {
         const n = parseFloat(input.value);
         if (!isFinite(n)) return undefined;
         const perMin = per === "sec" ? n * 60 : n; // -> canonical per-minute
         return Math.round(perMin * 1e6) / 1e6; // strip *60 float noise (2 not 2.0000000000000004)
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

export interface EditWatchOpts {
   watch: WatchItem;
   /* Create mode: the watch does not exist yet (seeded from catalog defaults). Save WRITES it
      (watch_add), Cancel leaves nothing behind, and there is no Remove. */
   isNew?: boolean;
   /* Full field state for the current kind. Rule-type-specific keys (see WatchFields). */
   onSave(fields: WatchFields): void;
   /* The panel gates this behind a confirm dialog before calling ingest.removeWatch. Absent in
      create mode (nothing to remove yet). */
   onRemove?(): void;
}

export function openEditWatch(opts: EditWatchOpts): void {
   closeWatchModal();
   prevFocus = document.activeElement as HTMLElement | null;
   const w = opts.watch;
   const isNew = opts.isNew === true;
   const isAbsence = w.ruleType === "absence";

   overlay = document.createElement("div");
   overlay.className = "watch-modal-overlay";
   const card = document.createElement("div");
   card.className = "watch-modal";
   card.setAttribute("role", "dialog");
   card.setAttribute("aria-modal", "true");
   card.setAttribute("aria-label", isNew ? `New watch on ${w.label}` : `Edit ${w.label}`);
   addCorners(card);

   const title = document.createElement("div");
   title.className = "watch-modal-title";
   title.textContent = isNew ? "New watch" : w.label || w.metric;
   const sub = document.createElement("div");
   sub.className = "watch-modal-sub";
   sub.textContent = isNew ? w.label || w.metric : w.metric; // create: what you're watching; edit: the catalog key
   card.append(title, sub);

   const body = document.createElement("div");
   body.className = "watch-modal-body";

   /* Name: pre-filled for a user-named watch; blank with the auto-name as placeholder for an
      auto-named one (so leaving it blank keeps the server auto-naming from the condition). */
   const isNamed = w.named === true;
   const nameField = textField("Name", isNamed ? w.name : "", isNamed ? "" : w.name || "Auto-named");
   body.appendChild(nameField.row);

   /* Current condition kind: absence is fixed; a threshold/slope watch starts on its stored
      kind and can flip between the two. */
   let kind: string = isAbsence ? "absence" : w.ruleType === "slope" ? "slope" : "threshold";

   /* The reactive condition section (direction + trigger), rebuilt when the kind flips. Its
      current getters are captured here so Save reads whichever kind is showing. */
   const condWrap = document.createElement("div");
   condWrap.className = "watch-cond";
   let getCondition: () => Partial<WatchFields> = () => ({});
   const errLine = document.createElement("div");
   errLine.className = "watch-modal-err";

   const renderCondition = (): void => {
      condWrap.replaceChildren();
      errLine.textContent = "";
      if (kind === "absence") {
         const f = numberField("Alert if silent for", w.absenceAfterSec, "s");
         getCondition = () => ({ threshold: f.get() }); // absence: threshold field = silence seconds
         condWrap.appendChild(f.row);
      } else if (kind === "slope") {
         const dirInit = w.direction === "falling" ? "falling" : "rising";
         const dir = segmentedField("Direction", SLOPE_DIR_OPTIONS, dirInit);
         const rate = slopeField("Rate", w.slopePerMin, w.unit);
         const win = numberField("Averaged over", w.slopeWindowSec, "s"); // optional; blank -> server default
         getCondition = () => ({ direction: dir.get(), slopePerMin: rate.get(), slopeWindowSec: win.get() });
         condWrap.append(dir.row, rate.row, win.row);
      } else {
         const dirInit = w.direction === "below" ? "below" : "above";
         const dir = segmentedField("Direction", THRESH_DIR_OPTIONS, dirInit);
         const thr = numberField("Threshold", w.threshold, w.unit);
         getCondition = () => ({ direction: dir.get(), threshold: thr.get() });
         condWrap.append(dir.row, thr.row);
      }
   };

   /* Kind toggle (threshold <-> slope), hidden for the fixed absence kind. */
   if (!isAbsence) {
      const kindField = segmentedField("Condition", KIND_OPTIONS, kind, (v) => {
         kind = v;
         renderCondition();
      });
      body.appendChild(kindField.row);
   }
   body.append(condWrap, errLine);
   renderCondition();

   /* Notify offers only alert/ambient (digest is DAWN-P0 log-only). A watch whose stored notify
      is something else (a digest watch made by voice/another client) would be silently coerced
      to alert on Save - so track whether the user actually picked a notify, and only send it when
      they did (or when the stored value was already representable). */
   let notifyTouched = false;
   const notifyRepresentable = w.notify === "alert" || w.notify === "ambient";
   const notify = segmentedField("Notify", NOTIFY_OPTIONS, w.notify === "ambient" ? "ambient" : "alert", () => {
      notifyTouched = true;
   });
   body.appendChild(notify.row);
   card.append(body);

   const actions = document.createElement("div");
   actions.className = "watch-modal-actions";
   /* Remove only exists for an existing watch; a create modal has nothing to remove. */
   if (!isNew && opts.onRemove) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "watch-modal-btn danger";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => {
         closeWatchModal();
         opts.onRemove?.(); // panel gates this behind a confirm
      });
      actions.append(removeBtn);
   }
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
   saveBtn.textContent = isNew ? "Add" : "Save";
   saveBtn.addEventListener("click", () => {
      const cond = getCondition();
      /* A slope watch needs a positive rate (DAWN rejects a zero/absent one with
         "A rising/falling watch needs a rate"); catch it inline instead of round-tripping. */
      if (kind === "slope" && !(typeof cond.slopePerMin === "number" && cond.slopePerMin > 0)) {
         errLine.textContent = "Enter a rate above zero.";
         return;
      }
      const fields: WatchFields = { ...cond };
      if (!isAbsence) fields.ruleType = kind; // threshold|slope: honor an in-place kind switch
      const nm = nameField.get().trim();
      if (nm) fields.name = nm; // only send a name when set; blank keeps the current/auto name
      if (isNew || notifyTouched || notifyRepresentable) fields.notify = notify.get(); // else keep a non-representable stored notify (e.g. digest)
      closeWatchModal();
      opts.onSave(fields);
   });
   actions.append(spacer, cancelBtn, saveBtn);
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
