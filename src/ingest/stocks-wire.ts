/* DAWN's stocks frames -> the Stocks and Watchlist panels' types. */

import type {
   StockAccount,
   StockAssetType,
   StockExt,
   StockMarket,
   StockPortfolio,
   StockPosition,
   StockSnapshot,
   StockStatus,
   StockWatchlist,
   StockWatchSymbol
} from "./ingest.ts";
import { str } from "./wire.ts";

/* --- stocks_portfolio_update mapping. Every union is passed through an allowlist BEFORE it can
   become a class name downstream, and every number is finite-guarded (an absent field on a
   state-only frame must never coerce to NaN). --- */
const STOCK_STATUSES = new Set<StockStatus>([
   "ok",
   "not_connected",
   "rate_limited",
   "token_expired",
   "error"
]);
const STOCK_MARKETS = new Set<StockMarket>(["regular", "pre", "post", "closed"]);
const STOCK_ASSET_TYPES = new Set<StockAssetType>([
   "equity",
   "etf",
   "option",
   "mutual_fund",
   "cash_equivalent",
   "other"
]);

function asStockStatus(v: unknown): StockStatus {
   return typeof v === "string" && STOCK_STATUSES.has(v as StockStatus)
      ? (v as StockStatus)
      : "error";
}
function asStockMarket(v: unknown): StockMarket {
   return typeof v === "string" && STOCK_MARKETS.has(v as StockMarket)
      ? (v as StockMarket)
      : "closed";
}
function asStockAssetType(v: unknown): StockAssetType {
   return typeof v === "string" && STOCK_ASSET_TYPES.has(v as StockAssetType)
      ? (v as StockAssetType)
      : "other";
}
/* Finite number or 0 - only ever applied to fields inside a real snapshot. */
function finNum(v: unknown): number {
   return typeof v === "number" && isFinite(v) ? v : 0;
}

/* The optional ext-hours overlay: present only when the row carries a real extended price. A finite
   `price` gates it (change/change_pct default to 0); absent/malformed -> undefined (render as today). */
function toStockExt(v: unknown): StockExt | undefined {
   if (!v || typeof v !== "object") return undefined;
   const o = v as Record<string, unknown>;
   if (typeof o.price !== "number" || !isFinite(o.price)) return undefined;
   return { price: o.price, change: finNum(o.change), changePct: finNum(o.change_pct) };
}

/* Optional instrument name: trimmed, length-capped, undefined when absent/empty (an older
   daemon omits it -> no tooltip). Untrusted wire text; the view binds it via the DOM `title`
   property (a plain string set, not an HTML sink). */
function stockDesc(v: unknown): string | undefined {
   if (typeof v !== "string") return undefined;
   const s = v.trim();
   return s ? s.slice(0, 120) : undefined;
}

function toStockPosition(r: Record<string, unknown>): StockPosition {
   return {
      symbol: str(r.symbol),
      description: stockDesc(r.description),
      assetType: asStockAssetType(r.asset_type),
      qty: finNum(r.qty),
      price: finNum(r.price),
      value: finNum(r.value),
      unrealizedPl: finNum(r.unrealized_pl),
      unrealizedPlPct: finNum(r.unrealized_pl_pct),
      dayChange: finNum(r.day_change),
      dayChangePct: finNum(r.day_change_pct),
      ext: toStockExt(r.ext)
   };
}
function toStockAccount(a: Record<string, unknown>): StockAccount {
   const positions = a.positions;
   return {
      label: str(a.label),
      value: finNum(a.value),
      cash: finNum(a.cash),
      dayChange: finNum(a.day_change),
      unrealizedPl: finNum(a.unrealized_pl),
      unrealizedPlPct: finNum(a.unrealized_pl_pct),
      positions: Array.isArray(positions)
         ? positions.map((r) => toStockPosition(r as Record<string, unknown>))
         : []
   };
}
/* A state-only frame (token_expired / cold not_connected) carries no as_of + no accounts, so
   `snapshot` is undefined and the view shows the matching empty state instead of $NaN. A
   transient error replays the last-known numbers, so those DO build a snapshot (dimmed by the
   status). */
