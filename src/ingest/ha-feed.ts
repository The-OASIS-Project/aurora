/* The Home Assistant board's feed: the entity snapshot (a poll, merged with DAWN's realtime
   ha_state_changed deltas), the board's status, its 30 s backstop poll, and the widget controls. */

import type { HAEntity, HAServiceCall, IngestSinks, SpikeNotice } from "./ingest.ts";
import { toHAEntity } from "./feeds-wire.ts";
import { str } from "./wire.ts";

/* The views it drives. */
type Sinks = Pick<IngestSinks, "ha">;

export class HAFeed {
   private haTimer = 0; // polls ha_refresh_entities as the backstop under the realtime push
   /* The merged HA entity snapshot, keyed by entity_id. A poll replaces it wholesale; the
      realtime ha_state_changed push (§9.4 #3) merges its delta into this same map and
      re-emits. Keeping the map (vs. re-emitting the raw array) is what makes that a
      drop-in - a single-entity delta updates one row without a full re-poll. */
   private readonly haEntities = new Map<string, HAEntity>();

   constructor(
      private readonly send: (msg: object) => boolean,
      private readonly getSinks: () => Sinks,
      private readonly spikeNotice: SpikeNotice
   ) {}

   private get sinks(): Sinks {
      return this.getSinks();
   }

   /* As the socket opens. */
   linkUp(): void {
      /* Home Assistant: a read-only status board. There is no push feed yet (SAGE
         item #3), so poll. ha_status reports configured/connected for the header;
         ha_list_entities fills from DAWN's <=5min cache immediately; then a slow
         ha_refresh_entities interval forces a live refetch (bypassing that cache)
         so state stays current. All reads, admin-gated server-side. */
      this.send({ type: "ha_status" });
      this.send({ type: "ha_list_entities" });
      window.clearInterval(this.haTimer);
      this.haTimer = window.setInterval(() => this.send({ type: "ha_refresh_entities" }), 30000);
   }

   /* Its frames (the core lists them in its switch). */
   onFrame(type: string, p: Record<string, unknown>): void {
      switch (type) {
         case "ha_status_response":
            /* Configured/connected for the board header. Absent fields => false. */
            this.sinks.ha.setStatus({
               configured: p.configured === true,
               connected: p.connected === true,
               error: typeof p.error === "string" ? p.error : undefined
            });
            break;

         case "ha_entities_response": {
            /* Both ha_list_entities and ha_refresh_entities land here. success:false
               means HA is unreachable (NOT an empty house) - surface offline and keep
               the last snapshot on screen. On success, rebuild the merged map and emit
               the whole set; a future single-entity push merges into this same map. */
            if (p.success === false) {
               this.sinks.ha.setStatus({
                  configured: true,
                  connected: false,
                  error: typeof p.error === "string" ? p.error : undefined
               });
               break;
            }
            const ents = (p.entities ?? []) as Array<Record<string, unknown>>;
            this.haEntities.clear();
            for (const e of ents) {
               const ent = toHAEntity(e);
               if (ent.entityId) this.haEntities.set(ent.entityId, ent);
            }
            this.sinks.ha.setStatus({ configured: true, connected: true });
            this.sinks.ha.setEntities([...this.haEntities.values()]);
            break;
         }

         case "ha_call_service_response": {
            /* Ack for a widget control (§9.4 #8). Success is silent: the server has
               already re-polled HA and will broadcast a fresh ha_entities_response, which
               reconciles the board (the optimistic flip only bridged the round-trip). A
               failure gets no broadcast, so revert the optimistic flip with a live re-poll
               and surface why (allowlist reject, HA offline, HA-side error). */
            if (p.success === false) {
               const err =
                  typeof p.error === "string" && p.error
                     ? p.error
                     : "Home Assistant control failed";
               console.warn("[dawn] ha_call_service failed:", p.entity_id, err);
               this.refreshHA();
               this.spikeNotice("ha-notice", "home", err, {
                  tone: "attention",
                  hold: 7
               });
            }
            break;
         }

         case "ha_state_changed": {
            /* Realtime delta (§9.4 #3): an unsolicited, coalesced (~200ms) push of the
               entities that just changed - from ANY source (a control action, a physical
               switch, an HA automation), so one frame can carry many entities (a scene
               flip). Batch-merge the whole array into the retained map by entity_id -
               each element is either a full entity (toHAEntity handles it) or a
               {entity_id, removed:true} tombstone - then re-emit the full set so the board
               diff-spikes just the changed rows. The 30s poll stays as the backstop, so a
               client that misses or ignores this frame still self-heals. HA strings are
               bound via textContent downstream (they now arrive without an admin gesture). */
            const ents = (p.entities ?? []) as Array<Record<string, unknown>>;
            let touched = false;
            for (const e of ents) {
               const id = str(e.entity_id);
               if (!id) continue;
               if (e.removed === true) this.haEntities.delete(id);
               else this.haEntities.set(id, toHAEntity(e));
               touched = true;
            }
            if (touched) this.sinks.ha.setEntities([...this.haEntities.values()]);
            break;
         }
      }
   }

   /* Force a live HA re-poll now (the board's manual refresh). ha_refresh_entities
      bypasses DAWN's 5-min cache and returns the fresh list; a read, not a mutation. */
   refreshHA(): void {
      this.send({ type: "ha_refresh_entities" });
   }

   /* HA widget control (signal-map §9.4 #8): the board's write path, a deliberate
      user-initiated action (like music transport), not ambient control. `data` is passed
      VERBATIM to HA - the panel already uses HA's own keys (brightness/percentage/
      position/hvac_mode/temperature). The server allowlists the (domain, service) pairs
      the board can invoke; anything else comes back "Service not permitted".

      On SUCCESS the server re-polls HA and broadcasts a fresh ha_entities_response on its
      own, so the board reconciles without us re-polling; the optimistic flip just bridges
      the round-trip. On FAILURE nothing is broadcast, so ha_call_service_response drives
      the revert + surfaces the error (see the handler). */
   haControl(call: HAServiceCall): void {
      this.send({
         type: "ha_call_service",
         payload: {
            entity_id: call.entityId,
            domain: call.domain,
            service: call.service,
            ...(call.data ? { data: call.data } : {})
         }
      });
   }

   /* The socket closed, or this DAWN has no Home Assistant. */
   stopPolling(): void {
      window.clearInterval(this.haTimer);
   }
}
