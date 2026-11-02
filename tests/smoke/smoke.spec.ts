/* The smoke test: does the bundle that ships start and stand up against DAWN? Each scenario loads
   the production build with a fake DAWN in place of the real one (docs/FAKE_DAWN_PLAN.md). A run
   fails on any uncaught exception, any console error or warning not allowed below, any DAWN frame
   the client didn't handle, any request the fake doesn't expect, or a core element that's missing
   or wrong. */

import { test as base, expect, type Page } from "@playwright/test";
import type { FakeDawn } from "../fake-dawn/fake-dawn.ts";
import { OPTIONAL } from "../fake-dawn/fake-dawn.ts";
import { SCENARIOS, TRANSCRIPT, type Scenario } from "../fake-dawn/scenarios.ts";
import { attachFakeDawn, BASE } from "./fake-dawn-page.ts";

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
}

const test = base.extend<{ dawn: Dawn }>({
   dawn: async ({ page, baseURL }, use, testInfo) => {
      const problems: string[] = [];
      page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
      page.on("console", (m) => {
         const text = m.text();
         if (m.type() === "error") problems.push(`console.error: ${text}`);
         else if (m.type() === "warning" && !ALLOWED_WARNINGS.some((a) => a.pattern.test(text)))
            problems.push(`console.warn: ${text}`);
         else if (text.startsWith(UNHANDLED)) problems.push(`unhandled frame: ${text}`);
      });
      let fake: FakeDawn | undefined;
      await use({
         boot: async (scenario) => {
            fake = await attachFakeDawn(page, scenario, new URL(baseURL!).origin);
            await page.goto(BASE);
            return fake;
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
async function reactorIsLive(page: Page): Promise<boolean> {
   return page.evaluate(() => {
      const canvas = document.getElementById("anchor") as HTMLCanvasElement | null;
      if (!canvas || canvas.getContext("2d") !== null) return false;
      const gl = canvas.getContext("webgl2");
      return gl !== null && !gl.isContextLost() && gl.drawingBufferWidth > 0;
   });
}

/* The signed-in shell, with the transcript the resume loaded, rendered. */
async function expectSignedInShell(page: Page): Promise<void> {
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

   expect(await reactorIsLive(page), "the reactor has a live WebGL2 context").toBe(true);
}

test("signed out: the login card, and no socket", async ({ page, dawn }) => {
   const fake = await dawn.boot(SCENARIOS.signedOut);
   await expect(page.locator("#login-card")).toBeVisible();
   await expect(page.locator("#login-card .login-status")).toHaveText("Awaiting link");
   await expect(page.locator('#login-card input[name="username"]')).toBeEditable();
   await expect(page.locator("#link-chip")).toBeHidden();
   expect(fake.sockets).toEqual([]);
   expect(fake.requests).toEqual([]);
});

test("signed in: resumes the session and the open conversation", async ({ page, dawn }) => {
   const fake = await dawn.boot(SCENARIOS.signedIn);
   await expectSignedInShell(page);
   expect(fake.requests[0]).toBe("init");
   expect(fake.requests).toContain("load_conversation");
});

test("an older DAWN (no feature flags): signed in, nothing tagged", async ({ page, dawn }) => {
   const fake = await dawn.boot(SCENARIOS.legacyDawn);
   await expectSignedInShell(page);
   /* The fake records any ?app=aurora as a violation for a DAWN without app_logins. */
   expect(fake.log.some((e) => e.text.includes("app=aurora"))).toBe(false);
});

test("a newer DAWN protocol: says so, and opens nothing", async ({ page, dawn }) => {
   const fake = await dawn.boot(SCENARIOS.protocolMismatch);
   await expect(page.locator("#login-card .login-status")).toHaveText(
      "Link failed: This DAWN is newer than this Aurora. Update Aurora to connect."
   );
   expect(fake.sockets).toEqual([]);
   expect(fake.requests).toEqual([]);
});

test("DAWN upgraded between page load and socket: says so on the config frame", async ({
   page,
   dawn
}) => {
   const fake = await dawn.boot(SCENARIOS.upgradedMidLoad);
   await expect(page.locator("#login-card .login-status")).toHaveText(
      "Link failed: DAWN v0.0.0-fake is newer than this Aurora. Update Aurora to connect."
   );
   /* It got as far as the socket, then stopped at the config frame's protocol. */
   expect(fake.requests[0]).toBe("init");
   expect(fake.requests).not.toContain("load_conversation");
});
