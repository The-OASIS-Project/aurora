/* Voice input: the microphone (push-to-talk and continuous listening), DAWN's server-side VAD and
   wake word (always_on_enable / _disable and the always_on_state it reports), the ready ding on a
   wake, and the echo mute that keeps DAWN's own voice out of the open mic. Audio goes up as
   AUDIO_IN frames once the session is confirmed. TTS playback (what DAWN says) stays with the
   turn in the core; this reads whether DAWN is speaking from it. */

import type { IngestSinks } from "./ingest.ts";
import { MicCapture, type MicCaptureState, type MicControl } from "../audio/mic.ts";
import { RecordingDing } from "../audio/ding.ts";

const BIN_AUDIO_IN = 0x01; // mic audio to DAWN ([0x01][raw Int16 PCM] or [0x01][len-prefixed opus])
const BIN_AUDIO_IN_END = 0x02; // end of a push-to-talk utterance (no payload); triggers ASR
const MIC_MUTE_COOLDOWN_MS = 800; // hold the continuous mute this long after DAWN stops speaking

/* The view it drives (the reactor's bars follow the user's voice). */
type Sinks = Pick<IngestSinks, "reactor">;

/* What it reads in the core. */
export interface VoiceCore {
   send: (msg: object) => boolean;
   /* Raw binary to the main socket (dropped when it isn't open). */
   sendBinary: (bytes: Uint8Array<ArrayBuffer>) => void;
   sinks: () => Sinks;
   ws: () => { readonly readyState: number } | null;
   /* DAWN has processed this connection's handshake (use_opus is set). */
   capsSynced: () => boolean;
   wantConnected: () => boolean;
   /* DAWN's state is "speaking", and the TTS playing what it said. */
   dawnSpeaking: () => boolean;
   tts: () => { isSpeaking(): boolean };
}

export class VoiceInput {
   /* The always-on "ready" ding: a short synthesized tone played on entry into
      always_on_state:recording, replacing DAWN's dropped spoken greeting. Its own lazy,
      isolated AudioContext; purely cosmetic (error-swallowed). */
   private readonly ding = new RecordingDing();
   /* Microphone capture (voice input). Constructed here so the composer's mic button can
      bind to it before ingest.start() runs; its AudioContext stays lazy until first use.
      onLevels feeds the reactor bar ring with the user's voice while speaking (the same
      hook TTS uses), onState drives the button chrome, onFrame/onEnd carry the AUDIO_IN
      payload and the utterance-end marker to DAWN (both gated on the session handshake). */
   readonly mic = new MicCapture({
      onLevels: (bins) => this.sinks.reactor.setLevels(bins),
      onFrame: (payload) => this.sendAudioIn(payload),
      /* Gate the end marker on the same capsSynced check as the frames, so a reconnect
         mid-utterance can't ship a bare AUDIO_IN_END whose audio was all dropped. */
      onEnd: () => {
         if (this.capsSynced) this.sendBinary(new Uint8Array([BIN_AUDIO_IN_END]));
      },
      onState: (s) => this.emitMicState(s),
      onError: (msg) => {
         console.warn("[mic]", msg);
         /* A mic failure/revoke (acquire denied, wrong rate, unplugged) while continuous is
            latched: disable it server-side instead of leaving DAWN armed with no audio. */
         if (this.continuousOn) {
            this.continuousOn = false;
            this.resumeContinuous = false;
            this.send({ type: "always_on_disable" });
         }
      }
   });
   private micStateListener: (s: MicCaptureState) => void = () => {};
   private lastMicState: MicCaptureState = "idle";
   /* Continuous-listening (always-on) state. `continuousOn` is the current session's latch;
      `resumeContinuous` survives a reconnect so the always-on mode is re-enabled from the new
      session's handshake (DAWN destroys the always-on context on socket close). */
   private continuousOn = false;
   resumeContinuous = false; // read and restored by logout
   /* DAWN's always-on FSM is in "recording" (capturing the user's command), so the mic must
      stay OPEN here regardless of dawnSpeaking - muting would blank the command window. (DAWN
      dropped the spoken "Hello" greeting that used to play here with a concurrent
      state:speaking; a client-side ding replaces it. The mic-open override remains as the
      command-capture guarantee, and any concurrent TTS is handled AEC-side, not by muting.) */
   private alwaysOnRecording = false;
   private voiceWake: (() => void) | null = null; // fired on a wake-word match (standby wake-on-voice)
   private micMuteCooldown = 0; // timer: reopen the mic a beat after DAWN goes fully quiet

   constructor(private readonly core: VoiceCore) {}

