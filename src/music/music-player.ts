/*
 * The music player (brief: a calm now-playing instrument, not a jukebox). A
 * dedicated interactive view like the conversation console and menu: it renders
 * itself in the machined phosphor language, reflects DAWN's music_state/position,
 * and sends transport back through Ingest.musicControl (a deliberate Tier-C write).
 *
 * The spectrum meter is fed by the music AudioNode's own analyser (per the chosen
 * design), so the center reactor stays voice-only. The view appears when a track
 * is present and fades out when playback is empty.
 */

import type { MusicAudio } from "../audio/music.ts";
import type { MusicState, MusicSink } from "../ingest/ingest.ts";
import { makeMovable } from "../render/movable.ts";

export interface MusicPlayerOptions {
   audio: MusicAudio;
   control: (action: string, params?: Record<string, unknown>) => void;
}

export interface MusicPlayerController extends MusicSink {
   /* Called from the one frame loop: draws the spectrum + interpolates progress. */
   frame(): void;
   /* User show/hide (Panels menu). isVisible is the operator's choice, not whether
      a track is currently playing. */
   isVisible(): boolean;
   setVisible(on: boolean): void;
   destroy(): void;
}

const VIZ_BARS = 24; // spectrum meter bar count
const SVG = "http://www.w3.org/2000/svg";
/* User-facing show/hide, toggled from the Panels menu and persisted. Distinct from
   the track-presence fade (`.on`): this is the operator choosing not to show the
   player at all, so a playing track stays hidden until they re-enable it. */
const VISIBLE_KEY = "dawn.hero.musicShown";

/* Transport glyphs. Solid (filled) for play/pause/skip; hairline (stroked) for the
   mode + volume affordances, matching the rest of the chrome. */
const ICONS: Record<string, { solid?: boolean; paths: string[] }> = {
   play: { solid: true, paths: ["M7 4l13 8-13 8z"] },
   pause: { solid: true, paths: ["M7 4h4v16H7z", "M15 4h4v16h-4z"] },
   prev: { solid: true, paths: ["M8 5v14H6V5z", "M20 5v14l-11-7z"] },
   next: { solid: true, paths: ["M16 5v14h2V5z", "M4 5v14l11-7z"] },
   shuffle: {
      paths: [
         "M17 3l4 4-4 4",
         "M21 7h-4.5a4 4 0 0 0-3.3 1.7l-4.4 6.6A4 4 0 0 1 5.5 17H3",
         "M17 13l4 4-4 4",
         "M3 7h2.5a4 4 0 0 1 3.3 1.7l.7 1"
      ]
   },
   repeat: { paths: ["M17 2l4 4-4 4", "M3 11v-1a4 4 0 0 1 4-4h14", "M7 22l-4-4 4-4", "M21 13v1a4 4 0 0 1-4 4H3"] },
   volume: { paths: ["M11 5 6 9H3v6h3l5 4z", "M15.5 8.5a5 5 0 0 1 0 7", "M18.5 6a9 9 0 0 1 0 12"] },
   mute: { paths: ["M11 5 6 9H3v6h3l5 4z", "M22 9l-6 6", "M16 9l6 6"] }
};

function icon(name: keyof typeof ICONS): SVGSVGElement {
   const def = ICONS[name];
   const svg = document.createElementNS(SVG, "svg");
   svg.setAttribute("viewBox", "0 0 24 24");
   svg.setAttribute("aria-hidden", "true");
   svg.setAttribute("fill", def.solid ? "currentColor" : "none");
   if (!def.solid) {
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "1.7");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
   }
   for (const d of def.paths) {
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
   }
   return svg;
}

function fmtTime(sec: number): string {
   if (!Number.isFinite(sec) || sec < 0) sec = 0;
   const m = Math.floor(sec / 60);
   const s = Math.floor(sec % 60);
   return `${m}:${s.toString().padStart(2, "0")}`;
}

