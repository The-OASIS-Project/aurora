/*
 * The Home Assistant board: an interactive "state of the house" in the machined
 * phosphor language of the calendar and music player. It renders DAWN's HA entity
 * snapshot grouped by room, active states lit and idle ones dimmed so what's happening
 * pops and the quiet stuff recedes, and lets the user act on it through inline widgets
 * (toggles for on/off things, a slider for brightness/position, a dropdown for climate
 * modes). The header is the drag handle; the body is interactive.
 *
 * Control is a deliberate, user-initiated Tier-C write (like music transport), not
 * ambient control - it fits the read-mostly charter's carve-out for explicit actions.
 * The write path (ha_call_service, signal-map §9.4 #8) is live: a widget flips
 * optimistically for snap, and the server re-polls HA and broadcasts a fresh entity set
 * that reconciles the board (a failed call re-polls to revert and surfaces the error).
 *
 * The ingest hands over the whole entity set each update and this view diffs it to briefly
 * emphasise a changed row (spike-then-recede). Updates arrive in real time from DAWN's
 * ha_state_changed push (merged by entity_id in the ingest), with a 30s poll retained as a
 * backstop; the diff makes a single-entity delta light just that row.
 *
 * Everything is phosphor tokens; there is no per-entity color from DAWN (unlike the
 * calendar's CalDAV colors), so emphasis is carried by the active/idle tone.
 */

import type { HAAttributes, HAEntity, HAServiceCall, HAStatus, HASink } from "../ingest/ingest.ts";
import { makeMovable } from "../render/movable.ts";
import { makeListCard } from "../render/list-card.ts";
import { addCorners } from "../render/corners.ts";
import { makeVisibility } from "../render/visibility.ts";

export interface HAPanelController extends HASink {
   /* User show/hide (Panels menu), independent of whether HA has any entities. */
   isVisible(): boolean;
   setVisible(on: boolean): void;
   destroy(): void;
}

export interface HAPanelOpts {
   /* Ask the ingest to force a live re-poll now (the manual refresh affordance). */
   onRefresh(): void;
   /* A widget control intent (toggle/slider/dropdown). Sent live to DAWN's
      ha_call_service; the board reconciles from the server's follow-up entity broadcast. */
   onControl(call: HAServiceCall): void;
   /* Is the DAWN link confirmed usable right now? When it isn't, a control is neither sent
      nor optimistically flipped (a flip would lie), and `notify` surfaces why. Optional so
      the board still works if a host doesn't wire liveness (treated as always-live). */
   isLive?(): boolean;
   /* Surface a transient user-facing notice (e.g. "control not sent"). */
   notify?(message: string): void;
}

/* Domains rendered as a simple on/off toggle (state is "on"/"off"). */
const TOGGLE_DOMAINS = new Set(["light", "switch", "fan", "input_boolean"]);
/* Fallback climate modes when DAWN hasn't sent the entity's `hvac_modes` list yet. */
const DEFAULT_HVAC_MODES = ["off", "heat", "cool", "auto"];

/* What control a given entity's row shows. `toggle` for on/off things, `select` for
   enumerated modes, `display` for read-only readouts. An optional `slider` (brightness
   / position / percentage) rides on a second line when the attribute is present. */
type Control =
   | { kind: "toggle"; on: boolean; onSet: (on: boolean) => void }
   | { kind: "select"; value: string; options: string[]; onSet: (v: string) => void }
   | { kind: "display"; text: string };
interface Slider {
   value: number;
   min: number;
   max: number;
   suffix: string;
   onSet: (v: number) => void;
}

const VISIBLE_KEY = "dawn.hero.haShown";
const LIST_H_KEY = "dawn.hero.haListH"; // persisted list height (grip resize)
const COLLAPSED_KEY = "dawn.hero.haCollapsed"; // rooms the user has folded shut (per machine)