   private get sinks(): Sinks {
      return this.core.sinks();
   }
   private send(msg: object): boolean {
      return this.core.send(msg);
   }
   private sendBinary(bytes: Uint8Array<ArrayBuffer>): void {
      this.core.sendBinary(bytes);
   }
   private get ws(): { readonly readyState: number } | null {
      return this.core.ws();
   }
   private get capsSynced(): boolean {
      return this.core.capsSynced();
   }
   private get wantConnected(): boolean {
      return this.core.wantConnected();
   }
   private get dawnSpeaking(): boolean {
      return this.core.dawnSpeaking();
   }
   private get tts(): { isSpeaking(): boolean } {
      return this.core.tts();
   }

   onVoiceWake(cb: () => void): void {
      this.voiceWake = cb;
   }

   /* The main socket closed. */
   linkDown(): void {
      /* Release the mic on a drop; the session-frame resume re-enables continuous with a
         fresh always-on context. A deliberate disconnect (wantConnected false) clears the
         resume so it does NOT auto-re-arm. */
      if (this.continuousOn) {
         this.continuousOn = false;
         this.mic.continuousStop();
      }
      if (!this.wantConnected) this.resumeContinuous = false;
   }

   /* A session frame: re-establish continuous listening after a reconnect (DAWN destroyed the
      always-on context on the drop). */
   resumeIfWanted(): void {
      if (this.resumeContinuous && !this.continuousOn) this.startContinuous();
   }

   /* A deliberate disconnect. */
   stop(): void {
      window.clearTimeout(this.micMuteCooldown);
      this.micMuteCooldown = 0;
      /* Drop any in-flight utterance: the server's accumulated audio dies with the
         connection, so there is nothing to salvage. Reset the button to idle. */
      this.mic.stop();
      this.emitMicState("idle");
   }

   /* The error codes that refuse continuous listening; whether it was one. */
   onAlwaysOnRefusal(code: string, p: Record<string, unknown>): boolean {
      if (
         code === "ALREADY_ACTIVE" ||
         code === "PTT_ACTIVE" ||
         code === "INVALID_SAMPLE_RATE" ||
         code === "INIT_FAILED"
      ) {
         console.warn("[dawn] continuous listening rejected:", code, p.message);
         if (this.continuousOn) {
            this.continuousOn = false;
            this.resumeContinuous = false;
            this.mic.continuousStop();
         }
         return true;
      }
      return false;
   }

   /* always_on_state (the core lists it in its switch). */
   onFrame(type: string, p: Record<string, unknown>): void {
      switch (type) {
         case "always_on_state": {
            /* The ONLY always-on push (states: listening | wake_check | wake_pending |
               recording | processing | disabled). These are DAWN's internal VAD
               micro-states; we don't map them to the reactor (they'd thrash the busy
               channel), the normal `state` frames still drive it during an always-on turn. */
            const st = typeof p.state === "string" ? p.state : "";
            /* "recording" = DAWN is capturing the user's command; everything else is not.
               Drives the keep-mic-open override in updateMicMute. `entering` = the once-per-
               wake transition INTO recording, which triggers the ready ding. */
            const enteringRecording = st === "recording" && !this.alwaysOnRecording;
            this.alwaysOnRecording = st === "recording";
            if (st === "disabled") {
               /* Server turned us off (60s no-audio auto-disable, or the echo of our own
                  disable). If our latch is still up it was unsolicited -> tear down + clear
                  the resume so we don't fight it on reconnect. */
               if (this.continuousOn) {
                  this.continuousOn = false;
                  this.resumeContinuous = false;
                  this.mic.continuousStop();
               }
            } else if (this.continuousOn) {
               /* Ready ding: replaces DAWN's dropped spoken greeting. Once per wake (guarded
                  by the transition), and safe to play into the open mic - a pure tone isn't
                  VAD-scored as speech, so it can't re-trigger the echo stall. */
               if (enteringRecording) {
                  this.ding.play();
                  this.voiceWake?.(); // a wake-word match: wake the standby screensaver
               }
               /* Re-evaluate the mute on every micro-state transition: unmute entering
                  "recording" (capture the command), and let the speaking/tail logic re-mute
                  for "processing" + the reply. The cooldown means this can't reopen mid-reply
                  the way a bare unmute would. */
               this.updateMicMute();
            }
            break;
         }
      }
   }

   getMicControl(): MicControl {
      return {
         available: () => this.mic.available,
         pttStart: () => this.mic.pttStart(),
         pttCommit: () => this.mic.pttCommit(),
         pttEnd: () => this.mic.pttEnd(),
         pttCancel: () => this.mic.pttCancel(),
         toggleContinuous: () => this.toggleContinuous(),
         onState: (cb) => {
            this.micStateListener = cb;
            cb(this.lastMicState);
         },
         listDevices: () => this.mic.listDevices(),
         currentDevice: () => this.mic.getDevice(),
         setDevice: (id) => {
            this.mic.setDevice(id);
            /* Apply immediately if continuous is latched: move the capture to the new device,
               here only. DAWN's always-on context keeps running (the stream stays 48 kHz, like
               the echo mute's encoder reset). Turning DAWN's listening off and on would race its
               "disabled" reply, which lands after the re-latch and reads as DAWN turning it off. */
            if (this.continuousOn) {
               this.mic.continuousStop();
               this.mic
                  .continuousStart(this.dawnSpeaking || this.tts.isSpeaking())
                  .catch((e: unknown) =>
                     console.warn("[dawn] continuous listening failed to start:", e)
                  );
            }
         }
      };
   }

