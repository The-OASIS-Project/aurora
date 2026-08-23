/*
 * The Library panel: a calm reading view over DAWN's document library (notes +
 * uploaded documents). A standalone movable card in the same machined phosphor
 * language as the calendar / HA boards - it lists the library and opens any item in a
 * large centered reading overlay that dims the dashboard. Read-only: it reflects
 * doc_library_list (a poll, like the calendar) and never wires any of DAWN's library
 * WRITE verbs (note save/edit, delete, index, ...).
 *
 * What is readable:
 *   - a NOTE carries its full body inline (rendered as markdown), so it reads today;
 *   - a txt/md DOCUMENT is fetched (through ingest, never a direct DAWN call here) and
 *     rendered in the reader;
 *   - a binary DOCUMENT (pdf/docx/...) offers a download;
 *   - a document with no stored original (or an older server that omits the blob id)
 *     falls back to a metadata-only row.
 *
 * Security: every DAWN-sourced string (filename, filetype) is bound via textContent.
 * A fetched original is untrusted content: markdown flows through renderMarkdown (which
 * DOMPurify-sanitizes) and plain text is set as textContent, never innerHTML.
 */

import type { LibraryItem, LibrarySink } from "../ingest/ingest.ts";
import { makeMovable } from "../render/movable.ts";
import { makeListCard } from "../render/list-card.ts";
import { addCorners } from "../render/corners.ts";
import { makeVisibility } from "../render/visibility.ts";
import { onActivate } from "../render/activate.ts";
import {
   openDocViewer,
   setDocBodyText,
   setDocBodyMessage,
   textDownload,
   ensureExt,
   type DocViewerHandle,
   type DocDownload
} from "../render/doc-viewer.ts";
import { relativeTime } from "../util/time.ts";

export interface LibraryPanelOptions {
   /* Re-list the first page (also the manual refresh control; the library has no push). */
   onRefresh(): void;
   /* Run the BM25 label/body search (empty query reverts to the cached list). */
   onSearch(query: string): void;
   /* Page the plain list (server offset = current loaded count). */
   onLoadMore(offset: number): void;
   /* Fetch a document's original file (routed through ingest, the single DAWN boundary). */
   fetchOriginal(blobId: string): Promise<{ blob: Blob; contentType: string }>;
   /* Fetch a document's reassembled full text (doc_library_get) - the readable body of a
      document with no uploaded original. Resolves null when unavailable. */
   getFullText(id: number): Promise<{ text: string; filename: string; filetype: string } | null>;
}

export interface LibraryPanelController extends LibrarySink {
   isVisible(): boolean;
   setVisible(on: boolean): void;
   destroy(): void;
}

const VISIBLE_KEY = "dawn.hero.libraryShown";
const LIST_H_KEY = "dawn.hero.libraryListH"; // persisted list max-height (grip resize)
const POS_KEY = "dawn.hero.libraryPos";
const SEARCH_DEBOUNCE_MS = 300;

/* filetypes whose original file is plain text we can render inline. Anything else with a
   stored original (pdf/docx/...) is offered as a download. */
const TEXT_TYPES = new Set(["txt", "text", "log", "md", "markdown", "csv", "json"]);
const MARKDOWN_TYPES = new Set(["md", "markdown"]);

/* Normalize a filetype for matching: strip a leading dot DAWN sometimes sends (".pdf"). */
function cleanType(item: LibraryItem): string {
   return (item.filetype || "").replace(/^\./, "").toLowerCase();
}

function typeLabel(item: LibraryItem): string {
   if (item.isNote) return "NOTE";
   return (cleanType(item) || "doc").toUpperCase();
}

/* Color-code the chip by family. Only calm phosphor hues (teal/blue) plus the gold
   secondary accent are used - the alert red stays reserved for "needs you". */
function chipFamily(item: LibraryItem): string {
   if (item.isNote) return "note"; // teal
   const ft = cleanType(item);
   if (ft === "pdf") return "pdf"; // gold
   if (["txt", "text", "md", "markdown", "log", "csv", "json"].includes(ft)) return "text"; // blue
   return "doc"; // neutral
}