export function mountMusicPlayer(root: HTMLElement, opts: MusicPlayerOptions): MusicPlayerController {
   const el = document.createElement("div");
   el.id = "music";
   el.className = "music";
   for (const c of ["tl", "tr", "bl", "br"]) {
      const corner = document.createElement("span");
      corner.className = `panel-corner ${c}`;
      el.appendChild(corner);
   }

   const canvas = document.createElement("canvas");
   canvas.className = "music-viz";
   const ctx = canvas.getContext("2d");

   const head = document.createElement("div");
   head.className = "music-head";
   const titleEl = document.createElement("div");
   titleEl.className = "music-title";
   const subEl = document.createElement("div");
   subEl.className = "music-sub";
   head.append(titleEl, subEl);

   const seek = document.createElement("div");
   seek.className = "music-seek";
   seek.setAttribute("role", "slider");
   seek.setAttribute("aria-label", "Seek");
   const seekFill = document.createElement("div");
   seekFill.className = "music-seek-fill";
   seek.appendChild(seekFill);

   const times = document.createElement("div");
   times.className = "music-times";
   const curEl = document.createElement("span");
   curEl.className = "music-cur";
   curEl.textContent = "0:00";
   const durEl = document.createElement("span");
   durEl.className = "music-dur";
   durEl.textContent = "0:00";
   times.append(curEl, durEl);

   const controls = document.createElement("div");
   controls.className = "music-controls";
   const mkBtn = (act: string, name: keyof typeof ICONS, label: string, cls = ""): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `music-btn ${cls}`.trim();
      b.dataset.act = act;
      b.setAttribute("aria-label", label);
      b.appendChild(icon(name));
      return b;
   };
   const shuffleBtn = mkBtn("shuffle", "shuffle", "Shuffle", "music-mode");
   const prevBtn = mkBtn("prev", "prev", "Previous");
   const playBtn = mkBtn("playpause", "play", "Play", "music-play");
   const nextBtn = mkBtn("next", "next", "Next");
   const repeatBtn = mkBtn("repeat", "repeat", "Repeat", "music-mode");
   const repeatOne = document.createElement("span");
   repeatOne.className = "music-repeat-one";
   repeatOne.textContent = "1";
   repeatBtn.appendChild(repeatOne);
   controls.append(shuffleBtn, prevBtn, playBtn, nextBtn, repeatBtn);

   const volRow = document.createElement("div");
   volRow.className = "music-vol";
   const muteBtn = mkBtn("mute", "volume", "Mute", "music-mute");
   const vol = document.createElement("input");
   vol.type = "range";
   vol.className = "music-vol-slider";
   vol.min = "0";
   vol.max = "1";
   vol.step = "0.02";
   vol.value = String(opts.audio.getVolume());
   volRow.append(muteBtn, vol);

   el.append(canvas, head, seek, times, controls, volRow);
   root.appendChild(el);

   /* User visibility (Panels menu), persisted. `music-off` force-hides the player
      regardless of the track-presence fade. Defaults to shown. */
   let visible = localStorage.getItem(VISIBLE_KEY) !== "false";
   const applyVisible = (): void => {
      el.classList.toggle("music-off", !visible);
   };
   applyVisible();

   /* Grab-and-move: the player is user-arrangeable, not glued to a corner. Drags
      start anywhere except the interactive controls; position is persisted. */
   const disposeMovable = makeMovable(el, {
      storageKey: "dawn.hero.musicPos",
      ignore: "button, input, .music-seek"
   });

   /* --- state ------------------------------------------------------------- */
   let state: MusicState | null = null;
   let posBase = 0; // last authoritative position (sec)
   let posAt = performance.now(); // when we learned it
   let dur = 0;
   let vizColor = "#62F0E1";
   let errorTimer = 0;

   const readAccent = (): void => {
      const c = getComputedStyle(document.documentElement).getPropertyValue("--accent-glow").trim();
      if (c) vizColor = c;
   };
   readAccent();

   const setPlayGlyph = (): void => {
      const playing = Boolean(state?.playing && !state.paused);
      playBtn.replaceChild(icon(playing ? "pause" : "play"), playBtn.firstChild as Node);
      playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
   };

   const render = (): void => {
      if (!state || !state.track) {
         el.classList.remove("on");
         return;
      }
      el.classList.add("on");
      const t = state.track;
      const title = t.title || "Unknown";
      const sub = [t.artist, t.album].filter(Boolean).join("  •  ");
      if (titleEl.textContent !== title) titleEl.textContent = title;
      if (subEl.textContent !== sub) subEl.textContent = sub;
      dur = state.durationSec;
      durEl.textContent = fmtTime(dur);
      setPlayGlyph();
      shuffleBtn.classList.toggle("active", state.shuffle);
      repeatBtn.classList.toggle("active", state.repeatMode > 0);
      repeatBtn.classList.toggle("one", state.repeatMode === 2);
   };

   /* --- MusicSink --------------------------------------------------------- */
   const setState = (s: MusicState): void => {
      state = s;
      posBase = s.positionSec;
      posAt = performance.now();
      render();
   };
   const setPosition = (positionSec: number, durationSec: number): void => {
      posBase = positionSec;
      posAt = performance.now();
      if (durationSec > 0) dur = durationSec;
   };
   const setError = (message: string): void => {
      subEl.textContent = message;
      subEl.classList.add("error");
      window.clearTimeout(errorTimer);
      errorTimer = window.setTimeout(() => {
         subEl.classList.remove("error");
         render();
      }, 4000);
   };

   /* --- transport --------------------------------------------------------- */
   controls.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>(".music-btn");
      if (!btn) return;
      switch (btn.dataset.act) {
         case "shuffle":
            opts.control("toggle_shuffle");
            break;
         case "prev":
            opts.control("previous");
            break;
         case "playpause":
            /* Three cases, because DAWN streams audio only to the session that
               actively STARTS a track: a bare `play` merely resumes a pause, so on
               a session that never started (a dashboard that just subscribed) it
               no-ops and no audio ever streams here. Start it for real with
               play_index; use bare `play` only to resume an actual pause. */
            if (state?.playing && !state.paused) opts.control("pause");
            else if (state?.paused) opts.control("play");
            else opts.control("play_index", { index: state?.queueIndex ?? 0 });
            break;
         case "next":
            opts.control("next");
            break;
         case "repeat":
            opts.control("cycle_repeat");
            break;
      }
   });

   const seekTo = (clientX: number): void => {
      if (!dur) return;
      const r = seek.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      const target = frac * dur;
      posBase = target; // optimistic; music_position will confirm
      posAt = performance.now();
      seekFill.style.transform = `scaleX(${frac.toFixed(3)})`;
      opts.control("seek", { position_sec: target });
   };
   seek.addEventListener("pointerdown", (e) => seekTo(e.clientX));

   /* Volume: client-side gain immediately, debounced sync to DAWN's stored hint. */
   let volTimer = 0;
   vol.addEventListener("input", () => {
      const v = Number(vol.value);
      opts.audio.setVolume(v);
      muteBtn.classList.toggle("muted", v === 0);
      window.clearTimeout(volTimer);
      volTimer = window.setTimeout(() => opts.control("volume", { level: v }), 150);
   });
   muteBtn.addEventListener("click", () => {
      const next = !opts.audio.isMuted();
      opts.audio.setMuted(next);
      muteBtn.replaceChild(icon(next ? "mute" : "volume"), muteBtn.firstChild as Node);
      muteBtn.classList.toggle("muted", next);
   });

   /* --- per-frame: spectrum + progress ------------------------------------ */
   let lastCur = -1;
   const frame = (): void => {
      if (!visible || !el.classList.contains("on")) return;

      /* Progress: interpolate from the last authoritative position while playing. */
      const playing = Boolean(state?.playing && !state.paused);
      let cur = posBase;
      if (playing) cur = posBase + (performance.now() - posAt) / 1000;
      if (dur > 0) cur = Math.min(cur, dur);
      seekFill.style.transform = `scaleX(${(dur > 0 ? cur / dur : 0).toFixed(4)})`;
      const curWhole = Math.floor(cur);
      if (curWhole !== lastCur) {
         lastCur = curWhole;
         curEl.textContent = fmtTime(cur);
      }

      /* Spectrum meter. */
      if (ctx) drawSpectrum(ctx, canvas, opts.audio.getSpectrum(), vizColor);
   };

   const controller: MusicPlayerController = {
      setState,
      setPosition,
      setError,
      frame,
      isVisible: () => visible,
      setVisible: (on) => {
         visible = on;
         localStorage.setItem(VISIBLE_KEY, on ? "true" : "false");
         applyVisible();
      },
      destroy: () => {
         window.clearTimeout(volTimer);
         window.clearTimeout(errorTimer);
         disposeMovable();
         el.remove();
      }
   };
   return controller;
}

