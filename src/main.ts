/*
 * Composition root. Wires the layers together and runs the one frame loop. This
 * is the only place that knows every part exists; each layer knows only the one
 * below it (brief S7, downward-only dependencies):
 *
 *   ingest  ->  state  ->  choreography  ->  render
 *
 * Ingest is a single boundary (src/ingest/ingest.ts) that fans DAWN data out to
 * four sinks: the store, the reactor (anchor), the conversation view, and the
 * HUD telemetry. The fake StubIngest and the real WebSocket client are two
 * implementations of it, so wiring DAWN swaps ONE line below (`new StubIngest`).
 * Nothing else in this file changes. The anchor runs alongside on the same clock.
 */

/* Self-hosted fonts (bundled by Vite, no runtime CDN). Latin subset only, and
   only the weights the UI uses, so we do not ship Cyrillic/Greek we never draw. */
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-400.css";

import "./styles/main.css";
import "./styles/panels.css";
import "./styles/login.css";
import "./styles/convo.css";
import "./styles/model.css";
import "./styles/list-card.css";
import "./styles/music.css";
import "./styles/calendar.css";
import "./styles/homeassistant.css";
import "./styles/library.css";
import "./styles/notifications.css";
import "./styles/dialog.css";
import "./styles/conversations.css";

import { applyPalette } from "./design/tokens.ts";
import {
   applyUiScale,
   formatUiScale,
   getUiScale,
   setUiScale,
   UI_SCALE_DEFAULT,
   UI_SCALE_STEPS
} from "./design/ui-scale.ts";
import { Store } from "./state/store.ts";
import { Choreographer } from "./choreography/choreographer.ts";
import { Css3dRenderer } from "./render/css3d.ts";
import { PanelDrag } from "./render/panel-drag.ts";
import { Anchor } from "./anchor/anchor.ts";
import { DawnIngest } from "./ingest/dawn-ws.ts";
import type { Ingest, MicCaptureState } from "./ingest/ingest.ts";
import { mountHud } from "./hud/hud.ts";
import { mountConversation } from "./conversation/conversation.ts";
import { mountMenu } from "./menu/menu.ts";
import { openDialog } from "./menu/dialog.ts";
import { mountLogin } from "./auth/login-panel.ts";
import { mountMusicPlayer } from "./music/music-player.ts";
import { mountCalendarPanel } from "./calendar/calendar-panel.ts";
import { mountHAPanel } from "./homeassistant/ha-panel.ts";
import { mountLibraryPanel } from "./library/library-panel.ts";
import { mountConversationPicker } from "./conversation-picker/conversation-picker.ts";
import { Notifications } from "./notify/notifications.ts";

/* 1. Design foundation: mirror the palette into CSS custom properties so the
      stylesheets and the anchor shader share one tunable source. */
applyPalette();
/* User's persisted UI-size multiplier, applied before first paint so type/spacing
   settle at the chosen scale with no reflow flash. */
applyUiScale();

/* 2. The layers + views. */
const store = new Store();
const choreographer = new Choreographer();

const field = document.getElementById("field") as HTMLElement;
const docks = document.getElementById("docks") as HTMLElement;
const canvas = document.getElementById("anchor") as HTMLCanvasElement;
const stage = document.getElementById("stage") as HTMLElement;
/* Closing a notification removes it and notifies ingest (a ringing alarm needs a real
   dismiss to DAWN); the hook is assigned once the ingest exists further down. This is
   the × control's handler now, not a tap. */
let notifyDismiss: (id: string) => void = () => {};
const closePanel = (id: string): void => {
   store.remove(id);
   notifyDismiss(id);
};
/* A tap (no drag): notifications do nothing on tap now (× closes, drag docks); a
   non-notification ambient panel still pins on tap. */
const tapPanel = (id: string): void => {
   const el = store.get(id);
   if (!el || el.closeable) return;
   store.togglePin(id);
};
/* A panel dropped off the rails: if it was docked, float it back; a floating one just
   stays floating. */
