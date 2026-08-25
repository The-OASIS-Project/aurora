/*
 * The Watches board: DAWN's SAGE proactive-alert rules rendered in the same machined
 * phosphor language as the Home Assistant board. Each row is one watch - a metric, the
 * condition it fires on (threshold or feed-silence), the live reading, and an enable
 * toggle - grouped by source (system / suit / components) like HA's rooms.
 *
 * It is the config side of the attention system Aurora already surfaces: the notices these
 * watches FIRE arrive as attention_alert / silent_observation cards; this shows what is
 * being watched and the live values behind them.
 *
 * Read + a benign per-watch enable/disable (watch_set_enabled), a deliberate user action in
 * the sanctioned class (like set_pinned) - NOT ambient control. The global attention flag is
 * DISPLAY ONLY (toggling it is a set_config, out of the read-mostly charter). There is no
 * push: the ingest polls watch_list (a cheap read) and re-lists after a toggle to reconcile;
 * the live readings refresh on that poll, so the row spikes only on DISCRETE transitions
 * (enable flip, reading appearing/disappearing), never on the continuously-varying number.
 *
 * All DAWN strings (label / name / unit / source) are bound via textContent - a watch name
 * is user/LLM-authorable through the `attention` tool, so treat it as untrusted.
 */

import type { WatchItem, WatchesStatus, WatchesSink, WatchCatalogEntry, WatchReading } from "../ingest/ingest.ts";
import { makeMovable } from "../render/movable.ts";
import { makeListCard } from "../render/list-card.ts";
import { addCorners } from "../render/corners.ts";
import { makeVisibility } from "../render/visibility.ts";
import { openDialog } from "../menu/dialog.ts";
import { openEditWatch, closeWatchModal } from "./watch-modal.ts";

export interface WatchesPanelController extends WatchesSink {
   isVisible(): boolean;
   setVisible(on: boolean): void;
   destroy(): void;
}

export interface WatchesPanelOpts {
   /* Re-list the watches now (the manual refresh control; there is no push feed). */
   onRefresh(): void;
   /* Enable/disable a watch - a benign flip; the server reconciles via a re-list. */
   onToggle(id: number, enabled: boolean): void;
   /* Opt into / out of the 1 Hz live-readings stream. Called with the panel's visibility so
      DAWN only streams while the board is on screen. */
   onReadingsSubscribe?(enabled: boolean): void;
   /* Phase-2 CRUD (deliberate user actions). `onAdd` starts watching a metric (defaults);
      `onUpdate` sends the full field state of an existing watch; `onRemove` is only ever
      reached from the confirm-gated gesture here. Optional so Phase-1 hosts still work. */
   onAdd?(metric: string): void;
   onUpdate?(id: number, fields: { direction?: string; threshold?: number; notify?: string }): void;
   onRemove?(id: number): void;
   /* Is the DAWN link usable right now? When not, the flip is neither sent nor shown
      (it would lie), and `notify` says why. Optional -> treated as always-live. */
   isLive?(): boolean;
   notify?(message: string): void;
}

const VISIBLE_KEY = "dawn.hero.watchesShown";
const POS_KEY = "dawn.hero.watchesPos";
const LIST_H_KEY = "dawn.hero.watchesListH";
const COLLAPSED_KEY = "dawn.hero.watchesCollapsed";

/* Group by metric FAMILY (the metric-key prefix: stat.* / suit.* / component.*), not the
   watch's source_tag - that's provenance (seed/other), whereas the family is what "what am I
   watching" wants. Preferred display order first, unknown families after (alpha). */
const FAMILY_LABELS: Record<string, string> = { stat: "System", suit: "Suit", component: "Components" };
const FAMILY_ORDER = ["stat", "suit", "component"];
const familyOf = (w: WatchItem): string => w.metric.split(".")[0] || w.source || "other";

