// @vitest-environment jsdom
import fc from "fast-check";
import { JSDOM } from "jsdom";
import { parse } from "parse5";
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

/* Parsed twice: with scripting enabled, as the sandboxed frame parses it (<noscript> content is
   raw text there), and with scripting disabled (DOMParser), where it becomes elements. A frame in
   either fails. The scripting-enabled parse is parse5 (jsdom's own parser) with
   scriptingEnabled, which parses as a scripting browser does and runs nothing; jsdom itself only
   sets that flag with runScripts: "dangerously", which would execute the markup's scripts. */
interface P5Node {
   nodeName: string;
   childNodes?: P5Node[];
   content?: P5Node;
}
function p5Names(node: P5Node, out: string[] = []): string[] {
   out.push(node.nodeName.toLowerCase());
   for (const child of node.childNodes ?? []) p5Names(child, out);
   if (node.content) p5Names(node.content, out); // a <template>'s contents
   return out;
}
const scriptingParse = (html: string): string[] => p5Names(parse(html, { scriptingEnabled: true }));
function framesIn(html: string): string[] {
   const unscripted = new DOMParser().parseFromString(html, "text/html");
   return [
      ...scriptingParse(html),
      ...allElements(unscripted).map((el) => el.localName.toLowerCase())
   ].filter((n) => FRAMES.has(n));
}

describe("the two parses really differ where scripting matters", () => {
   it("<noscript> content is text with scripting on, elements with it off", () => {
      const html =
         "<!DOCTYPE html><html><body><noscript><iframe></iframe></noscript></body></html>";
      expect(scriptingParse(html)).not.toContain("iframe");
      expect(
         allElements(new DOMParser().parseFromString(html, "text/html")).map((e) => e.localName)
      ).toContain("iframe");
   });
});

/* The heavier properties (each run parses documents in jsdom) get a sized run count; every
   property test has a fuzz-sized timeout from vitest.config.ts (the "property" project), and the
   heaviest (two parses per run) gets more. */
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

describe("frame inspection across DOM realms", () => {
   it("finds a frame inside a <template> of a document from another jsdom", () => {
      const html =
         "<!DOCTYPE html><html><body><template><iframe></iframe></template></body></html>";
      const other = (new JSDOM(html).window as Window).document;
      expect(allElements(other).some((el) => el.localName === "iframe")).toBe(true);
   });
});