const floatPanel = (id: string): void => {
   if (store.get(id)?.pinned) store.togglePin(id);
};

const renderer = new Css3dRenderer(
   field,
   docks,
   tapPanel,
   (id, over) => store.setHovered(id, over),
   closePanel
);
const anchor = new Anchor(canvas);
const hud = mountHud(stage);

/* Top-centre settings menu: enable/disable which panels the dashboard shows. */
/* Store-backed ambient panels the Panels menu can enable/disable. The music player
   and calendar card are not here: they are standalone views (mounted below) toggled
   through their own controllers, appended to the Panels list separately. */
const PANEL_LABELS: Record<string, string> = {
   email: "Email",
   subsystems: "Subsystems",
   documents: "Documents"
};
/* Display kill switches double as a profiling tool (bloom is the real GPU cost;
   star field and clouds are cheap but exposed for comparison). Persisted so a chosen
   profile survives a reload; the anchor applies it (below, and on each toggle). */
const DISPLAY_KEY = "aurora.display";
const display = ((): { starfield: boolean; clouds: boolean; bloom: boolean } => {
   const d = { starfield: true, clouds: true, bloom: true };
   try {
      const saved = JSON.parse(localStorage.getItem(DISPLAY_KEY) ?? "{}") as Record<string, unknown>;
      for (const k of Object.keys(d) as (keyof typeof d)[]) {
         if (typeof saved[k] === "boolean") d[k] = saved[k] as boolean;
      }
   } catch {
      /* corrupt/absent -> defaults (all on) */
   }
   return d;
})();
const saveDisplay = (): void => localStorage.setItem(DISPLAY_KEY, JSON.stringify(display));
/* Push the persisted layer state onto the anchor now (its own defaults are all-on, so a
   saved-off layer would otherwise flash on until first toggled). */
anchor.setStarfield(display.starfield);
anchor.setClouds(display.clouds);
anchor.setBloom(display.bloom);
/* TTS toggle is backed by the ingest (DAWN), which exists further down; wired once it
   does. (New Chat now lives in the conversation picker's header, not the System menu.) */
const ttsControl = { get: (): boolean => false, toggle: (): void => {} };

/* 3. Ingest: the single DAWN boundary. Created here (before the menu) so the MODEL
      panel can bind to it; the rest of the app sees only the `Ingest` interface.
      Started at the end, once all four sinks exist. */
const dawn = new DawnIngest();
const ingest: Ingest = dawn;

/* Notification layer: self-owned movable notice cards (they snap like the instruments).
   The x closes a notice and propagates to DAWN (a ringing alarm needs a real dismiss). */
const notifications = new Notifications(stage, (id) => ingest.dismiss(id));

/* The music player: a dedicated interactive view (like the conversation console).
   It reflects DAWN's music_state/position and sends transport through the ingest;
   its spectrum meter reads the music AudioNode's own analyser. Mounted here (before
   the menu) so the Panels menu can bind to its show/hide. */
const musicPlayer = mountMusicPlayer(stage, {
   audio: dawn.getMusicAudio(),
   control: (action, params) => ingest.musicControl(action, params)
});

/* The calendar card: a standalone movable view (like the music player) showing
   today's agenda from DAWN's calendar cache. Read-only; the ingest feeds it the
   calendar map + events and refetches on calendar_events_changed. */
const calendarPanel = mountCalendarPanel(stage);

/* The Home Assistant board: a standalone movable view showing DAWN's HA entity
   snapshot grouped by room, with interactive widgets. The ingest polls HA and feeds it
   the entity set + connection status; manual refresh forces a live re-poll; control
   intents route to ingest.haControl (a deliberate user action -> ha_call_service,
   signal-map §9.4). */
