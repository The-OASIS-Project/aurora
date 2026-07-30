/*
 * HUD chrome: the fixed "movie OS" framing that sits around the living dashboard
 * and makes it read as a high-tech instrument rather than a few floating labels.
 * This is deliberately STATIC scaffolding, not state-driven elements, so it lives
 * outside the render seam: screen-corner brackets, a live clock + wordmark, a
 * telemetry column, and a rotating reticle framing the reactor.
 *
 * Everything here is low-luminance on purpose (brief S3.4): richness through fine
 * precise detail, not brightness. The reticle ticks and frame are hairlines.
 *
 * Runtime clock/telemetry use new Date()/timers, which is fine in the browser.
 */

const SVGNS = "http://www.w3.org/2000/svg";
const HUD_CACHE_KEY = "dawn.hero.hud"; // last telemetry values, to survive a refresh

export interface HudController {
   /* Ingest pushes telemetry values (keyed by the row's data-tel attribute). */
   updateTelemetry(values: Record<string, string>): void;
   /* Render the clock in a specific IANA timezone (the user's, from DAWN) instead
      of the browser box's local time. Invalid/empty falls back to browser-local. */
   setTimezone(tz: string): void;
   destroy(): void;
}

export function mountHud(root: HTMLElement): HudController {
   buildReticle(root);
   /* Timezone the clock renders in: the DAWN user's, once known; browser-local
      until then (the machine running Chrome may be UTC). */
   let tz: string | undefined;
   const stopClock = startClock(root, () => tz);

   const rows = root.querySelectorAll<HTMLElement>("#hud-status .tel-val");
   const applyRows = (values: Record<string, string>): void => {
      rows.forEach((el) => {
         const key = el.dataset.tel;
         if (key && values[key] !== undefined) el.textContent = values[key];
      });
   };

   /* Cache the last values so a refresh shows them immediately instead of "--"
      until fresh data arrives. Uptime is excluded — it is live and re-syncs within
      a second, and caching it would thrash storage every tick. */
   let cache: Record<string, string> = {};
   try {
      cache = JSON.parse(localStorage.getItem(HUD_CACHE_KEY) ?? "{}") as Record<string, string>;
   } catch {
      cache = {};
   }
   applyRows(cache);

   const updateTelemetry = (values: Record<string, string>): void => {
      applyRows(values);
      let dirty = false;
      for (const [k, v] of Object.entries(values)) {
         if (k === "up") continue;
         if (cache[k] !== v) {
            cache[k] = v;
            dirty = true;
         }
      }
      if (dirty) localStorage.setItem(HUD_CACHE_KEY, JSON.stringify(cache));
   };

   const setTimezone = (zone: string): void => {
      if (!zone) {
         tz = undefined;
         return;
      }
      try {
         new Intl.DateTimeFormat("en-US", { timeZone: zone }); // throws on bad zone
         tz = zone;
      } catch {
         tz = undefined; // keep browser-local
      }
   };

   return {
      updateTelemetry,
      setTimezone,
      destroy: () => stopClock()
   };
}

/* A degree reticle framing the reactor: an outer tick ring that slowly rotates,
   plus four static corner brackets. Built in code so the ticks are exact. */
function buildReticle(root: HTMLElement): void {
   const holder = root.querySelector<HTMLElement>("#reticle");
   if (!holder) return;

   const svg = document.createElementNS(SVGNS, "svg");
   svg.setAttribute("viewBox", "0 0 400 400");
   svg.setAttribute("class", "reticle-svg");

   const cx = 200;
   const cy = 200;

   /* Rotating tick ring. */
   const ring = document.createElementNS(SVGNS, "g");
   ring.setAttribute("class", "reticle-ring");

   const base = document.createElementNS(SVGNS, "circle");
   base.setAttribute("cx", `${cx}`);
   base.setAttribute("cy", `${cy}`);
   base.setAttribute("r", "178");
   base.setAttribute("class", "reticle-circle");
   ring.appendChild(base);

   for (let deg = 0; deg < 360; deg += 5) {
      const long = deg % 30 === 0;
      const r1 = long ? 166 : 172;
      const rad = (deg * Math.PI) / 180;
      const line = document.createElementNS(SVGNS, "line");
      line.setAttribute("x1", `${cx + Math.cos(rad) * r1}`);
      line.setAttribute("y1", `${cy + Math.sin(rad) * r1}`);
      line.setAttribute("x2", `${cx + Math.cos(rad) * 178}`);
      line.setAttribute("y2", `${cy + Math.sin(rad) * 178}`);
      line.setAttribute("class", long ? "reticle-tick long" : "reticle-tick");
      ring.appendChild(line);
   }
   svg.appendChild(ring);
   holder.appendChild(svg);
}

function startClock(root: HTMLElement, getTz: () => string | undefined): () => void {
   const timeEl = root.querySelector<HTMLElement>(".clk-time");
   const dateEl = root.querySelector<HTMLElement>(".clk-date");

   const tick = (): void => {
      const now = new Date();
      const tz = getTz();
      const timeOpts: Intl.DateTimeFormatOptions = {
         hour12: false,
         hour: "2-digit",
         minute: "2-digit",
         second: "2-digit"
      };
      const dateOpts: Intl.DateTimeFormatOptions = {
         weekday: "short",
         day: "2-digit",
         month: "short",
         year: "numeric"
      };
      if (tz) {
         timeOpts.timeZone = tz;
         dateOpts.timeZone = tz;
      }
      if (timeEl) timeEl.textContent = now.toLocaleTimeString("en-GB", timeOpts);
      if (dateEl) dateEl.textContent = now.toLocaleDateString("en-US", dateOpts).toUpperCase();
   };
   tick();
   const id = window.setInterval(tick, 1000);
   return () => window.clearInterval(id);
}
