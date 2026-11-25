/* SAGE's proactive attention: an alert (needs you) or ambient FYI, and the quieter silent
   observations, each shown as a notice keyed by its text so distinct ones stack and a repeat
   coalesces. Holds no state. */

import type { SpikeNotice } from "./ingest.ts";
import { str } from "./wire.ts";

export class AttentionFeed {
   constructor(private readonly spikeNotice: SpikeNotice) {}

   /* attention_alert and silent_observation (the core lists them in its switch). */
   onFrame(type: string, p: Record<string, unknown>): void {
      switch (type) {
         case "attention_alert": {
            /* SAGE proactive attention - the signature ambient spike. level=alert
               needs the user (warm + claims the front); level=ambient is an FYI. */
            const alert = str(p.level, "ambient") === "alert";
            const summary = str(p.summary);
            /* Key the notice by its text: distinct alerts get distinct cards (two watches firing
               close together stack instead of one overwriting the other), while an identical
               re-fire coalesces onto the same card and re-spikes - so one flapping watch can't
               crowd the rest out. Content-stable, so it also survives a reload without colliding
               with a per-session counter (which would reset and inherit stale saved positions). */
            this.spikeNotice(`attention:${summary}`, "attention", summary, {
               tone: alert ? "attention" : "nominal",
               hold: alert ? 9 : 6,
               persist: alert, // a "needs you" alert stays until docked or closed; an FYI fades
               urgent: alert // a needs-you alert peeks the standby screensaver; an ambient FYI does not
               /* Spawn centered, in the reactor's full-height dead strip: docked panels are kept
                  in the left/right columns flanking it, so a centered notice avoids them. */
            });
            break;
         }

         case "silent_observation":
            /* A quieter noticed-something FYI, categorized (calendar/email/…). Keyed by
               category+note so distinct observations stack and identical ones coalesce (see
               attention_alert). */
            {
               const category = str(p.category, "note");
               const note = str(p.note);
               this.spikeNotice(`observation:${category}:${note}`, category, note, {
                  hold: 5
                  /* Centered in the dead strip too (see attention_alert), just lower. */
               });
            }
            break;
      }
   }
}
