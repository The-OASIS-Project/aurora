/*
 * The Stocks panel: a calm, read-only view of the user's OWN Schwab portfolio, pushed over the
 * WS (stocks_portfolio_update). A standalone movable card in the same machined phosphor language
 * as the Watches / HA boards - grab-to-move header, a Panels-menu show/hide, corner brackets.
 *
 * It is the user's own financial data, read-only - no write beyond the sanctioned
 * subscribe/get. The subscription is gated on EFFECTIVE visibility (shown AND not suspended by
 * the standby screensaver or a hidden tab), so DAWN only fetches from Schwab when someone is
 * actually looking (mirrors the Watches 1 Hz gauge).
 *
 * Ambient signal: a position row SPIKES (a brief gain/loss-tinted wash) only on a MATERIAL move
 * (a ~0.5pp day-change swing, a gain/loss sign flip, or a ~0.5% value move), never on the
 * continuously-ticking value - so the flash means something (the repo's watches rule). The
 * display order is frozen on a structural change (a symbol added/removed), so rows do not
 * re-sort and jitter every frame.
 *
 * Security/privacy: every DAWN-sourced string (symbol, account label, market) is bound via
 * textContent, never innerHTML. Financial values are never logged or persisted (only UI prefs).
 * The eye toggle redacts values in the FORMATTER (a fixed-width mask), so nothing sensitive
 * sits in the DOM when hidden and there is no layout shift on toggle.
 */

import type {
   StockAccount,
   StockPortfolio,
   StockPosition,
   StockSnapshot,
   StocksSink
} from "../ingest/ingest.ts";
import { addCorners } from "../render/corners.ts";
import { makeListCard } from "../render/list-card.ts";
import { makeMovable } from "../render/movable.ts";
import { makeVisibility } from "../render/visibility.ts";
import { assetBadge, assetLabel, compactSymbol, dirClass, dirGlyph, extSessionLabel, fmtPct, fmtSignedUsd, fmtUsd } from "../util/stock-format.ts";

export interface StocksPanelOptions {
   /* Subscribe (true) / unsubscribe (false) the portfolio push, with the current ext-hours
      choice. Wired to ingest.stocksPortfolioSubscribe; driven off effective visibility. */
   onPortfolioSubscribe(enabled: boolean, extHours: boolean): void;
   /* One-shot cached snapshot (the refresh button) -> ingest.refreshStocks. */
   onRefresh(extHours: boolean): void;
   /* Whether the DAWN link is live (gate the refresh button). */
   isLive(): boolean;
   notify?(msg: string): void;
}

export interface StocksPanelController extends StocksSink {
   isVisible(): boolean;
   setVisible(on: boolean): void;
   /* Suspend/resume the subscription independent of the panel toggle: set by the standby
      screensaver, so "nobody watching" means zero API traffic. (A hidden tab is handled
      internally via visibilitychange.) */
   setSuspended(on: boolean): void;
   /* The DAWN user's IANA tz, for the "as of" stamp. */
   setTimezone(tz: string | undefined): void;
   destroy(): void;
}

const VISIBLE_KEY = "dawn.hero.stocksShown";
const POS_KEY = "dawn.hero.stocksPos";
const LIST_H_KEY = "dawn.hero.stocksListH";
const EXT_KEY = "dawn.hero.stocksExtHours";
const REDACT_KEY = "dawn.hero.stocksRedact";

/* Materiality thresholds for a spike (tuned live). */
const SPIKE_PP = 0.5; // day-change percent swing, in percentage points
const SPIKE_VALUE_FRAC = 0.005; // fractional value move
const SPIKE_VALUE_MIN = 50; // ...or this absolute $ move, whichever is larger

/* Schwab-link expiry warning bands (the link lives ~7 days). Stay silent when comfortably
   ahead; a neutral note within LINK_WARN_SEC; amber within LINK_URGENT_SEC. */
const LINK_WARN_SEC = 72 * 3600; // 3 days: start showing a quiet note
const LINK_URGENT_SEC = 24 * 3600; // 1 day: escalate to amber "reconnect soon"

const REFRESH_LOCKOUT_MS = 3000;
/* No frame within this long after subscribing => the feed is not available on this DAWN (an
   older daemon silently drops the unknown verb), distinct from the brief initial "loading". */
