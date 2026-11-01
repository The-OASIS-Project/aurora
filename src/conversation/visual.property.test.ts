// @vitest-environment jsdom
import fc from "fast-check";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { neutralizeFrames, splitVisualSegments, VISUAL_PRELUDE } from "./visual.ts";
import { allElements, hostileMarkup } from "../test/hostile.ts";

const FRAMES = new Set(["iframe", "frame", "frameset", "object", "embed", "portal", "fencedframe"]);

/* The visual's document as createVisualFrame assembles it (head with the prelude, the code in the
   body, then the closing tags), so a frame tag at the very end of the code meets what really
   follows it. */
const srcdocFor = (code: string): string =>
   "<!DOCTYPE html><html><head>" +
   VISUAL_PRELUDE +
   "<style></style></head><body>\n" +
   neutralizeFrames(code) +
   "</body></html>";

/* Parsed twice: with scripting enabled, as the sandboxed frame parses it (<noscript> is raw text
   there; jsdom's "outside-only" sets the flag but runs no script in the page), and with scripting
   disabled (DOMParser), where <noscript> content becomes elements. A frame in either fails. */
function framesIn(html: string): string[] {
   const scripted = (new JSDOM(html, { runScripts: "outside-only" }).window as Window).document;
   const unscripted = new DOMParser().parseFromString(html, "text/html");
   return [...allElements(scripted), ...allElements(unscripted)]
      .map((el) => el.localName.toLowerCase())
      .filter((n) => FRAMES.has(n));
}

/* The heavier properties (each run parses documents in jsdom) get a sized run count and an
   explicit timeout: they are a fuzz-style workload, and their time follows the machine's load. */
describe("neutralizeFrames (property)", () => {
   /* A generated visual's markup is model output (reachable by prompt injection). Frame tags in it
      are neutralized as text before the sandbox parses it: a nested frame would bring back the
      WebRTC constructors the sandbox removes. */
   it("leaves nothing the HTML parser turns into a frame", { timeout: 120_000 }, () => {
      fc.assert(
         fc.property(hostileMarkup, (code) => {
            expect(framesIn(srcdocFor(code))).toEqual([]);
         }),
         { numRuns: 400 }
      );
   });
});

/* Text with real <dawn-visual> blocks among it, plus broken variants (unclosed, nested, odd
   quoting) that must stay text. */
const block = fc
   .tuple(
      fc.string({ maxLength: 10 }).filter((t) => !t.includes('"')),
      fc.constantFrom("svg", "html"),
      hostileMarkup
   )
   .map(
      ([title, type, code]) =>
         `<dawn-visual title="${title}" type="${type}">${code.replaceAll("</dawn-visual>", "")}</dawn-visual>`
   );
const broken = fc.constantFrom(
   '<dawn-visual title="x" type="svg">unclosed',
   "<dawn-visual title='x' type='svg'>single quotes</dawn-visual>",
   '<dawn-visual type="svg" title="x">attribute order</dawn-visual>',
   '<dawn-visual title="a" type="html"><dawn-visual title="b" type="svg">nested</dawn-visual></dawn-visual>'
);
const visualText = fc
   .array(fc.oneof(fc.string({ maxLength: 30 }), block, broken), { maxLength: 6 })
   .map((parts) => parts.join(""));

describe("splitVisualSegments (property)", () => {
   /* By design it drops whitespace-only text between blocks and trims a block's code; nothing
      else may go missing or move. */
   it("loses nothing but whitespace: text segments plus each block's source rebuild the input", () => {
      fc.assert(
         fc.property(visualText, (text) => {
            const segs = splitVisualSegments(text);
            const rebuilt = segs
               .map((s) =>
                  s.kind === "text"
                     ? s.content
                     : `<dawn-visual title="${s.visual.title}" type="${s.visual.type}">${s.visual.code}</dawn-visual>`
               )
               .join("");
            const squash = (t: string): string => t.replace(/\s+/g, "");
            expect(squash(rebuilt)).toBe(squash(text));
         }),
         { numRuns: 400 }
      );
   });
});
