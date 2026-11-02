// @vitest-environment jsdom
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown.ts";
import { executableBits, fetchingBits, hostileMarkup, parseLikeSink } from "../test/hostile.ts";

/* What renderMarkdown promises beyond "nothing runs": an image from another site never loads by
   itself (it becomes a click-to-load placeholder this module alone can make), nothing else fetches,
   and a link that opens a tab can't reach back to this page. */
function promiseBreaks(els: Element[]): string[] {
   const bad: string[] = [];
   for (const el of els) {
      const name = el.localName.toLowerCase();
      if (name === "img" && el.hasAttribute("src")) {
         const u = new URL(el.getAttribute("src")!, window.location.href);
         if (
            u.origin !== window.location.origin &&
            u.protocol !== "data:" &&
            u.protocol !== "blob:"
         )
            bad.push(`off-origin <img src=${u.href}>`);
      }
      if (name === "button") {
         const src = el.getAttribute("data-src") ?? "";
         if (
            !el.classList.contains("md-img-blocked") ||
            el.getAttribute("type") !== "button" ||
            !/^https?:\/\//.test(src)
         )
            bad.push(`<button> that isn't an image placeholder`);
      } else {
         if (el.classList.contains("md-img-blocked")) bad.push(`forged placeholder <${name}>`);
         for (const a of Array.from(el.attributes))
            if (a.name.startsWith("data-")) bad.push(`<${name} ${a.name}>`);
      }
      if (el.hasAttribute("target") && !/\bnoopener\b/.test(el.getAttribute("rel") ?? ""))
         bad.push(`<${name} target> without rel=noopener`);
   }
   return bad;
}

/* The heavier properties (each run parses documents in jsdom) get a sized run count; every
   property test has a fuzz-sized timeout from vitest.config.ts (the "property" project). */
describe("renderMarkdown (property)", () => {
   it("never emits anything that runs, fetches by itself, or forges the image gate", () => {
      fc.assert(
         fc.property(fc.oneof(hostileMarkup, fc.string()), (text) => {
            const els = parseLikeSink(renderMarkdown(text));
            expect([...executableBits(els), ...fetchingBits(els), ...promiseBreaks(els)]).toEqual(
               []
            );
         }),
         { numRuns: 500 }
      );
   });

   it("never throws", () => {
      fc.assert(
         fc.property(fc.string({ maxLength: 400 }), (text) => {
            expect(typeof renderMarkdown(text)).toBe("string");
         })
      );
   });
});
