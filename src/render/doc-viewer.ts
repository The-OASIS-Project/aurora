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
import { renderMarkdown } from "../conversation/format.ts";

export interface DocDownload {
   /* Suggested save name (DAWN-sourced; sanitized before use). */
   filename: string;
   /* Fetch the original bytes, routed through the caller's ingest boundary. */
   fetch: () => Promise<{ blob: Blob; contentType: string }>;
}

export interface DocViewerOpts {
   title: string;
   /* Metadata line under the title (type · size · date · shared, etc.). */
   subtitle?: string;
   /* When present, a Download button in the header fetches + saves the original. Callers
      that only know what is downloadable after an async load pass this null and call
      `setDownload` from `populate` once the text/original resolves. */
   download?: DocDownload;
   /* Fill the body. `stale()` returns true once this viewer was closed or replaced, so an
      async load bails without painting. `setDownload` adds/replaces/removes the header
      Download button (a no-op once stale). Use setDocBodyText / setDocBodyMessage. */
   populate: (body: HTMLElement, stale: () => boolean, setDownload: (dl: DocDownload | null) => void) => void;
}

export interface DocViewerHandle {
   /* Idempotent; only acts while this viewer is still the active one. */
   close(): void;
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
      body.innerHTML = renderMarkdown(text); // sanitized
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
   if (opts.subtitle) {
      const sub = document.createElement("div");
      sub.className = "docview-sub";
      sub.textContent = opts.subtitle;
      titleWrap.append(sub);
   }

   const actions = document.createElement("div");
   actions.className = "docview-actions";
   const closeBtn = document.createElement("button");
   closeBtn.type = "button";
   closeBtn.className = "docview-close";
   closeBtn.setAttribute("aria-label", "Close");
   closeBtn.textContent = "×";
   closeBtn.addEventListener("click", closeCurrent);
   actions.append(closeBtn);

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
      }
   };
   applyDownload(opts.download ?? null);

   head.append(titleWrap, actions);

   const body = document.createElement("div");
   body.className = "docview-body";

   cardEl.append(head, body);
   overlay.append(cardEl);
   overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeCurrent(); // backdrop only, not clicks in the card
   });

   const keyHandler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
         e.preventDefault();
         closeCurrent();
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
   opts.populate(body, stale, setDownload);

   return {
      close: (): void => {
         if (current && current.req === req) closeCurrent();
      }
   };
}
