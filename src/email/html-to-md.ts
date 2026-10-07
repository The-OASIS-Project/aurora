/*
 * Email HTML -> markdown, for the Mail panel's calm reader (docs/EMAIL_PANEL_DESIGN.md 6.1).
 *
 * The input is attacker-authored. Rules this file guarantees:
 *   - The HTML is parsed with DOMParser into an inert document, and NO node from it ever
 *     enters the page: the walker only reads it and returns a string.
 *   - Every text node is escaped (markdown metacharacters backslash-escaped, < > & as
 *     entities), so email text can never become markdown or HTML syntax.
 *   - URLs are read with getAttribute() only (never the resolved .href/.src, so <base> and
 *     relative paths can't resolve against Aurora), and only absolute http(s) (plus mailto: for
 *     links) that is NOT on Aurora's own host survives (safeUrl). An email URL can never pick up the
 *     Aurora login.
 *   - Dangerous and invisible subtrees are dropped whole; tracking pixels are dropped
 *     (best-effort; the real image guarantee is the sanitizer hook in render-body.ts).
 *   - Depth is capped, so pathological nesting can't blow the stack.
 */

import { designWidth } from "./fit-images.ts";

/* Subtrees dropped entirely (with their text). */
const DROP = new Set([
   "script", "style", "head", "title", "noscript", "template", "svg", "math", "iframe", "frame",
   "frameset", "object", "embed", "applet", "link", "meta", "base", "form", "input", "button",
   "select", "textarea", "option", "picture", "source", "video", "audio", "canvas", "map", "area"
]);

const BLOCK = new Set([
   "p", "div", "section", "article", "header", "footer", "main", "aside", "nav", "center",
   "address", "figure", "figcaption", "body", "html", "dl", "dt", "dd", "details", "summary"
]);

const MAX_DEPTH = 120;

/* Accept an email-supplied URL, or null. Absolute only (kills relative, protocol-relative, and
   anything a <base> would resolve), http(s) (and mailto: for links), never this host. */
export function safeUrl(raw: string | null | undefined, kind: "link" | "image"): string | null {
   if (!raw) return null;
   const t = raw.trim();
   if (!/^(https?:|mailto:)/i.test(t)) return null;
   let u: URL;
   try {
      u = new URL(t);
   } catch {
      return null;
   }
   if (u.protocol === "mailto:") return kind === "link" ? u.href : null;
   if (u.protocol !== "http:" && u.protocol !== "https:") return null;
   /* Never Aurora's own host, on any port or scheme: the login cookie is host-scoped (cookies
      ignore the port), so another port on this host still rides it. */
   if (typeof location !== "undefined" && location.hostname && u.hostname === location.hostname) return null;
   return u.href;
}

/* Text -> markdown-inert text. Backslash-escape the markdown metacharacters (CommonMark
   unescapes any escaped ASCII punctuation back to the literal), then entity-encode < > &. */
