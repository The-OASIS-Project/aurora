/*
 * The conversation picker: menu-band chrome (a peer of the menubar), fixed in the top
 * band between the clock and the center menu - NOT a movable instrument card. It rests
 * collapsed as a single "Conversations" header and expands downward as a dropdown
 * overlay: a search row, a "+ New" button, and a grouped, paginating list of the user's
 * conversations.
 *
 * Seam: this is request/response chrome (like the calendar/HA boards), driven by a
 * ConversationListSink and reaching DAWN only through the opts.on* callbacks wired in
 * main.ts. It holds no pixels above the seam and no color literals - everything is
 * tokens (or color-mix of tokens) in conversations.css.
 *
 * Security: every DAWN-sourced string (title, origin, the rename input value) is bound
 * via textContent / .value, never a template literal into markup - the conversation_renamed
 * push is AI-authored (auto-title) and arrives unsolicited, so the discipline must hold.
 */

import type { ConversationListSink, ConversationMeta } from "../ingest/ingest.ts";
import { addCorners } from "../render/corners.ts";
import { onActivate } from "../render/activate.ts";
import { openDialog } from "../menu/dialog.ts";
import { relativeTime, dayBucket } from "../util/time.ts";

export interface ConversationPickerOptions {
   onLoad(id: number): void;
   onNew(): void;
   onSearch(query: string, content: boolean): void;
   onRename(id: number, title: string): void;
   onDelete(id: number): void;
   onPin(id: number, pinned: boolean): void;
   /* Request the next page (server offset = current loaded count). */
   onLoadMore(offset: number): void;
}

export interface ConversationPickerController extends ConversationListSink {
   destroy(): void;
}

const OPEN_KEY = "dawn.hero.conversationsOpen"; // default collapsed (absent/"false")
const SEARCH_DEBOUNCE_MS = 300;

/* The origin badge: a label plus the class that colors it, so voice / messaging /
   briefing each read as a distinct channel. `messaging:<provider>` carries an
   attacker-influenceable provider substring; it only ever becomes textContent below. */
function originBadge(origin: string): { label: string; cls: string } | null {
   if (origin === "voice") return { label: "voice", cls: "cpick-badge-voice" };
   if (origin === "briefing") return { label: "briefing", cls: "cpick-badge-briefing" };
   if (origin.startsWith("messaging:")) {
      const provider = origin.slice("messaging:".length);
      const label = provider ? provider[0].toUpperCase() + provider.slice(1) : "message";
      return { label, cls: "cpick-badge-msg" };
   }
   return null; // webui / unknown -> no badge
}

