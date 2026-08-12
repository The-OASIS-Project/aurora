/*
 * StubIngest: the fake DAWN source (brief S7.4, v1). Implements the same
 * `Ingest` interface the real WebSocket client will, feeding the same four sinks
 * (store, reactor, conversation, telemetry). So swapping in the real client is a
 * one-file change; nothing above ingest can tell the difference.
 *
 * The real client will subscribe to DAWN's { "type", "payload" } frames
 * (dawn/src/webui/webui_broadcasts.c: attention_alert, job_notification,
 * scheduler notifications, message_appended, STAT telemetry, conversation state)
 * and route each to the matching sink. Here we synthesize plausible activity:
 * ambient panel events, reactor state, telemetry, and canned replies.
 */

import type { Ingest, IngestSinks } from "./ingest.ts";
import type { ReactorState } from "../anchor/anchor.ts";
import type { Store } from "../state/store.ts";
import { IMPORTANCE } from "../state/types.ts";

/* Resting summary each ambient element returns to after an event recedes. */
const RESTING: Record<string, string> = {
   calendar: "Standup in 42 min",
   subsystems: "All systems nominal",
   email: "Inbox quiet"
};

const CANNED_REPLIES = [
   "Done. Anything else?",
   "On it. I'll surface the result when it's ready.",
   "Noted. I'll keep an eye on that and let you know if it changes.",
   "Here's what I found. Say the word if you want the detail pinned."
];

/* DEMO ONLY: idle reactor state cycle so all states are visible without typing.
   The real client drives reactor state from DAWN's conversation-state stream. */
const DEMO_STATES: ReactorState[] = [
   "listening",
   "thinking",
   "speaking",
   "idle",
   "error",
   "idle"
];

export class StubIngest implements Ingest {
   private sinks!: IngestSinks;
   private intervals: number[] = [];
   private timeouts: number[] = [];
   private responding = false;
   private engaged = false;
   private demoIdx = 0;

   start(sinks: IngestSinks): void {
      this.sinks = sinks;
      this.seed(sinks.store);
      this.startPanelEvents();
      this.startTelemetry();
      this.startReactorDemo();
   }

   /* User submitted text: DAWN would think, then speak a reply. Here, canned. */
   submit(_text: string): void {
      this.responding = true;
      this.sinks.reactor.setState("thinking");
      this.sinks.conversation.setThinking(true);
      this.timeouts.push(
         window.setTimeout(() => {
            this.sinks.reactor.setState("speaking");
            this.sinks.conversation.showReply(
               CANNED_REPLIES[Math.floor(Math.random() * CANNED_REPLIES.length)]
            );
         }, 900)
      );
      this.timeouts.push(
         window.setTimeout(() => {
            this.sinks.reactor.setState(this.engaged ? "listening" : "idle");
            this.responding = false;
         }, 3600)
      );
   }

   /* No DAWN behind the stub, so a dismiss is purely local (the store removes it). */
   dismiss(_id: string): void {}

   /* No music engine behind the stub. */
   musicControl(_action: string, _params?: Record<string, unknown>): void {}

   /* No Home Assistant behind the stub (the HA board stays "not configured"). */
   refreshHA(): void {}
   haControl(): void {}

   /* --- Conversation picker (fake data so offline dev shows the panel) ------- */
   listConversations(_opts: { limit: number; offset: number }): void {
      const now = Math.floor(Date.now() / 1000);
      const fake = [
         { id: 1, title: "OASIS build notes", updatedAt: now - 120, isPinned: true },
         { id: 2, title: "Weather for the weekend", updatedAt: now - 3600, origin: "voice" },
         { id: 3, title: "Standup follow-ups", updatedAt: now - 90000 },
         { id: 4, title: "Grocery reminder", updatedAt: now - 500000, origin: "messaging:sms" }
      ].map((c) => ({
         id: c.id,
         title: c.title,
         createdAt: c.updatedAt,
         updatedAt: c.updatedAt,
         messageCount: 4 + c.id,
         isArchived: false,
         isPrivate: false,
         isPinned: Boolean((c as { isPinned?: boolean }).isPinned),
         origin: (c as { origin?: string }).origin ?? "webui"
      }));
      this.sinks.conversationList.setList(fake, { total: fake.length, append: false, searching: false });
   }
   searchConversations(_query: string, _content: boolean): void {
      this.sinks.conversationList.setList([], { append: false, searching: true });
   }
   loadConversation(id: number): void {
      this.sinks.conversationList.setActive(id);
   }
   newConversation(): void {
      this.sinks.conversation.clear();
      this.sinks.conversationList.setActive(0);
   }
   renameConversation(_id: number, _title: string): void {}
   deleteConversation(_id: number): void {}
   setPinned(_id: number, _pinned: boolean): void {}

   /* Focus puts DAWN in listening; blur returns to idle unless mid-response. */
   setEngaged(engaged: boolean): void {
      this.engaged = engaged;
      if (engaged) this.sinks.reactor.setState("listening");
      else if (!this.responding) this.sinks.reactor.setState("idle");
   }

   stop(): void {
      this.intervals.forEach((t) => window.clearInterval(t));
      this.timeouts.forEach((t) => window.clearTimeout(t));
      this.intervals = [];
      this.timeouts = [];
   }

   /* No audio graph in the stub, so teardown is just stop(). */
   dispose(): void {
      this.stop();
   }

   /* --- seed + synthetic activity ------------------------------------------ */

