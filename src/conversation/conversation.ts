/*
 * The conversation surface (brief S4.1). Two faces of one thing:
 *
 *   - FRONT: a scrollable frosted window in the same language as the panels,
 *     readable up close. Each turn is a labelled block (USER / the AI's name) with
 *     a markdown-rendered body, streamed token-by-token.
 *   - RECEDED: when a turn settles and the pointer leaves, the window leans back
 *     from a fixed bottom edge into a trapezoid (real CSS-3D rotateX), its frame
 *     and far edge fading so only dimmed text remains, tipped into the distance.
 *     The lean-DOWN is slow (a recede); the raise back is quick. It never fully
 *     vanishes; move over it and it rises to front to browse.
 *
 * PASSIVE VIEW on the ingest side: ingest pushes stream/thinking + the assistant's
 * display name; the user's submit/focus are reported out. It owns only
 * presentation timing (the front/recede state machine). It never decides replies.
 */

import type { ActivityStatus, ConversationItem, UploadedDoc } from "../ingest/ingest.ts";
import { addCorners } from "../render/corners.ts";
import { renderMarkdown } from "./format.ts";
import { emojify } from "../util/emoji.ts";
import { attachEmojiPicker } from "./emoji-picker.ts";
import {
   buildDocMarker,
   docTypeLabel,
   formatBytes,
   isSafeImageDataUri,
   parseAttachments,
   type ParsedDoc,
   type ParsedImage
} from "./attachments.ts";

export interface ConversationController {
   setThinking(thinking: boolean): void;
   startReply(): void;
   appendDelta(delta: string): void;
   endReply(): void;
   showReply(text: string): void;
   showUser(text: string): void;
   showToolUse(tools: string[]): void;
   setAssistantName(name: string): void;
   loadHistory(items: ConversationItem[]): void;
   clear(): void;
   setStatus(status: ActivityStatus | null): void;
   destroy(): void;
}

export interface ConversationOptions {
   onSubmit?: (text: string) => void;
   onEngage?: (engaged: boolean) => void;
   /* Fetch an attached image's bytes (routed through ingest -> /api/images/<id>). The view
      object-URLs the blob into a thumbnail. Absent -> images render as a failed placeholder. */
   fetchImage?: (id: string) => Promise<{ blob: Blob; contentType: string }>;
   /* Fetch a document's original file for the download affordance on a doc chip that has a
      stored original (ingest -> /api/documents/original/<blobId>). */
   fetchDocument?: (blobId: string) => Promise<{ blob: Blob; contentType: string }>;
   /* Upload a document the user attached in the composer (ingest -> POST /api/documents).
      Resolves with the extracted text + metadata; absent -> the attach control is hidden. */
   uploadDocument?: (file: File) => Promise<UploadedDoc>;
}

interface Msg {
   role: "user" | "assistant";
   roleEl: HTMLElement;
   body: HTMLElement;
   text: string;
}

const IDLE_MS = 6000; // pointer off the window + settled -> recede
const LONG_IDLE_MS = 45000; // no activity at all -> recede even if hovered/focused
const HOVER_MARGIN = 64; // px slack around the window that still counts as "over"