   private emitMicState(s: MicCaptureState): void {
      this.lastMicState = s;
      this.micStateListener(s);
   }

   /* Tap-to-latch continuous listening. A deliberate, user-initiated write (same sanctioned
      class as chat submit): it turns on DAWN's server-side VAD + wake word. */
   private toggleContinuous(): void {
      if (this.continuousOn) this.stopContinuous(true);
      else this.startContinuous();
   }

   private startContinuous(): void {
      if (this.continuousOn || !this.mic.available || this.ws?.readyState !== WebSocket.OPEN)
         return;
      this.continuousOn = true;
      /* Never inherit a stale recording flag across a re-arm/reconnect: a stale-true errs
         UNSAFE (it force-holds the mic open -> DAWN's own voice echoes) until the next
         always_on_state frame resets it. A fresh latch always starts not-recording. */
      this.alwaysOnRecording = false;
      this.resumeContinuous = true; // survive a reconnect
      /* Enable BEFORE streaming so DAWN sets up its always-on context first; sample_rate is
         the constant 48000 (its VAD decimation divides by it - reporting the ctx rate would
         degrade wake detection). */
      this.send({ type: "always_on_enable", payload: { sample_rate: 48000 } });
      /* Seed the echo mute: latching while DAWN is mid-reply (speaking or audio still
         playing) must not capture its voice. updateMicMute drives it after this. */
      this.mic
         .continuousStart(this.dawnSpeaking || this.tts.isSpeaking())
         .catch((e: unknown) => console.warn("[dawn] continuous listening failed to start:", e));
   }

   /* userInitiated: a tap-off / auto-unlatch clears the resume flag; a transient teardown
      (server auto-disable, error) leaves it so a reconnect can re-establish. */
   private stopContinuous(userInitiated: boolean): void {
      if (!this.continuousOn) return;
      this.continuousOn = false;
      this.alwaysOnRecording = false;
      if (userInitiated) this.resumeContinuous = false;
      window.clearTimeout(this.micMuteCooldown);
      this.micMuteCooldown = 0;
      this.mic.continuousStop(); // synchronous: releases the mic and emits idle
      this.send({ type: "always_on_disable" });
   }

   /* Single echo-mute decision for continuous listening. Muted while DAWN is speaking OR its
      voice is still audibly playing (the buffered tail after state:idle); when both settle,
      a short cooldown holds the mute a beat longer, then reopens the mic. Using DAWN's
      speaking state - which spans the whole reply - closes the inter-sentence gaps that
      per-segment TTS playback alone would leave open. No-op outside continuous mode. */
   updateMicMute(): void {
      if (!this.continuousOn) {
         window.clearTimeout(this.micMuteCooldown);
         this.micMuteCooldown = 0;
         return;
      }
      /* Always-on RECORDING overrides the speaking-mute: nothing may gag the user's command.
         DAWN speaks no greeting while it records (it dropped the "Hello." that once echoed
         into the capture); the only sound here is Aurora's ready ding, a tone DAWN's speech
         detector doesn't take for speech. The browser's echo cancellation stays on for
         anything else. */
      if (this.alwaysOnRecording) {
         window.clearTimeout(this.micMuteCooldown);
         this.micMuteCooldown = 0;
         this.mic.setMuted(false);
         return;
      }
      if (this.dawnSpeaking || this.tts.isSpeaking()) {
         window.clearTimeout(this.micMuteCooldown);
         this.micMuteCooldown = 0;
         this.mic.setMuted(true);
      } else if (this.micMuteCooldown === 0) {
         this.micMuteCooldown = window.setTimeout(() => {
            this.micMuteCooldown = 0;
            this.mic.setMuted(false);
         }, MIC_MUTE_COOLDOWN_MS);
      }
   }

   /* One mic capture chunk -> an AUDIO_IN frame ([0x01][payload]). Voice input is a
      deliberate, user-initiated write, in the same sanctioned class as chat submit. */
   private sendAudioIn(payload: Uint8Array): void {
      /* Hold audio until the session is confirmed: Opus shipped before use_opus is set on
         the (re)connection would be decoded as PCM. In practice a hold is always long
         after `session`, so this only guards the reconnect-mid-utterance edge. */
      if (!this.capsSynced) return;
      const frame = new Uint8Array(1 + payload.byteLength);
      frame[0] = BIN_AUDIO_IN;
      frame.set(payload, 1);
      this.sendBinary(frame);
   }

   /* Final teardown (HMR / unmount). */
   dispose(): void {
      this.mic.dispose();
      this.ding.dispose();
   }
}