export function escapeMd(s: string): string {
   return s
      .replace(/\u0000/g, "")
      .replace(/[\\`*_{}[\]()#+\-.!|~=]/g, "\\$&")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
}

/* A URL inside markdown's (...) destination: parens and spaces must not end it early. */
function mdDest(href: string): string {
   return href.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/ /g, "%20");
}

function styleOf(el: Element): string {
   return (el.getAttribute("style") ?? "").toLowerCase().replace(/\s+/g, "");
}

/* Hidden content (a preheader, a hidden tracker) is not shown. */
function isHidden(el: Element): boolean {
   if (el.hasAttribute("hidden")) return true;
   const s = styleOf(el);
   return /display:none|visibility:hidden|opacity:0(?![.\d])/.test(s);
}

/* An image's intended display size survives markdown (whose image syntax has no size) as a URL
   fragment the browser never sends: `#aurora-size=WxH`, 0 for an unknown side. render-body reads it
   back into width/height and drops it. A sender could write one too; it only sizes the image,
   within the clamp. Without it, an icon drawn from a high-resolution file shows at full size. */
const SIZE_MAX = 4000;
const SIZE_FRAGMENT = /^#aurora-size=(\d{1,4})x(\d{1,4})$/;

function px(v: string | null | undefined): number {
   const m = /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/i.exec(v ?? "");
   if (!m) return 0; // a percentage, auto, or junk: unknown
   const n = Math.round(Number(m[1]));
   return n >= 1 && n <= SIZE_MAX ? n : 0;
}

/* The width and height the sender asked for (attributes first, then simple pixel styles). */
export function intendedSize(img: Element): { w: number; h: number } {
   const s = styleOf(img);
   const fromStyle = (side: string): number => px(new RegExp(`(?:^|;)${side}:([^;]*)`).exec(s)?.[1]);
   return {
      w: px(img.getAttribute("width")) || fromStyle("width"),
      h: px(img.getAttribute("height")) || fromStyle("height")
   };
}

/* `src` with the size fragment (replacing any fragment it had: an image's own fragment does nothing). */
export function withSize(src: string, size: { w: number; h: number }): string {
   if (!size.w && !size.h) return src;
   const u = new URL(src);
   u.hash = `aurora-size=${size.w}x${size.h}`;
   return u.href;
}

/* Split a src into the URL to load and the size it carried (0 = unknown). */
export function readSize(src: string): { src: string; w: number; h: number } {
   const u = new URL(src);
   const m = SIZE_FRAGMENT.exec(u.hash);
   if (!m) return { src, w: 0, h: 0 };
   u.hash = "";
   const clamp = (n: number): number => (n >= 1 && n <= SIZE_MAX ? n : 0);
   return { src: u.href, w: clamp(Number(m[1])), h: clamp(Number(m[2])) };
}

/* A tracking pixel: tiny or invisible. */
function isPixel(img: Element): boolean {
   if (isHidden(img)) return true;
   const tiny = (v: string | null): boolean => v !== null && /^\s*[01](px)?\s*$/i.test(v);
   if (tiny(img.getAttribute("width")) || tiny(img.getAttribute("height"))) return true;
   const s = styleOf(img);
   return /(^|;)(max-)?(width|height):[01](px)?(;|$)/.test(s);
}

/* The host a visible link text claims, if it looks like a URL or a bare domain. */
function claimedHost(text: string): string | null {
   const t = text.trim();
   if (!/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(t)) return null;
   try {
      return new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`).hostname;
   } catch {
      return null;
   }
}

/* The longest run of backticks in s, so a code span / fence can be one longer. */
function longestTicks(s: string): number {
   let max = 0;
   for (const m of s.matchAll(/`+/g)) max = Math.max(max, m[0].length);
   return max;
}

/* An element's visible text, without recursion (a browser's textContent is iterative, but
   don't rely on it for a pathologically deep tree). Skips dropped and hidden subtrees. */
function flatText(root: Element): string {
   let out = "";
   const stack: Node[] = [root];
   while (stack.length) {
      const n = stack.pop()!;
      if (n.nodeType === 3) {
         out += n.nodeValue ?? "";
         continue;
      }
      if (n.nodeType !== 1) continue;
      const el = n as Element;
      if (el !== root && (DROP.has(el.tagName.toLowerCase()) || isHidden(el))) continue;
      const kids = el.childNodes;
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
   }
   return out;
}

interface Ctx {
   pre: Array<{ raw: string; fenced: string }>; // code blocks, restored by normalize (they keep blank lines)
   images: number; // real remote images emitted (https; tracking pixels excluded)
}

const PRE_RE = /\u0000PRE(\d+)\u0000/g;
const PRE_TOKEN = (n: number): string => `\u0000PRE${n}\u0000`;

/* Raw text for code: visible text only, never NUL (the PRE token's delimiter). */
const codeText = (el: Element): string => flatText(el).replace(/\u0000/g, "");

/* In an inline context (a heading, emphasis, a link, a list item, ...) a code block can't be
   fenced, so it degrades to escaped single-line text. */
function inlinePre(s: string, ctx: Ctx): string {
   return s.replace(PRE_RE, (_m, n: string) => escapeMd((ctx.pre[Number(n)]?.raw ?? "").replace(/\s+/g, " ").trim()));
}

/* Children as one line of inline markdown. Leading/trailing space is reported separately, so a
   wrapper (** or [..]) can sit inside it ("Hello<b> world</b>" keeps its space). */
function inlineParts(node: Node, ctx: Ctx, depth: number): { text: string; lead: string; trail: string } {
   const raw = inlinePre(children(node, ctx, depth), ctx).replace(/\\\n/g, " ").replace(/\s*\n+\s*/g, " ");
   return { text: raw.trim(), lead: /^\s/.test(raw) ? " " : "", trail: /\s$/.test(raw) ? " " : "" };
}

function inlineText(node: Node, ctx: Ctx, depth: number): string {
   return inlineParts(node, ctx, depth).text;
}

function wrapInline(node: Node, ctx: Ctx, depth: number, mark: string): string {
   const { text, lead, trail } = inlineParts(node, ctx, depth);
   return text ? `${lead}${mark}${text}${mark}${trail}` : lead || trail;
}

/* An image, or a linked image, in the markdown this walker emits (alt/label text is escaped, so
   `\]` can appear in it; destinations never hold a space or ")"). */
const MEDIA = String.raw`(?:\[!\[(?:\\.|[^\]\\])*\]\([^)\s]*\)\]\([^)\s]*\)|!\[(?:\\.|[^\]\\])*\]\([^)\s]*\))`;
const MEDIA_ONLY = new RegExp(`^${MEDIA}(?:(?:\\s|\\\\(?=\\n))+${MEDIA})*$`);

/* Markdown that is nothing but images / linked images (a row of social icons), or null. Returned
   on one line, so they sit side by side as the sender laid them out. */
export function mediaLine(md: string): string | null {
   const t = md.trim();
   if (!t || !MEDIA_ONLY.test(t)) return null;
   return t.replace(/\\\n/g, " ").replace(/\s+/g, " ");
}

/* A node's children. Consecutive blocks that are only images (icons each in their own little
   table or div, a common newsletter pattern) are joined on one line instead of stacking; images
   already inline in running text are left as they are. */
function children(node: Node, ctx: Ctx, depth: number): string {
   let out = "";
   let run: Array<{ raw: string; line: string }> = [];
   let gap = ""; // whitespace between run members, kept if the run turns out to be a single item
   const flush = (): void => {
      if (run.length > 1 && run.some((r) => r.raw.includes("\n"))) out += `\n\n${run.map((r) => r.line).join(" ")}\n\n`;
      else out += run.map((r) => r.raw).join(gap);
      run = [];
      gap = "";
   };
   for (const c of Array.from(node.childNodes)) {
      const part = walk(c, ctx, depth + 1);
      const line = mediaLine(part);
      if (line !== null) {
         run.push({ raw: part, line });
      } else if (run.length && part.trim() === "") {
         gap += part;
      } else {
         flush();
         out += part;
      }
   }
   flush();
   return out;
}

function walk(node: Node, ctx: Ctx, depth: number): string {
   if (node.nodeType === 3) return escapeMd((node.textContent ?? "").replace(/\s+/g, " "));
   if (node.nodeType !== 1) return "";
   const el = node as Element;
   const tag = el.tagName.toLowerCase();
   if (DROP.has(tag) || isHidden(el)) return "";
   if (depth > MAX_DEPTH) return escapeMd(flatText(el).replace(/\s+/g, " "));

   switch (tag) {
      case "br":
         return "\\\n";
      case "hr":
         return "\n\n---\n\n";
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
         const t = inlineText(el, ctx, depth);
         return t ? `\n\n${"#".repeat(Number(tag[1]))} ${t}\n\n` : "";
      }
      case "strong":
      case "b":
         return wrapInline(el, ctx, depth, "**");
      case "em":
      case "i":
         return wrapInline(el, ctx, depth, "*");
      case "del":
      case "s":
      case "strike":
         return wrapInline(el, ctx, depth, "~~");
      case "code": {
         if (el.parentElement?.tagName.toLowerCase() === "pre") return codeText(el);
         const raw = codeText(el).replace(/\s+/g, " ");
         if (!raw.trim()) return "";
         const fence = "`".repeat(longestTicks(raw) + 1);
         return `${fence} ${raw} ${fence}`;
      }
      case "pre": {
         const raw = codeText(el).replace(/\n+$/, "");
         const fence = "`".repeat(Math.max(3, longestTicks(raw) + 1));
         ctx.pre.push({ raw, fenced: `${fence}\n${raw}\n${fence}` });
         return `\n\n${PRE_TOKEN(ctx.pre.length - 1)}\n\n`;
      }
      case "img": {
         if (isPixel(el)) return "";
         const src = safeUrl(el.getAttribute("src"), "image");
         const alt = escapeMd((el.getAttribute("alt") ?? "").replace(/\s+/g, " ").trim());
         if (!src) return alt ? `\\[${alt}\\]` : "";
         if (src.startsWith("https:")) ctx.images++; // http images can never be shown, so they aren't "blocked"
         return `![${alt}](${mdDest(withSize(src, intendedSize(el)))})`;
      }
      case "a": {
         const { text, lead, trail } = inlineParts(el, ctx, depth);
         const href = safeUrl(el.getAttribute("href"), "link");
         if (!href) return `${lead}${text}${trail}`;
         const label = text || escapeMd(href);
         let out = `[${label}](${mdDest(href)})`;
         /* Phishing tell: VISIBLE text (hidden spans don't count) that is a URL/domain for a
            different host. */
         const claimed = claimedHost(flatText(el));
         if (claimed && !href.startsWith("mailto:")) {
            const real = new URL(href).hostname;
            if (claimed !== real) out += ` (→ ${escapeMd(real)})`;
         }
         return `${lead}${out}${trail}`;
      }
      case "ul":
      case "ol":
         return `\n\n${list(el, ctx, depth, "")}\n\n`;
      case "li":
         return `\n\n${inlineText(el, ctx, depth)}\n\n`;
      case "blockquote": {
         /* Restore code blocks first, then prefix EVERY line, so a quoted <pre> (Thunderbird's
            plain-text reply quoting) stays inside the quote. */
         const inner = normalize(children(el, ctx, depth), ctx, true);
         if (!inner) return "";
         return `\n\n${inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")}\n\n`;
      }
      case "table":
      case "thead":
      case "tbody":
      case "tfoot":
         return `\n\n${children(el, ctx, depth)}\n\n`;
      case "tr":
         return row(el, ctx, depth);
      case "td":
      case "th":
         return `\n\n${children(el, ctx, depth)}\n\n`;
      default:
         if (BLOCK.has(tag)) return `\n\n${children(el, ctx, depth)}\n\n`;
         return children(el, ctx, depth); // span, font, u, small, ...: inline passthrough
   }
}

/* A list. A nested list indents to its parent item's content column ("10. " is wider than
   "- "), or it would break out of the item. */
function list(el: Element, ctx: Ctx, depth: number, indent: string): string {
   const ordered = el.tagName.toLowerCase() === "ol";
   const lines: string[] = [];
   let n = 1;
   for (const li of Array.from(el.children)) {
      if (li.tagName.toLowerCase() !== "li" || isHidden(li)) continue;
      const marker = ordered ? `${n++}.` : "-";
      let text = "";
      const nested: string[] = [];
      for (const c of Array.from(li.childNodes)) {
         const ct = c.nodeType === 1 ? (c as Element).tagName.toLowerCase() : "";
         if ((ct === "ul" || ct === "ol") && depth + 1 <= MAX_DEPTH) {
            nested.push(list(c as Element, ctx, depth + 1, indent + " ".repeat(marker.length + 1)));
         } else {
            text += walk(c, ctx, depth + 2);
         }
      }
      const t = inlinePre(text, ctx).replace(/\\\n/g, " ").replace(/\s*\n+\s*/g, " ").trim();
      lines.push(`${indent}${marker} ${t}`);
      lines.push(...nested);
   }
   return lines.join("\n");
}

/* A cell whose markdown starts a block construct must not be joined onto one line with others
   (it would turn the whole row into a heading, quote, list, or fence). */
const BLOCK_START = /^(#|>|- |\d+\. |`{3,}|\u0000PRE)/;

/* A table row: short single-line cells share one line ("a · b"); anything bigger stacks. */
function row(el: Element, ctx: Ctx, depth: number): string {
   const cells: string[] = [];
   for (const c of Array.from(el.children)) {
      const ct = c.tagName.toLowerCase();
      if ((ct !== "td" && ct !== "th") || isHidden(c)) continue;
      let md = normalize(children(c, ctx, depth + 1), ctx, false);
      md = mediaLine(md) ?? md; // a cell of icons (even from a nested table) stays on one line
      if (ct === "th" && md && !md.includes("\n") && !BLOCK_START.test(md)) md = `**${md}**`;
      if (md) cells.push(md);
   }
   if (cells.length === 0) return "";
   /* A row of image cells (social icons) sits side by side, plainly spaced. */
   if (cells.every((c) => mediaLine(c) !== null)) return `\n\n${cells.join(" ")}\n\n`;
   /* "Short" is the visible text: link and image destinations (long tracking URLs) don't count. */
   const visible = cells.join("").replace(/\]\([^)\s]*\)/g, "]").length;
   const inline = cells.every((c) => !c.includes("\n") && !BLOCK_START.test(c)) && visible < 200;
   return `\n\n${inline ? cells.join(" · ") : cells.join("\n\n")}\n\n`;
}

