import { defineConfig, devices } from "@playwright/test";

/* The smoke test (tests/smoke/, docs/FAKE_DAWN_PLAN.md): the production build, served by vite
   preview in smoke mode (plain http, no DAWN proxy), against a fake DAWN in the page. The build
   goes to .smoke/dist, never dist/ (which DAWN serves). */
const PORT = 4273;

export default defineConfig({
   testDir: "tests/smoke",
   /* One worker and no retries: a flaky smoke test is a bug to fix, not to hide. */
   workers: 1,
   retries: 0,
   forbidOnly: !!process.env.CI,
   reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
   use: {
      baseURL: `http://localhost:${PORT}`,
      trace: "retain-on-failure",
      screenshot: "only-on-failure",
      /* Skips the boot animation; the assertions wait on state, never on time. */
      contextOptions: { reducedMotion: "reduce" }
   },
   projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
   webServer: {
      command: `vite build --mode smoke --outDir .smoke/dist --emptyOutDir && vite preview --mode smoke --outDir .smoke/dist --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}/aurora/`,
      reuseExistingServer: false,
      timeout: 180_000
   }
});