const haPanel = mountHAPanel(stage, {
   onRefresh: () => ingest.refreshHA(),
   onControl: (call) => ingest.haControl(call),
   /* A control fired at a dead/half-open link would silently vanish, so gate the widgets
      on the ingest's heartbeat-backed liveness: block + notify instead of a lying flip. */
   isLive: () => dawn.isLinkLive(),
   notify: (m) => dawn.notifyUser(m)
});

/* The Library panel: a standalone movable view listing DAWN's notes + documents, opening
   any item in a large centered reading overlay. Read-only; the ingest polls doc_library_list
   and the panel fetches a document's original through the ingest (never DAWN directly). */
const libraryPanel = mountLibraryPanel(stage, {
   onRefresh: () => ingest.refreshLibrary(),
   onSearch: (query) => ingest.searchLibrary(query),
   onLoadMore: (offset) => ingest.loadMoreLibrary(offset),
   fetchOriginal: (blobId) => ingest.fetchDocumentOriginal(blobId),
   getFullText: (id) => ingest.getDocumentText(id)
});

/* The conversation picker: fixed menu-band chrome (top band, between the clock and the
   center menu) that lists / searches / opens the user's conversations and does the
   sanctioned conversation writes (new, rename, pin, and confirm-gated delete). It reaches
   DAWN only through the ingest; the ingest feeds it the list + active id + live pushes. */
const conversationPicker = mountConversationPicker(stage, {
   onLoad: (id) => ingest.loadConversation(id),
   onNew: () => ingest.newConversation(),
   onSearch: (query, content) => ingest.searchConversations(query, content),
   onRename: (id, title) => ingest.renameConversation(id, title),
   onDelete: (id) => ingest.deleteConversation(id),
   onPin: (id, pinned) => ingest.setPinned(id, pinned),
   onLoadMore: (offset) => ingest.listConversations({ limit: 50, offset })
});

/* System > About: what this is, the daemon + interface versions, and the project link.
   DAWN's version is feature-detected (shows "—" until the daemon advertises one). */
const openAbout = (): void => {
   const dawnVer = dawn.getConnectionInfo().dawnVersion;
   openDialog({
      title: "D.A.W.N.",
      sub: "The OASIS Project",
      rows: [
         { label: "DAWN", value: dawnVer ? `v${dawnVer}` : "—" },
         { label: "Interface", value: `Aurora v${__APP_VERSION__}` }
      ],
      link: { label: "oasisproject.net", href: "https://oasisproject.net/" }
   });
};

/* System > Connection: live link state, the server the browser talks to, and a
   Disconnect action (drops back to the login overlay via the status stream). */
const openConnection = (): void => {
   const info = dawn.getConnectionInfo();
   const linked = info.status === "connected";
   const statusLabel = linked
      ? "Linked"
      : info.status.charAt(0).toUpperCase() + info.status.slice(1);
   openDialog({
      title: "Connection",
      rows: [
         {
            label: "Status",
            value: statusLabel,
            tone: linked ? "ok" : info.status === "error" ? "alert" : undefined
         },
         { label: "Server", value: info.server },
         ...(info.detail ? [{ label: "Detail", value: info.detail }] : [])
      ],
      actions: linked ? [{ label: "Disconnect", onClick: () => dawn.disconnect(), danger: true }] : []
   });
};

/* System > Microphone: pick the input device voice uses. getUserMedia defaults to the
   system input, which can be the wrong one; this lets the user choose and remembers it.
   Device labels populate only after mic permission has been granted. */
const openMicDevice = async (): Promise<void> => {
   const mic = dawn.getMicControl();
   const [devices, current] = [await mic.listDevices(), mic.currentDevice()];
   openDialog({
      title: "Microphone",
      sub: "Voice input device",
      choices: devices.map((d) => ({ label: d.label, value: d.id, selected: d.id === current })),
      onChoose: (id) => mic.setDevice(id)
   });
};

