/* The Memory panel's Learned list against the fake DAWN's batches (tests/fake-dawn/memory-batches.ts):
   it comes up only on a DAWN that records batches, and an Undo, a Keep, a Forget and an Undo all
   each change what it shows. WebGL off, as in smoke.spec.ts (none of this is about the reactor). */

import { SCENARIOS, TRANSCRIPT, type Scenario } from "../fake-dawn/scenarios.ts";
import { expect, expectSignedInShell, test } from "./fixture.ts";

test.use({ launchOptions: { args: ["--disable-webgl"] } });

/* A returning user who left the Memory panel open. */
const withPanel = (s: Scenario): Scenario => ({
   ...s,
   storage: { ...s.storage, "dawn.hero.memoryShown": "true" }
});

test("an older DAWN: no Memory panel, and nothing asked", async ({ page, dawn }) => {
   const fake = await dawn.boot(withPanel(SCENARIOS.legacyDawn));
   await expectSignedInShell(page, false);
   await expect(page.locator("#memory")).toBeHidden();
   expect(fake.transcript()).not.toContain("list_memory_batches");
});

test("the Learned list: undo, keep, forget and undo all", async ({ page, dawn }) => {
   test.setTimeout(120_000);
   const fake = await dawn.boot(withPanel(SCENARIOS.signedIn));
   await expectSignedInShell(page, false);
   const panel = page.locator("#memory");
   await expect(panel).toBeVisible();
   const batches = panel.locator(".memory-batch");
   await expect(batches).toHaveCount(3);
   await expect(batches.nth(0).locator(".memory-batch-summary")).toHaveText(
      "2 learned, 1 updated, 1 not kept"
   );
   await expect(panel.locator(".memory-tag")).toHaveCount(0); // tags show once a batch is open

   /* Each batch is headed by its conversation, and the title opens it. */
   const title = batches.nth(0).locator(".memory-batch-conv");
   await expect(title).toHaveText(TRANSCRIPT.title);
   const loads = (): number => fake.transcript().split('"type":"load_conversation"').length;
   const before = loads();
   await title.click();
   await expect.poll(loads).toBeGreaterThan(before);

   /* Open the newest batch: its changes, each with the one action DAWN allows. */
   const newest = batches.nth(0);
   await newest.locator(".memory-batch-head").click();
   const ops = newest.locator(".memory-op");
   await expect(ops).toHaveCount(4);
   await expect(ops.nth(2).locator(".memory-op-reason")).toHaveText(
      "Model's reason: The same preference, said two ways"
   );

   /* A single Undo goes at once. */
   await ops
      .nth(1)
      .getByRole("button", { name: /^Undo:/ })
      .click();
   await expect(ops.nth(1).locator(".memory-tag")).toHaveText("Undone");
   await expect(newest.locator(".memory-batch-tags")).toContainText("Partly undone");

   /* Keep stores the candidate: it reads Kept, and the stored fact joins the batch. */
   await ops
      .nth(3)
      .getByRole("button", { name: /^Keep:/ })
      .click();
   await expect(ops.nth(3).locator(".memory-tag")).toHaveText("Kept");
   await expect(ops).toHaveCount(5);
   await expect(ops.nth(4).locator(".memory-op-text")).toHaveText(
      "Said the weather was nice today"
   );

   /* Undo all asks first, then undoes what's left. */
   await newest.getByRole("button", { name: /^Undo all:/ }).click();
   const dialog = page.locator(".dialog-card");
   await expect(dialog.locator(".dialog-title")).toHaveText("Undo 3 changes?");
   await dialog.getByRole("button", { name: "Undo all", exact: true }).click();
   await expect(newest.locator(".memory-action")).toHaveCount(0);

   /* Forget a suggestion: confirmed, and its row leaves the batch. */
   const older = batches.nth(1);
   await older.locator(".memory-batch-head").click();
   await expect(older.locator(".memory-batch-tags")).toHaveText("Read outside text: an email");
   await expect(older.locator(".memory-op")).toHaveCount(2);
   await older.getByRole("button", { name: /^Forget:/ }).click();
   await expect(dialog.locator(".dialog-title")).toHaveText("Forget this memory?");
   await dialog.getByRole("button", { name: "Forget", exact: true }).click();
   await expect(older.locator(".memory-op")).toHaveCount(1);
});
