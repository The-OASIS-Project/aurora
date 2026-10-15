/*
 * The music player's queue and library section: an expanding part of the player (not a panel
 * of its own), opened from the player's queue button and remembered per browser.
 *
 *   Queue    the play order, the current track marked; a click plays a row, minus removes it,
 *            a filter narrows the list, Clear empties the queue.
 *   Library  search (Enter; "source:plex" / "source:local" narrows it) and browse (tracks,
 *            artists, albums, page by page; open an artist or album, or add all of it). A click
 *            plays a track now, plus adds it to the queue.
 *
 * Everything goes through DAWN's existing music verbs (music_queue / music_search /
 * music_library reads, music_control writes on the user's own queue), so no DAWN change.
 * DAWN answers a queue change with a music_state, not the list, so the list is re-read when the
 * queue moves while it's open. Saved playlists and reordering wait on DAWN. Every track string is
 * DAWN data: textContent only.
 */

import type { MusicLibraryPage, MusicQueue, MusicState, MusicTrack } from "../ingest/ingest.ts";

export interface MusicLibraryOptions {
   control(action: string, params?: Record<string, unknown>): void;
   queueList(): void;
   search(query: string): void;
   library(type: string, params?: Record<string, unknown>): void;
   /* After each render (the list card re-measures its overflow cue). */
   onRender?(): void;
}

export interface MusicLibraryView {
   el: HTMLElement;
   /* The scrolling body (the list card's list). */
   body: HTMLElement;
   isOpen(): boolean;
   setOpen(on: boolean): void;
   /* Open straight onto the Library tab (the empty player's "Open the Library"). */
   openLibrary(): void;
   /* The player's state: the queue is re-read when it moves while the section is open. */
   setState(state: MusicState | null): void;
   setQueue(queue: MusicQueue): void;
   setSearchResults(query: string, tracks: MusicTrack[]): void;
   setLibrary(page: MusicLibraryPage): void;
   /* DAWN refused a music request (music_error): the section stops waiting and says so. */
   setError(code: string, message: string): void;
   destroy(): void;
}

const OPEN_KEY = "dawn.hero.musicLibOpen";
const TAB_KEY = "dawn.hero.musicLibTab";
const PAGE = 50;

function fmtTime(sec: number): string {
   if (!Number.isFinite(sec) || sec <= 0) return "";
   const m = Math.floor(sec / 60);
   const s = Math.floor(sec % 60);
   return `${m}:${s.toString().padStart(2, "0")}`;
}

/* Small stroked glyphs matching the player's icon set (text glyphs sat unevenly in the sans face). */
const GLYPHS: Record<string, string[]> = {
   plus: ["M12 5v14", "M5 12h14"],
   minus: ["M5 12h14"],
   check: ["M5 12.5l4.5 4.5L19 7.5"],
   back: ["M14 6l-6 6 6 6"]
};
function glyph(name: keyof typeof GLYPHS): SVGSVGElement {
   const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
   svg.setAttribute("viewBox", "0 0 24 24");
   svg.setAttribute("aria-hidden", "true");
   svg.setAttribute("fill", "none");
   svg.setAttribute("stroke", "currentColor");
   svg.setAttribute("stroke-width", "2");
   svg.setAttribute("stroke-linecap", "round");
   svg.setAttribute("stroke-linejoin", "round");
   for (const d of GLYPHS[name]) {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
   }
   return svg;
}

let mountSeq = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
   const e = document.createElement(tag);
   if (cls) e.className = cls;
   if (text !== undefined) e.textContent = text;
   return e;
}

function readPref(key: string): string | null {
   try {
      return localStorage.getItem(key);
   } catch {
      return null;
   }
}
function writePref(key: string, value: string): void {
   try {
      localStorage.setItem(key, value);
   } catch {
      /* blocked: remembered for this tab only */
   }
}

/* How many rows a browse list has loaded so far (the next page's offset). */
const loadedCount = (p: MusicLibraryPage): number =>
   p.kind === "tracks" || p.kind === "artist" || p.kind === "album" ? p.tracks.length : p.kind === "artists" ? p.artists.length : p.kind === "albums" ? p.albums.length : 0;

const trackParams = (t: MusicTrack): Record<string, unknown> => ({
   path: t.path,
   title: t.title,
   artist: t.artist,
   album: t.album,
   duration_sec: t.durationSec
});

