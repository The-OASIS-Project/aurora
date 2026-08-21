/*
 * Conversation attachment markers. DAWN persists images and documents attached to a
 * message as INLINE TEXT MARKERS inside the message body - there is no structured
 * attachments field on the wire, and no `image_url` frame (verified against DAWN source;
 * the signal map's §3.7 `image_url` is an internal LLM content type, never sent to a
 * browser). The markers:
 *
 *   image:    [IMAGE:img_<12 alnum>]                 (or a legacy inline [IMAGE:data:image/...])
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

const IMAGE_MARKER = /\[IMAGE:(img_[a-zA-Z0-9]{12}|data:image\/[^\]]+)\]/g;
/* The whole [ATTACHED DOCUMENT ...] ... [END DOCUMENT] block, content non-greedy so a run
   of documents each match their own block. */
const DOC_MARKER =
   /\[ATTACHED DOCUMENT:\s*(.+?)\s*\((\d+)\s*bytes\)(?:\s*blob:(blb_[a-zA-Z0-9]{12}))?\]\n?([\s\S]*?)\n?\[END DOCUMENT\]/g;

export function parseAttachments(raw: string): ParsedAttachments {
   const images: ParsedImage[] = [];
   const docs: ParsedDoc[] = [];
   let text = raw;

   /* Documents first: the block spans lines and can contain bracket text, so strip the
      full [ATTACHED DOCUMENT ...][END DOCUMENT] span before scanning for image markers. */
   text = text.replace(DOC_MARKER, (_m, filename: string, size: string, blobId: string | undefined, content: string) => {
      docs.push({ filename, size: Number(size), content, blobId: blobId || undefined });
      return "";
   });
   text = text.replace(IMAGE_MARKER, (_m, ref: string) => {
      images.push({ ref, isDataUri: ref.startsWith("data:") });
      return "";
   });

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
   the inverse of the DOC_MARKER parse above, and the same shape the existing WebUI emits.
   The daemon persists this text verbatim and the LLM reads the extracted content; on reload
   parseAttachments() turns it back into a chip. `blob:<id>` only when an original is stored. */
export function buildDocMarker(d: { filename: string; size: number; content: string; blobId?: string }): string {
   const blob = d.blobId ? ` blob:${d.blobId}` : "";
   return `[ATTACHED DOCUMENT: ${d.filename} (${d.size} bytes)${blob}]\n${d.content}\n[END DOCUMENT]`;
}