const menu = mountMenu(stage, {
   onConnection: openConnection,
   onMicDevice: () => void openMicDevice(),
   onAbout: openAbout,
   model: dawn.getModelControl(),
   /* Store-backed panels, plus the standalone calendar + music views appended. */
   getPanels: () => [
      ...store
         .snapshot()
         .filter((e) => PANEL_LABELS[e.id])
         .map((e) => ({ id: e.id, label: PANEL_LABELS[e.id], enabled: e.enabled !== false })),
      { id: "calendar", label: "Calendar", enabled: calendarPanel.isVisible() },
      { id: "homeassistant", label: "Home Assistant", enabled: haPanel.isVisible() },
      { id: "library", label: "Library", enabled: libraryPanel.isVisible() },
      { id: "music", label: "Music", enabled: musicPlayer.isVisible() }
   ],
   onTogglePanel: (id) => {
      if (id === "music") musicPlayer.setVisible(!musicPlayer.isVisible());
      else if (id === "calendar") calendarPanel.setVisible(!calendarPanel.isVisible());
      else if (id === "homeassistant") haPanel.setVisible(!haPanel.isVisible());
      else if (id === "library") libraryPanel.setVisible(!libraryPanel.isVisible());
      else store.toggleEnabled(id);
   },
   displayToggles: [
      {
         label: "Star Field",
         get: () => display.starfield,
         toggle: () => {
            anchor.setStarfield((display.starfield = !display.starfield));
            saveDisplay();
         }
      },
      {
         label: "Nebula Clouds",
         get: () => display.clouds,
         toggle: () => {
            anchor.setClouds((display.clouds = !display.clouds));
            saveDisplay();
         }
      },
      {
         label: "Bloom (glow)",
         get: () => display.bloom,
         toggle: () => {
            anchor.setBloom((display.bloom = !display.bloom));
            saveDisplay();
         }
      }
   ],
   displaySlider: {
      label: "Text Size",
      steps: UI_SCALE_STEPS,
      get: () => getUiScale(),
      format: (v) => formatUiScale(v),
      onChange: (v) => setUiScale(v),
      reset: () => setUiScale(UI_SCALE_DEFAULT)
   }
});

/* Pointer taps and drags for panels: drag to a rail docks (foreground), drop off the
   rails leaves it floating (or floats a docked card back). Reports intent; the store
   resolves. Notifications dock like any panel now. */
const panelDrag = new PanelDrag(stage, {
   onTap: tapPanel,
   onDrop: (id, side, index) => store.dockTo(id, side, index),
   onFloat: floatPanel
});

/* Now that ingest exists, route panel dismissals to it (real alarm dismiss, etc)
   and back the TTS toggle with it. */
notifyDismiss = (id) => ingest.dismiss(id);
ttsControl.get = () => dawn.isTtsEnabled();
ttsControl.toggle = () => dawn.setTtsEnabled(!dawn.isTtsEnabled());

/* Voice (TTS) toggle: a small speaker icon on the composer, next to the mic. It is
   a frequently-reached control, so it lives by the input rather than in a menu.
   Reflects the persisted/live TTS state and drives dawn.setTtsEnabled. */
const ttsBtn = document.getElementById("composer-tts") as HTMLButtonElement;
const paintTts = (): void => {
   const on = ttsControl.get();
   ttsBtn.classList.toggle("tts-off", !on);
   ttsBtn.setAttribute("aria-pressed", on ? "true" : "false");
   ttsBtn.setAttribute("aria-label", on ? "Mute DAWN's voice" : "Unmute DAWN's voice");
};
const onTtsClick = (): void => {
   ttsControl.toggle();
   paintTts();
};
ttsBtn.addEventListener("click", onTtsClick);
paintTts();

/* Voice input: the mic dot on the composer. Hold to speak (push-to-talk); the reactor's
   bar ring lights with your voice while held, and the utterance is sent to DAWN on
   release. A quick tap latches continuous listening (DAWN's wake word). Pointer capture
   keeps the release/cancel on the button even if the pointer drifts off; Space/Enter
   mirror hold-to-talk for the keyboard. */
