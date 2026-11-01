// @vitest-environment jsdom
import fc from "fast-check";
import { Marked } from "marked";
import { describe, expect, it } from "vitest";
import { escapeMd, htmlToMarkdown, safeUrl } from "./html-to-md.ts";
import { renderEmailBody } from "./render-body.ts";
import { allElements, executableBits, fetchingBits, hostileMarkup } from "../test/hostile.ts";

/* What the mail pipeline promises beyond "nothing runs": no image loads unless the user pressed
   Show images, and then only over https and never from this host; every link is http(s) or
   mailto, never this host, and opens a new tab that can't reach back to this page. */
function promiseBreaks(els: Element[], showImages: boolean): string[] {
   const bad: string[] = [];
   const own = window.location.hostname;
   for (const el of els) {
      const name = el.localName.toLowerCase();
      if (el.hasAttribute("src")) {
         const src = el.getAttribute("src")!;
         if (!showImages) bad.push(`<${name} src> while images are blocked`);
         else if (!src.startsWith("https:") || new URL(src).hostname === own)
            bad.push(`<${name} src=${src}>`);
      }
      if (name === "a" && el.hasAttribute("href")) {
         const href = el.getAttribute("href")!;
         const ok = /^https?:\/\//.test(href)
            ? new URL(href).hostname !== own
            : href.startsWith("mailto:");
         if (!ok) bad.push(`<a href=${href}>`);
         if (
            el.getAttribute("target") !== "_blank" ||
            el.getAttribute("rel") !== "noopener noreferrer"
         )
            bad.push(`<a> without target=_blank rel="noopener noreferrer"`);
      }
   }
   return bad;
}

/* The heavier properties (each run parses documents in jsdom) get a sized run count and an
   explicit timeout: they are a fuzz-style workload, and their time follows the machine's load. */
describe("the mail body pipeline (property)", () => {
   it(
      "renders any HTML body to nothing that runs, fetches unasked, or links out unsafely",
      { timeout: 60_000 },
      () => {
         fc.assert(
            fc.property(hostileMarkup, fc.boolean(), (html, showImages) => {
               const root = document.createElement("div");
               root.append(renderEmailBody({ html, text: "" }, showImages).fragment);
               /* Walk the nodes as inserted: the real sink never parses a string. */
               const els = allElements(root);
               expect([
                  ...executableBits(els),
                  ...fetchingBits(els),
                  ...promiseBreaks(els, showImages)
               ]).toEqual([]);
            }),
            { numRuns: 400 }
         );
      }
   );

   it("htmlToMarkdown never throws and always returns text", () => {
      fc.assert(
         fc.property(fc.oneof(hostileMarkup, fc.string()), (html) => {
            expect(typeof htmlToMarkdown(html).markdown).toBe("string");
         })
      );
   });

   it("safeUrl returns only absolute http(s), or mailto for a link, and never this host", () => {
      const own = window.location.hostname;
      fc.assert(
         fc.property(
            fc.oneof(
               fc.webUrl(),
               fc.string(),
               fc.constantFrom(
                  "javascript:alert(1)",
                  " https://x.test/a",
                  "mailto:a@b.test",
                  "data:image/png;base64,AA",
                  `http://${own}:1/x`,
                  `https://${own.toUpperCase()}/x`,
                  `http://${own}.:5273/`,
                  `http://user@${own}/`
               )
            ),
            fc.constantFrom("link", "image" as const),
            (raw, kind) => {
               const out = safeUrl(raw, kind);
               if (out === null) return;
               if (out.startsWith("mailto:")) {
                  expect(kind).toBe("link");
                  return;
               }
               expect(out).toMatch(/^https?:\/\//);
               expect(new URL(out).hostname.replace(/\.$/, "")).not.toBe(own);
            }
         )
      );
   });

   it("escapeMd text renders back as exactly that text, inert", () => {
      /* Escaping is about inline markup, so parse inline, with autolinks and bare URLs off as the
         mail renderer has them (render-body.ts): block layout (an indented line becoming a code
         block) and automatic linking aren't what escaping promises. */
      const md = new Marked({
         gfm: true,
         tokenizer: { url: () => undefined, autolink: () => undefined }
      });
      fc.assert(
         fc.property(fc.string(), (s) => {
            const html = md.parseInline(escapeMd(s), { async: false });
            const box = document.createElement("div");
            // eslint-disable-next-line no-unsanitized/property -- checking what the escaped text renders to
            box.innerHTML = html;
            /* Only line breaks and text: no markup was injected. A hard break (two spaces before a
               newline) is a <br> and stands for that line break in the comparison below. */
            for (const el of allElements(box)) {
               expect(el.localName).toBe("br");
               el.replaceWith("\n");
            }
            /* escapeMd drops NUL (its sentinel); whitespace is normalized on both sides. */
            const NUL = String.fromCharCode(0);
            const norm = (t: string): string => t.split(NUL).join("").replace(/\s+/g, " ").trim();
            expect(norm(box.textContent ?? "")).toBe(norm(s));
         })
      );
   });

   it("a hard break in the text is a line break, not an escaping failure", () => {
      const md = new Marked({
         gfm: true,
         tokenizer: { url: () => undefined, autolink: () => undefined }
      });
      const box = document.createElement("div");
      // eslint-disable-next-line no-unsanitized/property -- checking what the escaped text renders to
      box.innerHTML = md.parseInline(escapeMd("a  \nb"), { async: false });
      expect(Array.from(box.querySelectorAll("*")).map((e) => e.localName)).toEqual(["br"]);
   });

   it("escapes text that markdown would otherwise turn into a code block or a link", () => {
      const md = new Marked({
         gfm: true,
         tokenizer: { url: () => undefined, autolink: () => undefined }
      });
      for (const s of ["    x", "http://x", "<http://x>", "[a](javascript:alert(1))"]) {
         const box = document.createElement("div");
         // eslint-disable-next-line no-unsanitized/property -- checking what the escaped text renders to
         box.innerHTML = md.parseInline(escapeMd(s), { async: false });
         expect(box.querySelector("*")).toBeNull();
         expect(box.textContent?.trim()).toBe(s.trim());
      }
   });
});
