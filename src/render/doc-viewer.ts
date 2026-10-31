/*
 * Shared document viewer: one centered reading overlay over a dimmed dashboard,
 * used by BOTH the Library panel (notes + library documents) and the conversation's
 * document chips. It owns the shell - overlay + backdrop, header (title / subtitle,
 * an optional Download button, close), a scrolling body, Esc / backdrop close, a Tab
 * focus trap, and a staleness guard so a slow async load can't paint into a reader
 * that was closed or replaced. The caller supplies a `populate` strategy (fill the
 * body, sync or async) and an optional `download` descriptor.
 *
 * Single global instance: opening a viewer closes any other. This is a modal, so
 * stacking two would be wrong anyway.
 *
 * Security: titles/subtitles are DAWN-sourced and bound via textContent. Body content
 * is untrusted - markdown flows through renderMarkdown (DOMPurify-sanitized) and plain
 * text is set as textContent, never innerHTML. The download name is sanitized before it
 * becomes an anchor `download` attribute.
 */

import { addCorners } from "./corners.ts";
import { renderMarkdown, wireImageGate } from "./markdown.ts";

const gated = new WeakSet<HTMLElement>();

export interface DocDownload {
   /* Suggested save name (DAWN-sourced; sanitized before use). */
   filename: string;
   /* Fetch the original bytes, routed through the caller's ingest boundary. */
   fetch: () => Promise<{ blob: Blob; contentType: string }>;
}

export interface DocEdit {
   /* Persist the edited text. Resolves null on success (the reader re-renders the read view
      with the new text), or a human-readable error string (shown inline; stays in edit mode).
      Routed through the caller's ingest boundary; never throws for an expected failure. */
   save: (text: string) => Promise<string | null>;
   /* How to re-render the saved text back into the read view. Default true (notes and
      reassembled documents are markdown). */
   markdown?: boolean;
}

export interface DocViewerOpts {
   title: string;
   /* Metadata line under the title (type · size · date · shared, etc.). */
   subtitle?: string;
   /* When present, a Download button in the header fetches + saves the original. Callers
      that only know what is downloadable after an async load pass this null and call
      `setDownload` from `populate` once the text/original resolves. */
   download?: DocDownload;
   /* When present, the reader can edit this content. The Edit button only appears once the
      populate strategy calls setEditable(text) with the raw source (immediately for a note,
      after the async text resolves for a document); it stays hidden for content with no
      editable source (a binary-only doc, a conversation attachment). */
   edit?: DocEdit;
   /* Fill the body. `stale()` returns true once this viewer was closed or replaced, so an
      async load bails without painting. `setDownload` adds/replaces/removes the header
      Download button (a no-op once stale). `setEditable(text)` supplies the raw editable
      source and reveals the Edit button (null hides it); no-op unless `edit` was passed and
      once stale. Use setDocBodyText / setDocBodyMessage. */
   populate: (
      body: HTMLElement,
      stale: () => boolean,
      setDownload: (dl: DocDownload | null) => void,
      setEditable: (text: string | null) => void
   ) => void;
}

export interface DocViewerHandle {
   /* Idempotent; only acts while this viewer is still the active one. */
   close(): void;
   /* Replace the subtitle (e.g. its date, after a timezone change); same active-only rule. */
   setSubtitle(text: string): void;
}

/* Append `ext` only when `name` has no extension of its own (a note label, a generated
   doc title). */
export function ensureExt(name: string, ext: string): string {
   const base = (name || "document").trim();
   return /\.[a-z0-9]{1,8}$/i.test(base) ? base : `${base}.${ext}`;
}

/* A Download descriptor that saves in-memory TEXT as a file - for notes and generated
   documents that have readable text but no stored original to fetch. */
export function textDownload(filename: string, text: string, mime = "text/markdown"): DocDownload {
   return {
      filename,
      fetch: () => Promise.resolve({ blob: new Blob([text], { type: mime }), contentType: mime })
   };
}

/* --- body helpers (shared by every caller's populate strategy) ------------- */

/* Render text into the body: markdown (DOMPurify-sanitized) or a plain <pre>. */
export function setDocBodyText(body: HTMLElement, text: string, asMarkdown: boolean): void {
   if (asMarkdown) {
      body.classList.add("markdown");
      body.innerHTML = renderMarkdown(text); // sanitized; off-origin images are click-to-load
      if (!gated.has(body)) {
         gated.add(body); // one listener per body element (it lives and dies with the element)
         wireImageGate(body);
      }
   } else {
      body.classList.remove("markdown");
      const pre = document.createElement("pre");
      pre.className = "docview-plain";
      pre.textContent = text; // untrusted -> textContent, never HTML
      body.replaceChildren(pre);
   }
}

