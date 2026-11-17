/*
 * The Memory panel: what memory learned, a batch at a time (DAWN's memory_batches). Each time
 * memory consolidates a conversation it records what it did; this lists those batches newest
 * first, each resting at a one-line summary ("3 learned, 1 updated") that opens to its changes.
 * From there the user can undo a change (or every change of a batch), keep a candidate memory set
 * aside, or forget a fact memory suggested forgetting. Which button a change gets is DAWN's
 * call (its `action`); the panel draws only that one.
 *
 * Calm by design: a new batch arrives quietly (a brief ring on the panel when it's open, never a
 * notification card). Undo all and Forget take a named confirm (as in DAWN's WebUI); a single
 * Undo and Keep don't, since both can be taken back from the same list.
 *
 * Shown only on a DAWN that records batches; hidden until the user summons it from the Panels
 * menu. A movable view, outside the render seam. Every string from the record (memory text, the
 * model's reasons) is bound via textContent, never markup.
 */

import type {
   MemoryActionResult,
   MemoryBatch,
   MemoryBatchOp,
   MemoryBatchPage,
   MemoryBatchesSink
} from "../ingest/ingest.ts";
import { makeMovable } from "../render/movable.ts";
import { makeListCard } from "../render/list-card.ts";
import { addCorners } from "../render/corners.ts";
import { makeVisibility } from "../render/visibility.ts";
import { openDialog } from "../menu/dialog.ts";
import { relativeTime } from "../util/time.ts";
import { safeTimeZone } from "../util/tz.ts";
import { batchSummary, outsideText } from "../util/memory-text.ts";

export interface MemoryPanelController extends MemoryBatchesSink {
   setTimezone(tz: string): void;
   /* Offered at all: this DAWN records batches (the Panels menu lists it only then). */
   isAvailable(): boolean;
   isVisible(): boolean;
   setVisible(on: boolean): void;
   /* Show this batch: the panel comes up with it open and pointed out (a conversation's mark was
      clicked). One older than the pages read is shown too. */
   focusBatch(batch: MemoryBatch): void;
   destroy(): void;
}

export interface MemoryPanelOptions {
   /* Each returns false when nothing was sent (not connected). */
   /* The request's id, or 0 when nothing was sent (not connected). */
   list(before?: number): number;
   undo(batchId: number, opId: number | null): boolean;
   keep(batchId: number, opId: number): boolean;
   forget(factId: number): boolean;
   /* Open the conversation a batch came from (a read, like picking it in the picker). */
   open(conversationId: number): void;
}

const VISIBLE_KEY = "dawn.hero.memoryShown";
const LIST_H_KEY = "dawn.hero.memoryListH";
const POS_KEY = "dawn.hero.memoryPos";
const PULSE_MS = 800;
const HIGHLIGHT_MS = 4000;
const CLOCK_MS = 60_000;
/* Renames remembered while the list is held (each conversation's latest). */
const RENAMES_KEPT = 256;
/* The list always keeps at least a page (DAWN's page size, as the ingest asks for). */
const PAGE_FLOOR = 20;

const NOTHING_LEARNED =
   "Nothing learned yet. What memory learns shows here after a conversation ends.";
const NOT_CONNECTED = "Not connected. This fills in when DAWN is back.";
const NOT_SENT = "Not connected; try again in a moment.";

/* What each change says, before its text. An unknown kind shows as DAWN names it. */
const OP_LABELS: Record<string, string> = {
   added: "Learned",
   reinforced: "Confirmed",
   merged: "Merged",
   replaced: "Replaced",
   closed: "No longer true",
   linked: "Same as",
   pref_set: "Preference",
   dropped: "Not kept",
   deferred: "Set aside",
   suggested_forget: "Maybe forget"
};

/* A change's state when it isn't simply applied: its tag, tone, and what it means. */
const STATUS: Record<string, { label: string; tone: "muted" | "warn" | "good"; help: string }> = {
   undone: { label: "Undone", tone: "muted", help: "This was undone." },
   stale: {
      label: "Changed since",
      tone: "warn",
      help: "Changed since this batch, so it can no longer be undone."
   },
   kept: { label: "Kept", tone: "good", help: "You kept this." },
   consumed: { label: "Taken up later", tone: "muted", help: "A later batch decided this." },
   expired: { label: "Expired", tone: "muted", help: "Set aside too long ago." },
   proposed: { label: "Proposed", tone: "muted", help: "Waiting for your decision." }
};

