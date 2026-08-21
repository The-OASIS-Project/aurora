/*
 * The Context panel: a calm, summonable "why did it say that" surface. A standalone movable
 * card in the same machined phosphor language as the calendar / library / HA boards, fed by
 * the pushed `context_injection` frame (signal map §3.2) - what DAWN retrieved into context
 * for the latest turn, with each source's blended score and its semantic/recency/importance/
 * source breakdown. Read-only: it reflects a push, sends nothing. Defaults hidden (a demo
 * affordance you summon from the Panels menu), and pulses when a fresh turn updates it.
 *
 * DAWN scopes the frame to the connection's active conversation, so this only ever shows the
 * conversation on screen; ingest clears it whenever the conversation changes.
 *
 * Security: every field here (item text, source id, rejection source) is memory/model-
 * sourced and therefore untrusted - all of it is bound via textContent, never innerHTML.
 */

import type { ContextItem, ContextSink, ContextTrace } from "../ingest/ingest.ts";
import { makeMovable } from "../render/movable.ts";
import { makeListCard } from "../render/list-card.ts";
import { addCorners } from "../render/corners.ts";
import { makeVisibility } from "../render/visibility.ts";
import { onActivate } from "../render/activate.ts";

export interface ContextPanelController extends ContextSink {
   isVisible(): boolean;
   setVisible(on: boolean): void;
   destroy(): void;
}

const VISIBLE_KEY = "dawn.hero.contextShown";
const LIST_H_KEY = "dawn.hero.contextListH"; // persisted list max-height (grip resize)
const POS_KEY = "dawn.hero.contextPos";
const PULSE_MS = 800;

/* The DAWN source_type -> a short tag + a color family (styled in context.css). Only calm
   phosphor hues; the alert red stays reserved for "needs you". */
function tier(sourceType: string): { label: string; family: string } {
   switch (sourceType) {
      case "internal":
         return { label: "INTERNAL", family: "internal" };
      case "external":
         return { label: "EXTERNAL", family: "external" };
      case "user-content":
         return { label: "USER", family: "user" };
      default:
         return { label: (sourceType || "source").toUpperCase(), family: "other" };
   }
}

/* The four score contributions, in display order. Labels are 3-letter mono captions. */
const BREAKDOWN: Array<{ key: keyof ContextItem["breakdown"]; cap: string; name: string }> = [
   { key: "semantic", cap: "SEM", name: "semantic" },
   { key: "recency", cap: "REC", name: "recency" },
   { key: "importance", cap: "IMP", name: "importance" },
   { key: "source", cap: "SRC", name: "source" }
];

