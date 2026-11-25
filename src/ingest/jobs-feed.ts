/* Background jobs: the active set (queued or running), shown as one sticky card, kept from DAWN's
   snapshot and per-job updates, with a brief notice when one starts or finishes. */

import type { IngestSinks, SpikeNotice } from "./ingest.ts";
import { str } from "./wire.ts";

interface JobRow {
   conversation_id?: number;
   title?: string;
   status?: string;
}

/* The view it drives. */
type Sinks = Pick<IngestSinks, "notifications">;

export class JobsFeed {
   private readonly jobs = new Map<number, { title: string; running: boolean }>();

   constructor(
      private readonly send: (msg: object) => boolean,
      private readonly getSinks: () => Sinks,
      private readonly spikeNotice: SpikeNotice
   ) {}

   private get sinks(): Sinks {
      return this.getSinks();
   }

   /* The job frames (the core lists them in its switch). */
   onFrame(type: string, p: Record<string, unknown>): void {
      switch (type) {
         case "jobs_snapshot": {
            /* The complete active set - replace ours wholesale. */
            this.jobs.clear();
            for (const j of (p.jobs ?? []) as JobRow[]) this.trackJob(j);
            this.renderJobs();
            break;
         }

         case "job_update": {
            /* One job's transition. Track by id, drop on any terminal status. A
               newly-appearing active job also fires a brief toast notice, separate from
               the sticky jobs card (which just reflects the active set). */
            const job = (p.job ?? {}) as JobRow;
            const wasActive = job.conversation_id != null && this.jobs.has(job.conversation_id);
            this.trackJob(job);
            const nowActive = job.conversation_id != null && this.jobs.has(job.conversation_id);
            if (!wasActive && nowActive) {
               this.spikeNotice(
                  "job-notice",
                  "jobs",
                  `Started: ${job.title || "background job"}`,
                  {}
               );
            }
            this.renderJobs();
            break;
         }

         case "jobs_invalidate":
            this.send({ type: "jobs_request" });
            break;

         case "job_notification":
            /* A job finished: spike a transient notice that recedes on its own. */
            this.spikeNotice("job-notice", "jobs", str(p.text, "Background job complete"), {});
            break;
      }
   }

   /* Track a job in the active set. `queued`/`running` are active; everything else
      is terminal, so drop it (set membership, never +/-1, so dup/out-of-order
      frames converge). */
   private trackJob(j: JobRow): void {
      if (j.conversation_id == null) return;
      const running = j.status === "queued" || j.status === "running";
      if (running)
         this.jobs.set(j.conversation_id, {
            title: j.title || "background job",
            running: j.status === "running"
         });
      else this.jobs.delete(j.conversation_id);
   }

   /* Reflect the active set into the jobs card: a sticky, movable status widget listing
      running jobs. It snaps like the instruments (central dead zone, side columns) and,
      being sticky, is always full-presence - never a fading toast. When none are active
      the card leaves the dashboard entirely. */
   private renderJobs(): void {
      const count = this.jobs.size;
      if (count === 0) {
         this.sinks.notifications.remove("jobs");
         return;
      }
      const items = [...this.jobs.values()].map((j) => `${j.running ? "▹" : "·"} ${j.title}`);
      this.sinks.notifications.notify({
         id: "jobs",
         kind: "jobs",
         summary: `${count} active job${count > 1 ? "s" : ""}`,
         items,
         sticky: true
         // defaults to the right region (its old rail side); persists once moved
      });
   }
}