/* Log-scaled bar meter from the analyser's byte-frequency data. Renders quiet bars
   (an at-rest baseline) when there is no signal yet, so it never looks broken. */
function drawSpectrum(
   ctx: CanvasRenderingContext2D,
   canvas: HTMLCanvasElement,
   data: Uint8Array<ArrayBuffer> | null,
   color: string
): void {
   const dpr = window.devicePixelRatio || 1;
   const w = canvas.clientWidth;
   const h = canvas.clientHeight;
   if (w === 0 || h === 0) return;
   if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
   }
   ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
   ctx.clearRect(0, 0, w, h);

   const bins = data?.length ?? 0;
   const gap = 2;
   const bw = (w - gap * (VIZ_BARS - 1)) / VIZ_BARS;
   ctx.fillStyle = color;
   for (let i = 0; i < VIZ_BARS; i++) {
      let v = 0;
      if (data && bins > 0) {
         /* Log-spaced bin range for this bar over the lower ~half of the spectrum,
            where music energy lives. */
         const lo = Math.floor(Math.pow(bins * 0.5, i / VIZ_BARS));
         const hi = Math.max(lo + 1, Math.floor(Math.pow(bins * 0.5, (i + 1) / VIZ_BARS)));
         let peak = 0;
         for (let b = lo; b < hi && b < bins; b++) peak = Math.max(peak, data[b]);
         v = peak / 255;
      }
      const bh = Math.max(1.5, v * h);
      ctx.globalAlpha = 0.35 + v * 0.65;
      ctx.fillRect(i * (bw + gap), h - bh, bw, bh);
   }
   ctx.globalAlpha = 1;
}
