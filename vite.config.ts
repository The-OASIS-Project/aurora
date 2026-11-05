import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { CLIENT_PROTOCOL } from "./src/ingest/contract.ts";

// The Node versions Aurora supports, from package.json's `engines` ("^22.22.2 || ^24.15.0 ||
// >=26.0.0": a caret pins the major, >= is a floor). Checked here so `dev`, `dev:fake` and `build`
// stop with a plain message on an older Node instead of a crash from inside it (Node 22.21's
// HTTP/2 server, for one, crashes on the first WebSocket upgrade).
const PACKAGE = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as {
   version: string;
   engines?: { node?: string };
};
function nodeSupported(version: string, range: string): boolean {
   const parse = (v: string): number[] => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
   const atLeast = (v: number[], min: number[]): boolean => {
      for (let i = 0; i < 3; i++)
         if ((v[i] ?? 0) !== (min[i] ?? 0)) return (v[i] ?? 0) > (min[i] ?? 0);
      return true;
   };
   const v = parse(version);
   return range.split("||").some((part) => {
      const m = /^\s*(\^|>=)\s*(\d+(?:\.\d+){0,2})\s*$/.exec(part);
      if (!m) return false;
      const min = parse(m[2]);
      return m[1] === ">=" ? atLeast(v, min) : v[0] === min[0] && atLeast(v, min);
   });
}
const nodeRange = PACKAGE.engines?.node;
if (nodeRange && !nodeSupported(process.versions.node, nodeRange))
   throw new Error(
      `Aurora needs Node ${nodeRange}; this is Node ${process.versions.node}. ` +
         "With nvm, run `nvm use` in this folder (it reads .nvmrc)."
   );

// App version, read from package.json at config time and injected as a global
// (__APP_VERSION__) so the About dialog can show it without a runtime JSON import.
const APP_VERSION = PACKAGE.version;

// The commit the build came from: AURORA_BUILD_COMMIT when set (the release workflow sets it to
// the tagged commit), else this checkout's HEAD, marked "-dirty" when it has uncommitted changes;
// omitted without git. (Not GITHUB_SHA: on a pull request that's a merge commit on no branch.)
function buildCommit(): string | undefined {
   if (process.env.AURORA_BUILD_COMMIT) return process.env.AURORA_BUILD_COMMIT;
   try {
      const git = (...args: string[]): string =>
         execFileSync("git", args, {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"]
         }).trim();
      const head = git("rev-parse", "HEAD");
      return git("status", "--porcelain") ? `${head}-dirty` : head;
   } catch {
      return undefined;
   }
}

// aurora-release.json in every build: what this bundle is (version, commit) and the DAWN wire
// protocol it speaks. A release archive carries it (RELEASING.md), so DAWN's packaging can check
// an Aurora release speaks its protocol before bundling it; a deployed copy can be identified.
function releaseManifest(): Plugin {
   return {
      name: "aurora-release-manifest",
      apply: "build",
      generateBundle() {
         const commit = buildCommit();
         this.emitFile({
            type: "asset",
            fileName: "aurora-release.json",
            source: `${JSON.stringify(
               {
                  name: "aurora",
                  version: APP_VERSION,
                  ...(commit ? { commit } : {}),
                  protocol: CLIENT_PROTOCOL
               },
               null,
               3
            )}\n`
         });
      }
   };
}

// `npm run dev:fake` (`--mode fake`): the dev server with a fake DAWN in place of the real one
// (tests/fake-dawn/, the same fake the smoke test uses), for working on Aurora with no daemon. The
// real client talks to it as it would to DAWN; FAKE_DAWN_SCENARIO picks the scenario (default
// signedIn; see tests/fake-dawn/scenarios.ts). Loaded only in that mode, so `dev` and `build` never
// touch it. docs/FAKE_DAWN_PLAN.md phase 2.
function fakeDawn(): Plugin {
   return {
      name: "aurora-fake-dawn",
      apply: "serve",
      async configureServer(server) {
         const { SCENARIOS } = await import("./tests/fake-dawn/scenarios.ts");
         const { attachFakeDawn } = await import("./tests/fake-dawn/node-adapter.ts");
         const name = process.env.FAKE_DAWN_SCENARIO ?? "signedIn";
         if (!Object.hasOwn(SCENARIOS, name))
            throw new Error(
               `FAKE_DAWN_SCENARIO=${name}: not a scenario (${Object.keys(SCENARIOS).join(", ")})`
            );
         if (!server.httpServer) return; // middleware mode: no server of our own to attach to
         const node = attachFakeDawn(
            server.httpServer as import("node:http").Server,
            SCENARIOS[name as keyof typeof SCENARIOS],
            { secure: true, log: (line) => server.config.logger.warn(line) }
         );
         server.middlewares.use(node.middleware);
         server.httpServer.on("close", () => node.close());
         server.config.logger.info(`  fake DAWN: scenario "${name}"`);
      }
   };
}

