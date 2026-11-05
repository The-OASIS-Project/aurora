/* The Node adapter: serves a FakeDawn from a real HTTP server, for offline development
   (`npm run dev:fake`, through the Vite plugin in vite.config.ts) and anything else that needs a
   fake DAWN over the network. The same core as the smoke test's Playwright adapter
   (tests/smoke/fake-dawn-page.ts); docs/FAKE_DAWN_PLAN.md phase 2. */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { FakeDawn } from "./fake-dawn.ts";
import { forceLogout, type Scenario } from "./scenarios.ts";

/* The largest request body or socket message accepted (a login is a few hundred bytes, a frame a
   few kilobytes): the dev server listens on the LAN, so nothing from it is taken unbounded. */
const MAX_BODY = 64 * 1024;
/* How much of the fake's log a long dev session keeps. */
const MAX_LOG = 2000;

export interface NodeFakeDawn {
   fake: FakeDawn;
   /* Connect-style middleware: answers DAWN's /api/* paths, passes everything else on. */
   middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
   /* Stops the socket server (on dev server shutdown). */
   close: () => void;
}

/* The request body, or null when it's larger than MAX_BODY (the rest is read and dropped, so the
   413 that follows reaches the client). Rejects only when the request itself fails. */
function readBody(req: IncomingMessage): Promise<string | null> {
   return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
         size += c.length;
         if (size <= MAX_BODY) chunks.push(c);
      });
      req.on("end", () => resolve(size > MAX_BODY ? null : Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
   });
}

/* Control characters escaped, so text a LAN client chose (a frame type, a query value) can't
   move the cursor or retitle the terminal the dev server logs to. */
function printable(line: string): string {
   return line.replace(
      // eslint-disable-next-line no-control-regex -- matching control characters is the point
      /[\u0000-\u001f\u007f]/g,
      (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`
   );
}

/* A text frame's data as a string (ws hands it over as one Buffer, a list of them, or an
   ArrayBuffer). */
function frameText(data: RawData): string {
   if (Buffer.isBuffer(data)) return data.toString("utf8");
   if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
   return Buffer.from(data).toString("utf8");
}

/* The origin a request came to (the page's own), for the fake's same-origin socket check. */
function requestOrigin(req: IncomingMessage, secure: boolean, ws: boolean): string {
   const scheme = ws ? (secure ? "wss" : "ws") : secure ? "https" : "http";
   return `${scheme}://${req.headers.host ?? "localhost"}`;
}

/* A fake DAWN on `server`: its /api/* answers (through the returned middleware) and its /ws
   socket. Any other upgrade (Vite's hot-reload socket) is left alone. `log` gets each violation:
   in development a violation is a message to read, not a test failure. */
export function attachFakeDawn(
   server: Server,
   scenario: Scenario,
   opts: { secure: boolean; log: (line: string) => void }
): NodeFakeDawn {
   const fake = new FakeDawn(scenario, { maxLog: MAX_LOG });
   fake.onViolation = (what) => opts.log(printable(`[fake DAWN] ${what}`));

   const sockets = new Set<WebSocket>();
   fake.onSessionEnd = () => {
      for (const ws of sockets) {
         ws.send(JSON.stringify(forceLogout()));
         ws.close(4002, "logged out");
      }
   };

   /* dawn-1.0 is chosen when the client asks for it; without it the upgrade still completes (as
      libwebsockets' HTTP fallback does) and the fake records the missing subprotocol. */
   const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_BODY,
      handleProtocols: (protocols) => (protocols.has("dawn-1.0") ? "dawn-1.0" : false)
   });

   const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
      const url = new URL(req.url ?? "/", requestOrigin(req, opts.secure, true));
      if (url.pathname !== "/ws" && url.pathname !== "/music-ws") return; // not DAWN's
      const protocols = (req.headers["sec-websocket-protocol"] ?? "")
         .split(",")
         .map((p) => p.trim())
         .filter(Boolean);
      /* The page's origin, from the browser's Origin header (DAWN checks it against the host:
         a socket from another site must not ride the login cookie). */
      const page = req.headers.origin ?? "";
      if (!fake.open(url, protocols, page.replace(/^http/, "ws"))) {
         socket.destroy();
         return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
         sockets.add(ws);
         ws.on("close", () => sockets.delete(ws));
         /* An oversized or malformed frame: ws reports it here and closes the connection. Without
            a listener Node would treat it as uncaught and stop the dev server. */
         ws.on("error", (e) => fake.violate(`socket error: ${e.message}`));
         ws.on("message", (data, isBinary) => {
            if (isBinary) {
               fake.violate("a binary frame on the main socket (no audio is expected)");
               return;
            }
            /* Nothing a client sends may take the dev server down: a fault in the fake is a
               violation to read, and that frame gets no answer. */
            try {
               for (const frame of fake.message(frameText(data))) ws.send(JSON.stringify(frame));
            } catch (e) {
               fake.violate(`the fake failed on a frame: ${(e as Error).message}`);
            }
         });
      });
   };
   server.on("upgrade", onUpgrade);

   const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
      const url = new URL(req.url ?? "/", requestOrigin(req, opts.secure, false));
      if (!url.pathname.startsWith("/api/")) {
         next();
         return;
      }
      const method = req.method ?? "GET";
      const answer = (body: string | undefined): void => {
         let reply: { status: number; body: unknown };
         try {
            reply = fake.http(method, url, body);
         } catch (e) {
            fake.violate(`the fake failed on ${method} ${url.pathname}: ${(e as Error).message}`);
            reply = { status: 500, body: { success: false, error: "Server error" } };
         }
         res.statusCode = reply.status;
         res.setHeader("Content-Type", "application/json");
         res.setHeader("Cache-Control", "no-store");
         res.end(JSON.stringify(reply.body));
      };
      if (method !== "POST") {
         answer(undefined);
         return;
      }
      readBody(req).then(
         (body) => {
            if (body !== null) {
               answer(body);
               return;
            }
            res.statusCode = 413;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ success: false, error: "Request too large" }));
         },
         () => res.destroy() // the request failed mid-way: nothing to answer
      );
   };

   return {
      fake,
      middleware,
      close: () => {
         server.off("upgrade", onUpgrade);
         for (const ws of sockets) ws.terminate();
         wss.close();
      }
   };
}
