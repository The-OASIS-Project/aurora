# DAWN Hero UI - Architecture

## Overview

DAWN Hero UI is a single-page, vanilla-TypeScript + Vite application. It renders a calm
ambient dashboard from the data DAWN broadcasts over its WebSocket. There is no web
framework by design: the architecture owns a thin, swappable render layer, and a
framework would want to own rendering itself.

## Design goals

- **Ambient and read-mostly.** An instrument you leave running. It consumes DAWN's
  streams and reflects state; it never adds control paths that could depower the
  daemon. The few writes it makes are deliberate user actions (see below).
- **Purpose, not eye candy.** Every moving element encodes a real signal. The center
  reactor is a reinterpretation of DAWN's own ring visualizer: the bars are the voice
  spectrum, the gauges are throughput, the core is conversation state.
- **Calm.** Elements rest at a quiet summary, spike forward on a relevant event, and
  recede. Cool phosphor for nominal, warm amber reserved strictly for "needs you."
- **A render seam that survives a rewrite.** Logic writes abstract coordinates;
  rendering reads them. The CSS-3D renderer today can be swapped for WebGL without
  touching anything above it.

## The four layers

Data flows downward only. Each layer knows only the one below it.

```
ingest  ->  state  ->  choreography  ->  render
```

- **ingest** (`src/ingest/`) is the single boundary to DAWN. An `Ingest` implementation
  feeds four sinks: the store, the reactor, the conversation, and the HUD telemetry.
  `StubIngest` (fake data) and `DawnIngest` (the real WebSocket client) are
  interchangeable; swapping DAWN in is one line in `main.ts`.
- **state** (`src/state/`) is the `Store` of `ElementState`: what is true right now
  (summary, importance, planar position, tone), with zero notion of pixels. `spike()`
  raises importance; `tick()` decays it back toward a floor. That is the whole "spike
  then recede" behavior expressed as pure data.
- **choreography** (`src/choreography/`) turns state into `RenderNode`s: it decides
  depth (back / mid / front tiers, eased), presence, and front-slot contention from
  importance. It is the only place that maps importance to depth.
- **render** (`src/render/`) is the only code that knows what a pixel is. The CSS-3D
  renderer maps depth 0..1 to translateZ + perspective + blur, presence to opacity,
  tone to a palette token.

### The render seam

`src/render/renderer.ts` defines `RenderNode`: `depth` is 0..1 (not translateZ pixels),
`x`/`y` are roughly -1..1 (not left/top), plus `presence`, `emphasis`, `tone`, and a few
panel fields. This is the contract. Nothing above render emits pixels; nothing in render
decides importance or timing. Because the seam is abstract, a WebGL renderer is a later
class swap, not a rewrite. In strict TypeScript, "logic touched a CSS property" is a
compile error, which is the main reason the stack is TypeScript.

## The center reactor (`src/anchor/`)

The one place real 3D earns its keep. Three.js (~137KB gzipped) lives ONLY here and
never crosses the render seam. It is a volumetric reinterpretation of DAWN's SVG ring
visualizer and keeps that signal vocabulary:

- bar ring = voice FFT, driven by the live TTS spectrum while DAWN speaks (an idle
  shimmer otherwise),
- gauge arcs = throughput and hesitation (from `metrics_update`),
- fresnel core = conversation state plus a heartbeat.

The anchor is a full-screen canvas that also holds the drifting particle nebula, so
there is no compositing seam between the background and the reactor. (The bloom pass
outputs opaque black with no alpha, which is why the ground token is pure black by
design.)

## The ingest boundary (`src/ingest/`)

`Ingest` is the seam between DAWN and everything above it. `main.ts` builds the sinks
and calls `ingest.start(sinks)`. `DawnIngest` (`dawn-ws.ts`) owns the WebSocket: login,
session reuse, and translating DAWN's `{type, payload}` frames into sink calls. Which
DAWN signals map to what is documented in `docs/DAWN_UI_SIGNAL_MAP.md`.

The deliberate writes, i.e. the read-mostly exceptions: submitting a chat message,
`set_session_llm` (the model panel), `set_private`, dismissing an alarm
(`scheduler_action`), and `new_conversation` plus final-answer persistence for the UI's
own conversation. Everything else is read.

## Directory structure

```
src/
  main.ts            composition root: wires the layers, runs the one frame loop
  design/tokens.ts   palette + feel, mirrored to CSS custom properties
  ingest/            the DAWN boundary (Ingest, DawnIngest, StubIngest, sinks)
  state/             Store + ElementState
  choreography/      importance -> depth / presence
  render/            css3d renderer, RenderNode contract, panel drag
  anchor/            the Three.js reactor (the only WebGL)
  conversation/      the front window, markdown, and the 3D-lean recede
  audio/             TTS playback + FFT tap to the reactor
  hud/               clock + telemetry readout
  menu/              top menu: panels, display, model, system
  auth/              login panel
  model/             LLM-selection types + effort rules
  styles/            CSS (driven by the design tokens via custom properties)
docs/                the DAWN signal map
```

## Frame loop

`main.ts` runs one `requestAnimationFrame` loop:

```
store.tick(dt)                    // importance decays (the recede)
nodes = choreographer.tick(...)   // state -> coordinates
renderer.render(nodes)            // coordinates -> pixels
anchor.frame(t)                   // the center light
```

The store is polled each frame rather than being an event emitter: a 60fps dashboard
has no use for change-notification plumbing, and polling has no ordering surprises.

## Extending

- **Swap the renderer to WebGL.** Implement `Renderer` against `RenderNode` and wire it
  in `main.ts`. Nothing above the seam changes.
- **Consume a new DAWN signal.** Handle its frame in `DawnIngest` and route it to a sink
  (a store spike, the reactor, the conversation, or telemetry). See the signal map.
- **Add an ambient panel kind.** `store.upsert({ id, kind, ... })`; the renderer is
  data-driven and renders unknown kinds generically.

## Conventions

- Three-space indentation everywhere.
- No em dashes in prose.
- Colors and feel come only from `src/design/tokens.ts` (the single source of truth,
  mirrored to CSS custom properties). Do not hardcode colors in components.
