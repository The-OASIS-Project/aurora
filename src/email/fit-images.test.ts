// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { designWidth, fitImages, fitRatio } from "./fit-images.ts";

const doc = (html: string): Document => new DOMParser().parseFromString(html, "text/html");

describe("keeping a reflowed email's images in proportion", () => {
   it("finds the width the email was designed at, ignoring spacers and full-width noise", () => {
      expect(
         designWidth(
            doc(
               '<table width="600"><tr><td width="20"></td><td><img width="560"></td></tr></table>'
            )
         )
      ).toBe(600);
      expect(designWidth(doc('<div style="max-width: 900px; width: 640px">x</div>'))).toBe(640);
      expect(
         designWidth(
            doc('<table width="100%"><tr><td width="10">x</td></tr></table><img width="4000">')
         )
      ).toBe(0);
      /* A 600 px newsletter with a retina hero, a wider nested table, and a hidden wide block. */
      expect(
         designWidth(
            doc(
               '<table width="600"><tr><td><img width="1200" style="width:100%"><table width="800"><tr><td>x</td></tr></table></td></tr></table><div style="display:none"><div style="width:900px">p</div></div>'
            )
         )
      ).toBe(600);
      expect(designWidth(doc('<p>x</p><img width="640">'))).toBe(640); // no box says: the image does
   });

   it("scales only when the reader is narrower than the design", () => {
      expect(fitRatio(300, 600)).toBe(0.5);
      expect(fitRatio(800, 600)).toBe(1);
      expect(fitRatio(300, 0)).toBe(1);
   });

   it("scales every sized image by the same factor, and undoes it when there's room", () => {
      const root = document.createElement("div");
      root.innerHTML =
         '<img width="600" height="200"><img width="24" height="24"><img height="40">';
      const [banner, icon, bar] = Array.from(root.querySelectorAll("img"));
      fitImages(root, 0.5);
      expect([banner.style.width, icon.style.width, bar.style.height]).toEqual([
         "300px",
         "12px",
         "20px"
      ]);
      fitImages(root, 1);
      expect([banner.style.width, icon.style.width, bar.style.height]).toEqual(["", "", ""]);
   });
});