const micCtl = dawn.getMicControl();
const micBtn = document.getElementById("composer-mic") as HTMLButtonElement;
let micState: MicCaptureState = "idle";
let micHolding = false;
const paintMic = (): void => {
   const rec = micState === "recording";
   const listen = micState === "listening";
   const unavailable = !micCtl.available() || micState === "unavailable";
   micBtn.classList.toggle("recording", rec);
   micBtn.classList.toggle("listening", listen);
   micBtn.classList.toggle("mic-off", unavailable);
   micBtn.disabled = unavailable;
   micBtn.setAttribute("aria-pressed", rec || listen ? "true" : "false");
   micBtn.setAttribute(
      "aria-label",
      unavailable
         ? "Microphone unavailable"
         : rec
           ? "Release to send"
           : listen
             ? "Stop listening"
             : "Hold to speak to DAWN"
   );
};
micCtl.onState((s) => {
   micState = s;
   paintMic();
});
/* One button, two gestures. Capture starts immediately on press (so the first word is
   never clipped) but buffers locally; if the press crosses the hold threshold it is a
   push-to-talk utterance (commit + send on release), and if it is released sooner it was
   a tap (discard the buffer, toggle continuous listening). A hold while continuous is
   latched auto-unlatches it, then runs push-to-talk. */
/* Tap-vs-hold threshold. Measured clicks in a relayed/remote input path land near ~750ms
   (a fixed input-latency floor, not a fast tap), so a click and a short hold are otherwise
   indistinguishable - the cutoff sits at 1000ms so those clicks read as taps (latch
   continuous) and only a deliberate >1s hold is push-to-talk. Capture starts on pointerdown
   regardless (first word kept), so a longer threshold never delays a real hold; it only
   classifies the gesture on release. */
const MIC_HOLD_MS = 1000;
let micHoldTimer = 0;
let micHeld = false; // this gesture crossed the hold threshold (a real utterance)
let micFromListening = false; // the press began while continuous listening was latched
const micHoldStart = (): void => {
   /* Block only while the mic is mid-teardown after a prior PTT (state "recording" but the
      gesture already ended): starting here would arm a "holding" UI over a dropped pttStart.
      A press while idle OR while continuous-listening ("listening") is handled below. */
   if (micBtn.disabled || micHolding || micState === "recording") return;
   micHolding = true;
   micHeld = false;
   micFromListening = micState === "listening";
   if (micFromListening) {
      /* Continuous is on: capture nothing yet. A quick tap turns it OFF; crossing the hold
         threshold auto-unlatches continuous and runs a push-to-talk utterance instead. */
      micHoldTimer = window.setTimeout(() => {
         micHeld = true;
         micCtl.toggleContinuous(); // unlatch (synchronous stop)
         micCtl.pttStart();
         micCtl.pttCommit();
      }, MIC_HOLD_MS);
   } else {
      micCtl.pttStart(); // capture-from-pointerdown (first word kept)
      micHoldTimer = window.setTimeout(() => {
         micHeld = true;
         micCtl.pttCommit();
      }, MIC_HOLD_MS);
   }
};
const micHoldEnd = (): void => {
   if (!micHolding) return;
   micHolding = false;
   window.clearTimeout(micHoldTimer);
   if (micHeld) {
      micCtl.pttEnd(); // a hold (from idle, or after an auto-unlatch) -> send the utterance
   } else if (micFromListening) {
      micCtl.toggleContinuous(); // a tap while listening -> turn continuous OFF
   } else {
      micCtl.pttCancel(); // a tap while idle -> discard the brief capture...
      micCtl.toggleContinuous(); // ...and latch continuous ON
   }
};
const micHoldCancel = (): void => {
   if (!micHolding) return;
   micHolding = false;
   window.clearTimeout(micHoldTimer);
   /* A committed hold that lost the pointer/focus still has valid audio -> send it; an
      uncommitted idle press discarded; an uncommitted listening press left continuous as-is. */
   if (micHeld) micCtl.pttEnd();
   else if (!micFromListening) micCtl.pttCancel();
};
const onMicPointerDown = (e: PointerEvent): void => {
   if (micBtn.disabled) return;
   e.preventDefault();
   micBtn.setPointerCapture(e.pointerId); // so pointerup/cancel land here even off-target
   micHoldStart();
};
const onMicPointerUp = (): void => micHoldEnd();
const onMicPointerCancel = (): void => micHoldCancel();
const onMicKeyDown = (e: KeyboardEvent): void => {
   if (e.repeat || (e.key !== " " && e.key !== "Enter")) return;
   e.preventDefault(); // Space would otherwise scroll
   micHoldStart();
};
const onMicKeyUp = (e: KeyboardEvent): void => {
   if (e.key !== " " && e.key !== "Enter") return;
   micHoldEnd();
};
micBtn.addEventListener("pointerdown", onMicPointerDown);
micBtn.addEventListener("pointerup", onMicPointerUp);
micBtn.addEventListener("pointercancel", onMicPointerCancel);
micBtn.addEventListener("keydown", onMicKeyDown);
micBtn.addEventListener("keyup", onMicKeyUp);
micBtn.addEventListener("blur", onMicPointerCancel); // focus lost mid-hold -> cancel
paintMic();

