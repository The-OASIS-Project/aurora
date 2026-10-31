/*
 * The Mail reader's body pipeline (docs/EMAIL_PANEL_DESIGN.md 6). Email-only on purpose: its
 * own Marked instance and its own DOMPurify instance, sharing nothing with the chat's
 * renderMarkdown (whose global hooks tag same-origin /api URLs with the Aurora login, and whose
 * allowlist keeps images and styles).
 *
 *   HTML mail:  htmlToMarkdown (inert parse, escaped) -> Marked (raw HTML escaped)
 *               -> DOMPurify (strict allowlist + the one image/link choke point) -> fragment
 *   Text mail:  built with createElement/textContent, absolute http(s) URLs linkified.
 *
 * The sanitize hook is the single image guarantee: an <img> keeps its src only when the
 * message's images were shown AND the URL is https; otherwise the src is removed inside
 * DOMPurify's inert document, and the result is parsed in an inert <template> (before anything
 * reaches the page) and the image
 * becomes an alt-text placeholder. Links keep only safe absolute URLs and always open in a new
 * tab with no opener/referrer.
 */

import { Marked } from "marked";
import DOMPurify from "dompurify";
import { htmlToMarkdown, readSize, safeUrl } from "./html-to-md.ts";

const escapeHtml = (s: string): string =>
   s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* Raw HTML tokens are rendered as escaped text: the walker never emits HTML, so any that
   appears came from somewhere it shouldn't. Autolinks (<url> and GFM bare URLs) are off: the
   only links are the ones the walker emitted from a vetted href, and a bare URL in escaped text
   would otherwise be linked with its escape backslashes intact. */
const md = new Marked({
   gfm: true,
   breaks: false,
   renderer: {
      html: ({ text }) => escapeHtml(text)
   },
   tokenizer: {
      url: () => undefined,
      autolink: () => undefined
   }
});

const purify = DOMPurify(window);
const ALLOWED_TAGS = [
   "p",
   "br",
   "h1",
   "h2",
   "h3",
   "h4",
   "h5",
   "h6",
   "strong",
   "em",
   "del",
   "a",
   "ul",
   "ol",
   "li",
   "blockquote",
   "pre",
   "code",
   "hr",
   "table",
   "thead",
   "tbody",
   "tr",
   "th",
   "td",
   "img"
];
const ALLOWED_ATTR = ["href", "src", "alt", "title"];
const FORBID_ATTR = ["style", "srcset", "background", "poster"];

/* Per-call state for the hook (sanitize is synchronous, so a module variable is safe). */
let showImagesNow = false;

purify.addHook("afterSanitizeAttributes", (node) => {
   if (!(node instanceof Element)) return;
   const tag = node.tagName.toLowerCase();
   if (tag === "a") {
      const href = safeUrl(node.getAttribute("href"), "link");
      if (!href) {
         node.removeAttribute("href");
         return;
      }
      node.setAttribute("href", href);
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
      if (!href.startsWith("mailto:")) node.setAttribute("title", new URL(href).hostname);
   } else if (tag === "img") {
      const safe = safeUrl(node.getAttribute("src"), "image");
      /* The sender's intended size (carried through markdown as a fragment), so an icon drawn from
         a big file stays icon-sized; CSS still caps the width to the reader. Set on blocked images
         too, harmlessly (a placeholder replaces them). */
      const sized = safe ? readSize(safe) : null;
      if (sized?.w) node.setAttribute("width", String(sized.w));
      if (sized?.h) node.setAttribute("height", String(sized.h));
      if (sized?.h && !sized.w) node.classList.add("mail-img-h"); // only a height: honour it (CSS)
      const src = sized?.src ?? null;
      if (showImagesNow && src && src.startsWith("https:")) {
         node.setAttribute("src", src);
         node.setAttribute("referrerpolicy", "no-referrer");
         /* Eager (the default): images the user chose to show all load now, so the message
            doesn't reflow under the reader as they scroll in. */
      } else {
         node.removeAttribute("src");
         node.setAttribute("data-blocked", "");
      }
   } else {
      /* Belt and braces: only a and img may carry a URL. */
      node.removeAttribute("href");
      node.removeAttribute("src");
   }
});

/* Replace each blocked <img> with a placeholder showing its alt text, and unwrap any link
   whose URL was refused (it reads as plain text). */
function placeholders(frag: DocumentFragment): void {
   for (const a of Array.from(frag.querySelectorAll("a:not([href])")))
      a.replaceWith(...Array.from(a.childNodes));
   for (const img of Array.from(frag.querySelectorAll("img[data-blocked]"))) {
      const ph = document.createElement("span");
      ph.className = "mail-img-blocked";
      ph.textContent = img.getAttribute("alt") || "Image";
      img.replaceWith(ph);
   }
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/g;

/* Plain-text mail: paragraphs on blank lines, line breaks kept, absolute URLs as links. */
function renderText(text: string): DocumentFragment {
   const frag = document.createDocumentFragment();
   for (const para of text.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const p = document.createElement("p");
      para.split("\n").forEach((line, i) => {
         if (i > 0) p.appendChild(document.createElement("br"));
         let last = 0;
         for (const m of line.matchAll(URL_RE)) {
            const raw = m[0].replace(/[.,;:!?)\]]+$/, "");
            const at = m.index ?? 0;
            const href = safeUrl(raw, "link");
            if (!href) continue;
            if (at > last) p.appendChild(document.createTextNode(line.slice(last, at)));
            const a = document.createElement("a");
            a.href = href;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.title = new URL(href).hostname;
            a.textContent = raw;
            p.appendChild(a);
            last = at + raw.length;
         }
         if (last < line.length) p.appendChild(document.createTextNode(line.slice(last)));
      });
      frag.appendChild(p);
   }
   return frag;
}

export interface RenderedBody {
   fragment: DocumentFragment;
   /* Real remote images in an HTML body (0 for text): drives the "Show images" bar. */
   images: number;
   /* The width the email was designed at, for keeping its images in proportion (0 = unknown). */
   designWidth: number;
}

/* Render one message body. `showImages` = the user pressed Show images for this message. */
export function renderEmailBody(
   body: { html?: string; text: string },
   showImages: boolean
): RenderedBody {
   if (body.html && body.html.trim()) {
      const { markdown, images, designWidth } = htmlToMarkdown(body.html);
      const html = md.parse(markdown, { async: false });
      showImagesNow = showImages;
      let clean: string;
      try {
         clean = purify.sanitize(html, {
            ALLOWED_TAGS,
            ALLOWED_ATTR,
            FORBID_ATTR,
            ALLOW_DATA_ATTR: false
         });
      } finally {
         showImagesNow = false;
      }
      /* Parse the sanitized HTML in an inert <template> (nothing loads or runs there), swap the
         blocked images for placeholders, and hand back its content. */
      const tpl = document.createElement("template");
      tpl.innerHTML = clean;
      const frag = tpl.content;
      placeholders(frag);
      return { fragment: frag, images, designWidth };
   }
   return { fragment: renderText(body.text), images: 0, designWidth: 0 };
}
