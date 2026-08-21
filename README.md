# Aurora

Aurora is a next-generation interface for D.A.W.N., the voice assistant at the heart of
The OASIS Project. It's a calm, always-on screen — JARVIS-style — that shows what DAWN is
doing at a glance and lets you talk to it. A glowing reactor at the center comes alive as
DAWN listens, thinks, and speaks; notices, alarms, and jobs drift in when they need you
and fade back when they don't. Made to sit on a monitor and be pleasant to leave running
all day.

## What you get

- **The reactor.** The glowing centerpiece. It shifts as DAWN listens, thinks, speaks, or
  runs into trouble, and its ring dances to DAWN's voice while it talks. Dials around it
  show how hard it's working.
- **Conversation.** Chat with DAWN and watch its reply appear as it's written. Each
  message shows who said it, and the window eases into the background when you're idle,
  then comes forward when you type. Attach images or documents to a message — drop a file
  anywhere on the screen or use the paperclip — and images show up inline while documents
  appear as chips you can open.
- **Context.** Curious why DAWN answered the way it did? Open the Context view to see what
  it pulled in to reply — each source, how relevant it was, and which ones it actually used
  (those light up gold as the answer lands).
- **Voice.** Talk to DAWN and hear it reply out loud. Hold the mic button to speak a
  single request, or tap it to switch on hands-free listening so you can just say the wake
  word whenever you need it. The reactor's ring moves to your voice as you speak, and you
  can mute DAWN's replies anytime.
- **Music.** Play and control your music right from the dashboard — see what's playing,
  skip, seek, shuffle, and repeat, with a visualizer that moves to the sound.
- **Notices.** Reminders, alarms and timers, and heads-ups from DAWN slide in when they
  matter and fade back when they don't. Tap one to dismiss it.
- **Tasks.** See what DAWN is working on in the background; when a job finishes, its answer
  shows up in the conversation.
- **Home Assistant.** See and control your smart home — lights, switches, locks, fans,
  blinds, thermostats — grouped by room and updating the moment anything changes.
- **Calendar.** Your day at a glance: today's events, color-coded by calendar, updating as
  your schedule changes.
- **Library.** Browse your saved notes and documents and open any one to read.
- **Status readout.** A quiet corner with the live details: which AI model is running, how
  quickly it's replying, how much of the conversation it's holding, how long it's been up,
  and a clock in your local time.
- **Model control.** Pick which AI model DAWN uses and how hard it thinks, and mark a
  conversation private.

## Requirements

- A running DAWN with its web interface turned on (default `wss://localhost:3000`).
- A modern web browser (Chrome or Edge work best).
- Node.js 18+ if you're building or developing it.

Aurora has two sides: the machine that runs it and the screen where you watch it. Run it
on anything — a PC, a home server, or the Jetson itself, right next to DAWN — and watch it
in a browser on whatever screen suits you: a laptop, a wall display, or the Jetson's own
screen.

## Run it

```
npm install
npm run dev      # https://localhost:5273
```

`npm run build` typechecks with `tsc` and produces a static bundle in `dist/`.

The dev server runs over **HTTPS** with an auto-generated self-signed cert. This is
required, not cosmetic: the music player needs a secure context to decode audio, and
browsers only grant that over HTTPS (or on `localhost`). Opening the dashboard from
another machine over plain `http://<ip>:5273` won't play music; HTTPS fixes that. Accept
the self-signed cert once per browser (a one-time warning), the same as DAWN's own cert.

The dev server proxies `/api`, `/ws`, and `/music-ws` to DAWN, so the browser talks to a
single address (this is what lets the session cookie ride the WebSocket handshake). Point
it at your daemon by editing `DAWN_TARGET` in `vite.config.ts` (default
`https://localhost:3000`). Accept DAWN's cert too, once, by visiting
`https://localhost:3000` directly.

## Connecting

Log in with your DAWN username and password. Aurora keeps you signed in across refreshes,
so you won't have to log in again every time you reload.

DAWN lives in one place. If you open Aurora in a second tab or window, that one takes over
and the first shows a **"Use DAWN here"** button to bring it back — only one is live at a
time, so your tabs never fight over the connection. Whichever tab you bring live catches up
to the latest of the conversation automatically.

## Documentation

- `docs/DAWN_UI_SIGNAL_MAP.md` - which DAWN signals this UI consumes and what each one
  drives, plus small backend additions the UI would benefit from.
- `ARCHITECTURE.md` - the four-layer design and the render seam.
- `CLAUDE.md` - guidance for AI assistants working in this repo.

## Part of The OASIS Project

Aurora is the face of D.A.W.N. See the DAWN repository for the assistant itself and the
rest of the project.
