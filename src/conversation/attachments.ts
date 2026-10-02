/*
 * Conversation attachment markers. DAWN persists images and documents attached to a
 * message as INLINE TEXT MARKERS inside the message body - there is no structured
 * attachments field on the wire, and no `image_url` frame (verified against DAWN source;
 * the signal map's §3.7 `image_url` is an internal LLM content type, never sent to a
 * browser). The markers:
 *
 *   image:    [IMAGE:img_<12 alnum>]                 (or a legacy inline [IMAGE:data:image/...;base64,...]),
 *             counted only in the trailing block of markers at the end of the message
 *   document: [ATTACHED DOCUMENT: <name> (<N> bytes) blob:<blb_id>]\n<extracted text>\n[END DOCUMENT]
 *             (the `blob:<id>` is omitted when no original file was stored server-side)
 *
 * This parses those markers out of a message's text, returning the human text with the
 * markers stripped plus the structured attachments the view renders (thumbnails / chips).
 * Read-only: markers are produced server-side; we only ever consume them here.
 */

export interface ParsedImage {
   /* An image id to fetch from /api/images/<id>, or (legacy) an inline data: URI. */
   ref: string;
   isDataUri: boolean;
}

export interface ParsedDoc {
   filename: string;
   size: number; // bytes, from the marker
   content: string; // the extracted text carried inline
   blobId?: string; // present -> the original file can be downloaded
}

export interface ParsedAttachments {
   text: string; // the message text with all markers removed
   images: ParsedImage[];
   docs: ParsedDoc[];
}

/* One image marker: an uploaded image id, or a legacy inline raster data URI (base64). Matched
   ANCHORED against a single candidate slice only (never scanned across the whole message), so the
   parse stays linear however long or hostile the text is. */
const IMAGE_ONE = /^\[IMAGE:(img_[a-zA-Z0-9]{12}|data:image\/(?:jpeg|jpg|png|gif|webp);base64,[A-Za-z0-9+/]+={0,2})\]$/;
/* One document header line (filename is at most 255 bytes, so the line is bounded). */
const DOC_HEADER = /^\[ATTACHED DOCUMENT:\s*(.+?)\s*\((\d+)\s*bytes\)(?:\s*blob:(blb_[a-zA-Z0-9]{12}))?\]$/;
const DOC_OPEN = "[ATTACHED DOCUMENT:";
const DOC_END = "[END DOCUMENT]";
const MAX_HEADER = 600;

/* Documents: only a LEADING block of well-formed documents at the start of a USER message, which
   is where DAWN puts them (and DAWN defuses any marker inside a body or filename). Anywhere else,
   and in assistant text, a document marker is literal text: it can't forge a chip. Linear: each
   step reads one header line and finds that document's end with indexOf. */
function leadingDocs(text: string): { docs: ParsedDoc[]; rest: string } {
   const docs: ParsedDoc[] = [];
   let i = 0;
   for (;;) {
      let j = i;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (!text.startsWith(DOC_OPEN, j)) break;
      const nl = text.indexOf("\n", j);
      const headerEnd = nl < 0 ? text.length : nl;
      if (headerEnd - j > MAX_HEADER) break;
      const header = DOC_HEADER.exec(text.slice(j, headerEnd));
      if (!header) break;
      let content: string;
      let after: number;
      if (text.startsWith(DOC_END, headerEnd + 1)) {
         content = ""; // "[ATTACHED DOCUMENT: …]\n[END DOCUMENT]"
         after = headerEnd + 1 + DOC_END.length;
      } else {
         const endAt = text.indexOf("\n" + DOC_END, headerEnd + 1);
         if (nl < 0 || endAt < 0) break; // unterminated: not a document
         content = text.slice(headerEnd + 1, endAt);
         after = endAt + 1 + DOC_END.length;
      }
      docs.push({ filename: header[1], size: Number(header[2]), content, blobId: header[3] || undefined });
      i = after;
   }
   return { docs, rest: docs.length ? text.slice(i) : text };
}

/* Images: only the TRAILING block of valid markers at the end of the message (where DAWN appends
   them; DAWN's reload rule too). A marker mid-text, quoted, or inside a document is literal text.
   A backward scan, one marker at a time: linear in the text length. */
function trailingImages(text: string): { images: ParsedImage[]; rest: string } {
   const images: ParsedImage[] = [];
   let rest = text.trimEnd();
   while (rest.endsWith("]")) {
      const at = rest.lastIndexOf("[IMAGE:");
      if (at < 0) break;
      const m = IMAGE_ONE.exec(rest.slice(at));
      if (!m) break;
      images.unshift({ ref: m[1], isDataUri: m[1].startsWith("data:") });
      rest = rest.slice(0, at).trimEnd();
   }
   return { images, rest: images.length ? rest : text };
}

export function parseAttachments(raw: string, role: "user" | "assistant" = "user"): ParsedAttachments {
   const { docs, rest } = role === "user" ? leadingDocs(raw) : { docs: [] as ParsedDoc[], rest: raw };
   const { images, rest: text } = trailingImages(rest);
   return { text: text.trim(), images, docs };
}

/* Only a raster image data URI may reach an <img> src; SVG is excluded (it can carry
   script). Fetched images come back as blobs we object-URL ourselves, so this guards only
   the legacy inline-data path. */
export function isSafeImageDataUri(uri: string): boolean {
   return /^data:image\/(jpeg|jpg|png|gif|webp);/i.test(uri);
}

export function formatBytes(n: number): string {
   if (!n || n < 0) return "";
   if (n < 1024) return `${n} B`;
   if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
   return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function docTypeLabel(filename: string): string {
   const m = /\.([a-z0-9]+)$/i.exec(filename);
   return (m ? m[1] : "doc").toUpperCase();
}

/* Build the OUTBOUND [ATTACHED DOCUMENT] marker block for a turn the user is sending -
   the inverse of the leading-document parse above, and the same shape the existing WebUI emits.
   The daemon persists this text verbatim and the LLM reads the extracted content; on reload
   parseAttachments() turns it back into a chip. `blob:<id>` only when an original is stored. */
export function buildDocMarker(d: { filename: string; size: number; content: string; blobId?: string }): string {
   const blob = d.blobId ? ` blob:${d.blobId}` : "";
   return `[ATTACHED DOCUMENT: ${d.filename} (${d.size} bytes)${blob}]\n${d.content}\n[END DOCUMENT]`;
}