/* Login overlay: collects credentials, hands them to the ingest, and reflects the
   connection status the ingest reports back. Connect is user-driven, so nothing
   talks to DAWN until the operator logs in. */
const login = mountLogin(stage, {
   onConnect: (username, password) => dawn.connect(username, password),
   onDisconnect: () => dawn.disconnect()
});
dawn.onStatus((status, detail) => login.setStatus(status, detail));

/* If the auth cookie is still valid (e.g. after an F5), reconnect without asking
   for credentials again; otherwise the login card stays up. */
void dawn.tryResume();

/* The conversation view emits user intent to ingest; ingest pushes replies back
   to it. Focus also recedes the ambient field + dims the chrome (S3.3). */
const conversation = mountConversation(stage, {
   onSubmit: (text) => ingest.submit(text),
   onEngage: (engaged) => {
      choreographer.setEngaged(engaged);
      notifications.setEngaged(engaged);
      document.body.classList.toggle("engaged", engaged);
      ingest.setEngaged(engaged);
   }
});

ingest.start({
   store,
   reactor: anchor,
   conversation,
   telemetry: {
      update: (values) => hud.updateTelemetry(values),
      setTimezone: (tz) => hud.setTimezone(tz)
   },
   music: musicPlayer,
   calendar: calendarPanel,
   ha: haPanel,
   library: libraryPanel,
   notifications,
   conversationList: conversationPicker
});

/* 5. Resize: the render layer and anchor own pixels, so they resize; nothing
      above them cares about the viewport. */
function onResize(): void {
   renderer.resize(window.innerWidth, window.innerHeight);
   anchor.resize();
}
window.addEventListener("resize", onResize);

/* 6. The single frame loop. dt clamped so a paused/background tab does not
      resume with a giant jump. */
let last = performance.now();
const start = last;
let running = true;

