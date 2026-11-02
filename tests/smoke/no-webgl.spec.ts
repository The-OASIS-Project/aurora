/* A browser without WebGL (a privacy-hardened browser, an extension or IT policy blocking it, an
   old browser without WebGL2): Aurora starts without its centerpiece and says why, instead of failing to
   start. src/anchor/reactor.ts. */

import { SCENARIOS } from "../fake-dawn/scenarios.ts";
import { expect, expectSignedInShell, test } from "./fixture.ts";

test.use({ launchOptions: { args: ["--disable-webgl"] } });

const NOTICE = "The animated centerpiece is off";

test("no WebGL, signed out: the login card still comes up", async ({ page, dawn }) => {
   await dawn.boot(SCENARIOS.signedOut);
   await expect(page.locator("#login-card")).toBeVisible();
   await expect(page.locator("#login-card .login-status")).toHaveText("Awaiting link");
});

test("no WebGL, signed in: everything but the reactor, and the reason", async ({ page, dawn }) => {
   await dawn.boot(SCENARIOS.signedIn);
   await expectSignedInShell(page, false);
   await expect(page.getByText(NOTICE)).toBeVisible();
});
