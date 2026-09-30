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

/* Any link kept with target="_blank" also gets rel="noopener noreferrer" so the opened
   page cannot reach window.opener (reverse tabnabbing). DOMPurify already strips
   javascript:/dangerous hrefs; this closes the target hole on older engines too. */
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
   if (node instanceof Element && node.hasAttribute("target")) {
      node.setAttribute("rel", "noopener noreferrer");
   }
   /* A reply's image/link to this origin's DAWN API must carry this app's login tag (DAWN's
      per-app logins), or it loads as the WebUI's login. No-op for any other URL. */
   if (node instanceof Element) {
      for (const attr of ["src", "href"]) {
         const v = node.getAttribute(attr);
         if (v) {
            const tagged = tagIfDawnApi(v);
            if (tagged !== v) node.setAttribute(attr, tagged);
         }
      }
   }
});

/* Render markdown to sanitized HTML. Links open in a new tab (ADD_ATTR target),
   same allowance the existing WebUI makes. */
export function renderMarkdown(text: string): string {
   const html = marked.parse(text, { async: false });
   return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}