export function toStockPortfolio(p: Record<string, unknown>): StockPortfolio {
   const hasSnapshot =
      typeof p.as_of === "number" && isFinite(p.as_of) && Array.isArray(p.accounts);
   const snapshot: StockSnapshot | undefined = hasSnapshot
      ? {
           asOf: finNum(p.as_of),
           totalValue: finNum(p.total_value),
           totalDayChange: finNum(p.total_day_change),
           totalDayChangePct: finNum(p.total_day_change_pct),
           totalUnrealizedPl: finNum(p.total_unrealized_pl),
           totalUnrealizedPlPct: finNum(p.total_unrealized_pl_pct),
           accounts: (p.accounts as Array<Record<string, unknown>>).map(toStockAccount)
        }
      : undefined;
   /* link_expires_at: emitted only when > 0 (older daemon omits it). Can be in the past
      (a lapsed link) - kept as-is; the view treats a past/near value as "reconnect now". */
   const linkExpiresAt =
      typeof p.link_expires_at === "number" && isFinite(p.link_expires_at) && p.link_expires_at > 0
         ? p.link_expires_at
         : undefined;
   return {
      status: asStockStatus(p.status),
      market: asStockMarket(p.market),
      extHours: p.ext_hours === true,
      linkExpiresAt,
      snapshot
   };
}

/* --- stocks_watch_update mapping. Quote-only rows (no qty/value): a watched symbol is not
   held. Same allowlist + finite guards as the portfolio mapping. --- */
function toStockWatchSymbol(r: Record<string, unknown>): StockWatchSymbol {
   return {
      symbol: str(r.symbol),
      description: stockDesc(r.description),
      assetType: asStockAssetType(r.asset_type),
      price: finNum(r.price),
      dayChange: finNum(r.day_change),
      dayChangePct: finNum(r.day_change_pct),
      ext: toStockExt(r.ext),
      quotable: typeof r.quotable === "boolean" ? r.quotable : undefined
   };
}
export function toStockWatchlist(p: Record<string, unknown>): StockWatchlist {
   return {
      status: asStockStatus(p.status),
      market: asStockMarket(p.market),
      asOf: typeof p.as_of === "number" && isFinite(p.as_of) ? p.as_of : undefined,
      symbols: Array.isArray(p.symbols)
         ? (p.symbols as Array<Record<string, unknown>>).map(toStockWatchSymbol)
         : []
   };
}

/* stocks_watch_set_response reject reporting (feature-detected: an older daemon omits it).
   Maps a short reason enum to user-facing copy; an unknown reason degrades to a generic line. */
function watchRejectReason(reason: unknown): string {
   switch (reason) {
      case "unknown":
      case "invalid":
         return "not a recognized symbol";
      case "limit":
         return "watchlist full (25 max)";
      case "duplicate":
         return "already watching";
      default:
         return "could not be added";
   }
}
/* Build a single notice for whatever the set rejected, or null if it rejected nothing. Untrusted
   wire strings are length-capped; they reach the DOM only through the notice layer's textContent. */
export function watchRejectMessage(rejected: unknown): string | null {
   if (!Array.isArray(rejected) || rejected.length === 0) return null;
   const parts = rejected
      .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : null))
      .map((r) => {
         if (!r) return null;
         const sym = str(r.symbol)
            .toUpperCase()
            .replace(/[^A-Z0-9.]/g, "")
            .slice(0, 12);
         return sym ? `${sym} (${watchRejectReason(r.reason)})` : null;
      })
      .filter((s): s is string => s !== null);
   return parts.length ? `Couldn't add ${parts.join(", ")}.` : null;
}
