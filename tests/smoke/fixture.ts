/* The smoke test's fixture and shared checks (the specs are smoke.spec.ts and no-webgl.spec.ts).
   Each test loads the production build with a fake DAWN in place of the real one
   (docs/FAKE_DAWN_PLAN.md). A run fails on any uncaught exception, any console error or warning
   not allowed below, any DAWN frame the client didn't handle, any request the fake doesn't expect,
   or a core element that's missing or wrong. */

import { test as base, expect, type Page } from "@playwright/test";
import type { FakeDawn } from "../fake-dawn/fake-dawn.ts";
import { OPTIONAL } from "../fake-dawn/fake-dawn.ts";
import { TRANSCRIPT, type Scenario } from "../fake-dawn/scenarios.ts";
import { BASE, pageDawn, type PageDawn } from "./fake-dawn-page.ts";

export { expect };

/* The console warnings a run may log, each with its reason. Any other warning fails the run. */
const ALLOWED_WARNINGS: { pattern: RegExp; why: string }[] = [
   {
      pattern: new RegExp(
         `^\\[dawn\\] this DAWN doesn't handle "(?:${OPTIONAL.join("|")})"; not sending it again on this connection$`
      ),
      why: "an optional subsystem this DAWN is built without, answered UNKNOWN_TYPE by design"
   },
   {
      pattern: /^\[\.WebGL-0x[0-9a-f]+\]GL Driver Message \(OpenGL, Performance, /,
      why: "the browser's own GL driver noting a slow path (headless frame readback), not the app"
   }
];

/* What the client logs for a frame it has no handler for: every frame the fake sends is one the
   client should handle, so this means a fixture (or the client) went stale. */
const UNHANDLED = "[dawn] unhandled frame:";

interface Dawn {
   /* Opens the app against a fake DAWN playing this scenario. */
   boot(scenario: Scenario): Promise<FakeDawn>;
   /* Opens the app in another tab of the same browser, on the same fake DAWN (after boot). */
   openTab(): Promise<Page>;
}

export const test = base.extend<{ dawn: Dawn }>({
   dawn: async ({ page, baseURL }, use, testInfo) => {
      const problems: string[] = [];
      /* Every tab's errors count; a second tab's are marked with its number. */
      const watch = (p: Page, tab: string): void => {
         p.on("pageerror", (e) => problems.push(`${tab}uncaught: ${e.message}`));
         p.on("console", (m) => {
            const text = m.text();
            if (m.type() === "error") problems.push(`${tab}console.error: ${text}`);
            else if (m.type() === "warning" && !ALLOWED_WARNINGS.some((a) => a.pattern.test(text)))
               problems.push(`${tab}console.warn: ${text}`);
            else if (text.startsWith(UNHANDLED)) problems.push(`${tab}unhandled frame: ${text}`);
         });
      };
      watch(page, "");
      let dawn: PageDawn | undefined;
      let fake: FakeDawn | undefined;
      let tabs = 1;
      await use({
         boot: async (scenario) => {
            dawn = pageDawn(scenario, new URL(baseURL!).origin);
            fake = dawn.fake;
            await dawn.attach(page);
            await page.goto(BASE);
            return fake;
         },
         openTab: async () => {
            if (!dawn) throw new Error("openTab before boot");
            const tab = await page.context().newPage();
            watch(tab, `tab ${++tabs}: `);
            await dawn.attach(tab);
            await tab.goto(BASE);
            return tab;
         }
      });
      if (!fake) return;
      /* Let anything startup throws just after the last assertion land before reading the problems:
         two animation frames (a state wait, not a sleep). */
      if (!page.isClosed())
         await page.evaluate(
            () =>
               new Promise<void>((done) =>
                  requestAnimationFrame(() => requestAnimationFrame(() => done()))
               )
         );
      await testInfo.attach("frames.log", { body: fake.transcript(), contentType: "text/plain" });
      expect.soft(fake.violations, "requests the fake DAWN didn't expect").toEqual([]);
      expect.soft(problems, "errors in the page").toEqual([]);
   }
});

/* The reactor really drew with WebGL2: the anchor canvas holds a live WebGL2 context with a
   drawing buffer. (A canvas with a WebGL context answers null to getContext("2d").) */
export async function reactorIsLive(page: Page): Promise<boolean> {
   return page.evaluate(() => {
      const canvas = document.getElementById("anchor") as HTMLCanvasElement | null;
      if (!canvas || canvas.getContext("2d") !== null) return false;
      const gl = canvas.getContext("webgl2");
      return gl !== null && !gl.isContextLost() && gl.drawingBufferWidth > 0;
   });
}

/* The signed-in shell, with the transcript the resume loaded, rendered. */
export async function expectSignedInShell(page: Page, reactor = true): Promise<void> {
   await expect(page.locator("#link-chip")).toBeVisible();
   await expect(page.locator("#link-chip .link-text")).toHaveText("Linked");
   await expect(page.locator("#login-card")).toBeHidden();
   await expect(page.locator("#menubar")).toBeVisible();

   const user = page.locator(".convo-msg.user .convo-body");
   await expect(user).toHaveText(TRANSCRIPT.user);
   const reply = page.locator(".convo-msg.assistant .convo-body");
   await expect(reply.locator("h2")).toHaveText("Release checklist");
   await expect(reply.locator("li")).toHaveCount(2);
   const link = reply.locator("a", { hasText: "release notes" });
   await expect(link).toHaveAttribute("href", "https://example.com/notes");
   await expect(reply.locator("pre code")).toContainText("git tag v1.0.0");

   expect(await reactorIsLive(page), "the reactor has a live WebGL2 context").toBe(reactor);
}
