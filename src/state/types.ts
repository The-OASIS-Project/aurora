/*
 * State layer types (brief S7.1). This is the vocabulary of "what is true right
 * now", with ZERO notion of pixels, CSS, tiers, or how anything looks. If a type
 * in this file grows a visual property, the seam has been breached.
 *
 * Note deliberately absent: depth / z / tier. The brief mentions z in S7.1 but
 * S7.2 assigns "importance maps to Z" to the choreography layer, and S9.2 makes
 * depth auto-managed in v1 (not user data). So depth is DERIVED downstream from
 * importance; storing it here would invite logic to write render coordinates,
 * which is exactly the seam we are protecting. State holds importance + planar
 * position; choreography decides where that sits in depth.
 */

/* Semantic tone. Cool = calm/nominal, warm = attention (the amber, brief S8).
   This is meaning, not color: the render layer maps tone to a palette token. */
export type Tone = "nominal" | "attention";

/*
 * Importance is a continuous 0..3 scale, not an enum, so it can decay smoothly
 * (spike then recede). The bands are named for reference but the value between
 * them is meaningful:
 *   0.0  invisible / no signal        (an event element at rest)
 *   1.0  ambient resting summary      (a persistent element at rest)
 *   2.0  notice                       (worth drifting forward)
 *   3.0  alert / just happened        (claims the front)
 * "Persistent vs event" is just a different resting floor (restImportance).
 */
export const IMPORTANCE = {
   invisible: 0,
   ambient: 1,
   notice: 2,
   alert: 3
} as const;

export interface ElementState {
   /* Stable identity. Ingest updates address an element by id. */
   id: string;
   /* What kind of thing this is: 'calendar' | 'email' | 'homeassistant' |
      'subsystems' | ... Drives which panel template renders it. */
   kind: string;

   /* The quiet resting summary (brief S3.1). Shown at rest. */
   summary: string;
   /* Richer text revealed as the element comes forward. Optional. */
   detail?: string;

   /* Current importance (drives everything downstream). Decays toward the
      floor over time so a spike naturally recedes. */
   importance: number;
   /* The floor importance never falls below: the persistent-vs-event knob.
      Persistent elements rest at ~ambient; event elements rest at ~invisible. */
   restImportance: number;

   /* Abstract planar position, roughly -1..1 with (0,0) at center. This is the
      user-arrangeable axis (brief S9.2: planar drag in v1). NOT pixels. */
   position: { x: number; y: number };

   /* Cool vs warm treatment. */
   tone: Tone;

   /* User toggle from the menu. Undefined or true = shown; false = hidden (the
      choreography layer emits no node for it, so it leaves the dashboard). */
   enabled?: boolean;

   /* User pinned / moved this element. Layout offsets are saved here. A pinned
      element docks to a side rail (see `dock`), stays fully present, and is
      exempt from the importance/contention choreography. */
   pinned: boolean;
   /* Which side rail a pinned element docks to, and its order within that rail
      (lower is higher up). The user sets both by dragging; the store keeps each
      rail's orders contiguous. */
   dock?: "left" | "right";
   dockOrder?: number;
   /* True for elements that ONLY ever live docked (music, documents): they are
      widgets, not ambient panels, so they cannot be unpinned back into the field.
      Ambient panels (calendar, email, ...) leave this unset and toggle freely. */
   dockOnly?: boolean;

   /* True for notification cards (attention alerts, a ringing alarm, job/observation
      toasts). They spike forward then settle to a quiet floating presence, or auto-fade
      when `restImportance` is invisible (toasts). Unlike ambient panels they carry an ×
      close control in BOTH the floating and docked states, can be dragged to a rail to
      dock (foreground) or left floating (faded back for depth), and are removed on ×. A
      tap no longer closes them - the × does. */
   closeable?: boolean;

   /* Optional richer content for pinned panels, rendered kind-specifically:
      `progress` (0..1) drives a music now-playing bar; `items` is a row list
      (e.g. recent documents). Ignored for ambient floating elements. */
   progress?: number;
   items?: string[];

   /* Logical tick counter at last change, used only for recency tiebreaks in
      contention. Not wall-clock, so it stays deterministic and testable. */
   revision: number;
}
