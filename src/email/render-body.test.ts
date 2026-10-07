// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { escapeMd, htmlToMarkdown, safeUrl } from "./html-to-md.ts";
import { renderEmailBody } from "./render-body.ts";

/* Render into a detached container so the assertions can query the result. */
function render(html: string, showImages = false): HTMLElement {
   const div = document.createElement("div");
   div.appendChild(renderEmailBody({ html, text: "" }, showImages).fragment);
   return div;
}

/* Every element carrying a URL attribute, as [tag, attr, value]. */
function urlAttrs(root: HTMLElement): Array<[string, string, string]> {
   const out: Array<[string, string, string]> = [];
   for (const el of Array.from(root.querySelectorAll("*"))) {
      for (const a of Array.from(el.attributes)) {
         if (["href", "src", "srcset", "background", "poster", "style", "action", "formaction", "xlink:href"].includes(a.name)) {
            out.push([el.tagName.toLowerCase(), a.name, a.value]);
         }
      }
   }
   return out;
}

describe("safeUrl", () => {
   it("accepts absolute http(s) and mailto links only", () => {
      expect(safeUrl("https://a.example.com/x", "link")).toBe("https://a.example.com/x");
      expect(safeUrl("mailto:a@example.com", "link")).toBe("mailto:a@example.com");
      expect(safeUrl("mailto:a@example.com", "image")).toBeNull();
      for (const bad of ["javascript:alert(1)", "data:text/html,x", "/api/auth/logout", "//evil.example.net/x", "relative/path", "cid:abc", "  JavaScript:x", "vbscript:x"]) {
         expect(safeUrl(bad, "link")).toBeNull();
      }
   });

   it("rejects this host on any port or scheme", () => {
      expect(safeUrl(`${location.origin}/api/images/1`, "image")).toBeNull();
      expect(safeUrl(`https://${location.hostname}:3999/api/x`, "link")).toBeNull();
      expect(safeUrl(`http://${location.hostname}/api/x`, "link")).toBeNull();
   });
});

describe("escapeMd", () => {
   it("neutralizes markdown and HTML syntax", () => {
      expect(escapeMd("![x](https://t.example/p)")).toBe("\\!\\[x\\]\\(https://t\\.example/p\\)");
      expect(escapeMd("<img src=x>")).toBe("&lt;img src\\=x&gt;");
   });
});