/* A list line from list(): its indent is meaningful and must survive the trim. Email text can't
   produce this shape, because escapeMd turns "-" / "1." into "\-" / "1\.". */
const LIST_LINE = /^ *(-|\d+\.)( |$)/;

/* An odd run of trailing backslashes ends in a hard break (an even run is escaped literals). */
const endsInBreak = (line: string): boolean => (line.match(/\\+$/)?.[0].length ?? 0) % 2 === 1;

/* Collapse block separators, trim each line, and drop hard breaks that end a block (CommonMark
   renders those as a literal backslash: Gmail's blank-line <div><br></div>). Leading whitespace
   goes (four spaces would make a code block), except a list line's indent. Code blocks are
   restored only where nothing will normalize them again (the top level, or a blockquote, whose
   every line then carries "> "), so their indentation and blank lines survive. */
function normalize(md: string, ctx: Ctx, restorePre: boolean): string {
   const lines = md.split("\n").map((l) => {
      const line = l.replace(/[ \t]+$/g, "");
      return LIST_LINE.test(line) ? line : line.trimStart();
   });
   for (let i = 0; i < lines.length; i++) {
      const next = lines[i + 1];
      if (endsInBreak(lines[i]) && (next === undefined || next.trim() === "")) lines[i] = lines[i].slice(0, -1).replace(/[ \t]+$/, "");
   }
   const out = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
   return restorePre ? out.replace(PRE_RE, (_m, n: string) => ctx.pre[Number(n)]?.fenced ?? "") : out;
}

export interface MdResult {
   markdown: string;
   /* Remote images the user could show (https; tracking pixels excluded): the "N blocked" count. */
   images: number;
   /* The width the email was designed at (fit-images.ts), 0 when it doesn't say. */
   designWidth: number;
}

/* Convert one email's HTML to escaped markdown. Pure: reads an inert parsed document only. */
export function htmlToMarkdown(html: string): MdResult {
   const doc = new DOMParser().parseFromString(html, "text/html");
   const ctx: Ctx = { pre: [], images: 0 };
   const root = doc.body ?? doc.documentElement;
   const md = normalize(root ? walk(root, ctx, 0) : "", ctx, true);
   return { markdown: md, images: ctx.images, designWidth: designWidth(doc) };
}