export function mountConversation(
   root: HTMLElement,
   opts: ConversationOptions = {}
): ConversationController {
   const mount = root.querySelector<HTMLElement>("#convo")!;
   const form = root.querySelector<HTMLFormElement>("#composer")!;
   const input = root.querySelector<HTMLInputElement>("#composer-input")!;
   const composerRow = root.querySelector<HTMLElement>(".composer-row")!;

   /* Activity chip: what DAWN is doing, parked just above the input bar so it sits
      in the eye path where the reply streams in. Driven by setStatus; hidden when
      idle. A live dot + uppercase label, plus a dim detail (e.g. the tool name). */
   const chip = document.createElement("div");
   chip.className = "status-chip";
   chip.setAttribute("aria-live", "polite");
   const chipDot = document.createElement("span");
   chipDot.className = "status-dot";
   const chipLabel = document.createElement("span");
   chipLabel.className = "status-label";
   const chipDetail = document.createElement("span");
   chipDetail.className = "status-detail";
   chip.append(chipDot, chipLabel, chipDetail);
   composerRow.appendChild(chip);

   const win = document.createElement("div");
   win.className = "convo-window empty";
   addCorners(win);
   const scroll = document.createElement("div");
   scroll.className = "convo-scroll";
   win.appendChild(scroll);
   mount.appendChild(win);

   const messages: Msg[] = [];
   let streaming: Msg | null = null;
   let assistantName = "DAWN"; // replaced by the configured ai_name once known
   let active = false;
   let thinking = false;
   let focused = false;
   let hovering = false;
   let shortTimer = 0;
   let longTimer = 0;
   let raf = 0;
   /* Attachment plumbing: object URLs minted for fetched images (revoked on clear /
      loadHistory / destroy so a long session doesn't leak them), plus the one open
      image-lightbox / doc-viewer overlay. */
   const objectUrls: string[] = [];
   let overlay: HTMLElement | null = null;
   let overlayKey: ((e: KeyboardEvent) => void) | null = null;

   /* Instant by default (token streaming pins to the bottom every frame; smooth there
      would lag). Pass smooth for the discrete settles - raising from receded, a finished
      reply - where the overflow/scrollbar change would otherwise snap the scroll (the
      hidden->auto restore re-wraps the text a few px taller, so the bottom jumps). */
   const scrollToEnd = (smooth = false): void => {
      win.scrollTo({ top: win.scrollHeight, behavior: smooth ? "smooth" : "auto" });
   };

   /* --- attachments (inline images + document chips) ----------------------- */

   const revokeObjectUrls = (): void => {
      for (const u of objectUrls) URL.revokeObjectURL(u);
      objectUrls.length = 0;
   };
   const closeOverlay = (): void => {
      if (!overlay) return;
      overlay.remove();
      overlay = null;
      if (overlayKey) document.removeEventListener("keydown", overlayKey);
      overlayKey = null;
   };
   /* A centered modal over a dimmed dashboard (image lightbox / doc-text viewer). Backdrop
      click or Escape closes; only one open at a time. */
   const openOverlay = (content: HTMLElement, label: string): void => {
      closeOverlay();
      const ov = document.createElement("div");
      ov.className = "convo-overlay";
      ov.setAttribute("role", "dialog");
      ov.setAttribute("aria-modal", "true");
      ov.setAttribute("aria-label", label);
      ov.appendChild(content);
      ov.addEventListener("click", (e) => {
         if (e.target === ov) closeOverlay(); // backdrop only, not the content
      });
      overlayKey = (e: KeyboardEvent): void => {
         if (e.key === "Escape") {
            e.preventDefault();
            closeOverlay();
         }
      };
      document.addEventListener("keydown", overlayKey);
      document.body.appendChild(ov);
      overlay = ov;
   };
   const openImageLightbox = (src: string): void => {
      const big = document.createElement("img");
      big.className = "convo-lightbox-img";
      big.src = src; // a blob:/data: URL we already produced + validated
      big.alt = "Attached image";
      openOverlay(big, "Image");
   };
   const openDocViewer = (d: ParsedDoc): void => {
      const card = document.createElement("div");
      card.className = "convo-doc-viewer";
      addCorners(card);
      const h = document.createElement("div");
      h.className = "convo-doc-viewer-head";
      h.textContent = d.filename || "Document"; // DAWN-sourced -> textContent
      const pre = document.createElement("pre");
      pre.className = "convo-doc-viewer-body";
      pre.textContent = d.content; // untrusted extracted text -> textContent, never HTML
      card.append(h, pre);
      openOverlay(card, d.filename || "Document");
   };

   const buildImage = (im: ParsedImage): HTMLElement => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "convo-image";
      btn.setAttribute("aria-label", "Open image");
      const img = document.createElement("img");
      img.className = "convo-image-thumb";
      img.alt = "Attached image";
      img.loading = "lazy";
      btn.appendChild(img);
      btn.addEventListener("click", () => {
         if (img.src) openImageLightbox(img.src);
      });
      if (im.isDataUri) {
         /* Legacy inline data URI: only a validated raster type reaches the src. */
         if (isSafeImageDataUri(im.ref)) img.src = im.ref;
         else btn.classList.add("failed");
      } else if (opts.fetchImage) {
         opts
            .fetchImage(im.ref)
            .then(({ blob }) => {
               const url = URL.createObjectURL(blob); // our own blob: URL -> safe src
               objectUrls.push(url);
               img.src = url;
            })
            .catch(() => btn.classList.add("failed"));
      } else {
         btn.classList.add("failed");
      }
      return btn;
   };

   const downloadDoc = (d: ParsedDoc): void => {
      if (!d.blobId || !opts.fetchDocument) return;
      opts
         .fetchDocument(d.blobId)
         .then(({ blob }) => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            /* filename is DAWN-sourced: strip path separators + control chars first. */
            a.download = (d.filename || "document").replace(/[^A-Za-z0-9._() -]+/g, "_");
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 0); // sync revoke can cancel the download
         })
         .catch(() => {});
   };

   const buildDocChip = (d: ParsedDoc): HTMLElement => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "convo-doc-chip";
      const badge = document.createElement("span");
      badge.className = "convo-doc-type";
      badge.textContent = docTypeLabel(d.filename);
      const name = document.createElement("span");
      name.className = "convo-doc-name";
      name.textContent = d.filename || "document"; // DAWN text -> textContent
      chip.append(badge, name);
      const size = formatBytes(d.size);
      if (size) {
         const s = document.createElement("span");
         s.className = "convo-doc-size";
         s.textContent = size;
         chip.append(s);
      }
      /* A stored original downloads; otherwise the chip opens the extracted text inline. */
      const downloadable = Boolean(d.blobId && opts.fetchDocument);
      chip.title = downloadable ? "Download original" : "View extracted text";
      chip.addEventListener("click", () => (downloadable ? downloadDoc(d) : openDocViewer(d)));
      return chip;
   };

   const renderAttachments = (images: ParsedImage[], docs: ParsedDoc[]): HTMLElement | null => {
      if (images.length === 0 && docs.length === 0) return null;
      const wrap = document.createElement("div");
      wrap.className = "convo-attach";
      if (images.length) {
         const row = document.createElement("div");
         row.className = "convo-images";
         for (const im of images) row.appendChild(buildImage(im));
         wrap.appendChild(row);
      }
      for (const d of docs) wrap.appendChild(buildDocChip(d));
      return wrap;
   };

   const appendMsg = (role: "user" | "assistant", rawText: string): Msg => {
      win.classList.remove("empty");
      const el = document.createElement("div");
      el.className = `convo-msg ${role}`;

      const roleEl = document.createElement("div");
      roleEl.className = "convo-role";
      roleEl.textContent = role === "user" ? "USER" : assistantName;

      /* Split inline attachment markers ([IMAGE:...] / [ATTACHED DOCUMENT:...]) out of the
         text; render the remaining prose, then the thumbnails/chips below it. Markers only
         appear in complete/replayed text (history, showReply/showUser), never mid-stream. */
      const { text, images, docs } = parseAttachments(rawText);

      const body = document.createElement("div");
      body.className = "convo-body";
      if (role === "user") body.textContent = text;
      else body.innerHTML = renderMarkdown(text);
      const attach = renderAttachments(images, docs);
      if (attach) body.appendChild(attach);

      el.append(roleEl, body);
      scroll.appendChild(el);
      const msg: Msg = { role, roleEl, body, text };
      messages.push(msg);
      scrollToEnd();
      return msg;
   };

   /* A tool-call marker: DAWN ran a tool this turn. Rendered as compact on-theme chips
      (a cog glyph + the tool name) rather than the raw tool_use JSON. Tool names are
      DAWN-supplied data, so bind via textContent. Not a conversational turn, so it
      stays out of `messages` (the recede/hover logic keys on real turns). */
   const appendToolChip = (tools: string[]): void => {
      if (!tools.length) return;
      win.classList.remove("empty");
      const row = document.createElement("div");
      row.className = "convo-tools";
      for (const name of tools) {
         const chip = document.createElement("span");
         chip.className = "convo-tool";
         const icon = document.createElement("span");
         icon.className = "convo-tool-icon";
         icon.setAttribute("aria-hidden", "true");
         const label = document.createElement("span");
         label.className = "convo-tool-label";
         label.textContent = name;
         chip.append(icon, label);
         row.appendChild(chip);
      }
      scroll.appendChild(row);
      scrollToEnd();
   };

   /* Streaming markdown: re-render the growing reply at most once per frame so a
      fast token stream does not re-parse per token. */
   const scheduleRender = (): void => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
         raf = 0;
         if (streaming) {
            streaming.body.innerHTML = renderMarkdown(streaming.text);
            scrollToEnd();
         }
      });
   };

   const summon = (): void => {
      if (!active) {
         active = true;
         win.classList.remove("receded");
         scrollToEnd(true); // ease the scrollbar-restore settle as it raises upright
      }
      armIdle();
   };

   const recede = (): void => {
      if (!active || messages.length === 0) return;
      active = false;
      win.classList.add("receded"); // leans back slowly, dims, edges fade - persists
   };

   /* Two countdowns: the short one recedes once the pointer is off the window;
      the long one recedes on total inactivity even while hovered or focused
      (reset by any real activity, which flows through summon()). */
   function armIdle(): void {
      window.clearTimeout(shortTimer);
      window.clearTimeout(longTimer);
      if (thinking || messages.length === 0) return;
      longTimer = window.setTimeout(recede, LONG_IDLE_MS);
      if (!hovering && !focused) shortTimer = window.setTimeout(recede, IDLE_MS);
   }

   /* --- ingest-facing (passive view) --------------------------------------- */

   const setThinking = (t: boolean): void => {
      thinking = t;
      win.classList.toggle("thinking", t);
      if (t) summon();
      else armIdle();
   };

   const startReply = (): void => {
      summon();
      streaming = appendMsg("assistant", "");
      win.classList.remove("thinking");
   };

   const appendDelta = (delta: string): void => {
      if (!streaming) startReply();
      streaming!.text += delta;
      scheduleRender();
      summon();
   };

   const endReply = (): void => {
      if (raf) {
         cancelAnimationFrame(raf);
         raf = 0;
      }
      if (streaming) streaming.body.innerHTML = renderMarkdown(streaming.text);
      streaming = null;
      scrollToEnd(true); // final markdown reflow can change height; ease it, don't snap
      setThinking(false);
   };

   const showReply = (text: string): void => {
      streaming = null;
      appendMsg("assistant", text);
      setThinking(false);
      summon();
   };

   /* A user turn that did NOT originate from the composer here - i.e. a voice
      transcript DAWN sent back. Typed turns are appended locally on submit and deduped
      upstream, so this only carries spoken input. */
   const showUser = (text: string): void => {
      appendMsg("user", text);
      summon();
   };

   const showToolUse = (tools: string[]): void => {
      appendToolChip(tools);
      summon();
   };

   const setAssistantName = (name: string): void => {
      if (!name) return;
      assistantName = name;
      for (const m of messages) {
         if (m.role === "assistant") m.roleEl.textContent = name;
      }
   };

   /* Reflect DAWN's current activity in the chip; null clears it (idle). */
   const setStatus = (status: ActivityStatus | null): void => {
      if (!status) {
         chip.classList.remove("on");
         return;
      }
      chipLabel.textContent = status.label.toUpperCase();
      chipDetail.textContent = status.detail ?? "";
      chip.classList.toggle("has-detail", Boolean(status.detail));
      chip.classList.toggle("alert", status.tone === "alert");
      chip.classList.add("on");
   };

   /* Empty the surface (a tool reset the conversation). */
   const clear = (): void => {
      if (raf) {
         cancelAnimationFrame(raf);
         raf = 0;
      }
      window.clearTimeout(shortTimer);
      window.clearTimeout(longTimer);
      streaming = null;
      thinking = false;
      active = false;
      closeOverlay();
      revokeObjectUrls();
      scroll.replaceChildren();
      messages.length = 0;
      win.classList.remove("thinking", "receded");
      win.classList.add("empty");
      chip.classList.remove("on");
   };

   /* Replace the transcript with a loaded conversation, then show it briefly so
      there is somewhere to start; it recedes on its own after the idle interval. */
   const loadHistory = (items: ConversationItem[]): void => {
      if (raf) {
         cancelAnimationFrame(raf);
         raf = 0;
      }
      streaming = null;
      closeOverlay();
      revokeObjectUrls(); // the outgoing transcript's image URLs are about to be dropped
      scroll.replaceChildren();
      messages.length = 0;
      /* A turn can carry text, a tool chip, or both (spoke then called a tool) - render
         the text first, then its tool chips, preserving transcript order. */
      for (const it of items) {
         if (it.text) appendMsg(it.role, it.text);
         if (it.tools?.length) appendToolChip(it.tools);
      }
      if (messages.length > 0) summon();
   };

   /* --- user-facing -------------------------------------------------------- */

   /* --- composer attachments (documents) ----------------------------------- */
   /* Attaching uploads the doc (DAWN extracts its text) and holds it as pending; on send it
      is inlined into the turn text as an [ATTACHED DOCUMENT] marker (which the daemon
      persists and the LLM reads). Gated on opts.uploadDocument - no upload path, no control.
      A hidden file input + a pending-attachment row above the composer are created here. */
   const attachBtn = root.querySelector<HTMLButtonElement>("#composer-attach");
   let pendingDocs: UploadedDoc[] = [];
   let fileInput: HTMLInputElement | null = null;
   let pendingRow: HTMLElement | null = null;

   const renderPending = (): void => {
      if (!pendingRow) return;
      pendingRow.replaceChildren();
      pendingRow.classList.toggle("shown", pendingDocs.length > 0);
      pendingDocs.forEach((d, i) => {
         const c = document.createElement("span");
         c.className = "composer-pending-chip";
         const badge = document.createElement("span");
         badge.className = "convo-doc-type";
         badge.textContent = docTypeLabel(d.filename);
         const name = document.createElement("span");
         name.className = "composer-pending-name";
         name.textContent = d.filename; // upload echo of the user's own file -> textContent
         const rm = document.createElement("button");
         rm.type = "button";
         rm.className = "composer-pending-remove";
         rm.setAttribute("aria-label", `Remove ${d.filename}`);
         rm.textContent = "×"; // ×
         rm.addEventListener("click", () => {
            pendingDocs.splice(i, 1);
            renderPending();
         });
         c.append(badge, name, rm);
         pendingRow!.appendChild(c);
      });
   };

   /* Accepted document types (images are excluded until the vision-upload contract lands).
      One source for both the picker's `accept` and the drag-drop filter. */
   const DOC_EXTS = ["pdf", "txt", "md", "markdown", "doc", "docx", "csv", "json", "log", "rtf", "odt", "html", "xml"];
   const DOC_EXT_SET = new Set(DOC_EXTS);
   const isDoc = (f: File): boolean => DOC_EXT_SET.has((f.name.split(".").pop() ?? "").toLowerCase());

   const onFilesPicked = (files: File[]): void => {
      if (!opts.uploadDocument || files.length === 0) return;
      attachBtn?.classList.add("busy");
      Promise.allSettled(files.map((f) => opts.uploadDocument!(f)))
         .then((results) => {
            for (const r of results) if (r.status === "fulfilled") pendingDocs.push(r.value);
            renderPending();
            summon();
         })
         .finally(() => attachBtn?.classList.remove("busy"));
   };
   const onAttachClick = (): void => fileInput?.click();
   const onFileChange = (): void => {
      if (fileInput?.files) onFilesPicked(Array.from(fileInput.files));
      if (fileInput) fileInput.value = ""; // let the same file be picked again after removal
   };

   /* Drag-and-drop anywhere in the app as a second attach path. The WINDOW is the drop zone
      (the #console is pointer-events:none, so it can't receive drag events) with a depth
      counter to ride out the dragenter/dragleave flicker as the pointer crosses child
      boundaries. A full-window hint shows while a file is over the page; preventing default on
      dragover+drop also stops the browser navigating to a misdropped file. Only file drags
      are intercepted; non-doc files are filtered out on drop. */
   let dropHint: HTMLElement | null = null;
   let dragDepth = 0;
   const hasFiles = (e: DragEvent): boolean =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
   const onWinDragEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      dragDepth++;
      dropHint?.classList.add("shown");
   };
   const onWinDragOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // allow the drop + block navigation to the file
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
   };
   const onWinDragLeave = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dropHint?.classList.remove("shown");
   };
   const onWinDrop = (e: DragEvent): void => {
      dragDepth = 0;
      dropHint?.classList.remove("shown");
      if (!hasFiles(e)) return;
      e.preventDefault();
      onFilesPicked(Array.from(e.dataTransfer!.files).filter(isDoc));
   };

   if (attachBtn && opts.uploadDocument) {
      fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.multiple = true;
      fileInput.accept = DOC_EXTS.map((e) => `.${e}`).join(",");
      fileInput.hidden = true;
      form.appendChild(fileInput);
      pendingRow = document.createElement("div");
      pendingRow.className = "composer-pending";
      composerRow.parentElement?.insertBefore(pendingRow, composerRow);
      attachBtn.addEventListener("click", onAttachClick);
      fileInput.addEventListener("change", onFileChange);
      dropHint = document.createElement("div");
      dropHint.className = "composer-drop-hint";
      const hintInner = document.createElement("div");
      hintInner.className = "composer-drop-hint-inner";
      hintInner.textContent = "Drop a document to attach";
      dropHint.appendChild(hintInner);
      root.appendChild(dropHint); // full-window overlay (root is #stage)
      window.addEventListener("dragenter", onWinDragEnter);
      window.addEventListener("dragover", onWinDragOver);
      window.addEventListener("dragleave", onWinDragLeave);
      window.addEventListener("drop", onWinDrop);
   } else if (attachBtn) {
      attachBtn.hidden = true; // no upload path wired -> hide the control
   }

   const onSubmit = (e: SubmitEvent): void => {
      e.preventDefault();
      /* Expand any typed-but-not-picked `:shortcode:` so the user's bubble and the
         text DAWN receives both carry the real glyph. */
      const typed = emojify(input.value.trim());
      if (!typed && pendingDocs.length === 0) return;
      /* Inline each attached doc as an [ATTACHED DOCUMENT] marker, then the typed text - the
         same shape DAWN persists + the LLM reads. The user's bubble renders it back as a chip
         via parseAttachments; the daemon persists the whole text (no images -> server save). */
      const markers = pendingDocs.map(buildDocMarker).join("\n");
      const outgoing = markers ? (typed ? `${markers}\n\n${typed}` : markers) : typed;
      input.value = "";
      pendingDocs = [];
      renderPending();
      appendMsg("user", outgoing);
      summon();
      opts.onSubmit?.(outgoing);
   };
   const onInput = (): void => summon(); // typing counts as activity
   const engage = (): void => {
      focused = true;
      summon();
      opts.onEngage?.(true);
   };
   const disengage = (): void => {
      focused = false;
      armIdle();
      opts.onEngage?.(false);
   };

   /* Pointer over the window (with slack) keeps it up or brings it back; leaving
      arms the recede. The transformed (leaned) window still reports a hittable
      box, so hovering the receded text raises it again. */
   const onMove = (e: PointerEvent): void => {
      if (messages.length === 0) return;
      const r = win.getBoundingClientRect();
      const over =
         e.clientX >= r.left - HOVER_MARGIN &&
         e.clientX <= r.right + HOVER_MARGIN &&
         e.clientY >= r.top - HOVER_MARGIN &&
         e.clientY <= r.bottom + HOVER_MARGIN;
      if (over) {
         hovering = true;
         summon();
      } else if (hovering) {
         hovering = false;
         armIdle();
      }
   };

   form.addEventListener("submit", onSubmit);
   input.addEventListener("input", onInput);
   input.addEventListener("focus", engage);
   input.addEventListener("blur", disengage);
   window.addEventListener("pointermove", onMove);

   /* `:shortcode:` autocomplete over the input; anchored to the composer bar
      (position:relative), it owns its own dropdown + keys and is torn down below. */
   const emojiPicker = attachEmojiPicker(input, form);

   return {
      setThinking,
      startReply,
      appendDelta,
      endReply,
      showReply,
      showUser,
      showToolUse,
      setAssistantName,
      loadHistory,
      clear,
      setStatus,
      destroy: () => {
         window.clearTimeout(shortTimer);
         window.clearTimeout(longTimer);
         if (raf) cancelAnimationFrame(raf);
         form.removeEventListener("submit", onSubmit);
         input.removeEventListener("input", onInput);
         input.removeEventListener("focus", engage);
         input.removeEventListener("blur", disengage);
         window.removeEventListener("pointermove", onMove);
         attachBtn?.removeEventListener("click", onAttachClick);
         fileInput?.removeEventListener("change", onFileChange);
         window.removeEventListener("dragenter", onWinDragEnter);
         window.removeEventListener("dragover", onWinDragOver);
         window.removeEventListener("dragleave", onWinDragLeave);
         window.removeEventListener("drop", onWinDrop);
         pendingRow?.remove();
         dropHint?.remove();
         closeOverlay();
         revokeObjectUrls();
         emojiPicker.destroy();
         win.remove();
         chip.remove();
      }
   };
}
