import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

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

// Dev-only: the browser page is http://localhost:5273, but DAWN marks its cookie
// `Secure` (only sent over https). Strip that flag off the proxied Set-Cookie so
// the dev origin will store it; likewise relax SameSite to Lax. Never ships: this
// is the dev server config, not the production bundle.
function stripCookieSecurity(setCookie: string[]): string[] {
   return setCookie.map((c) =>
      c.replace(/;\s*Secure/gi, "").replace(/;\s*SameSite=Strict/gi, "; SameSite=Lax")
   );
}

export default defineConfig({
   plugins: [basicSsl()],
   server: {
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
         }
      }
   },
   build: {
      target: "es2022",
      outDir: "dist"
   }
});
