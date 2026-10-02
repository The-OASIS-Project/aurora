/*
 * The Mail panel (docs/EMAIL_PANEL_DESIGN.md): a calm, movable, resizable view over the user's
 * inboxes. Scan every account in one merged list, read a message, triage it (read/unread,
 * archive, trash with undo), and hand a message to the assistant ("Discuss").
 *
 * Self-owned like Stocks / Watches: it depends only on the EmailSource boundary (DawnIngest once
 * DAWN ships its email verbs, or the dev simulator), bound with attach(), and reaches the rest of
 * the app only through the callbacks main.ts wires (onDiscuss, notify).
 *
 * States: off (Panels menu), collapsed (a bar with the unread count), expanded (resizable; a
 * single list-or-reader column when narrow, list + reader side by side when wide, decided from
 * the panel's own width with hysteresis). The first time it is enabled it opens expanded so its
 * use is obvious; after that it restores what the user left.
 *
 * Rendering is split by section: the header, list, and reader each re-render only when their
 * own inputs change (the reader keeps its scroll, focus, and expanded details across a count
 * push or an arrival; a message body is rendered once per (message, images shown)).
 *
 * Security/privacy: every email string is attacker-authored and is bound via textContent; bodies
 * go only through renderEmailBody (inert parse, escaped markdown, strict sanitizer, remote images
 * blocked until "Show images"). Mail lives in memory only (logout/user switch reload the page);
 * the one per-user pref key is in USER_KEYS, layout keys are per machine. New-mail notice ids are
 * per account, never a message id or subject (the notify layer persists positions by id).
 */

import type {
   EmailAccount,
   EmailAvailability,
   EmailChanges,
   EmailErrorCode,
   EmailMessage,
   EmailRef,
   EmailRow,
   EmailSink,
   EmailSource,
   EmailUnreadCount
} from "../ingest/email.ts";
import { EmailRequestError } from "../ingest/email.ts";
import type { Notice } from "../ingest/ingest.ts";
import { PALETTE } from "../design/tokens.ts";
import { addCorners } from "../render/corners.ts";
import { makeMovableHandle, raiseMovable, type MovableHandle } from "../render/movable.ts";
import { makeResizable } from "../render/resizable.ts";
import { makeVisibility } from "../render/visibility.ts";
import { renderEmailBody } from "./render-body.ts";

export interface EmailPanelOptions {
   source: EmailSource;
   /* Hand a message to the assistant: a new private chat, or the current one. */
   onDiscuss(ref: EmailRef, opts: { newChat: boolean }): void;
   /* Raise / clear a new-mail notification card (opt-in per account). */
   notify(notice: Notice): void;
   removeNotice(id: string): void;
}

export interface EmailPanelController extends EmailSink {
   isVisible(): boolean;
   setVisible(on: boolean): void;
   /* Standby: suspend the panel-visibility half of the subscription. */
   setSuspended(on: boolean): void;
   setTimezone(tz: string | undefined): void;
   /* Open one message (a new-mail card tap): shows + expands the panel. */
   openMessage(accountId: number, messageId: string): void;
   destroy(): void;
}

/* Layout: per machine. */
const VISIBLE_KEY = "dawn.hero.mailShown";
const POS_KEY = "dawn.hero.mailPos";
const SIZE_KEY = "dawn.hero.mailSize";
const OPEN_KEY = "dawn.hero.mailOpen"; // absent = first enable -> expanded
const UNREAD_KEY = "dawn.hero.mailUnreadOnly";
/* The user's own choices that embed account ids: per user (in USER_KEYS). */
export const MAIL_PREFS_KEY = "dawn.hero.mailPrefs";
/* Every key this panel may write (a test holds it to this). */
export const MAIL_STORAGE_KEYS = [VISIBLE_KEY, POS_KEY, SIZE_KEY, OPEN_KEY, UNREAD_KEY, MAIL_PREFS_KEY] as const;

const PAGE = 25;
const ROW_CAP = 1000;
const SPLIT_ON = 720;
const SPLIT_OFF = 680;
const COMPACT_DISCUSS = 420;
const SKELETON_DELAY_MS = 250;
const TOAST_MS = 6000;
const REFLOW_LOCK_MS = 400;
const REFLOW_UNLOCK_PX = 8;
const WASH_MS = 1500;
const NOTIFY_COALESCE_MS = 30_000;
const SEARCH_DEBOUNCE_MS = 300;

interface Prefs {
   filter: number[] | null; // null = all accounts
   notify: number[];
   senderOnly: boolean;
}

interface Reader {
   key: string;
   row: EmailRow;
   state: "loading" | "ready" | "gone" | "error";
   message?: EmailMessage;
   error?: string;
   showImages: boolean;
}

interface Toast {
   accountId: number;
   tokens: string[];
   remaining: number;
   startedAt: number;
   timer: number;
}

const keyOf = (accountId: number, messageId: string): string => `${accountId}/${messageId}`;
const rowKey = (r: EmailRow): string => keyOf(r.accountId, r.messageId);

/* --- small DOM helpers ---------------------------------------------------- */

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS: Record<string, string[]> = {
   back: ["M15 18l-6-6 6-6"],
   up: ["M18 15l-6-6-6 6"],
   down: ["M6 9l6 6 6-6"],
   archive: ["M21 8v13H3V8", "M1 3h22v5H1z", "M10 12h4"],
   trash: ["M3 6h18", "M19 6l-1 14H6L5 6", "M10 11v6", "M14 11v6", "M9 6V4h6v2"],
   unread: ["M3 6h18v12H3z", "M3 7l9 6 9-6"],
   read: ["M3 10l9-6 9 6v9H3z", "M3 10l9 5 9-5"],
   lock: ["M5 11h14v10H5z", "M8 11V7a4 4 0 0 1 8 0v4"],
   bell: ["M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9", "M13.73 21a2 2 0 0 1-3.46 0"],
   image: ["M3 5h18v14H3z", "M3 16l5-5 4 4 3-3 6 6", "M15.5 9.5h.01"],
   filter: ["M3 5h18", "M6 12h12", "M10 19h4"],
   clip: ["M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"]
};

function icon(name: string): SVGSVGElement {
   const svg = document.createElementNS(SVG_NS, "svg");
   svg.setAttribute("viewBox", "0 0 24 24");
   svg.setAttribute("aria-hidden", "true");
   svg.setAttribute("fill", "none");
   svg.setAttribute("stroke", "currentColor");
   svg.setAttribute("stroke-width", "1.7");
   svg.setAttribute("stroke-linecap", "round");
   svg.setAttribute("stroke-linejoin", "round");
   for (const d of ICONS[name] ?? []) {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
   }
   return svg;
}

function div(cls: string, text?: string): HTMLDivElement {
   const d = document.createElement("div");
   d.className = cls;
   if (text !== undefined) d.textContent = text;
   return d;
}

function span(cls: string, text?: string): HTMLSpanElement {
   const s = document.createElement("span");
   s.className = cls;
   if (text !== undefined) s.textContent = text;
   return s;
}

function iconButton(cls: string, name: string, label: string): HTMLButtonElement {
   const b = document.createElement("button");
   b.type = "button";
   b.className = `mail-icon-btn ${cls}`;
   b.setAttribute("aria-label", label);
   b.title = label;
   b.appendChild(icon(name));
   return b;
}

function textButton(cls: string, text: string): HTMLButtonElement {
   const b = document.createElement("button");
   b.type = "button";
   b.className = cls;
   b.textContent = text;
   return b;
}

function errorCode(e: unknown): EmailErrorCode | undefined {
   return e instanceof EmailRequestError ? e.code : undefined;
}

function errorText(e: unknown): string {
   return e instanceof Error && e.message ? e.message : "Something went wrong";
}

