/* Tests drive a script-running DOM through jsdom (already present for vitest's jsdom environment);
   only the constructor is used, so a bare declaration is enough without adding @types/jsdom. */
declare module "jsdom" {
   export class JSDOM {
      constructor(html?: string, options?: { runScripts?: "dangerously" | "outside-only" });
      readonly window: unknown;
   }
}
