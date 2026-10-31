/*
 * Phone calls (WebUI parity, DAWN's phone_call_notification / phone_action / phone_status).
 * The call itself runs on DAWN's own modem hardware: its audio goes through the Jetson's speaker
 * and microphone and never reaches the browser. Aurora only shows the call and controls it:
 *
 *   ringing -> a needs-you card (caller photo, name, number) with Answer / Reject, plus a local
 *              ring tone (the real ring plays only at the daemon), gated by "Alarm sounds";
 *   answer  -> the same card shows "Answering…" until DAWN says the call connected;
 *   active  -> a persistent in-call card: live duration (anchored to DAWN's elapsed_sec, so a
 *              backgrounded tab stays right), Hang Up, and Minimize to a one-line bar;
 *   ended   -> the card goes. Hang Up waits for DAWN's "ended" (it never vanishes on the click),
 *              with a 30 s fallback in case that frame is lost.
 *
 * Answering, rejecting, and hanging up the user's own phone are user-scoped writes (charter);
 * DAWN only lets the configured modem owner do them. After every (re)connect Aurora asks for the
 * live call state (phone_status: DAWN replies only while a call is live), and a link loss tears
 * the call UI down. Every caller string is DAWN data, bound via textContent by the notify layer.
 * Kept out of dawn-ws.ts: DawnIngest routes the frame here and supplies send + the sinks.
 */

import type { AlarmChime } from "../audio/alarm-chime.ts";
import type { NoticeAction, NotificationsSink } from "./ingest.ts";

export const PHONE_NOTICE_ID = "phone-call";
const FALLBACK_MS = 30_000; // clear a card stuck waiting for a frame that never came (then re-ask)
const RECHECK_MS = 2_000; // after Reject: re-ask whether the phone is still ringing

type CallState = {
   status: "ringing" | "active";
   callId: number; // DAWN's call-log id (-1 when unknown): name/photo carry over only within one call
   name: string;
   number: string;
   photo?: string;
   startedAt: number; // ms (performance clock) when the call connected, for the duration
};

