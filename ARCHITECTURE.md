# Aurora - Architecture

## Overview

Aurora is a single-page, vanilla-TypeScript + Vite application. It renders a calm
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
  feeds a set of sinks: the four that drive the seam below (store, reactor, conversation,
  HUD telemetry) plus the self-owned interactive views it feeds directly (music, calendar,
  Home Assistant, library, context, notifications, conversation list). `StubIngest` (fake data) and
  `DawnIngest` (the real WebSocket client) are interchangeable; swapping DAWN in is one
  line in `main.ts`.
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

Not everything flows through this seam. Store-backed ambient elements do (they earn depth
and front-slot contention from the choreographer). The standalone interactive views - the
music player, calendar, Home Assistant board, library, context panel, conversation picker,
and the **notification
layer** - are self-owned: ingest feeds each its own sink, and the view owns its DOM and
position directly (see the notification-layer and conventions sections). In the live DAWN
path today nothing drives the store - notices and the jobs card moved to the notification
layer - so the seam is exercised only by `StubIngest`. It remains the spine and the
extension point for any future store-backed panel.

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

## The notification layer (`src/notify/`)

Notices (proactive alerts, ringing alarms, job/observation toasts, and the sticky jobs
card) are NOT store-backed ambient panels. They are self-owned movable cards, fed by the
`notifications` ingest sink and owning their own DOM, position, and lifecycle - so they
snap exactly like the instruments (music/calendar/HA) via `makeMovable`, including the
central dead zone around the reactor (a drop over the atom un-snaps a notice).

Their motion is a self-contained importance model, ticked from the frame loop and kept
orthogonal to `makeMovable`: `makeMovable` owns X/Y (placement), the model owns Z / blur /
opacity (translateZ + depth-of-field blur + presence). A notice spikes forward, holds,
then recedes into depth as its importance decays - the same "spike then recede" the store
does, reimplemented here because one card cannot be positioned by both `makeMovable` and
the choreographer at once. Front-slot contention (with severity preemption so a real alert
jumps ahead), engagement dim (notices recede while the chat input is focused), and a ~60s
hover-resettable toast life all fall out of that model. A notice is transient - a toast
recedes to a visible floor and is then removed; a persist alert settles to a dim float -
until it is SNAPPED, which makes it persistent like an instrument. `prefers-reduced-motion`
drops the depth slide + blur, leaving opacity alone.

## The ingest boundary (`src/ingest/`)

`Ingest` is the seam between DAWN and everything above it. `main.ts` builds the sinks
and calls `ingest.start(sinks)`. `DawnIngest` (`dawn-ws.ts`) owns the WebSocket: login,
session reuse, and translating DAWN's `{type, payload}` frames into sink calls. Which
DAWN signals map to what is documented in `docs/DAWN_UI_SIGNAL_MAP.md`.

The deliberate writes, i.e. the read-mostly exceptions: submitting a chat message,
`set_session_llm` (the model panel), `set_private`, `set_tts_enabled` (a per-connection
voice-mute preference; it also stops DAWN synthesizing each sentence on the LLM-token
thread, so a client-side audio drop alone leaves the reply paced to synthesis speed),
dismissing an alarm
(`scheduler_action`), `new_conversation` plus final-answer persistence for the UI's
own conversation, music transport (`music_subscribe` plus `music_control` from the
player), voice input (the mic streams `AUDIO_IN` / `AUDIO_IN_END` binary frames for
push-to-talk; continuous listening toggles `always_on_enable` / `always_on_disable`), and
the conversation picker's management verbs (`rename_conversation`, `set_pinned`, and the
confirm-gated `delete_conversation`). Music control and voice input are Tier C (they mutate
DAWN) but benign and user-initiated, so they are treated like chat submit, not ambient
control. Picker rename/pin are the same benign class; `delete_conversation` is the one
destructive write (it cascade-deletes the conversation's images + child background jobs
server-side), so it is gated behind a named, cascade-explicit confirm and is reachable only
from a deliberate user gesture. Everything else is read.

## Directory structure

```
src/
  main.ts            composition root: wires the layers, runs the one frame loop
  design/tokens.ts   palette + feel + type scale, mirrored to CSS custom properties
  ingest/            the DAWN boundary (Ingest, DawnIngest, StubIngest, sinks)
  state/             Store + ElementState
  choreography/      importance -> depth / presence
  render/            css3d renderer, RenderNode contract, makeMovable, panel drag
  anchor/            the Three.js reactor (the only WebGL)
  conversation/      the front window, markdown, the 3D-lean recede, and attachment
                     display + the composer's attach/upload (attachments.ts)
  conversation-picker/  the top-band history panel
  context/           the movable "why did it say that" panel (context_injection + gold)
  library/           the movable notes + documents viewer
  notify/            the self-owned movable notification cards + importance model
  music/             the movable music player view
  calendar/          the movable calendar card
  homeassistant/     the movable Home Assistant board
  audio/             TTS playback + FFT tap to the reactor
  hud/               clock + telemetry readout
  menu/              top menu: panels, display, model, system
  auth/              login panel (+ the "another tab took over" takeover card)
  model/             LLM-selection types + effort rules
  util/              small shared helpers (time formatting, image compression, ...)
  styles/            CSS (driven by the design tokens via custom properties)
docs/                the DAWN signal map
```

## Frame loop

`main.ts` runs one `requestAnimationFrame` loop:

```
store.tick(dt)                    // importance decays (the recede)
nodes = choreographer.tick(...)   // state -> coordinates
renderer.render(nodes)            // coordinates -> pixels
notifications.tick(dt)            // notice importance -> depth recede + contention
anchor.frame(t)                   // the center light
```

The store is polled each frame rather than being an event emitter: a 60fps dashboard
has no use for change-notification plumbing, and polling has no ordering surprises.

## Extending

- **Swap the renderer to WebGL.** Implement `Renderer` against `RenderNode` and wire it
  in `main.ts`. Nothing above the seam changes.
- **Consume a new DAWN signal.** Handle its frame in `DawnIngest` and route it to a sink
  (a store spike, the reactor, the conversation, telemetry, or a view sink such as
  `notifications`). See the signal map.
- **Add an ambient panel kind.** `store.upsert({ id, kind, ... })`; the renderer is
  data-driven and renders unknown kinds generically. (For an attention-style card, prefer
  the notification layer's `notify()` instead - see `src/notify/`.)

## Conventions

- Three-space indentation everywhere.
- No em dashes in prose.
- Colors and feel come only from `src/design/tokens.ts` (the single source of truth,
  mirrored to CSS custom properties). Do not hardcode colors in components.
- **Views are user-arrangeable, not glued to a corner.** The standalone interactive views
  (music player, calendar, Home Assistant board) and the notification cards are grab-to-move
  with a persisted position, via `makeMovable` (`src/render/movable.ts`) - all sharing one
  snap set (they snap to each other and the viewport, with a central dead zone around the
  reactor). This is distinct from the store-backed ambient panels, which drag onto the side
  rails through `PanelDrag` (a path only `StubIngest` exercises today). Reserve a fixed
  screen position for fixed HUD chrome (clock, telemetry frame) only.
