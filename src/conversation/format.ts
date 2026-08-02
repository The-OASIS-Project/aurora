/*
 * Markdown rendering for assistant replies, matching the existing WebUI
 * (www/js/ui/format.js): marked with GFM + line breaks, then DOMPurify to sanitize
 * the HTML before it touches the DOM. DAWN's output is trusted-ish, but tool
 * results and web content flow through it, so we sanitize as a matter of course.
 */

import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

/* Any link kept with target="_blank" also gets rel="noopener noreferrer" so the opened
   page cannot reach window.opener (reverse tabnabbing). DOMPurify already strips
   javascript:/dangerous hrefs; this closes the target hole on older engines too. */
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
   if (node instanceof Element && node.hasAttribute("target")) {
      node.setAttribute("rel", "noopener noreferrer");
   }
});

/* Render markdown to sanitized HTML. Links open in a new tab (ADD_ATTR target),
   same allowance the existing WebUI makes. */
export function renderMarkdown(text: string): string {
   const html = marked.parse(text, { async: false });
   return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}
