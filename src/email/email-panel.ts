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
 * blocked until "Show images", or a trusted sender / Always show images, which only set that same
 * per-message flag). Mail lives in memory only (logout/user switch reload the page). Settings that
 * follow the person (3.9) go through the injected UserPrefs (8.7); this screen's choices (account
 * filter, bells, chime) are one per-user key in USER_KEYS; layout keys are per machine. New-mail
 * notice ids are per account, never a message id or subject (the notify layer persists positions by id).
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
import { watchTabAway } from "../util/tab-away.ts";
import { renderEmailBody } from "./render-body.ts";
import { fitImages, fitRatio } from "./fit-images.ts";
import type { UserPrefs } from "../ingest/prefs.ts";
import {
   AFTER_MOVE,
   ALWAYS_IMAGES,
   cleanTrusted,
   MARK_READ,
   MARK_READ_DELAY_MS,
   normalizeAddress,
   PREVIEWS,
   SENDER_ONLY,
   TRUSTED_SENDERS,
   type AfterMove,
   type MarkRead
} from "./mail-prefs.ts";

export interface EmailPanelOptions {
   source: EmailSource;
   /* The settings that follow the person (3.9 / 8.7): trusted senders, reading habits. */
   prefs: UserPrefs;
   /* A soft chime for a new-mail notice (gated by the app's "Alarm sounds"); absent = silent. */
   playChime?(): void;
   /* Hand a message to the assistant: a new private chat, or the current one. */
   onDiscuss(ref: EmailRef, opts: { newChat: boolean }): void;
   /* Whether a chat turn can carry an email reference (DAWN's `email_refs`): the Discuss controls
      exist only then (absent = never), so nothing visible waits on DAWN work that isn't there. */
   canDiscuss?(): boolean;
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
const MAX_EMPTY_REFRESH_PAGES = 3; // empty pages in a row (with more after them) before a refresh gives up
const NOTIFY_COALESCE_MS = 30_000;
const SEARCH_DEBOUNCE_MS = 300;

/* This screen's choices (3.9): which accounts to show, which ring a bell, and whether it chimes. */
interface Prefs {
   filter: number[] | null; // null = all accounts
   notify: number[];
   chime: boolean;
}

interface Reader {
   key: string;
   row: EmailRow;
   state: "loading" | "ready" | "gone" | "error";
   message?: EmailMessage;
   error?: string;
   showImages: boolean;
   /* The images were shown by a setting (a trusted sender or Always show images), not a click. */
   autoImages?: boolean;
   /* The sender's address as a trust key (null when it isn't one well-formed address). */
   fromKey?: string | null;
}

interface Toast {
   /* Every move in the group that can be undone, from any account (one undo call per account). */
   tokens: Array<{ accountId: number; token: string }>;
   move: boolean; // a move's toast (a plain message never groups)
   archived: number;
   trashed: number;
   groupStart: number; // when the group's first move landed (its tokens expire 60 s after their move)
   baseText: string; // the toast's own text
   note: string; // a failure shown beside it (kept across joins)
   expiry: number; // hides a move group before its oldest token expires, paused or not
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
   close: ["M6 6l12 12", "M18 6L6 18"],
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
   const filterBtn = iconButton("mail-filter-btn", "filter", "Mail options");
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
   popover.setAttribute("aria-label", "Mail options");

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
      minWidth: 340, // matches the CSS min-width: the narrowest the reader bar still fits
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
   let accountsKnown = false; // the source has sent its account list at least once
   let accountsError: string | null = null; // the account list failed to load (it is retried)
   const accountIndex = new Map<number, number>(); // id -> stable color slot (0-based)
   let monograms = new Map<number, string>();
   const counts = new Map<number, EmailUnreadCount>();
   const states = new Map<number, string>(); // last change-state per account (reconnect catch-up)
   let tz: string | undefined;

   let prefs: Prefs = { filter: null, notify: [], chime: false };
   let legacySenderOnly = false;
   try {
      const raw = localStorage.getItem(MAIL_PREFS_KEY);
      if (raw) {
         const p = JSON.parse(raw) as Partial<Prefs> & { senderOnly?: unknown };
         prefs = {
            filter: Array.isArray(p.filter) ? p.filter.filter((n) => Number.isInteger(n)) : null,
            notify: Array.isArray(p.notify) ? p.notify.filter((n) => Number.isInteger(n)) : [],
            chime: p.chime === true
         };
         legacySenderOnly = p.senderOnly === true;
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
   /* "Show the sender only" moved to the settings that follow the person: carry an old choice over
      once (8.7), then this screen's key no longer holds it. */
   const userPrefs = opts.prefs;
   if (legacySenderOnly) {
      userPrefs.set(SENDER_ONLY, true);
      savePrefs();
   }
   /* Until this connection's settings have loaded, the privacy-sensitive ones stay strict (3.9):
      no automatic images, sender-only notices. */
   const trustedSenders = (): Set<string> => new Set(userPrefs.loaded() ? userPrefs.get(TRUSTED_SENDERS) : []);
   const alwaysImages = (): boolean => userPrefs.loaded() && userPrefs.get(ALWAYS_IMAGES);
   const senderOnly = (): boolean => !userPrefs.loaded() || userPrefs.get(SENDER_ONLY);
   const markReadMode = (): MarkRead => userPrefs.get(MARK_READ);
   const afterMove = (): AfterMove => userPrefs.get(AFTER_MOVE);
   const previews = (): boolean => userPrefs.get(PREVIEWS);

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
   let listStale = false; // changes arrived while the list wasn't on screen: refresh on return
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
   let fullDiscussNeeds = 0; // the reader width the full Discuss buttons were measured to need
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
   let advanceFrom: number | null = null; // after a move: open rows[advanceFrom] once the next page lands
   let readerSig = "";
   let bodyCache: { key: string; showImages: boolean; node: DocumentFragment; images: number; designWidth: number } | null = null;
   /* The open message's body + its design width: its images are re-fitted when the reader resizes. */
   let fitTarget: { el: HTMLElement; design: number; width: number } | null = null;
   const refit = (): void => {
      if (!fitTarget) return;
      const cs = getComputedStyle(fitTarget.el);
      const width = fitTarget.el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (width === fitTarget.width) return; // only the height moved (e.g. images loading)
      fitTarget.width = width;
      fitImages(fitTarget.el, fitRatio(width, fitTarget.design));
   };
   /* Watches the reader's scroll area, whose size comes from the panel layout, never the body the
      fitting resizes (watching that would re-trigger itself every frame). */
   const bodyRo = new ResizeObserver(() => refit());
   const unfit = (): void => {
      bodyRo.disconnect();
      fitTarget = null;
   };
   const notifyState = new Map<number, { count: number; last: EmailRow; timer: number }>();

   /* --- accounts ----------------------------------------------------------- */
   const account = (id: number): EmailAccount | undefined => accounts.find((a) => a.id === id);
   const accountName = (id: number): string => account(id)?.displayName || account(id)?.address || "Mail";
   const isReadOnly = (id: number): boolean => account(id)?.readOnly ?? true;
   /* Archive / trash: not on a read-only account, and only once the source can move mail.
      Read/unread works everywhere (only the read state changes). */
   const canMove = (id: number): boolean => !isReadOnly(id) && source.supportsMoves();
   /* Re-read on every reader render: the link-up after each config frame re-renders, so the controls
      follow DAWN's features as they change across reconnects. */
   const canDiscuss = (): boolean => opts.canDiscuss?.() ?? false;
   /* Per action: hidden only when DAWN says the account has no Archive / Trash (unknown = offered,
      and the refusal explains). */
   const canArchive = (id: number): boolean => canMove(id) && account(id)?.canArchive !== false;
   const canTrash = (id: number): boolean => canMove(id) && account(id)?.canTrash !== false;
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
   let subscribed = false;
   /* A hidden tab counts only after a grace period, so a quick tab hop doesn't drop and refetch. */
   const tabAway = watchTabAway(() => syncEffective());
   const panelEffective = (): boolean => vis.isVisible() && expanded && !suspended && !tabAway.away();
   /* What needs the person actually looking, with no grace: marking read, and whether a new-mail
      bell is redundant. A hidden tab never marks a message read or swallows a bell. */
   const onScreen = (): boolean => panelEffective() && !document.hidden;
   const onRawVisibility = (): void => syncMark();
   document.addEventListener("visibilitychange", onRawVisibility);
   /* Listen while the panel is on screen, or (opt-in bells) while it's COLLAPSED or the tab is
      hidden. Turning the panel off in the Panels menu silences it entirely: the bell settings live
      in the panel, so an off panel must not keep raising cards the user can't trace. */
   const notifyOn = (): boolean => source.supportsLiveChanges() && prefs.notify.length > 0;
   const wantSubscription = (): boolean =>
      availability === "available" && (panelEffective() || (vis.isVisible() && notifyOn() && linked));
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
         /* Coming back into view: catch up (the list may be stale while unsubscribed). A list
            already on screen is refreshed in place, so returning never blanks it or loses the scroll. */
         refreshCounts();
         if (rows.length === 0 || loadError) reload();
         else refreshInPlace();
      }
      wasEffective = eff;
      syncSubscription();
      syncMark();
   };

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

