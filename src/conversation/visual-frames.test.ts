// @vitest-environment node
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { neutralizeFrames, VISUAL_PRELUDE } from "./visual.ts";

/* A visual's document with the prelude run first, as in the real srcdoc. */
function visualWindow(): { w: Window & typeof globalThis; run: (code: string) => unknown } {
   const dom = new JSDOM(
      `<!DOCTYPE html><html><head>${VISUAL_PRELUDE}</head><body></body></html>`,
      { runScripts: "dangerously" }
   );
   const w = dom.window as unknown as Window & typeof globalThis;
   return { w, run: (code) => (w as unknown as { eval: (c: string) => unknown }).eval(code) };
}

describe("no frames inside a visual", () => {
   it("neutralizes frame tags in the model's markup", () => {
      expect(neutralizeFrames('<div><iframe src="x"></iframe><IFRAME/><embed src=y></div>')).toBe(
         '<div><x-blocked-iframe src="x"></x-blocked-iframe><x-blocked-IFRAME/><x-blocked-embed src=y></div>'
      );
      expect(neutralizeFrames("<iframes-are-words> <frameborder>")).toBe(
         "<iframes-are-words> <frameborder>"
      );
   });

   it("refuses every runtime route to a frame", () => {
      const { run } = visualWindow();
      const routes = [
         'document.createElement("iframe")',
         'document.createElementNS("http://www.w3.org/1999/xhtml","iframe")',
         'document.body.innerHTML = "<iframe></iframe>"',
         'document.body.insertAdjacentHTML("beforeend", "<object></object>")',
         'var t = document.createElement("div"); t.outerHTML; document.body.appendChild(t); t.outerHTML = "<embed>"',
         'var f = new DOMParser().parseFromString("<iframe></iframe>", "text/html").body.firstChild; document.body.appendChild(document.importNode(f, true))',
         'var d = new DOMParser().parseFromString("<div><iframe></iframe></div>", "text/html").body.firstChild; document.body.append(d)',
         'document.write("<iframe></iframe>")',
         'var r = document.createRange(); r.selectNodeContents(document.body); r.insertNode(r.createContextualFragment("<iframe></iframe>"))'
      ];
      /* An HTML value that isn't a string (a TrustedHTML in a real browser): still checked. */
      routes.push(
         'document.body.insertAdjacentHTML("beforeend", { toString: function () { return "<iframe></iframe>"; } })'
      );
      for (const r of routes) expect(() => run(r), r).toThrow(/Frames are not allowed/);
      expect(run('document.querySelectorAll("iframe,object,embed").length')).toBe(0);
   });

   it("leaves ordinary content alone, and WebRTC gone", () => {
      const { run } = visualWindow();
      run(
         'document.body.innerHTML = "<div id=a><canvas></canvas></div>"; document.body.appendChild(document.createElement("span"))'
      );
      expect(run('document.querySelectorAll("#a canvas, span").length')).toBe(2);
      expect(run("typeof window.RTCPeerConnection")).toBe("undefined");
   });

   it("can't be undone by the visual's code", () => {
      const { run } = visualWindow();
      expect(() =>
         run(
            'Object.defineProperty(Document.prototype, "createElement", { value: function () {} })'
         )
      ).toThrow();
      expect(() => run('document.createElement("iframe")')).toThrow(/Frames are not allowed/);
   });
});