export function mountConversationPicker(
   root: HTMLElement,
   opts: ConversationPickerOptions
): ConversationPickerController {
   const el = document.createElement("div");
   el.id = "conversations";
   el.className = "cpick";
   addCorners(el);

   /* Header (the collapsed rest state): a toggle (caret + title) plus an always-visible
      "+ New" so starting a fresh chat is one click from any state. The toggle and the
      button are siblings so clicking "+ New" never also collapses/expands the panel. */
   const head = document.createElement("div");
   head.className = "cpick-head";
   const toggle = document.createElement("div");
   toggle.className = "cpick-toggle";
   const caret = document.createElement("span");
   caret.className = "cpick-caret";
   caret.setAttribute("aria-hidden", "true");
   const title = document.createElement("span");
   title.className = "cpick-title";
   title.textContent = "Conversations";
   toggle.append(caret, title);
   const newBtn = document.createElement("button");
   newBtn.type = "button";
   newBtn.className = "cpick-new";
   newBtn.textContent = "+ New";
   head.append(toggle, newBtn);

   /* Dropdown body. */
   const panel = document.createElement("div");
   panel.className = "cpick-panel";

   const tools = document.createElement("div");
   tools.className = "cpick-tools";

   const searchWrap = document.createElement("div");
   searchWrap.className = "cpick-search";
   const searchInput = document.createElement("input");
   searchInput.type = "text";
   searchInput.className = "cpick-search-input";
   searchInput.placeholder = "Search conversations";
   searchInput.setAttribute("aria-label", "Search conversations");
   const searchClear = document.createElement("button");
   searchClear.type = "button";
   searchClear.className = "cpick-search-clear";
   searchClear.setAttribute("aria-label", "Clear search");
   searchClear.textContent = "×"; // ×
   searchWrap.append(searchInput, searchClear);

   const contentRow = document.createElement("label");
   contentRow.className = "cpick-content";
   const contentCheck = document.createElement("input");
   contentCheck.type = "checkbox";
   const contentText = document.createElement("span");
   contentText.textContent = "Message content";
   contentRow.append(contentCheck, contentText);

   tools.append(searchWrap, contentRow);

   const listEl = document.createElement("div");
   listEl.className = "cpick-list";

   panel.append(tools, listEl);
   el.append(head, panel);
   root.appendChild(el);

   /* --- state ------------------------------------------------------------- */
   let listItems: ConversationMeta[] = []; // the paginated full list
   let searchItems: ConversationMeta[] = []; // current search results
   let total = 0; // server total for the full list (pagination stop)
   let activeId = 0;
   let tz = "";
   const unread = new Set<string>(); // String(id) keys (WebUI-consistent)
   let awaitingPage = false; // a load-more request is in flight
   let editingId = 0; // row currently in inline-rename (0 = none)

   const isSearching = (): boolean => searchInput.value.trim().length > 0;
   const viewItems = (): ConversationMeta[] => (isSearching() ? searchItems : listItems);

   /* Collapse, persisted, default-collapsed (an absent/"false" flag stays closed). */
   let open = localStorage.getItem(OPEN_KEY) === "true";
   const applyOpen = (): void => {
      el.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) searchInput.focus();
   };

   /* --- rendering --------------------------------------------------------- */
   const buildBadges = (c: ConversationMeta): HTMLElement | null => {
      const badges: HTMLElement[] = [];
      const add = (cls: string, label: string): void => {
         const b = document.createElement("span");
         b.className = `cpick-badge ${cls}`;
         b.textContent = label; // DAWN-influenced (origin) -> textContent only
         badges.push(b);
      };
      if (c.isPrivate) add("cpick-badge-private", "private");
      const ob = originBadge(c.origin);
      if (ob) add(ob.cls, ob.label);
      if (!badges.length) return null;
      const wrap = document.createElement("span");
      wrap.className = "cpick-badges";
      wrap.append(...badges);
      return wrap;
   };

   const buildRow = (c: ConversationMeta): HTMLElement => {
      const row = document.createElement("div");
      row.className = "cpick-row";
      row.dataset.id = String(c.id);
      if (c.id === activeId) row.classList.add("active");
      if (unread.has(String(c.id))) row.classList.add("unread");

      const main = document.createElement("div");
      main.className = "cpick-row-main";

      const titleEl = document.createElement("span");
      titleEl.className = "cpick-row-title";
      titleEl.textContent = c.title || "Untitled"; // DAWN/AI text -> textContent

      const meta = document.createElement("span");
      meta.className = "cpick-row-meta";
      const time = document.createElement("span");
      time.className = "cpick-row-time";
      time.textContent = relativeTime(c.updatedAt, tz);
      const count = document.createElement("span");
      count.className = "cpick-row-count";
      count.textContent = `${c.messageCount} msg`;
      meta.append(time, count);
      const badges = buildBadges(c);
      if (badges) meta.append(badges);

      main.append(titleEl, meta);
      /* Clicking the row body loads it (row actions stop propagation). */
      const disposeLoad = onActivate(main, () => {
         if (editingId) return;
         opts.onLoad(c.id);
      });
      rowDisposers.push(disposeLoad);

      const actions = document.createElement("div");
      actions.className = "cpick-row-actions";
      const act = (cls: string, label: string, fn: () => void): void => {
         const b = document.createElement("button");
         b.type = "button";
         b.className = `cpick-act ${cls}`;
         b.setAttribute("aria-label", label);
         b.title = label;
         b.addEventListener("click", (e) => {
            e.stopPropagation();
            fn();
         });
         actions.append(b);
      };
      act("cpick-act-pin", c.isPinned ? "Unpin" : "Pin", () => togglePin(c));
      act("cpick-act-rename", "Rename", () => beginRename(row, c));
      act("cpick-act-delete", "Delete", () => confirmDelete(c));
      if (c.isPinned) row.classList.add("pinned");

      row.append(main, actions);
      return row;
   };

   const buildGroup = (label: string, items: ConversationMeta[]): HTMLElement => {
      const group = document.createElement("div");
      group.className = "cpick-group";
      const header = document.createElement("div");
      header.className = "cpick-group-head";
      header.textContent = label;
      group.append(header, ...items.map(buildRow));
      return group;
   };

   /* Disposers for per-row onActivate listeners, cleared on each full render. */
   let rowDisposers: Array<() => void> = [];

   const render = (opts2: { append?: boolean } = {}): void => {
      const prevScroll = listEl.scrollTop;
      rowDisposers.forEach((d) => d());
      rowDisposers = [];
      listEl.replaceChildren();

      const items = viewItems();
      if (items.length === 0) {
         const empty = document.createElement("div");
         empty.className = "cpick-empty";
         empty.textContent = isSearching() ? "No matches" : "No conversations yet";
         listEl.appendChild(empty);
         return;
      }

      if (isSearching()) {
         /* Flat, relevance-as-returned; no pinned section or date groups for a filtered view. */
         listEl.append(...items.map(buildRow));
      } else {
         const pinned = items.filter((c) => c.isPinned);
         if (pinned.length) listEl.appendChild(buildGroup("Pinned", pinned));
         /* Items arrive sorted by updatedAt desc, so first-seen bucket order is already
            chronological (Today, Yesterday, This Week, then months descending). */
         const buckets = new Map<string, ConversationMeta[]>();
         for (const c of items) {
            if (c.isPinned) continue;
            const key = dayBucket(c.updatedAt, tz);
            const bucket = buckets.get(key);
            if (bucket) bucket.push(c);
            else buckets.set(key, [c]);
         }
         for (const [label, group] of buckets) listEl.appendChild(buildGroup(label, group));
      }

      /* An append keeps the reading position (new rows are added at the bottom). */
      if (opts2.append) listEl.scrollTop = prevScroll;
   };

   /* --- mutations (optimistic; ingest refetches only on failure) ---------- */
   const patchLocal = (id: number, fn: (c: ConversationMeta) => void): void => {
      for (const arr of [listItems, searchItems]) {
         const c = arr.find((x) => x.id === id);
         if (c) fn(c);
      }
   };

   const togglePin = (c: ConversationMeta): void => {
      const next = !c.isPinned;
      patchLocal(c.id, (x) => (x.isPinned = next));
      render();
      opts.onPin(c.id, next);
   };

   const beginRename = (row: HTMLElement, c: ConversationMeta): void => {
      if (editingId) return;
      editingId = c.id;
      const titleEl = row.querySelector<HTMLElement>(".cpick-row-title");
      if (!titleEl) return;
      const input = document.createElement("input");
      input.type = "text";
      input.className = "cpick-rename-input";
      input.value = c.title || ""; // property assignment, not markup - safe
      titleEl.replaceWith(input);
      input.focus();
      input.select();
      const commit = (): void => {
         if (editingId !== c.id) return;
         editingId = 0;
         const next = input.value.trim();
         if (next && next !== c.title) {
            patchLocal(c.id, (x) => (x.title = next));
            opts.onRename(c.id, next);
         }
         render();
      };
      const cancel = (): void => {
         if (editingId !== c.id) return;
         editingId = 0;
         render();
      };
      input.addEventListener("keydown", (e) => {
         if (e.key === "Enter") {
            e.preventDefault();
            commit();
         } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
         }
      });
      input.addEventListener("blur", commit);
   };

   const confirmDelete = (c: ConversationMeta): void => {
      /* Named, cascade-explicit confirm: delete is the one Aurora write that permanently
         destroys DAWN-side data (images + child background jobs). */
      openDialog({
         title: "Delete conversation",
         sub: `"${c.title || "Untitled"}" and its images and background jobs will be permanently deleted.`,
         actions: [
            { label: "Cancel", onClick: () => {} },
            {
               label: "Delete",
               danger: true,
               onClick: () => {
                  listItems = listItems.filter((x) => x.id !== c.id);
                  searchItems = searchItems.filter((x) => x.id !== c.id);
                  unread.delete(String(c.id));
                  render();
                  opts.onDelete(c.id);
               }
            }
         ]
      });
   };

   /* --- search + pagination ---------------------------------------------- */
   let searchTimer = 0;
   const runSearch = (): void => {
      const q = searchInput.value.trim();
      if (q) opts.onSearch(q, contentCheck.checked);
      else render(); // reverting to the cached full list; no refetch needed
   };
   const onSearchInput = (): void => {
      searchClear.classList.toggle("shown", searchInput.value.length > 0);
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
   };
   searchInput.addEventListener("input", onSearchInput);
   const onSearchClear = (): void => {
      searchInput.value = "";
      searchClear.classList.remove("shown");
      window.clearTimeout(searchTimer);
      render();
   };
   searchClear.addEventListener("click", onSearchClear);
   const onContentToggle = (): void => {
      if (isSearching()) runSearch();
   };
   contentCheck.addEventListener("change", onContentToggle);

   const onScroll = (): void => {
      if (isSearching() || awaitingPage) return; // no infinite-scroll while searching
      if (listItems.length >= total) return; // reached the end
      if (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 150) {
         awaitingPage = true;
         opts.onLoadMore(listItems.length);
      }
   };
   listEl.addEventListener("scroll", onScroll);

   const onNew = (): void => {
      onSearchClear();
      opts.onNew();
   };
   newBtn.addEventListener("click", onNew);

   const disposeToggle = onActivate(toggle, () => {
      open = !open;
      localStorage.setItem(OPEN_KEY, open ? "true" : "false");
      applyOpen();
   });
   toggle.setAttribute("aria-label", "Toggle conversations");
   applyOpen();

   /* Close the dropdown on an outside pointerdown (mousedown, before any rebuild -
      same discipline as the menubar). Clicks inside a modal dialog we spawned (the
      delete confirm) are not "outside": the dialog renders on document.body, outside
      this element, so without this guard cancelling a delete would collapse the panel. */
   const onDocDown = (e: Event): void => {
      const target = e.target as HTMLElement;
      if (open && !el.contains(target) && !target.closest(".dialog-overlay")) {
         open = false;
         localStorage.setItem(OPEN_KEY, "false");
         applyOpen();
      }
   };
   document.addEventListener("mousedown", onDocDown);

   /* --- sink -------------------------------------------------------------- */
   const controller: ConversationPickerController = {
      setList: (items, o) => {
         if (o.searching) {
            if (!isSearching()) return; // stale search response after the query was cleared (M7)
            searchItems = items;
         } else if (o.append) {
            listItems = listItems.concat(items);
            awaitingPage = false;
            if (o.total != null) total = o.total;
            /* An empty append page means the server has no more (total went stale after
               deletions); pin total to what we have so the scroll handler stops. */
            if (items.length === 0) total = listItems.length;
         } else {
            listItems = items;
            awaitingPage = false;
            total = o.total ?? items.length;
         }
         render({ append: o.append && !o.searching });
      },
      setActive: (id) => {
         activeId = id;
         unread.delete(String(id));
         render();
      },
      markRenamed: (id, newTitle) => {
         let found = false;
         patchLocal(id, (c) => {
            c.title = newTitle;
            found = true;
         });
         if (found) render(); // unknown id (auto-title before a refetch) -> tolerated no-op
      },
      markAppended: (id) => {
         if (id === activeId) return; // the active view reloads via the ingest, not a badge
         if (!listItems.some((c) => c.id === id) && !searchItems.some((c) => c.id === id)) return;
         unread.add(String(id));
         render();
      },
      setTimezone: (zone) => {
         tz = zone;
         render();
      },
      destroy: () => {
         window.clearTimeout(searchTimer);
         document.removeEventListener("mousedown", onDocDown);
         rowDisposers.forEach((d) => d());
         disposeToggle();
         el.remove();
      }
   };
   return controller;
}
