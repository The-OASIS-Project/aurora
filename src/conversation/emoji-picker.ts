/*
 * Emoji autocomplete for the composer input. As the user types `:sm`, a small
 * dropdown of matching shortcodes rises above the input bar; Arrow keys move the
 * highlight, Enter/Tab accept, Escape dismisses, click accepts. Accepting swaps
 * the `:partial` fragment under the caret for the glyph.
 *
 * Self-contained: it owns its dropdown DOM + listeners and is torn down by
 * destroy(). It never routes through the seam - it is composer UI, editing the
 * input the same way a paste would, so the submit path downstream is unchanged
 * (emojify() still runs on submit to catch typed-but-not-picked codes).
 *
 * The `:` that opens a token must sit at the start or after whitespace, so a
 * shortcode is never detected inside `http://` or `12:30`.
 */

import { searchEmoji, type EmojiHit } from "../util/emoji.ts";

export interface EmojiPicker {
   destroy(): void;
}

/* Text-before-caret ending in an open shortcode: a `:` at a word boundary
   followed by 1+ name chars, nothing yet closing it. */
const OPEN_TOKEN_RE = /(?:^|\s):([a-z0-9_+-]+)$/i;

export function attachEmojiPicker(input: HTMLInputElement, anchor: HTMLElement): EmojiPicker {
   const box = document.createElement("div");
   box.className = "emoji-picker";
   box.setAttribute("role", "listbox");
   box.hidden = true;
   anchor.appendChild(box);

   let hits: EmojiHit[] = [];
   let active = 0;
   let tokenStart = -1; // index of the ':' that opened the active token

   const isOpen = (): boolean => !box.hidden;

   const close = (): void => {
      if (box.hidden) return;
      box.hidden = true;
      box.replaceChildren();
      hits = [];
      tokenStart = -1;
   };

   const render = (): void => {
      box.replaceChildren();
      hits.forEach((hit, i) => {
         const row = document.createElement("button");
         row.type = "button"; // inside a <form>: must NOT be a submit button
         row.className = "emoji-row" + (i === active ? " active" : "");
         row.setAttribute("role", "option");
         row.setAttribute("aria-selected", i === active ? "true" : "false");

         const glyph = document.createElement("span");
         glyph.className = "emoji-glyph";
         glyph.textContent = hit.char;
         const label = document.createElement("span");
         label.className = "emoji-name";
         label.textContent = `:${hit.name}:`;
         row.append(glyph, label);

         /* mousedown (not click) so the input never blurs before we accept. */
         row.addEventListener("mousedown", (e) => {
            e.preventDefault();
            accept(i);
         });
         box.appendChild(row);
      });
   };

   /* Recompute the token under the caret and show/hide the dropdown. */
   const refresh = (): void => {
      const caret = input.selectionStart;
      if (caret === null || caret !== input.selectionEnd) {
         close();
         return;
      }
      const before = input.value.slice(0, caret);
      const m = OPEN_TOKEN_RE.exec(before);
      if (!m) {
         close();
         return;
      }
      const query = m[1];
      const next = searchEmoji(query);
      if (next.length === 0) {
         close();
         return;
      }
      hits = next;
      active = 0;
      tokenStart = caret - query.length - 1; // back over the name + the ':'
      box.hidden = false;
      render();
   };

   const accept = (i: number): void => {
      const hit = hits[i];
      if (!hit || tokenStart < 0) return;
      const caret = input.selectionStart ?? input.value.length;
      const value = input.value;
      input.value = value.slice(0, tokenStart) + hit.char + value.slice(caret);
      const pos = tokenStart + hit.char.length;
      input.setSelectionRange(pos, pos);
      close();
      input.focus();
      /* Let the composer's own 'input' listeners (activity/summon) see the edit. */
      input.dispatchEvent(new Event("input", { bubbles: true }));
   };

   const onKeydown = (e: KeyboardEvent): void => {
      if (!isOpen()) return;
      switch (e.key) {
         case "ArrowDown":
            e.preventDefault();
            active = (active + 1) % hits.length;
            render();
            break;
         case "ArrowUp":
            e.preventDefault();
            active = (active - 1 + hits.length) % hits.length;
            render();
            break;
         case "Enter":
         case "Tab":
            /* preventDefault on Enter also blocks the form submit - exactly what
               we want while the picker owns the keystroke. */
            e.preventDefault();
            accept(active);
            break;
         case "Escape":
            e.preventDefault();
            e.stopPropagation();
            close();
            break;
      }
   };

   /* The picker's own input listener runs alongside the composer's (which only
      does activity/summon); order does not matter since they are independent. */
   input.addEventListener("input", refresh);
   input.addEventListener("keydown", onKeydown);
   input.addEventListener("blur", close);

   return {
      destroy: () => {
         input.removeEventListener("input", refresh);
         input.removeEventListener("keydown", onKeydown);
         input.removeEventListener("blur", close);
         box.remove();
      }
   };
}
