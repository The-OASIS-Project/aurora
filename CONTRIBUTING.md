# Contributing to Aurora

Thanks for your interest. Aurora is part of [The OASIS Project](https://github.com/The-OASIS-Project)
and is licensed under GPLv3 or later, the same as DAWN. This page covers how to build and test a
change, the standards it has to meet, and how a change gets into `main`.

Security problems go through [SECURITY.md](SECURITY.md), not a public issue.

## Build

You need Node.js (the version in [`.nvmrc`](.nvmrc)) and npm. [DEVELOPING.md](DEVELOPING.md) is the
full developer guide, including how to work against built-in fake data without a running DAWN.

```bash
npm ci
npm run dev        # https://localhost:5273
```

## Before you commit

Run the same checks CI runs, before every commit:

```bash
npm run typecheck  # strict TypeScript: the render seam is enforced by the type system
npm test           # the unit tests (vitest)
npm run build      # the production bundle
```

CI also runs CodeQL and an audit of the runtime dependencies. (`./install-git-hooks.sh` installs a
pre-commit hook that runs an optional, untracked `pre-commit.local.hook` for checks of your own; it
doesn't run the commands above.) A change to behaviour should also be
tried in a browser: for audio, the reactor or layout, a visual check is the only check.

## Standards

[ARCHITECTURE.md](ARCHITECTURE.md) is the design; the rules that hold it together:

- **The render seam.** Logic (ingest, state, choreography) writes abstract coordinates through
  `RenderNode`; only `src/render/` knows about pixels or CSS. Dependencies point downward only.
- **One DAWN boundary.** Everything that talks to DAWN lives in `src/ingest/`, and every DAWN URL is
  tagged for Aurora's own login (`dawnUrl()` inside the ingest, `tagDawnUrl()` from
  `src/util/dawn-app.ts` elsewhere).
- **Colors and feel come from `src/design/tokens.ts`.** Never a hardcoded color in a component.
- **Text from outside is text.** Anything that came from DAWN, a user, a mail or a web page reaches
  the page through `textContent`, or through the sanitizing renderers for markdown and mail, never
  `innerHTML`.
- **The user's surface, not the operator's console.** Aurora acts on the user's own data and session.
  It never sends DAWN's operator or admin requests, and a destructive action needs a named
  confirmation from a deliberate user gesture. [CLAUDE.md](CLAUDE.md) lists the requests Aurora makes.
- 3-space indent, and no em dashes in prose.

Some changes have a guide of their own:

- **Using a new DAWN message**: [docs/DAWN_UI_SIGNAL_MAP.md](docs/DAWN_UI_SIGNAL_MAP.md), checked
  against DAWN's [WebSocket protocol](https://github.com/The-OASIS-Project/dawn/blob/main/docs/WEBSOCKET_PROTOCOL.md)
  and its source. A behaviour change on DAWN's side rides a feature flag; the ingest checks it with `hasFeature`.
- **A new per-user browser setting**: add its key to `USER_KEYS` in `src/util/user-state.ts`, so it is
  cleared on logout and when another user signs in.

Add or update tests with the change. Code that parses outside input (DAWN's frames, mail, markdown)
should be tested with hostile input, not only the happy path.

## Commits and pull requests

- `main` is protected: changes arrive by pull request, CI must pass, and pull requests land as merge
  commits.
- One logical change per commit. The message says what changed and why, in plain language a reader
  without your context can follow.
- By contributing you agree to license your contribution under GPLv3 or later.

## How Aurora is developed

Aurora is developed with an AI coding assistant (Claude Code). [CLAUDE.md](CLAUDE.md) holds the rules
it works under: fix problems properly rather than patch around them, verify claims against the code
and DAWN's source, ask before committing. The maintainer reviews and approves every commit, after
trying the change in a browser.

Before a change is handed over it goes through a review step: specialist reviewers run over the diff
(correctness, front-end security, browser runtime and lifecycle, the render-seam architecture, and
for UI changes, design), and each finding is checked against the code before it is acted on. The
Aurora-specific reviewers are defined in [`.claude/agents/`](.claude/agents/); the general ones are
published in [atlas/claude-agents](https://github.com/The-OASIS-Project/atlas/tree/main/claude-agents).
Everything else on this page applies to every change, however it was written.