   /* Edits made while an in-place refresh is in flight (see refreshInPlace). */
   let refreshing: {
      dropped: Set<string>;
      added: Map<string, EmailRow>;
      updated: Map<string, Partial<EmailRow>>; // changes pushed by DAWN (another client, Friday)
      unread: Map<string, boolean>; // the user's own read/unread here
   } | null = null;
   const reload = (): void => {
      listGen++;
      refreshing = null; // a refresh this supersedes has nothing left to replay onto
      rows = [];
      cursor = undefined;
      loadError = null;
      loading = false;
      listStale = false;
      lastPageEmpty = false;
      advanceAfterPage = false;
      advanceFrom = null;
      pendingNew = [];
      pendingOverflow = false;
      searchNewMail = false;
      partials.clear();
      rowEls.clear();
      listEl.scrollTop = 0;
      loadMore();
   };

   /* Refresh the list on screen without blanking it: re-read as many pages as are loaded now
      (through DAWN's own paging, so there are no gaps and nothing is guessed from dates), then swap
      them in at once. Scroll, the open message and the row elements stay. What the user does while
      it's in flight (a move, read/unread, an undo putting mail back) is replayed onto the fresh
      rows, since the pages were read before it. New mail at the top waits behind the "new" pill
      while the user is scrolled or pointing at the list, like live mail. A failure keeps the list on
      screen (marked stale, so the next return or link-up tries again); only a stale cursor reloads.
      An account that fails this refresh keeps its rows. */
   const noteUnread = (row: EmailRow): void => {
      refreshing?.unread.set(rowKey(row), row.unread);
   };
   /* Recorded whether or not the row is loaded: the refresh may have read it already. */
   const noteUpdate = (u: Partial<EmailRow> & { accountId: number; messageId: string }): void => {
      if (!refreshing) return;
      const k = rowKey(u as EmailRow);
      refreshing.updated.set(k, { ...refreshing.updated.get(k), ...u });
   };
   const refreshInPlace = (): void => {
      if (destroyed || availability !== "available" || accounts.length === 0 || noneSelected()) return;
      if (!linked) {
         listStale = true; // e.g. a laptop waking before the link is back: link-up refreshes it
         return;
      }
      if (rows.length === 0) return reload(); // nothing on screen to keep
      listGen++;
      const gen = listGen;
      loading = true;
      listStale = false;
      advanceFrom = null; // they belonged to a page request this one supersedes
      advanceAfterPage = false;
      /* Read until the fresh pages reach the oldest row loaded now, so new mail at the top can't push
         loaded rows out of reach and leave a gap. DAWN keeps each account's own order (IMAP by UID),
         so neither the tail's key nor a date alone proves it: also require at least as many rows as
         are loaded now. Empty pages with more after them are read through (a few in a row at most);
         if the fresh pages never reach the tail, the list on screen stays as it is (marked stale)
         rather than shrinking under the user. */
      const oldTail = rows[rows.length - 1];
      const tailKey = rowKey(oldTail);
      const oldCount = rows.length;
      const oldKeys = new Set(rows.map(rowKey));
      const oldHead = rows.length ? rows[0].date : -Infinity;
      const edits = {
         dropped: new Set<string>(),
         added: new Map<string, EmailRow>(),
         updated: new Map<string, Partial<EmailRow>>(),
         unread: new Map<string, boolean>()
      };
      refreshing = edits;
      const base = { accountIds: filterIsAll() ? undefined : selectedIds(), unreadOnly, query: query || undefined, limit: PAGE };
      const buf: EmailRow[] = [];
      const seen = new Set<string>();
      const freshPartials: typeof partials = new Map();
      let next: string | null = null;
      let reachedTail = false;
      let empties = 0;
      const fetchPages = async (): Promise<"swap" | "keep" | "superseded"> => {
         let cur: string | undefined;
         for (;;) {
            const r = await source.list({ ...base, cursor: cur });
            if (destroyed || gen !== listGen) return "superseded";
            const tail = buf.length ? buf[buf.length - 1].date : Infinity;
            let outOfOrder = false;
            let pushed = 0;
            for (const row of r.rows) {
               const k = rowKey(row);
               if (seen.has(k)) continue;
               seen.add(k);
               pushed++;
               if (k === tailKey || row.date < oldTail.date) reachedTail = true;
               if (row.date > tail) outOfOrder = true; // same rule as loadMore
               buf.push(row);
            }
            if (outOfOrder) buf.sort((x, y) => y.date - x.date);
            for (const f of r.partial) freshPartials.set(f.accountId, { code: f.code, message: f.message });
            next = r.cursor;
            if (next === null || buf.length >= ROW_CAP) return "swap";
            if (reachedTail) {
               /* Rows that will survive the swap vs the loaded rows that weren't moved away meanwhile. */
               let goneOld = 0;
               for (const k of edits.dropped) if (oldKeys.has(k)) goneOld++;
               let survivors = 0;
               for (const r of buf) if (!edits.dropped.has(rowKey(r))) survivors++;
               if (survivors >= oldCount - goneOld) return "swap";
            }
            empties = pushed === 0 ? empties + 1 : 0; // a page of nothing new counts as empty
            if (empties >= MAX_EMPTY_REFRESH_PAGES) return "keep";
            cur = next;
         }
      };
      fetchPages()
         .then((outcome) => {
            if (outcome === "superseded") return;
            if (outcome === "keep") {
               listStale = true;
               return;
            }
            let list = buf.filter((r) => !edits.dropped.has(rowKey(r)));
            /* An account that failed this refresh keeps the rows it had (its place stays in the cursor). */
            const inBuf = new Set(list.map(rowKey));
            for (const r of rows) {
               if (!freshPartials.has(r.accountId) || inBuf.has(rowKey(r))) continue;
               const at = list.findIndex((x) => x.date < r.date);
               if (at >= 0) list.splice(at, 0, r);
               else list.push(r);
            }
            list = list.map((r) => {
               const k = rowKey(r);
               const upd = edits.updated.get(k);
               const u = edits.unread.get(k);
               let out = upd ? { ...r, ...upd } : r;
               if (u !== undefined && u !== out.unread) out = { ...out, unread: u };
               return out;
            });
            for (const [k, row] of edits.added) {
               if (list.some((r) => rowKey(r) === k)) continue;
               const at = list.findIndex((r) => r.date < row.date);
               if (at >= 0) list.splice(at, 0, row);
               else if (next === null) list.push(row);
            }
            const arrived = list.filter((r) => !oldKeys.has(rowKey(r)) && !edits.added.has(rowKey(r)) && r.date > oldHead);
            const busy = listEl.scrollTop > 4 || pointerOverList || listEl.contains(document.activeElement);
            if (busy && arrived.length && !query) {
               const held = new Set(arrived.map(rowKey));
               list = list.filter((r) => !held.has(rowKey(r)));
               for (const r of arrived.reverse()) {
                  if (pendingNew.some((p) => rowKey(p) === rowKey(r))) continue;
                  if (pendingNew.length < PAGE) pendingNew.unshift(r);
                  else pendingOverflow = true;
               }
            } else if (arrived.length) {
               const now = performance.now();
               for (const r of arrived) washed.set(rowKey(r), now + WASH_MS);
               scheduleWash();
            }
            const inList = new Set(list.map(rowKey));
            pendingNew = pendingNew.filter((p) => !inList.has(rowKey(p)));
            if (list.length > ROW_CAP) list.length = ROW_CAP;
            if (list.length !== rows.length || list.some((r, i) => rowKey(r) !== rowKey(rows[i]))) lockReflow();
            rows = list;
            cursor = next;
            advanceFrom = null; // an index into the old list: a move made meanwhile goes back to the list
            advanceAfterPage = false;
            lastPageEmpty = false;
            loadError = null;
            partials.clear();
            for (const [id, f] of freshPartials) partials.set(id, f);
         })
         .catch((e: unknown) => {
            if (destroyed || gen !== listGen || errorCode(e) === "SUPERSEDED") return;
            if (errorCode(e) === "CURSOR_STALE") {
               refreshing = null;
               loading = false;
               reload(); // the list changed under the paging: start fresh
               return;
            }
            listStale = true; // keep what's on screen (a timeout or link loss); the next return or link-up retries
         })
         .finally(() => {
            if (refreshing === edits) refreshing = null;
            if (destroyed || gen !== listGen) return;
            loading = false;
            clearSkeleton();
            render();
            requestAnimationFrame(() => {
               if (gen === listGen && canAutoPage() && sentinelVisible()) loadMore();
            });
         });
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
      let superseded = false;
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
            /* No rows yet the cursor stays set (every account failed this page, or a provider page held
               nothing to show): stop auto-paging; a deliberate Retry / scroll tries again. */
            lastPageEmpty = r.rows.length === 0 && r.cursor !== null;
            if (advanceFrom !== null) {
               const t = rows[advanceFrom];
               advanceFrom = null;
               if (t && !reader) queueMicrotask(() => openRow(t, true, true));
            }
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
            /* A newer list request from this connection owns the slot: no error, but don't
               auto-page again off this one (the newer request drives the list). */
            if (errorCode(e) === "SUPERSEDED") {
               superseded = true;
               return;
            }
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
            if (superseded) return;
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
         canArchive(r.accountId),
         canTrash(r.accountId),
         accountIndex.get(r.accountId),
         monograms.get(r.accountId),
         tz,
         today,
         previews()
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
      content.append(l1, l2);
      if (previews()) content.appendChild(div("mail-row-preview", r.preview));
      row.append(bar, gutter, content);
      {
         const actions = span("mail-row-actions");
         const mark = iconButton("mail-act-mark", r.unread ? "read" : "unread", r.unread ? "Mark read" : "Mark unread");
         mark.dataset.act = "mark";
         const btns = [mark];
         if (canArchive(r.accountId)) {
            const arch = iconButton("mail-act-archive", "archive", "Archive");
            arch.dataset.act = "archive";
            btns.push(arch); // read/unread, archive, then (set apart) trash
         }
         if (canTrash(r.accountId)) {
            const del = iconButton("mail-act-trash", "trash", "Move to Trash");
            del.dataset.act = "trash";
            btns.push(del);
         }
         for (const b of btns) {
            b.tabIndex = focused ? 0 : -1; // reachable by Tab from the focused row
            b.disabled = !linked;
         }
         actions.append(...btns);
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
      if (code === "UNSUPPORTED_QUERY") return `Search for non-English text isn't supported on ${name}`;
      /* The account listed, but its server refused some rows (too many requests): its other rows stay
         on screen; Retry reloads from the top, which is the only way back to the refused ones. */
      if (code === "RATE_LIMITED") return `${name} sent only part of this list (too many requests). Retry in a moment`;
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
      if (!accountsKnown) return accountsError ? `Couldn't load your mail accounts: ${accountsError}. Trying again…` : "Loading…";
      if (accounts.length === 0) return "Add an email account in DAWN's settings.";
      if (noneSelected()) return "No accounts selected";
      if (rows.length > 0 || showSkeleton || loading) return "";
      if (loadError) return `Couldn't load mail: ${loadError}`;
      if (cursor === undefined) return "";
      const n = selectedIds().length;
      if (query) return `No results for “${query}”${filterIsAll() ? "" : ` in ${n} account${n === 1 ? "" : "s"}`}`;
      return unreadOnly ? "No unread mail" : "No mail";
   };

   const totalUnread = (): number => selectedIds().reduce((s, id) => s + (counts.get(id)?.inboxUnread ?? 0), 0); // unknown counts add nothing

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
         if (!c || (!c.inboxUnread && c.status === "ok")) continue;
         const t = tile(id, true);
         t.classList.toggle("broken", c.status !== "ok");
         t.removeAttribute("aria-hidden");
         t.title = c.status === "ok" ? `${accountName(id)}: ${c.inboxUnread ?? "?"} unread` : `${accountName(id)}: needs attention`;
         t.setAttribute("aria-label", t.title);
         tilesEl.appendChild(t);
      }
      unreadPill.classList.toggle("on", unreadOnly);
      unreadPill.setAttribute("aria-pressed", unreadOnly ? "true" : "false");
      filterBtn.classList.toggle("on", !filterIsAll() || notifyOn());
   };

