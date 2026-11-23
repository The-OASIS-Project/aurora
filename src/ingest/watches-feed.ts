/* The Watches board's feed (SAGE watch rules): the rule list and its 30 s poll, the live 1 Hz
   readings while the panel is shown (re-armed after a reconnect), and the watch writes. */

import type { IngestSinks, SpikeNotice, WatchFields } from "./ingest.ts";
import { toWatchItem, watchFieldsToWire } from "./feeds-wire.ts";
import { str } from "./wire.ts";

/* The views it drives. */
type Sinks = Pick<IngestSinks, "watches">;

export class WatchesFeed {
   private watchTimer = 0; // polls watch_list (no push exists); refreshes the rule structure
   private watchReadingsWanted = false; // Watches panel visible -> subscribe to the 1 Hz gauge stream

   constructor(
      private readonly send: (msg: object) => boolean,
      private readonly getSinks: () => Sinks,
      private readonly spikeNotice: SpikeNotice,
      private readonly isLinkLive: () => boolean,
      private readonly notifyUser: (message: string) => void
   ) {}

   private get sinks(): Sinks {
      return this.getSinks();
   }

   /* As the socket opens. */
   linkUp(): void {
      /* SAGE watches (the Watches panel): the rule list + live readings. Poll-only (no
         push - a watch FIRING arrives as an attention notice), so re-list on a slow
         backstop to refresh the readings. A read; the panel's toggle is the only write. */
      this.send({ type: "watch_list" });
      window.clearInterval(this.watchTimer);
      this.watchTimer = window.setInterval(() => this.send({ type: "watch_list" }), 30000);
      /* Re-arm the live-gauge stream if the panel wanted it before this (re)connect - the
         subscription is per-connection and lost on reconnect. */
      if (this.watchReadingsWanted) {
         this.send({ type: "watch_readings_subscribe", payload: { enabled: true } });
      }
   }

   /* Its frames (the core lists them in its switch). */
   onFrame(type: string, p: Record<string, unknown>): void {
      switch (type) {
         case "watch_list_response": {
            /* The SAGE watch rules + live readings (Watches panel). A FAILED list carries no
               watches/catalog/attention_enabled, so surface a status error and keep the last
               rows rather than rendering an empty list (which would read as "nothing watched").
               Watch strings (label/name/unit/source) are bound via textContent downstream. */
            if ((p as { success?: boolean }).success === false) {
               this.sinks.watches.setStatus({
                  ok: false,
                  attentionEnabled: false,
                  error:
                     typeof (p as { error?: string }).error === "string"
                        ? (p as { error?: string }).error
                        : "Couldn't list watches"
               });
               break;
            }
            const rows = (p.watches ?? []) as Array<Record<string, unknown>>;
            const catalog = ((p.catalog ?? []) as Array<Record<string, unknown>>).map((c) => ({
               key: str(c.key),
               label: str(c.label, str(c.key)),
               unit: str(c.unit),
               ruleType: typeof c.rule_type === "string" ? c.rule_type : undefined,
               defaultDirection:
                  typeof c.default_direction === "string" ? c.default_direction : undefined,
               defaultThreshold:
                  typeof c.default_threshold === "number" ? c.default_threshold : undefined
            }));
            this.sinks.watches.setWatches(rows.map(toWatchItem), catalog);
            this.sinks.watches.setStatus({
               ok: true,
               attentionEnabled: (p as { attention_enabled?: boolean }).attention_enabled === true
            });
            break;
         }

         case "watch_set_enabled_response": {
            /* A benign toggle ack. On failure surface the reason; either way re-list so the
               panel reflects the server-authoritative truth (mirrors the HA reconcile). */
            if ((p as { success?: boolean }).success === false) {
               const err = (p as { error?: string }).error;
               console.warn("[dawn] watch_set_enabled failed:", err);
               this.spikeNotice("watch-toggle", "attention", err || "Couldn't update the watch", {
                  tone: "attention",
                  hold: 6
               });
            }
            this.send({ type: "watch_list" });
            break;
         }

         case "watch_readings": {
            /* The ~1 Hz live-gauge stream (only while subscribed + SAGE attention is on).
               Patch just the volatile values onto the existing rows - no re-list, no spike. */
            const readings = (p.readings ?? []) as Array<Record<string, unknown>>;
            this.sinks.watches.setReadings(
               readings.map((r) => ({
                  id: Number(r.id ?? 0),
                  hasCurrent: r.has_current === true,
                  current: typeof r.current === "number" ? r.current : undefined,
                  breaching: typeof r.breaching === "boolean" ? r.breaching : undefined
               }))
            );
            break;
         }

         case "watch_readings_subscribe_response":
            break; // just an ack; the readings frames are what matter

         case "watch_add_response":
         case "watch_update_response":
         case "watch_remove_response": {
            /* Phase-2 CRUD acks. Surface a failure; re-list either way so the panel reflects
               the server-authoritative truth (add upserts + re-enables, update/remove change
               the row). */
            const r = p as { success?: boolean; error?: string };
            if (r.success === false) {
               console.warn("[dawn] watch mutation failed:", type, r.error);
               this.spikeNotice(
                  "watch-mutate",
                  "attention",
                  r.error || "Couldn't update the watch",
                  {
                     tone: "attention",
                     hold: 6
                  }
               );
            }
            this.send({ type: "watch_list" });
            break;
         }
      }
   }