   private seed(store: Store): void {
      /* Calendar (persistent primary glance): rests at its ambient summary. */
      store.upsert({
         id: "calendar",
         kind: "calendar",
         summary: RESTING.calendar,
         detail: "10:00  Daily standup\n11:30  Design review",
         restImportance: IMPORTANCE.ambient,
         importance: IMPORTANCE.ambient,
         position: { x: -0.66, y: -0.5 },
         tone: "nominal"
      });
      /* Subsystems (persistent near-invisible heartbeat): earns attention only
         by failing. Rests just at the mid tier so it is present but quiet. */
      store.upsert({
         id: "subsystems",
         kind: "subsystems",
         summary: RESTING.subsystems,
         detail: "asr · llm · tts · mqtt · ha",
         restImportance: 0.85,
         importance: 0.85,
         position: { x: 0.66, y: -0.5 },
         tone: "nominal"
      });
      /* Email (event-driven): near-invisible at rest. */
      store.upsert({
         id: "email",
         kind: "email",
         summary: RESTING.email,
         restImportance: IMPORTANCE.invisible,
         importance: IMPORTANCE.invisible,
         position: { x: 0.66, y: 0.5 },
         tone: "nominal"
      });
      /* Pinned panels dock to the side rails, always present. */
      store.upsert({
         id: "music",
         kind: "music",
         summary: "Neon Meridian",
         detail: "The Midnight · Monsters",
         pinned: true,
         dock: "left",
         dockOrder: 0,
         dockOnly: true,
         progress: 0.36,
         restImportance: IMPORTANCE.ambient,
         importance: IMPORTANCE.ambient,
         position: { x: 0, y: 0 },
         tone: "nominal"
      });
      store.upsert({
         id: "documents",
         kind: "documents",
         summary: "Recent documents",
         detail: "12 indexed · 4 today",
         items: ["OASIS_build_notes.md", "DAWN_architecture.pdf", "q3_roadmap.docx"],
         pinned: true,
         dock: "right",
         dockOrder: 0,
         dockOnly: true,
         restImportance: IMPORTANCE.ambient,
         importance: IMPORTANCE.ambient,
         position: { x: 0, y: 0 },
         tone: "nominal"
      });
   }

   /* Borrow a panel to announce, then hand it back to its resting summary. */
   private announce(
      id: string,
      summary: string,
      detail: string,
      opts: { tone?: "nominal" | "attention"; to?: number; restoreAfter?: number } = {}
   ): void {
      const store = this.sinks.store;
      store.upsert({ id, kind: id, summary, detail });
      store.spike(id, opts.to ?? IMPORTANCE.alert, opts.tone);
      if (opts.restoreAfter) {
         this.timeouts.push(
            window.setTimeout(() => {
               store.upsert({ id, kind: id, summary: RESTING[id] });
               if (opts.tone === "attention") store.spike(id, 0, "nominal");
            }, opts.restoreAfter)
         );
      }
   }

   private startPanelEvents(): void {
      const emailSubjects = [
         "Kris — re: OASIS build",
         "Calendar: invite accepted",
         "Shipment out for delivery",
         "AURA firmware digest"
      ];
      const faults = [
         ["MQTT bridge degraded", "mqtt · reconnecting"],
         ["TTS latency high", "tts · 1.8s"],
         ["Vision model stalled", "mirage · restarting"]
      ];
      let e = 0;
      let f = 0;

      this.intervals.push(
         window.setInterval(() => {
            this.announce("email", emailSubjects[e++ % emailSubjects.length], "1 new · just now", {
               restoreAfter: 9000
            });
         }, 10000)
      );
      this.intervals.push(
         window.setInterval(() => {
            this.announce("calendar", "Standup starting now", "10:00  Daily standup · join", {
               restoreAfter: 9500
            });
         }, 23000)
      );
      this.intervals.push(
         window.setInterval(() => {
            const [summary, detail] = faults[f++ % faults.length];
            this.announce("subsystems", summary, detail, {
               tone: "attention",
               restoreAfter: 10000
            });
         }, 33000)
      );

      /* Music progress advances so the pinned now-playing feels live. */
      let musicProg = 0.36;
      const tracks = [
         ["Neon Meridian", "The Midnight · Monsters"],
         ["Sunset", "The Midnight · Endless Summer"],
         ["Vansire", "Angel Youth · b4"]
      ];
      let track = 0;
      this.intervals.push(
         window.setInterval(() => {
            musicProg += 0.008;
            if (musicProg >= 1) {
               musicProg = 0;
               track = (track + 1) % tracks.length;
               const [title, sub] = tracks[track];
               this.sinks.store.upsert({ id: "music", kind: "music", summary: title, detail: sub });
            }
            this.sinks.store.upsert({ id: "music", kind: "music", progress: musicProg });
         }, 1000)
      );
   }

   /* Telemetry (stands in for DAWN STAT/MQTT). Updated every 4s so the numbers
      do not churn every second and undercut the resting calm. */
   private startTelemetry(): void {
      let uptime = 0;
      const tick = (): void => {
         uptime += 4;
         const lat = 38 + Math.round(Math.sin(uptime * 0.2) * 6 + Math.random() * 4);
         const cpu = 21 + Math.round(Math.sin(uptime * 0.1) * 5 + Math.random() * 3);
         const hh = String(Math.floor(uptime / 3600)).padStart(2, "0");
         const mm = String(Math.floor((uptime % 3600) / 60)).padStart(2, "0");
         const ss = String(uptime % 60).padStart(2, "0");
         this.sinks.telemetry.update({
            link: "ONLINE",
            lat: `${lat}ms`,
            cpu: `${cpu}%`,
            up: `${hh}:${mm}:${ss}`
         });
      };
      tick();
      this.intervals.push(window.setInterval(tick, 4000));
   }

   private startReactorDemo(): void {
      this.intervals.push(
         window.setInterval(() => {
            if (this.responding || this.engaged) return;
            this.sinks.reactor.setState(DEMO_STATES[this.demoIdx % DEMO_STATES.length]);
            this.demoIdx++;
         }, 5000)
      );
   }
}
