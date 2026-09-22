/*
 * The Watchlist panel: a calm, read-only view of the user's tracked (NOT held) Schwab symbols,
 * pushed over the WS (stocks_watch_update). A sibling of the Stocks portfolio panel in the same
 * machined phosphor language, but its OWN standalone movable card - Portfolio = held, Watchlist =
 * tracked. Its subscription is INDEPENDENT of the portfolio's and gated on THIS panel's effective
 * visibility, so DAWN only quotes it while it is actually watched.
 *
 * Rows are quote-only (price + signed day change) - a watched symbol has no qty/value/unrealized,
 * so there is nothing personal to redact (public quotes), hence no eye toggle. The user curates the
 * list with a small add-symbol input and a per-row remove; both are user-scoped writes on the
 * user's own watchlist (stocks_watch_set), the same sanctioned class as the Watches panel verbs.
 *
 * Ambient signal: a row SPIKES (a brief gain/loss-tinted wash) only on a MATERIAL move (a ~0.5pp
 * day-change swing, a gain/loss sign flip, or a ~0.5% price move), never on the continuously-
 * ticking quote. Order is a STABLE alphabetical sort, recomputed only on membership change, so a
 * curated list never jitters. Every DAWN-sourced string is bound via textContent, never innerHTML.
 */

import type {
   StockMarket,
   StockWatchlist,
   StockWatchSymbol,
   WatchlistSink
} from "../ingest/ingest.ts";
import { addCorners } from "../render/corners.ts";
import { makeListCard } from "../render/list-card.ts";
import { makeMovable } from "../render/movable.ts";
import { makeVisibility } from "../render/visibility.ts";
import { assetBadge, assetLabel, compactSymbol, dirClass, dirGlyph, fmtPct, fmtSignedUsd, fmtUsd } from "../util/stock-format.ts";

export interface WatchlistPanelOptions {
   /* Subscribe (true) / unsubscribe (false) the watch push, with the current ext-hours choice.
      Wired to ingest.stocksWatchSubscribe; driven off effective visibility. */
   onWatchSubscribe(enabled: boolean, extHours: boolean): void;
   /* One-shot cached snapshot (the refresh button) -> ingest.refreshWatchlist. */
   onRefresh(extHours: boolean): void;
   /* Curate the watchlist (add/remove symbols) -> ingest.stocksWatchSet. A user-scoped write. */
   onWatchSet(add: string[], remove: string[]): void;
   /* Whether the DAWN link is live (gate the refresh + add + remove controls). */
   isLive(): boolean;
   notify?(msg: string): void;
}

export interface WatchlistPanelController extends WatchlistSink {
   isVisible(): boolean;
   setVisible(on: boolean): void;
   setSuspended(on: boolean): void;
   setTimezone(tz: string | undefined): void;
   destroy(): void;
}

const VISIBLE_KEY = "dawn.hero.watchlistShown";
const POS_KEY = "dawn.hero.watchlistPos";
const LIST_H_KEY = "dawn.hero.watchlistListH";
const EXT_KEY = "dawn.hero.watchlistExtHours";

const SPIKE_PP = 0.5; // day-change percent swing, in percentage points
const SPIKE_PRICE_FRAC = 0.005; // fractional price move
const REFRESH_LOCKOUT_MS = 3000;
const UNAVAILABLE_MS = 8000; // no frame this long after subscribing => feed not available on this DAWN
const MAX_SYMBOL_LEN = 12; // client-side sanity cap on an entered ticker (OCC roots + a margin)

/* Only a snapshot we are actively awaiting a refresh for can be "stale"; when no update is due
   (closed, or pre/post with ext-hours off, or not subscribed) a frozen stamp is expected. */
function staleAfterSec(market: StockMarket, extHours: boolean): number {
   if (market === "regular") return 90;
   if ((market === "pre" || market === "post") && extHours) return 900;
   return Infinity;
}

/* One entry in the frozen render order: a symbol key (the uppercased ticker). */
type Order = string[];

