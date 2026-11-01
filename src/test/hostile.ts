/*
 * Generators and checks for property tests over outside input: random text mixed with the shapes an
 * attacker reaches for (tags in odd case and spacing, event handlers, script and encoded URLs, quote
 * breakouts, parser-confusion payloads, markdown links), so a property is tried against the inputs
 * that matter, not only well-behaved ones.
 */
import fc from "fast-check";

const TAGS = [
   "script",
   "iframe",
   "frame",
   "frameset",
   "object",
   "embed",
   "portal",
   "fencedframe",
   "svg",
   "math",
   "style",
   "base",
   "meta",
   "link",
   "form",
   "img",
   "a",
   "div",
   "p",
   "template",
   "noscript",
   "textarea",
   "title",
   "xmp",
   "plaintext",
   "noembed",
   "noframes",
   "select",
   "table",
   "tr",
   "td",
   "mglyph",
   "foreignObject",
   "annotation-xml",
   "animate",
   "set",
   "use",
   "video",
   "audio",
   "source",
   "picture",
   "input",
   "button"
];
const ATTRS = [
   "onerror",
   "onload",
   "onclick",
   "src",
   "href",
   "srcdoc",
   "style",
   "action",
   "formaction",
   "xlink:href",
   "srcset",
   "poster",
   "background",
   "ping",
   "data",
   "values",
   "attributeName",
   "http-equiv",
   "content",
   "class",
   "data-src",
   "data-gate",
   "target",
   "shadowrootmode"
];
const URLS = [
   "javascript:alert(1)",
   " JaVaScRiPt:alert(1)",
   "java\tscript:alert(1)",
   "vbscript:msgbox(1)",
   "data:text/html,<script>alert(1)</script>",
   "https://t.example.net/x.gif",
   /* dawn-url-ok: test input only, never requested */
   "/api/images/x",
   "//evil.example.net/x"
];
/* Encoded and control-character forms a browser still reads as a scheme or another host. */
const ENCODED = [
   "&#106;avascript:alert(1)",
   "&#x6A;avascript:alert(1)",
   "javascript&colon;alert(1)",
   "jav&Tab;ascript:alert(1)",
   "\u0001javascript:alert(1)",
   "data:image/svg+xml,<svg onload=alert(1)>",
   "data:text/html;base64,PHNjcmlwdD4=",
   "blob:x",
   "https:evil.example",
   "/\\evil.example",
   "http://localhost:9999/x"
];
/* Whole payloads that random fragments almost never assemble on their own. */
const PAYLOADS = [
   '" onerror="alert(1)" x="',
   '"><img src=x onerror=alert(1)>',
   '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
   "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>",
   "<svg><a><animate attributeName=href values=javascript:alert(1) /><text>x</text></a></svg>",
   '<meta http-equiv=refresh content="0;url=javascript:alert(1)">',
   "<template shadowrootmode=open><img src=x onerror=alert(1)></template>",
   "<button class=md-img-blocked data-src=https://evil.example/x data-gate=x>x</button>",
   "<style>@import url(https://evil.example/x.css)</style>",
   '<img src=x srcset="https://evil.example/1x 1x">',
   '<p style="background:url(https://evil.example/b)">x</p>',
   /* Well-formed images and links, so the rules for what may load and where links may go are
      exercised every run, not only when random pieces happen to line up. */
   '<img src="https://t.example.net/x.gif" alt="pixel">',
   "<img src=http://t.example.net/y.png>",
   '<img src="//t.example.net/z.png">',
   '<img src="https://localhost/own.png">',
   '<a href="https://t.example.net/page">link</a>',
   '<a href="http://localhost:3000/api/x">own host</a>',
   '<a href="mailto:a@b.example">mail</a>'
];

const url = fc.constantFrom(...URLS, ...ENCODED);
/* A tag name in random letter case. */
const tagName = fc
   .constantFrom(...TAGS)
   .chain((t) =>
      fc
         .array(fc.boolean(), { minLength: t.length, maxLength: t.length })
         .map((up) => [...t].map((c, i) => (up[i] ? c.toUpperCase() : c)).join(""))
   );
const space = fc.constantFrom("", " ", "\t", "\n", "\f", "\r", "/", "  ");
const attr = fc
   .tuple(
      fc.constantFrom(...ATTRS),
      fc.oneof(url, fc.string({ maxLength: 12 })),
      fc.constantFrom('"', "'", "")
   )
   .map(([n, v, q]) => ` ${n}=${q}${v}${q}`);
const openTag = fc
   .tuple(space, tagName, fc.array(attr, { maxLength: 3 }), space)
   .map(([s1, t, a, s2]) => `<${s1}${t}${a.join("")}${s2}>`);
const closeTag = fc.tuple(tagName, space).map(([t, s]) => `</${t}${s}>`);
/* Markdown links, images, reference definitions and autolinks carrying the URLs above. */
const mdLink = fc
   .tuple(fc.constantFrom("[x](", "![i](", "[x]: ", "<"), url, fc.constantFrom(")", ">", ' "t")'))
   .map((a) => a.join(""));