/* "At rest" states: on/open/unlocked/home/playing (and a bare sensor value) read as
   ACTIVE and get a filled, lit dot + a place in the header's active count; everything
   listed here is at rest and gets a hollow dot. This drives the dot and the count ONLY,
   not legibility: an off light is a perfectly known state (the toggle already shows it),
   so it stays as legible as an on one. Compared case-insensitively; a pragmatic heuristic
   (DAWN sends no device_class), refine per-domain later if it proves too loud. */
const RESTING_STATES = new Set([
   "off",
   "closed",
   "locked",
   "unavailable",
   "unknown",
   "idle",
   "standby",
   "none",
   "not_home",
   "away",
   "disarmed",
   "paused",
   "0",
   "false"
]);
const isActive = (state: string): boolean => !RESTING_STATES.has(state.trim().toLowerCase());

/* Offline: the entity is unreachable or its state is undetermined, so its real state is
   genuinely unknown. This - and only this - dims a row (recedes it), because there is no
   trustworthy state to show. `unavailable` = HA can't reach the device; `unknown`/empty =
   no state reported yet. An "off" device is online and known, so it does NOT dim. */
const OFFLINE_STATES = new Set(["unavailable", "unknown"]);
const isOffline = (state: string): boolean => {
   const s = state.trim().toLowerCase();
   return s === "" || OFFLINE_STATES.has(s);
};

/* Raw HA state string -> something readable: "not_home" -> "Not home". Numeric and
   already-clean states pass through with just a capitalised first letter. */