const UNAVAILABLE_MS = 8000;
/* How long a snapshot stays "live" before the stamp escalates to stale, by market state.
   Keyed on whether updates are EXPECTED: a stamp is only "stale" when we were waiting for a
   refresh that did not arrive. Regular hours always push (90s cadence). Pre/post push ONLY
   when the user has Extended Hours on (15 min cadence); with it off we never subscribed to
   off-hours updates, so a frozen pre/post stamp is expected, not stale. Closed never pushes.
   So: never "stale by age" unless an update was actually due. */
function staleAfterSec(market: StockPortfolio["market"], extHours: boolean): number {
   if (market === "regular") return 90;
   if ((market === "pre" || market === "post") && extHours) return 900; // 15 min ext-hours cadence
   return Infinity; // closed, or pre/post with ext-hours off: no updates expected -> never stale by age
}

/* Redaction replaces every DIGIT with a bullet, keeping the surrounding $ , . % + - and the
   width intact (with tabular-nums, no layout shift). So the real value is never in the DOM
   while hidden. */
function maskFigure(s: string): string {
   return s.replace(/\d/g, "•");
}
function fmtQty(q: number): string {
   if (Number.isInteger(q)) return String(q);
   return q.toFixed(4).replace(/\.?0+$/, "");
}

/* One entry in the frozen render order: an account header, or a position keyed by acct:symbol. */
type RenderItem = { kind: "header"; acct: number } | { kind: "pos"; key: string };

/* Feather-style eye / eye-off, same stroke-icon language as the music player's transport
   glyphs. `off` = the eye-with-slash shown while values are redacted. */
const SVG_NS = "http://www.w3.org/2000/svg";
function eyeIcon(off: boolean): SVGSVGElement {
   const svg = document.createElementNS(SVG_NS, "svg");
   svg.setAttribute("viewBox", "0 0 24 24");
   svg.setAttribute("aria-hidden", "true");
   svg.setAttribute("fill", "none");
   svg.setAttribute("stroke", "currentColor");
   svg.setAttribute("stroke-width", "1.7");
   svg.setAttribute("stroke-linecap", "round");
   svg.setAttribute("stroke-linejoin", "round");
   const paths = off
      ? [
           "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94",
           "M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19",
           "M9.88 9.88a3 3 0 1 0 4.24 4.24",
           "M1 1l22 22"
        ]
      : ["M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"];
   for (const d of paths) {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
   }
   return svg;
}

