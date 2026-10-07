/*
 * Keep a reflowed email's images in proportion to each other (docs/EMAIL_PANEL_DESIGN.md 6.2).
 * The reader shows mail as markdown, so its layout reflows, but the images keep the sizes the
 * sender gave them. In a reader narrower than the email's design width (newsletters are built at
 * 600-700 px), CSS would shrink only the images wider than the reader and leave the rest at full
 * size. This scales every image by the same factor (reader width / design width), so a banner and
 * the icons beside it keep their proportions. Never enlarges; the CSS max-width cap still applies.
 */

/* The width the email was built at: the outermost layout box that sets a pixel width (a nested
   box can be wider, e.g. a desktop table inside a 600 px frame, and an oversized retina image is
   capped by its box anyway), within a newsletter's range. Images count only when no box says.
   Hidden subtrees (a preheader, an MSO-only block) don't count. 0 = unknown. */
const DESIGN_MIN = 320;
const DESIGN_MAX = 1200;
const BOXES = "table, td, th, div, center";

function pxWidth(el: Element): number {
   const attr = /^\s*(\d+)\s*(px)?\s*$/i.exec(el.getAttribute("width") ?? "");
   const style = /(?:^|;)\s*width\s*:\s*(\d+)px/i.exec(el.getAttribute("style") ?? "");
   const n = Number((attr ?? style)?.[1] ?? 0);
   return n >= DESIGN_MIN && n <= DESIGN_MAX ? n : 0;
}

function hidden(el: Element): boolean {
   for (let e: Element | null = el; e; e = e.parentElement) {
      if (e.hasAttribute("hidden")) return true;
      if (/display\s*:\s*none/i.test(e.getAttribute("style") ?? "")) return true;
   }
   return false;
}

export function designWidth(doc: Document): number {
   let best = 0;
   for (const el of Array.from(doc.querySelectorAll(BOXES))) {
      const w = pxWidth(el);
      if (!w || hidden(el)) continue;
      /* Outermost only: skip a box inside another sized box. */
      let outer = true;
      for (let p = el.parentElement; p; p = p.parentElement) {
         if (p.matches(BOXES) && pxWidth(p)) {
            outer = false;
            break;
         }
      }
      if (outer && w > best) best = w;
   }
   if (best) return best;
   for (const img of Array.from(doc.querySelectorAll("img"))) {
      const w = pxWidth(img);
      if (w > best && !hidden(img)) best = w;
   }
   return best;
}

/* The factor for a reader `available` px wide (1 when it fits, or the design width is unknown). */
export function fitRatio(available: number, design: number): number {
   if (!design || available <= 0 || available >= design) return 1;
   return available / design;
}

/* Apply `ratio` to every image under `root`. A sized image scales from its width/height
   attributes; an unsized one from its loaded size. Each unsized image gets ONE load listener,
   which reads the ratio current when it loads (images are lazy, so that can be much later). */
export function fitImages(root: HTMLElement, ratio: number): void {
   root.dataset.fitRatio = String(ratio);
   for (const img of Array.from(root.querySelectorAll("img"))) {
      const w = Number(img.getAttribute("width")) || 0;
      const h = Number(img.getAttribute("height")) || 0;
      if (w) {
         img.style.width = ratio < 1 ? `${Math.round(w * ratio)}px` : "";
      } else if (h) {
         img.style.height = ratio < 1 ? `${Math.round(h * ratio)}px` : "";
      } else if (img.complete) {
         fitNatural(img, ratio);
      } else if (!img.dataset.fitWatch) {
         img.dataset.fitWatch = "1";
         img.addEventListener("load", () => fitNatural(img, Number(root.dataset.fitRatio) || 1), { once: true });
      }
   }
}

function fitNatural(img: HTMLImageElement, ratio: number): void {
   img.style.width = ratio < 1 && img.naturalWidth ? `${Math.round(img.naturalWidth * ratio)}px` : "";
}
