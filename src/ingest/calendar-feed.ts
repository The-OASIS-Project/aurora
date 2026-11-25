/* The Calendar card's feed: the calendar map (names, colors) and today's events in the user's
   zone, read on connect, every 15 minutes (which also rolls the day over), and shortly after DAWN
   says a sync changed something. */

import type { CalendarInfo, IngestSinks } from "./ingest.ts";
import { toCalendarEvent } from "./feeds-wire.ts";
import { todayWindow } from "../util/time.ts";
import { str } from "./wire.ts";

/* The view it drives. */
type Sinks = Pick<IngestSinks, "calendar">;

export class CalendarFeed {
   private calendarTimer = 0; // slow refetch of today's events (also handles midnight rollover)
   private calendarDebounce = 0; // debounce a burst of calendar_events_changed pushes

   constructor(
      private readonly send: (msg: object) => boolean,
      private readonly getSinks: () => Sinks,
      private readonly getUserTz: () => string
   ) {}

   private get sinks(): Sinks {
      return this.getSinks();
   }

   /* The user's IANA zone ("" = browser-local until DAWN names one). */
   private get userTz(): string {
      return this.getUserTz();
   }

   /* As the socket opens. */
   linkUp(): void {
      /* Calendar: the id->{name,color} map plus today's occurrences, for the
         calendar card. A slow refetch keeps it live between calendar_events_changed
         pushes and rolls the window over at midnight. Both reads, no writes. */
      this.requestCalendar();
      window.clearInterval(this.calendarTimer);
      this.calendarTimer = window.setInterval(() => this.requestCalendar(), 15 * 60 * 1000);
   }

   /* Its frames (the core lists them in its switch). */
   onFrame(type: string, p: Record<string, unknown>): void {
      switch (type) {
         case "calendar_list_my_calendars_response": {
            /* The id->{name,color} map for the calendar card's color dots. */
            if (p.success === false) break;
            const cals = (p.calendars ?? []) as Array<Record<string, unknown>>;
            const map: CalendarInfo[] = cals.map((c) => ({
               id: Number(c.id ?? 0),
               name: str(c.name),
               color: str(c.color)
            }));
            this.sinks.calendar.setCalendars(map);
            break;
         }

         case "calendar_upcoming_events_response": {
            /* Today's occurrences. success:true with an empty array covers both an
               empty day and a transient read error (same contract as the LLM tool);
               the panel renders "Nothing scheduled" and the next changed-push heals. */
            if (p.success === false) break;
            const evs = (p.events ?? []) as Array<Record<string, unknown>>;
            this.sinks.calendar.setEvents(evs.map(toCalendarEvent), p.truncated === true);
            break;
         }

         case "calendar_events_changed":
            /* A background CalDAV sync changed something. Refetch (debounced, since a
               multi-calendar sync can fire several in a burst). */
            this.scheduleCalendarRefetch();
            break;
      }
   }

   /* Request the calendar map + today's occurrences (both reads). Called on connect,
      on the slow interval, and after a debounced calendar_events_changed. */
   requestCalendar(): void {
      const { start, end } = todayWindow(this.userTz);
      this.send({ type: "calendar_list_my_calendars" });
      this.send({ type: "calendar_upcoming_events", payload: { start, end } });
   }

   /* Coalesce a burst of calendar_events_changed pushes into one refetch. */
   private scheduleCalendarRefetch(): void {
      window.clearTimeout(this.calendarDebounce);
      this.calendarDebounce = window.setTimeout(() => this.requestCalendar(), 500);
   }

   /* The socket closed, or this DAWN has no calendar. */
   stopPolling(): void {
      window.clearInterval(this.calendarTimer);
      window.clearTimeout(this.calendarDebounce);
   }
}
