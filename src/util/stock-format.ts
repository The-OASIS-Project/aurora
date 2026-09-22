/*
 * Shared, pure formatters for the Schwab-backed panels (Stocks portfolio + Watchlist). Kept
 * panel-agnostic (typed on the DTO unions, no DOM), so both siblings render symbols, quotes,
 * and direction identically. Redaction (maskFigure), share qty (fmtQty), and the portfolio's
 * staleness rule stay panel-local - they are not shared concerns.
 */

import type { StockAssetType, StockMarket } from "../ingest/ingest.ts";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const usdSigned = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", signDisplay: "exceptZero" });

export function fmtUsd(n: number): string {
   return usd.format(n);
}
export function fmtSignedUsd(n: number): string {
   return usdSigned.format(n);
}
export function fmtPct(n: number): string {
   return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

/* Direction is ALWAYS carried by a glyph too, never color alone (colorblind + redacted safe). */
export function dirGlyph(n: number): string {
   return n > 0 ? "▲" : n < 0 ? "▼" : "–"; // ▲ ▼ –
}
export function dirClass(n: number): string {
   return n > 0 ? "stk-gain" : n < 0 ? "stk-loss" : "stk-flat";
}

/* An OCC option symbol ("AAPL  260116C00250000") is 21 chars with embedded spaces - compact it
   for display only (the full string is kept for identity). Non-option symbols pass through. */
export function compactSymbol(sym: string, isOption: boolean): string {
   if (!isOption) return sym;
   const m = /^\s*([A-Z.]+)\s+(\d{2})(\d{2})(\d{2})([CP])(\d{8})\s*$/.exec(sym);
   if (!m) return sym.replace(/\s+/g, " ").trim();
   const [, root, yy, mm, dd, cp, strike8] = m;
   const strike = (parseInt(strike8, 10) / 1000).toString();
   return `${root} ${parseInt(mm, 10)}/${parseInt(dd, 10)}/${yy} ${cp}${strike}`;
}

/* Session label for the ext-hours overlay: pre-market -> "PRE", post-market -> "AH" (after-hours).
   The overlay only appears in an ext window, so "EXT" is just a defensive fallback. */
export function extSessionLabel(market: StockMarket): string {
   return market === "pre" ? "PRE" : market === "post" ? "AH" : "EXT";
}

/* Short asset-type badge next to the symbol. */
export function assetBadge(t: StockAssetType): string {
   switch (t) {
      case "equity":
         return "EQ";
      case "etf":
         return "ETF";
      case "option":
         return "OPT";
      case "mutual_fund":
         return "FUND";
      case "cash_equivalent":
         return "CASH";
      default:
         return "—";
   }
}

/* The full asset-type name, for the badge's hover tooltip (native `title`). */
export function assetLabel(t: StockAssetType): string {
   switch (t) {
      case "equity":
         return "Equity";
      case "etf":
         return "Exchange-traded fund";
      case "option":
         return "Option";
      case "mutual_fund":
         return "Mutual fund";
      case "cash_equivalent":
         return "Cash equivalent";
      default:
         return "Other";
   }
}