describe("htmlToMarkdown", () => {
   it("drops dangerous subtrees and their text", () => {
      const { markdown } = htmlToMarkdown(
         "<p>keep</p><script>alert(1)</script><style>p{}</style><form><input value=pw></form><svg><text>svgtext</text></svg><noscript>ns</noscript>"
      );
      expect(markdown).toBe("keep");
   });

   it("drops tracking pixels and counts real images", () => {
      const r = htmlToMarkdown(
         '<img src="https://a.example.com/hero.jpg" alt="Hero"><img src="https://t.example.com/p.gif" width="1" height="1"><img src="https://t.example.com/q.gif" style="display:none"><img src="https://t.example.com/r.gif" width="0">'
      );
      expect(r.images).toBe(1);
      expect(r.markdown).toBe("![Hero](https://a.example.com/hero.jpg)");
   });

   it("reads URLs from attributes, ignoring <base>", () => {
      const { markdown } = htmlToMarkdown('<base href="https://evil.example.net/"><a href="relative/path">Relative</a>');
      expect(markdown).toBe("Relative");
   });

   it("shows the real host when link text claims another", () => {
      const { markdown } = htmlToMarkdown('<a href="https://examp1e.example.net/login">https://accounts.example.com/security</a>');
      expect(markdown).toContain("(→ examp1e\\.example\\.net)");
   });

   it("keeps structure", () => {
      const { markdown } = htmlToMarkdown(
         "<h2>Title</h2><p>One <strong>bold</strong> and <em>soft</em>.</p><ul><li>a</li><li>b<ul><li>c</li></ul></li></ul><pre>x  =  1\n\ny</pre>"
      );
      expect(markdown).toContain("## Title");
      expect(markdown).toContain("**bold**");
      expect(markdown).toContain("- a\n- b\n  - c");
      expect(markdown).toContain("```\nx  =  1\n\ny\n```");
   });

   it("flattens short table rows onto one line", () => {
      const { markdown } = htmlToMarkdown("<table><tr><th>Item</th><th>Cost</th></tr><tr><td>Cable</td><td>$12</td></tr></table>");
      expect(markdown).toContain("**Item** · **Cost**");
      expect(markdown).toContain("Cable · $12");
   });

   it("keeps a quoted <pre> inside the quote, as code", () => {
      const { markdown } = htmlToMarkdown('<blockquote type="cite"><pre>line1\n# big\n[x](https://evil.example.net)</pre></blockquote><p>after text</p>');
      expect(markdown).toBe("> ```\n> line1\n> # big\n> [x](https://evil.example.net)\n> ```\n\nafter text");
      const root = render('<blockquote><pre>line1\n# big</pre></blockquote><p>after text</p>');
      expect(root.querySelector("h1")).toBeNull();
      expect(root.querySelector("blockquote pre")?.textContent).toContain("# big");
      expect(Array.from(root.querySelectorAll("p")).map((p) => p.textContent)).toContain("after text");
   });

   it("degrades a <pre> in an inline context to escaped text", () => {
      const li = render('<ul><li><pre>## Heading\n[Reset](https://evil.example.net/x)</pre></li></ul><p>tail</p>');
      expect(li.querySelector("h2")).toBeNull();
      expect(li.querySelector("a")).toBeNull();
      expect(li.querySelector("li")?.textContent).toContain("## Heading [Reset](https://evil.example.net/x)");
      const td = render("<table><tr><td><pre>x</pre></td><td>z</td></tr></table><p>after</p>");
      expect(Array.from(td.querySelectorAll("p")).map((p) => p.textContent)).toEqual(["z", "after"]);
   });

   it("keeps a code block's indentation and blank lines inside a table cell", () => {
      const { markdown } = htmlToMarkdown("<table><tr><td><pre>def f():\n    return 1\n\n\n\nx = 1 \\</pre></td><td>z</td></tr></table>");
      expect(markdown).toContain("```\ndef f():\n    return 1\n\n\n\nx = 1 \\\n```");
      expect(markdown).toContain("\n\nz");
   });

   it("keeps nesting under an empty list item", () => {
      const { markdown } = htmlToMarkdown("<ul><li>a</li><li><ul><li>b</li></ul></li></ul>");
      expect(markdown).toBe("- a\n-\n  - b");
   });

   it("drops a hard break that ends a block (no stray backslash)", () => {
      const root = render("<div>Hi Alex,</div><div><br></div><div>See you.</div><p>Line one<br></p><p>a<br>b</p>");
      expect(root.textContent).not.toContain("\\");
      expect(root.querySelectorAll("br").length).toBe(1);
   });

   it("ignores hidden text when checking a link's claimed host", () => {
      const { markdown } = htmlToMarkdown('<a href="https://evil.example.net/">https://accounts.example.com<span style="display:none">zz zz</span></a>');
      expect(markdown).toContain("(→ evil\\.example\\.net)");
   });

   it("keeps the space around emphasis and links", () => {
      const root = render("<p>Hello<b> world</b> and<a href='https://ok.example.com'> here </a>end</p>");
      expect(root.textContent?.trim()).toBe("Hello world and here end");
   });

   it("nests under a wide ordered-list marker", () => {
      const items = Array.from({ length: 9 }, (_, i) => `<li>i${i + 1}</li>`).join("");
      const root = render(`<ol>${items}<li>i10<ul><li>sub</li></ul></li></ol>`);
      expect(root.querySelector("ol > li:last-child ul li")?.textContent).toBe("sub");
   });

   it("doesn't join a block-shaped cell onto the row", () => {
      const root = render("<table><tr><td><h3>Title</h3></td><td>z</td></tr></table>");
      expect(root.querySelector("h3")?.textContent).toBe("Title");
      expect(Array.from(root.querySelectorAll("p")).map((p) => p.textContent)).toEqual(["z"]);
   });

   it("survives deep nesting", () => {
      const deep = "<div>".repeat(5000) + "deep" + "</div>".repeat(5000);
      expect(htmlToMarkdown(deep).markdown).toContain("deep");
   });
});