/* Render a short status line (Loading, no preview, ...) into the body. */
export function setDocBodyMessage(body: HTMLElement, msg: string): void {
   body.classList.remove("markdown");
   const p = document.createElement("div");
   p.className = "docview-msg";
   p.textContent = msg;
   body.replaceChildren(p);
}

/* --- the single-instance modal shell --------------------------------------- */

let current: {
   overlay: HTMLElement;
   keyHandler: (e: KeyboardEvent) => void;
   prevFocus: HTMLElement | null;
   req: number;
} | null = null;
let reqSeq = 0;

/* Keep Tab focus inside the open reader. */
function trapTab(e: KeyboardEvent, container: HTMLElement): void {
   const focusables = container.querySelectorAll<HTMLElement>(
      'button, [href], input, [tabindex]:not([tabindex="-1"])'
   );
   if (focusables.length === 0) return;
   const first = focusables[0];
   const last = focusables[focusables.length - 1];
   const active = document.activeElement;
   if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
   } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
   }
}

function closeCurrent(): void {
   if (!current) return;
   const c = current;
   current = null;
   c.req = -1; // any in-flight stale() for this viewer now reads closed
   c.overlay.remove();
   document.removeEventListener("keydown", c.keyHandler);
   c.prevFocus?.focus?.();
}

function buildDownloadButton(dl: DocDownload): HTMLButtonElement {
   const btn = document.createElement("button");
   btn.type = "button";
   btn.className = "docview-download";
   btn.textContent = "Download ↓";
   btn.title = "Download original";
   btn.addEventListener("click", () => {
      btn.disabled = true;
      dl.fetch()
         .then(({ blob }) => {
            /* Object-URL the bytes and download from OUR anchor, so no DAWN URL leaks
               into the view and the endpoint's Content-Disposition is irrelevant. */
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            /* filename is DAWN-sourced: allowlist safe chars for the download name. */
            a.download = (dl.filename || "document").replace(/[^A-Za-z0-9._() -]+/g, "_");
            document.body.append(a);
            a.click();
            a.remove();
            /* Defer the revoke: a synchronous revoke after click() can cancel the
               download in some browsers. */
            window.setTimeout(() => URL.revokeObjectURL(url), 0);
            btn.disabled = false;
         })
         .catch(() => {
            btn.disabled = false;
         });
   });
   return btn;
}

