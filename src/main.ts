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

import { applyPalette } from "./design/tokens.ts";
import { Store } from "./state/store.ts";
import { Choreographer } from "./choreography/choreographer.ts";
import { Css3dRenderer } from "./render/css3d.ts";
import { PanelDrag } from "./render/panel-drag.ts";
import { Anchor } from "./anchor/anchor.ts";
import { DawnIngest } from "./ingest/dawn-ws.ts";
import type { Ingest } from "./ingest/ingest.ts";
import { mountHud } from "./hud/hud.ts";
import { mountConversation } from "./conversation/conversation.ts";
import { mountMenu } from "./menu/menu.ts";
import { mountLogin } from "./auth/login-panel.ts";
import { mountMusicPlayer } from "./music/music-player.ts";
import { mountCalendarPanel } from "./calendar/calendar-panel.ts";
import { mountHAPanel } from "./homeassistant/ha-panel.ts";

/* 1. Design foundation: mirror the palette into CSS custom properties so the
      stylesheets and the anchor shader share one tunable source. */
applyPalette();

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
   star field and clouds are cheap but exposed for comparison). State lives here;
   the anchor just applies it. */
const display = { starfield: true, clouds: true, bloom: true };
/* TTS toggle + New Chat are backed by the ingest (DAWN), which exists further down;
   these hooks are wired once it does. */
const ttsControl = { get: (): boolean => false, toggle: (): void => {} };
const newChatHook = { fire: (): void => {} };

/* 3. Ingest: the single DAWN boundary. Created here (before the menu) so the MODEL
      panel can bind to it; the rest of the app sees only the `Ingest` interface.
      Started at the end, once all four sinks exist. */
const dawn = new DawnIngest();
const ingest: Ingest = dawn;

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
   onControl: (call) => ingest.haControl(call)
});

const menu = mountMenu(stage, {
   onNewChat: () => newChatHook.fire(),
   model: dawn.getModelControl(),
   /* Store-backed panels, plus the standalone calendar + music views appended. */
   getPanels: () => [
      ...store
         .snapshot()
         .filter((e) => PANEL_LABELS[e.id])
         .map((e) => ({ id: e.id, label: PANEL_LABELS[e.id], enabled: e.enabled !== false })),
      { id: "calendar", label: "Calendar", enabled: calendarPanel.isVisible() },
      { id: "homeassistant", label: "Home Assistant", enabled: haPanel.isVisible() },
      { id: "music", label: "Music", enabled: musicPlayer.isVisible() }
   ],
   onTogglePanel: (id) => {
      if (id === "music") musicPlayer.setVisible(!musicPlayer.isVisible());
      else if (id === "calendar") calendarPanel.setVisible(!calendarPanel.isVisible());
      else if (id === "homeassistant") haPanel.setVisible(!haPanel.isVisible());
      else store.toggleEnabled(id);
   },
   displayToggles: [
      {
         label: "Star Field",
         get: () => display.starfield,
         toggle: () => anchor.setStarfield((display.starfield = !display.starfield))
      },
      {
         label: "Nebula Clouds",
         get: () => display.clouds,
         toggle: () => anchor.setClouds((display.clouds = !display.clouds))
      },
      {
         label: "Bloom (glow)",
         get: () => display.bloom,
         toggle: () => anchor.setBloom((display.bloom = !display.bloom))
      }
   ]
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
newChatHook.fire = () => dawn.newChat();

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
   ha: haPanel
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
   anchor.frame((now - start) / 1000); // the center light
   musicPlayer.frame(); // spectrum meter + interpolated progress (when playing)

   requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* Teardown so hot-module reloads (and any future unmount) do not stack WebGL
   contexts, listeners, timers, and rAF loops on top of the old ones. */
function dispose(): void {
   running = false;
   window.removeEventListener("resize", onResize);
   ttsBtn.removeEventListener("click", onTtsClick);
   ingest.stop();
   conversation.destroy();
   musicPlayer.destroy();
   calendarPanel.destroy();
   haPanel.destroy();
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
