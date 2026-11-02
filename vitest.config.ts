import { defineConfig } from "vitest/config";

/* Standalone from vite.config.ts on purpose: the dev server's basic-ssl + DAWN proxy have
   no place in a unit run. The standby state machine is pure logic, so a plain node env is
   all it needs. */
export default defineConfig({
   test: {
      environment: "node",
      projects: [
         {
            extends: true,
            test: {
               name: "unit",
               include: ["src/**/*.test.ts"],
               exclude: ["src/**/*.property.test.ts"]
            }
         },
         {
            /* Property tests (fast-check, src/test/hostile.ts) are a fuzz-style workload: each
               runs hundreds of generated inputs, and their time follows the machine's load (one
               that takes 2 s alone can pass 5 s on a busy machine). So every one gets a
               fuzz-sized timeout here, rather than each test remembering to set its own. */
            extends: true,
            test: {
               name: "property",
               include: ["src/**/*.property.test.ts"],
               testTimeout: 60_000
            }
         }
      ],
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