export function openDocViewer(opts: DocViewerOpts): DocViewerHandle {
   closeCurrent();
   const prevFocus = document.activeElement as HTMLElement | null;
   const req = ++reqSeq;

   const overlay = document.createElement("div");
   overlay.className = "docview-overlay";

   const cardEl = document.createElement("div");
   cardEl.className = "docview";
   cardEl.setAttribute("role", "dialog");
   cardEl.setAttribute("aria-modal", "true");
   cardEl.setAttribute("aria-label", opts.title || "Document");
   addCorners(cardEl);

   const head = document.createElement("div");
   head.className = "docview-head";
   const titleWrap = document.createElement("div");
   titleWrap.className = "docview-titlewrap";
   const title = document.createElement("div");
   title.className = "docview-title";
   title.textContent = opts.title || "(untitled)";
   titleWrap.append(title);
   const sub = document.createElement("div");
   sub.className = "docview-sub";
   sub.textContent = opts.subtitle ?? "";
   sub.hidden = !opts.subtitle;
   titleWrap.append(sub);

   const actions = document.createElement("div");
   actions.className = "docview-actions";
   const closeBtn = document.createElement("button");
   closeBtn.type = "button";
   closeBtn.className = "docview-close";
   closeBtn.setAttribute("aria-label", "Close");
   closeBtn.textContent = "×";
   closeBtn.addEventListener("click", () => requestClose());
   actions.append(closeBtn);

   /* Edit-mode flag, declared before applyDownload (which reads it to keep the Download button
      hidden while editing). The rest of the edit state is set up further below. */
   let editing = false;

   /* The Download button lives before the close ×; it can be set at open time and later
      replaced/removed once an async load knows what is downloadable. */
   let dlBtn: HTMLButtonElement | null = null;
   const applyDownload = (dl: DocDownload | null): void => {
      if (dlBtn) {
         dlBtn.remove();
         dlBtn = null;
      }
      if (dl) {
         dlBtn = buildDownloadButton(dl);
         actions.insertBefore(dlBtn, closeBtn);
         if (editing) dlBtn.hidden = true; // stay hidden while editing
      }
   };
   applyDownload(opts.download ?? null);

   head.append(titleWrap, actions);

   const body = document.createElement("div");
   body.className = "docview-body";

   cardEl.append(head, body);
   overlay.append(cardEl);
   const requestClose = (): void => {
      /* While editing, the first close gesture (×, Esc, backdrop) cancels the edit rather
         than the whole reader, so an in-progress edit isn't lost to a fat-fingered dismiss. */
      if (editing) cancelEdit();
      else closeCurrent();
   };
   overlay.addEventListener("click", (e) => {
      if (e.target === overlay) requestClose(); // backdrop only, not clicks in the card
   });

   const keyHandler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
         e.preventDefault();
         requestClose();
      } else if (e.key === "Tab") {
         trapTab(e, cardEl);
      }
   };
   document.addEventListener("keydown", keyHandler);

   document.body.append(overlay);
   current = { overlay, keyHandler, prevFocus, req };
   closeBtn.focus();

   const stale = (): boolean => !current || current.req !== req;
   const setDownload = (dl: DocDownload | null): void => {
      if (!stale()) applyDownload(dl);
   };

   /* --- edit mode ---------------------------------------------------------- */
   /* Raw editable source (null until the populate strategy supplies it via setEditable). The
      Edit button appears only when `edit` was passed AND we have a source AND we are not
      already editing. */
   let editText: string | null = null;
   let saving = false; // a save is in flight: block a mid-save cancel/close teardown
   let editBtn: HTMLButtonElement | null = null;
   let saveBtn: HTMLButtonElement | null = null;
   let cancelBtn: HTMLButtonElement | null = null;
   let editArea: HTMLTextAreaElement | null = null;
   let editErr: HTMLElement | null = null;
   const asMarkdown = (): boolean => opts.edit?.markdown !== false;

   const syncEditBtn = (): void => {
      const want = !!opts.edit && editText !== null && !editing;
      if (want && !editBtn) {
         editBtn = document.createElement("button");
         editBtn.type = "button";
         editBtn.className = "docview-edit";
         editBtn.textContent = "Edit ✎";
         editBtn.title = "Edit";
         editBtn.addEventListener("click", enterEdit);
         actions.insertBefore(editBtn, dlBtn ?? closeBtn); // Edit sits left of Download
      } else if (!want && editBtn) {
         editBtn.remove();
         editBtn = null;
      }
   };

   /* Restore the read view from `editText` (used by both Cancel and a successful Save). */
   function exitEdit(): void {
      editing = false;
      saving = false;
      saveBtn?.remove();
      cancelBtn?.remove();
      saveBtn = cancelBtn = null;
      editArea = editErr = null;
      if (dlBtn) dlBtn.hidden = false;
      body.classList.remove("editing");
      setDocBodyText(body, editText ?? "", asMarkdown());
      syncEditBtn();
   }
   function cancelEdit(): void {
      /* A save in flight has both buttons disabled; the Esc/backdrop/× path routes here too,
         so guard it the same way - don't tear the editor down mid-save (the write would land
         but the reader would revert to the pre-edit text). */
      if (editing && !saving) exitEdit();
   }

   function doSave(): void {
      if (!opts.edit || !saveBtn || !cancelBtn || !editArea || !editErr || saving) return;
      const next = editArea.value;
      saving = true;
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      editErr.hidden = true;
      const fail = (msg: string): void => {
         saving = false;
         if (stale() || !editing || !saveBtn || !cancelBtn || !editErr || !editArea) return;
         editErr.textContent = msg;
         editErr.hidden = false;
         saveBtn.disabled = false;
         cancelBtn.disabled = false;
         editArea.focus();
      };
      opts.edit
         .save(next)
         .then((err) => {
            if (stale() || !editing) return; // reader closed / edit cancelled while saving
            if (err) {
               fail(err);
               return;
            }
            editText = next; // commit, then re-render the read view with the new text
            exitEdit();
         })
         .catch(() => fail("Save failed."));
   }

   function enterEdit(): void {
      if (editing || editText === null || !opts.edit) return;
      const src = editText; // captured: editText is reassigned in nested closures
      editing = true;
      syncEditBtn(); // removes the Edit button (editing is now true)
      if (dlBtn) dlBtn.hidden = true;

      saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "docview-save";
      saveBtn.textContent = "Save";
      saveBtn.addEventListener("click", doSave);
      cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "docview-cancel";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", cancelEdit);
      actions.insertBefore(saveBtn, closeBtn);
      actions.insertBefore(cancelBtn, closeBtn);

      editErr = document.createElement("div");
      editErr.className = "docview-edit-error";
      editErr.hidden = true;
      editArea = document.createElement("textarea");
      editArea.className = "docview-editor";
      editArea.value = src;
      editArea.spellcheck = false;
      body.classList.remove("markdown");
      body.classList.add("editing"); // flex column so the textarea fills the body height
      body.replaceChildren(editErr, editArea);
      editArea.focus();
   }

   const setEditable = (text: string | null): void => {
      if (stale()) return;
      editText = text;
      if (!editing) syncEditBtn();
   };

   opts.populate(body, stale, setDownload, setEditable);

   return {
      close: (): void => {
         if (current && current.req === req) closeCurrent();
      },
      setSubtitle: (text: string): void => {
         if (!current || current.req !== req) return;
         sub.textContent = text;
         sub.hidden = !text;
      }
   };
}
