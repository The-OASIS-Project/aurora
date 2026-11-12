/* The Playwright adapter: puts a FakeDawn in place of DAWN for one page. Every request the page
   makes outside the app's own files, and every socket it opens, goes to the fake (a socket route
   that never connects to a server); nothing reaches the network. */

import type { Page, WebSocketRoute } from "@playwright/test";
import { FakeDawn, deliveryTargets } from "../fake-dawn/fake-dawn.ts";
import { forceLogout, superseded, type Scenario } from "../fake-dawn/scenarios.ts";

/* Where the app is served (vite.config.ts `base`). */
export const BASE = "/aurora/";

/* One fake DAWN for a test, and the tabs it serves: `attach` puts it in place of DAWN for one more
   page of the same browser (they share its sessions, as two tabs share one DAWN). It runs until
   `close`, at the end of the test: a tab closing doesn't stop a reply another tab may resume. */
export interface PageDawn {
   fake: FakeDawn;
   attach(page: Page): Promise<void>;
   close(): void;
}

export function pageDawn(scenario: Scenario, origin: string): PageDawn {
   const fake = new FakeDawn(scenario);
   /* DAWN's socket is same-origin with the page (http -> ws, https -> wss). */
   const wsOrigin = origin.replace(/^http/, "ws");
   /* Every tab's open sockets by connection id (the fake only accepts /ws): a frame it sends on its
      own goes to one connection or to all but one (deliveryTargets). */
   const sockets = new Map<string, WebSocketRoute>();
   let nextConn = 0;
   /* A socket the fake closes itself gets no onClose from Playwright, so it's dropped here. */
   const shut = (conn: string, frame: object, code: number, reason: string): void => {
      const ws = sockets.get(conn);
      sockets.delete(conn);
      fake.closed(conn);
      if (!ws) return;
      ws.send(JSON.stringify(frame));
      void ws.close({ code, reason });
   };
   /* A logout ends the login: DAWN tells each of its sockets, then closes it with 4002
      (webui_login_sweep.c). */
   fake.onSessionEnd = () => {
      for (const conn of [...sockets.keys()]) shut(conn, forceLogout(), 4002, "logged out");
   };
   /* A connection another took its session from: told, then closed with 4001, as DAWN does. */
   fake.onEvict = (conn) => shut(conn, superseded(), 4001, "superseded");
   fake.onPush = (frame, to) => {
      for (const ws of deliveryTargets(sockets, to)) ws.send(JSON.stringify(frame));
   };

   const attach = async (page: Page): Promise<void> => {
      if (page.isClosed()) throw new Error("fake DAWN: attach to a closed page");
      /* Playwright reports no close for the sockets of a page that closes, so they're let go
         here (in DAWN their sessions lose their owner the same way). */
      const mine = new Set<string>();
      page.on("close", () => {
         for (const conn of mine) {
            sockets.delete(conn);
            fake.closed(conn);
         }
      });

      /* The browser this scenario stands for (a returning user's localStorage), set before any
         app code runs, once per browser (its tabs share localStorage): a reload, or another tab,
         keeps what the app wrote since. */
      await page.addInitScript((storage: Record<string, string>) => {
         if (localStorage.getItem("fake-dawn-seeded") !== null) return;
         localStorage.setItem("fake-dawn-seeded", "1");
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
         /* The browser asks for a favicon on its own (the page declares none): not the app's
            doing. */
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

      await page.routeWebSocket(
         () => true,
         (ws) => {
            if (!fake.open(new URL(ws.url()), ws.protocols(), wsOrigin)) {
               void ws.close({ code: 1008, reason: "fake DAWN: unexpected socket" });
               return;
            }
            const conn = `ws${++nextConn}`;
            sockets.set(conn, ws);
            mine.add(conn);
            /* Setting onClose turns off Playwright's own close handling, so finish the close
               here: without it a close the page starts (a reconnect after a dead link) never
               completes, and the client's onclose never runs. */
            ws.onClose((code, reason) => {
               mine.delete(conn);
               sockets.delete(conn);
               fake.closed(conn);
               void ws.close({ code, reason });
            });
            ws.onMessage((data) => {
               /* A frame racing a close the fake started (an eviction, a logout): the socket is
                  done, so it starts nothing. */
               if (!sockets.has(conn)) return;
               if (typeof data !== "string") {
                  fake.violate("a binary frame on the main socket (no audio is expected)");
                  return;
               }
               for (const frame of fake.message(data, conn)) ws.send(JSON.stringify(frame));
            });
         }
      );
   };

   return { fake, attach, close: () => fake.dispose() };
}