/* A compact number: integers bare, otherwise one decimal. */
function fmtNum(v: number): string {
   if (!isFinite(v)) return "";
   return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
function withUnit(v: number, unit: string): string {
   const n = fmtNum(v);
   return n && unit ? `${n} ${unit}` : n;
}

/* "What this watch does", one line. */
function conditionText(w: WatchItem): string {
   if (w.ruleType === "absence") {
      return `Alerts if silent over ${w.absenceAfterSec}s`;
   }
   const thr = typeof w.threshold === "number" ? withUnit(w.threshold, w.unit) : "-";
   const dir = w.direction === "below" ? "below" : w.direction === "rising" ? "rising past" : "above";
   return `Alerts when ${dir} ${thr}`;
}

/* The live reading, or "" when there is none (hardware not reporting). */
function currentText(w: WatchItem): string {
   if (!w.hasCurrent || typeof w.current !== "number") return "";
   if (w.ruleType === "absence") return `silent ${fmtNum(w.current)}s`;
   return `now ${withUnit(w.current, w.unit)}`;
}

export function mountWatchesPanel(root: HTMLElement, opts: WatchesPanelOpts): WatchesPanelController {
   const el = document.createElement("div");
   el.id = "watches";
   el.className = "watches";
   addCorners(el);

   const head = document.createElement("div");
   head.className = "watches-head";
   const titleEl = document.createElement("div");
   titleEl.className = "watches-title";
   titleEl.textContent = "Watches";
   const statusEl = document.createElement("div");
   statusEl.className = "watches-status";
   const addBtn = document.createElement("button");
   addBtn.type = "button";
   addBtn.className = "watches-add"; // also the drag-ignore hook
   addBtn.setAttribute("aria-label", "Add a watch");
   addBtn.title = "Add a watch";
   addBtn.textContent = "+";
   const refreshBtn = document.createElement("button");
   refreshBtn.type = "button";
   refreshBtn.className = "watches-refresh panel-refresh"; // watches-refresh is the drag-ignore hook
   refreshBtn.setAttribute("aria-label", "Refresh watches now");
   head.append(titleEl, statusEl, addBtn, refreshBtn);

   const list = document.createElement("div");
   list.className = "watches-list";

   el.append(head, list);
   root.appendChild(el);

   const onRefreshClick = (e: MouseEvent): void => {
      e.stopPropagation();
      opts.onRefresh();
      refreshBtn.classList.remove("spin");
      void refreshBtn.offsetWidth; // restart the animation
      refreshBtn.classList.add("spin");
   };
   refreshBtn.addEventListener("click", onRefreshClick);

   const card = makeListCard(el, list, { storageKey: LIST_H_KEY });
   const disposeMovable = makeMovable(el, {
      storageKey: POS_KEY,
      handle: ".watches-head",
      ignore: ".watches-refresh, .watches-add"
   });
   const vis = makeVisibility(el, { storageKey: VISIBLE_KEY, offClass: "watches-off" });
   /* Show/hide (from the Panels menu) also opts the 1 Hz readings stream in/out - it is only
      worth streaming while the board is on screen. */
   const setVisible = (on: boolean): void => {
      vis.setVisible(on);
      opts.onReadingsSubscribe?.(on);
   };

   /* --- state ------------------------------------------------------------- */
   let watches: WatchItem[] = [];
   let catalog: WatchCatalogEntry[] = []; // watchable metrics (Phase-2 add picker)
   let pendingEditMetric = ""; // just-added metric: open its edit form when the re-list arrives
   let status: WatchesStatus = { ok: true, attentionEnabled: true };
   let loaded = false; // suppress the transition-spike on the first list
   let changed = new Set<number>(); // watch ids whose enabled / has-reading flipped this list
   const prevEnabled = new Map<number, boolean>();
   const prevHasCurrent = new Map<number, boolean>();
   /* Live row elements by watch id, so the 1 Hz readings stream patches the numbers in place
      (no full re-render). Rebuilt each render(); a collapsed group's rows are absent (the
      watch object is still patched, so it is fresh on expand). */
   const rowEls = new Map<number, { row: HTMLElement; reading: HTMLElement }>();

   const loadCollapsed = (): Set<string> => {
      try {
         const arr = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
         return Array.isArray(arr) ? new Set(arr.map(String)) : new Set();
      } catch {
         return new Set();
      }
   };
   const collapsed = loadCollapsed();
   const persistCollapsed = (): void => {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
   };

   const live = (): boolean => !opts.isLive || opts.isLive();

   /* Group by metric family; preferred order (System/Suit/Components) first, unknown
      families after alphabetically. Within a group, order by label then id. */
   const groupByFamily = (): Array<{ family: string; label: string; items: WatchItem[] }> => {
      const groups = new Map<string, WatchItem[]>();
      for (const w of watches) {
         const key = familyOf(w);
         const bucket = groups.get(key);
         if (bucket) bucket.push(w);
         else groups.set(key, [w]);
      }
      const keys = [...groups.keys()].sort((a, b) => {
         const ia = FAMILY_ORDER.indexOf(a);
         const ib = FAMILY_ORDER.indexOf(b);
         if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
         return a.localeCompare(b);
      });
      return keys.map((family) => ({
         family,
         label: FAMILY_LABELS[family] ?? family.charAt(0).toUpperCase() + family.slice(1),
         items: (groups.get(family) as WatchItem[]).sort((a, b) => a.label.localeCompare(b.label) || a.id - b.id)
      }));
   };

   /* --- Phase-2 CRUD (add / edit / remove) -------------------------------- */

   const confirmRemove = (w: WatchItem): void => {
      /* A watch is cheap to recreate (no cascade, unlike delete_conversation), so the confirm
         is proportionate - not cascade-gravity. Reachable only from this gesture. */
      openDialog({
         title: "Remove watch",
         sub: `Stop watching ${w.label || w.metric}?`,
         actions: [
            { label: "Cancel", onClick: () => {} },
            { label: "Remove", danger: true, onClick: () => opts.onRemove?.(w.id) }
         ]
      });
   };

   const openEdit = (w: WatchItem): void => {
      openEditWatch({
         watch: w,
         onSave: (fields) => opts.onUpdate?.(w.id, fields),
         onRemove: () => confirmRemove(w)
      });
   };

   /* Add: a catalog picker of not-yet-watched metrics (grouped label prefix). Choosing one
      adds it with defaults, then we drop into its edit form when the re-list lands, so the
      user can set the threshold immediately (no-backend add-then-edit). */
   const openAdd = (): void => {
      const watched = new Set(watches.map((w) => w.metric));
      const choices = catalog
         .filter((c) => !watched.has(c.key))
         .map((c) => {
            const fam = c.key.split(".")[0];
            const famLabel = fam === "stat" ? "System" : fam === "suit" ? "Suit" : fam === "component" ? "Components" : fam;
            return { label: `${famLabel} · ${c.label}`, value: c.key };
         });
      if (choices.length === 0) {
         openDialog({ title: "Add a watch", sub: "Everything in the catalog is already watched." });
         return;
      }
      openDialog({
         title: "Add a watch",
         sub: "Pick a metric to watch.",
         choices,
         onChoose: (metric) => {
            pendingEditMetric = metric;
            opts.onAdd?.(metric);
         }
      });
   };
   addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openAdd();
   });

   const toggleWatch = (w: WatchItem): void => {
      if (!live()) {
         opts.notify?.("Not connected to DAWN - change not sent.");
         return;
      }
      const next = !w.enabled;
      opts.onToggle(w.id, next);
      w.enabled = next; // optimistic; the re-list reconciles (a lost flip self-corrects on poll)
      render();
   };

   const buildToggle = (w: WatchItem): HTMLElement => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = w.enabled ? "watches-toggle on" : "watches-toggle";
      btn.setAttribute("role", "switch");
      btn.setAttribute("aria-checked", w.enabled ? "true" : "false");
      btn.setAttribute("aria-label", `${w.enabled ? "Disable" : "Enable"} ${w.label}`);
      btn.addEventListener("click", (e) => {
         e.stopPropagation();
         toggleWatch(w);
      });
      return btn;
   };

   const buildRow = (w: WatchItem): HTMLElement => {
      const row = document.createElement("div");
      row.className = "watches-row";
      if (w.enabled) row.classList.add("armed");
      if (!w.hasCurrent) row.classList.add("no-reading"); // dim: no live value to show
      if (changed.has(w.id)) row.classList.add("watches-changed");

      const dot = document.createElement("span");
      dot.className = "watches-dot";

      const main = document.createElement("div");
      main.className = "watches-row-main";
      const name = document.createElement("span");
      name.className = "watches-row-name";
      name.textContent = w.label || w.metric; // catalog label; DAWN string -> textContent
      const cond = document.createElement("span");
      cond.className = "watches-row-cond";
      cond.textContent = conditionText(w);
      main.append(name, cond);

      const reading = document.createElement("span");
      reading.className = "watches-row-current";
      reading.textContent = currentText(w);

      row.append(dot, main, reading, buildToggle(w));
      /* Click the row (anywhere but the toggle, which stops propagation) to edit it. */
      row.classList.add("editable");
      row.addEventListener("click", () => openEdit(w));
      rowEls.set(w.id, { row, reading }); // for the in-place readings patch
      return row;
   };

   const render = (): void => {
      list.replaceChildren();
      rowEls.clear();

      /* Header line: a list error, the disarmed note, or the active-watch count. */
      if (!status.ok) {
         statusEl.textContent = "list error";
      } else if (!status.attentionEnabled) {
         statusEl.textContent = "disarmed";
      } else {
         const active = watches.filter((w) => w.enabled).length;
         statusEl.textContent = watches.length ? `${active} armed` : "";
      }

      /* A failed list keeps the last rows (don't wipe to "nothing watched" on a blip) but
         flags the staleness. */
      if (!status.ok && watches.length === 0) {
         const msg = document.createElement("div");
         msg.className = "watches-empty";
         msg.textContent = status.error ? `Couldn't load watches (${status.error})` : "Couldn't load watches";
         list.appendChild(msg);
         card.refresh();
         changed = new Set();
         return;
      }
      if (watches.length === 0) {
         const msg = document.createElement("div");
         msg.className = "watches-empty";
         msg.textContent = "Nothing being watched";
         list.appendChild(msg);
         card.refresh();
         changed = new Set();
         return;
      }

      /* Disarmed banner: the whole SAGE attention system is off, so no watch will fire -
         say why (the flag is global config, changed in DAWN settings, not here). */
      if (!status.attentionEnabled) {
         const banner = document.createElement("div");
         banner.className = "watches-disarmed";
         banner.textContent = "Proactive attention is off - enable it in DAWN settings.";
         list.appendChild(banner);
      }
      if (!status.ok) {
         const stale = document.createElement("div");
         stale.className = "watches-stale";
         stale.textContent = status.error ? `Showing last known (${status.error})` : "Showing last known";
         list.appendChild(stale);
      }

      for (const { family, label, items } of groupByFamily()) {
         const isCollapsed = collapsed.has(family);
         const header = document.createElement("div");
         header.className = isCollapsed ? "watches-group collapsed" : "watches-group";
         header.setAttribute("role", "button");
         header.setAttribute("tabindex", "0");
         header.setAttribute("aria-expanded", isCollapsed ? "false" : "true");

         const chevron = document.createElement("span");
         chevron.className = "watches-group-chevron";
         chevron.setAttribute("aria-hidden", "true");
         const glabel = document.createElement("span");
         glabel.className = "watches-group-label";
         glabel.textContent = label;
         header.append(chevron, glabel);

         const armed = items.filter((w) => w.enabled).length;
         if (armed > 0) {
            const count = document.createElement("span");
            count.className = "watches-group-count";
            count.textContent = String(armed);
            header.appendChild(count);
         }

         const toggleGroup = (): void => {
            if (collapsed.has(family)) collapsed.delete(family);
            else collapsed.add(family);
            persistCollapsed();
            render();
         };
         header.addEventListener("click", toggleGroup);
         header.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
               e.preventDefault();
               toggleGroup();
            }
         });
         list.appendChild(header);

         if (isCollapsed) continue;
         for (const w of items) list.appendChild(buildRow(w));
      }

      card.refresh();
      changed = new Set(); // consume: a later non-list re-render must not re-spike
   };
   render();

   const controller: WatchesPanelController = {
      setWatches: (next, cat: WatchCatalogEntry[]) => {
         /* Spike only on DISCRETE transitions - enable flip or a reading appearing/
            disappearing - NEVER on the current value, which changes every poll. */
         const nextChanged = new Set<number>();
         if (loaded) {
            for (const w of next) {
               const pe = prevEnabled.get(w.id);
               const ph = prevHasCurrent.get(w.id);
               if ((pe !== undefined && pe !== w.enabled) || (ph !== undefined && ph !== w.hasCurrent)) {
                  nextChanged.add(w.id);
               }
            }
         }
         prevEnabled.clear();
         prevHasCurrent.clear();
         for (const w of next) {
            prevEnabled.set(w.id, w.enabled);
            prevHasCurrent.set(w.id, w.hasCurrent);
         }
         loaded = true;
         changed = nextChanged;
         watches = next;
         catalog = cat;
         render();
         /* add-then-edit: a metric we just added has now appeared - open its edit form so the
            user can set the threshold (the fresh row carries the resolved rule_type/values). */
         if (pendingEditMetric) {
            const justAdded = watches.find((w) => w.metric === pendingEditMetric);
            pendingEditMetric = "";
            if (justAdded) openEdit(justAdded);
         }
      },
      setStatus: (s) => {
         status = s;
         render();
      },
      /* Patch the live readings in place - update the number + the no-reading dim per row,
         no re-render (the rule structure is unchanged, and values must not spike). A row in
         a collapsed group has no element; its watch object is still patched, so it is fresh
         when the group expands. */
      setReadings: (readings: WatchReading[]) => {
         for (const r of readings) {
            const w = watches.find((x) => x.id === r.id);
            if (!w) continue;
            w.hasCurrent = r.hasCurrent;
            w.current = r.current;
            const els = rowEls.get(r.id);
            if (els) {
               els.reading.textContent = currentText(w);
               els.row.classList.toggle("no-reading", !w.hasCurrent);
            }
         }
      },
      isVisible: vis.isVisible,
      setVisible,
      destroy: () => {
         opts.onReadingsSubscribe?.(false); // stop the stream when the panel goes away
         closeWatchModal(); // an open edit form must not outlive the panel (HMR)
         refreshBtn.removeEventListener("click", onRefreshClick);
         card.destroy();
         disposeMovable();
         el.remove();
      }
   };
   /* Opt into the live stream now if we mount visible (the ingest remembers the intent and
      sends it once connected). */
   if (vis.isVisible()) opts.onReadingsSubscribe?.(true);
   return controller;
}
