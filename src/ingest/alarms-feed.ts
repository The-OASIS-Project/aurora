/* Alarms, timers and reminders (DAWN's scheduler): one card per event, the ringing alarms that
   loop the client tone until they are snoozed or dismissed, and the scheduler_action those
   buttons send. The chime itself is shared (the phone ring, the mail chime), so it's passed in. */

import type { IngestSinks, SpikeNotice } from "./ingest.ts";
import type { AlarmChime } from "../audio/alarm-chime.ts";
import { str } from "./wire.ts";

/* The view it drives. */
type Sinks = Pick<IngestSinks, "notifications">;

export class AlarmsFeed {
   /* Event ids of currently-ringing ALARMS (not reminders/timers, which DAWN auto-dismisses).
      Drives the scheduler_action{dismiss} on user close and the shared ringing-tone loop
      (loop runs while the set is non-empty). Keyed per event so concurrent alarms + a
      reminder don't clobber each other's cards (each notice is `scheduler-<eventId>`). */
   private readonly ringingAlarms = new Set<number>();

   constructor(
      private readonly send: (msg: object) => boolean,
      private readonly getSinks: () => Sinks,
      private readonly spikeNotice: SpikeNotice,
      private readonly alarmChime: AlarmChime
   ) {}

   private get sinks(): Sinks {
      return this.getSinks();
   }

   /* The socket closed (or a deliberate disconnect). */
   linkDown(): void {
      this.alarmChime.stopLoop();
      this.ringingAlarms.clear();
   }

   /* scheduler_notification (the core lists it in its switch). */
   onFrame(type: string, p: Record<string, unknown>): void {
      switch (type) {
         case "scheduler_notification": {
            /* Alarms/timers/reminders. One movable card per event (`scheduler-<id>`) so
               concurrent events don't clobber each other. Behaviour mirrors DAWN's own WebUI
               (www/js/ui/scheduler.js): a client chime on every live notification (skipped
               for a `missed` replay); a ringing ALARM additionally loops a tone + is tracked
               for the dismiss->scheduler_action path. Reminders/timers auto-dismiss server-
               side after their chime, so they are NOT tracked and their auto-dismiss frame is
               ignored below (else the card would flash and vanish before it can be read). */
            const status = str(p.status);
            const message = str(p.message);
            const eventType = str(p.event_type, "alarm");
            const eventId = Number(p.event_id ?? 0);
            const missed = p.missed === true;
            const noticeId = `scheduler-${eventId}`;
            /* A morning briefing (event_type "briefing") creates a persistent conversation and
               carries its id here, so its card is click-to-open. Other scheduler events (alarms/
               timers/reminders) omit it -> a non-clickable card. Feature-detected: an older
               daemon or a briefing whose conversation failed to create won't carry it. */
            const convId = Number(p.conversation_id ?? 0);
            const wasRinging = this.ringingAlarms.has(eventId);
            if (status === "ringing" || status === "fired") {
               /* A live ringing alarm is `critical` so the notification layer's persist-cap
                  can't silently evict its card - that would leave the loop beeping with no
                  on-screen control. Reminders/timers and missed replays are ordinary. */
               const ringingAlarm = eventType === "alarm" && status === "ringing" && !missed;
               this.spikeNotice(noticeId, eventType, str(p.name, "Alarm"), {
                  tone: "attention",
                  hold: 10,
                  detail: message,
                  persist: true, // stays readable until dismissed or docked (WebUI parity)
                  critical: ringingAlarm,
                  /* A ringing alarm gets Snooze (with a duration dropdown, default 10 = DAWN's
                     default_snooze_minutes) + Dismiss; both silence the tone. Reminders/timers
                     keep the plain close (nothing to stop). */
                  actions: ringingAlarm
                     ? [
                          {
                             id: "snooze",
                             label: "Snooze",
                             options: [
                                { value: "1", label: "1 min" },
                                { value: "5", label: "5 min" },
                                { value: "10", label: "10 min" },
                                { value: "30", label: "30 min" }
                             ],
                             defaultValue: "10"
                          },
                          { id: "dismiss", label: "Dismiss" }
                       ]
                     : undefined,
                  open: convId > 0 ? { kind: "conversation", id: convId } : undefined,
                  /* A live (non-missed) fire wakes the standby screensaver (peek): alarms,
                     timers, reminders, and briefings. A `missed` reconnect replay does not. */
                  urgent: !missed
               });
               /* A live ringing alarm's sound IS the looping tone (started below) - no separate
                  one-shot, which would double over the loop's first beat. A non-alarm live
                  notification gets the one ascending chime (skip a missed replay). Only a live
                  ringing alarm drives the loop AND is tracked for the dismiss->scheduler_action
                  path; a missed replay is neither, so it leaves no phantom set entry that would
                  keep the loop beeping. */
               if (ringingAlarm) {
                  this.ringingAlarms.add(eventId);
                  this.alarmChime.startLoop(); // idempotent on a re-broadcast
               } else if (!missed && !wasRinging) {
                  this.alarmChime.playChime();
               }
            } else {
               /* Non-ringing (dismissed/cancelled/snoozed/timed_out). A ringing alarm's loop
                  stops on ANY non-ringing status. Then: IGNORE a server AUTO-dismiss/timeout
                  (both it and a user dismiss carry status "dismissed", so key on the message
                  prefix / "timed_out" like WebUI, NOT the status) so it can't wipe the card;
                  a real user/other-client dismiss removes it. */
               if (this.ringingAlarms.delete(eventId) && this.ringingAlarms.size === 0) {
                  this.alarmChime.stopLoop();
               }
               const isAuto = status === "timed_out" || message.startsWith("Auto-");
               if (!isAuto) this.sinks.notifications.remove(noticeId);
            }
            break;
         }
      }
   }

   /* A dismissed notice. For a ringing ALARM (`scheduler-<id>`), stop the local ringing loop
      and tell DAWN to actually silence it (scheduler_action{dismiss}). Reminders/timers are
      not tracked (DAWN already auto-dismissed them server-side), so their close is local-only.
      Other notices are cleared locally by the layer. */
   dismiss(id: string): void {
      if (!id.startsWith("scheduler-")) return;
      const eventId = Number(id.slice("scheduler-".length));
      if (this.ringingAlarms.delete(eventId)) {
         if (this.ringingAlarms.size === 0) this.alarmChime.stopLoop();
         this.send({ type: "scheduler_action", payload: { action: "dismiss", event_id: eventId } });
      }
   }

   /* A ringing alarm's Snooze or Dismiss button (the core routes its other notices first). */
   noticeAction(id: string, action: string, value?: string): void {
      if (!id.startsWith("scheduler-")) return;
      if (action !== "snooze" && action !== "dismiss") return;
      const eventId = Number(id.slice("scheduler-".length));
      if (!this.ringingAlarms.delete(eventId)) return;
      if (this.ringingAlarms.size === 0) this.alarmChime.stopLoop();
      const payload: Record<string, unknown> = { action, event_id: eventId };
      /* Snooze duration from the dropdown (DAWN accepts 1-120; omit to use its default). */
      if (action === "snooze" && value) {
         const mins = Number(value);
         if (Number.isFinite(mins) && mins >= 1 && mins <= 120)
            payload.snooze_minutes = Math.round(mins);
      }
      this.send({ type: "scheduler_action", payload });
   }

   /* Whether an alarm is ringing (the screensaver's don't-sleep guard). */
   isRinging(): boolean {
      return this.ringingAlarms.size > 0;
   }
}
