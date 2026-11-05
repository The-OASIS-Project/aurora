/* The Playwright adapter: puts a FakeDawn in place of DAWN for one page. Every request the page
   makes outside the app's own files, and every socket it opens, goes to the fake (a socket route
   that never connects to a server); nothing reaches the network. */

import type { Page, WebSocketRoute } from "@playwright/test";
import { FakeDawn } from "../fake-dawn/fake-dawn.ts";
import { forceLogout, type Scenario } from "../fake-dawn/scenarios.ts";

/* Where the app is served (vite.config.ts `base`). */
export const BASE = "/aurora/";

export async function attachFakeDawn(
   page: Page,
   scenario: Scenario,
   origin: string
): Promise<FakeDawn> {
   const fake = new FakeDawn(scenario);

   /* The browser this scenario stands for (a returning user's localStorage), set before any app
      code runs, once per tab: a reload keeps what the app wrote. */
   await page.addInitScript((storage: Record<string, string>) => {
      if (sessionStorage.getItem("fake-dawn-seeded") !== null) return;
      sessionStorage.setItem("fake-dawn-seeded", "1");
      for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
   }, scenario.storage);

   await page.route("**/*", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const own = url.origin === origin;
      if (own && url.pathname.startsWith(BASE)) {
         await route.continue(); // the app's own files, from vite preview
         return;
      }
      /* The browser asks for a favicon on its own (the page declares none): not the app's doing. */
      if (own && url.pathname === "/favicon.ico") {
         await route.fulfill({ status: 204, body: "" });
         return;
      }
      if (own && url.pathname.startsWith("/api/")) {
         const reply = fake.http(req.method(), url, req.postData() ?? undefined);
         await route.fulfill({
            status: reply.status,
            contentType: "application/json",
            body: JSON.stringify(reply.body)
         });
         return;
      }
      fake.violate(`request outside the app and DAWN: ${req.method()} ${url.href}`);
      await route.abort();
   });

   /* DAWN's socket is same-origin with the page (http -> ws, https -> wss). */
   const wsOrigin = origin.replace(/^http/, "ws");
   /* A logout ends the login: DAWN tells each of its sockets, then closes it with 4002
      (webui_login_sweep.c). */
   const open = new Set<WebSocketRoute>();
   fake.onSessionEnd = () => {
      for (const ws of open) {
         ws.send(JSON.stringify(forceLogout()));
         void ws.close({ code: 4002, reason: "logged out" });
      }
      open.clear();
   };

   await page.routeWebSocket(
      () => true,
      (ws) => {
         if (!fake.open(new URL(ws.url()), ws.protocols(), wsOrigin)) {
            void ws.close({ code: 1008, reason: "fake DAWN: unexpected socket" });
            return;
         }
         open.add(ws);
         /* Setting onClose turns off Playwright's own close handling, so finish the close here:
            without it a close the page starts (a reconnect after a dead link) never completes,
            and the client's onclose never runs. */
         ws.onClose((code, reason) => {
            open.delete(ws);
            void ws.close({ code, reason });
         });
         ws.onMessage((data) => {
            if (typeof data !== "string") {
               fake.violate("a binary frame on the main socket (no audio is expected)");
               return;
            }
            for (const frame of fake.message(data)) ws.send(JSON.stringify(frame));
         });
      }
   );

   return fake;
}
