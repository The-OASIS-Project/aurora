/* The smoke test: does the bundle that ships start and stand up against DAWN? The fixture and
   what fails a run: fixture.ts.

   These run with WebGL off: none of them is about the reactor, and headless Chromium draws it in
   software, on the CPU, every frame, which made a run slow and its waits time out on a busy
   machine. Aurora without WebGL is a supported setup (no-webgl.spec.ts), so this is still the app
   a user can get, with a notice saying why the centerpiece is off. The reactor's own tests, with
   WebGL, are in reactor.spec.ts. */

import { CONVERSATION_ID, SCENARIOS } from "../fake-dawn/scenarios.ts";
import { expect, expectSignedInShell, test } from "./fixture.ts";
import type { Page } from "@playwright/test";

test.use({ launchOptions: { args: ["--disable-webgl"] } });

test("signed out: the login card, and no socket", async ({ page, dawn }) => {
   const fake = await dawn.boot(SCENARIOS.signedOut);
   await expect(page.locator("#login-card")).toBeVisible();
   await expect(page.locator("#login-card .login-status")).toHaveText("Awaiting link");
   await expect(page.locator('#login-card input[name="username"]')).toBeEditable();
   await expect(page.locator("#link-chip")).toBeHidden();
   expect(fake.sockets).toEqual([]);
   expect(fake.requests).toEqual([]);
});

test("an older DAWN (no feature flags): signed in, nothing tagged", async ({ page, dawn }) => {
   const fake = await dawn.boot(SCENARIOS.legacyDawn);
   await expectSignedInShell(page, false);
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
   /* Only after the socket opens and the config frame arrives, so as long as connecting takes. */
   await expect(page.locator("#login-card .login-status")).toHaveText(
      "Link failed: DAWN v0.0.0-fake is newer than this Aurora. Update Aurora to connect.",
      { timeout: 30_000 }
   );
   /* It got as far as the socket, then stopped at the config frame's protocol. */
   expect(fake.requests[0]).toBe("init");
   expect(fake.requests).not.toContain("load_conversation");
});

