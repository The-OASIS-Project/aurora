/* The smoke test: does the bundle that ships start and stand up against DAWN? The fixture and
   what fails a run: fixture.ts. */

import { SCENARIOS } from "../fake-dawn/scenarios.ts";
import { expect, expectSignedInShell, reactorIsLive, test } from "./fixture.ts";
import type { Page } from "@playwright/test";

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

/* Take the reactor's WebGL context away, as a GPU reset or driver update does. The extension is
   kept on the page: it can't be fetched again while the context is gone. */
async function loseContext(page: Page): Promise<void> {
   await page.evaluate(async () => {
      const canvas = document.getElementById("anchor") as HTMLCanvasElement;
      const ext = canvas.getContext("webgl2")!.getExtension("WEBGL_lose_context")!;
      (window as unknown as { __loseContext: typeof ext }).__loseContext = ext;
      const lost = new Promise((done) =>
         canvas.addEventListener("webglcontextlost", done, { once: true })
      );
      ext.loseContext();
      await lost;
   });
}

/* Give it back, and let a few frames draw. */
async function restoreContext(page: Page): Promise<void> {
   await page.evaluate(async () => {
      const canvas = document.getElementById("anchor") as HTMLCanvasElement;
      const restored = new Promise((done) =>
         canvas.addEventListener("webglcontextrestored", done, { once: true })
      );
      (window as unknown as { __loseContext: WEBGL_lose_context }).__loseContext.restoreContext();
      await restored;
      await new Promise<void>((done) => {
         let n = 10;
         const step = (): void => (--n <= 0 ? done() : void requestAnimationFrame(step));
         requestAnimationFrame(step);
      });
   });
}

/* The mean brightness (0-255) of the reactor's core, from a screenshot: what the page shows, bloom
   and all. Reduced motion holds the reactor still, so two looks at an intact reactor match. */
async function coreBrightness(page: Page): Promise<number> {
   const vp = page.viewportSize()!;
   const png = await page.screenshot({
      clip: { x: vp.width / 2 - 60, y: vp.height / 2 - 60, width: 120, height: 120 }
   });
   return page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      return sum / (d.length / 4) / 3;
   }, png.toString("base64"));
}

/* The core's brightness once the scene has settled (the first frames still change as it comes
   up): two looks in a row that agree. */
async function settledBrightness(page: Page): Promise<number> {
   let last = -1;
   let value = 0;
   await expect
      .poll(
         async () => {
            value = await coreBrightness(page);
            const steady = last >= 0 && Math.abs(value - last) <= 0.01 * Math.max(last, 1);
            last = value;
            return steady;
         },
         { timeout: 30_000, intervals: [500] }
      )
      .toBe(true);
   return value;
}

test("the reactor survives losing its WebGL context and getting it back", async ({
   page,
   dawn
}) => {
   test.setTimeout(90_000); // two settles and a rebuild; slow where WebGL runs in software
   await dawn.boot(SCENARIOS.signedIn);
   await expectSignedInShell(page);
   const before = await settledBrightness(page);
   expect(before, "the reactor's core is lit").toBeGreaterThan(20);
   await loseContext(page);
   /* A resize while it's gone: the composer's render targets are rebuilt with no context. */
   const size = page.viewportSize()!;
   await page.setViewportSize({ width: size.width - 200, height: size.height - 100 });
   await page.setViewportSize(size);
   await restoreContext(page);
   expect(await reactorIsLive(page), "the reactor's context is back").toBe(true);
   /* Three.js rebuilt its GPU state: the reactor draws as it did, not black or half-built (the
      bloom included: reduced motion holds the scene still, so it matches closely). */
   const after = await settledBrightness(page);
   expect(Math.abs(after - before) / before, `core brightness ${before} -> ${after}`).toBeLessThan(
      0.02
   );
   /* A loss that comes back quickly says nothing. */
   await expect(page.getByText("The animated centerpiece stopped")).toHaveCount(0);
});

test("a context that stays lost: the notice says so, and goes when it's back", async ({
   page,
   dawn
}) => {
   test.setTimeout(90_000);
   await dawn.boot(SCENARIOS.signedIn);
   await expectSignedInShell(page);
   await loseContext(page);
   const notice = page.getByText("The animated centerpiece stopped");
   await expect(notice).toBeVisible({ timeout: 15_000 }); // after a few seconds, not at once
   await restoreContext(page);
   await expect(notice).toHaveCount(0);
   expect(await reactorIsLive(page)).toBe(true);
});

test("signs in from the login card, and logs out back to it", async ({ page, dawn }) => {
   test.setTimeout(120_000); // two reloads (sign-in and logout); slow where WebGL runs in software
   const fake = await dawn.boot(SCENARIOS.signedOut);
   await expect(page.locator("#login-card .login-status")).toHaveText("Awaiting link");
   await page.locator('#login-card input[name="username"]').fill("tester");
   await page.locator('#login-card input[name="password"]').fill("a password");
   await page.locator("#login-card .login-connect").click();
   /* A first sign-in in this browser reloads onto a clean page, then resumes on the new login. */
   await expect(page.locator("#link-chip .link-text")).toHaveText("Linked", { timeout: 30_000 });
   expect(fake.requests).toContain("init");

   await page.locator("#link-chip").click();
   await page.getByRole("button", { name: "Log out", exact: true }).click();
   /* DAWN ends the login (force_logout, then a 4002 close); Aurora clears the user's state and
      reloads to the login card. */
   await expect(page.locator("#login-card")).toBeVisible({ timeout: 30_000 });
   await expect(page.locator("#login-card .login-status")).toHaveText("Awaiting link");
   expect(fake.log.some((e) => e.text === "POST /api/auth/logout?app=aurora")).toBe(true);
   /* The wipe really happened: the user this browser last signed in as is forgotten. */
   expect(await page.evaluate(() => localStorage.getItem("dawn.hero.lastUser"))).toBeNull();
});
