// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fmtCallDuration, PhoneCalls, PHONE_NOTICE_ID } from "./phone-wire.ts";
import type { AlarmChime } from "../audio/alarm-chime.ts";
import type { Notice } from "./ingest.ts";

function setup() {
   const sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];
   const shown = new Map<string, Notice>();
   const removed: string[] = [];
   const chime = {
      ring: false,
      startRing() {
         this.ring = true;
      },
      stopRing() {
         this.ring = false;
      }
   };
   const phone = new PhoneCalls(
      (m) => sent.push(m),
      () => ({
         notify: (n: Notice) => shown.set(n.id, n),
         remove: (id: string) => {
            shown.delete(id);
            removed.push(id);
         }
      }),
      chime as unknown as AlarmChime
   );
   return { phone, sent, shown, removed, chime, card: () => shown.get(PHONE_NOTICE_ID) };
}

beforeEach(() =>
   vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance", "Date"]
   })
);
afterEach(() => vi.useRealTimers());

describe("phone calls", () => {
   it("rings with Answer / Reject, then answers and shows the call with a live duration", () => {
      const t = setup();
      t.phone.onFrame({
         status: "ringing",
         name: "Jordan Avery",
         number: "+15550100",
         photo: { data: "iVBORw0KGgo=", mime: "image/png" }
      });
      expect(t.chime.ring).toBe(true);
      expect(t.card()?.kind).toBe("Incoming call");
      expect(t.card()?.summary).toBe("Jordan Avery");
      expect(t.card()?.detail).toBe("+15550100");
      expect(t.card()?.urgent).toBe(true);
      expect(t.card()?.actions?.map((a) => a.id)).toEqual(["answer", "reject"]);
      expect(t.card()?.image).toBe("data:image/png;base64,iVBORw0KGgo=");

      t.phone.action("answer");
      expect(t.sent.at(-1)).toEqual({ type: "phone_action", payload: { action: "answer" } });
      expect(t.chime.ring).toBe(false);
      expect(t.card()?.kind).toBe("Answering…");
      expect(t.card()?.actions?.every((a) => a.disabled)).toBe(true);

      t.phone.onFrame({
         status: "active",
         name: "Jordan Avery",
         number: "+15550100",
         elapsed_sec: 0
      });
      expect(t.card()?.kind).toBe("On call");
      expect(t.card()?.sticky).toBe(true);
      expect(t.card()?.image).toBe("data:image/png;base64,iVBORw0KGgo="); // kept from the ringing frame
      vi.advanceTimersByTime(65_000);
      expect(t.card()?.detail).toContain("1:05");
   });

   it("never gives a different caller the previous caller's name or photo", () => {
      const t = setup();
      t.phone.onFrame({
         status: "active",
         call_id: 7,
         name: "Jordan",
         number: "+1",
         photo: { data: "iVBORw0KGgo=", mime: "image/png" },
         elapsed_sec: 0
      });
      t.phone.onFrame({ status: "ringing", call_id: 8, name: "", number: "+2" });
      expect(t.card()?.kind).toBe("Incoming call");
      expect(t.card()?.summary).toBe("+2");
      expect(t.card()?.image).toBeUndefined();
      vi.advanceTimersByTime(5000);
      expect(t.card()?.kind).toBe("Incoming call"); // the old call's ticker didn't take over
   });

   it("rejects and clears at once", () => {
      const t = setup();
      t.phone.onFrame({ status: "ringing", name: "", number: "+15550100" });
      expect(t.card()?.summary).toBe("+15550100");
      t.phone.action("reject");
      expect(t.sent.at(-1)?.payload).toEqual({ action: "reject" });
      expect(t.card()).toBeUndefined();
      expect(t.chime.ring).toBe(false);
   });

   it("hang up waits for DAWN's ended, with a 30 s fallback", () => {
      const t = setup();
      t.phone.onFrame({ status: "active", name: "Sam", number: "1", elapsed_sec: 125 });
      expect(t.card()?.detail).toContain("2:05"); // anchored to DAWN's elapsed
      t.phone.action("hangup");
      expect(t.card()?.kind).toBe("Hanging up…");
      t.phone.onFrame({ status: "ended" });
      expect(t.card()).toBeUndefined();

      t.phone.onFrame({ status: "active", name: "Sam", number: "1", elapsed_sec: 0 });
      t.phone.action("hangup");
      vi.advanceTimersByTime(30_001);
      expect(t.card()).toBeUndefined(); // the ended frame never came
   });

   it("minimizes to a compact bar and expands back", () => {
      const t = setup();
      t.phone.onFrame({ status: "active", name: "Sam", number: "1", elapsed_sec: 0 });
      t.phone.action("minimize");
      expect(t.card()?.compact).toBe(true);
      expect(t.card()?.summary).toContain("Sam ·");
      expect(t.card()?.actions?.[1].id).toBe("expand");
      t.phone.action("expand");
      expect(t.card()?.compact).toBe(false);
   });

   it("asks for the live call on reconnect and drops the UI on a link loss", () => {
      const t = setup();
      t.phone.requestStatus();
      expect(t.sent.at(-1)).toEqual({ type: "phone_status" });
      t.phone.onFrame({ status: "ringing", name: "X", number: "1" });
      t.phone.reset();
      expect(t.card()).toBeUndefined();
      expect(t.chime.ring).toBe(false);
   });

   it("formats durations", () => {
      expect(fmtCallDuration(0)).toBe("0:00");
      expect(fmtCallDuration(65)).toBe("1:05");
      expect(fmtCallDuration(3725)).toBe("1:02:05");
   });
});