function formatBytes(n: number): string {
   if (n < 1024) return `${n} B`;
   if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
   return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/* Best-available size hint. Notes carry their body, so their byte size is exact;
   documents expose only num_chunks over the WS (a rough size proxy, no byte size yet -
   see signal-map §9.5). "" when neither is meaningful. */
function sizeInfo(item: LibraryItem): string {
   if (item.isNote) {
      const bytes = item.text ? new Blob([item.text]).size : 0;
      return bytes ? formatBytes(bytes) : "";
   }
   return item.numChunks > 0 ? `${item.numChunks} part${item.numChunks === 1 ? "" : "s"}` : "";
}

function fmtDate(epochSec: number): string {
   if (!epochSec) return "";
   return new Date(epochSec * 1000).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

export function mountLibraryPanel(root: HTMLElement, opts: LibraryPanelOptions): LibraryPanelController {
   const el = document.createElement("div");
   el.id = "library";
   el.className = "library";
   addCorners(el);

   /* Header (the drag handle): title + a manual refresh (the library has no push feed). */
   const head = document.createElement("div");
   head.className = "library-head";
   const titleEl = document.createElement("div");
   titleEl.className = "library-title";
   titleEl.textContent = "Library";
   const refreshBtn = document.createElement("button");
   refreshBtn.type = "button";
   refreshBtn.className = "library-refresh";
   refreshBtn.setAttribute("aria-label", "Refresh library");
   refreshBtn.title = "Refresh";
   head.append(titleEl, refreshBtn);

   /* Search row. */
   const searchWrap = document.createElement("div");
   searchWrap.className = "library-search";
   const searchInput = document.createElement("input");
   searchInput.type = "text";
   searchInput.className = "library-search-input";
   searchInput.placeholder = "Search library";
   searchInput.setAttribute("aria-label", "Search library");
   const searchClear = document.createElement("button");
   searchClear.type = "button";
   searchClear.className = "library-search-clear";
   searchClear.setAttribute("aria-label", "Clear search");
   searchClear.textContent = "×"; // ×
   searchWrap.append(searchInput, searchClear);

   const list = document.createElement("div");
   list.className = "library-list";

   el.append(head, searchWrap, list);
   root.appendChild(el);

   /* Shared sizing / overflow-fade / grip-resize / hover-expand for the list body. */
   const card = makeListCard(el, list, { storageKey: LIST_H_KEY });

   /* Grab-and-move by the header only, so the search box + list rows stay interactive
      (the HA board model, not the calendar's whole-card drag). */
   const disposeMovable = makeMovable(el, {
      storageKey: POS_KEY,
      handle: ".library-head",
      ignore: ".library-refresh"
   });

   const vis = makeVisibility(el, { storageKey: VISIBLE_KEY, offClass: "library-off" });

   /* --- state ------------------------------------------------------------- */
   let listItems: LibraryItem[] = []; // the paginated full list
   let searchItems: LibraryItem[] = []; // current search results
   let hasMore = false;
   let awaitingPage = false; // a load-more request is in flight
   let searchTimer = 0;
   let rowDisposers: Array<() => void> = [];

   const isSearching = (): boolean => searchInput.value.trim().length > 0;
   const viewItems = (): LibraryItem[] => (isSearching() ? searchItems : listItems);

   /* --- reading overlay (the shared document viewer) ---------------------- */
   let reader: DocViewerHandle | null = null;

   type SetDownload = (dl: DocDownload | null) => void;

   /* Reassembled full text (doc_library_get): the readable body of a generated document
      with no uploaded original, or the extracted text of one that has. On success, offer a
      TEXT download when there is no binary original to fetch (a Friday-generated doc). */
   const tryFullText = (item: LibraryItem, body: HTMLElement, stale: () => boolean, setDownload: SetDownload): void => {
      setDocBodyMessage(body, "Loading…");
      const hasBinary = Boolean(item.hasOriginal && item.originalBlobId);
      const fallback = (): void =>
         setDocBodyMessage(body, hasBinary ? "This document type opens as a download." : "No preview available over the connection.");
      opts
         .getFullText(item.id)
         .then((res) => {
            if (stale()) return; // reader closed/replaced while fetching
            if (res && res.text) {
               setDocBodyText(body, res.text, true); // reassembled -> markdown
               /* A binary original (set at open) is the better download; only synthesize a
                  text file when there is none. */
               if (!hasBinary) setDownload(textDownload(ensureExt(item.filename || "document", "md"), res.text));
            } else fallback();
         })
         .catch(() => {
            if (stale()) return;
            fallback();
         });
   };

   const populateReader = (item: LibraryItem, body: HTMLElement, stale: () => boolean, setDownload: SetDownload): void => {
      if (item.isNote) {
         setDocBodyText(body, item.text ?? "", true);
         return;
      }
      const ft = cleanType(item);
      /* 1) An uploaded txt/md original renders with exact fidelity. */
      if (TEXT_TYPES.has(ft) && item.hasOriginal && item.originalBlobId) {
         setDocBodyMessage(body, "Loading…");
         opts
            .fetchOriginal(item.originalBlobId)
            .then(({ blob }) => blob.text())
            .then((text) => {
               if (stale()) return; // reader closed/replaced while fetching
               setDocBodyText(body, text, MARKDOWN_TYPES.has(ft));
            })
            .catch(() => {
               if (stale()) return;
               tryFullText(item, body, stale, setDownload); // fall back to reassembled text
            });
         return;
      }
      /* 2) Everything else: reassembled full text (generated docs, extracted pdf/docx). */
      tryFullText(item, body, stale, setDownload);
   };

   const openReader = (item: LibraryItem): void => {
      const subtitle = [typeLabel(item), sizeInfo(item), fmtDate(item.createdAt), item.isGlobal ? "shared" : ""]
         .filter(Boolean)
         .join(" · ");
      /* Open-time download: a stored binary original (exact file) for a document, or the
         note body saved as markdown. A generated document with only reassembled text gets
         its Download set later, from tryFullText. */
      const blobId = item.originalBlobId;
      let download: DocDownload | undefined;
      if (item.isNote) {
         const body = item.text ?? "";
         if (body) download = textDownload(ensureExt(item.filename || "note", "md"), body);
      } else if (item.hasOriginal && blobId) {
         download = { filename: item.filename || "document", fetch: () => opts.fetchOriginal(blobId) };
      }
      reader = openDocViewer({
         title: item.filename || "(untitled)",
         subtitle,
         download,
         populate: (body, stale, setDownload) => populateReader(item, body, stale, setDownload)
      });
   };

   /* --- rendering --------------------------------------------------------- */
   const buildRow = (item: LibraryItem): HTMLElement => {
      const row = document.createElement("div");
      row.className = "library-row";

      const type = document.createElement("span");
      type.className = `library-type family-${chipFamily(item)}`;
      type.textContent = typeLabel(item);

      const main = document.createElement("div");
      main.className = "library-row-main";
      const name = document.createElement("span");
      name.className = "library-row-name";
      name.textContent = item.filename || "(untitled)"; // DAWN text -> textContent
      const meta = document.createElement("span");
      meta.className = "library-row-meta";
      const when = document.createElement("span");
      when.className = "library-row-when";
      when.textContent = relativeTime(item.createdAt);
      meta.append(when);
      const size = sizeInfo(item);
      if (size) {
         const s = document.createElement("span");
         s.className = "library-row-size";
         s.textContent = size;
         meta.append(s);
      }
      if (item.isGlobal) {
         const g = document.createElement("span");
         g.className = "library-badge-global";
         g.textContent = "shared";
         meta.append(g);
      }
      main.append(name, meta);

      row.append(type, main);
      rowDisposers.push(onActivate(row, () => openReader(item)));
      return row;
   };

   const render = (o: { append?: boolean } = {}): void => {
      const prevScroll = list.scrollTop;
      rowDisposers.forEach((d) => d());
      rowDisposers = [];
      list.replaceChildren();

      const items = viewItems();
      if (items.length === 0) {
         const empty = document.createElement("div");
         empty.className = "library-empty";
         empty.textContent = isSearching() ? "No matches" : "Nothing in the library";
         list.appendChild(empty);
         card.refresh();
         return;
      }

      list.append(...items.map(buildRow));
      if (o.append) list.scrollTop = prevScroll; // an append keeps the reading position
      card.refresh();
   };
   render();

   /* --- search + pagination ---------------------------------------------- */
   const runSearch = (): void => {
      const q = searchInput.value.trim();
      if (q) opts.onSearch(q);
      else render(); // reverting to the cached list; no refetch needed
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

   const onScroll = (): void => {
      if (isSearching() || awaitingPage || !hasMore) return; // no infinite-scroll while searching
      if (list.scrollTop + list.clientHeight >= list.scrollHeight - 120) {
         awaitingPage = true;
         opts.onLoadMore(listItems.length);
      }
   };
   list.addEventListener("scroll", onScroll);

   const onRefreshClick = (): void => {
      onSearchClear();
      opts.onRefresh();
   };
   refreshBtn.addEventListener("click", onRefreshClick);

   /* --- sink -------------------------------------------------------------- */
   const controller: LibraryPanelController = {
      setItems: (items, o) => {
         if (o.searching) {
            if (!isSearching()) return; // stale search response after the query was cleared
            searchItems = items;
         } else if (o.append) {
            listItems = listItems.concat(items);
            awaitingPage = false;
            hasMore = o.hasMore;
         } else {
            listItems = items;
            awaitingPage = false;
            hasMore = o.hasMore;
         }
         render({ append: o.append && !o.searching });
      },
      isVisible: vis.isVisible,
      setVisible: vis.setVisible,
      destroy: () => {
         reader?.close();
         window.clearTimeout(searchTimer);
         searchInput.removeEventListener("input", onSearchInput);
         searchClear.removeEventListener("click", onSearchClear);
         list.removeEventListener("scroll", onScroll);
         refreshBtn.removeEventListener("click", onRefreshClick);
         rowDisposers.forEach((d) => d());
         card.destroy();
         disposeMovable();
         el.remove();
      }
   };
   return controller;
}
