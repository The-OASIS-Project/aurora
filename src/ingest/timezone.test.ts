// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DawnIngest } from "./dawn-ws.ts";

/* DawnIngest's zone handling with fake sinks and socket. */
function setup() {
   const ing = new DawnIngest() as unknown as Record<string, any>;
   const zones: string[] = [];
   const sent: Array<Record<string, any>> = [];
   ing.sinks = {
      telemetry: { setTimezone: (tz: string) => zones.push(tz) },
      calendar: { setTimezone: () => {} },
      conversationList: { setTimezone: () => {} }
   };
   ing.ws = { readyState: WebSocket.OPEN, send: (m: string) => sent.push(JSON.parse(m)) };
   const frame = (type: string, payload: Record<string, unknown>): void =>
      ing.onFrame(JSON.stringify({ type, payload }));
   const calendarAsks = () => sent.filter((m) => m.type === "calendar_upcoming_events");
   return { zones, frame, calendarAsks };
}

describe("the user's timezone", () => {
   it("switches on timezone_changed and refetches today's calendar in the new zone", () => {
      const t = setup();
      t.frame("get_my_settings_response", { timezone: "America/New_York" });
      t.frame("timezone_changed", { timezone: "America/Los_Angeles" });
      expect(t.zones).toEqual(["America/New_York", "America/Los_Angeles"]);
      const asks = t.calendarAsks();
      expect(asks.length).toBe(2);
      expect(asks[1].payload.start - asks[0].payload.start).not.toBe(0); // a different midnight
   });

   it("does nothing for the zone already in use, or an unknown one", () => {
      const t = setup();
      t.frame("timezone_changed", { timezone: "America/New_York" });
      t.frame("timezone_changed", { timezone: "America/New_York" });
      t.frame("get_my_settings_response", { timezone: "America/New_York" });
      t.frame("timezone_changed", { timezone: "Not/AZone" });
      t.frame("timezone_changed", {});
      expect(t.zones).toEqual(["America/New_York"]);
      expect(t.calendarAsks().length).toBe(1);
   });

   it("prefers the session frame's zone over get_my_settings's raw one", () => {
      const t = setup();
      t.frame("session", { authenticated: true, timezone: "America/Chicago" });
      t.frame("get_my_settings_response", { timezone: "US/Central" });
      expect(t.zones).toEqual(["America/Chicago"]);
   });

   it("uses get_my_settings on an older DAWN whose session frame has no zone", () => {
      const t = setup();
      t.frame("session", { authenticated: true });
      t.frame("get_my_settings_response", { timezone: "America/Denver" });
      expect(t.zones).toEqual(["America/Denver"]);
   });
});
