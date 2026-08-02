/*
 * The four L-shaped corner brackets that machine a framed surface (styled by
 * .panel-corner in the stylesheets). The same chrome appears on every framed thing -
 * ambient panels, the conversation window, the movable instrument cards - so it lives
 * in one place. Appends four spans to `el`.
 */
export function addCorners(el: HTMLElement): void {
   for (const c of ["tl", "tr", "bl", "br"]) {
      const corner = document.createElement("span");
      corner.className = `panel-corner ${c}`;
      el.appendChild(corner);
   }
}