describe("renderEmailBody", () => {
   it("renders attacker text as inert text", () => {
      const root = render(
         "<p>&lt;img src=https://t.example.net/esc.gif onerror=alert(1)&gt; ![pixel](https://t.example.net/md.gif) [x](javascript:alert(1))</p>"
      );
      expect(root.querySelector("img")).toBeNull();
      expect(root.querySelector("a")).toBeNull();
      expect(root.textContent).toContain("<img src=https://t.example.net/esc.gif");
      expect(root.textContent).toContain("![pixel](https://t.example.net/md.gif)");
   });

   it("blocks remote images until shown, then allows https only", () => {
      const html = '<img src="https://a.example.com/x.jpg" alt="Photo"><img src="http://a.example.com/y.jpg" alt="Plain">';
      const blocked = render(html);
      expect(blocked.querySelector("img")).toBeNull();
      expect(Array.from(blocked.querySelectorAll(".mail-img-blocked")).map((e) => e.textContent)).toEqual(["Photo", "Plain"]);

      const shown = render(html, true);
      const imgs = Array.from(shown.querySelectorAll("img"));
      expect(imgs.map((i) => i.getAttribute("src"))).toEqual(["https://a.example.com/x.jpg"]);
      expect(imgs[0].getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(shown.querySelectorAll(".mail-img-blocked").length).toBe(1);
   });

   it("keeps a row of social icons side by side", () => {
      const icon = (n: string): string =>
         `<a href="https://track.example.com/click?u=${"x".repeat(80)}&n=${n}"><img src="https://cdn.example.com/${n}.png" width="24" height="24" alt="${n}"></a>`;
      const sameLine = (html: string): void => {
         const root = render(html, true);
         const ps = Array.from(root.querySelectorAll("p")).filter((p) => p.querySelector("img"));
         expect(ps.length).toBe(1); // one paragraph holds them all
         expect(ps[0].querySelectorAll("img").length).toBe(4);
      };
      /* One row of cells, with long tracking links. */
      sameLine(`<table><tr>${["fb", "ig", "x", "yt"].map((n) => `<td>${icon(n)}</td>`).join("")}</tr></table>`);
      /* Each icon in its own little table (a common newsletter builder pattern). */
      sameLine(`<div>${["fb", "ig", "x", "yt"].map((n) => `<table align="left"><tr><td>${icon(n)}</td></tr></table>`).join("\n")}</div>`);
      /* Images inside running text stay inline, and text around them isn't split. */
      const p = render(`<p>Hello ${icon("a")}${icon("b")} world</p>`, true).querySelector("p")!;
      expect(p.textContent).toContain("Hello");
      expect(p.textContent).toContain("world");
      expect(p.querySelectorAll("img").length).toBe(2);
   });

   it("keeps each image's intended size, and loads it without the size fragment", () => {
      const html =
         '<img src="https://a.example.com/icon.png" width="24" height="24" alt="Nav">' +
         '<img src="https://a.example.com/hero.jpg#top" style="width: 600px" alt="Hero">' +
         '<img src="https://a.example.com/bar.png" height="40" alt="Bar">' +
         '<img src="https://a.example.com/full.png" width="100%" alt="Full">';
      const imgs = Array.from(render(html, true).querySelectorAll("img"));
      expect(imgs.map((i) => i.getAttribute("src"))).toEqual([
         "https://a.example.com/icon.png",
         "https://a.example.com/hero.jpg",
         "https://a.example.com/bar.png",
         "https://a.example.com/full.png"
      ]);
      expect(imgs.map((i) => [i.getAttribute("width"), i.getAttribute("height")])).toEqual([
         ["24", "24"],
         ["600", null],
         [null, "40"],
         [null, null] // a percentage isn't a pixel size: CSS fits it
      ]);
      expect(imgs[2].classList.contains("mail-img-h")).toBe(true);
   });

   it("clamps a size a sender wrote into the fragment themselves", () => {
      const imgs = Array.from(render('<img src="https://a.example.com/x.png#aurora-size=99999x0" alt="x"><img src="https://a.example.com/y.png#aurora-size=0x9000" alt="y">', true).querySelectorAll("img"));
      for (const img of imgs) {
         expect(img.getAttribute("width")).toBeNull();
         expect(img.getAttribute("height")).toBeNull();
      }
   });

   it("leaves no URL attribute except safe links and shown https images", () => {
      const html = `<a href="https://ok.example.com">ok</a><a href="/api/auth/logout">same</a>
         <a href="javascript:alert(1)">js</a><div style="background:url(https://t.example.com/bg.png)">bg</div>
         <picture><source srcset="https://t.example.com/a.webp"><img src="https://t.example.com/a.jpg" alt="a"></picture>
         <video poster="https://t.example.com/p.png"></video><img src="cid:logo" alt="logo">`;
      for (const show of [false, true]) {
         for (const [tag, attr, value] of urlAttrs(render(html, show))) {
            const ok = (tag === "a" && attr === "href" && value === "https://ok.example.com/") || (show && tag === "img" && attr === "src" && value.startsWith("https:"));
            expect(ok, `${tag}[${attr}=${value}]`).toBe(true);
         }
      }
   });

   it("opens links in a new tab without opener or referrer", () => {
      const a = render('<a href="https://ok.example.com/p">go</a>').querySelector("a")!;
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      expect(a.getAttribute("title")).toBe("ok.example.com");
   });

   it("renders plain text with linkified URLs", () => {
      const div = document.createElement("div");
      div.appendChild(renderEmailBody({ text: "Hi <b>there</b>\nsee https://ok.example.com/x.\n\nbye" }, false).fragment);
      expect(div.querySelectorAll("p").length).toBe(2);
      expect(div.querySelector("b")).toBeNull();
      expect(div.querySelector("a")?.getAttribute("href")).toBe("https://ok.example.com/x");
   });
});