   const announce = (text: string): void => {
      live.textContent = "";
      live.textContent = text;
   };

   const senderLabel = (name: string, addr: string): string => (name && addr && name !== addr ? `${name} <${addr}>` : addr || name);

   /* --- reader ------------------------------------------------------------- */
   const discussRef = (r: Reader): EmailRef => ({
      accountId: r.row.accountId,
      messageId: r.row.messageId,
      /* "Name <addr>": the chip (stored with the chat message) never shows a display name alone. */
      sender: senderLabel(r.message?.fromName ?? r.row.fromName, r.message?.fromAddr ?? r.row.fromAddr),
      subject: r.message?.subject ?? r.row.subject
   });

   const addrList = (list: Array<{ name: string; addr: string }>): string => list.map((a) => (a.name ? `${a.name} <${a.addr}>` : a.addr)).join(", ");

   /* The rendered body for the open message, once per (message, images shown). */
   const bodyFor = (r: Reader, m: EmailMessage): { node: Node; images: number; designWidth: number } => {
      if (!bodyCache || bodyCache.key !== r.key || bodyCache.showImages !== r.showImages) {
         const rendered = renderEmailBody({ html: m.bodyHtml, text: m.bodyText }, r.showImages);
         bodyCache = { key: r.key, showImages: r.showImages, node: rendered.fragment, images: rendered.images, designWidth: rendered.designWidth };
      }
      return { node: bodyCache.node.cloneNode(true), images: bodyCache.images, designWidth: bodyCache.designWidth };
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
      /* The read state is NOT here (the mark toggle flips in place, syncReaderActions): a rebuild
         would throw the reader back to the top. Trust IS, only as far as this message's bar shows it. */
      const stopBar = !!reader.autoImages && !alwaysImages() && !!reader.fromKey && trustedSenders().has(reader.fromKey);
      return [reader.key, reader.state, reader.showImages, stopBar, !!reader.message, split, compactDiscuss, canDiscuss(), isReadOnly(id), canArchive(id), canTrash(id), accountIndex.get(id), monograms.get(id), tz].join("\u0001");
   };

