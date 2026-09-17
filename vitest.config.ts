import { defineConfig } from "vitest/config";

/* Standalone from vite.config.ts on purpose: the dev server's basic-ssl + DAWN proxy have
   no place in a unit run. The standby state machine is pure logic, so a plain node env is
   all it needs. */
export default defineConfig({
   test: {
      include: ["src/**/*.test.ts"],
      environment: "node"
   }
});