export function mountWatchlistPanel(root: HTMLElement, opts: WatchlistPanelOptions): WatchlistPanelController {
   const el = document.createElement("div");
   el.className = "watchlist lcard-host";
   addCorners(el);

   /* Header (drag handle): title + ext-hours pill + refresh. */
   const head = document.createElement("div");
   head.className = "watchlist-head";
   const titleEl = document.createElement("div");
   titleEl.className = "watchlist-title";
   titleEl.textContent = "Watchlist";
   const extBtn = document.createElement("button");
   extBtn.type = "button";
   extBtn.className = "watchlist-ext"; // drag-ignore hook
   extBtn.textContent = "EXT";
   const refreshBtn = document.createElement("button");
   refreshBtn.type = "button";
   refreshBtn.className = "watchlist-refresh panel-refresh"; // drag-ignore hook
   refreshBtn.setAttribute("aria-label", "Refresh watchlist");
   refreshBtn.title = "Refresh";
   head.append(titleEl, extBtn, refreshBtn);

   const statusEl = document.createElement("div");
   statusEl.className = "watchlist-status";

   /* Add-symbol row: a small input + button. Not part of the drag handle, so typing works. */
   const addRow = document.createElement("form");
   addRow.className = "watchlist-add"; // drag-ignore hook (its controls are interactive)
   const addInput = document.createElement("input");
   addInput.type = "text";
   addInput.className = "watchlist-add-input";
   addInput.placeholder = "Add symbol";
   addInput.setAttribute("aria-label", "Add a symbol to the watchlist");
   addInput.maxLength = MAX_SYMBOL_LEN;
   addInput.autocomplete = "off";
   addInput.spellcheck = false;
   const addBtn = document.createElement("button");
   addBtn.type = "submit";
   addBtn.className = "watchlist-add-btn";
   addBtn.textContent = "+";
   addBtn.setAttribute("aria-label", "Add symbol");
   addRow.append(addInput, addBtn);

   const list = document.createElement("div");
   list.className = "watchlist-list";

   el.append(head, statusEl, addRow, list);
   root.appendChild(el);

   const card = makeListCard(el, list, { storageKey: LIST_H_KEY });
   const disposeMovable = makeMovable(el, {
      storageKey: POS_KEY,
      handle: ".watchlist-head",
      ignore: ".watchlist-refresh, .watchlist-ext"
   });
   /* Opt-in like the portfolio panel (finance-adjacent; no surprise on a shared screen). */
   const vis = makeVisibility(el, { storageKey: VISIBLE_KEY, offClass: "watchlist-off", defaultVisible: false });
   const reducedMotion =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

   /* --- state ------------------------------------------------------------- */
   let watchlist: StockWatchlist | null = null;
   let tz: string | undefined;
   let lastFrameAt = 0;
   let lastRefreshAt = 0;
   let extHours = false;
   try {
      extHours = localStorage.getItem(EXT_KEY) === "1";
   } catch {
      /* storage blocked - default stands */
   }

   /* Spike baselines + frozen order, keyed by uppercased symbol. */
   const baseline = new Map<string, { price: number; dayChangePct: number; dayChange: number }>();
   let order: Order = [];
   let structureSig = "";
   let seedNextFrame = false;

   /* --- subscription lifecycle (gated on EFFECTIVE visibility) ------------ */
   let suspended = false;
   let tabHidden = typeof document !== "undefined" && document.hidden;
   let subscribed = false;
   const effective = (): boolean => vis.isVisible() && !suspended && !tabHidden;
   const syncSubscription = (): void => {
      const want = effective();
      if (want === subscribed) return;
      subscribed = want;
      if (want) {
         lastFrameAt = performance.now();
         baseline.clear();
         seedNextFrame = true;
      }
      opts.onWatchSubscribe(want, extHours);
      render();
   };
   const onVisChange = (): void => {
      tabHidden = document.hidden;
      syncSubscription();
   };
   document.addEventListener("visibilitychange", onVisChange);

   /* --- as-of stamp + staleness ------------------------------------------ */
   const fmtAsOf = (asOfSec: number): string => {
      const d = new Date(asOfSec * 1000);
      const now = new Date();
      let sameDay: boolean;
      try {
         const f = new Intl.DateTimeFormat("en-US", { timeZone: tz || undefined, year: "numeric", month: "numeric", day: "numeric" });
         sameDay = f.format(d) === f.format(now);
      } catch {
         sameDay = d.toDateString() === now.toDateString();
      }
      const fmtOpts: Intl.DateTimeFormatOptions = sameDay
         ? { hour: "numeric", minute: "2-digit" }
         : { weekday: "short", hour: "numeric", minute: "2-digit" };
      try {
         return new Intl.DateTimeFormat("en-US", { timeZone: tz || undefined, ...fmtOpts }).format(d);
      } catch {
         return d.toLocaleTimeString();
      }
   };
   const isStale = (asOf: number, market: StockMarket): boolean =>
      subscribed && Date.now() / 1000 - asOf > staleAfterSec(market, extHours);

   /* --- ordering + spike -------------------------------------------------- */
   const membershipSig = (symbols: StockWatchSymbol[]): string =>
      symbols
         .map((s) => s.symbol)
         .sort()
         .join(",");
   const computeOrder = (symbols: StockWatchSymbol[]): Order => symbols.map((s) => s.symbol).sort();
   const isMaterial = (key: string, s: StockWatchSymbol): boolean => {
      const b = baseline.get(key);
      if (!b) return false;
      if (b.dayChange !== 0 && s.dayChange !== 0 && Math.sign(b.dayChange) !== Math.sign(s.dayChange)) return true;
      if (Math.abs(s.dayChangePct - b.dayChangePct) >= SPIKE_PP) return true;
      return Math.abs(s.price - b.price) >= SPIKE_PRICE_FRAC * Math.abs(s.price);
   };

   /* --- render ------------------------------------------------------------ */
   const emptyStateText = (): string => {
      const status = watchlist?.status ?? "ok";
      if (status === "token_expired") return "Schwab link expired - reconnect in DAWN (dawn-admin schwab auth).";
      if (status === "not_connected") return "No brokerage linked in DAWN.";
      if (status === "rate_limited" || status === "error") return "Watchlist temporarily unavailable.";
      if (subscribed && lastFrameAt > 0 && performance.now() - lastFrameAt > UNAVAILABLE_MS)
         return "Watchlist feed not available on this DAWN.";
      if (!subscribed) return "Watchlist hidden.";
      if (watchlist) return "No symbols watched yet. Add one above.";
      return "Loading…";
   };

   const buildRow = (s: StockWatchSymbol, spike: boolean): HTMLElement => {
      const unquotable = s.quotable === false; // stored but Schwab returned no quote (bad ticker)
      const row = document.createElement("div");
      row.className = "watchlist-row";
      if (unquotable) row.classList.add("watchlist-unquotable");
      if (spike && !unquotable) row.classList.add(s.dayChangePct >= 0 ? "watchlist-spike-gain" : "watchlist-spike-loss");

      const l1 = document.createElement("div");
      l1.className = "watchlist-row-l1";
      const main = document.createElement("div");
      main.className = "watchlist-row-main";
      const sym = document.createElement("span");
      sym.className = "watchlist-sym";
      sym.textContent = compactSymbol(s.symbol, s.assetType === "option"); // DAWN string -> textContent
      if (s.description) sym.title = s.description; // full instrument name on hover
      const badge = document.createElement("span");
      badge.className = `watchlist-badge type-${s.assetType}`;
      badge.textContent = assetBadge(s.assetType);
      badge.title = assetLabel(s.assetType);
      main.append(sym, badge);
      const price = document.createElement("span");
      price.className = "watchlist-price";
      if (unquotable) {
         price.textContent = "no quote";
         price.classList.add("watchlist-noquote");
         price.title = "No quote available - this symbol may not be recognized.";
      } else {
         price.textContent = fmtUsd(s.price);
      }
      l1.append(main, price);

      const l2 = document.createElement("div");
      l2.className = "watchlist-row-l2";
      const name = document.createElement("span");
      name.className = "watchlist-name";
      name.textContent = s.description ?? ""; // DAWN string -> textContent
      const day = document.createElement("span");
      if (unquotable) {
         day.className = "watchlist-day watchlist-noquote";
         day.textContent = "not recognized";
      } else {
         day.className = `watchlist-day ${dirClass(s.dayChange)}`;
         day.textContent = `${dirGlyph(s.dayChange)} ${fmtSignedUsd(s.dayChange)} (${fmtPct(s.dayChangePct)})`;
      }
      l2.append(name, day);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "watchlist-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${s.symbol}`);
      remove.title = `Remove ${s.symbol}`;
      remove.disabled = !opts.isLive();
      remove.addEventListener("click", () => {
         if (!opts.isLive()) return;
         opts.onWatchSet([], [s.symbol]); // trivially reversible (re-add) -> no confirm gate
      });

      row.append(l1, l2, remove);
      return row;
   };

   const render = (): void => {
      extBtn.classList.toggle("on", extHours);
      extBtn.setAttribute("aria-pressed", extHours ? "true" : "false");
      extBtn.setAttribute("aria-label", extHours ? "Extended hours on" : "Extended hours off");
      extBtn.title = "Extended hours";
      refreshBtn.disabled = !opts.isLive();
      addInput.disabled = !opts.isLive();
      addBtn.disabled = !opts.isLive();

      const symbols = watchlist?.symbols ?? [];
      const hasRows = symbols.length > 0;

      if (!hasRows) {
         list.replaceChildren();
         order = [];
         structureSig = "";
         baseline.clear();
         statusEl.hidden = false;
         const degraded = (watchlist?.status ?? "ok") !== "ok";
         statusEl.className = `watchlist-status${degraded ? " watchlist-status-stale" : ""}`;
         statusEl.textContent = emptyStateText();
         card.refresh();
         return;
      }

      const market = watchlist?.market ?? "closed";
      const asOf = watchlist?.asOf;
      const stale = typeof asOf === "number" ? isStale(asOf, market) : false;
      const degraded = (watchlist?.status ?? "ok") !== "ok";

      statusEl.hidden = false;
      statusEl.className = `watchlist-status${degraded || stale ? " watchlist-status-stale" : ""}`;
      const asOfStr = typeof asOf === "number" ? ` · as of ${fmtAsOf(asOf)}` : "";
      statusEl.textContent = degraded || stale ? `${market.toUpperCase()} · stale${asOfStr}` : `${market.toUpperCase()}${asOfStr}`;

      // Freeze order; recompute only when membership changes (a symbol added/removed).
      const nextSig = membershipSig(symbols);
      const structural = nextSig !== structureSig;
      if (structural) {
         order = computeOrder(symbols);
         structureSig = nextSig;
      }

      const byKey = new Map<string, StockWatchSymbol>();
      symbols.forEach((s) => byKey.set(s.symbol, s));

      const seed = structural || seedNextFrame;
      const spiking = new Set<string>();
      for (const key of order) {
         const s = byKey.get(key);
         if (!s) continue;
         if (s.quotable === false) {
            // No quote -> nothing to spike on; drop any baseline so a later re-quote re-seeds clean.
            baseline.delete(key);
            continue;
         }
         if (!seed && !reducedMotion && isMaterial(key, s)) spiking.add(key);
         if (seed || spiking.has(key) || !baseline.has(key)) {
            baseline.set(key, { price: s.price, dayChangePct: s.dayChangePct, dayChange: s.dayChange });
         }
      }
      // Prune baselines for symbols no longer present.
      for (const key of [...baseline.keys()]) if (!byKey.has(key)) baseline.delete(key);

      const rows: HTMLElement[] = [];
      for (const key of order) {
         const s = byKey.get(key);
         if (s) rows.push(buildRow(s, spiking.has(key)));
      }
      list.replaceChildren(...rows);
      card.refresh();
   };

   /* --- controls ---------------------------------------------------------- */
   const submitAdd = (e: Event): void => {
      e.preventDefault();
      if (!opts.isLive()) return;
      const raw = addInput.value.trim().toUpperCase();
      addInput.value = ""; // always clear on submit
      if (!raw) return; // empty submit: nothing typed, no feedback needed
      // Validate the FORMAT client-side and tell the user, rather than silently stripping bad
      // characters. A well-formed-but-nonexistent ticker (e.g. "ZZZZ") still passes here and is
      // surfaced by the server as an unquotable "no quote" row; this only catches bad format.
      if (!/^[A-Z0-9.]+$/.test(raw)) {
         // input maxLength (MAX_SYMBOL_LEN) already bounds the length; this only checks characters.
         opts.notify?.("Enter a valid symbol (letters, numbers, and '.' only).");
         return;
      }
      if ((watchlist?.symbols ?? []).some((s) => s.symbol === raw)) {
         opts.notify?.(`${raw} is already on the watchlist.`);
         return;
      }
      opts.onWatchSet([raw], []);
   };
   addRow.addEventListener("submit", submitAdd);

   const onRefreshClick = (): void => {
      const now = performance.now();
      if (!opts.isLive() || now - lastRefreshAt < REFRESH_LOCKOUT_MS) return;
      lastRefreshAt = now;
      opts.onRefresh(extHours);
   };
   refreshBtn.addEventListener("click", onRefreshClick);

   const onExtClick = (): void => {
      extHours = !extHours;
      try {
         localStorage.setItem(EXT_KEY, extHours ? "1" : "0");
      } catch {
         /* ignore */
      }
      if (subscribed) opts.onWatchSubscribe(true, extHours);
      render();
   };
   extBtn.addEventListener("click", onExtClick);

   /* A slow ticker re-evaluates staleness (and the unavailable state) even with no frame. */
   const watchdog = window.setInterval(() => {
      if (vis.isVisible()) render();
   }, 15000);

   render();
   syncSubscription();

   const controller: WatchlistPanelController = {
      setWatchlist: (w) => {
         watchlist = w;
         lastFrameAt = performance.now();
         render();
         seedNextFrame = false;
      },
      isVisible: vis.isVisible,
      setVisible: (on) => {
         vis.setVisible(on);
         syncSubscription();
      },
      setSuspended: (on) => {
         if (suspended === on) return;
         suspended = on;
         syncSubscription();
      },
      setTimezone: (z) => {
         tz = z;
         if (watchlist?.symbols?.length) render();
      },
      destroy: () => {
         if (subscribed) opts.onWatchSubscribe(false, extHours);
         subscribed = false;
         window.clearInterval(watchdog);
         document.removeEventListener("visibilitychange", onVisChange);
         addRow.removeEventListener("submit", submitAdd);
         refreshBtn.removeEventListener("click", onRefreshClick);
         extBtn.removeEventListener("click", onExtClick);
         card.destroy();
         disposeMovable();
         el.remove();
      }
   };
   return controller;
}