   const renderReader = (): void => {
      const sig = currentReaderSig();
      if (sig === readerSig) return; // nothing the reader shows changed: keep its scroll/focus/state
      readerSig = sig;
      const hadFocus = readerCol.contains(document.activeElement);
      readerCol.replaceChildren();
      unfit(); // the old body is gone (a new one re-arms below)
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
      if (r.state !== "gone") {
         /* A read / unread toggle in every mode, so "Only when I choose" has a control here. */
         const local = rows.find((x) => rowKey(x) === r.key) ?? r.row;
         const markBtn = iconButton("mail-r-mark", local.unread ? "read" : "unread", local.unread ? "Mark read" : "Mark unread");
         markBtn.addEventListener("click", () => {
            const cur = rows.find((x) => rowKey(x) === r.key) ?? r.row;
            cancelMark();
            if (cur.unread) setUnreadFlag(cur, false);
            else markUnread(cur);
         });
         const acts = [markBtn];
         if (!ro && canArchive(r.row.accountId)) {
            const arch = iconButton("mail-r-archive", "archive", "Archive");
            arch.addEventListener("click", () => moveRow(r.row, "archive"));
            acts.push(arch); // read/unread, archive, then (set apart) trash
         }
         if (!ro && canTrash(r.row.accountId)) {
            const del = iconButton("mail-r-trash", "trash", "Move to Trash");
            del.addEventListener("click", () => moveRow(r.row, "trash"));
            acts.push(del);
         }
         /* Not until the open (which marks read) has landed: a Mark unread racing it would lose.
            The link state is applied in place by syncReaderActions (no rebuild on a link blip). */
         for (const b of acts) {
            b.classList.add("mail-r-act");
            b.dataset.ready = ready ? "1" : "";
         }
         bar.append(...acts);
      }
      bar.appendChild(span("mail-spacer"));
      if (r.state !== "gone" && canDiscuss()) {
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
      /* The full Discuss buttons are used only while the bar really fits them: measured, not guessed
         (the actions it holds vary by account and by what DAWN supports). Remember the width they
         needed, so widening the panel brings them back only once they'd fit again. */
      if (!compactDiscuss && bar.scrollWidth > bar.clientWidth + 1 && bar.querySelector(".mail-discuss-private")) {
         fullDiscussNeeds = bar.scrollWidth + 8;
         compactDiscuss = true;
         readerSig = "";
         renderReader();
         return;
      }

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
         /* Count every recipient, including any DAWN cut from a long list. */
         const totalRecips = Math.max(m.to.length, m.toTotal ?? 0) + Math.max(m.cc.length, m.ccTotal ?? 0);
         if (recips.length) {
            const own = account(m.accountId)?.address;
            const toMe = recips.some((a) => a.addr === own);
            const first = toMe ? "me" : addrList(recips.slice(0, 1));
            const more = totalRecips - 1;
            const toLine = div("mail-reader-to");
            const expand = textButton("mail-link mail-to-toggle", `to ${first}${more > 0 ? `, +${more}` : ""}`);
            expand.setAttribute("aria-expanded", "false");
            const full = div("mail-reader-to-full");
            full.hidden = true;
            const cut = (shown: number, total?: number): string => (total && total > shown ? ` +${total - shown} more` : "");
            full.append(div("", `To: ${addrList(m.to)}${cut(m.to.length, m.toTotal)}`));
            if (m.cc.length) full.append(div("", `Cc: ${addrList(m.cc)}${cut(m.cc.length, m.ccTotal)}`));
            if (m.replyTo && m.replyTo.addr !== m.fromAddr) full.append(div("", `Reply-To: ${addrList([m.replyTo])}`));
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
            ib.title = "Remote images can tell the sender when you open the message";
            ib.appendChild(icon("image"));
            ib.appendChild(span("", `${rendered.images} image${rendered.images === 1 ? "" : "s"} blocked · `));
            const show = textButton("mail-link", "Show images");
            show.addEventListener("click", () => {
               if (reader && reader.key === r.key) {
                  reader.showImages = true;
                  renderReader();
               }
            });
            ib.appendChild(show);
            if (r.fromKey) {
               /* The exact address, so a display name can't stand in for who is trusted. */
               const addr = r.fromKey;
               ib.appendChild(document.createTextNode(" · "));
               const always = textButton("mail-link", `Always show from ${addr}`);
               always.addEventListener("click", () => trustSender(addr));
               ib.appendChild(always);
            }
            scroll.appendChild(ib);
         } else if (rendered.images > 0 && r.autoImages && r.fromKey && !alwaysImages() && trustedSenders().has(r.fromKey)) {
            const addr = r.fromKey;
            const ib = div("mail-images-bar");
            ib.appendChild(icon("image"));
            ib.appendChild(span("", `Images from ${addr} load automatically · `));
            const stop = textButton("mail-link", "Stop");
            stop.addEventListener("click", () => untrustSender(addr));
            ib.appendChild(stop);
            scroll.appendChild(ib);
         }
         const bodyEl = div("mail-reader-body");
         bodyEl.appendChild(rendered.node);
         scroll.appendChild(bodyEl);
         /* Keep the images in proportion to each other at this reader width (and on resize). */
         if (rendered.designWidth && bodyEl.querySelector("img")) {
            fitTarget = { el: bodyEl, design: rendered.designWidth, width: -1 };
            bodyRo.observe(scroll, { box: "border-box" }); // a scrollbar coming or going is not a resize
         }
         if (m.textTruncated || m.htmlTruncated) scroll.appendChild(div("mail-reader-trunc", "Shortened · the rest of this message wasn't loaded"));
         if (m.attachments.length) {
            const att = div("mail-attachments");
            for (const a of m.attachments) {
               const chip = span("mail-attachment");
               chip.appendChild(icon("clip"));
               chip.appendChild(span("mail-attachment-name", a.filename || "attachment"));
               chip.appendChild(span("mail-attachment-size", fmtBytes(a.size)));
               chip.title = a.mime; // listed only (downloads are a later phase, not promised here)
               att.appendChild(chip);
            }
            if (m.attachmentsTruncated) att.appendChild(span("mail-attachment-more", "More attachments than shown"));
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
      const markBtn = readerCol.querySelector<HTMLButtonElement>(".mail-r-mark");
      if (markBtn && reader) {
         const unread = (rows.find((x) => rowKey(x) === reader!.key) ?? reader.row).unread;
         const label = unread ? "Mark read" : "Mark unread";
         if (markBtn.getAttribute("aria-label") !== label) {
            markBtn.setAttribute("aria-label", label);
            markBtn.title = label;
            markBtn.replaceChildren(icon(unread ? "read" : "unread"));
         }
      }
      const prev = readerCol.querySelector<HTMLButtonElement>(".mail-prev");
      const next = readerCol.querySelector<HTMLButtonElement>(".mail-next");
      if (prev || next) {
         const n = neighbors();
         if (prev) prev.disabled = !n.prev;
         if (next) next.disabled = !n.next && !n.more;
      }
   };

   /* A trusted sender's (or, with Always show images, every) message shows its images on open. */
   const applyAutoImages = (r: Reader): void => {
      if (r.showImages) return;
      if (alwaysImages() || (r.fromKey && trustedSenders().has(r.fromKey))) {
         r.showImages = true;
         r.autoImages = true;
      }
   };

   /* --- Mark as read "After 3 seconds" (3.9) ------------------------------ */
   /* The delay counts only while the message is actually on screen (the panel expanded and visible,
      the tab visible, standby down); it pauses otherwise and is cancelled by moving on. */
   let mark: { key: string; remaining: number; startedAt: number; handle: number } | null = null;
   const cancelMark = (): void => {
      if (mark) window.clearTimeout(mark.handle);
      mark = null;
   };
   const fireMark = (): void => {
      const k = mark?.key;
      mark = null;
      if (!k || !reader || reader.key !== k || reader.state !== "ready") return;
      const local = rows.find((x) => rowKey(x) === k) ?? reader.row;
      if (!local.unread) return;
      if (!linked) {
         mark = { key: k, remaining: 0, startedAt: 0, handle: 0 }; // offline: mark once the link is back
         return;
      }
      washed.set(k, performance.now() + WASH_MS); // the row settles with the arrival wash, no jump
      scheduleWash();
      setUnreadFlag(local, false);
   };
   const syncMark = (): void => {
      if (!mark) return;
      if (onScreen() && linked) {
         if (mark.handle) return;
         mark.startedAt = performance.now();
         mark.handle = window.setTimeout(fireMark, mark.remaining);
      } else if (mark.handle) {
         window.clearTimeout(mark.handle);
         mark.handle = 0;
         mark.remaining = Math.max(0, mark.remaining - (performance.now() - mark.startedAt));
      }
   };
   const startMark = (k: string): void => {
      cancelMark();
      mark = { key: k, remaining: MARK_READ_DELAY_MS, startedAt: 0, handle: 0 };
      syncMark();
   };

   let readTimer = 0;
   const openRow = (row: EmailRow, focusReader = true, settle = false): void => {
      advanceAfterPage = false; // any open supersedes a pending "open the next one when it loads"
      advanceFrom = null;
      window.clearTimeout(readTimer);
      cancelMark();
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
      const mode = markReadMode();
      source
         .read(row.accountId, row.messageId, mode === "immediately")
         .then((res) => {
            if (destroyed || seq !== readSeq || !reader || reader.key !== k) return;
            reader.message = res.message;
            reader.state = "ready";
            const local = rows.find((x) => rowKey(x) === k);
            if (local) local.unread = res.unread;
            reader.row.unread = res.unread;
            noteUnread(reader.row);
            /* Trust keys on the message's own From address (3.9), never the display name. */
            reader.fromKey = normalizeAddress(res.message.fromAddr || row.fromAddr);
            applyAutoImages(reader);
            if (mode === "delayed" && res.unread) startMark(k);
            render();
         })
         .catch((e: unknown) => {
            if (destroyed || seq !== readSeq || !reader || reader.key !== k) return;
            if (errorCode(e) === "SUPERSEDED") {
               /* Our own newer open replaced it (the seq check above already dropped that case);
                  anything else must not leave the reader stuck on "Loading". */
               reader.state = "error";
               reader.error = "it was interrupted";
               render();
               return;
            }
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
      advanceFrom = null;
      window.clearTimeout(readTimer);
      cancelMark();
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

   /* --- trusted senders (3.9) ------------------------------------------------ */
   /* Edited as operations on the current list, so a DAWN-backed store can re-apply them on a
      conflict (8.7). The change comes back through onChange, which updates the open message. */
   const trustSender = (addr: string): void => {
      let full = false;
      userPrefs.update(TRUSTED_SENDERS, (cur) => {
         const next = cleanTrusted([...cur, addr]);
         full = !next.includes(addr);
         return next;
      });
      if (full) {
         const msg = "The trusted senders list is full. Remove one in Mail options first.";
         if (toast && toast.tokens.length) announce(msg); // never take over a live Undo
         else showToast(msg);
      }
   };
   const untrustSender = (addr: string): void => {
      userPrefs.update(TRUSTED_SENDERS, (cur) => cur.filter((a) => a !== addr));
      announce(`Stopped trusting ${addr}`);
   };
   const onPrefsChange = (keys: string[]): void => {
      if (destroyed) return;
      if (keys.includes(TRUSTED_SENDERS.key) || keys.includes(ALWAYS_IMAGES.key)) {
         if (reader && reader.state === "ready") {
            const still = alwaysImages() || (!!reader.fromKey && trustedSenders().has(reader.fromKey));
            if (reader.autoImages && !still) {
               reader.showImages = false; // Stop: the images unload, the bar returns
               reader.autoImages = false;
            } else {
               applyAutoImages(reader);
            }
         }
      }
      if (keys.includes(MARK_READ.key) && markReadMode() !== "delayed") cancelMark();
      render(); // the reader rebuilds only if this message's images or bar changed (its signature)
      if (!popover.hidden) renderPopover();
   };
   const unsubPrefs = userPrefs.onChange(onPrefsChange);

   /* --- triage ------------------------------------------------------------- */
   const removeRows = (keys: string[]): void => {
      const set = new Set(keys);
      if (refreshing) for (const k of keys) {
         refreshing.dropped.add(k);
         refreshing.added.delete(k);
      }
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
      refreshing?.dropped.delete(k); // it's back (an undo), even if it doesn't fit the loaded range
      pendingNew = pendingNew.filter((r) => rowKey(r) !== k);
      if (rows.some((r) => rowKey(r) === k)) return;
      const at = rows.findIndex((r) => r.date < row.date);
      if (at < 0) {
         if (cursor !== null) return; // older than everything loaded: it'll arrive with a later page
         rows.push(row);
      } else {
         rows.splice(at, 0, row);
      }
      if (refreshing) {
         refreshing.added.set(k, row);
         refreshing.dropped.delete(k);
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

   /* Show what's really there now: reload if the list is on screen and connected, else on return. */
   const refreshList = (): void => {
      if (panelEffective() && linked) reload();
      else listStale = true;
   };

   const moveRow = (row: EmailRow, kind: "archive" | "trash"): void => {
      if (!linked || !(kind === "archive" ? canArchive(row.accountId) : canTrash(row.accountId))) return;
      const k = rowKey(row);
      const seq = ++actionSeq;
      const index = rows.findIndex((r) => rowKey(r) === k);
      const next = index >= 0 ? (rows[index + 1] ?? rows[index - 1]) : undefined;
      const wasOpen = reader?.key === k;
      /* "After archive or trash" (3.9): open the next (older) / previous (newer) message, or go back
         to the list (the default; split view keeps the next row selected, not opened). The end of
         the list falls back to the list; it never wraps. */
      const mode = afterMove();
      const advanceTo = wasOpen && index >= 0 && mode !== "list" ? (mode === "next" ? rows[index + 1] : rows[index - 1]) : undefined;
      /* "Next" past the loaded rows while more exist: open the first one the next page brings. */
      const advanceLater = wasOpen && index >= 0 && mode === "next" && !rows[index + 1] && cursor !== null && rows.length < ROW_CAP;
      removeRows([k]);
      if (wasOpen) {
         cancelMark();
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
      if (advanceTo) openRow(advanceTo, true, true); // marks read per the Mark as read setting
      else if (advanceLater) {
         advanceFrom = index; // after the removal, the next page's first row lands here
         loadMore();
      }

      const verb = kind === "archive" ? "archive" : "move to Trash";
      const restore = (why: string): void => {
         if (destroyed) return;
         advanceFrom = null; // the move failed: don't open a row in its place
         if (!rows.some((r) => rowKey(r) === k)) {
            rows.splice(Math.min(Math.max(index, 0), rows.length), 0, row);
            lockReflow();
         }
         if (refreshing) {
            refreshing.dropped.delete(k); // the move didn't happen: the refresh must keep the row
            refreshing.added.set(k, row);
         }
         /* Never let an older action's failure take over a newer action's undo. */
         reportFailure(seq, `Couldn't ${verb}: ${why}`);
         render();
      };
      /* What a refusal means for the row (DAWN's codes, P1.2). */
      const settle = (code: EmailErrorCode | undefined, message: string): void => {
         if (destroyed) return;
         switch (code) {
            case "NOT_FOUND":
               /* Gone from here (or an id from before the mailbox was rebuilt): nothing to put back;
                  look again so a message that does still exist reappears. */
               refreshList();
               return;
            case "TIMEOUT":
            case "UNREACHABLE":
            case "NOT_REMOVED":
            case "OUTCOME_UNKNOWN":
               /* It may have moved (or been copied without the original going): never retry; reload
                  so the list shows what's really there (DAWN's email_changed says it too). */
               /* DAWN counts all of these as "may have moved": never put the row back or retry. */
               reportFailure(seq, code === "NOT_REMOVED" ? `Couldn't ${verb} cleanly; refreshed the list` : `DAWN didn't confirm it; refreshed the list`);
               refreshList();
               return;
            case "BUSY":
            case "RATE_LIMITED":
               return restore("DAWN is busy. Try again in a moment.");
            case "IN_TRASH":
               return restore("it's in Trash or Spam. Restore it there first.");
            case "NO_TRASH":
               return restore("this account has no Trash folder");
            case "FOLDER_MISSING":
               return restore(kind === "archive" ? "this account has no Archive folder" : "its folder is missing");
            case "READ_ONLY":
               return restore("this account is read-only");
            default:
               return restore(message);
         }
      };
      const call = kind === "archive" ? source.archive(row.accountId, [row.messageId]) : source.trash(row.accountId, [row.messageId]);
      call
         .then((res) => {
            if (destroyed) return;
            const f = res.failed[0];
            if (f) return settle(f.code, f.message);
            if (!res.done.length) return settle("OUTCOME_UNKNOWN", ""); // neither done nor failed
            const tokens = res.done.flatMap((d) => (d.undo ? [d.undo] : []));
            /* Quick clicks land in order, each after the next click was made: a success joins the
               group, or opens one when no other action's Undo is on screen. */
            /* A newer message (a failure) stays readable beside the Undo this result brings. */
            const carry = toast && !toast.move && seq !== actionSeq ? toast.baseText : "";
            if (tokens.length || seq === actionSeq || !toast || !toast.tokens.length) toastMove(kind, row.accountId, tokens);
            else announce(kind === "archive" ? "Archived" : "Moved to Trash");
            if (carry && toast && toast.move) {
               toast.note = carry;
               paintToast();
               announce(carry);
            }
         })
         .catch((e: unknown) => settle(errorCode(e), errorText(e)));
   };

   /* A failure message for an action: a toast only if no newer action owns the toast (never
      clobber a newer Undo), else announced. */
   const reportFailure = (seq: number, text: string): void => {
      if (toast && toast.tokens.length) {
         /* A live Undo stays: the failure shows beside it, never instead of it. */
         toast.note = text;
         paintToast();
         announce(text);
         return;
      }
      if (seq === actionSeq) showToast(text);
      else announce(text);
   };

   const setUnreadFlag = (row: EmailRow, unread: boolean): void => {
      if (!linked) return; // read state changes even on a read-only account
      const seq = ++actionSeq;
      const prev = row.unread;
      row.unread = unread;
      noteUnread(row);
      render();
      source.setFlags(row.accountId, [row.messageId], { unread }).catch((e: unknown) => {
         if (destroyed) return;
         const now = rows.find((r) => rowKey(r) === rowKey(row)) ?? row; // the list may have been refreshed since
         now.unread = prev;
         noteUnread(now);
         reportFailure(seq, `Couldn't mark ${unread ? "unread" : "read"}: ${errorText(e)}`);
         render();
      });
   };

   const markUnread = (row: EmailRow): void => {
      const local = rows.find((r) => rowKey(r) === rowKey(row)) ?? row;
      setUnreadFlag(local, true);
      if (!split) closeReader(true);
   };

   /* Every archive and trash while the Undo shows joins ONE group, whatever its kind or account
      ("2 archived, 1 moved to Trash"), and its Undo takes them all back (3.9). A group stays open well
      inside DAWN's 60 s undo window, so its Undo never sends expired tokens. */
   const GROUP_MAX_MS = 45_000;
   const UNDO_LIFE_MS = 55_000; // just inside DAWN's 60 s token life, from the group's first move
   const groupOpen = (): boolean =>
      !!toast && toast.move && toast.tokens.length > 0 && performance.now() - toast.groupStart < GROUP_MAX_MS;
   const groupText = (archived: number, trashed: number): string => {
      if (!trashed) return archived === 1 ? "Archived" : `Archived ${archived}`;
      if (!archived) return trashed === 1 ? "Moved to Trash" : `Moved ${trashed} to Trash`;
      return `${archived} archived, ${trashed} moved to Trash`;
   };
   const toastMove = (kind: "archive" | "trash", accountId: number, tokens: string[]): void => {
      const entries = tokens.map((token) => ({ accountId, token }));
      if (entries.length && groupOpen()) {
         const t = toast!;
         for (const e of entries) if (!t.tokens.some((x) => x.token === e.token)) t.tokens.push(e);
         if (kind === "archive") t.archived += 1;
         else t.trashed += 1;
         t.baseText = groupText(t.archived, t.trashed);
         paintToast();
         t.remaining = TOAST_MS; // a fresh window for the whole group
         toastBar.classList.remove("run");
         void toastBar.offsetWidth;
         toastBar.classList.add("run");
         if (!toastEl.classList.contains("paused")) armToast(); // hovered: resume arms it
         return;
      }
      /* Nothing to undo (already there): never replace a live group's Undo for it. */
      if (!entries.length && toast && toast.tokens.length) {
         announce(groupText(kind === "archive" ? 1 : 0, kind === "trash" ? 1 : 0));
         return;
      }
      showToast(groupText(kind === "archive" ? 1 : 0, kind === "trash" ? 1 : 0), entries, kind);
   };

   /* --- undo toast ---------------------------------------------------------- */
   const toastText = span("mail-toast-text");
   const toastUndo = textButton("mail-link mail-toast-undo", "Undo");
   const toastBar = span("mail-toast-bar");
   toastEl.append(toastText, toastUndo, toastBar);

   const paintToast = (): void => {
      if (toast) toastText.textContent = toast.note ? `${toast.baseText} · ${toast.note}` : toast.baseText;
   };
   const hideToast = (): void => {
      if (toast) {
         window.clearTimeout(toast.timer);
         window.clearTimeout(toast.expiry);
      }
      toast = null;
      toastEl.hidden = true;
   };
   const armToast = (): void => {
      if (!toast) return;
      window.clearTimeout(toast.timer);
      toast.startedAt = performance.now();
      toast.timer = window.setTimeout(hideToast, toast.remaining);
   };
   const showToast = (text: string, tokens: Array<{ accountId: number; token: string }> = [], kind?: "archive" | "trash"): void => {
      if (destroyed) return;
      hideToast(); // one at a time: a new action replaces the older undo
      toast = {
         tokens,
         move: !!kind,
         archived: kind === "archive" ? 1 : 0,
         trashed: kind === "trash" ? 1 : 0,
         remaining: TOAST_MS,
         startedAt: 0,
         timer: 0,
         groupStart: performance.now(),
         baseText: text,
         note: "",
         expiry: 0
      };
      /* DAWN's undo tokens last 60 s from their move: a hovered or focused (paused) group still goes
         before the oldest one would be refused. */
      if (kind && tokens.length) {
         const t = toast;
         t.expiry = window.setTimeout(() => toast === t && hideToast(), UNDO_LIFE_MS);
      }
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
      /* DAWN's undo is per account: one call each, at once, merged into one result. */
      const byAccount = new Map<number, string[]>();
      for (const { accountId, token } of toast.tokens) byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), token]);
      const seq = ++actionSeq;
      hideToast();
      void Promise.allSettled([...byAccount].map(([acct, toks]) => source.undo(acct, toks))).then((results) => {
         if (destroyed) return;
         let unreadable = false;
         let restored = 0;
         let unknown = false;
         let firstWhy = "";
         let failed = 0;
         const why = (code: string, message: string): string =>
            code === "UNDO_EXPIRED"
               ? "it's too late"
               : code === "NOT_FOUND"
                 ? "it's no longer in Trash or Archive"
                 : code === "FOLDER_MISSING"
                   ? "the folder it came from is gone"
                   : message;
         results.forEach((r, i) => {
            if (r.status === "rejected") {
               if (errorCode(r.reason) === "OUTCOME_UNKNOWN") unknown = true;
               else {
                  failed += [...byAccount][i][1].length;
                  firstWhy ||= errorText(r.reason);
               }
               return;
            }
            for (const x of r.value.restored) {
               restored++;
               if (!x.row) {
                  unreadable = true; // back, but DAWN couldn't read it: reload shows it
                  continue;
               }
               const row = x.row;
               /* The restore's own `created` echo may have queued it behind the pill: drop it
                  there, and only put it in the list if it fits the current view. */
               pendingNew = pendingNew.filter((p) => rowKey(p) !== rowKey(row));
               if (matchesView(row)) insertSorted(row);
            }
            for (const f of r.value.failed) {
               failed++;
               firstWhy ||= why(f.code, f.message);
            }
            /* A token in neither list: DAWN didn't say what became of it. */
            if (r.value.restored.length + r.value.failed.length < [...byAccount][i][1].length) unknown = true;
         });
         if (unreadable || unknown) refreshList();
         if (unknown) reportFailure(seq, `DAWN didn't confirm all of the undo; refreshed the list${failed ? ` (${failed} couldn't be: ${firstWhy})` : ""}`);
         else if (failed) reportFailure(seq, restored ? `Restored ${restored}; ${failed} couldn't be: ${firstWhy}` : `Couldn't undo: ${firstWhy}`);
         render();
      });
   });

   /* --- popover: Mail options, two levels (3.9) ------------------------------ */
   let popLevel: 1 | 2 = 1;
   let confirmAlways = false; // "Always show images" asks once before it commits
   let trustFilter = "";
   let removed: { addr: string; timer: number } | null = null;

   const fieldset = (legend: string, cls = ""): HTMLFieldSetElement => {
      const fs = document.createElement("fieldset");
      fs.className = `mail-pop-set${cls ? ` ${cls}` : ""}`;
      const lg = document.createElement("legend");
      lg.textContent = legend;
      fs.appendChild(lg);
      return fs;
   };
   const checkRow = (label: string, checked: boolean, focusId: string, onChange: (on: boolean) => void): HTMLLabelElement => {
      const lab = document.createElement("label");
      lab.className = "mail-pop-row";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.focusId = focusId;
      box.checked = checked;
      box.addEventListener("change", () => onChange(box.checked));
      lab.append(box, span("mail-pop-name", label));
      return lab;
   };
   const radioGroup = <T extends string>(legend: string, name: string, value: T, options: Array<[T, string]>, onPick: (v: T) => void): HTMLFieldSetElement => {
      const fs = fieldset(legend, "mail-pop-radios");
      for (const [v, label] of options) {
         const lab = document.createElement("label");
         lab.className = "mail-pop-row";
         const r = document.createElement("input");
         r.type = "radio";
         r.name = `mail-${name}`;
         r.value = v;
         r.checked = v === value;
         r.dataset.focusId = `${name}-${v}`;
         r.addEventListener("change", () => r.checked && onPick(v));
         lab.append(r, span("mail-pop-name", label));
         fs.appendChild(lab);
      }
      return fs;
   };
   const setLevel = (level: 1 | 2): void => {
      popLevel = level;
      confirmAlways = false;
      renderPopover();
      popover.querySelector<HTMLElement>(level === 2 ? ".mail-pop-back" : ".mail-pop-more")?.focus();
   };

   const renderLevel1 = (): void => {
      const fs = fieldset("Show mail from (this screen)");
      fs.appendChild(
         checkRow("All accounts", filterIsAll(), "all", (on) => {
            prefs.filter = on ? null : [];
            savePrefs();
            reload();
            renderPopover();
         })
      );
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
         row.append(lab);
         /* New-mail notifications need the source's live changes: no bell until it has them. */
         if (source.supportsLiveChanges()) {
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
            row.append(bell);
         }
         fs.appendChild(row);
      }
      popover.appendChild(fs);
      if (notifyOn()) {
         const nf = fieldset("Notifications");
         nf.appendChild(checkRow("Show the sender only", userPrefs.get(SENDER_ONLY), "sender", (on) => userPrefs.set(SENDER_ONLY, on)));
         nf.appendChild(
            checkRow("Chime for new mail", prefs.chime, "chime", (on) => {
               prefs.chime = on;
               savePrefs();
            })
         );
         nf.appendChild(div("mail-pop-foot", "Notifications apply to this screen only."));
         popover.appendChild(nf);
      }
      const more = textButton("mail-pop-more", "Reading options ›");
      more.dataset.focusId = "more";
      more.addEventListener("click", () => setLevel(2));
      popover.appendChild(more);
   };

   const renderLevel2 = (): void => {
      const back = textButton("mail-pop-back", "‹ Back to Mail options");
      back.dataset.focusId = "back";
      back.addEventListener("click", () => setLevel(1));
      popover.appendChild(back);

      /* Images: the privacy-sensitive group. */
      const img = fieldset("Images");
      const always = alwaysImages();
      const descId = "mail-always-desc";
      const alwaysRow = checkRow("Always show images", always || confirmAlways, "always", (on) => {
         if (on) {
            confirmAlways = true; // a deliberate step: the warning first, then Turn on
            renderPopover();
            focusPop("turn-on");
         } else {
            confirmAlways = false;
            userPrefs.set(ALWAYS_IMAGES, false);
            renderPopover(); // the value may not have changed (no onChange), but the confirm must go
         }
      });
      alwaysRow.querySelector("input")?.setAttribute("aria-describedby", descId);
      img.appendChild(alwaysRow);
      const desc = div("mail-pop-desc", "Anyone who emails you, spammers included, can see when and roughly where you open it.");
      desc.id = descId;
      desc.hidden = !always && !confirmAlways;
      img.appendChild(desc);
      if (confirmAlways && !always) {
         const confirm = div("mail-pop-confirm");
         const on = textButton("mail-link mail-pop-turn-on", "Turn on");
         on.dataset.focusId = "turn-on";
         on.addEventListener("click", () => {
            confirmAlways = false;
            userPrefs.set(ALWAYS_IMAGES, true);
            focusPop("always");
         });
         const cancel = textButton("mail-link", "Cancel");
         cancel.addEventListener("click", () => {
            confirmAlways = false;
            renderPopover();
            focusPop("always");
         });
         confirm.append(on, document.createTextNode(" · "), cancel);
         img.appendChild(confirm);
      }
      img.appendChild(renderTrusted(always));
      popover.appendChild(img);

      const rd = fieldset("Reading");
      rd.appendChild(
         radioGroup<MarkRead>("Mark as read", "markread", markReadMode(), [
            ["immediately", "Immediately"],
            ["delayed", "After 3 seconds"],
            ["manual", "Only when I choose"]
         ], (v) => userPrefs.set(MARK_READ, v))
      );
      rd.appendChild(
         radioGroup<AfterMove>("After archive or trash", "aftermove", afterMove(), [
            ["list", "Go back to the list"],
            ["next", "Open the next message (older)"],
            ["previous", "Open the previous message (newer)"]
         ], (v) => userPrefs.set(AFTER_MOVE, v))
      );
      rd.appendChild(checkRow("Preview line under each message", previews(), "previews", (on) => userPrefs.set(PREVIEWS, on)));
      popover.appendChild(rd);
   };

   /* Sorted by domain, then local part (a sender's addresses group together). */
   const trustOrder = (a: string, b: string): number => {
      const [la, da] = [a.slice(0, a.lastIndexOf("@")), a.slice(a.lastIndexOf("@") + 1)];
      const [lb, db] = [b.slice(0, b.lastIndexOf("@")), b.slice(b.lastIndexOf("@") + 1)];
      return da.localeCompare(db) || la.localeCompare(lb);
   };
   const renderTrusted = (alwaysOn: boolean): HTMLElement => {
      const wrap = div("mail-pop-trusted");
      const list = userPrefs.get(TRUSTED_SENDERS).slice().sort(trustOrder);
      const head = div("mail-pop-trusted-head", `Trusted senders${list.length ? ` (${list.length})` : ""}`);
      head.tabIndex = -1;
      head.dataset.focusId = "trusted-head";
      wrap.appendChild(head);
      if (alwaysOn && list.length) wrap.appendChild(div("mail-pop-desc", "Not needed while Always show images is on."));
      if (removed) {
         const r = removed;
         const undo = div("mail-pop-removed");
         undo.append(span("", `Removed ${r.addr} · `));
         const btn = textButton("mail-link", "Undo");
         btn.dataset.focusId = "trust-undo";
         btn.addEventListener("click", () => {
            window.clearTimeout(r.timer);
            removed = null;
            trustSender(r.addr);
            renderPopover(); // even when the re-add changed nothing (another tab got there first)
            focusPop(`trust-${r.addr}`);
            if (!popover.contains(document.activeElement)) focusPop("trusted-head");
         });
         undo.appendChild(btn);
         wrap.appendChild(undo);
      }
      if (!list.length) {
         wrap.appendChild(div("mail-pop-desc", "None yet · trust a sender from the images bar in a message."));
         return wrap;
      }
      const ul = document.createElement("ul");
      ul.className = "mail-pop-trust-list";
      if (list.length > 8) {
         const f = document.createElement("input");
         f.type = "search";
         f.className = "mail-pop-filter";
         f.placeholder = "Filter";
         f.setAttribute("aria-label", "Filter trusted senders");
         f.dataset.focusId = "trust-filter";
         f.value = trustFilter;
         /* Only the list re-renders while typing: the field keeps its caret and any IME input. */
         f.addEventListener("input", () => {
            trustFilter = f.value;
            fillTrusted(ul, list);
         });
         wrap.appendChild(f);
      }
      fillTrusted(ul, list);
      wrap.appendChild(ul);
      return wrap;
   };
   const fillTrusted = (ul: HTMLUListElement, list: string[]): void => {
      ul.replaceChildren();
      const q = list.length > 8 ? trustFilter.trim().toLowerCase() : ""; // no field, no filter
      const shown = q ? list.filter((a) => a.includes(q)) : list;
      shown.forEach((addr, i) => {
         const li = document.createElement("li");
         li.className = "mail-pop-trust";
         const name = span("mail-pop-trust-addr", addr);
         name.title = addr;
         const x = iconButton("mail-pop-trust-x", "close", `Stop trusting ${addr}`);
         x.dataset.focusId = `trust-${addr}`;
         x.addEventListener("click", () => {
            if (removed) window.clearTimeout(removed.timer);
            const after = shown[i + 1] ?? shown[i - 1];
            const timer = window.setTimeout(() => {
               removed = null;
               if (popover.hidden) return;
               const onUndo = (document.activeElement as HTMLElement | null)?.dataset?.focusId === "trust-undo";
               renderPopover();
               if (onUndo) focusPop("trusted-head"); // never drop focus to the page (Escape lives on the panel)
            }, 5000);
            removed = { addr, timer };
            userPrefs.update(TRUSTED_SENDERS, (cur) => cur.filter((a) => a !== addr));
            /* onChange re-rendered the popover: move focus to a neighbour, never to the page. */
            focusPop(after ? `trust-${after}` : "trusted-head");
         });
         li.append(name, x);
         ul.appendChild(li);
      });
   };

   /* Focus a popover control by its focus id (compared, never built into a selector: ids can hold
      an email address). */
   const focusPop = (id: string): void => {
      for (const n of popover.querySelectorAll<HTMLElement>("[data-focus-id]")) {
         if (n.dataset.focusId === id) {
            n.focus();
            return;
         }
      }
   };
   const renderPopover = (): void => {
      const focusedId = (document.activeElement as HTMLElement | null)?.dataset?.focusId;
      popover.replaceChildren();
      popover.classList.toggle("mail-pop-l2", popLevel === 2);
      if (popLevel === 1) renderLevel1();
      else renderLevel2();
      /* Re-rendering replaced the focused control: put focus back on its twin (Escape keeps working). */
      if (focusedId) focusPop(focusedId);
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
      popLevel = 1;
      confirmAlways = false;
      trustFilter = "";
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
         detail: senderOnly() ? `From ${sender}` : `${sender}: ${st.last.subject || "(no subject)"}`,
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
      if (!source.supportsLiveChanges() || !prefs.notify.includes(row.accountId) || !row.unread || !vis.isVisible()) return;
      if (onScreen()) return; // they're looking at the list: the arrival itself is the signal
      const st = notifyState.get(row.accountId);
      /* The window runs from the LAST arrival, so the card's count and the coalescing agree. */
      if (st) window.clearTimeout(st.timer);
      const timer = window.setTimeout(() => notifyState.delete(row.accountId), NOTIFY_COALESCE_MS);
      notifyState.set(row.accountId, { count: (st?.count ?? 0) + 1, last: row, timer });
      noticeFor(row.accountId);
      /* One chime per coalesced burst (this screen's choice; never in standby). */
      if (!st && prefs.chime && !suspended) opts.playChime?.();
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
      /* Compact once the reader is narrower than the full bar was measured to need (renderReader
         measures it; COMPACT_DISCUSS is only the floor before any measurement). */
      let nextCompact = readerW < Math.max(COMPACT_DISCUSS, fullDiscussNeeds);
      /* Narrowing while the full buttons show: if the bar on screen now overflows, go compact. */
      const bar = readerCol.querySelector<HTMLElement>(".mail-reader-bar");
      if (!compactDiscuss && bar && bar.querySelector(".mail-discuss-private") && bar.scrollWidth > bar.clientWidth + 1) {
         fullDiscussNeeds = bar.scrollWidth + 8;
         nextCompact = true;
      }
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
      if (!on) cancelMark(); // collapsing moves on from the message
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
         if (act === "mark" && reader?.key === rowKey(row) && reader.state === "loading") return; // its open may mark read: wait
         if (act === "archive") moveRow(row, "archive");
         else if (act === "trash") moveRow(row, "trash");
         else if (act === "mark") {
            if (reader?.key === rowKey(row)) cancelMark(); // an explicit choice beats the pending 3 s mark
            setUnreadFlag(row, !row.unread);
         }
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
         if (popLevel === 2) setLevel(1); // level 2 -> level 1 -> closed
         else closePopover(true);
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
      renderHead(); // counts touch only the header (and an open popover's account list, level 1)
      if (!popover.hidden && popLevel === 1) renderPopover();
   };

   const applyChanges = (ch: EmailChanges): void => {
      if (destroyed || !accounts.some((a) => a.id === ch.accountId)) return;
      if (ch.state !== null) states.set(ch.accountId, ch.state);
      /* A move or undo's notice is not new mail: no notification for its rows. */
      if (!ch.kind) for (const c of ch.created) queueNotice(c);
      if (reader && ch.destroyed.some((id) => keyOf(ch.accountId, id) === reader!.key)) {
         reader.state = "gone";
         cancelMark();
      }
      if (!panelEffective()) {
         /* Nobody is looking at the list: don't grow it in the background; the return refreshes it.
            Still drop and update rows it names, so a move made elsewhere (another tab, Friday)
            doesn't linger on screen until the return's refresh lands. */
         removeRows(ch.destroyed.map((id) => keyOf(ch.accountId, id)));
         for (const u of ch.updated) {
            const i = rows.findIndex((r) => rowKey(r) === rowKey(u));
            if (i >= 0) rows[i] = { ...rows[i], ...u };
            noteUpdate(u);
         }
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
         noteUpdate(u);
      }
      let arrived = 0;
      for (const c of ch.created) {
         if (c.accountId !== ch.accountId) continue; // a notice speaks for its own account only
         if (ch.kind) {
            /* An undo putting mail back (from any tab or Friday): it replaces a row with the same id
               (a Gmail id is the same in every folder), else goes straight in if it fits this view;
               never the "new mail" pill. */
            const i = rows.findIndex((r) => rowKey(r) === rowKey(c));
            if (i >= 0) rows[i] = c;
            else if (matchesView(c)) insertSorted(c);
            continue;
         }
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
      if (ch.refresh) {
         /* A row couldn't be read, or a move happened without its answer: reload what's on screen
            (the early return above already marked a hidden list stale). */
         reload();
         return;
      }
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
         /* Loading waits for the link (the source reports it only once the flags are known); the
            link-up branch below then loads or catches up. */
         if (a === "available" && was !== "available" && linked && panelEffective()) reload();
         syncSubscription();
         render();
      },
      setAccounts: (list) => {
         const sameIdentity =
            list.length === accounts.length &&
            list.every(
               (a, i) =>
                  a.id === accounts[i]?.id &&
                  a.address === accounts[i].address &&
                  a.displayName === accounts[i].displayName &&
                  a.readOnly === accounts[i].readOnly
            );
         const sameCaps = sameIdentity && list.every((a, i) => a.canTrash === accounts[i].canTrash && a.canArchive === accounts[i].canArchive);
         if (sameCaps && accountsKnown) return; // a reconnect re-sent the same accounts: keep the list (and its scroll)
         if (sameIdentity && accountsKnown) {
            /* Only what they can move to changed (learned from a list page): redraw the actions. */
            accounts = list.slice();
            rowEls.clear();
            readerSig = "";
            render();
            return;
         }
         accountsKnown = true;
         accounts = list.slice();
         computeIdentity();
         rowEls.clear();
         readerSig = "";
         if (panelEffective()) reload();
         else render();
      },
      setAccountsError: (message) => {
         accountsError = message;
         render();
      },
      setUnreadCounts: setCounts,
      applyChanges,
      setLinked: (on) => {
         const was = linked;
         linked = on;
         syncSubscription();
         syncMark(); // a pending mark waits out a link loss
         if (on && !was && availability === "available") {
            refreshCounts();
            /* Before the first account list there is nothing to load yet: setAccounts loads then. */
            if (!accountsKnown) render();
            else if (!source.supportsLiveChanges()) {
               /* No change feed to catch up from: what arrived while down is learned by loading again. */
               if (panelEffective()) (rows.length ? refreshInPlace() : reload());
               else listStale = true;
            } else if (panelEffective() && (listStale || rows.length === 0)) (rows.length ? refreshInPlace() : reload());
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
         unfit();
         cancelMark();
         unsubPrefs();
         if (removed) window.clearTimeout(removed.timer);
         tabAway.dispose();
         document.removeEventListener("visibilitychange", onRawVisibility);
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
