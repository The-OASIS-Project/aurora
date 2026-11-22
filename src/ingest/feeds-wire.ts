/* DAWN's panel frames -> the panels' types: calendar events, library items, context items, Home
   Assistant entities, watches. */

import type {
   CalendarEvent,
   ContextItem,
   HAAttributes,
   HAEntity,
   LibraryItem,
   WatchFields,
   WatchItem
} from "./ingest.ts";
import { str } from "./wire.ts";

/* A calendar_upcoming_events event -> our CalendarEvent. */
export function toCalendarEvent(e: Record<string, unknown>): CalendarEvent {
   return {
      id: Number(e.id ?? 0),
      calendarId: Number(e.calendar_id ?? 0),
      summary: str(e.summary),
      location: str(e.location),
      start: Number(e.start ?? 0),
      end: Number(e.end ?? 0),
      allDay: e.all_day === true,
      startDate: str(e.start_date),
      endDate: str(e.end_date),
      cancelled: e.cancelled === true,
      isOverride: e.is_override === true
   };
}

/* A doc_library_list document/note -> our LibraryItem. `text` is present for notes only.
   `original_blob_id`/`has_original` gate a document's readability and are only present once
   DAWN ships the signal-map §9 backend field; absent, hasOriginal falls back to whether a
   blob id came through, and if neither is present the document is a metadata-only row. */
export function toLibraryItem(d: Record<string, unknown>): LibraryItem {
   const filetype = str(d.filetype);
   const blobId =
      typeof d.original_blob_id === "string" && d.original_blob_id ? d.original_blob_id : undefined;
   return {
      id: Number(d.id ?? 0),
      filename: str(d.filename),
      filetype,
      isNote: d.is_note === true || filetype === "note",
      text: typeof d.text === "string" ? d.text : undefined,
      numChunks: Number(d.num_chunks ?? 0),
      isGlobal: d.is_global === true,
      createdAt: Number(d.created_at ?? 0),
      originalBlobId: blobId,
      hasOriginal: d.has_original === true || blobId !== undefined
   };
}

/* Parse one context_injection item (a focus-block candidate). Numbers are read
   defensively; provenance is omitted server-side when unavailable (conv_id 0), so treat its
   absence as "not available". Text stays raw here - the panel binds it via textContent. */
export function toContextItem(d: Record<string, unknown>): ContextItem {
   const b = (d.score_breakdown ?? {}) as Record<string, unknown>;
   const item: ContextItem = {
      itemId: str(d.item_id), // unique per-row key; "" for non-citeable rows (feature-detected)
      sourceId: str(d.source_id),
      sourceType: str(d.source_type),
      text: typeof d.text === "string" ? d.text : "",
      score: Number(d.score ?? 0),
      breakdown: {
         semantic: Number(b.semantic ?? 0),
         recency: Number(b.recency ?? 0),
         importance: Number(b.importance ?? 0),
         source: Number(b.source ?? 0)
      },
      appliedSourceWeight: Number(d.applied_source_weight ?? 0)
   };
   const prov = d.provenance as Record<string, unknown> | undefined;
   if (prov && typeof prov === "object") {
      item.provenance = {
         conversationId: Number(prov.conversation_id ?? 0),
         msgIdStart: Number(prov.msg_id_start ?? 0),
         msgIdEnd: Number(prov.msg_id_end ?? 0)
      };
   }
   /* Optional, omitted when the item has none: accept only a finite positive number. */
   const ts = d.item_timestamp;
   if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) item.itemTimestamp = ts;
   return item;
}

/* Parse the optional per-entity `attributes` object (signal-map §9.4 #7). Only present
   once DAWN ships it; absent, the board falls back to on/off toggles. Numbers are read
   defensively (HA sometimes sends strings). */
function toHAAttributes(a: Record<string, unknown> | undefined): HAAttributes | undefined {
   if (!a || typeof a !== "object") return undefined;
   const num = (v: unknown): number | undefined => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
   };
   const attrs: HAAttributes = {};
   if (a.brightness != null) attrs.brightness = num(a.brightness);
   if (a.percentage != null) attrs.percentage = num(a.percentage);
   if (a.current_position != null) attrs.position = num(a.current_position);
   if (typeof a.hvac_mode === "string") attrs.hvacMode = a.hvac_mode;
   if (Array.isArray(a.hvac_modes)) attrs.hvacModes = a.hvac_modes.map(String);
   if (a.current_temperature != null) attrs.currentTemp = num(a.current_temperature);
   if (a.temperature != null) attrs.targetTemp = num(a.temperature);
   if (typeof a.unit_of_measurement === "string") attrs.unit = a.unit_of_measurement;
   if (typeof a.device_class === "string") attrs.deviceClass = a.device_class;
   return Object.keys(attrs).length > 0 ? attrs : undefined;
}

/* A ha_list_entities entity -> our HAEntity. `domain` and `area` are the two fields
   the signal-map docs omit but the source actually sends (`area` only when the
   entity is assigned to a room); friendly_name falls back to the entity_id. */
export function toHAEntity(e: Record<string, unknown>): HAEntity {
   const entityId = str(e.entity_id);
   return {
      entityId,
      name: str(e.friendly_name, entityId),
      domain: str(e.domain),
      area: str(e.area),
      state: str(e.state),
      attributes: toHAAttributes(e.attributes as Record<string, unknown> | undefined)
   };
}

/* A watch_list watch object -> our WatchItem. `threshold`/`current` are optional on the wire
   (omitted when non-finite), so read them independently rather than off `has_current`. */
/* WatchFields -> the snake_case wire keys DAWN's apply_overrides() reads (shared by add +
   update). rule_type drives an in-place threshold<->slope switch; the trigger key follows the
   kind (threshold vs slope_per_min, a positive magnitude in units/MINUTE - the sign comes from
   direction). Only defined fields are sent (an omitted field keeps its server value). */
export function watchFieldsToWire(fields: WatchFields | undefined): Record<string, unknown> {
   const payload: Record<string, unknown> = {};
   if (!fields) return payload;
   if (fields.name !== undefined) payload.name = fields.name;
   if (fields.ruleType !== undefined) payload.rule_type = fields.ruleType;
   if (fields.direction !== undefined) payload.direction = fields.direction;
   if (fields.threshold !== undefined) payload.threshold = fields.threshold;
   if (fields.slopePerMin !== undefined) payload.slope_per_min = fields.slopePerMin;
   if (fields.slopeWindowSec !== undefined) payload.slope_window_sec = fields.slopeWindowSec;
   if (fields.notify !== undefined) payload.notify = fields.notify;
   return payload;
}

export function toWatchItem(w: Record<string, unknown>): WatchItem {
   return {
      id: Number(w.id ?? 0),
      name: str(w.name),
      metric: str(w.metric),
      label: str(w.label, str(w.metric)),
      unit: str(w.unit),
      ruleType: str(w.rule_type, "threshold"),
      direction: str(w.direction, "above"),
      threshold: typeof w.threshold === "number" ? w.threshold : undefined,
      slopePerMin: typeof w.slope_per_min === "number" ? w.slope_per_min : undefined,
      slopeWindowSec: typeof w.slope_window_sec === "number" ? w.slope_window_sec : undefined,
      absenceAfterSec: Number(w.absence_after_sec ?? 0),
      notify: str(w.notify),
      enabled: w.enabled === true,
      named: w.named === true,
      source: str(w.source),
      hasCurrent: w.has_current === true,
      current: typeof w.current === "number" ? w.current : undefined,
      breaching: typeof w.breaching === "boolean" ? w.breaching : undefined
   };
}