function frame(now: number): void {
   if (!running) return;
   const dt = Math.min((now - last) / 1000, 0.05);
   last = now;

   store.tick(dt); // state evolves (importance decays: the recede)
   const nodes = choreographer.tick(store.snapshot(), dt); // state -> coordinates
   renderer.render(nodes); // coordinates -> pixels
   notifications.tick(dt); // notice importance -> depth recede + contention + engagement
   anchor.frame((now - start) / 1000); // the center light
   musicPlayer.frame(); // spectrum meter + interpolated progress (when playing)

   requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* 7. Boot cinematic (the cold open, beats 1+2). Let the background nebula linger alone
      for a beat while the chrome sits hidden-but-in-layout (opacity:0, NOT display:none, so
      fonts rasterize, layout settles, and the reactor's Three shaders compile behind the
      still-dark reactor while the frame loop runs) - so the reveal is crisp, not janky. Then
      ignite the reactor, then fade the chrome in over it. Reduced motion skips straight to
      fully-on (frame() forces bootGain to 1; no class, no delay). */
let bootLeadTimer = 0;
let bootRevealTimer = 0;
let bootCleanupTimer = 0;
/* The `boot-intro`/`boot-anim` classes are set on <body> in index.html so the chrome is
   hidden from the very first paint (no item glimmer); this only removes them. */
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
   /* Reduced motion: no cinematic. The chrome-hide is already disabled for this user by the
      motion-OK media query (index.html); drop the classes and hold the reactor fully on. */
   document.body.classList.remove("boot-intro", "boot-anim");
   anchor.startBoot(); // no-op ramp; the reactor is already held fully on
} else {
   const BOOT_LEAD_MS = 1200; // background lingers alone before the reactor ignites (demo cold open)
   const BOOT_REVEAL_MS = 2000; // chrome begins assembling in (reactor well into its ramp, still leading)
   const BOOT_ANIM_MS = 700; // MUST match the .boot-anim chrome fade DURATION in main.css
   const BOOT_STAGGER_MAX_MS = 520; // MUST match the LARGEST .boot-anim transition-delay in main.css (#console)
   bootLeadTimer = window.setTimeout(() => anchor.startBoot(), BOOT_LEAD_MS);
   bootRevealTimer = window.setTimeout(() => document.body.classList.remove("boot-intro"), BOOT_REVEAL_MS);
   /* Drop the temporary intro transition once the LAST staggered tier has finished fading
      (reveal + max stagger delay + fade), so each chrome element returns to its own opacity
      transition (e.g. the console's engage-recede) instead of being snapped mid-fade. */
   bootCleanupTimer = window.setTimeout(
      () => document.body.classList.remove("boot-anim"),
      BOOT_REVEAL_MS + BOOT_STAGGER_MAX_MS + BOOT_ANIM_MS
   );
}

/* Teardown so hot-module reloads (and any future unmount) do not stack WebGL
   contexts, listeners, timers, and rAF loops on top of the old ones. */
function dispose(): void {
   running = false;
   window.removeEventListener("resize", onResize);
   ttsBtn.removeEventListener("click", onTtsClick);
   micBtn.removeEventListener("pointerdown", onMicPointerDown);
   micBtn.removeEventListener("pointerup", onMicPointerUp);
   micBtn.removeEventListener("pointercancel", onMicPointerCancel);
   micBtn.removeEventListener("keydown", onMicKeyDown);
   micBtn.removeEventListener("keyup", onMicKeyUp);
   micBtn.removeEventListener("blur", onMicPointerCancel);
   window.clearTimeout(micHoldTimer); // a hold in progress at teardown leaves a pending one-shot
   window.clearTimeout(bootLeadTimer); // pending boot-cinematic one-shots
   window.clearTimeout(bootRevealTimer);
   window.clearTimeout(bootCleanupTimer);
   ingest.dispose(); // full teardown: also closes the audio graphs so HMR doesn't stack AudioContexts
   conversation.destroy();
   musicPlayer.destroy();
   calendarPanel.destroy();
   haPanel.destroy();
   libraryPanel.destroy();
   conversationPicker.destroy();
   notifications.dispose();
   hud.destroy();
   menu.destroy();
   login.destroy();
   anchor.dispose();
   renderer.dispose();
   panelDrag.dispose();
}
if (import.meta.hot) {
   import.meta.hot.dispose(dispose);
}
