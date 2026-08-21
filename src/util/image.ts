/*
 * Client-side image compression for conversation attachments. DAWN's /api/images caps at a
 * few MB and the vision path wants a bounded size, so - like the existing WebUI - we downscale
 * to a max edge and re-encode as JPEG before upload. Returns the compressed blob (for the
 * multipart upload) AND its base64 (for the turn frame's live-LLM images[]) so the two always
 * describe the same bytes.
 */

const MAX_DIM = 1024; // longest edge after downscale
const JPEG_QUALITY = 0.85;

export interface CompressedImage {
   blob: Blob;
   base64: string; // bare base64, no data: prefix
   mimeType: string; // always image/jpeg (the re-encode target)
}

export async function compressImage(file: File): Promise<CompressedImage> {
   const src = await loadImage(file);
   const sw = "width" in src ? src.width : 0;
   const sh = "height" in src ? src.height : 0;
   const scale = Math.min(1, MAX_DIM / Math.max(sw, sh || 1));
   const w = Math.max(1, Math.round(sw * scale));
   const h = Math.max(1, Math.round(sh * scale));

   const canvas = document.createElement("canvas");
   canvas.width = w;
   canvas.height = h;
   const ctx = canvas.getContext("2d");
   if (!ctx) throw new Error("no 2d context");
   ctx.drawImage(src, 0, 0, w, h);
   if (src instanceof ImageBitmap) src.close();

   const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
   if (!blob) throw new Error("image encode failed");
   return { blob, base64: await blobToBase64(blob), mimeType: "image/jpeg" };
}

/* Decode to something drawable. Prefer createImageBitmap (honours EXIF orientation), fall
   back to an <img> element (broader format support, some orientation quirks). */
async function loadImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
   if (typeof createImageBitmap === "function") {
      try {
         return await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch {
         /* fall through to the <img> path */
      }
   }
   const url = URL.createObjectURL(file);
   try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
         img.onload = () => resolve();
         img.onerror = () => reject(new Error("image decode failed"));
         img.src = url;
      });
      return img; // fully decoded; the URL can be revoked now (below)
   } finally {
      URL.revokeObjectURL(url);
   }
}

/* Blob -> bare base64 (strip the leading `data:<mime>;base64,`). */
function blobToBase64(blob: Blob): Promise<string> {
   return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
         const s = String(r.result);
         const comma = s.indexOf(",");
         resolve(comma >= 0 ? s.slice(comma + 1) : s);
      };
      r.onerror = () => reject(new Error("base64 encode failed"));
      r.readAsDataURL(blob);
   });
}