/* How the counterpart line reads, by change. */
const TARGET_LABELS: Record<string, string> = {
   merged: "into",
   replaced: "by",
   closed: "by",
   linked: "with"
};

const ACTION_LABELS = { undo: "Undo", keep: "Keep", forget: "Forget" } as const;
const BUSY_LABELS = { undo: "Undoing…", keep: "Keeping…", forget: "Forgetting…" } as const;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function mountMemoryPanel(
   root: HTMLElement,
   opts: MemoryPanelOptions
): MemoryPanelController {
   const el = document.createElement("div");
   el.id = "memory";
   el.className = "memory memory-unavailable";
   el.setAttribute("role", "region");
   el.setAttribute("aria-label", "Memory: what was learned");
   addCorners(el);

   const head = document.createElement("div");
   head.className = "memory-head";
   const titleEl = document.createElement("div");
   titleEl.className = "memory-title";
   titleEl.textContent = "Memory";
   const subEl = document.createElement("div");
   subEl.className = "memory-sub";
   subEl.textContent = "Learned";
   head.append(titleEl, subEl);

   const list = document.createElement("div");
   list.className = "memory-list";
   list.setAttribute("role", "list");
   list.tabIndex = -1; // where the keyboard goes when its control leaves (an undone change)

   /* Spoken once when a new batch lands (the panel itself stays quiet). */
   const live = document.createElement("div");
   live.className = "memory-live";
   live.setAttribute("role", "status");
   live.setAttribute("aria-live", "polite");

   el.append(head, list, live);
   root.appendChild(el);

   const card = makeListCard(el, list, { storageKey: LIST_H_KEY });
   const disposeMovable = makeMovable(el, { storageKey: POS_KEY, handle: ".memory-head" });
   const vis = makeVisibility(el, {
      storageKey: VISIBLE_KEY,
      offClass: "memory-off",
      defaultVisible: false
   });

   /* --- state ------------------------------------------------------------- */
   let available = false;
   let tz: string | undefined;
   const batches = new Map<number, MemoryBatch>();
   /* Shown at all: the first page came. Until then pushes wait for it. */
   let loaded = false;
   /* A page on its way: the first (everything waits for it) or an older one (only its range). */
   let loading: "first" | "older" | null = null;
   /* Pushes that came while a page was on its way, for what that page will hold: applied over it
      when it lands (newer than the page), dropped with it if it fails. null = removed. */
   const pushedWhileLoading = new Map<number, MemoryBatch | null>();
   /* The latest title from each rename heard while the list is held, by conversation. DAWN
      sends the notice at once but queues pages and batch pushes, so one built before a rename
      can land after it: every batch that comes in takes the latest title heard. */
   const renamed = new Map<number, string>();
   let nextBefore: number | null = null;
   /* Every page asked for on this connection, oldest first (DAWN answers in order). Each reply
      settles the oldest; one asked before the panel let go of its list (hidden meanwhile) is no
      longer wanted, and its reply changes nothing. */
   let asked: Array<{ id: number; before: number | null; wanted: boolean }> = [];
   /* How many batches the pages brought: the list keeps at most that many (newest first), so new
      batches pushed over days push the oldest back behind "Show older" rather than piling up. */
   let paged = 0;
   /* The link is up: actions can be sent. */
   let online = true;
   let status: "idle" | "error" | "offline" = "idle";
   let errorText = "";
   let footNote = "";
   const expanded = new Set<number>();
   /* Buttons waiting on DAWN, by key (see busyKey). */
   const busy = new Set<string>();
   /* Undo and Keep share one slot per user at DAWN: while one runs, the others wait. */
   let slotBusy = false;
   /* The change a Keep just stored, pointed out for a moment (until highlightUntil). */
   let highlightOp = 0;
   let highlightUntil = 0;
   let highlightTimer = 0;
   /* Each Keep's batch as it was when clicked: the row the Keep stored is one that's new since. */
   const keepBefore = new Map<string, Set<number>>();
   let pulseTimer = 0;

   const busyKey = (action: string, batchId: number, opId: number | null): string =>
      `${action}:${batchId}:${opId ?? "all"}`;
   const forgetKey = (factId: number): string => `forget:${factId}`;

   const shownNow = (): boolean => available && vis.isVisible();

   /* --- reading ----------------------------------------------------------- */
   const requestPage = (before?: number): void => {
      if (loading) return;
      const id = opts.list(before);
      if (!id) {
         if (before === undefined && !loaded) status = "offline";
         else footNote = NOT_SENT;
         render();
         return;
      }
      loading = before === undefined ? "first" : "older";
      asked.push({ id, before: before ?? null, wanted: true });
      if (before === undefined) status = "idle";
      footNote = "";
      render();
   };

   /* Forget what's shown: a fresh first page brings it back (on the next show, or reconnect). */
   const unload = (): void => {
      loaded = false;
      loading = null;
      for (const a of asked) a.wanted = false; // their replies still come, and settle nothing
      renamed.clear(); // the fresh first page has the titles as they are
      pinned.clear();
      wanted = null; // a batch asked for before belongs to that list
      batches.clear();
      expanded.clear();
      pushedWhileLoading.clear();
      nextBefore = null;
      paged = 0;
      footNote = "";
   };

   /* Keep the newest `paged` batches; the rest wait behind "Show older" again. */
   const trim = (): void => {
      /* A batch shown because it was asked for (focusBatch) stays, outside the count. */
      const ordered = [...batches.keys()].filter((id) => !pinned.has(id)).sort((a, b) => b - a);
      if (ordered.length <= Math.max(paged, PAGE_FLOOR)) return;
      const keep = ordered.slice(0, Math.max(paged, PAGE_FLOOR));
      for (const id of ordered.slice(keep.length)) drop(id);
      nextBefore = keep[keep.length - 1];
   };

   /* A batch asked for (focusBatch), shown once the list is. */
   let wanted: MemoryBatch | null = null;
   /* Batches shown because they were asked for, older than the pages read. */
   const pinned = new Set<number>();
   let lit = 0; // the batch pointed out for a moment (until litUntil)
   let litUntil = 0;
   let litTimer = 0;

   const applyFocus = (): void => {
      if (!wanted || !loaded || !shownNow()) return;
      const b = wanted;
      wanted = null;
      if (!batches.has(b.batchId)) {
         batches.set(b.batchId, retitle(b));
         pinned.add(b.batchId);
      }
      expanded.add(b.batchId);
      lit = b.batchId;
      litUntil = Date.now() + HIGHLIGHT_MS;
      window.clearTimeout(litTimer);
      litTimer = window.setTimeout(() => {
         lit = 0;
         renderIfShown();
      }, HIGHLIGHT_MS);
      render();
      const head = list.querySelector<HTMLElement>(`[data-focus-key="batch:${b.batchId}"]`);
      head?.scrollIntoView?.({ block: "nearest" });
      head?.focus();
   };

   /* Draw only what's on screen (a hidden panel is rebuilt when it's next shown). */
   const renderIfShown = (): void => {
      if (shownNow()) render();
   };

   /* The first page, once the panel is on screen and DAWN offers it. */
   const ensureLoaded = (): void => {
      if (shownNow() && !loaded && !loading) requestPage();
   };

   /* A batch into the shown set. One older than the next page's cursor is left to that page. */
   const place = (batch: MemoryBatch): boolean => {
      if (!batches.has(batch.batchId) && nextBefore !== null && batch.batchId < nextBefore) {
         return false;
      }
      const isNew = !batches.has(batch.batchId);
      batches.set(batch.batchId, batch);
      /* While an older page is on its way, its cursor must hold: trim when it lands. */
      if (isNew && loading !== "older") trim();
      return isNew;
   };

   /* What came for a page while it was on its way, now that the page set the loaded range: a
      removal everywhere, an update only for a batch within the range (an older one is left to its
      own page). Then the list is trimmed back to what the pages brought. */
   /* A batch with the latest title heard for its conversation (only one DAWN titles). */
   const retitle = (b: MemoryBatch): MemoryBatch => {
      const title = b.conversationId !== null ? renamed.get(b.conversationId) : undefined;
      return title !== undefined && typeof b.conversationTitle === "string"
         ? { ...b, conversationTitle: title }
         : b;
   };

   const replayHeld = (): void => {
      for (const [id, b] of pushedWhileLoading) {
         /* Within the loaded range, or a batch shown because it was asked for (focusBatch). */
         const shown = nextBefore === null || id >= nextBefore || pinned.has(id);
         if (!b) drop(id);
         else if (shown) batches.set(id, retitle(b));
      }
      pushedWhileLoading.clear();
      trim();
   };

   /* A push for what the page on its way will hold: that page's range (the first page holds
      everything; an older page, what's behind the cursor). */
   const forThePage = (batchId: number): boolean =>
      loading === "first" || (loading === "older" && nextBefore !== null && batchId < nextBefore);

   const drop = (batchId: number): void => {
      batches.delete(batchId);
      expanded.delete(batchId);
      pinned.delete(batchId);
   };

   /* --- rendering --------------------------------------------------------- */
   const tag = (text: string, tone: string, help?: string): HTMLElement => {
      const t = document.createElement("span");
      t.className = `memory-tag tone-${tone}`;
      t.textContent = text;
      if (help) t.title = help;
      return t;
   };

   const actionButton = (
      action: "undo" | "keep" | "forget",
      batch: MemoryBatch,
      op: MemoryBatchOp | null
   ): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `memory-action action-${action}`;
      const key =
         action === "forget" && op?.factId
            ? forgetKey(op.factId)
            : busyKey(action, batch.batchId, op ? op.opId : null);
      btn.dataset.focusKey = key;
      const isBusy = busy.has(key);
      btn.textContent = isBusy ? BUSY_LABELS[action] : op ? ACTION_LABELS[action] : "Undo all";
      btn.disabled = isBusy || !online || (action !== "forget" && slotBusy);
      const what = op ? (op.text ?? "a forgotten memory") : batchSummary(batch);
      btn.setAttribute("aria-label", `${op ? ACTION_LABELS[action] : "Undo all"}: ${what}`);
      btn.addEventListener("click", () => act(action, batch, op));
      return btn;
   };

   const buildOp = (op: MemoryBatchOp, batch: MemoryBatch): HTMLElement => {
      const row = document.createElement("div");
      row.className = "memory-op";
      row.setAttribute("role", "listitem");
      row.dataset.status = op.status;
      if (op.opId === highlightOp) {
         row.classList.add("memory-op-new");
         /* A redraw mid-glow carries on from where it was rather than starting over. */
         const elapsed = HIGHLIGHT_MS - Math.max(0, highlightUntil - Date.now());
         row.style.animationDelay = `-${elapsed}ms`;
      }

      const label = document.createElement("span");
      label.className = "memory-op-label";
      label.textContent = OP_LABELS[op.op] ?? op.op;
      const body = document.createElement("span");
      body.className = "memory-op-text";
      body.textContent = op.text ?? "(forgotten)";
      row.append(label, body);
      if (op.action) row.append(actionButton(op.action, batch, op));

      const meta = document.createElement("div");
      meta.className = "memory-op-meta";
      const st = STATUS[op.status];
      if (st) meta.append(tag(st.label, st.tone, st.help));
      /* The batch says what it read once; a change only when it differs (one from another batch). */
      if (op.outside && (!batch.outside || op.outsideFrom !== batch.outsideFrom)) {
         meta.append(
            tag(outsideText(op), "outside", "Learned while reading text someone else wrote")
         );
      }
      if (op.targetText) {
         const target = document.createElement("span");
         target.className = "memory-op-target";
         const since =
            op.targetStatus === "gone"
               ? " (since deleted)"
               : op.targetStatus === "superseded"
                 ? " (since changed)"
                 : "";
         target.textContent = `${TARGET_LABELS[op.op] ?? "→"} ${op.targetText}${since}`;
         meta.append(target);
      }
      if (op.sources.length > 0) {
         const sources = document.createElement("span");
         sources.className = "memory-op-target";
         sources.textContent = `Merged in: ${op.sources.map((s) => s.text ?? "(forgotten)").join("; ")}`;
         meta.append(sources);
      }
      if (meta.childNodes.length > 0) row.append(meta);

      if (op.reason) {
         const reason = document.createElement("div");
         reason.className = "memory-op-reason";
         const who = document.createElement("span");
         who.className = "memory-op-reason-by";
         /* The model's words are shown as its own. */
         who.textContent = op.reasonBy === "model" ? "Model's reason: " : "Reason: ";
         reason.append(who, document.createTextNode(op.reason));
         row.append(reason);
      }
      return row;
   };

   const buildBatch = (batch: MemoryBatch): HTMLElement => {
      const box = document.createElement("div");
      box.className = "memory-batch";
      box.setAttribute("role", "listitem");
      box.dataset.status = batch.status;
      if (batch.batchId === lit) {
         box.classList.add("memory-batch-lit");
         /* A redraw mid-glow carries on from where it was rather than starting over. */
         box.style.animationDelay = `-${HIGHLIGHT_MS - Math.max(0, litUntil - Date.now())}ms`;
      }
      const open = expanded.has(batch.batchId);
      if (open) box.classList.add("open");

      /* The resting line: a summary, when, and its state. Toggles the changes. */
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "memory-batch-head";
      toggle.dataset.focusKey = `batch:${batch.batchId}`;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      const summary = document.createElement("span");
      summary.className = "memory-batch-summary";
      summary.textContent = batchSummary(batch);
      const when = document.createElement("time");
      when.className = "memory-when";
      if (batch.createdAt > 0) {
         when.dateTime = new Date(batch.createdAt * 1000).toISOString();
         when.dataset.at = String(batch.createdAt);
         when.textContent = relativeTime(batch.createdAt, tz);
         when.title = new Date(batch.createdAt * 1000).toLocaleString([], {
            timeZone: safeTimeZone(tz),
            dateStyle: "medium",
            timeStyle: "short"
         });
      }
      toggle.addEventListener("click", () => {
         if (expanded.has(batch.batchId)) expanded.delete(batch.batchId);
         else expanded.add(batch.batchId);
         render();
      });
      /* Headed by the conversation it came from, when DAWN names it; the title opens it. */
      const convId = batch.conversationId;
      if (typeof batch.conversationTitle === "string" && convId !== null) {
         const titleRow = document.createElement("div");
         titleRow.className = "memory-batch-title-row";
         const conv = document.createElement("button");
         conv.type = "button";
         conv.className = "memory-batch-conv";
         conv.dataset.focusKey = `conv:${batch.batchId}`;
         const name = batch.conversationTitle.trim() || "Untitled conversation";
         conv.textContent = name;
         conv.title = `${name}\nOpen this conversation`; // the whole title when it's cut short
         conv.setAttribute("aria-label", `Open the conversation: ${name}`);
         /* Opening it moves the session: not while the link is down (it would point turns at a
            conversation whose transcript never loaded). */
         conv.disabled = !online;
         conv.addEventListener("click", () => opts.open(convId));
         titleRow.append(conv, when);
         toggle.append(summary);
         box.append(titleRow, toggle);
      } else {
         toggle.append(summary, when);
         box.append(toggle);
      }

      /* Its state, unseen while closed (an undone batch's summary steps back instead), is named
         for a screen reader all the same. */
      const state =
         batch.status === "undone" ? "Undone" : batch.status === "partial" ? "Partly undone" : "";
      if (state) {
         toggle.setAttribute(
            "aria-label",
            `${batchSummary(batch)}, ${when.textContent || "earlier"}, ${state.toLowerCase()}`
         );
      }

      if (open) {
         /* Opened: its state and what outside text it read come first. */
         const tags = document.createElement("div");
         tags.className = "memory-batch-tags";
         if (state) tags.append(tag(state, "muted"));
         if (batch.outside) {
            tags.append(
               tag(
                  outsideText(batch),
                  "outside",
                  "This conversation included text someone else wrote"
               )
            );
         }
         if (tags.childNodes.length > 0) box.append(tags);
         const ops = document.createElement("div");
         ops.className = "memory-ops";
         ops.setAttribute("role", "list");
         if (batch.ops.length === 0) {
            const none = document.createElement("div");
            none.className = "memory-note";
            none.textContent = "Nothing to show for this batch.";
            ops.append(none);
         }
         for (const op of batch.ops) ops.append(buildOp(op, batch));
         box.append(ops);
         if (batch.ops.filter((o) => o.action === "undo").length > 1) {
            const foot = document.createElement("div");
            foot.className = "memory-batch-foot";
            foot.append(actionButton("undo", batch, null));
            box.append(foot);
         }
      }
      return box;
   };

   const note = (text: string, retry?: () => void): HTMLElement => {
      const n = document.createElement("div");
      n.className = "memory-note";
      n.textContent = text;
      if (retry) {
         const btn = document.createElement("button");
         btn.type = "button";
         btn.className = "memory-action";
         btn.dataset.focusKey = "retry";
         btn.textContent = "Try again";
         btn.addEventListener("click", retry);
         n.append(" ", btn);
      }
      return n;
   };

   const render = (): void => {
      /* The keyboard stays on the same control across a redraw. */
      const focused = document.activeElement as HTMLElement | null;
      const focusKey = focused && list.contains(focused) ? focused.dataset.focusKey : undefined;
      list.replaceChildren();

      if (!loaded) {
         if (status === "error") {
            list.append(note(errorText, () => requestPage()));
         } else if (status === "offline") {
            list.append(note(NOT_CONNECTED));
         } else {
            list.append(note("Loading…"));
         }
      } else if (batches.size === 0 && nextBefore === null) {
         list.append(note(NOTHING_LEARNED));
      } else {
         const ordered = [...batches.values()].sort((a, b) => b.batchId - a.batchId);
         list.append(...ordered.map(buildBatch));
         if (nextBefore !== null) {
            const more = document.createElement("button");
            more.type = "button";
            more.className = "memory-more";
            more.dataset.focusKey = "more";
            more.textContent = loading === "older" ? "Loading…" : "Show older";
            more.disabled = loading !== null || !online;
            const cursor = nextBefore;
            more.addEventListener("click", () => requestPage(cursor));
            list.append(more);
         }
         if (footNote) list.append(note(footNote));
      }

      if (focusKey) restoreFocus(focusKey);
      card.refresh();
   };

   /* The keyboard back on the control with this key, or the list when it's gone or busy. */
   function restoreFocus(key: string): void {
      focusTarget(key).focus();
   }

   /* The control with this key now (a redraw replaces controls), or the list when it's gone or
      busy. */
   function focusTarget(key: string): HTMLElement {
      const again = list.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`);
      return again && !(again as HTMLButtonElement).disabled ? again : list;
   }

   /* Refresh the relative times while open ("just now" ages). */
   const clock = window.setInterval(() => {
      if (!shownNow()) return;
      list.querySelectorAll<HTMLElement>(".memory-when[data-at]").forEach((t) => {
         t.textContent = relativeTime(Number(t.dataset.at), tz);
      });
   }, CLOCK_MS);

   const pulse = (): void => {
      el.classList.remove("memory-pulse");
      void el.offsetWidth;
      el.classList.add("memory-pulse");
      window.clearTimeout(pulseTimer);
      pulseTimer = window.setTimeout(() => el.classList.remove("memory-pulse"), PULSE_MS);
   };

   /* --- writing (only from the buttons) ------------------------------------- */
   /* A confirm hands the keyboard back by key (returnFocus), however it closes: a push that
      redrew the list meanwhile replaced the button that opened it. */

   function act(
      action: "undo" | "keep" | "forget",
      batch: MemoryBatch,
      op: MemoryBatchOp | null
   ): void {
      if (action === "forget") {
         const factId = op?.factId;
         if (!op || !factId || busy.has(forgetKey(factId))) return;
         openDialog({
            title: "Forget this memory?",
            returnFocus: () => focusTarget(forgetKey(factId)),
            body: `${op.text ? `"${op.text}"` : "This memory"} will be forgotten, and memory won't learn it again. This cannot be undone.`,
            actions: [
               { label: "Keep it", onClick: () => {}, autofocus: true },
               {
                  label: "Forget",
                  danger: true,
                  onClick: () => {
                     if (opts.forget(factId)) busy.add(forgetKey(factId));
                     else footNote = NOT_SENT;
                     render();
                  }
               }
            ]
         });
         return;
      }
      if (slotBusy) return;
      const opId = op ? op.opId : null;
      const key = busyKey(action, batch.batchId, opId);
      const run = (): void => {
         const sent =
            action === "keep" && opId !== null
               ? opts.keep(batch.batchId, opId)
               : opts.undo(batch.batchId, opId);
         if (sent) {
            busy.add(key);
            slotBusy = true;
            footNote = "";
            if (action === "keep") {
               keepBefore.set(key, new Set(batches.get(batch.batchId)?.ops.map((o) => o.opId)));
            }
         } else {
            footNote = NOT_SENT;
         }
         render();
      };
      if (action === "undo" && op === null) {
         const n = batch.ops.filter((o) => o.action === "undo").length;
         openDialog({
            title: `Undo ${plural(n, "change", "changes")}?`,
            returnFocus: () => focusTarget(key),
            body: `${batchSummary(batch)}. What changed since stays as it is.`,
            actions: [
               { label: "Cancel", onClick: () => {}, autofocus: true },
               {
                  label: "Undo all",
                  danger: true,
                  onClick: run
               }
            ]
         });
         return;
      }
      run();
   }

   /* --- the sink ------------------------------------------------------------ */
   const controller: MemoryPanelController = {
      setAvailable(on) {
         if (on === available) return;
         available = on;
         el.classList.toggle("memory-unavailable", !on);
         if (!on) {
            unload();
            return;
         }
         ensureLoaded();
      },
      setPage(page: MemoryBatchPage) {
         /* The request it answers: the one it names (request_refs), else the oldest page asked
            for this cursor (replies come in order). One no longer wanted (or a
            reply nothing asked for) changes nothing, and leaves the page that is wanted still
            loading. */
         const at = asked.findIndex((a) =>
            page.request !== undefined ? a.id === page.request : a.before === page.before
         );
         if (at < 0) return;
         const [mine] = asked.splice(at, 1);
         if (!mine.wanted) return;
         loading = null;
         const first = page.before === null;
         if (page.error) {
            /* What came for the failed page goes with it, except updates to a batch shown because
               it was asked for (its own state); trims held for it run now. */
            for (const [id, b] of pushedWhileLoading) {
               if (!pinned.has(id)) continue;
               if (b) batches.set(id, retitle(b));
               else drop(id);
            }
            pushedWhileLoading.clear();
            if (first && !loaded) {
               status = "error";
               errorText = page.error;
            } else {
               footNote = page.error;
               trim();
            }
            render();
            return;
         }
         if (first) {
            batches.clear();
            pinned.clear();
            expanded.clear();
            loaded = true;
            status = "idle";
            paged = 0;
         }
         for (const b of page.batches) batches.set(b.batchId, retitle(b));
         paged += page.batches.length;
         nextBefore = page.nextBefore;
         replayHeld();
         render();
         applyFocus(); // a batch asked for while the list was on its way
      },
      upsertBatch(pushed) {
         const batch = retitle(pushed);
         /* The batch a mark asked for, if it's still on its way to the list: its newest state. */
         if (wanted?.batchId === batch.batchId) wanted = batch;
         if (forThePage(batch.batchId)) {
            pushedWhileLoading.set(batch.batchId, batch);
            return;
         }
         if (!loaded) return; // the first page will bring it
         const isNew = place(batch);
         renderIfShown();
         if (isNew && batch.status === "applied" && shownNow()) {
            live.textContent = `Memory updated: ${batchSummary(batch)}`;
            pulse();
         }
      },
      removeBatch(batchId) {
         if (wanted?.batchId === batchId) wanted = null; // gone: nothing to show
         if (forThePage(batchId)) pushedWhileLoading.set(batchId, null);
         if (!batches.has(batchId)) return;
         drop(batchId);
         renderIfShown();
      },
      renameConversation(conversationId, title) {
         let changed = false;
         for (const [id, b] of batches) {
            /* Only a batch DAWN titles: one from an older DAWN stays untitled like the rest. */
            if (b.conversationId !== conversationId || typeof b.conversationTitle !== "string")
               continue;
            batches.set(id, { ...b, conversationTitle: title });
            changed = true;
         }
         /* And whatever comes in later: a page or push built before this rename (see renamed).
            Bounded: the oldest heard goes first. */
         renamed.delete(conversationId);
         renamed.set(conversationId, title);
         if (renamed.size > RENAMES_KEPT) renamed.delete(renamed.keys().next().value as number);
         for (const [id, b] of pushedWhileLoading) if (b) pushedWhileLoading.set(id, retitle(b));
         if (changed) renderIfShown();
      },
      actionDone(result: MemoryActionResult) {
         if (result.kind === "forget") {
            busy.delete(forgetKey(result.factId));
         } else {
            /* A reply ends the action it names: a late one (an Undo started before a reconnect,
               answered after it) can't end a newer action. One that names nothing usable (DAWN
               sent no ids) ends the one running, as DAWN runs one per user at a time. */
            const key = busyKey(result.kind, result.batchId, result.opId);
            const named = result.batchId > 0 && (result.kind === "undo" || result.opId > 0);
            for (const k of [...busy]) {
               if (k.startsWith("forget:")) continue;
               if (named ? k === key : k.startsWith(`${result.kind}:`)) busy.delete(k);
            }
            slotBusy = [...busy].some((k) => !k.startsWith("forget:"));
            const before = keepBefore.get(key);
            keepBefore.delete(key);
            /* Point out the row a Keep stored: one that's new in the batch since the click. */
            if (result.kind === "keep" && result.ok && result.factId !== null && before) {
               const kept = batches
                  .get(result.batchId)
                  ?.ops.find((o) => o.factId === result.factId && !before.has(o.opId));
               if (kept) {
                  highlightOp = kept.opId;
                  highlightUntil = Date.now() + HIGHLIGHT_MS;
                  window.clearTimeout(highlightTimer);
                  highlightTimer = window.setTimeout(() => {
                     highlightOp = 0;
                     renderIfShown();
                  }, HIGHLIGHT_MS);
               }
            }
         }
         renderIfShown();
      },
      linkDown() {
         /* Nothing in flight will be answered: the buttons wait for the link. */
         online = false;
         if (loading === "first" || !loaded) status = "offline";
         loading = null;
         asked = []; // the closed socket answers nothing more
         pushedWhileLoading.clear();
         busy.clear();
         keepBefore.clear();
         slotBusy = false;
         renderIfShown();
      },
      linkUp() {
         /* What changed meanwhile: a fresh first page (now if open, else when it's next shown). */
         online = true;
         /* A first page asked on this connection already (the same connect's setAvailable) is
            the fresh one: a link loss cancels any older request. */
         if (loading === "first") return;
         unload();
         if (shownNow()) requestPage();
      },
      setTimezone(zone) {
         if (zone === tz) return;
         tz = zone;
         if (loaded) renderIfShown();
      },
      isAvailable: () => available,
      isVisible: vis.isVisible,
      setVisible(on) {
         vis.setVisible(on);
         if (!on) {
            /* Hidden: let go of the list (it's read fresh when next shown). */
            unload();
            render();
            return;
         }
         render();
         ensureLoaded();
      },
      focusBatch(batch) {
         if (!available) return;
         wanted = batch;
         if (!vis.isVisible())
            controller.setVisible(true); // reads the first page, then focuses
         else applyFocus();
      },
      destroy() {
         window.clearTimeout(litTimer);
         window.clearInterval(clock);
         window.clearTimeout(pulseTimer);
         window.clearTimeout(highlightTimer);
         card.destroy();
         disposeMovable();
         el.remove();
      }
   };
   render();
   return controller;
}
