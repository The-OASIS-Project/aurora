/*
 * Markdown rendering for assistant replies, matching the existing WebUI
 * (www/js/ui/format.js): marked with GFM + line breaks, then DOMPurify to sanitize
 * the HTML before it touches the DOM. DAWN's output is trusted-ish, but tool
 * results and web content flow through it, so we sanitize as a matter of course.
 */

import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

/* Render markdown to sanitized HTML. Links open in a new tab (ADD_ATTR target),
   same allowance the existing WebUI makes. */
export function renderMarkdown(text: string): string {
   const html = marked.parse(text, { async: false });
   return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}