export function mountStocksPanel(root: HTMLElement, opts: StocksPanelOptions): StocksPanelController {
   const el = document.createElement("div");
   el.id = "stocks";
   el.className = "stocks";
   addCorners(el);

   /* Header (drag handle): title + ext-hours pill + eye redact + refresh. */
   const head = document.createElement("div");
   head.className = "stocks-head";
   const titleEl = document.createElement("div");
   titleEl.className = "stocks-title";
   titleEl.textContent = "Portfolio";
   const extBtn = document.createElement("button");
   extBtn.type = "button";
   extBtn.className = "stocks-ext"; // drag-ignore hook
   extBtn.textContent = "EXT";
   const eyeBtn = document.createElement("button");
   eyeBtn.type = "button";
   eyeBtn.className = "stocks-eye"; // drag-ignore hook
   const refreshBtn = document.createElement("button");
   refreshBtn.type = "button";
   refreshBtn.className = "stocks-refresh panel-refresh"; // drag-ignore hook
   refreshBtn.setAttribute("aria-label", "Refresh portfolio");
   refreshBtn.title = "Refresh";
   head.append(titleEl, extBtn, eyeBtn, refreshBtn);

   /* Headline: total value + day change; a secondary all-time line. */
   const headline = document.createElement("div");
   headline.className = "stocks-headline";
   const totalEl = document.createElement("div");
   totalEl.className = "stocks-total";
   const dayEl = document.createElement("div");
   dayEl.className = "stocks-day";
   const allTimeEl = document.createElement("div");
   allTimeEl.className = "stocks-alltime";
   headline.append(totalEl, dayEl, allTimeEl);

   const statusEl = document.createElement("div");
   statusEl.className = "stocks-status";

   /* Schwab-link expiry warning: hidden until the link is within the warn window, then a
      quiet note, then an amber "reconnect soon" as it gets close. Read-only - it points at
      the CLI relink, never performs the OAuth itself. */
   const linkEl = document.createElement("div");
   linkEl.className = "stocks-link";
   linkEl.hidden = true;

   const list = document.createElement("div");
   list.className = "stocks-list";

   el.append(head, headline, statusEl, linkEl, list);
   root.appendChild(el);

   const card = makeListCard(el, list, { storageKey: LIST_H_KEY });
   const disposeMovable = makeMovable(el, {
      storageKey: POS_KEY,
      handle: ".stocks-head",
      ignore: ".stocks-refresh, .stocks-eye, .stocks-ext"
   });
   /* Opt-in: financial data should not auto-appear (a garage TV, a screen-share). The user
      turns it on from the Panels menu; the choice then persists like any other panel. */
   const vis = makeVisibility(el, { storageKey: VISIBLE_KEY, offClass: "stocks-off", defaultVisible: false });
   const reducedMotion =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

   /* --- state ------------------------------------------------------------- */
   let portfolio: StockPortfolio | null = null;
   let tz: string | undefined;
   let lastFrameAt = 0;
   let lastRefreshAt = 0;
   let extHours = false;
   let redacted = false;
   let eyeShownOff: boolean | null = null; // which eye icon is currently mounted (avoid per-frame rebuild)
   try {
      extHours = localStorage.getItem(EXT_KEY) === "1";
      redacted = localStorage.getItem(REDACT_KEY) === "1";
   } catch {
      /* storage blocked - defaults stand */
   }

   /* Spike baselines + frozen order, keyed by acct:symbol. */
   const baseline = new Map<string, { value: number; dayChangePct: number; dayChange: number }>();
   let order: RenderItem[] = [];
   let structureSig = "";
   /* Set on (re)subscribe; the first real frame after it is treated as a baseline (no spikes),
      then it clears - so a resume does not wash the list for moves that happened while away. */
   let seedNextFrame = false;

   const money = (n: number): string => (redacted ? maskFigure(fmtUsd(n)) : fmtUsd(n));
   const moneySigned = (n: number): string => (redacted ? maskFigure(fmtSignedUsd(n)) : fmtSignedUsd(n));
   const pct = (n: number): string => (redacted ? maskFigure(fmtPct(n)) : fmtPct(n));

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
         /* A fresh (re)subscribe: the next real frame is a new baseline (no spikes), so resume
            does not wash the list for moves that happened while suspended. */
         baseline.clear();
         seedNextFrame = true;
      }
      opts.onPortfolioSubscribe(want, extHours);
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
         return new Intl.DateTimeFormat("en-US", fmtOpts).format(d);
      }
   };
   /* Only a snapshot we are actively awaiting a refresh for can be "stale". If the panel is
      not subscribed (suspended in standby, a hidden tab, or otherwise not watched), no update
      is due, so a frozen stamp is expected - never stale. Combined with staleAfterSec's
      market/ext-hours gating, this is the full "don't cry stale when no update is due" rule. */
   const isStale = (snap: StockSnapshot, market: StockPortfolio["market"]): boolean =>
      subscribed && Date.now() / 1000 - snap.asOf > staleAfterSec(market, extHours);

   /* --- ordering + spike -------------------------------------------------- */
   const posKey = (acct: number, symbol: string): string => `${acct}:${symbol}`;

   /* Recompute the frozen render order from a snapshot. Positions sort by |value| desc within
      each account; a header precedes each account only when there is more than one. */
   const computeOrder = (accounts: StockAccount[]): RenderItem[] => {
      const items: RenderItem[] = [];
      const multi = accounts.length > 1;
      accounts.forEach((a, i) => {
         if (multi) items.push({ kind: "header", acct: i });
         [...a.positions]
            .sort((x, y) => Math.abs(y.value) - Math.abs(x.value))
            .forEach((p) => items.push({ kind: "pos", key: posKey(i, p.symbol) }));
      });
      return items;
   };
   /* Membership signature: value-INDEPENDENT (lexically-sorted keys + account layout). The
      display order is recomputed ONLY when this changes (a symbol/account added or removed) -
      never when two holdings swap value rank on a price tick, which would otherwise re-sort the
      rows and suppress that frame's spikes + reset every baseline. */
   const membershipSig = (accounts: StockAccount[]): string => {
      const multi = accounts.length > 1;
      return accounts
         .map((a, i) => `${multi ? `H${i};` : ""}${a.positions.map((p) => posKey(i, p.symbol)).sort().join(",")}`)
         .join("|");
   };

   /* Whether a position's move since its baseline is material enough to spike. */
   const isMaterial = (key: string, p: StockPosition): boolean => {
      const b = baseline.get(key);
      if (!b) return false; // no baseline yet (fresh subscribe / structural change) => no spike
      // A genuine gain<->loss crossing (both sides nonzero) is material; a move off exactly-flat
      // is not treated as a "flip" on its own - the magnitude thresholds below catch it.
      if (b.dayChange !== 0 && p.dayChange !== 0 && Math.sign(b.dayChange) !== Math.sign(p.dayChange)) return true;
      if (Math.abs(p.dayChangePct - b.dayChangePct) >= SPIKE_PP) return true;
      return Math.abs(p.value - b.value) >= Math.max(SPIKE_VALUE_MIN, SPIKE_VALUE_FRAC * Math.abs(p.value));
   };

   /* --- render ------------------------------------------------------------ */
   const render = (): void => {
      el.classList.toggle("stocks-redacted", redacted);
      eyeBtn.setAttribute("aria-label", redacted ? "Show values" : "Hide values");
      eyeBtn.setAttribute("aria-pressed", redacted ? "true" : "false");
      eyeBtn.title = redacted ? "Show values" : "Hide values";
      if (eyeShownOff !== redacted) {
         eyeBtn.replaceChildren(eyeIcon(redacted)); // rebuild only on a state change, not every frame
         eyeShownOff = redacted;
      }
      extBtn.classList.toggle("on", extHours);
      extBtn.setAttribute("aria-pressed", extHours ? "true" : "false");
      extBtn.setAttribute("aria-label", extHours ? "Extended hours on" : "Extended hours off");
      extBtn.title = "Extended hours";

      const snap = portfolio?.snapshot;
      if (!snap) {
         el.classList.remove("stocks-degraded");
         headline.hidden = true;
         list.replaceChildren();
         order = [];
         structureSig = "";
         baseline.clear();
         statusEl.hidden = false;
         statusEl.className = "stocks-status";
         statusEl.textContent = emptyStateText(portfolio, subscribed, lastFrameAt);
         // A state-only frame (e.g. token_expired) owns its own reconnect messaging; the
         // proactive expiry note only rides alongside a live snapshot.
         linkEl.hidden = true;
         card.refresh();
         return;
      }

      const market = portfolio?.market ?? "closed";
      const stale = isStale(snap, market);
      const degraded = (portfolio?.status ?? "ok") !== "ok";
      el.classList.toggle("stocks-degraded", degraded || stale);

      headline.hidden = false;
      totalEl.textContent = money(snap.totalValue);
      dayEl.className = `stocks-day ${dirClass(snap.totalDayChange)}`;
      dayEl.textContent = `${dirGlyph(snap.totalDayChange)} ${moneySigned(snap.totalDayChange)} (${pct(snap.totalDayChangePct)})`;
      allTimeEl.className = `stocks-alltime ${dirClass(snap.totalUnrealizedPl)}`;
      allTimeEl.textContent = `All-time ${moneySigned(snap.totalUnrealizedPl)} (${pct(snap.totalUnrealizedPlPct)})`;

      statusEl.hidden = false;
      statusEl.className = `stocks-status${degraded || stale ? " stocks-status-stale" : ""}`;
      const asOf = `as of ${fmtAsOf(snap.asOf)}`;
      statusEl.textContent = degraded || stale ? `${market.toUpperCase()} · stale · ${asOf}` : `${market.toUpperCase()} · ${asOf}`;

      // Schwab-link expiry note (feature-detected; absent when the daemon omits it).
      const note = linkNote(portfolio?.linkExpiresAt, Date.now() / 1000);
      linkEl.hidden = !note;
      if (note) {
         linkEl.className = `stocks-link${note.urgent ? " stocks-link-urgent" : ""}`;
         linkEl.textContent = note.text;
      }

      // Index the current positions by key + keep the account for a header lookup.
      const posByKey = new Map<string, StockPosition>();
      snap.accounts.forEach((a, i) => a.positions.forEach((p) => posByKey.set(posKey(i, p.symbol), p)));

      // Freeze the display order across frames; recompute only when MEMBERSHIP changes (a symbol
      // or account added/removed), never on a value-rank swap.
      const nextSig = membershipSig(snap.accounts);
      const structural = nextSig !== structureSig;
      if (structural) {
         order = computeOrder(snap.accounts);
         structureSig = nextSig;
      }

      // A "seed" frame (a structural change OR the first frame after a (re)subscribe) sets
      // baselines without spiking, so resume / a symbol change never washes the whole list for
      // moves the user did not just watch happen.
      const seed = structural || seedNextFrame;
      const spiking = new Set<string>();
      for (const it of order) {
         if (it.kind !== "pos") continue;
         const p = posByKey.get(it.key);
         if (!p) continue;
         if (!seed && !reducedMotion && isMaterial(it.key, p)) spiking.add(it.key);
         if (seed || spiking.has(it.key) || !baseline.has(it.key)) {
            baseline.set(it.key, { value: p.value, dayChangePct: p.dayChangePct, dayChange: p.dayChange });
         }
      }
      // Prune baselines for symbols no longer held (bounded growth across churn).
      for (const k of baseline.keys()) if (!posByKey.has(k)) baseline.delete(k);

      // Build rows in the frozen order.
      const rows: HTMLElement[] = [];
      for (const it of order) {
         if (it.kind === "header") {
            rows.push(buildAccountHeader(snap.accounts[it.acct]));
         } else {
            const p = posByKey.get(it.key);
            if (p) rows.push(buildRow(p, spiking.has(it.key)));
         }
      }
      const cash = snap.accounts.reduce((s, a) => s + a.cash, 0);
      if (cash !== 0) rows.push(buildCashRow(cash)); // show a negative (margin) balance too, so it reconciles
      list.replaceChildren(...rows);
      card.refresh();
   };

   const buildAccountHeader = (a: StockAccount): HTMLElement => {
      const h = document.createElement("div");
      h.className = "stocks-acct";
      h.textContent = a.label; // masked "…1234", DAWN string -> textContent
      return h;
   };

   const buildRow = (p: StockPosition, spike: boolean): HTMLElement => {
      const row = document.createElement("div");
      row.className = "stocks-row";
      if (spike) row.classList.add(p.dayChangePct >= 0 ? "stocks-spike-gain" : "stocks-spike-loss");

      const l1 = document.createElement("div");
      l1.className = "stocks-row-l1";
      const main = document.createElement("div");
      main.className = "stocks-row-main";
      const sym = document.createElement("span");
      sym.className = "stocks-sym";
      sym.textContent = compactSymbol(p.symbol, p.assetType === "option"); // DAWN string -> textContent
      if (p.description) sym.title = p.description; // hover shows the full instrument name (title = plain string, not an HTML sink)
      const badge = document.createElement("span");
      badge.className = `stocks-badge type-${p.assetType}`;
      badge.textContent = assetBadge(p.assetType);
      badge.title = assetLabel(p.assetType); // hover expands the abbreviation
      main.append(sym, badge);
      const val = document.createElement("span");
      val.className = "stocks-val";
      val.textContent = money(p.value);
      l1.append(main, val);

      const l2 = document.createElement("div");
      l2.className = "stocks-row-l2";
      const qty = document.createElement("span");
      qty.className = "stocks-qty";
      // Mask the share count too under redact: symbol + count + public price would otherwise
      // reconstruct the hidden value.
      const qtyStr = redacted ? maskFigure(fmtQty(p.qty)) : fmtQty(p.qty);
      qty.textContent = `${qtyStr} @ ${money(p.price)}`;
      const day = document.createElement("span");
      day.className = `stocks-row-day ${dirClass(p.dayChangePct)}`;
      day.textContent = `${dirGlyph(p.dayChangePct)} ${moneySigned(p.dayChange)} (${pct(p.dayChangePct)})`;
      l2.append(qty, day);

      // Extended-hours overlay: the ext delta is PER-SHARE, so derive the POSITION-total dollar
      // (change * qty) to match the position-total day change above. Redact-aware.
      if (p.ext) {
         const extEl = document.createElement("div");
         const posChange = p.ext.change * p.qty; // per-share ext delta -> position dollar
         // Sign glyph/tint/pct off the POSITION, not the per-share pct: for a short (qty < 0) a rising
         // quote is a loss, so the arrow/color must match the (negative) position dollar.
         const posPct = p.ext.changePct * Math.sign(p.qty || 1);
         extEl.className = `stocks-row-ext ${dirClass(posPct)}`;
         extEl.textContent = `${extSessionLabel(portfolio?.market ?? "closed")} ${dirGlyph(posPct)} ${moneySigned(posChange)} (${pct(posPct)})`;
         row.append(l1, l2, extEl);
      } else {
         row.append(l1, l2);
      }
      return row;
   };

   const buildCashRow = (cash: number): HTMLElement => {
      const row = document.createElement("div");
      row.className = "stocks-row stocks-cash";
      const l1 = document.createElement("div");
      l1.className = "stocks-row-l1";
      const label = document.createElement("span");
      label.className = "stocks-sym";
      label.textContent = "Cash";
      const val = document.createElement("span");
      val.className = "stocks-val";
      val.textContent = money(cash);
      l1.append(label, val);
      row.append(l1);
      return row;
   };

   const onRefreshClick = (e: MouseEvent): void => {
      e.stopPropagation();
      const now = performance.now();
      if (now - lastRefreshAt < REFRESH_LOCKOUT_MS) return; // debounce click-spam
      if (!opts.isLive()) {
         opts.notify?.("Not connected to DAWN - portfolio not refreshed.");
         return;
      }
      lastRefreshAt = now;
      opts.onRefresh(extHours);
      refreshBtn.classList.remove("spin");
      void refreshBtn.offsetWidth;
      refreshBtn.classList.add("spin");
   };
   refreshBtn.addEventListener("click", onRefreshClick);

   const onEyeClick = (e: MouseEvent): void => {
      e.stopPropagation();
      redacted = !redacted;
      try {
         localStorage.setItem(REDACT_KEY, redacted ? "1" : "0");
      } catch {
         /* ignore */
      }
      render();
   };
   eyeBtn.addEventListener("click", onEyeClick);

   const onExtClick = (e: MouseEvent): void => {
      e.stopPropagation();
      extHours = !extHours;
      try {
         localStorage.setItem(EXT_KEY, extHours ? "1" : "0");
      } catch {
         /* ignore */
      }
      /* Re-subscribe with the new cadence choice (idempotent server-side) if currently on. */
      if (subscribed) opts.onPortfolioSubscribe(true, extHours);
      render();
   };
   extBtn.addEventListener("click", onExtClick);

   /* A slow ticker re-evaluates as-of staleness (and the unavailable state) even with no frame;
      skipped while the panel is off-screen (nothing to re-evaluate there). */
   const watchdog = window.setInterval(() => {
      if (vis.isVisible()) render();
   }, 15000);

   render();
   syncSubscription();

   const controller: StocksPanelController = {
      setPortfolio: (p) => {
         portfolio = p;
         lastFrameAt = performance.now();
         render();
         seedNextFrame = false; // the first real frame after (re)subscribe has now seeded baselines
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
         if (portfolio?.snapshot) render();
      },
      destroy: () => {
         if (subscribed) opts.onPortfolioSubscribe(false, extHours);
         subscribed = false;
         window.clearInterval(watchdog);
         document.removeEventListener("visibilitychange", onVisChange);
         refreshBtn.removeEventListener("click", onRefreshClick);
         eyeBtn.removeEventListener("click", onEyeClick);
         extBtn.removeEventListener("click", onExtClick);
         card.destroy();
         disposeMovable();
         el.remove();
      }
   };
   return controller;
}

