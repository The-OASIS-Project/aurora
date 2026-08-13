/*
 * Design tokens: the single source of truth for the visual language.
 *
 * Kris asked for tunable colors so a palette pivot is a one-file change. This is
 * that file. Every color the system draws (CSS panels AND the WebGL anchor) is
 * derived from PALETTE here. At startup applyPalette() mirrors these into CSS
 * custom properties on :root, so stylesheets reference var(--accent) and the
 * anchor shader reads the same numbers. Change a hex here and both follow.
 *
 * The point of view (brief S3.4): a calm observatory instrument, not gamer neon.
 * Deep desaturated blue-black ground so glow reads as light in atmosphere; a
 * restrained phosphor cyan-teal accent at low luminance for at-rest / nominal;
 * warm amber reserved STRICTLY for "needs you". Cool means calm, warm means
 * attention. The palette encodes the state model, it does not decorate it.
 */

export interface Palette {
   /* Ground: the dark the whole scene sits on. Not pure black. */
   ground: string;
   groundRaise: string;

   /* Accent: phosphor cyan-teal. `soft` is the at-rest luminance (present, not
      demanding); `core` is the base; `glow` is the bright spike / light core. */
   accentSoft: string;
   accent: string;
   accentGlow: string;

   /* Energy: warm gold. The hot end of the FFT gradient (peaks flare gold), and
      a secondary warm accent. Distinct from the alert red so "hot" reads as
      energy, not danger. */
   warn: string;
   warnGlow: string;

   /* Alert: red-orange. The ONLY "needs you" color (brief S8), pulled well clear
      of the gold energy so an alert is unmistakable. */
   alert: string;
   alertGlow: string;

   /* Secondary cool hue for the second gimbal gauge ring so the two are not one
      teal. Still cool, still calm, but distinct. `coolGlow` is its bright/hot end (cool
      lifted toward white), the cool-ring analogue of accentGlow - drives the comet head. */
   cool: string;
   coolGlow: string;

   /* Text: low-luminance off-white with a faint teal cast, so it belongs to the
      same light as the accent rather than sitting on top as plain white. The
      three tiers stay above the contrast floor on pure black: `faint` is the
      dimmest and still carries the input placeholder and telemetry labels. */
   text: string;
   textDim: string;
   textFaint: string;
}

export const PALETTE: Palette = {
   /* Pure black on purpose: the WebGL anchor's bloom compositor outputs opaque
      black (it does not preserve alpha), so matching the ground to pure black
      makes the anchor canvas melt in with no visible rectangle. The blue-black
      identity is carried by groundRaise (panels) and the accent, not the void. */
   ground: "#000000",
   groundRaise: "#0B1017",

   accentSoft: "#1E7570",
   accent: "#35C6B9",
   accentGlow: "#62F0E1",

   /* Gold, nudged toward amber-yellow so its hue sits well clear of the alert
      red even when both bloom (energy vs danger must never be confusable). */
   warn: "#F4C24E",
   warnGlow: "#FFD98A",

   alert: "#FF5233",
   alertGlow: "#FF8A6B",

   cool: "#2FB4D6",
   coolGlow: "#97D9EA",

   text: "#CAD7D5",
   textDim: "#8AA09C",
   /* Lifted from a failing ~2.3:1 to ~4.2:1 on black: it is load-bearing (input
      placeholder, telemetry labels), so it must clear the legibility floor while
      staying the dimmest tier. */
   textFaint: "#647875"
};

/*
 * Type scale: the single source of truth for font size, named by ROLE the way the
 * palette is named by role. Every font-size in the stylesheets is one of these steps
 * (mirrored to --fs-* by applyType), so type stays consistent and retunes in one place.
 * rem-based so they follow the responsive html font-size. `label` is floored above the
 * desk-distance legibility limit (~0.7rem); `nano` is reserved for the tiniest meter
 * labels only.
 */
export interface TypeScale {
   nano: string; // tiny meter labels (e.g. the music spectrum readout)
   label: string; // uppercase labels: kind, meta, telemetry, hint
   data: string; // mono data rows: detail, dock sub/list, reply query
   body: string; // panel summary, dock title, input
   lead: string; // the living response, panel/login titles
   display: string; // the clock
}

export const TYPE: TypeScale = {
   nano: "0.5625rem",
   label: "0.7rem",
   data: "0.8rem",
   body: "1rem",
   lead: "1.15rem",
   display: "1.75rem"
};

/* The monospace family for instrument-readout text (data rows, labels, code). One
   source of truth, mirrored to --font-mono like the palette/type, so a font swap is a
   one-line change instead of a grep across every stylesheet. */
export const FONT_MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

/* The anchor canvas occupies this fraction of the smaller viewport dimension.
   Exported so the renderer can derive its panel keep-out from the SAME number
   rather than a duplicated constant that drifts (the reactor's real footprint). */
export const ANCHOR_SIZE_FRAC = 0.66;

/*
 * Motion + depth feel. Also tunable, also renderer-neutral: these are abstract
 * feel constants, not pixel values. The render layer decides how a `depth` of
 * 0..1 becomes translateZ/scale/blur; these govern how quickly things move
 * between states. Recede timing is craft (brief S9.3) and will be tuned here.
 */
export const FEEL = {
   /* Easing rate for a node's depth toward its target, per second. Higher is
      snappier. The spike should read as a deliberate drift, not a snap. */
   depthEase: 3.4,
   /* Easing rate for opacity / emphasis. */
   fadeEase: 4.0,
   /* Seconds the front slot must hold before it can hand off, so simultaneous
      events resolve into a paced sequence rather than a flash (brief S9.1). */
   frontDwell: 2.8
} as const;

/* Convert "#RRGGBB" to normalized [r, g, b] in 0..1 for the WebGL anchor. */
export function hexToRgb01(hex: string): [number, number, number] {
   const h = hex.replace("#", "");
   const n = parseInt(h, 16);
   return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/* Mirror the palette into CSS custom properties so stylesheets and the shader
   share one source of truth. Called once at boot. */
export function applyPalette(p: Palette = PALETTE): void {
   const root = document.documentElement.style;
   root.setProperty("--ground", p.ground);
   root.setProperty("--ground-raise", p.groundRaise);
   root.setProperty("--accent-soft", p.accentSoft);
   root.setProperty("--accent", p.accent);
   root.setProperty("--accent-glow", p.accentGlow);
   root.setProperty("--warn", p.warn);
   root.setProperty("--warn-glow", p.warnGlow);
   root.setProperty("--alert", p.alert);
   root.setProperty("--alert-glow", p.alertGlow);
   root.setProperty("--cool", p.cool);
   root.setProperty("--cool-glow", p.coolGlow);
   root.setProperty("--text", p.text);
   root.setProperty("--text-dim", p.textDim);
   root.setProperty("--text-faint", p.textFaint);
   applyType();
}

/* Mirror the type scale into --fs-* custom properties (same pattern as the palette),
   so the single source of truth for size lives here, not scattered in the CSS. */
export function applyType(t: TypeScale = TYPE): void {
   const root = document.documentElement.style;
   root.setProperty("--fs-nano", t.nano);
   root.setProperty("--fs-label", t.label);
   root.setProperty("--fs-data", t.data);
   root.setProperty("--fs-body", t.body);
   root.setProperty("--fs-lead", t.lead);
   root.setProperty("--fs-display", t.display);
   root.setProperty("--font-mono", FONT_MONO);
}
