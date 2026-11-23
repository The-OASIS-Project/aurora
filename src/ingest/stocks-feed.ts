/* The Stocks and Watchlist boards' feed (the user's own Schwab portfolio and watchlist): the two
   subscriptions while their panels are shown (re-armed after a reconnect), their pushes, and the
   watchlist's own edits. */

import type { IngestSinks } from "./ingest.ts";
import { toStockPortfolio, toStockWatchlist, watchRejectMessage } from "./stocks-wire.ts";

/* The views it drives. */
type Sinks = Pick<IngestSinks, "stocks" | "watchlist">;

export class StocksFeed {
   private stocksPortfolioWanted = false; // Stocks panel effectively visible -> subscribe to the portfolio push
   private stocksExtHours = false; // the panel's Extended-Hours choice, re-sent on reconnect
   private stocksWatchWanted = false; // Watchlist panel effectively visible -> subscribe to the watch push
   private stocksWatchExtHours = false; // the Watchlist panel's Extended-Hours choice, re-sent on reconnect

   constructor(
      private readonly send: (msg: object) => boolean,
      private readonly getSinks: () => Sinks,
      private readonly notifyUser: (message: string) => void
   ) {}

   private get sinks(): Sinks {
      return this.getSinks();
   }

   /* As the socket opens. */
   linkUp(): void {
      /* Re-arm the portfolio push if the panel still wants it (per-connection, lost on reconnect). Re-subscribing gets
         an immediate fresh snapshot, so a reconnect / standby-wake has no visible lag. */
      if (this.stocksPortfolioWanted) {
         this.send({
            type: "stocks_portfolio_subscribe",
            payload: { ext_hours: this.stocksExtHours }
         });
      }
      /* Same for the watchlist push (its own independent per-connection subscription). */
      if (this.stocksWatchWanted) {
         this.send({
            type: "stocks_watch_subscribe",
            payload: { ext_hours: this.stocksWatchExtHours }
         });
      }
   }

   /* Its frames (the core lists them in its switch). */
   onFrame(type: string, p: Record<string, unknown>): void {
      switch (type) {
         case "stocks_portfolio_update":
            /* Portfolio push (immediate on subscribe, then on cadence, or a one-shot get). */
            this.sinks.stocks.setPortfolio(toStockPortfolio(p));
            break;

         case "stocks_watch_update":
            /* Watchlist push (immediate on subscribe, on cadence, on a set, or a one-shot get). */
            this.sinks.watchlist.setWatchlist(toStockWatchlist(p));
            break;

         /* Acks for the subscribe/unsubscribe verbs - the data arrives as its own frame, so
            these are no-ops. Present so the default arm does not console.debug the payload. */
         case "stocks_portfolio_subscribe_response":
         case "stocks_portfolio_unsubscribe_response":
         case "stocks_watch_subscribe_response":
         case "stocks_watch_unsubscribe_response":
            break;

         case "stocks_watch_set_response": {
            /* Surface any rejected add (typo / unknown symbol / hit the 25 cap) as a notice, so an
               invalid add is not a silent no-op. Feature-detected: no `rejected` => nothing shown. */
            const msg = watchRejectMessage(p.rejected);
            if (msg) this.notifyUser(msg);
            break;
         }
      }
   }

   /* Opt into / out of the portfolio push, gated on the panel's effective visibility (mirror of
      watchReadingsSubscribe). The intent + ext-hours choice are stored so the onopen handler can
      re-subscribe after a reconnect (the subscription is per-connection). `send` no-ops when the
      socket is down; the stored intent survives. A re-subscribe with a new extHours is idempotent
      server-side (it just resets the per-connection flags), so no unsubscribe-first dance. */
   stocksPortfolioSubscribe(enabled: boolean, extHours: boolean): void {
      this.stocksPortfolioWanted = enabled;
      this.stocksExtHours = extHours;
      if (enabled)
         this.send({ type: "stocks_portfolio_subscribe", payload: { ext_hours: extHours } });
      else this.send({ type: "stocks_portfolio_unsubscribe" });
   }
   /* One-shot cached snapshot for the manual refresh button. A read; the server TTL-clamps it. */
   refreshStocks(extHours: boolean): void {
      this.send({ type: "stocks_portfolio_get", payload: { ext_hours: extHours } });
   }

   /* Watchlist: its own subscription, independent of the portfolio's, gated on the Watchlist
      panel's own effective visibility. Re-sent on reconnect if still wanted (see onopen). */
   stocksWatchSubscribe(enabled: boolean, extHours: boolean): void {
      this.stocksWatchWanted = enabled;
      this.stocksWatchExtHours = extHours;
      if (enabled) this.send({ type: "stocks_watch_subscribe", payload: { ext_hours: extHours } });
      else this.send({ type: "stocks_watch_unsubscribe" });
   }
   refreshWatchlist(extHours: boolean): void {
      this.send({ type: "stocks_watch_get", payload: { ext_hours: extHours } });
   }
   /* User-scoped write: the user curating their own watchlist. Delta add/remove; the server
      dedups, clamps, ignores invalid, and answers with a fresh stocks_watch_update. */
   stocksWatchSet(add: string[], remove: string[]): void {
      this.send({ type: "stocks_watch_set", payload: { add, remove } });
   }
}