export function mountMusicLibrary(opts: MusicLibraryOptions): MusicLibraryView {
   const uid = `music-lib-${++mountSeq}`;
   const root = el("section", "music-lib");
   root.id = uid;
   root.setAttribute("aria-label", "Queue and library");

   const tabs = el("div", "music-lib-tabs");
   tabs.setAttribute("role", "tablist");
   tabs.setAttribute("aria-label", "Queue or library");
   const mkTab = (id: "queue" | "library", label: string): HTMLButtonElement => {
      const b = el("button", "music-lib-tab", label);
      b.type = "button";
      b.id = `${uid}-tab-${id}`;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-controls", `${uid}-panel`);
      b.dataset.tab = id;
      return b;
   };
   const queueTab = mkTab("queue", "Queue");
   const libraryTab = mkTab("library", "Library");
   tabs.append(queueTab, libraryTab);

   /* Queue tools: filter + clear. */
   const queueTools = el("div", "music-lib-tools");
   const filter = el("input", "music-lib-input");
   filter.type = "search";
   filter.placeholder = "Filter the queue";
   filter.setAttribute("aria-label", "Filter the queue");
   const clearBtn = el("button", "music-lib-text-btn", "Clear");
   clearBtn.type = "button";
   clearBtn.title = "Clear the queue";
   queueTools.append(filter, clearBtn);

   /* Library tools: search, and a back row while browsing a list or an artist/album. */
   const libTools = el("div", "music-lib-tools");
   const search = el("input", "music-lib-input");
   search.type = "search";
   search.placeholder = "Search music, then Enter";
   search.setAttribute("aria-label", "Search music (source:plex or source:local narrows it)");
   search.title = 'Press Enter to search. Add "source:plex" or "source:local" to search one library.';
   libTools.append(search);
   const backBtn = el("button", "music-lib-back");
   backBtn.type = "button";
   const backLabel = el("span");
   backBtn.append(glyph("back"), backLabel);

   const body = el("div", "music-lib-body");
   const list = el("ul", "music-lib-list");
   list.setAttribute("role", "list");
   const moreBtn = el("button", "music-lib-more", "More");
   moreBtn.type = "button";
   const status = el("div", "music-lib-status");
   body.append(status, list, moreBtn);

   const panel = el("div", "music-lib-panel");
   panel.id = `${uid}-panel`;
   panel.setAttribute("role", "tabpanel");
   panel.append(queueTools, libTools, backBtn, body);
   root.append(tabs, panel);

   /* --- state ----------------------------------------------------------------- */
   let open = readPref(OPEN_KEY) === "1";
   let tab: "queue" | "library" = readPref(TAB_KEY) === "library" ? "library" : "queue";
   let queue: MusicQueue | null = null;
   let lastQueueSig = "";
   let lastShownCurrent = -1;
   let queueEmpty = false; // the player's state says nothing is queued
   let refreshTimer = 0;
   /* Library: the last browse page (stats until something is opened), or search results. */
   let browse: MusicLibraryPage | null = null;
   let searchResults: { query: string; tracks: MusicTrack[] } | null = null;
   let pagePending = false; // a "More" page is on its way (More is disabled meanwhile)
   let lastAsk: "browse" | "search" = "browse"; // a late browse reply mustn't replace newer search results
   const askLibrary = (type: string, params?: Record<string, unknown>): void => {
      lastAsk = "browse";
      opts.library(type, params);
   };

   const askQueue = (): void => {
      window.clearTimeout(refreshTimer);
      refreshTimer = 0;
      opts.queueList();
   };
   /* Coalesce bursts (adding an album sends several state changes). */
   const askQueueSoon = (): void => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(askQueue, 150);
   };

   const rowButton = (title: string, sub: string, label: string): HTMLButtonElement => {
      const b = el("button", "music-lib-main");
      b.type = "button";
      b.setAttribute("aria-label", label);
      b.append(el("span", "music-lib-title", title || "Unknown"), el("span", "music-lib-sub", sub));
      return b;
   };
   const actionButton = (name: "plus" | "minus", label: string): HTMLButtonElement => {
      const b = el("button", "music-lib-act");
      b.type = "button";
      b.setAttribute("aria-label", label);
      b.title = label;
      b.appendChild(glyph(name));
      return b;
   };
   const flash = (b: HTMLButtonElement): void => {
      b.replaceChildren(glyph("check"));
      window.setTimeout(() => {
         if (b.isConnected) b.replaceChildren(glyph("plus"));
      }, 1000);
   };

   const trackRow = (t: MusicTrack, onPlay: () => void, act: { glyph: "plus" | "minus"; label: string; run: (b: HTMLButtonElement) => void }): HTMLLIElement => {
      const li = el("li", "music-lib-row");
      const main = rowButton(t.title, [t.artist, t.album].filter(Boolean).join(" · "), `Play ${t.title || "track"}`);
      main.addEventListener("click", onPlay);
      const a = actionButton(act.glyph, act.label);
      a.addEventListener("click", () => act.run(a));
      li.append(main, el("span", "music-lib-dur", fmtTime(t.durationSec)), a);
      return li;
   };

   /* --- render ---------------------------------------------------------------- */
   const renderQueue = (): void => {
      list.replaceChildren();
      moreBtn.hidden = true;
      const tracks = queue?.tracks ?? [];
      clearBtn.disabled = tracks.length === 0;
      filter.hidden = tracks.length === 0;
      if (!queue) {
         status.textContent = "Loading the queue…";
         return;
      }
      if (tracks.length === 0) {
         status.textContent = "The queue is empty. Add music from the Library.";
         return;
      }
      const q = filter.value.trim().toLowerCase();
      let shown = 0;
      let currentRow: HTMLLIElement | null = null;
      tracks.forEach((t, i) => {
         if (q && !`${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)) return;
         shown++;
         const li = trackRow(t, () => opts.control("play_index", { index: i }), {
            glyph: "minus",
            label: `Remove ${t.title || "track"} from the queue`,
            run: () => {
               opts.control("remove_from_queue", { index: i });
               /* Apply it here at once (DAWN's rule: a later current moves up), so the next click
                  in this list uses the new indices; the re-read then confirms. */
               if (queue) {
                  const tracks = queue.tracks.filter((_, k) => k !== i);
                  const cur = queue.currentIndex > i ? queue.currentIndex - 1 : Math.min(queue.currentIndex, tracks.length - 1);
                  queue = { tracks, currentIndex: cur };
                  renderQueue();
               }
               askQueue();
            }
         });
         const num = el("span", "music-lib-num", String(i + 1));
         li.prepend(num);
         if (i === queue!.currentIndex) {
            li.classList.add("current");
            li.setAttribute("aria-current", "true");
            currentRow = li;
         }
         list.appendChild(li);
      });
      status.textContent = shown === 0 ? "Nothing in the queue matches." : "";
      /* Bring the current track into view when it changed (not while filtering). */
      const ci = queue.currentIndex;
      const cur = currentRow as HTMLLIElement | null; // assigned in the loop above
      if (cur && !q && ci !== lastShownCurrent) cur.scrollIntoView({ block: "nearest" });
      lastShownCurrent = ci;
   };

   const addTrack = (t: MusicTrack) => ({
      glyph: "plus" as const,
      label: `Add ${t.title || "track"} to the queue`,
      run: (b: HTMLButtonElement) => {
         opts.control("add_to_queue", trackParams(t));
         flash(b);
      }
   });
   const playTrack = (t: MusicTrack) => () => opts.control("play", trackParams(t));

   const renderStats = (p: Extract<MusicLibraryPage, { kind: "stats" }>): void => {
      const li = el("li", "music-lib-stats");
      const stat = (label: string, n: number, type: string): HTMLButtonElement => {
         const b = el("button", "music-lib-stat");
         b.type = "button";
         b.append(el("span", "music-lib-stat-n", n.toLocaleString()), el("span", "music-lib-stat-label", label));
         b.addEventListener("click", () => askLibrary(type, { offset: 0, limit: PAGE }));
         return b;
      };
      li.append(stat("Tracks", p.tracks, "tracks"), stat("Artists", p.artists, "artists"), stat("Albums", p.albums, "albums"));
      list.appendChild(li);
      status.textContent = p.tracks === 0 ? "Your music library is empty." : "";
   };

   const appendBrowseRows = (p: MusicLibraryPage): void => {
      if (p.kind === "tracks" || p.kind === "artist" || p.kind === "album") {
         for (const t of p.tracks) list.appendChild(trackRow(t, playTrack(t), addTrack(t)));
      } else if (p.kind === "artists") {
         for (const a of p.artists) {
            const li = el("li", "music-lib-row");
            const main = rowButton(a.name, `${a.albums} album${a.albums === 1 ? "" : "s"} · ${a.tracks} track${a.tracks === 1 ? "" : "s"}`, `Open ${a.name || "artist"}`);
            main.addEventListener("click", () => askLibrary("tracks_by_artist", { artist: a.name }));
            const add = actionButton("plus", `Add everything by ${a.name || "this artist"} to the queue`);
            add.addEventListener("click", () => {
               opts.control("add_artist", { artist: a.name });
               flash(add);
            });
            li.append(main, add);
            list.appendChild(li);
         }
      } else if (p.kind === "albums") {
         for (const a of p.albums) {
            const li = el("li", "music-lib-row");
            const main = rowButton(a.name, [a.artist, `${a.tracks} track${a.tracks === 1 ? "" : "s"}`].filter(Boolean).join(" · "), `Open ${a.name || "album"}`);
            main.addEventListener("click", () => askLibrary("tracks_by_album", { album: a.name }));
            const add = actionButton("plus", `Add ${a.name || "this album"} to the queue`);
            add.addEventListener("click", () => {
               opts.control("add_album", { album: a.name });
               flash(add);
            });
            li.append(main, add);
            list.appendChild(li);
         }
      }
   };

   const renderLibrary = (): void => {
      backBtn.hidden = !searchResults && (!browse || browse.kind === "stats");
      list.replaceChildren();
      moreBtn.hidden = true;
      status.textContent = "";
      if (searchResults) {
         backLabel.textContent = "Library";
         if (searchResults.tracks.length === 0) status.textContent = `Nothing found for “${searchResults.query}”.`;
         for (const t of searchResults.tracks) list.appendChild(trackRow(t, playTrack(t), addTrack(t)));
         return;
      }
      if (!browse) {
         status.textContent = "Loading the library…";
         return;
      }
      if (browse.kind === "stats") {
         renderStats(browse);
         return;
      }
      backLabel.textContent = browse.kind === "artist" ? "Artists" : browse.kind === "album" ? "Albums" : "Library";
      if (browse.kind === "artist" || browse.kind === "album") {
         const head = el("li", "music-lib-heading", browse.name || "Unknown");
         head.setAttribute("role", "heading");
         head.setAttribute("aria-level", "3");
         list.appendChild(head);
      }
      appendBrowseRows(browse);
      if (browse.kind === "tracks" || browse.kind === "artists" || browse.kind === "albums") {
         const loaded = loadedCount(browse);
         moreBtn.hidden = loaded >= browse.total;
         moreBtn.textContent = `More (${loaded.toLocaleString()} of ${browse.total.toLocaleString()})`;
      }
   };

   const render = (): void => {
      root.hidden = !open;
      queueTab.setAttribute("aria-selected", tab === "queue" ? "true" : "false");
      libraryTab.setAttribute("aria-selected", tab === "library" ? "true" : "false");
      queueTab.tabIndex = tab === "queue" ? 0 : -1;
      libraryTab.tabIndex = tab === "library" ? 0 : -1;
      panel.setAttribute("aria-labelledby", tab === "queue" ? queueTab.id : libraryTab.id);
      queueTools.hidden = tab !== "queue";
      libTools.hidden = tab !== "library";
      if (tab === "queue") {
         backBtn.hidden = true;
         renderQueue();
      } else {
         renderLibrary();
      }
      opts.onRender?.();
   };

   const showTab = (t: "queue" | "library"): void => {
      tab = t;
      writePref(TAB_KEY, t);
      if (open) {
         if (t === "queue") askQueue();
         else if (!browse && !searchResults) askLibrary("stats");
      }
      render();
   };

   /* --- events ---------------------------------------------------------------- */
   const onTab = (e: Event): void => {
      const t = (e.currentTarget as HTMLElement).dataset.tab;
      if (t === "queue" || t === "library") showTab(t);
   };
   queueTab.addEventListener("click", onTab);
   libraryTab.addEventListener("click", onTab);
   /* Arrow keys / Home / End move between the two tabs (and select). */
   tabs.addEventListener("keydown", (e) => {
      const next = e.key === "ArrowRight" || e.key === "End" ? "library" : e.key === "ArrowLeft" || e.key === "Home" ? "queue" : null;
      if (!next) return;
      e.preventDefault();
      showTab(next);
      (next === "queue" ? queueTab : libraryTab).focus();
   });
   filter.addEventListener("input", () => renderQueue());
   clearBtn.addEventListener("click", () => {
      opts.control("clear_queue");
      askQueue();
   });
   search.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && search.value) {
         search.value = "";
         search.dispatchEvent(new Event("input"));
         return;
      }
      if (e.key !== "Enter") return;
      const q = search.value.trim();
      if (!q) return;
      lastAsk = "search";
      opts.search(q);
      list.replaceChildren();
      moreBtn.hidden = true;
      status.textContent = "Searching…";
   });
   search.addEventListener("input", () => {
      if (search.value.trim() || !searchResults) return;
      searchResults = null; // cleared: back to browsing
      render();
   });
   backBtn.addEventListener("click", () => {
      if (searchResults) {
         searchResults = null;
         search.value = "";
      } else if (browse && (browse.kind === "artist" || browse.kind === "album")) {
         askLibrary(browse.kind === "artist" ? "artists" : "albums", { offset: 0, limit: PAGE });
         return;
      } else {
         askLibrary("stats");
         return;
      }
      render();
   });
   const loadMore = (): void => {
      if (pagePending || !open || tab !== "library" || searchResults) return;
      if (!browse || (browse.kind !== "tracks" && browse.kind !== "artists" && browse.kind !== "albums")) return;
      if (loadedCount(browse) >= browse.total) return;
      pagePending = true;
      moreBtn.disabled = true;
      moreBtn.textContent = "Loading more…";
      askLibrary(browse.kind, { offset: loadedCount(browse), limit: PAGE });
   };
   moreBtn.addEventListener("click", loadMore);
   /* The next page loads by itself as the end of the list scrolls into view (Mail's pattern); the
      More button stays as the fallback, and as the "Loading more…" line meanwhile. */
   const io =
      typeof IntersectionObserver === "function"
         ? new IntersectionObserver((entries) => {
              if (entries.some((e) => e.isIntersecting)) loadMore();
           }, { root: body, rootMargin: "120px" })
         : null;
   io?.observe(moreBtn);
   /* A page that didn't fill the list leaves the end in view: re-check (observing again reports it). */
   const recheckEnd = (): void => {
      if (!io) return;
      io.unobserve(moreBtn);
      io.observe(moreBtn);
   };

   render();
   if (open) showTab(tab);

   return {
      el: root,
      body,
      isOpen: () => open,
      setOpen: (on) => {
         if (on === open) return;
         open = on;
         writePref(OPEN_KEY, on ? "1" : "0");
         /* Nothing queued: the Library is where the music is, whatever tab was last open. */
         if (on) showTab(queueEmpty ? "library" : tab);
         else render();
      },
      openLibrary: () => {
         if (!open) {
            open = true;
            writePref(OPEN_KEY, "1");
         }
         showTab("library");
      },
      setState: (s) => {
         /* The queue moved (a track added, removed, cleared, or the current one changed). */
         queueEmpty = !!s && s.queueLength === 0;
         /* The first state means DAWN is talking: a library read sent before the link was up was
            dropped, so ask again for whatever the open section still lacks. */
         if (s && open && tab === "library" && !browse && !searchResults) askLibrary("stats");
         const sig = s ? `${s.queueLength}|${s.queueIndex}|${s.track?.path ?? ""}` : "";
         if (sig === lastQueueSig) return;
         lastQueueSig = sig;
         if (open && tab === "queue") askQueueSoon();
         else queue = null; // stale: re-read when the queue tab next shows
      },
      setQueue: (q) => {
         queue = q;
         if (open && tab === "queue") {
            renderQueue();
            opts.onRender?.();
         }
      },
      setError: (code, message) => {
         if (!open) return;
         pagePending = false;
         moreBtn.disabled = false;
         /* A remove that hit a stale row: show the queue as it really is. */
         if (code === "INVALID_INDEX") {
            askQueue();
            return;
         }
         if (tab === "library") renderLibrary(); // "Loading more…" back to More, so it can be retried
         status.textContent = message || "Music isn't available right now.";
      },
      setSearchResults: (query, tracks) => {
         searchResults = { query, tracks };
         if (open && tab === "library") render();
      },
      setLibrary: (page) => {
         /* A More page joins the rows already loaded when it starts where they end (kept in
            `browse`, so a re-render shows them all); a duplicate page is ignored. */
         const paged = page.kind === "tracks" || page.kind === "artists" || page.kind === "albums";
         if (paged && page.offset > 0) {
            pagePending = false;
            moreBtn.disabled = false;
            if (!browse || browse.kind !== page.kind || page.offset !== loadedCount(browse)) return;
            if (browse.kind === "tracks" && page.kind === "tracks") browse = { ...page, tracks: [...browse.tracks, ...page.tracks] };
            else if (browse.kind === "artists" && page.kind === "artists") browse = { ...page, artists: [...browse.artists, ...page.artists] };
            else if (browse.kind === "albums" && page.kind === "albums") browse = { ...page, albums: [...browse.albums, ...page.albums] };
            /* An empty page (the library changed meanwhile) ends the list. */
            if (loadedCount(page) === 0 && (browse.kind === "tracks" || browse.kind === "artists" || browse.kind === "albums")) browse = { ...browse, total: loadedCount(browse) };
         } else {
            pagePending = false;
            moreBtn.disabled = false;
            browse = page;
         }
         if (lastAsk === "browse") searchResults = null;
         queueMicrotask(recheckEnd);
         if (open && tab === "library") render();
      },
      destroy: () => {
         window.clearTimeout(refreshTimer);
         io?.disconnect();
         root.remove();
      }
   };
}