function fmtBytes(n: number): string {
   if (n < 1024) return `${n} B`;
   if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
   return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/* Distinct monograms: the first letter, two letters on a clash, then letter + a digit, so two
   accounts never share a tile (identity never rests on hue alone). Exported for tests. */
export function assignMonograms(accounts: Array<{ id: number; label: string }>): Map<number, string> {
   const clean = (s: string): string => s.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase() || "?";
   const out = new Map<number, string>();
   const used = new Set<string>();
   const labels = accounts.map((a) => ({ id: a.id, l: clean(a.label) }));
   for (const { id, l } of labels) {
      const firstClash = labels.some((b) => b.id !== id && b.l[0] === l[0]);
      const tries = firstClash ? [l.slice(0, 2), ...Array.from({ length: 9 }, (_, i) => `${l[0]}${i + 1}`)] : [l[0], l.slice(0, 2)];
      const pick = tries.find((t) => !used.has(t)) ?? `${l[0]}${id}`;
      used.add(pick);
      out.set(id, pick);
   }
   return out;
}

export function mountEmailPanel(root: HTMLElement, opts: EmailPanelOptions): EmailPanelController {
   const { source } = opts;

   /* --- DOM ---------------------------------------------------------------- */
   const el = div("mail");
   el.id = "mail";
   addCorners(el);

   const head = div("mail-head");
   const toggle = document.createElement("button");
   toggle.type = "button";
   toggle.className = "mail-toggle";
   const caret = span("mail-caret");
   caret.setAttribute("aria-hidden", "true");
   const titleEl = span("mail-title", "Mail");
   const countEl = span("mail-count");
   toggle.append(caret, titleEl, countEl);
   const tilesEl = span("mail-bar-tiles");
   const headTools = span("mail-head-tools");
   const filterBtn = iconButton("mail-filter-btn", "filter", "Accounts and notifications");
   filterBtn.setAttribute("aria-haspopup", "true");
   filterBtn.setAttribute("aria-expanded", "false");
   const unreadPill = textButton("mail-unread-pill", "UNREAD");
   unreadPill.title = "Show unread only";
   const refreshBtn = document.createElement("button");
   refreshBtn.type = "button";
   refreshBtn.className = "mail-refresh panel-refresh";
   refreshBtn.setAttribute("aria-label", "Refresh mail");
   refreshBtn.title = "Refresh";
   headTools.append(filterBtn, unreadPill, refreshBtn);
   head.append(toggle, tilesEl, headTools);

   const popover = div("mail-popover");
   popover.hidden = true;
   popover.setAttribute("role", "dialog");
   popover.setAttribute("aria-label", "Accounts and notifications");

   const body = div("mail-body");
   const searchRow = div("mail-search");
   const searchInput = document.createElement("input");
   searchInput.type = "text";
   searchInput.className = "mail-search-input";
   searchInput.placeholder = "Search mail";
   searchInput.setAttribute("aria-label", "Search mail");
   const searchClear = textButton("mail-search-clear", "×");
   searchClear.setAttribute("aria-label", "Clear search");
   searchRow.append(searchInput, searchClear);
   const banners = div("mail-banners");
   const statusEl = div("mail-status");
   const mainEl = div("mail-main");
   const listCol = div("mail-listcol");
   const newPill = textButton("mail-newpill", "");
   newPill.hidden = true;
   const listEl = div("mail-list");
   listEl.setAttribute("role", "listbox");
   listEl.setAttribute("aria-label", "Messages");
   const footer = div("mail-footer");
   const sentinel = div("mail-sentinel");
   listCol.append(newPill, listEl);
   const readerCol = div("mail-readercol");
   mainEl.append(listCol, readerCol);
   const toastEl = div("mail-toast");
   toastEl.hidden = true;
   toastEl.setAttribute("role", "status");
   toastEl.setAttribute("aria-live", "polite");
   const live = div("mail-sr");
   live.setAttribute("aria-live", "polite");
   body.append(searchRow, banners, statusEl, mainEl);
   el.append(head, popover, body, toastEl, live);
   root.appendChild(el);

   /* --- layout primitives -------------------------------------------------- */
   /* Size first, so movable places the element at its real size (no re-dock a frame later). */
   let movable: MovableHandle | null = null;
   const resizable = makeResizable(el, {
      storageKey: SIZE_KEY,
      minWidth: 300,
      minHeight: 360,
      defaultWidth: 340,
      defaultHeight: 520,
      maxWidth: () => movable?.maxWidth() ?? Infinity,
      onCommit: (edges) => movable?.commitResize(edges)
   });
   const vis = makeVisibility(el, { storageKey: VISIBLE_KEY, offClass: "mail-off", defaultVisible: false });
   const reducedMotion =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

   /* --- state -------------------------------------------------------------- */
   let destroyed = false;
   let availability: EmailAvailability = "unknown";
   let linked = false;
   let accounts: EmailAccount[] = [];
   const accountIndex = new Map<number, number>(); // id -> stable color slot (0-based)
   let monograms = new Map<number, string>();
   const counts = new Map<number, EmailUnreadCount>();
   const states = new Map<number, string>(); // last change-state per account (reconnect catch-up)
   let tz: string | undefined;

   let prefs: Prefs = { filter: null, notify: [], senderOnly: false };
   try {
      const raw = localStorage.getItem(MAIL_PREFS_KEY);
      if (raw) {
         const p = JSON.parse(raw) as Partial<Prefs>;
         prefs = {
            filter: Array.isArray(p.filter) ? p.filter.filter((n) => Number.isInteger(n)) : null,
            notify: Array.isArray(p.notify) ? p.notify.filter((n) => Number.isInteger(n)) : [],
            senderOnly: p.senderOnly === true
         };
      }
   } catch {
      /* defaults */
   }
   const savePrefs = (): void => {
      try {
         localStorage.setItem(MAIL_PREFS_KEY, JSON.stringify(prefs));
      } catch {
         /* blocked */
      }
   };

   let expanded = true;
   let unreadOnly = false;
   try {
      expanded = localStorage.getItem(OPEN_KEY) !== "false";
      unreadOnly = localStorage.getItem(UNREAD_KEY) === "1";
   } catch {
      /* defaults */
   }
   resizable.setEnabled(expanded && vis.isVisible());
   movable = makeMovableHandle(el, {
      storageKey: POS_KEY,
      handle: ".mail-head",
      ignore: ".mail-head-tools, .rs-grip"
   });
   resizable.setEnabled(expanded && vis.isVisible()); // re-clamp now that the dock limits are known

   let rows: EmailRow[] = [];
   let cursor: string | null | undefined; // undefined = not loaded yet; null = end
   let loading = false;
   let loadError: string | null = null;
   let listGen = 0;
   let staleReloads = 0;
   let lastPageEmpty = false; // a page came back empty while the cursor stayed open (an account failing)
   let listStale = false; // changes arrived while the list wasn't on screen: reload on return
   let skeletonTimer = 0;
   let showSkeleton = false;
   const partials = new Map<number, { code: EmailErrorCode; message: string }>();
   const dismissedBanners = new Set<number>();
   let query = "";
   let searchTimer = 0;
   let pendingNew: EmailRow[] = [];
   let pendingOverflow = false;
   let searchNewMail = false;
   let reader: Reader | null = null;
   let selectedKey: string | null = null;
   let focusKey: string | null = null;
   let savedListScroll = 0;
   let split = false;
   let compactDiscuss = false;
   let lockUntil = 0;
   let lockX = 0;
   let lockY = 0;
   let pointerX = 0;
   let pointerY = 0;
   let pointerOverList = false;
   let toast: Toast | null = null;
   let actionSeq = 0;
   const washed = new Map<string, number>(); // key -> wash expiry (arrival highlight)
   let washTimer = 0;
   const rowEls = new Map<string, { el: HTMLElement; sig: string }>();
   let renderedLinked: boolean | null = null;
   let readSeq = 0;
   let advanceAfterPage = false; // Next pressed at the end of the loaded rows: open the next once it loads
   let readerSig = "";
   let bodyCache: { key: string; showImages: boolean; node: DocumentFragment; images: number } | null = null;
   const notifyState = new Map<number, { count: number; last: EmailRow; timer: number }>();

   /* --- accounts ----------------------------------------------------------- */
   const account = (id: number): EmailAccount | undefined => accounts.find((a) => a.id === id);
   const accountName = (id: number): string => account(id)?.displayName || account(id)?.address || "Mail";
   const isReadOnly = (id: number): boolean => account(id)?.readOnly ?? true;
   /* The accounts shown. `filter: null` = all; an empty filter = none (the user unchecked every
      account; the list says so and offers Show all). */
   const selectedIds = (): number[] => {
      const all = accounts.map((a) => a.id);
      if (!prefs.filter) return all;
      return prefs.filter.filter((id) => all.includes(id));
   };
   const noneSelected = (): boolean => accounts.length > 0 && selectedIds().length === 0;
   const filterIsAll = (): boolean => accounts.length > 0 && selectedIds().length === accounts.length;

   const computeIdentity = (): void => {
      accountIndex.clear();
      const sorted = [...accounts].sort((a, b) => a.id - b.id);
      sorted.forEach((a, i) => accountIndex.set(a.id, i));
      monograms = assignMonograms(sorted.map((a) => ({ id: a.id, label: a.displayName || a.address.split("@")[1] || a.address })));
   };

   /* The account's color token (slots cycle past the palette; the letter disambiguates). */
   const acctColor = (id: number): string => `var(--account-${((accountIndex.get(id) ?? 0) % PALETTE.account.length) + 1})`;

   const tile = (accountId: number, small = false): HTMLElement => {
      const t = span(`mail-tile${small ? " mail-tile-sm" : ""}`);
      t.style.setProperty("--acct", acctColor(accountId));
      t.textContent = monograms.get(accountId) ?? "?";
      t.setAttribute("aria-hidden", "true");
      return t;
   };

   /* --- dates (formatters cached per timezone) ----------------------------- */
   const fmtCache = new Map<string, Intl.DateTimeFormat>();
   const fmt = (d: Date, o: Intl.DateTimeFormatOptions): string => {
      const k = `${tz ?? ""}|${JSON.stringify(o)}`;
      let f = fmtCache.get(k);
      if (!f) {
         try {
            f = new Intl.DateTimeFormat(undefined, { timeZone: tz || undefined, ...o });
         } catch {
            f = new Intl.DateTimeFormat(undefined, o);
         }
         fmtCache.set(k, f);
      }
      return f.format(d);
   };
   const DAY_OPTS: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit" };
   const dayKey = (d: Date): string => fmt(d, DAY_OPTS);
   /* "Now" for a render: dates read relative to it, and it's part of each row's signature so a
      long-open panel relabels rows after midnight. */
   let today = "";
   let year = "";
   let nowMs = 0;
   const stampNow = (): void => {
      const now = new Date();
      nowMs = now.getTime();
      today = dayKey(now);
      year = fmt(now, { year: "numeric" });
   };
   const rowDate = (epoch: number): string => {
      const d = new Date(epoch * 1000);
      if (dayKey(d) === today) return fmt(d, { hour: "numeric", minute: "2-digit" });
      if (nowMs - d.getTime() < 6 * 86400_000) return fmt(d, { weekday: "short" });
      const sameYear = fmt(d, { year: "numeric" }) === year;
      return fmt(d, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
   };
   const fullDate = (epoch: number): string =>
      fmt(new Date(epoch * 1000), { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

   /* --- subscription (7.1) ------------------------------------------------- */
   let suspended = false;
   let tabHidden = document.hidden;
   let subscribed = false;
   const panelEffective = (): boolean => vis.isVisible() && expanded && !suspended && !tabHidden;
   /* Listen while the panel is on screen, or (opt-in bells) while it's COLLAPSED or the tab is
      hidden. Turning the panel off in the Panels menu silences it entirely: the bell settings live
      in the panel, so an off panel must not keep raising cards the user can't trace. */
   const wantSubscription = (): boolean =>
      availability === "available" && (panelEffective() || (vis.isVisible() && prefs.notify.length > 0 && linked));
   const syncSubscription = (): void => {
      const want = wantSubscription();
      if (want === subscribed) return;
      subscribed = want;
      source.setSubscription(want);
   };
   let wasEffective = false;
   const syncEffective = (): void => {
      const eff = panelEffective();
      if (eff && !wasEffective && availability === "available") {
         /* Coming back into view: catch up (the list may be stale while unsubscribed). */
         refreshCounts();
         reload();
      }
      wasEffective = eff;
      syncSubscription();
   };
   const onVisChange = (): void => {
      tabHidden = document.hidden;
      syncEffective();
   };
   document.addEventListener("visibilitychange", onVisChange);

   const refreshCounts = (): void => {
      source
         .unreadCounts()
         .then((c) => !destroyed && setCounts(c))
         .catch(() => {});
   };

   /* --- list loading ------------------------------------------------------- */
   const clearSkeleton = (): void => {
      window.clearTimeout(skeletonTimer);
      skeletonTimer = 0;
      showSkeleton = false;
   };

   const reload = (): void => {
      listGen++;
      rows = [];
      cursor = undefined;
      loadError = null;
      loading = false;
      listStale = false;
      lastPageEmpty = false;
      advanceAfterPage = false;
      pendingNew = [];
      pendingOverflow = false;
      searchNewMail = false;
      partials.clear();
      rowEls.clear();
      listEl.scrollTop = 0;
      loadMore();
   };

   /* Paging runs only for a list someone can see, and never re-fires itself after an error
      (the user's Retry does). */
   const canAutoPage = (): boolean => !loadError && !lastPageEmpty && panelEffective() && listEl.clientHeight > 0;

   const loadMore = (): void => {
      if (destroyed) return;
      if (availability !== "available" || accounts.length === 0) return render();
      if (noneSelected()) {
         cursor = null; // nothing to page
         return render();
      }
      if (loading || cursor === null || rows.length >= ROW_CAP) return;
      loading = true;
      loadError = null;
      const gen = listGen;
      if (rows.length === 0 && !skeletonTimer) {
         skeletonTimer = window.setTimeout(() => {
            showSkeleton = true;
            render();
         }, SKELETON_DELAY_MS);
      }
      render();
      source
         .list({
            accountIds: filterIsAll() ? undefined : selectedIds(),
            unreadOnly,
            query: query || undefined,
            cursor: cursor ?? undefined,
            limit: PAGE
         })
         .then((r) => {
            if (destroyed || gen !== listGen) return;
            staleReloads = 0;
            const have = new Set(rows.map(rowKey));
            const tail = rows.length ? rows[rows.length - 1].date : Infinity;
            let outOfOrder = false;
            for (const row of r.rows) {
               if (have.has(rowKey(row))) continue;
               if (row.date > tail) outOfOrder = true; // a recovered account's newer mail
               rows.push(row);
            }
            if (outOfOrder) rows.sort((a, b) => b.date - a.date); // keep newest-first (stable)
            cursor = r.cursor;
            lastPageEmpty = r.rows.length === 0 && r.cursor !== null;
            if (advanceAfterPage) {
               advanceAfterPage = false;
               const i = reader ? rows.findIndex((x) => rowKey(x) === reader!.key) : -1;
               if (i >= 0 && rows[i + 1]) queueMicrotask(() => openRow(rows[i + 1], readerCol.contains(document.activeElement), true));
            }
            if (rows.length >= ROW_CAP) rows.length = ROW_CAP;
            for (const p of r.partial) partials.set(p.accountId, { code: p.code, message: p.message });
         })
         .catch((e: unknown) => {
            if (destroyed || gen !== listGen) return;
            if (errorCode(e) === "CURSOR_STALE" && staleReloads < 2) {
               staleReloads++;
               loading = false;
               reload();
               return;
            }
            advanceAfterPage = false;
            loadError = errorCode(e) === "CURSOR_STALE" ? "the list keeps changing; refresh to reload" : errorText(e);
         })
         .finally(() => {
            if (destroyed || gen !== listGen) return;
            loading = false;
            clearSkeleton();
            render();
            /* A short first page may not fill the list: keep going while the sentinel shows. */
            requestAnimationFrame(() => {
               if (gen === listGen && canAutoPage() && sentinelVisible()) loadMore();
            });
         });
   };

   const sentinelVisible = (): boolean => {
      if (!sentinel.isConnected || listEl.clientHeight === 0) return false;
      const lr = listEl.getBoundingClientRect();
      const sr = sentinel.getBoundingClientRect();
      return sr.top < lr.bottom + 200;
   };
   const io = new IntersectionObserver(
      (entries) => {
         if (entries.some((e) => e.isIntersecting) && canAutoPage()) loadMore();
      },
      { root: listEl, rootMargin: "200px" }
   );
   io.observe(sentinel);

   /* --- rows --------------------------------------------------------------- */
   const rowSig = (r: EmailRow, k: string): string =>
      [
         r.unread,
         r.subject,
         r.fromName,
         r.fromAddr,
         r.preview,
         r.date,
         r.starred,
         r.hasAttachments,
         k === selectedKey,
         k === focusKey,
         isReadOnly(r.accountId),
         accountIndex.get(r.accountId),
         monograms.get(r.accountId),
         tz,
         today
      ].join("\u0001");

   const buildRow = (r: EmailRow, k: string): HTMLElement => {
      const row = div(`mail-row${r.unread ? " unread" : ""}${k === selectedKey ? " selected" : ""}`);
      row.style.setProperty("--acct", acctColor(r.accountId));
      row.setAttribute("role", "option");
      row.dataset.key = k;
      const focused = k === focusKey;
      row.tabIndex = focused ? 0 : -1;
      row.setAttribute("aria-selected", k === selectedKey ? "true" : "false");
      const sender = r.fromName || r.fromAddr;
      const when = rowDate(r.date);
      row.setAttribute("aria-label", `${r.unread ? "Unread, " : ""}from ${sender}, ${accountName(r.accountId)} account, ${r.subject || "(no subject)"}, ${when}`);
      const bar = span("mail-row-bar");
      const gutter = span("mail-row-gutter");
      gutter.appendChild(tile(r.accountId));
      const content = div("mail-row-content");
      const l1 = div("mail-row-l1");
      const from = span("mail-row-from", sender);
      from.title = `${r.fromAddr} · to ${account(r.accountId)?.address ?? ""}`;
      const dot = span("mail-row-dot");
      dot.setAttribute("aria-hidden", "true");
      const glyphs = span("mail-row-glyphs");
      if (r.hasAttachments) glyphs.appendChild(icon("clip"));
      const date = span("mail-row-date", when);
      l1.append(dot, from, glyphs, date);
      const l2 = div("mail-row-subject", r.subject || "(no subject)");
      const l3 = div("mail-row-preview", r.preview);
      content.append(l1, l2, l3);
      row.append(bar, gutter, content);
      if (!isReadOnly(r.accountId)) {
         const actions = span("mail-row-actions");
         const arch = iconButton("mail-act-archive", "archive", "Archive");
         const mark = iconButton("mail-act-mark", r.unread ? "read" : "unread", r.unread ? "Mark read" : "Mark unread");
         const del = iconButton("mail-act-trash", "trash", "Move to Trash");
         arch.dataset.act = "archive";
         mark.dataset.act = "mark";
         del.dataset.act = "trash";
         for (const b of [arch, mark, del]) {
            b.tabIndex = focused ? 0 : -1; // reachable by Tab from the focused row
            b.disabled = !linked;
         }
         actions.append(arch, mark, del);
         row.appendChild(actions);
      }
      return row;
   };

   const renderList = (): void => {
      const keep = new Set<string>();
      const els: HTMLElement[] = [];
      const now = performance.now();
      if (focusKey && !rows.some((r) => rowKey(r) === focusKey)) focusKey = null;
      if (!focusKey && rows.length) focusKey = rowKey(rows[0]);
      for (const r of rows) {
         const k = rowKey(r);
         keep.add(k);
         const sig = rowSig(r, k);
         let entry = rowEls.get(k);
         if (!entry || entry.sig !== sig) {
            entry = { el: buildRow(r, k), sig };
            rowEls.set(k, entry);
         }
         const w = washed.get(k);
         entry.el.classList.toggle("arrived", !!w && w > now);
         els.push(entry.el);
      }
      for (const k of rowEls.keys()) if (!keep.has(k)) rowEls.delete(k);
      /* The link state only enables/disables row actions: flip them in place, no rebuild. */
      if (renderedLinked !== linked) {
         renderedLinked = linked;
         for (const { el: r } of rowEls.values()) r.querySelectorAll<HTMLButtonElement>(".mail-row-actions button").forEach((b) => (b.disabled = !linked));
      }

      if (showSkeleton && rows.length === 0) {
         for (let i = 0; i < 6; i++) els.push(div("mail-skeleton"));
      }
      footer.replaceChildren();
      if (loadError && rows.length > 0) {
         footer.append(span("", "Couldn't load more · "));
         const retry = textButton("mail-link", "Retry");
         retry.addEventListener("click", () => loadMore());
         footer.appendChild(retry);
      } else if (lastPageEmpty && cursor !== null) {
         footer.append(span("", "Some mail couldn't be loaded · "));
         const retry = textButton("mail-link", "Retry");
         retry.addEventListener("click", () => {
            lastPageEmpty = false;
            loadMore();
         });
         footer.appendChild(retry);
      } else if (rows.length >= ROW_CAP) {
         footer.textContent = "Refine with search to see older mail";
      } else if (cursor === null && rows.length > 0) {
         footer.textContent = query ? "End of results" : "End of inbox";
      }
      els.push(footer, sentinel);

      /* Move nodes only when the order actually changed (cheap when nothing did). */
      const current = Array.from(listEl.children);
      if (current.length !== els.length || current.some((n, i) => n !== els[i])) {
         const hadFocus = listEl.contains(document.activeElement);
         listEl.replaceChildren(...els);
         if (hadFocus && focusKey) rowEls.get(focusKey)?.el.focus({ preventScroll: true });
      }
   };

   /* --- status, banners, header ------------------------------------------- */
   const bannerCopy = (code: EmailErrorCode, name: string): string => {
      if (code === "AUTH_REVOKED" || code === "AUTH_FAILED") return `${name} needs reconnecting in DAWN's settings`;
      if (code === "UNREACHABLE" || code === "TIMEOUT") return `Couldn't reach ${name}`;
      return `${name} had a problem loading mail`;
   };

   const renderBanners = (): void => {
      banners.replaceChildren();
      for (const [id, p] of partials) {
         if (dismissedBanners.has(id)) continue;
         const b = div("mail-banner");
         b.appendChild(tile(id, true));
         b.appendChild(span("mail-banner-text", bannerCopy(p.code, accountName(id))));
         if (p.code !== "AUTH_REVOKED" && p.code !== "AUTH_FAILED") {
            const retry = textButton("mail-link", "Retry");
            retry.addEventListener("click", () => {
               dismissedBanners.delete(id);
               reload();
            });
            b.appendChild(retry);
         }
         const x = textButton("mail-banner-x", "×");
         x.setAttribute("aria-label", "Dismiss");
         x.addEventListener("click", () => {
            dismissedBanners.add(id);
            renderBanners();
         });
         b.appendChild(x);
         banners.appendChild(b);
      }
   };

   const statusText = (): string => {
      if (availability === "unknown") return "Loading…";
      if (availability === "unavailable") return "Mail isn't available on this DAWN.";
      if (accounts.length === 0) return "Add an email account in DAWN's settings.";
      if (noneSelected()) return "No accounts selected";
      if (rows.length > 0 || showSkeleton || loading) return "";
      if (loadError) return `Couldn't load mail: ${loadError}`;
      if (cursor === undefined) return "";
      const n = selectedIds().length;
      if (query) return `No results for “${query}”${filterIsAll() ? "" : ` in ${n} account${n === 1 ? "" : "s"}`}`;
      return unreadOnly ? "No unread mail" : "No mail";
   };

   const totalUnread = (): number => selectedIds().reduce((s, id) => s + (counts.get(id)?.inboxUnread ?? 0), 0);

   let lastTotal = -1;
   const renderHead = (): void => {
      const total = totalUnread();
      countEl.textContent = total > 99 ? "99+" : String(total);
      countEl.classList.toggle("zero", total === 0);
      if (lastTotal >= 0 && total > lastTotal && !reducedMotion) {
         countEl.classList.remove("lift");
         void countEl.offsetWidth;
         countEl.classList.add("lift");
      }
      lastTotal = total;
      toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
      toggle.setAttribute("aria-label", `Mail, ${total} unread`);
      tilesEl.replaceChildren();
      for (const id of selectedIds()) {
         const c = counts.get(id);
         if (!c || (c.inboxUnread === 0 && c.status === "ok")) continue;
         const t = tile(id, true);
         t.classList.toggle("broken", c.status !== "ok");
         t.removeAttribute("aria-hidden");
         t.title = c.status === "ok" ? `${accountName(id)}: ${c.inboxUnread} unread` : `${accountName(id)}: needs attention`;
         t.setAttribute("aria-label", t.title);
         tilesEl.appendChild(t);
      }
      unreadPill.classList.toggle("on", unreadOnly);
      unreadPill.setAttribute("aria-pressed", unreadOnly ? "true" : "false");
      filterBtn.classList.toggle("on", !filterIsAll() || prefs.notify.length > 0);
   };

   const announce = (text: string): void => {
      live.textContent = "";
      live.textContent = text;
   };

   /* --- reader ------------------------------------------------------------- */
   const discussRef = (r: Reader): EmailRef => ({
      accountId: r.row.accountId,
      messageId: r.row.messageId,
      sender: r.message?.fromName || r.message?.fromAddr || r.row.fromName || r.row.fromAddr,
      subject: r.message?.subject ?? r.row.subject
   });

   const addrList = (list: Array<{ name: string; addr: string }>): string => list.map((a) => (a.name ? `${a.name} <${a.addr}>` : a.addr)).join(", ");

   /* The rendered body for the open message, once per (message, images shown). */
   const bodyFor = (r: Reader, m: EmailMessage): { node: Node; images: number } => {
      if (!bodyCache || bodyCache.key !== r.key || bodyCache.showImages !== r.showImages) {
         const rendered = renderEmailBody({ html: m.bodyHtml, text: m.bodyText }, r.showImages);
         bodyCache = { key: r.key, showImages: r.showImages, node: rendered.fragment, images: rendered.images };
      }
      return { node: bodyCache.node.cloneNode(true), images: bodyCache.images };
   };

   /* The open message's neighbors in the list order (null at an end; Next past the loaded rows
      is still possible while more can load). */
   const neighbors = (): { prev: EmailRow | null; next: EmailRow | null; more: boolean } => {
      const i = reader ? rows.findIndex((x) => rowKey(x) === reader!.key) : -1;
      if (i < 0) return { prev: null, next: null, more: false };
      return { prev: rows[i - 1] ?? null, next: rows[i + 1] ?? null, more: !rows[i + 1] && cursor !== null && rows.length < ROW_CAP };
   };

   const step = (dir: -1 | 1): void => {
      const n = neighbors();
      const target = dir < 0 ? n.prev : n.next;
      const keepFocus = readerCol.contains(document.activeElement);
      if (target) {
         openRow(target, keepFocus, true);
         if (split) rowEls.get(rowKey(target))?.el.scrollIntoView({ block: "nearest" });
      } else if (dir > 0 && n.more) {
         advanceAfterPage = true;
         loadMore();
      }
   };

   const currentReaderSig = (): string => {
      if (!reader) return `none|${split}`;
      const id = reader.row.accountId;
      return [reader.key, reader.state, reader.showImages, !!reader.message, split, compactDiscuss, isReadOnly(id), accountIndex.get(id), monograms.get(id), tz].join("\u0001");
   };

   const renderReader = (): void => {
      const sig = currentReaderSig();
      if (sig === readerSig) return; // nothing the reader shows changed: keep its scroll/focus/state
      readerSig = sig;
      const hadFocus = readerCol.contains(document.activeElement);
      readerCol.replaceChildren();
      if (!reader) {
         if (split) readerCol.appendChild(div("mail-reader-empty", "Select a message"));
         return;
      }
      const r = reader;
      const ro = isReadOnly(r.row.accountId);
      const ready = r.state === "ready";

      const bar = div("mail-reader-bar");
      if (!split) {
         const back = iconButton("mail-back", "back", "Back to list");
         back.addEventListener("click", () => closeReader(true));
         bar.appendChild(back);
      }
      if (r.state !== "gone") {
         const prev = iconButton("mail-prev", "up", "Previous message (K)");
         const next = iconButton("mail-next", "down", "Next message (J)");
         prev.addEventListener("click", () => step(-1));
         next.addEventListener("click", () => step(1));
         bar.append(prev, next);
      }
      if (!ro && r.state !== "gone") {
         const arch = iconButton("mail-r-archive", "archive", "Archive");
         arch.addEventListener("click", () => moveRow(r.row, "archive"));
         const mark = iconButton("mail-r-mark", "unread", "Mark unread");
         mark.addEventListener("click", () => markUnread(r.row));
         const del = iconButton("mail-r-trash", "trash", "Move to Trash");
         del.addEventListener("click", () => moveRow(r.row, "trash"));
         /* Not until the open (which marks read) has landed: a Mark unread racing it would lose.
            The link state is applied in place by syncReaderActions (no rebuild on a link blip). */
         for (const b of [arch, mark, del]) {
            b.classList.add("mail-r-act");
            b.dataset.ready = ready ? "1" : "";
         }
         bar.append(arch, mark, del);
      }
      bar.appendChild(span("mail-spacer"));
      if (r.state !== "gone") {
         if (compactDiscuss) {
            const wrap = span("mail-discuss-menu");
            const btn = textButton("mail-discuss-btn mail-primary", "Discuss ▾");
            btn.setAttribute("aria-haspopup", "menu");
            btn.setAttribute("aria-expanded", "false");
            const menu = div("mail-discuss-pop");
            menu.hidden = true;
            menu.setAttribute("role", "menu");
            const priv = textButton("mail-discuss-item", "Discuss privately");
            priv.prepend(icon("lock"));
            const here = textButton("mail-discuss-item", "Discuss here");
            for (const it of [priv, here]) it.setAttribute("role", "menuitem");
            priv.addEventListener("click", () => opts.onDiscuss(discussRef(r), { newChat: true }));
            here.addEventListener("click", () => opts.onDiscuss(discussRef(r), { newChat: false }));
            btn.addEventListener("click", () => {
               menu.hidden = !menu.hidden;
               btn.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
            });
            menu.append(priv, here);
            wrap.append(btn, menu);
            bar.appendChild(wrap);
         } else {
            const here = textButton("mail-discuss-here", "Discuss here");
            here.title = "Add this email to the current chat";
            here.addEventListener("click", () => opts.onDiscuss(discussRef(r), { newChat: false }));
            const priv = textButton("mail-discuss-private mail-primary", "Discuss privately");
            priv.title = "Start a new private chat about this email";
            priv.prepend(icon("lock"));
            priv.addEventListener("click", () => opts.onDiscuss(discussRef(r), { newChat: true }));
            bar.append(here, priv);
         }
      }
      readerCol.appendChild(bar);

      const scroll = div("mail-reader-scroll");
      const headBlock = div("mail-reader-head");
      const subj = div("mail-reader-subject", r.message?.subject ?? (r.row.subject || "(no subject)"));
      subj.tabIndex = -1;
      headBlock.appendChild(subj);
      const fromLine = div("mail-reader-from");
      const fromName = r.message?.fromName ?? r.row.fromName;
      const fromAddr = r.message?.fromAddr ?? r.row.fromAddr;
      fromLine.append(span("mail-reader-name", fromName || fromAddr));
      if (fromName) fromLine.append(span("mail-reader-addr", ` <${fromAddr}>`));
      headBlock.appendChild(fromLine);
      if (r.message) {
         const m = r.message;
         const recips = [...m.to, ...m.cc];
         if (recips.length) {
            const own = account(m.accountId)?.address;
            const toMe = recips.some((a) => a.addr === own);
            const first = toMe ? "me" : addrList(recips.slice(0, 1));
            const more = recips.length - 1;
            const toLine = div("mail-reader-to");
            const expand = textButton("mail-link mail-to-toggle", `to ${first}${more > 0 ? `, +${more}` : ""}`);
            expand.setAttribute("aria-expanded", "false");
            const full = div("mail-reader-to-full");
            full.hidden = true;
            full.append(div("", `To: ${addrList(m.to)}`));
            if (m.cc.length) full.append(div("", `Cc: ${addrList(m.cc)}`));
            if (m.replyTo && m.replyTo !== m.fromAddr) full.append(div("", `Reply-To: ${m.replyTo}`));
            expand.addEventListener("click", () => {
               full.hidden = !full.hidden;
               expand.setAttribute("aria-expanded", full.hidden ? "false" : "true");
            });
            toLine.append(expand, full);
            headBlock.appendChild(toLine);
         }
      }
      const meta = div("mail-reader-meta");
      meta.append(tile(r.row.accountId, true), span("mail-reader-acct", account(r.row.accountId)?.address ?? ""), span("mail-reader-date", fullDate(r.message?.date ?? r.row.date)));
      headBlock.appendChild(meta);
      scroll.appendChild(headBlock);

      if (r.state === "loading") {
         scroll.appendChild(div("mail-reader-note", "Loading…"));
      } else if (r.state === "gone") {
         scroll.appendChild(div("mail-reader-note", "This message was moved or deleted."));
      } else if (r.state === "error") {
         const n = div("mail-reader-note", `Couldn't open this message: ${r.error ?? ""} `);
         const retry = textButton("mail-link", "Retry");
         retry.addEventListener("click", () => openRow(r.row));
         n.appendChild(retry);
         scroll.appendChild(n);
      } else if (r.message) {
         const m = r.message;
         const rendered = bodyFor(r, m);
         if (rendered.images > 0 && !r.showImages) {
            const ib = div("mail-images-bar");
            ib.appendChild(icon("image"));
            ib.appendChild(span("", `${rendered.images} remote image${rendered.images === 1 ? "" : "s"} blocked (they can track opens) · `));
            const show = textButton("mail-link", "Show images");
            show.addEventListener("click", () => {
               if (reader && reader.key === r.key) {
                  reader.showImages = true;
                  renderReader();
               }
            });
            ib.appendChild(show);
            scroll.appendChild(ib);
         }
         const bodyEl = div("mail-reader-body");
         bodyEl.appendChild(rendered.node);
         scroll.appendChild(bodyEl);
         if (m.textTruncated || m.htmlTruncated) scroll.appendChild(div("mail-reader-trunc", "Shortened · the rest of this message wasn't loaded"));
         if (m.attachments.length) {
            const att = div("mail-attachments");
            for (const a of m.attachments) {
               const chip = span("mail-attachment");
               chip.appendChild(icon("clip"));
               chip.appendChild(span("mail-attachment-name", a.filename || "attachment"));
               chip.appendChild(span("mail-attachment-size", fmtBytes(a.size)));
               chip.title = `${a.mime} · downloads come later`;
               att.appendChild(chip);
            }
            scroll.appendChild(att);
         }
      }
      readerCol.appendChild(scroll);
      if (hadFocus) subj.focus({ preventScroll: true }); // keep keyboard users in the reader across a rebuild
   };

   /* Link state and prev/next availability change often and touch nothing else in the reader:
      apply them in place (a rebuild would reset the reader's scroll mid-read). */
   const syncReaderActions = (): void => {
      readerCol.querySelectorAll<HTMLButtonElement>(".mail-r-act").forEach((b) => (b.disabled = !linked || !b.dataset.ready));
      const prev = readerCol.querySelector<HTMLButtonElement>(".mail-prev");
      const next = readerCol.querySelector<HTMLButtonElement>(".mail-next");
      if (prev || next) {
         const n = neighbors();
         if (prev) prev.disabled = !n.prev;
         if (next) next.disabled = !n.next && !n.more;
      }
   };

   let readTimer = 0;
   const openRow = (row: EmailRow, focusReader = true, settle = false): void => {
      advanceAfterPage = false; // any open supersedes a pending "open the next one when it loads"
      window.clearTimeout(readTimer);
      const k = rowKey(row);
      if (!split && !reader) savedListScroll = listEl.scrollTop;
      selectedKey = k;
      focusKey = k;
      reader = { key: k, row, state: "loading", showImages: false };
      const seq = ++readSeq;
      render();
      if (!split && focusReader) readerCol.querySelector<HTMLElement>(".mail-reader-subject")?.focus({ preventScroll: true });
      /* Stepping (J/K, prev/next) shows the message at once but reads it (which marks it read)
         only once the selection rests, so holding J doesn't read and mark everything it passes. */
      if (settle) {
         readTimer = window.setTimeout(() => seq === readSeq && fetchRead(row, k, seq), 180);
         return;
      }
      fetchRead(row, k, seq);
   };

   const fetchRead = (row: EmailRow, k: string, seq: number): void => {
      source
         .read(row.accountId, row.messageId, true)
         .then((res) => {
            if (destroyed || seq !== readSeq || !reader || reader.key !== k) return;
            reader.message = res.message;
            reader.state = "ready";
            const local = rows.find((x) => rowKey(x) === k);
            if (local) local.unread = res.unread;
            render();
         })
         .catch((e: unknown) => {
            if (destroyed || seq !== readSeq || !reader || reader.key !== k) return;
            if (errorCode(e) === "NOT_FOUND") {
               reader.state = "gone";
               removeRows([k]);
            } else {
               reader.state = "error";
               reader.error = errorText(e);
            }
            render();
         });
   };

   const closeReader = (restoreFocus: boolean): void => {
      advanceAfterPage = false;
      window.clearTimeout(readTimer);
      const k = reader?.key ?? null;
      reader = null;
      readSeq++;
      if (!split) selectedKey = null;
      render();
      if (!split) {
         listEl.scrollTop = savedListScroll; // the list was display:none; put it back where it was
         if (k) rowEls.get(k)?.el.scrollIntoView({ block: "nearest" });
      }
      if (restoreFocus && k) rowEls.get(k)?.el.focus({ preventScroll: true });
   };

   /* --- triage ------------------------------------------------------------- */
   const removeRows = (keys: string[]): void => {
      const set = new Set(keys);
      rows = rows.filter((r) => !set.has(rowKey(r)));
      pendingNew = pendingNew.filter((r) => !set.has(rowKey(r)));
   };

   const scheduleWash = (): void => {
      window.clearTimeout(washTimer);
      washTimer = 0;
      if (washed.size === 0) return;
      const next = Math.min(...washed.values());
      washTimer = window.setTimeout(() => {
         const now = performance.now();
         for (const [k, t] of washed) if (t <= now) washed.delete(k);
         render();
         scheduleWash();
      }, Math.max(16, next - performance.now() + 50));
   };

   /* Whether a row belongs in the list as currently filtered. */
   const matchesView = (row: EmailRow): boolean =>
      selectedIds().includes(row.accountId) && (!unreadOnly || row.unread) && !query;

   const insertSorted = (row: EmailRow): void => {
      const k = rowKey(row);
      pendingNew = pendingNew.filter((r) => rowKey(r) !== k);
      if (rows.some((r) => rowKey(r) === k)) return;
      const at = rows.findIndex((r) => r.date < row.date);
      if (at < 0) {
         if (cursor !== null) return; // older than everything loaded: it'll arrive with a later page
         rows.push(row);
      } else {
         rows.splice(at, 0, row);
      }
      if (rows.length > ROW_CAP) rows.length = ROW_CAP;
      washed.set(k, performance.now() + WASH_MS);
      scheduleWash();
      lockReflow();
   };

   /* A row may have slid under the pointer: ignore row-action clicks until the pointer has
      deliberately moved (a hand jitter between two clicks doesn't count). */
   const lockReflow = (): void => {
      lockUntil = performance.now() + REFLOW_LOCK_MS;
      lockX = pointerX;
      lockY = pointerY;
   };

   const moveRow = (row: EmailRow, kind: "archive" | "trash"): void => {
      if (!linked || isReadOnly(row.accountId)) return;
      const k = rowKey(row);
      const seq = ++actionSeq;
      const index = rows.findIndex((r) => rowKey(r) === k);
      const next = index >= 0 ? (rows[index + 1] ?? rows[index - 1]) : undefined;
      const wasOpen = reader?.key === k;
      removeRows([k]);
      if (wasOpen) {
         reader = null;
         readSeq++;
         selectedKey = split && next ? rowKey(next) : null;
      }
      if (next) focusKey = rowKey(next);
      lockReflow();
      render();
      if (wasOpen && !split) {
         listEl.scrollTop = savedListScroll; // back from the narrow reader: where the list was
         if (next) rowEls.get(rowKey(next))?.el.scrollIntoView({ block: "nearest" });
      }
      if (next && (wasOpen || listEl.contains(document.activeElement))) rowEls.get(focusKey!)?.el.focus({ preventScroll: true });

      const verb = kind === "archive" ? "archive" : "move to Trash";
      const restore = (why: string): void => {
         if (destroyed) return;
         if (!rows.some((r) => rowKey(r) === k)) {
            rows.splice(Math.min(Math.max(index, 0), rows.length), 0, row);
            lockReflow();
         }
         /* Never let an older action's failure take over a newer action's undo. */
         reportFailure(seq, `Couldn't ${verb}: ${why}`, row.accountId);
         render();
      };
      const call = kind === "archive" ? source.archive(row.accountId, [row.messageId]) : source.trash(row.accountId, [row.messageId]);
      call
         .then((res) => {
            if (destroyed) return;
            if (res.failed.length) {
               const f = res.failed[0];
               restore(f.code === "NO_TRASH" ? "this account has no Trash folder" : f.message);
               return;
            }
            if (seq === actionSeq) showToast(kind === "archive" ? "Archived" : "Moved to Trash", row.accountId, res.done.map((d) => d.undo));
         })
         .catch((e: unknown) => restore(errorText(e)));
   };

   /* A failure message for an action: a toast only if no newer action owns the toast (never
      clobber a newer Undo), else announced. */
   const reportFailure = (seq: number, text: string, accountId: number): void => {
      if (seq === actionSeq) showToast(text, accountId, []);
      else announce(text);
   };

   const setUnreadFlag = (row: EmailRow, unread: boolean): void => {
      if (!linked || isReadOnly(row.accountId)) return;
      const seq = ++actionSeq;
      const prev = row.unread;
      row.unread = unread;
      render();
      source.setFlags(row.accountId, [row.messageId], { unread }).catch((e: unknown) => {
         if (destroyed) return;
         row.unread = prev;
         reportFailure(seq, `Couldn't mark ${unread ? "unread" : "read"}: ${errorText(e)}`, row.accountId);
         render();
      });
   };

   const markUnread = (row: EmailRow): void => {
      const local = rows.find((r) => rowKey(r) === rowKey(row)) ?? row;
      setUnreadFlag(local, true);
      if (!split) closeReader(true);
   };

   /* --- undo toast ---------------------------------------------------------- */
   const toastText = span("mail-toast-text");
   const toastUndo = textButton("mail-link mail-toast-undo", "Undo");
   const toastBar = span("mail-toast-bar");
   toastEl.append(toastText, toastUndo, toastBar);

   const hideToast = (): void => {
      if (toast) window.clearTimeout(toast.timer);
      toast = null;
      toastEl.hidden = true;
   };
   const armToast = (): void => {
      if (!toast) return;
      window.clearTimeout(toast.timer);
      toast.startedAt = performance.now();
      toast.timer = window.setTimeout(hideToast, toast.remaining);
   };
   const showToast = (text: string, accountId: number, tokens: string[]): void => {
      if (destroyed) return;
      hideToast(); // one at a time: a new action replaces the older undo
      toast = { accountId, tokens, remaining: TOAST_MS, startedAt: 0, timer: 0 };
      toastText.textContent = text;
      toastUndo.hidden = tokens.length === 0;
      toastEl.hidden = false;
      toastEl.classList.remove("paused");
      toastBar.classList.remove("run");
      void toastBar.offsetWidth;
      if (tokens.length) toastBar.classList.add("run");
      armToast();
   };
   const pauseToast = (): void => {
      if (!toast) return;
      window.clearTimeout(toast.timer);
      toast.remaining = Math.max(500, toast.remaining - (performance.now() - toast.startedAt));
      toastEl.classList.add("paused");
   };
   const resumeToast = (): void => {
      toastEl.classList.remove("paused");
      armToast();
   };
   toastEl.addEventListener("pointerenter", pauseToast);
   toastEl.addEventListener("pointerleave", resumeToast);
   toastEl.addEventListener("focusin", pauseToast);
   toastEl.addEventListener("focusout", resumeToast);
   toastUndo.addEventListener("click", () => {
      if (!toast || !toast.tokens.length) return;
      const { accountId, tokens } = toast;
      const seq = ++actionSeq;
      hideToast();
      source
         .undo(accountId, tokens)
         .then((res) => {
            if (destroyed) return;
            for (const r of res.restored) {
               /* The restore's own `created` echo may have queued it behind the pill: drop it
                  there, and only put it in the list if it fits the current view. */
               pendingNew = pendingNew.filter((p) => rowKey(p) !== rowKey(r.row));
               if (matchesView(r.row)) insertSorted(r.row);
            }
            if (res.failed.length) reportFailure(seq, `Couldn't undo: ${res.failed[0].message}`, accountId);
            render();
         })
         .catch((e: unknown) => !destroyed && reportFailure(seq, `Couldn't undo: ${errorText(e)}`, accountId));
   });

   /* --- popover (accounts + notifications) -------------------------------- */
   const renderPopover = (): void => {
      const focusedId = (document.activeElement as HTMLElement | null)?.dataset?.focusId;
      popover.replaceChildren();
      const fs = document.createElement("fieldset");
      fs.className = "mail-pop-set";
      const lg = document.createElement("legend");
      lg.textContent = "Show mail from";
      fs.appendChild(lg);
      const allLabel = document.createElement("label");
      allLabel.className = "mail-pop-row";
      const allBox = document.createElement("input");
      allBox.type = "checkbox";
      allBox.dataset.focusId = "all";
      allBox.checked = filterIsAll();
      allBox.addEventListener("change", () => {
         prefs.filter = allBox.checked ? null : [];
         savePrefs();
         reload();
         renderPopover();
      });
      allLabel.append(allBox, span("mail-pop-name", "All accounts"));
      fs.appendChild(allLabel);
      const sel = new Set(selectedIds());
      for (const a of accounts) {
         const row = document.createElement("div");
         row.className = "mail-pop-row";
         const lab = document.createElement("label");
         lab.className = "mail-pop-check";
         const box = document.createElement("input");
         box.type = "checkbox";
         box.dataset.focusId = `acct-${a.id}`;
         box.checked = sel.has(a.id);
         box.addEventListener("change", () => {
            const next = new Set(selectedIds());
            if (box.checked) next.add(a.id);
            else next.delete(a.id);
            /* Every account checked = All; none checked = none (the list offers Show all). */
            prefs.filter = next.size === accounts.length ? null : [...next];
            savePrefs();
            reload();
            renderPopover();
         });
         const c = counts.get(a.id);
         lab.append(box, tile(a.id, true), span("mail-pop-name", a.address), span("mail-pop-count", c && c.inboxUnread ? String(c.inboxUnread) : ""));
         const bell = iconButton("mail-pop-bell", "bell", `Notify me of new mail in ${a.displayName || a.address}`);
         bell.dataset.focusId = `bell-${a.id}`;
         const on = prefs.notify.includes(a.id);
         bell.classList.toggle("on", on);
         bell.setAttribute("aria-pressed", on ? "true" : "false");
         bell.addEventListener("click", () => {
            prefs.notify = on ? prefs.notify.filter((x) => x !== a.id) : [...prefs.notify, a.id];
            savePrefs();
            syncSubscription();
            renderPopover();
            renderHead();
         });
         row.append(lab, bell);
         fs.appendChild(row);
      }
      popover.appendChild(fs);
      if (prefs.notify.length) {
         const so = document.createElement("label");
         so.className = "mail-pop-row mail-pop-sender";
         const box = document.createElement("input");
         box.type = "checkbox";
         box.dataset.focusId = "sender";
         box.checked = prefs.senderOnly;
         box.addEventListener("change", () => {
            prefs.senderOnly = box.checked;
            savePrefs();
         });
         so.append(box, span("mail-pop-name", "Notifications show the sender only"));
         popover.appendChild(so);
      }
      /* Re-rendering replaced the focused control: put focus back on its twin (Escape keeps working). */
      if (focusedId) popover.querySelector<HTMLElement>(`[data-focus-id="${focusedId}"]`)?.focus();
   };
   const openPopover = (): void => {
      renderPopover();
      popover.hidden = false;
      filterBtn.setAttribute("aria-expanded", "true");
      popover.querySelector<HTMLInputElement>("input")?.focus();
   };
   const closePopover = (focusTrigger: boolean): void => {
      if (popover.hidden) return;
      popover.hidden = true;
      filterBtn.setAttribute("aria-expanded", "false");
      if (focusTrigger) filterBtn.focus();
   };
   const closeDiscussMenus = (except?: Node): boolean => {
      let closed = false;
      readerCol.querySelectorAll<HTMLElement>(".mail-discuss-pop").forEach((m) => {
         if (!m.hidden && !(except && m.parentElement?.contains(except))) {
            m.hidden = true;
            m.parentElement?.querySelector(".mail-discuss-btn")?.setAttribute("aria-expanded", "false");
            closed = true;
         }
      });
      return closed;
   };
   const onDocPointer = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (!popover.hidden && !popover.contains(t) && !filterBtn.contains(t)) closePopover(false);
      closeDiscussMenus(t);
   };
   document.addEventListener("pointerdown", onDocPointer);

   /* --- notifications (7.3) ------------------------------------------------ */
   const noticeFor = (accountId: number): void => {
      const st = notifyState.get(accountId);
      if (!st) return;
      const name = accountName(accountId);
      const sender = st.last.fromName || st.last.fromAddr;
      opts.notify({
         id: `mail-new:${accountId}`,
         kind: "mail",
         summary: st.count === 1 ? `New mail · ${name}` : `${st.count} new · ${name}`,
         detail: prefs.senderOnly ? `From ${sender}` : `${sender}: ${st.last.subject || "(no subject)"}`,
         tone: "nominal",
         open: { kind: "email", accountId, messageId: st.last.messageId }
      });
   };
   const clearNotifyState = (accountId: number): void => {
      const st = notifyState.get(accountId);
      if (st) window.clearTimeout(st.timer);
      notifyState.delete(accountId);
   };
   const queueNotice = (row: EmailRow): void => {
      if (!prefs.notify.includes(row.accountId) || !row.unread || !vis.isVisible()) return;
      if (panelEffective()) return; // they're looking at the list: the arrival itself is the signal
      const st = notifyState.get(row.accountId);
      /* The window runs from the LAST arrival, so the card's count and the coalescing agree. */
      if (st) window.clearTimeout(st.timer);
      const timer = window.setTimeout(() => notifyState.delete(row.accountId), NOTIFY_COALESCE_MS);
      notifyState.set(row.accountId, { count: (st?.count ?? 0) + 1, last: row, timer });
      noticeFor(row.accountId);
   };

   /* --- render ------------------------------------------------------------- */
   const render = (): void => {
      if (destroyed) return;
      el.classList.toggle("mail-collapsed", !expanded);
      el.classList.toggle("mail-split", split);
      el.classList.toggle("mail-reading", !split && !!reader);
      el.classList.toggle("mail-offline", !linked && availability === "available");
      renderHead();
      if (!expanded || !vis.isVisible()) return; // nothing below is on screen
      stampNow();
      searchClear.classList.toggle("shown", searchInput.value.length > 0);
      const s = statusText();
      statusEl.textContent = s;
      if (s && noneSelected()) {
         statusEl.append(" · ");
         const all = textButton("mail-link", "Show all");
         all.addEventListener("click", () => {
            prefs.filter = null;
            savePrefs();
            reload();
            if (!popover.hidden) renderPopover();
         });
         statusEl.appendChild(all);
      }
      statusEl.hidden = !s;
      renderBanners();
      newPill.hidden = pendingNew.length === 0 && !searchNewMail;
      newPill.textContent = searchNewMail ? "New mail · Clear search" : `${pendingNew.length}${pendingOverflow ? "+" : ""} new`;
      renderList();
      renderReader();
      syncReaderActions();
   };

   /* --- layout: split + compact discuss, from the panel's own width ------- */
   const onLayout = (): void => {
      if (!expanded) return;
      const w = el.clientWidth;
      if (w === 0) return;
      const nextSplit = split ? w >= SPLIT_OFF : w >= SPLIT_ON;
      const readerW = nextSplit ? w - Math.min(380, Math.max(280, w * 0.38)) : w;
      const nextCompact = readerW < COMPACT_DISCUSS;
      if (nextSplit === split && nextCompact === compactDiscuss) return;
      const toSplit = nextSplit !== split;
      split = nextSplit;
      compactDiscuss = nextCompact;
      if (toSplit && !split && !reader) selectedKey = null; // narrow shows the list; an open message stays open
      rowEls.clear(); // selection styling depends on the layout
      render();
   };
   const layoutRo = new ResizeObserver(() => onLayout());
   layoutRo.observe(el);

   /* --- expand / collapse --------------------------------------------------- */
   const setExpanded = (on: boolean): void => {
      expanded = on;
      try {
         localStorage.setItem(OPEN_KEY, on ? "true" : "false");
      } catch {
         /* blocked */
      }
      closePopover(false);
      resizable.setEnabled(on);
      readerSig = ""; // the reader DOM may be stale after a collapse
      render();
      if (on) onLayout();
      syncEffective();
   };

   /* --- events ------------------------------------------------------------- */
   /* The bar is also the drag handle: a press that moved is a drag, not a toggle. */
   let pressX = 0;
   let pressY = 0;
   toggle.addEventListener("pointerdown", (e) => {
      pressX = e.clientX;
      pressY = e.clientY;
   });
   toggle.addEventListener("click", (e) => {
      if (e.detail > 0 && Math.hypot(e.clientX - pressX, e.clientY - pressY) > 4) return;
      setExpanded(!expanded);
   });
   filterBtn.addEventListener("click", () => (popover.hidden ? openPopover() : closePopover(true)));
   unreadPill.addEventListener("click", () => {
      unreadOnly = !unreadOnly;
      try {
         localStorage.setItem(UNREAD_KEY, unreadOnly ? "1" : "0");
      } catch {
         /* blocked */
      }
      reload();
   });
   refreshBtn.addEventListener("click", () => {
      refreshBtn.classList.remove("spin");
      void refreshBtn.offsetWidth;
      refreshBtn.classList.add("spin");
      dismissedBanners.clear();
      staleReloads = 0;
      refreshCounts();
      reload();
   });
   searchInput.addEventListener("input", () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
         const q = searchInput.value.trim();
         if (q === query) return;
         query = q;
         reload();
      }, SEARCH_DEBOUNCE_MS);
      searchClear.classList.toggle("shown", searchInput.value.length > 0);
   });
   const clearSearch = (): void => {
      window.clearTimeout(searchTimer);
      searchInput.value = "";
      if (query) {
         query = "";
         reload();
      } else {
         render();
      }
   };
   searchClear.addEventListener("click", clearSearch);
   newPill.addEventListener("click", () => {
      if (searchNewMail) {
         clearSearch();
         return;
      }
      if (pendingOverflow) {
         reload(); // too many queued to splice in: start fresh from the top
         return;
      }
      const queued = pendingNew;
      pendingNew = [];
      for (const r of queued) insertSorted(r);
      listEl.scrollTop = 0;
      render();
   });

   listEl.addEventListener("pointerenter", () => (pointerOverList = true));
   listEl.addEventListener("pointerleave", () => (pointerOverList = false));
   const onPointerMove = (e: PointerEvent): void => {
      pointerX = e.clientX;
      pointerY = e.clientY;
      if (lockUntil && Math.hypot(pointerX - lockX, pointerY - lockY) > REFLOW_UNLOCK_PX) lockUntil = 0;
   };
   window.addEventListener("pointermove", onPointerMove, { passive: true });

   const rowFromEvent = (e: Event): EmailRow | undefined => {
      const k = (e.target as HTMLElement).closest<HTMLElement>(".mail-row")?.dataset.key;
      return k ? rows.find((r) => rowKey(r) === k) : undefined;
   };
   listEl.addEventListener("click", (e) => {
      const row = rowFromEvent(e);
      if (!row) return;
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act) {
         e.stopPropagation();
         if (performance.now() < lockUntil) return; // a row slid under the cursor: ignore
         if (act === "mark" && reader?.key === rowKey(row) && reader.state === "loading") return; // its open marks read: wait
         if (act === "archive") moveRow(row, "archive");
         else if (act === "trash") moveRow(row, "trash");
         else if (act === "mark") setUnreadFlag(row, !row.unread);
         return;
      }
      openRow(row, false);
   });

   const focusRow = (k: string | null): void => {
      if (!k) return;
      focusKey = k;
      renderList();
      const r = rowEls.get(k)?.el;
      r?.focus();
      r?.scrollIntoView({ block: "nearest" });
   };
   listEl.addEventListener("keydown", (e) => {
      if (!(e.target as HTMLElement).classList.contains("mail-row")) return;
      const idx = rows.findIndex((r) => rowKey(r) === focusKey);
      const at = (i: number): string | null => (rows[i] ? rowKey(rows[i]) : null);
      if (e.key === "ArrowDown") {
         e.preventDefault();
         focusRow(at(Math.min(rows.length - 1, idx + 1)));
         if (idx + 1 >= rows.length - 3) loadMore();
      } else if (e.key === "ArrowUp") {
         e.preventDefault();
         focusRow(at(Math.max(0, idx - 1)));
      } else if (e.key === "Home") {
         e.preventDefault();
         focusRow(at(0));
      } else if (e.key === "End") {
         e.preventDefault();
         focusRow(at(rows.length - 1));
      } else if (e.key === "Enter" || e.key === " ") {
         e.preventDefault();
         const row = rows[idx];
         if (row) openRow(row, !split);
      }
   });

   const onKeyDown = (e: KeyboardEvent): void => {
      /* J / K step through messages while one is open (never while typing in a field). */
      const typing = (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]");
      if (reader && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "j" || e.key === "k")) {
         e.preventDefault();
         step(e.key === "j" ? 1 : -1);
         return;
      }
      if (e.key !== "Escape") return;
      if (!popover.hidden) {
         e.preventDefault();
         closePopover(true);
      } else if (closeDiscussMenus()) {
         e.preventDefault();
      } else if (query || searchInput.value) {
         e.preventDefault();
         clearSearch();
      } else if (!split && reader) {
         e.preventDefault();
         closeReader(true);
      }
   };
   el.addEventListener("keydown", onKeyDown);

   /* --- sink --------------------------------------------------------------- */
   const setCounts = (c: EmailUnreadCount[]): void => {
      counts.clear();
      for (const x of c) counts.set(x.accountId, x);
      renderHead(); // counts touch only the header (and an open popover)
      if (!popover.hidden) renderPopover();
   };

   const applyChanges = (ch: EmailChanges): void => {
      if (destroyed || !accounts.some((a) => a.id === ch.accountId)) return;
      states.set(ch.accountId, ch.state);
      for (const c of ch.created) queueNotice(c);
      if (reader && ch.destroyed.some((id) => keyOf(ch.accountId, id) === reader!.key)) reader.state = "gone";
      if (!panelEffective()) {
         /* Nobody is looking at the list: don't grow or reshape it in the background; reload when
            it comes back into view. */
         listStale = true;
         return;
      }
      let shifted = false;
      if (ch.destroyed.length) {
         const before = rows.length;
         removeRows(ch.destroyed.map((id) => keyOf(ch.accountId, id)));
         shifted = rows.length !== before;
      }
      for (const u of ch.updated) {
         const i = rows.findIndex((r) => rowKey(r) === rowKey(u));
         if (i >= 0) rows[i] = { ...rows[i], ...u };
      }
      let arrived = 0;
      for (const c of ch.created) {
         if (!selectedIds().includes(c.accountId) || (unreadOnly && !c.unread)) continue;
         const k = rowKey(c);
         if (rows.some((r) => rowKey(r) === k) || pendingNew.some((r) => rowKey(r) === k)) continue;
         arrived++;
         if (query) {
            searchNewMail = true;
            continue;
         }
         const busy = listEl.scrollTop > 4 || pointerOverList || listEl.contains(document.activeElement);
         if (!busy) {
            insertSorted(c);
         } else if (pendingNew.length < PAGE) {
            pendingNew.unshift(c);
         } else {
            pendingOverflow = true;
         }
      }
      if (shifted) lockReflow();
      if (arrived) announce(`${arrived} new message${arrived === 1 ? "" : "s"}`);
      render();
   };

   /* Back online: ask each account what changed while we were away (7.2). */
   const catchUp = (): void => {
      for (const [accountId, state] of states) {
         source
            .changes(accountId, state)
            .then((ch) => applyChanges(ch))
            .catch(() => {
               if (destroyed) return;
               states.delete(accountId);
               /* Couldn't learn what changed (no history, or the request failed): don't silently
                  miss it; reload the list now or when it's next on screen. */
               if (panelEffective()) reload();
               else listStale = true;
            });
      }
   };

   const controller: EmailPanelController = {
      setAvailability: (a) => {
         const was = availability;
         availability = a;
         if (a === "available" && was !== "available" && panelEffective()) reload();
         syncSubscription();
         render();
      },
      setAccounts: (list) => {
         accounts = list.slice();
         computeIdentity();
         rowEls.clear();
         readerSig = "";
         if (panelEffective()) reload();
         else render();
      },
      setUnreadCounts: setCounts,
      applyChanges,
      setLinked: (on) => {
         const was = linked;
         linked = on;
         syncSubscription();
         if (on && !was && availability === "available") {
            refreshCounts();
            if (panelEffective() && (listStale || rows.length === 0)) reload();
            else catchUp();
         }
         render();
      },
      isVisible: vis.isVisible,
      setVisible: (on) => {
         vis.setVisible(on);
         if (on) {
            raiseMovable(el);
            resizable.setEnabled(expanded);
            readerSig = "";
            render();
            onLayout();
         }
         syncEffective();
      },
      setSuspended: (on) => {
         if (suspended === on) return;
         suspended = on;
         syncEffective();
      },
      setTimezone: (z) => {
         tz = z;
         render(); // tz is in each row's signature, so only rows whose labels change rebuild
      },
      openMessage: (accountId, messageId) => {
         if (!vis.isVisible()) controller.setVisible(true);
         if (!expanded) setExpanded(true);
         raiseMovable(el); // opened from a card: bring it in front of other panels
         const k = keyOf(accountId, messageId);
         const row =
            rows.find((r) => rowKey(r) === k) ??
            ({ accountId, messageId, fromName: "", fromAddr: "", subject: "", date: Math.floor(Date.now() / 1000), preview: "", unread: true } as EmailRow);
         opts.removeNotice(`mail-new:${accountId}`);
         clearNotifyState(accountId);
         openRow(row);
      },
      destroy: () => {
         destroyed = true;
         if (subscribed) source.setSubscription(false);
         subscribed = false;
         source.detach();
         hideToast();
         clearSkeleton();
         window.clearTimeout(searchTimer);
         window.clearTimeout(washTimer);
         window.clearTimeout(readTimer);
         for (const st of notifyState.values()) window.clearTimeout(st.timer);
         notifyState.clear();
         io.disconnect();
         layoutRo.disconnect();
         document.removeEventListener("visibilitychange", onVisChange);
         document.removeEventListener("pointerdown", onDocPointer);
         window.removeEventListener("pointermove", onPointerMove);
         el.removeEventListener("keydown", onKeyDown);
         resizable.dispose();
         movable?.dispose();
         el.remove();
      }
   };

   render();
   source.attach(controller); // pushes availability + accounts, which load the list if shown
   wasEffective = panelEffective();
   syncSubscription();
   return controller;
}
