// @vitest-environment jsdom
import { expect, it } from "vitest";
import { renderMarkdown } from "./markdown.ts";

/* A reply is shaped by whatever the model read (a web page, an email), so it can carry HTML. It
   must not borrow Aurora's own styling or state through a class or an id: a full-screen overlay
   class covers the app with a fake "sign in again" prompt, saved with the reply so it returns
   every time the conversation opens, and a class Aurora looks for (convo-stopped) fakes a state. */

const render = (md: string): HTMLElement => {
   const div = document.createElement("div");
   div.innerHTML = renderMarkdown(md);
   return div;
};

it("a reply can't take on the app's classes or ids", () => {
   const out = render(
      'Text <div class="dialog-overlay" id="link-chip">Session expired. <a href="https://evil.example/login">Sign in again</a></div> <span class="convo-stopped">x</span>'
   );
   expect(out.querySelector("[class]")).toBeNull();
   expect(out.querySelector("[id]")).toBeNull();
   expect(out.textContent).toContain("Session expired."); // the words stay; only the hooks go
});

it("ordinary markdown still renders, code blocks included", () => {
   const out = render("# Notes\n\n- one\n- **two**\n\n```js\nconst x = 1;\n```");
   expect(out.querySelector("h1")?.textContent).toBe("Notes");
   expect(out.querySelectorAll("li")).toHaveLength(2);
   expect(out.querySelector("pre code")?.textContent).toContain("const x = 1;");
});