export function mountContextPanel(root: HTMLElement): ContextPanelController {
   const el = document.createElement("div");
   el.id = "context";
   el.className = "context";
   addCorners(el);

   /* Header (the drag handle): title + a live count/filtered sub. */
   const head = document.createElement("div");
   head.className = "context-head";
   const titleEl = document.createElement("div");
   titleEl.className = "context-title";
   titleEl.textContent = "Context";
   const right = document.createElement("div");
   right.className = "context-head-right";
   const subEl = document.createElement("div");
   subEl.className = "context-sub";
   const helpBtn = document.createElement("button");
   helpBtn.type = "button";
   helpBtn.className = "context-help-btn";
   helpBtn.textContent = "?";
   helpBtn.setAttribute("aria-label", "How to read this panel");
   helpBtn.setAttribute("aria-haspopup", "dialog");
   helpBtn.setAttribute("aria-expanded", "false");
   right.append(subEl, helpBtn);
   head.append(titleEl, right);

   const list = document.createElement("div");
   list.className = "context-list";

   el.append(head, list);
   root.appendChild(el);

   /* Shared sizing / overflow-fade / grip-resize / hover-expand for the list body. */
   const card = makeListCard(el, list, { storageKey: LIST_H_KEY });

   /* Grab-and-move by the header only, so the rows stay interactive (the library model);
      the "?" is excluded so tapping it opens the popover instead of starting a drag. */
   const disposeMovable = makeMovable(el, {
      storageKey: POS_KEY,
      handle: ".context-head",
      ignore: ".context-help-btn"
   });

   const vis = makeVisibility(el, { storageKey: VISIBLE_KEY, offClass: "context-off" });
   /* Summonable: default hidden on first ever load (respect the operator's choice after). */
   if (localStorage.getItem(VISIBLE_KEY) === null) vis.setVisible(false);

   /* "?" help popover: a summonable "how to read this" card (calmer than an always-on
      legend, and a nice narration beat on stage). Click-toggle so it survives touch and
      stays open while you talk; dismiss on outside-click or Escape. Static copy, so plain
      textContent - it explains the tier tags and the four score bars. */
   const help = document.createElement("div");
   help.className = "context-help";
   help.setAttribute("role", "dialog");
   help.setAttribute("aria-label", "How to read the Context panel");
   const lead = document.createElement("p");
   lead.className = "context-help-lead";
   lead.textContent =
      "Each row is one thing DAWN pulled into context for this turn. The number is its blended score; the four bars are what drove it (tallest = the main reason).";
   help.append(lead);
   const addHelpGroup = (heading: string, rows: Array<[string, string]>): void => {
      const h = document.createElement("div");
      h.className = "context-help-h";
      h.textContent = heading;
      help.append(h);
      for (const [term, def] of rows) {
         const r = document.createElement("div");
         r.className = "context-help-row";
         const t = document.createElement("span");
         t.className = "context-help-term";
         t.textContent = term;
         const d = document.createElement("span");
         d.className = "context-help-def";
         d.textContent = def;
         r.append(t, d);
         help.append(r);
      }
   };
   addHelpGroup("WHERE IT CAME FROM", [
      ["INTERNAL", "DAWN's own memory: facts and preferences it saved."],
      ["EXTERNAL", "An outside source: a live feed, tool result, or lookup."],
      ["USER", "Your own content: something you wrote or sent."]
   ]);
   addHelpGroup("WHY IT WAS PULLED IN", [
      ["SEM", "Semantic — how closely its meaning matches what you just asked."],
      ["REC", "Recency — how fresh it is."],
      ["IMP", "Importance — how significant DAWN judged it when it saved it."],
      ["SRC", "Source — how much this kind of source is weighted for this turn."]
   ]);
   const note = document.createElement("p");
   note.className = "context-help-note";
   note.textContent =
      "A row that lights up gold (CITED) is one the model actually referenced in its answer — it appears when the reply finishes.";
   help.append(note);
   el.append(help);

   let helpOpen = false;
   let helpDocTimer = 0;
   const onHelpDocClick = (e: MouseEvent): void => {
      if (!help.contains(e.target as Node) && !helpBtn.contains(e.target as Node)) closeHelp();
   };
   const onHelpKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
         e.preventDefault();
         closeHelp();
      }
   };
   function closeHelp(): void {
      if (!helpOpen) return;
      helpOpen = false;
      help.classList.remove("open");
      helpBtn.setAttribute("aria-expanded", "false");
      window.clearTimeout(helpDocTimer);
      document.removeEventListener("click", onHelpDocClick);
      document.removeEventListener("keydown", onHelpKey);
   }
   const openHelp = (): void => {
      if (helpOpen) return;
      helpOpen = true;
      help.classList.add("open");
      helpBtn.setAttribute("aria-expanded", "true");
      /* Arm the outside-click close on the NEXT tick so the opening click doesn't self-close. */
      helpDocTimer = window.setTimeout(() => document.addEventListener("click", onHelpDocClick), 0);
      document.addEventListener("keydown", onHelpKey);
   };
   const onHelpClick = (): void => {
      if (helpOpen) closeHelp();
      else openHelp();
   };
   helpBtn.addEventListener("click", onHelpClick);

   /* --- state ------------------------------------------------------------- */
   let current: ContextTrace | null = null;
   /* item_ids the model cited this turn (from the late context_citations frame). Empty until
      that frame lands at turn end; a fresh trace resets it. Matched rows gold. */
   let citedIds = new Set<string>();
   let rowDisposers: Array<() => void> = [];
   let pulseTimer = 0;

   /* --- rendering --------------------------------------------------------- */
   const buildBars = (item: ContextItem): HTMLElement => {
      const bars = document.createElement("div");
      bars.className = "context-bars";
      /* Normalize per-item to the largest contribution so the tallest bar fills; the exact
         value rides the title. Negative contributions (penalties) read as an empty bar. */
      const max = Math.max(0.0001, ...BREAKDOWN.map((b) => Math.max(0, item.breakdown[b.key])));
      for (const b of BREAKDOWN) {
         const v = item.breakdown[b.key];
         const col = document.createElement("div");
         col.className = "context-bar";
         col.title = `${b.name} ${v.toFixed(3)}`;
         const track = document.createElement("div");
         track.className = "context-bar-track";
         const fill = document.createElement("div");
         fill.className = "context-bar-fill";
         fill.style.height = `${Math.round((Math.max(0, v) / max) * 100)}%`;
         track.appendChild(fill);
         const cap = document.createElement("span");
         cap.className = "context-bar-cap";
         cap.textContent = b.cap;
         col.append(track, cap);
         bars.append(col);
      }
      return bars;
   };

   const buildRow = (item: ContextItem): HTMLElement => {
      const row = document.createElement("div");
      row.className = "context-row";

      const rowHead = document.createElement("div");
      rowHead.className = "context-row-head";
      const t = tier(item.sourceType);
      const tags = document.createElement("div");
      tags.className = "context-row-tags";
      const tag = document.createElement("span");
      tag.className = `context-src family-${t.family}`;
      tag.textContent = t.label; // DAWN enum -> textContent
      tags.append(tag);
      /* Cited: the model referenced this row in its answer. Gold the row + a filled "CITED"
         badge (deliberately distinct from the outlined EXTERNAL tag's gold). Only memory rows
         carry a citeable item_id, so this never lands on external/user rows. */
      if (item.itemId !== "" && citedIds.has(item.itemId)) {
         row.classList.add("cited");
         const mark = document.createElement("span");
         mark.className = "context-cited-mark";
         mark.textContent = "CITED";
         mark.title = "The model cited this in its answer";
         tags.append(mark);
      }
      const score = document.createElement("span");
      score.className = "context-score";
      score.textContent = item.score.toFixed(2);
      rowHead.append(tags, score);
      row.append(rowHead);

      if (item.text) {
         const text = document.createElement("div");
         text.className = "context-text"; // clamped; click toggles full
         text.textContent = item.text; // untrusted (memory/model) -> textContent
         text.title = "Click to expand";
         rowDisposers.push(onActivate(text, () => text.classList.toggle("expanded")));
         row.append(text);
      }

      const foot = document.createElement("div");
      foot.className = "context-foot";
      foot.append(buildBars(item));
      const prov = item.provenance;
      if (prov && prov.conversationId) {
         const p = document.createElement("span");
         p.className = "context-prov";
         const span = prov.msgIdEnd && prov.msgIdEnd !== prov.msgIdStart ? `${prov.msgIdStart}–${prov.msgIdEnd}` : `${prov.msgIdStart}`;
         p.textContent = `conv ${prov.conversationId} · msg ${span}`;
         foot.append(p);
      }
      row.append(foot);
      return row;
   };

   const showEmpty = (msg: string): void => {
      const empty = document.createElement("div");
      empty.className = "context-empty";
      empty.textContent = msg;
      list.appendChild(empty);
   };

   const updateSub = (): void => {
      if (!current) {
         subEl.textContent = "idle";
         return;
      }
      const n = current.items.length;
      const filtered = current.rejections.reduce((s, r) => s + r.count, 0);
      subEl.textContent = n === 0 ? "nothing this turn" : `${n} pulled${filtered ? ` · ${filtered} filtered` : ""}`;
   };

   const render = (): void => {
      rowDisposers.forEach((d) => d());
      rowDisposers = [];
      list.replaceChildren();
      updateSub();

      if (!current) {
         showEmpty("Waiting for the next turn.");
         card.refresh();
         return;
      }
      if (current.items.length === 0) {
         showEmpty("No additional context for this turn.");
      } else {
         const items = [...current.items].sort((a, b) => b.score - a.score);
         list.append(...items.map(buildRow));
      }
      if (current.rejections.length > 0) {
         const rej = document.createElement("div");
         rej.className = "context-rejects";
         rej.textContent = `Filtered: ${current.rejections.map((r) => `${r.sourceId} (${r.count})`).join(", ")}`;
         list.append(rej);
      }
      card.refresh();
   };
   render();

   const pulse = (): void => {
      /* Restart the update-flash animation even on back-to-back turns (reflow trick). */
      el.classList.remove("context-pulse");
      void el.offsetWidth;
      el.classList.add("context-pulse");
      window.clearTimeout(pulseTimer);
      pulseTimer = window.setTimeout(() => el.classList.remove("context-pulse"), PULSE_MS);
   };

   /* --- sink -------------------------------------------------------------- */
   const controller: ContextPanelController = {
      show: (trace) => {
         current = trace;
         citedIds = new Set(); // a fresh turn: no citations yet (they arrive at turn end)
         render();
         pulse();
      },
      clear: () => {
         current = null;
         citedIds = new Set();
         render();
      },
      applyCitations: (conversationId, turnId, ids) => {
         /* Late overlay at turn end: gold the cited rows. Ignore a frame that doesn't match
            the trace on screen (a stale/older turn, or one we already replaced). */
         if (!current || current.conversationId !== conversationId || current.turnId !== turnId) return;
         citedIds = new Set(ids);
         render(); // rows rebuild with .cited -> the gold "lights up" (a CSS flash, see context.css)
      },
      isVisible: vis.isVisible,
      setVisible: vis.setVisible,
      destroy: () => {
         window.clearTimeout(pulseTimer);
         helpBtn.removeEventListener("click", onHelpClick);
         closeHelp(); // clears the doc-click timer + outside-click/Escape listeners
         rowDisposers.forEach((d) => d());
         card.destroy();
         disposeMovable();
         el.remove();
      }
   };
   return controller;
}