/* The Schwab-link expiry note for a given expiry (unix sec) and now, or null to show nothing.
   Silent when comfortably ahead; a neutral note within LINK_WARN_SEC; amber within
   LINK_URGENT_SEC or already lapsed. Read-only copy - it points at the CLI relink. */
function linkNote(expiresAt: number | undefined, nowSec: number): { text: string; urgent: boolean } | null {
   if (typeof expiresAt !== "number") return null;
   const rem = expiresAt - nowSec;
   if (rem > LINK_WARN_SEC) return null; // comfortably ahead: stay quiet
   if (rem <= 0) return { text: "Reconnect Schwab (link expired)", urgent: true };
   if (rem <= LINK_URGENT_SEC) {
      // round, not ceil: never overstate the runway on a warning meant to prompt a relink.
      const h = Math.max(1, Math.round(rem / 3600));
      return { text: `Reconnect Schwab soon (expires in ${h}h)`, urgent: true };
   }
   const d = Math.max(1, Math.round(rem / 86400));
   return { text: `Schwab link expires in ${d} day${d === 1 ? "" : "s"}`, urgent: false };
}

/* The four empty states, distinct copy each. */
function emptyStateText(p: StockPortfolio | null, subscribed: boolean, lastFrameAt: number): string {
   if (p) {
      switch (p.status) {
         case "token_expired":
            return "Schwab link expired — re-link with `dawn-admin schwab auth` (clears on its own once relinked).";
         case "not_connected":
            return "No brokerage linked in DAWN.";
         case "rate_limited":
         case "error":
            return "Portfolio temporarily unavailable.";
         default:
            return "Loading…";
      }
   }
   if (subscribed && lastFrameAt > 0 && performance.now() - lastFrameAt > UNAVAILABLE_MS) {
      return "Portfolio feed not available on this DAWN.";
   }
   return subscribed ? "Loading…" : "Portfolio hidden.";
}
