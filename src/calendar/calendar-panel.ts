/*
 * The calendar panel (brief: a calm "today" agenda, not a full planner). A
 * standalone movable card like the music player: it renders itself in the
 * machined phosphor language, shows the day's occurrences from DAWN's calendar
 * cache, and is grab-to-move with a persisted position. Read-only (no mutation
 * surface); it reflects `calendar_upcoming_events` and refreshes on the ingest's
 * `calendar_events_changed`-driven refetch.
 *
 * Colors: everything is phosphor tokens EXCEPT a small per-event dot, which uses
 * the owning calendar's real CalDAV color so a multi-calendar day reads at a
 * glance. That color is server data, so it is validated as a hex literal before it
 * touches CSS; anything else falls back to the accent token.
 */

import type { CalendarEvent, CalendarInfo, CalendarSink } from "../ingest/ingest.ts";
import { makeMovable } from "../render/movable.ts";
import { makeListCard } from "../render/list-card.ts";
import { addCorners } from "../render/corners.ts";
import { safeTimeZone } from "../util/tz.ts";

export interface CalendarPanelController extends CalendarSink {
   /* User show/hide (Panels menu), independent of whether the day has events. */
   isVisible(): boolean;
   setVisible(on: boolean): void;
   destroy(): void;
}

const VISIBLE_KEY = "dawn.hero.calendarShown";
const LIST_H_KEY = "dawn.hero.calendarListH"; // persisted list max-height (grip resize)
/* CalDAV colors are server strings; only accept a plain hex literal before using
   one as a color, so a malformed/hostile value can never inject into the style. */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/* Format in the user's tz (from DAWN) so times match the clock, not the browser box's
   zone. An empty tz falls back to the browser's local zone. */
function fmtTime(epochSec: number, tz: string): string {
   return new Date(epochSec * 1000).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz || undefined
   });
}

function fmtDay(d: Date, tz: string): string {
   return d.toLocaleDateString([], {
      weekday: "long",
      month: "short",
      day: "numeric",
      timeZone: tz || undefined
   });
}

export function mountCalendarPanel(root: HTMLElement): CalendarPanelController {
   const el = document.createElement("div");
   el.id = "calendar";
   el.className = "calendar";
   addCorners(el);

   const head = document.createElement("div");
   head.className = "calendar-head";
   const titleEl = document.createElement("div");
   titleEl.className = "calendar-title";
   titleEl.textContent = "Today";
   const dateEl = document.createElement("div");
   dateEl.className = "calendar-date";
   head.append(titleEl, dateEl);

   const list = document.createElement("div");
   list.className = "calendar-list";

   el.append(head, list);
   root.appendChild(el);

   /* Sizing / overflow-fade / grip-resize / hover-expand are shared across the movable
      ambient cards (see list-card.ts): it owns the bottom grip and toggles the
      `lcard-resized` class the CSS keys the full-text (wrapped location) reveal off. */
   const card = makeListCard(el, list, { storageKey: LIST_H_KEY });

   /* Grab-and-move: user-arrangeable like the music player. The whole card is a drag
      handle EXCEPT the resize grip; position is persisted. */
   const disposeMovable = makeMovable(el, {
      storageKey: "dawn.hero.calendarPos",
      ignore: ".lcard-grip"
   });

   /* User visibility (Panels menu), persisted. Always shown by default; when shown
      the card stays put even on an empty day ("Nothing scheduled"). */
   let visible = localStorage.getItem(VISIBLE_KEY) !== "false";
   const applyVisible = (): void => {
      el.classList.toggle("calendar-off", !visible);
   };
   applyVisible();

   /* --- state ------------------------------------------------------------- */
   const colors = new Map<number, string>(); // calendarId -> raw CalDAV color
   let events: CalendarEvent[] = [];
   let truncated = false;
   let tz = ""; // user's IANA tz from DAWN; "" => browser-local fallback

   const render = (): void => {
      dateEl.textContent = fmtDay(new Date(), tz);
      list.replaceChildren();

      if (events.length === 0) {
         const empty = document.createElement("div");
         empty.className = "calendar-empty";
         empty.textContent = "Nothing scheduled";
         list.appendChild(empty);
         card.refresh();
         return;
      }

      /* All-day events first, then timed by start. */
      const sorted = [...events].sort((a, b) =>
         a.allDay === b.allDay ? a.start - b.start : a.allDay ? -1 : 1
      );
      sorted.forEach((ev, i) => {
         if (i > 0) {
            const divider = document.createElement("div");
            divider.className = "calendar-divider";
            list.appendChild(divider);
         }
         const row = document.createElement("div");
         row.className = "calendar-event";
         if (ev.cancelled) row.classList.add("cancelled");

         const dot = document.createElement("span");
         dot.className = "calendar-dot";
         const color = colors.get(ev.calendarId);
         if (color && HEX_COLOR.test(color)) dot.style.setProperty("--dot", color);

         const when = document.createElement("span");
         when.className = "calendar-when";
         when.textContent = ev.allDay ? "All day" : fmtTime(ev.start, tz);

         const summary = document.createElement("span");
         summary.className = "calendar-summary";
         summary.textContent = ev.summary || "(untitled)";

         row.append(dot, when, summary);
         if (ev.location) {
            const loc = document.createElement("div");
            loc.className = "calendar-loc";
            /* Split on commas into non-breaking segments so the address wraps AFTER a
               comma ("... Forsyth 12," / "350 Peachtree Pkwy," / ...) rather than mid
               phrase. The comma stays with its segment; the space between segments is
               the only break opportunity. */
            const parts = ev.location.split(",").map((s) => s.trim()).filter(Boolean);
            parts.forEach((part, i) => {
               const seg = document.createElement("span");
               seg.className = "calendar-loc-seg";
               seg.textContent = i < parts.length - 1 ? `${part},` : part;
               loc.appendChild(seg);
               if (i < parts.length - 1) loc.appendChild(document.createTextNode(" "));
            });
            row.appendChild(loc);
         }
         list.appendChild(row);
      });

      if (truncated) {
         const more = document.createElement("div");
         more.className = "calendar-more";
         more.textContent = "More events not shown";
         list.appendChild(more);
      }
      card.refresh();
   };
   render();

   const controller: CalendarPanelController = {
      setCalendars: (calendars: CalendarInfo[]) => {
         colors.clear();
         for (const c of calendars) colors.set(c.id, c.color);
         render();
      },
      setEvents: (evs, trunc) => {
         events = evs;
         truncated = trunc;
         render();
      },
      setTimezone: (zone) => {
         /* Validate before use: an invalid IANA zone makes toLocaleString throw, which
            would break the render. safeTimeZone falls back to browser-local ("" here). */
         tz = safeTimeZone(zone) ?? "";
         render();
      },
      isVisible: () => visible,
      setVisible: (on) => {
         visible = on;
         localStorage.setItem(VISIBLE_KEY, on ? "true" : "false");
         applyVisible();
      },
      destroy: () => {
         card.destroy();
         disposeMovable();
         el.remove();
      }
   };
   return controller;
}
