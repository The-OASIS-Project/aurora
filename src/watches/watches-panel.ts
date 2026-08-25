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

import type { WatchItem, WatchesStatus, WatchesSink, WatchCatalogEntry, WatchReading, WatchFields } from "../ingest/ingest.ts";
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
   onAdd?(metric: string, fields: WatchFields): void;
   onUpdate?(id: number, fields: WatchFields): void;
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

/* The row title: the watch's own name (a metric can now hold several named watches - a min
   and a max, tiers - so the name is what tells them apart), falling back to the catalog label
   then the metric key on an older server that sends no name. */
function rowTitle(w: WatchItem): string {
   return w.name.trim() || w.label || w.metric;
}

/* A slope rate, in the metric's units per minute ("2 °C/min", "40 /min" for a unitless
   count). Per-minute is the wire's canonical unit. */
function rateText(v: number, unit: string): string {
   const n = fmtNum(v);
   if (!n) return "-";
   return unit ? `${n} ${unit}/min` : `${n}/min`;
}

/* "What this watch does", one line. */
function conditionText(w: WatchItem): string {
   if (w.ruleType === "absence") {
      return `Alerts if silent over ${w.absenceAfterSec}s`;
   }
   if (w.ruleType === "slope") {
      const rate = typeof w.slopePerMin === "number" ? rateText(w.slopePerMin, w.unit) : "-";
      const dir = w.direction === "falling" ? "falling" : "rising";
      return `Alerts when ${dir} ${rate}`;
   }
   const thr = typeof w.threshold === "number" ? withUnit(w.threshold, w.unit) : "-";
   const dir = w.direction === "below" ? "below" : "above";
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
   let destroyed = false; // set in destroy(); guards the deferred create-modal open below
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
   /* A watch tints warm only when it is enabled, has a live reading, AND DAWN says its
      condition is currently met (authoritative, hysteresis-aware). The has-reading gate
      matters because DAWN keeps `breaching` at its last-known value when a threshold watch's
      feed goes silent, and an unreadable row can't be trusted (it also dims via no-reading).
      Feature-detected: undefined breaching -> never tints. */
   const isBreaching = (w: WatchItem): boolean => w.enabled && w.hasCurrent && w.breaching === true;

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
         /* Cluster watches on the same metric together (a min + a max sit adjacent), then by
            title, then id for a stable order. */
         items: (groups.get(family) as WatchItem[]).sort(
            (a, b) => a.metric.localeCompare(b.metric) || rowTitle(a).localeCompare(rowTitle(b)) || a.id - b.id
         )
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

   /* Build a blank watch to seed the create modal, from the catalog entry's natural rule shape
      + default condition. Nothing is written until the user hits Save (id 0 = not yet created). */
   const seedWatch = (c: WatchCatalogEntry): WatchItem => {
      const isAbsence = c.ruleType === "absence";
      return {
         id: 0,
         name: "",
         metric: c.key,
         label: c.label,
         unit: c.unit,
         ruleType: c.ruleType ?? "threshold",
         direction: c.defaultDirection ?? "above",
         threshold: isAbsence ? undefined : c.defaultThreshold,
         absenceAfterSec: isAbsence ? c.defaultThreshold ?? 120 : 0,
         notify: "alert",
         enabled: true,
         named: false,
         source: c.key.split(".")[0],
         hasCurrent: false
      };
   };

   /* Add: a catalog picker of every watchable metric (grouped label prefix). A metric can hold
      several named watches now (min + max, tiers), so the list is NOT filtered by what's already
      watched. Choosing one opens a blank create modal seeded from the catalog defaults; the watch
      is written only on Save (Cancel leaves nothing behind - no stray default watch). */
   const openAdd = (): void => {
      const choices = catalog.map((c) => {
         const fam = c.key.split(".")[0];
         const famLabel = fam === "stat" ? "System" : fam === "suit" ? "Suit" : fam === "component" ? "Components" : fam;
         return { label: `${famLabel} · ${c.label}`, value: c.key };
      });
      if (choices.length === 0) {
         openDialog({ title: "Add a watch", sub: "No watchable metrics available." });
         return;
      }
      openDialog({
         title: "Add a watch",
         sub: "Pick a metric to watch.",
         choices,
         onChoose: (metric) => {
            const c = catalog.find((x) => x.key === metric);
            if (!c) return;
            /* Defer so the picker dialog fully closes first (it restores focus after onChoose);
               the create modal then opens last and keeps focus. Guard against the panel being
               torn down between the click and the microtask. */
            queueMicrotask(() => {
               if (destroyed) return;
               openEditWatch({
                  watch: seedWatch(c),
                  isNew: true,
                  onSave: (fields) => opts.onAdd?.(metric, fields)
               });
            });
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
      if (isBreaching(w)) row.classList.add("breaching"); // warm: condition currently met
      if (changed.has(w.id)) row.classList.add("watches-changed");

      const dot = document.createElement("span");
      dot.className = "watches-dot";

      /* Title spans the full row width on its own line (reads as a title); the condition and
         the live "now" reading share the line beneath it. */
      const main = document.createElement("div");
      main.className = "watches-row-main";
      const name = document.createElement("span");
      name.className = "watches-row-name";
      name.textContent = rowTitle(w); // watch name (or label fallback); DAWN string -> textContent
      const detail = document.createElement("div");
      detail.className = "watches-row-detail";
      const cond = document.createElement("span");
      cond.className = "watches-row-cond";
      cond.textContent = conditionText(w);
      const reading = document.createElement("span");
      reading.className = "watches-row-current";
      reading.textContent = currentText(w);
      detail.append(cond, reading);
      main.append(name, detail);

      row.append(dot, main, buildToggle(w));
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
      },
      setStatus: (s) => {
         /* A list poll calls setWatches (which may have just built the discrete-transition
            spike rows) then setStatus back-to-back in the same tick. Re-rendering here on an
            UNCHANGED status would replaceChildren and discard those spike rows before they
            paint - so only render when the status actually changed. */
         const same = status.ok === s.ok && status.attentionEnabled === s.attentionEnabled && status.error === s.error;
         status = s;
         if (!same) render();
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
            if (r.breaching !== undefined) w.breaching = r.breaching; // feature-detected
            const els = rowEls.get(r.id);
            if (els) {
               els.reading.textContent = currentText(w);
               els.row.classList.toggle("no-reading", !w.hasCurrent);
               const nowBreach = isBreaching(w);
               const wasBreach = els.row.classList.contains("breaching");
               els.row.classList.toggle("breaching", nowBreach);
               if (nowBreach && !wasBreach) {
                  /* Breach onset: a discrete "just started breaching" event - spike once. */
                  els.row.classList.remove("watches-breach-spike");
                  void els.row.offsetWidth; // restart the animation
                  els.row.classList.add("watches-breach-spike");
               }
            }
         }
      },
      isVisible: vis.isVisible,
      setVisible,
      destroy: () => {
         destroyed = true;
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
