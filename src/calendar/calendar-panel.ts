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
   for (const c of ["tl", "tr", "bl", "br"]) {
      const corner = document.createElement("span");
      corner.className = `panel-corner ${c}`;
      el.appendChild(corner);
   }

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

   /* Bottom grip: drag it to make the list taller and reveal more events. Excluded
      from the move-drag (see makeMovable ignore) so it resizes instead of relocating. */
   const grip = document.createElement("div");
   grip.className = "calendar-resize";
   grip.setAttribute("aria-hidden", "true");

   el.append(head, list, grip);
   root.appendChild(el);

   /* The user-set resting height of the list (grip drag), or null for the default
      content-sizing (40vh cap). Stored as a CSS custom property (--list-h / --list-cap
      that the stylesheet reads), NOT an inline height — an inline height would beat the
      :hover rule and block hover-expand once the card had ever been resized. */
   let restingH: number | null = null;

   /* Toggle the "overflowing" cue (bottom fade instead of a scrollbar) when the events
      don't fit the resting cap. Compared against that cap (resized height, else 40vh),
      not the live height, so it stays correct even while the card is hover-expanded. */
   const updateOverflow = (): void => {
      const capPx = restingH ?? window.innerHeight * 0.4;
      list.classList.toggle("overflowing", list.scrollHeight > capPx + 1);
   };

   const applyRestingH = (): void => {
      if (restingH != null) {
         list.style.setProperty("--list-h", `${Math.round(restingH)}px`);
         list.style.setProperty("--list-cap", "none");
         el.classList.add("calendar-resized"); // persistently reveals full text (locations wrap)
      } else {
         list.style.removeProperty("--list-h");
         list.style.removeProperty("--list-cap");
         el.classList.remove("calendar-resized");
      }
      updateOverflow();
   };
   const savedListH = Number(localStorage.getItem(LIST_H_KEY));
   if (Number.isFinite(savedListH) && savedListH > 0) {
      restingH = savedListH;
      applyRestingH();
   }

   /* Grip resize: set the resting height between a floor and ~80vh, persisted. Hover
      expansion is suppressed for the duration (calendar-resizing class) so the drag
      adjusts a stable height instead of fighting the hover rule; otherwise, since the
      pointer is over the card, hover pins the list to its content height and it can't
      be dragged smaller than the text. */
   let rStartY = 0;
   let rStartH = 0;
   let resizing = false;
   const onGripMove = (e: PointerEvent): void => {
      if (!resizing) return;
      restingH = Math.max(72, Math.min(window.innerHeight * 0.8, rStartH + (e.clientY - rStartY)));
      applyRestingH();
   };
   const onGripUp = (): void => {
      resizing = false;
      el.classList.remove("calendar-resizing");
      window.removeEventListener("pointermove", onGripMove);
      window.removeEventListener("pointerup", onGripUp);
      if (restingH != null) localStorage.setItem(LIST_H_KEY, String(Math.round(restingH)));
   };
   const onGripDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      e.preventDefault();
      rStartY = e.clientY;
      /* Freeze the current on-screen height as the resting size and hold it there
         (suppress hover) so the drag starts from exactly what the user sees. */
      rStartH = list.getBoundingClientRect().height;
      restingH = rStartH;
      el.classList.add("calendar-resizing");
      applyRestingH();
      resizing = true;
      window.addEventListener("pointermove", onGripMove);
      window.addEventListener("pointerup", onGripUp);
   };
   grip.addEventListener("pointerdown", onGripDown);

   /* Grab-and-move: user-arrangeable like the music player. The whole card is a drag
      handle EXCEPT the resize grip; position is persisted. */
   const disposeMovable = makeMovable(el, {
      storageKey: "dawn.hero.calendarPos",
      ignore: ".calendar-resize"
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
         updateOverflow();
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
      updateOverflow();
   };
   render();

   /* The collapsed cap is 40vh, so a viewport resize can change whether the list
      overflows; keep the fade cue in sync. */
   window.addEventListener("resize", updateOverflow);

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
         tz = zone || "";
         render();
      },
      isVisible: () => visible,
      setVisible: (on) => {
         visible = on;
         localStorage.setItem(VISIBLE_KEY, on ? "true" : "false");
         applyVisible();
      },
      destroy: () => {
         grip.removeEventListener("pointerdown", onGripDown);
         window.removeEventListener("pointermove", onGripMove);
         window.removeEventListener("pointerup", onGripUp);
         window.removeEventListener("resize", updateOverflow);
         disposeMovable();
         el.remove();
      }
   };
   return controller;
}