/* mm:ss, or h:mm:ss past an hour. */
export function fmtCallDuration(sec: number): string {
   const s = Math.max(0, Math.floor(sec));
   const h = Math.floor(s / 3600);
   const m = Math.floor((s % 3600) / 60);
   const ss = String(s % 60).padStart(2, "0");
   return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export class PhoneCalls {
   private call: CallState | null = null;
   private pending: "answering" | "hanging" | null = null;
   private minimized = false;
   private tickTimer = 0;
   private fallbackTimer = 0;
   private recheckTimer = 0;

   constructor(
      private readonly send: (msg: { type: string; payload?: Record<string, unknown> }) => void,
      private readonly notifications: () => NotificationsSink,
      private readonly chime: AlarmChime
   ) {}

   /* Whether a call is ringing (the screensaver's don't-sleep guard, like a ringing alarm). */
   isRinging(): boolean {
      return this.call?.status === "ringing";
   }

   /* After every (re)connect: ask whether a call is live (DAWN answers only if one is). */
   requestStatus(): void {
      this.send({ type: "phone_status" });
   }

   /* A phone_call_notification frame (a live event, or the reply to phone_status). */
   onFrame(p: Record<string, unknown>): void {
      const status = String(p.status ?? "");
      if (status === "ended") {
         this.clear();
         return;
      }
      if (status !== "ringing" && status !== "active") return;
      const name = typeof p.name === "string" ? p.name : "";
      const number = typeof p.number === "string" ? p.number : "";
      const photo =
         p.photo && typeof p.photo === "object"
            ? (p.photo as { data?: unknown; mime?: unknown })
            : null;
      const photoUri =
         photo && typeof photo.data === "string" && typeof photo.mime === "string"
            ? `data:${photo.mime};base64,${photo.data}`
            : undefined;
      const elapsed = Number(p.elapsed_sec ?? 0);
      const callId = Number(p.call_id ?? -1);
      /* The same call (by id) keeps what a later frame omits (the active frame has no photo); a
         DIFFERENT call never inherits the last caller's name or photo. */
      const sameCall =
         !!this.call &&
         ((callId >= 0 && this.call.callId === callId) ||
            (!!number && this.call.number === number) ||
            (!number && !name));
      const prev = sameCall ? this.call : null;
      const newCall = !prev;
      this.call = {
         status,
         callId,
         name: name || prev?.name || "",
         number: number || prev?.number || "",
         photo: photoUri ?? prev?.photo,
         startedAt:
            performance.now() - (Number.isFinite(elapsed) && elapsed > 0 ? elapsed * 1000 : 0)
      };
      if (status === "ringing") {
         /* A ringing frame ends any in-call display (a second call while one was active): stop the
            duration ticker and start the ringing card fresh, with its own settings. */
         if (this.tickTimer) {
            window.clearInterval(this.tickTimer);
            this.tickTimer = 0;
            this.minimized = false;
            this.notifications().remove(PHONE_NOTICE_ID);
         }
         if (newCall && this.pending !== "hanging") this.pending = null;
         if (this.pending !== "answering") this.chime.startRing();
      } else {
         /* Connected: the ring stops, and a pending Answer has done its job. */
         this.chime.stopRing();
         if (this.pending === "answering") this.pending = null;
         if (this.pending !== "hanging") this.disarmFallback();
         this.startTicking();
      }
      this.render();
   }

   /* A button on the call card. */
   action(action: string): void {
      if (!this.call) return;
      if (action === "answer" && this.call.status === "ringing") {
         this.chime.stopRing();
         this.pending = "answering";
         this.send({ type: "phone_action", payload: { action: "answer" } });
         this.armFallback();
      } else if (action === "reject" && this.call.status === "ringing") {
         this.send({ type: "phone_action", payload: { action: "reject" } });
         this.clear(); // DAWN's "ended" follows; the card goes now (WebUI parity)
         /* If the reject didn't take (DAWN drops a second action while one is in flight), the phone
            is still ringing: re-ask, and DAWN answers only if a call is still live. */
         this.recheckTimer = window.setTimeout(() => this.requestStatus(), RECHECK_MS);
         return;
      } else if (action === "hangup" && this.call.status === "active") {
         this.pending = "hanging";
         this.send({ type: "phone_action", payload: { action: "hangup" } });
         this.armFallback();
      } else if (action === "minimize" || action === "expand") {
         this.minimized = action === "minimize";
      }
      this.render();
   }

   /* Link lost: the call's frames can't arrive now; drop the UI (a reconnect re-asks). */
   reset(): void {
      this.clear();
   }

   dispose(): void {
      this.clear();
   }

   private render(): void {
      const c = this.call;
      if (!c) return;
      const who = c.name || c.number || "Unknown caller";
      const numberLine = c.name && c.number ? c.number : undefined;
      if (c.status === "ringing") {
         const answering = this.pending === "answering";
         const actions: NoticeAction[] = [
            { id: "answer", label: "Answer", keepOpen: true, disabled: answering },
            { id: "reject", label: "Reject", disabled: answering }
         ];
         this.notifications().notify({
            id: PHONE_NOTICE_ID,
            kind: answering ? "Answering…" : "Incoming call",
            summary: who,
            detail: numberLine,
            tone: "attention",
            persist: true,
            critical: true, // the only on-screen control for a ringing phone: never evicted
            urgent: !answering, // wakes the screensaver
            hold: 30,
            image: c.photo,
            actions
         });
         return;
      }
      const duration = fmtCallDuration((performance.now() - c.startedAt) / 1000);
      const hanging = this.pending === "hanging";
      this.notifications().notify({
         id: PHONE_NOTICE_ID,
         kind: hanging ? "Hanging up…" : "On call",
         summary: this.minimized ? `${who} · ${duration}` : who,
         detail: this.minimized ? undefined : numberLine ? `${numberLine} · ${duration}` : duration,
         tone: "attention",
         sticky: true, // a persistent call bar: full presence, no close, stays until the call ends
         compact: this.minimized,
         image: this.minimized ? undefined : c.photo,
         actions: [
            { id: "hangup", label: "Hang Up", keepOpen: true, disabled: hanging },
            {
               id: this.minimized ? "expand" : "minimize",
               label: this.minimized ? "Expand" : "Minimize",
               keepOpen: true
            }
         ]
      });
   }

   private startTicking(): void {
      if (this.tickTimer) return;
      this.tickTimer = window.setInterval(() => this.render(), 1000);
   }

   /* Waiting for a frame (connected after Answer, ended after Hang Up) that hasn't come: drop
      the stale card and re-ask, so a call that's still live comes back with live controls and a
      dead one stays gone (DAWN replies to phone_status only while a call is live). */
   private armFallback(): void {
      this.disarmFallback();
      this.fallbackTimer = window.setTimeout(() => {
         this.clear();
         this.requestStatus();
      }, FALLBACK_MS);
   }

   /* "Alarm sounds" was just turned on: a call that's ringing right now starts its ring. */
   resumeRing(): void {
      if (this.call?.status === "ringing" && this.pending !== "answering") this.chime.startRing();
   }

   private disarmFallback(): void {
      window.clearTimeout(this.fallbackTimer);
      this.fallbackTimer = 0;
   }

   private clear(): void {
      window.clearTimeout(this.recheckTimer);
      this.recheckTimer = 0;
      this.chime.stopRing();
      window.clearInterval(this.tickTimer);
      this.tickTimer = 0;
      this.disarmFallback();
      const had = this.call !== null;
      this.call = null;
      this.pending = null;
      this.minimized = false;
      if (had) this.notifications().remove(PHONE_NOTICE_ID);
   }
}
