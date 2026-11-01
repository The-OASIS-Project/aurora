import { defineConfig } from "vitest/config";

/* Standalone from vite.config.ts on purpose: the dev server's basic-ssl + DAWN proxy have
   no place in a unit run. The standby state machine is pure logic, so a plain node env is
   all it needs. */
export default defineConfig({
   test: {
      include: ["src/**/*.test.ts"],
      environment: "node",
      /* `npm run test:coverage` (CI on main): which of Aurora's own code the unit tests run.
         Reported, not gated: a number to watch and raise, not one to game. */
      coverage: {
         provider: "v8",
         include: ["src/**/*.ts"],
         exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
         reporter: ["text-summary", "json-summary", "html"],
         reportsDirectory: "coverage"
      }
   }
});
