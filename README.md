# Aurora

A calm, dark, JARVIS-style ambient dashboard for D.A.W.N. (the voice-AI assistant of
The OASIS Project). Panels hover in depth, rest at a quiet summary, spike forward when
something happens, and recede. It is built to sit on a desk-distance monitor and be
pleasant to leave running.

This is **not** a replacement for DAWN's admin/control panel. It is a mostly read-only
consumer of the streams DAWN already broadcasts over its WebSocket. It reads far more
than it writes: the only things it sends are the ones a person deliberately does (send
a message, pick a model, dismiss an alert, start a new conversation).

## What you get

- **The reactor.** A volumetric center piece (real WebGL) that reflects what DAWN is
  doing: it swings through idle / listening / thinking / speaking / error from DAWN's
  own state, its gauges track throughput, and its bar ring is driven by the live voice
  spectrum while DAWN speaks.
- **Conversation.** A frosted, scrollable window that streams DAWN's reply token by
  token as markdown, labels each turn (you vs the assistant's configured name), and
  leans back into the distance when idle so the reactor takes the stage. Hover or type
  to bring it forward.
- **Ambient notices.** Proactive attention, alarms and timers, and background-job
  events surface as panels that spike forward then recede. Tap one to dismiss it.
- **Background jobs.** A live panel of DAWN's running jobs; a finished job's answer
  arrives in the conversation.
- **HUD.** A quiet corner readout: the current model and reasoning effort, token rate,
  latency, context usage, uptime, and a clock in your local time.
- **Model control.** A MODEL menu to set mode / provider / model / reasoning / effort
  for the session, and mark a conversation private.
- **Voice.** DAWN's spoken replies play back (TTS), with a toggle. Microphone input is
  a later phase.

## Requirements

- A running DAWN daemon with the WebUI enabled (default `wss://localhost:3000`).
- Node.js 18+ for development.

This UI runs on a normal PC or laptop, not the Jetson. The full-screen bloom, blur, and
particle field are not a concern on that hardware.

## Run it

```
npm install
npm run dev      # https://localhost:5273
```

`npm run build` typechecks with `tsc` and produces a static bundle in `dist/`.

The dev server runs over **HTTPS** with an auto-generated self-signed cert. This is
required, not cosmetic: the music player decodes audio with WebCodecs and AudioWorklet,
which browsers expose only in a secure context. `localhost` is treated as secure over
http, but opening the dashboard from another machine (`http://<ip>:5273`) is not, so
music would not play there. HTTPS makes every origin secure. Accept the self-signed cert
once per browser (a one-time warning), the same as DAWN's own cert.

The dev server proxies `/api` and `/ws` to the DAWN daemon, so the browser talks to a
single origin (this is what lets the session cookie ride the WebSocket handshake).
Point it at your daemon by editing `DAWN_TARGET` in `vite.config.ts` (default
`https://localhost:3000`). Accept DAWN's cert too, once, by visiting
`https://localhost:3000` directly.

## Connecting

Log in with your DAWN operator credentials on the uplink panel. The UI authenticates as
its own client and keeps its own session; a valid session is reused across reloads, so
a refresh reconnects without asking again.

## Documentation

- `docs/DAWN_UI_SIGNAL_MAP.md` - which DAWN WebSocket signals this UI consumes and what
  each one drives, plus the small backend additions the UI would benefit from.
- `ARCHITECTURE.md` - the four-layer design and the render seam.
- `CLAUDE.md` - guidance for AI assistants working in this repo.

## Part of The OASIS Project

Aurora is a companion front-end for D.A.W.N. See the DAWN repository for the
daemon, the WebSocket protocol, and the rest of the project.