const fragment = fc.oneof(
   { weight: 3, arbitrary: fc.string({ maxLength: 20 }) },
   { weight: 3, arbitrary: openTag },
   { weight: 2, arbitrary: closeTag },
   { weight: 2, arbitrary: mdLink },
   { weight: 2, arbitrary: fc.constantFrom(...PAYLOADS) },
   {
      weight: 1,
      arbitrary: fc.constantFrom("<!--", "-->", "<![CDATA[", "]]>", "&lt;", "`", "```", "\n\n")
   }
);

/* Hostile HTML-ish (and markdown-ish) text. */
export const hostileMarkup = fc.array(fragment, { maxLength: 24 }).map((parts) => parts.join(""));

/* Every element in a tree, including template contents (which querySelectorAll skips). */
export function allElements(root: ParentNode): Element[] {
   const out: Element[] = [];
   for (const el of Array.from(root.querySelectorAll("*"))) {
      out.push(el);
      /* By namespace and name, not instanceof: a document from another jsdom (the scripting-enabled
         parse) has its own HTMLTemplateElement, so instanceof would skip its templates. */
      if (el.localName === "template" && el.namespaceURI === "http://www.w3.org/1999/xhtml")
         out.push(...allElements((el as HTMLTemplateElement).content));
   }
   return out;
}

/* Parse sanitized HTML as the real sinks do: into a <div> (renderMarkdown's output goes to a div's
   innerHTML). The div belongs to a detached document with no browsing context, so nothing in it
   loads or runs. Parsed twice (re-serialized), and both trees are checked, since a difference
   between the two parses is where mutation XSS lives. */
export function parseLikeSink(html: string): Element[] {
   const doc = document.implementation.createHTMLDocument("");
   const first = doc.createElement("div");
   // eslint-disable-next-line no-unsanitized/property -- the point: parse untrusted test output to inspect it, in a document with no browsing context
   first.innerHTML = html;
   const second = doc.createElement("div");
   // eslint-disable-next-line no-unsanitized/property -- the same, for the re-serialized form
   second.innerHTML = first.innerHTML;
   return [...allElements(first), ...allElements(second)];
}

const URL_ATTRS = ["href", "src", "action", "formaction", "xlink:href", "data", "values"];
/* A URL value as a browser would read its scheme: control characters and spaces dropped. */
const schemeOf = (v: string): string =>
   // eslint-disable-next-line no-control-regex -- browsers ignore control characters in a URL scheme ("java\tscript:"), so drop them before comparing
   v.replace(/[\u0000- ]/g, "").toLowerCase();

/* What runs script: executable elements, event handlers, script URLs, a refresh to one. */
export function executableBits(els: Element[]): string[] {
   const EXEC = new Set([
      "script",
      "iframe",
      "frame",
      "frameset",
      "object",
      "embed",
      "portal",
      "fencedframe",
      "base",
      "form",
      "animate",
      "set",
      "use",
      "foreignobject"
   ]);
   const bad: string[] = [];
   for (const el of els) {
      const name = el.localName.toLowerCase();
      if (EXEC.has(name)) bad.push(`<${name}>`);
      if (name === "meta" && el.hasAttribute("http-equiv")) bad.push("<meta http-equiv>");
      for (const a of Array.from(el.attributes)) {
         const n = a.name.toLowerCase();
         if (n.startsWith("on")) bad.push(`${name}[${n}]`);
         if (n === "srcdoc") bad.push(`${name}[srcdoc]`);
         if (URL_ATTRS.includes(n)) {
            const v = schemeOf(a.value);
            if (
               /^(javascript|vbscript):/.test(v) ||
               (v.startsWith("data:") && !/^data:image\/(png|jpe?g|gif|webp)[;,]/.test(v))
            )
               bad.push(`${name}[${n}=${a.value}]`);
         }
      }
   }
   return bad;
}

/* What would fetch a URL by itself, besides <img src> (each sink has its own image rule): media
   and embedding elements, stylesheets, and the URL-bearing attributes other than a link's href. */
export function fetchingBits(els: Element[]): string[] {
   const FETCH_TAGS = new Set([
      "style",
      "link",
      "video",
      "audio",
      "source",
      "track",
      "picture",
      "input",
      "object",
      "embed",
      "image",
      "feimage"
   ]);
   const FETCH_ATTRS = [
      "style",
      "srcset",
      "imagesrcset",
      "poster",
      "background",
      "ping",
      "data",
      "xlink:href"
   ];
   const bad: string[] = [];
   for (const el of els) {
      const name = el.localName.toLowerCase();
      if (FETCH_TAGS.has(name)) bad.push(`<${name}>`);
      for (const n of FETCH_ATTRS) if (el.hasAttribute(n)) bad.push(`${name}[${n}]`);
      if (el.hasAttribute("src") && name !== "img") bad.push(`${name}[src]`);
   }
   return bad;
}