   /* Re-list the SAGE watches (Watches panel manual refresh / poll). Read-only. */
   requestWatches(): void {
      this.send({ type: "watch_list" });
   }

   /* Toggle one watch on/off. A benign per-watch flip (the sanctioned deliberate-user-action
      class, like set_pinned); the server reconciles via the re-list in watch_set_enabled_response.
      Blocked on a dead link so the panel doesn't flip a state that never took (like haControl). */
   setWatchEnabled(id: number, enabled: boolean): void {
      if (!this.isLinkLive()) {
         this.notifyUser("Not connected to DAWN - change not sent.");
         return;
      }
      this.send({ type: "watch_set_enabled", payload: { id, enabled } });
   }

   /* Opt into / out of the 1 Hz watch_readings gauge stream (driven off panel visibility).
      Track the intent so a reconnect re-subscribes (the subscription is per-connection); the
      onopen handler replays it. `send` is a no-op when the socket is down, which is fine -
      the intent is remembered and re-sent on connect. */
   watchReadingsSubscribe(enabled: boolean): void {
      this.watchReadingsWanted = enabled;
      this.send({ type: "watch_readings_subscribe", payload: { enabled } });
   }

   /* Phase-2 watch CRUD. Per-user proactive rules (deliberate user actions), gated on link
      liveness; each reconciles via the re-list in its *_response handler. `updateWatch` sends
      the full field state (a partial send would reset omitted fields to catalog defaults).
      `removeWatch` is only ever invoked from the panel's confirm-gated gesture. */
   addWatch(metric: string, fields?: WatchFields): void {
      if (!this.isLinkLive()) {
         this.notifyUser("Not connected to DAWN - not sent.");
         return;
      }
      /* CREATES a new watch (add no longer dedups by metric). The create modal supplies the
         name + condition in `fields`; a bare add falls back to the server's catalog defaults. */
      this.send({ type: "watch_add", payload: { metric, ...watchFieldsToWire(fields) } });
   }
   updateWatch(id: number, fields: WatchFields): void {
      if (!this.isLinkLive()) {
         this.notifyUser("Not connected to DAWN - not sent.");
         return;
      }
      this.send({ type: "watch_update", payload: { id, ...watchFieldsToWire(fields) } });
   }
   removeWatch(id: number): void {
      if (!this.isLinkLive()) {
         this.notifyUser("Not connected to DAWN - not sent.");
         return;
      }
      this.send({ type: "watch_remove", payload: { id } });
   }

   /* The socket closed. */
   stopPolling(): void {
      window.clearInterval(this.watchTimer);
   }
}