test("signs in from the login card, and logs out back to it", async ({ page, dawn }) => {
   test.setTimeout(120_000); // two reloads (sign-in and logout)
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

test("sends a message and shows the streamed reply", async ({ page, dawn }) => {
   test.setTimeout(90_000);
   const fake = await dawn.boot(SCENARIOS.signedIn);
   await expectSignedInShell(page, false);
   const bubbles = page.locator(".convo-msg");
   await expect(bubbles).toHaveCount(fake.store.get(CONVERSATION_ID)!.messages.length);
   const before = await bubbles.count();
   const composer = page.locator("#composer-input");
   await composer.fill("How is the smoke test going?");
   await composer.press("Enter");
   await expect(page.locator(".convo-msg.user .convo-body").last()).toHaveText(
      "How is the smoke test going?"
   );
   const reply = page.locator(".convo-msg.assistant .convo-body").last();
   await expect(reply).toContainText("This is the fake DAWN", { timeout: 30_000 });
   await expect(reply.locator("blockquote")).toHaveText("How is the smoke test going?");
   await expect(reply.locator("code")).toHaveText("inline code");
   /* DAWN saved both rows: the conversation now holds the exchange. */
   await expect
      .poll(() =>
         fake.store
            .get(CONVERSATION_ID)
            ?.messages.map((m) => m.role)
            .slice(-2)
      )
      .toEqual(["user", "assistant"]);
   /* One bubble each: the saved rows' message_appended is matched to the echo and the streamed
      bubble, never drawn again. */
   await expect(bubbles).toHaveCount(before + 2);
   await expect(page.locator(".convo-msg.assistant .convo-body")).toHaveText([
      /./,
      /This is the fake DAWN/
   ]);
   expect(fake.requests).toContain("text");
});

test("New Chat clears the conversation, and the next message starts a new one", async ({
   page,
   dawn
}) => {
   test.setTimeout(90_000);
   const fake = await dawn.boot(SCENARIOS.signedIn);
   await expectSignedInShell(page, false);
   const before = fake.store.list().length;
   await page.locator(".cpick-new").click();
   await expect(page.locator(".convo-msg")).toHaveCount(0);
   const composer = page.locator("#composer-input");
   await composer.fill("A fresh start");
   await composer.press("Enter");
   await expect(page.locator(".convo-msg.assistant .convo-body").last()).toContainText(
      "This is the fake DAWN",
      { timeout: 30_000 }
   );
   /* DAWN made a conversation for it; the one that was open is unchanged. */
   expect(fake.store.list().length).toBe(before + 1);
   expect(fake.store.get(CONVERSATION_ID)!.messages).toHaveLength(2);
   expect(fake.requests).toEqual(expect.arrayContaining(["clear_session", "new_conversation"]));
});

test("the top band's defaults don't overlap, and + New is clickable, at common widths", async ({
   page,
   dawn
}) => {
   test.setTimeout(180_000); // boots, then five window sizes
   await dawn.boot(SCENARIOS.signedIn);
   await expectSignedInShell(page, false);
   const box = async (sel: string) => {
      const b = await page.locator(sel).boundingBox();
      if (!b) throw new Error(`${sel} has no box`);
      return b;
   };
   type Box = { x: number; y: number; width: number; height: number };
   const apart = (a: Box, b: Box): boolean =>
      a.x + a.width <= b.x ||
      b.x + b.width <= a.x ||
      a.y + a.height <= b.y ||
      b.y + b.height <= a.y;
   for (const [width, height] of [
      [900, 700], // narrow: the centered menubar reaches the telemetry readout's default spot
      [1024, 768],
      [1280, 720],
      [1366, 768],
      [1536, 864],
      [1920, 1080]
   ]) {
      await page.setViewportSize({ width, height });
      const picker = await box(".cpick-head");
      /* The telemetry readout, undragged, is kept below the menubar too (a keep-out). */
      expect(
         apart(await box("#hud-status"), await box("#menubar")),
         `${width}x${height}: telemetry vs menubar`
      ).toBe(true);
      for (const other of ["#menubar", "#hud-clock", "#hud-status"])
         expect(apart(picker, await box(other)), `${width}x${height}: picker vs ${other}`).toBe(
            true
         );
      /* What a click on + New would hit is + New itself, not whatever is drawn above it. */
      const hit = await page.evaluate(() => {
         const b = document.querySelector(".cpick-new")!.getBoundingClientRect();
         const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
         return Boolean(at?.closest(".cpick-new")); // nothing there (off screen) fails too
      });
      expect(hit, `${width}x${height}: + New is on top`).toBe(true);
   }
});

test("nothing can be dragged under the menubar, and the picker's dropdown stays on screen", async ({
   page,
   dawn
}) => {
   test.setTimeout(240_000); // several drags and two reloads
   await dawn.boot(SCENARIOS.signedIn);
   await expectSignedInShell(page, false);
   const menubar = page.locator("#menubar");
   /* Drags a view by its handle, by (dx, dy), in small steps like a hand would. */
   const drag = async (handle: string, dx: number, dy: number) => {
      const b = (await page.locator(handle).boundingBox())!;
      const x = b.x + 12;
      const y = b.y + b.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(400); // the snap's glide
   };
   const clearOfMenubar = async (sel: string) => {
      const m = (await menubar.boundingBox())!;
      const b = (await page.locator(sel).boundingBox())!;
      return b.y >= m.y + m.height || b.x + b.width <= m.x || b.x >= m.x + m.width;
   };
   const newOnTop = () =>
      page.evaluate(() => {
         const b = document.querySelector(".cpick-new")!.getBoundingClientRect();
         const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
         return Boolean(at?.closest(".cpick-new")); // nothing there (off screen) fails too
      });

   /* A position saved under the menubar (a top dock in its column: what the old snap saved) is
      moved below it on load, though every view restores before the menubar exists. */
   await page.evaluate(() =>
      localStorage.setItem(
         "dawn.hero.conversationsPos",
         JSON.stringify({ x: { a: "free", f: 0.42 }, y: { a: "lo" } })
      )
   );
   await page.reload();
   await expect(page.locator("#composer-input")).toBeVisible();
   expect(await clearOfMenubar(".cpick-head")).toBe(true);
   expect(await newOnTop()).toBe(true);
   await page.evaluate(() => localStorage.removeItem("dawn.hero.conversationsPos"));
   await page.reload();
   await expect(page.locator("#composer-input")).toBeVisible();

   /* A small nudge up and left: the top-edge snap used to pull it under the menubar. */
   await drag(".cpick-toggle", -40, -30);
   expect(await clearOfMenubar(".cpick-head")).toBe(true);
   expect(await newOnTop()).toBe(true);
   /* The spot it saved is clear too. */
   await page.reload();
   await expect(page.locator("#composer-input")).toBeVisible();
   expect(await clearOfMenubar(".cpick-head")).toBe(true);
   expect(await newOnTop()).toBe(true);

   /* A narrow window: the open dropdown is slid left to stay inside it. */
   await page.setViewportSize({ width: 480, height: 720 });
   await drag(".cpick-toggle", 400, 0); // toward the right edge
   await page.locator(".cpick-toggle").click();
   const panel = (await page.locator(".cpick-panel").boundingBox())!;
   expect(panel.x).toBeGreaterThanOrEqual(0);
   expect(panel.x + panel.width).toBeLessThanOrEqual(480);
   await page.locator(".cpick-toggle").click(); // closed again

   await page.setViewportSize({ width: 1280, height: 720 });
   /* A panel dragged up into the menubar's column stops below it. */
   const m = (await menubar.boundingBox())!;
   const lib = (await page.locator(".library-head").boundingBox())!;
   await drag(".library-head", m.x + 20 - lib.x, m.y - lib.y);
   expect(await clearOfMenubar("#library")).toBe(true);
});

test("a second tab takes the session over; the first can take it back", async ({ page, dawn }) => {
   test.setTimeout(120_000);
   const fake = await dawn.boot(SCENARIOS.signedIn);
   await expectSignedInShell(page, false);
   const takeover = (p: Page) => p.locator("#takeover-card");
   await expect(takeover(page)).toBeHidden();

   /* The second tab reconnects with the token the first stored, so DAWN gives it that session
      and evicts the first (session_superseded, then 4001): the first backs off and offers the
      takeover instead of fighting for it. */
   const second = await dawn.openTab();
   await expectSignedInShell(second, false);
   await expect(takeover(page)).toBeVisible();
   await expect(takeover(second)).toBeHidden();
   /* It landed on the first tab's own session: DAWN's session frame said so. */
   expect(fake.transcript()).toMatch(/"type":"session","payload":\{[^}]*"reconnected":true/);

   /* "Use DAWN here" takes it back: the first is live again with its transcript, and now the
      second offers the takeover. */
   await takeover(page).getByRole("button", { name: "Use DAWN here" }).click();
   await expect(takeover(page)).toBeHidden();
   await expect(takeover(second)).toBeVisible();
   await expectSignedInShell(page, false);
});