function humanizeState(state: string): string {
   const s = state.trim();
   if (!s) return "-";
   const spaced = s.replace(/_/g, " ");
   return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function mountHAPanel(root: HTMLElement, opts: HAPanelOpts): HAPanelController {
   const el = document.createElement("div");
   el.id = "homeassistant";
   el.className = "ha";
   addCorners(el);

   const head = document.createElement("div");
   head.className = "ha-head";
   const titleEl = document.createElement("div");
   titleEl.className = "ha-title";
   titleEl.textContent = "Home Assistant";
   const statusEl = document.createElement("div");
   statusEl.className = "ha-status";
   const refreshBtn = document.createElement("button");
   refreshBtn.type = "button";
   refreshBtn.className = "ha-refresh";
   refreshBtn.setAttribute("aria-label", "Refresh Home Assistant now");
   refreshBtn.textContent = "↻"; // clockwise open circle arrow
   head.append(titleEl, statusEl, refreshBtn);

   const list = document.createElement("div");
   list.className = "ha-list";

   el.append(head, list);
   root.appendChild(el);

   /* Manual refresh: force a live re-poll and spin the glyph briefly for feedback. */
   const onRefreshClick = (e: MouseEvent): void => {
      e.stopPropagation(); // don't let the click begin a card drag
      opts.onRefresh();
      refreshBtn.classList.remove("spin");
      void refreshBtn.offsetWidth; // restart the animation
      refreshBtn.classList.add("spin");
   };
   refreshBtn.addEventListener("click", onRefreshClick);

   /* Sizing / overflow-fade / grip-resize / hover-expand are shared across the movable
      ambient cards (see list-card.ts); it owns the bottom grip. */
   const card = makeListCard(el, list, { storageKey: LIST_H_KEY });

   /* Grab-and-move: only the HEADER drags (the body is interactive), and the refresh
      button inside it doesn't. Position persisted like the calendar/music views. */
   const disposeMovable = makeMovable(el, {
      storageKey: "dawn.hero.haPos",
      handle: ".ha-head",
      ignore: ".ha-refresh"
   });

   const vis = makeVisibility(el, { storageKey: VISIBLE_KEY, offClass: "ha-off" });

   /* --- state ------------------------------------------------------------- */
   let entities: HAEntity[] = [];
   let status: HAStatus = { configured: false, connected: false };
   const prevState = new Map<string, string>(); // entity_id -> last seen state (for diff)
   let loaded = false; // suppress the change-spike on the very first snapshot
   let changed = new Set<string>(); // entity_ids whose state changed on the latest poll

   /* Rooms the user has folded shut, persisted per machine (keyed by room name so it
      survives re-polls and reconnects; an unknown room just defaults to expanded). */
   const loadCollapsed = (): Set<string> => {
      try {
         const arr = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
         return Array.isArray(arr) ? new Set(arr.map(String)) : new Set();
      } catch {
         return new Set();
      }
   };
   const collapsedRooms = loadCollapsed();
   const persistCollapsed = (): void => {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedRooms]));
   };

   /* Group entities by room. Named areas sort alphabetically; entities with no area
      fall into "Other", which always sorts last. Within a room, cluster by domain
      then name so like things sit together. */
   const groupByRoom = (): Array<{ room: string; items: HAEntity[] }> => {
      const groups = new Map<string, HAEntity[]>();
      for (const e of entities) {
         const room = e.area || "Other";
         const bucket = groups.get(room);
         if (bucket) bucket.push(e);
         else groups.set(room, [e]);
      }
      const rooms = [...groups.keys()].sort((a, b) => {
         if (a === "Other") return 1;
         if (b === "Other") return -1;
         return a.localeCompare(b);
      });
      return rooms.map((room) => ({
         room,
         items: (groups.get(room) as HAEntity[]).sort(
            (a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name)
         )
      }));
   };

   /* --- widgets ----------------------------------------------------------- */

   /* Is the DAWN link usable right now? A host that doesn't wire it is treated as live. */
   const live = (): boolean => !opts.isLive || opts.isLive();

   const callService = (ev: HAEntity, service: string, data?: Record<string, unknown>): void => {
      /* Don't fire a control into a dead/half-open link where it would silently vanish;
         tell the user instead. optimistic() below also bails, so the widget doesn't flip a
         state that never took (the exact "toggled and nothing happened" gap). */
      if (!live()) {
         opts.notify?.("Not connected to DAWN - control not sent.");
         return;
      }
      opts.onControl({ entityId: ev.entityId, domain: ev.domain, service, data });
   };

   /* Reflect a user action immediately, then let the server's reconcile broadcast settle
      the true state (a fresh ha_entities_response after DAWN re-polls HA). On a rejected
      call the ingest re-polls to revert this flip and surfaces the error. */
   const optimistic = (entityId: string, newState: string, attrPatch?: Partial<HAAttributes>): void => {
      if (!live()) return; // link down: callService already declined + notified; don't flip a lie
      const e = entities.find((x) => x.entityId === entityId);
      if (!e) return;
      e.state = newState;
      if (attrPatch) e.attributes = { ...(e.attributes ?? {}), ...attrPatch };
      render();
   };

   /* Pick the control (and optional slider) for an entity from its domain + attributes. */
   const describe = (ev: HAEntity): { control: Control; slider: Slider | null } => {
      const d = ev.domain;
      const a = ev.attributes;

      if (TOGGLE_DOMAINS.has(d)) {
         const on = ev.state === "on";
         const control: Control = {
            kind: "toggle",
            on,
            onSet: (v) => {
               callService(ev, v ? "turn_on" : "turn_off");
               optimistic(ev.entityId, v ? "on" : "off");
            }
         };
         let slider: Slider | null = null;
         if (d === "light" && a?.brightness != null) {
            slider = {
               value: a.brightness,
               min: 0,
               max: 255,
               suffix: "",
               onSet: (v) => {
                  callService(ev, "turn_on", { brightness: v });
                  optimistic(ev.entityId, v > 0 ? "on" : "off", { brightness: v });
               }
            };
         } else if (d === "fan" && a?.percentage != null) {
            slider = {
               value: a.percentage,
               min: 0,
               max: 100,
               suffix: "%",
               onSet: (v) => {
                  callService(ev, "set_percentage", { percentage: v });
                  optimistic(ev.entityId, v > 0 ? "on" : "off", { percentage: v });
               }
            };
         }
         return { control, slider };
      }

      if (d === "lock") {
         const locked = ev.state === "locked";
         return {
            control: {
               kind: "toggle",
               on: locked,
               onSet: (v) => {
                  callService(ev, v ? "lock" : "unlock");
                  optimistic(ev.entityId, v ? "locked" : "unlocked");
               }
            },
            slider: null
         };
      }

      if (d === "cover") {
         const open = ev.state === "open";
         let slider: Slider | null = null;
         if (a?.position != null) {
            slider = {
               value: a.position,
               min: 0,
               max: 100,
               suffix: "%",
               onSet: (v) => {
                  callService(ev, "set_cover_position", { position: v });
                  optimistic(ev.entityId, v > 0 ? "open" : "closed", { position: v });
               }
            };
         }
         return {
            control: {
               kind: "toggle",
               on: open,
               onSet: (v) => {
                  callService(ev, v ? "open_cover" : "close_cover");
                  optimistic(ev.entityId, v ? "open" : "closed");
               }
            },
            slider
         };
      }

      if (d === "media_player") {
         const playing = ev.state === "playing";
         return {
            control: {
               kind: "toggle",
               on: playing,
               onSet: (v) => {
                  callService(ev, v ? "media_play" : "media_pause");
                  optimistic(ev.entityId, v ? "playing" : "paused");
               }
            },
            slider: null
         };
      }

      if (d === "climate") {
         const options = a?.hvacModes ?? DEFAULT_HVAC_MODES;
         const value = a?.hvacMode ?? ev.state;
         return {
            control: {
               kind: "select",
               value,
               options,
               onSet: (v) => {
                  callService(ev, "set_hvac_mode", { hvac_mode: v });
                  optimistic(ev.entityId, v, { hvacMode: v });
               }
            },
            slider: null
         };
      }

      /* Read-only readout (sensors, weather, anything not controllable). */
      const unit = a?.unit ?? "";
      return { control: { kind: "display", text: humanizeState(ev.state) + (unit ? ` ${unit}` : "") }, slider: null };
   };

   const buildControlEl = (c: Control): HTMLElement => {
      if (c.kind === "toggle") {
         const btn = document.createElement("button");
         btn.type = "button";
         btn.className = c.on ? "ha-toggle on" : "ha-toggle";
         btn.setAttribute("role", "switch");
         btn.setAttribute("aria-checked", c.on ? "true" : "false");
         btn.addEventListener("click", (e) => {
            e.stopPropagation();
            c.onSet(!c.on);
         });
         return btn;
      }
      if (c.kind === "select") {
         const sel = document.createElement("select");
         sel.className = "ha-select";
         for (const opt of c.options) {
            const o = document.createElement("option");
            o.value = opt;
            o.textContent = humanizeState(opt);
            if (opt === c.value) o.selected = true;
            sel.appendChild(o);
         }
         sel.addEventListener("change", (e) => {
            e.stopPropagation();
            c.onSet(sel.value);
         });
         return sel;
      }
      const span = document.createElement("span");
      span.className = "ha-state";
      span.textContent = c.text;
      return span;
   };

   const buildSliderEl = (s: Slider): HTMLElement => {
      const wrap = document.createElement("div");
      wrap.className = "ha-slider-row";
      const input = document.createElement("input");
      input.type = "range";
      input.className = "ha-slider";
      input.min = String(s.min);
      input.max = String(s.max);
      input.value = String(s.value);
      const val = document.createElement("span");
      val.className = "ha-slider-val";
      const label = (v: number): string =>
         s.suffix ? `${v}${s.suffix}` : `${Math.round(((v - s.min) / (s.max - s.min)) * 100)}%`;
      val.textContent = label(s.value);
      input.addEventListener("input", () => {
         val.textContent = label(Number(input.value));
      });
      input.addEventListener("change", (e) => {
         e.stopPropagation();
         s.onSet(Number(input.value));
      });
      wrap.append(input, val);
      return wrap;
   };

   const render = (): void => {
      list.replaceChildren();

      /* Header status line. */
      if (!status.configured) {
         statusEl.textContent = "";
      } else if (!status.connected) {
         statusEl.textContent = "offline";
      } else {
         const active = entities.filter((e) => isActive(e.state)).length;
         statusEl.textContent = `${active} active`;
      }

      /* Body: connection problems and empty houses get a single quiet line. */
      if (!status.configured) {
         const msg = document.createElement("div");
         msg.className = "ha-empty";
         msg.textContent = "Home Assistant not configured";
         list.appendChild(msg);
         card.refresh();
         changed = new Set();
         return;
      }
      if (!status.connected) {
         const msg = document.createElement("div");
         msg.className = "ha-empty";
         msg.textContent = status.error ? `Home Assistant offline (${status.error})` : "Home Assistant offline";
         list.appendChild(msg);
         card.refresh();
         changed = new Set();
         return;
      }
      if (entities.length === 0) {
         const msg = document.createElement("div");
         msg.className = "ha-empty";
         msg.textContent = "No entities";
         list.appendChild(msg);
         card.refresh();
         changed = new Set();
         return;
      }

      for (const { room, items } of groupByRoom()) {
         const collapsed = collapsedRooms.has(room);

         /* Room header doubles as a collapse toggle. It lives in the interactive body
            (only .ha-head drags the card), so a click here just folds the room. */
         const header = document.createElement("div");
         header.className = collapsed ? "ha-room collapsed" : "ha-room";
         header.setAttribute("role", "button");
         header.setAttribute("tabindex", "0");
         header.setAttribute("aria-expanded", collapsed ? "false" : "true");

         const chevron = document.createElement("span");
         chevron.className = "ha-room-chevron";
         chevron.setAttribute("aria-hidden", "true");
         const label = document.createElement("span");
         label.className = "ha-room-label";
         label.textContent = room;
         header.append(chevron, label);

         /* Active count, so a folded room still surfaces that something is on inside it. */
         const activeCount = items.filter((e) => isActive(e.state)).length;
         if (activeCount > 0) {
            const count = document.createElement("span");
            count.className = "ha-room-count";
            count.textContent = String(activeCount);
            header.appendChild(count);
         }

         const toggleRoom = (): void => {
            if (collapsedRooms.has(room)) collapsedRooms.delete(room);
            else collapsedRooms.add(room);
            persistCollapsed();
            render();
         };
         header.addEventListener("click", toggleRoom);
         header.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
               e.preventDefault();
               toggleRoom();
            }
         });
         list.appendChild(header);

         if (collapsed) continue; // header only; rows stay folded away

         for (const ev of items) {
            const row = document.createElement("div");
            row.className = "ha-row";
            if (isActive(ev.state)) row.classList.add("active"); // filled dot (liveliness)
            if (isOffline(ev.state)) row.classList.add("offline"); // the only thing that dims
            if (changed.has(ev.entityId)) row.classList.add("ha-changed");

            const dot = document.createElement("span");
            dot.className = "ha-dot";

            const name = document.createElement("span");
            name.className = "ha-name";
            name.textContent = ev.name || ev.entityId;

            const { control, slider } = describe(ev);
            row.append(dot, name, buildControlEl(control));
            if (slider) row.appendChild(buildSliderEl(slider));
            list.appendChild(row);
         }
      }

      card.refresh();
      changed = new Set(); // consume: a later non-poll re-render must not re-spike
   };
   render();

   const controller: HAPanelController = {
      setEntities: (evs) => {
         /* Diff against the last snapshot to find changed rows (skip the first load,
            so we don't flash the whole house on connect). */
         const next = new Set<string>();
         if (loaded) {
            for (const e of evs) {
               const prev = prevState.get(e.entityId);
               if (prev !== undefined && prev !== e.state) next.add(e.entityId);
            }
         }
         prevState.clear();
         for (const e of evs) prevState.set(e.entityId, e.state);
         loaded = true;
         changed = next;
         entities = evs;
         render();
      },
      setStatus: (s) => {
         status = s;
         render();
      },
      isVisible: vis.isVisible,
      setVisible: vis.setVisible,
      destroy: () => {
         refreshBtn.removeEventListener("click", onRefreshClick);
         card.destroy();
         disposeMovable();
         el.remove();
      }
   };
   return controller;
}