// Minimal by design. Vite is the "make" of this project: one command to compile
// TypeScript and serve with live-reload. The render layer is hand-rolled, so
// there is nothing framework-specific to configure.
//
// HTTPS (basicSsl): the dev server is served over TLS with an auto-generated,
// cached self-signed cert. This is REQUIRED for the music player: WebCodecs
// (AudioDecoder) and AudioWorklet are secure-context-only, and `localhost` is the
// only http origin browsers treat as secure. Without HTTPS, opening the dashboard
// from another machine (http://<ip>:5273) cannot decode music audio. Accept the
// self-signed cert once per browser (same as DAWN's own cert).
//
// The one addition is a DEV PROXY to DAWN. The dashboard talks only to its own
// origin (localhost:5273) for /api and /ws; Vite forwards both to the DAWN daemon.
// This sidesteps two cross-origin problems that would otherwise block the login
// cookie: (1) CORS on the /api/auth calls, and (2) the dawn_session cookie is
// HttpOnly + Secure + SameSite=Strict, so it only rides the WebSocket handshake
// when it looks first-party. Proxying makes DAWN same-origin from the browser's
// point of view, so the cookie is set on :5273 and sent back on the /ws upgrade.
//
// DAWN target: point this at your daemon. It serves TLS (ssl_cert_path is set in
// dawn.toml), so the target is https/wss and `secure:false` accepts the
// self-signed cert. Change DAWN_TARGET if your daemon lives elsewhere.
const DAWN_TARGET = "https://localhost:3000";

// DAWN's dedicated music-stream server runs on the main port + 1, same host, and
// shares DAWN's TLS cert. Derived from DAWN_TARGET so there is one place to edit.
const dawnUrl = new URL(DAWN_TARGET);
const DAWN_MUSIC_TARGET = `https://${dawnUrl.hostname}:${Number(dawnUrl.port || "443") + 1}`;

// Dev-only: relax SameSite=Strict to Lax on the proxied Set-Cookie. `Secure` is KEPT: the dev
// server is https (basicSsl), and DAWN's login cookies are `__Host-` prefixed, which a browser
// silently rejects without `Secure` (or with a `Domain` attribute - so no cookieDomainRewrite
// either). Never ships: this is the dev server config, not the production bundle.
function stripCookieSecurity(setCookie: string[]): string[] {
   return setCookie.map((c) => c.replace(/;\s*SameSite=Strict/gi, "; SameSite=Lax"));
}

// The `smoke` mode (`--mode smoke`, the smoke test's build and preview; tests/smoke/) drops the
// HTTPS cert and the DAWN proxy: plain http on localhost (still a secure context), and nothing can
// reach a real DAWN, since the test's fake DAWN answers every DAWN request in the page.
export default defineConfig(({ mode }) => {
   const smoke = mode === "smoke";
   const fake = mode === "fake";
   return {
      // Served under /aurora when co-located behind DAWN (same-origin subpath, so DAWN's
      // WebUI keeps "/"). One base for dev and build, so the dev server also serves at
      // https://localhost:5273/aurora/. API/WS paths stay absolute at the root (/api, /ws,
      // /music-ws) and are unaffected. Worklets live in public/worklets/ and are loaded via
      // import.meta.env.BASE_URL so they resolve under this base too.
      base: "/aurora/",
      define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
      plugins: smoke
         ? [releaseManifest()]
         : fake
           ? [basicSsl(), releaseManifest(), fakeDawn()]
           : [basicSsl(), releaseManifest()],
      server: smoke
         ? {}
         : fake
           ? { host: true, port: 5274 } // beside `npm run dev` (5273); no DAWN proxy
           : {
                host: true,
                port: 5273,
                proxy: {
                   "/api": {
                      target: DAWN_TARGET,
                      changeOrigin: true,
                      secure: false,
                      configure: (proxy) => {
                         proxy.on("proxyRes", (proxyRes) => {
                            const sc = proxyRes.headers["set-cookie"];
                            if (sc) proxyRes.headers["set-cookie"] = stripCookieSecurity(sc);
                         });
                      }
                   },
                   "/ws": {
                      target: DAWN_TARGET,
                      changeOrigin: true,
                      secure: false,
                      ws: true
                   },
                   // The dedicated dawn-music audio stream (subprotocol `dawn-music`), proxied
                   // same-origin like /ws so it works for remote browsers too. It authenticates with
                   // the session token AND the login cookie (__Host-dawn_session, or __Host-dawn_session_aurora
                   // with DAWN's per-app logins; DAWN checks the cookie's user owns the session), which the
                   // browser sends here and the proxy forwards on the upgrade. NOTE: the path must NOT start with
                   // "/ws", or the broader "/ws" rule above captures it and routes it to the
                   // main server (which does not speak dawn-music). Hence "/music-ws".
                   "/music-ws": {
                      target: DAWN_MUSIC_TARGET,
                      changeOrigin: true,
                      secure: false,
                      ws: true
                   },
                   // Vendor scripts (Chart.js, ...) that model-generated `<dawn-visual type=html>`
                   // blocks reference as `<script src="/js/vendor/X">`; the visual renderer fetches
                   // and inlines them into its sandboxed iframe. DAWN serves them from its www root,
                   // and in production the HUD is same-origin with DAWN so this path resolves there too.
                   "/js/vendor": {
                      target: DAWN_TARGET,
                      changeOrigin: true,
                      secure: false
                   }
                }
             },
      build: {
         target: "es2022",
         outDir: "dist"
      }
   };
});
