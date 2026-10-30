// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DawnIngest } from "./dawn-ws.ts";

/* DawnIngest's recovery around a DAWN restart, with a fake socket and /api/auth/status. */
function setup(status: () => Promise<Response>) {
   vi.stubGlobal("fetch", vi.fn(status));
   const ing = new DawnIngest() as unknown as Record<string, any>;
   const statuses: string[] = [];
   ing.emit = (s: string) => statuses.push(s);
   const revoked: Array<string | undefined> = [];
   ing.revokeSession = (r?: string) => revoked.push(r);
   let opened = 0;
   ing.openSocket = () => {
      opened++;
   };
   const ws = { readyState: WebSocket.OPEN, send: () => {}, close: vi.fn() };
   ing.ws = ws;
   ing.wantConnected = true;
   return { ing, statuses, revoked, ws, opened: () => opened };
}
const json = (body: unknown): Promise<Response> => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
const down = (): Promise<Response> => Promise.resolve(new Response("", { status: 502 }));
const flush = async (): Promise<void> => {
   for (let i = 0; i < 50; i++) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
   vi.useRealTimers();
   vi.unstubAllGlobals();
});

describe("UNAUTHORIZED during a DAWN restart", () => {
   it("signs out only when auth status keeps agreeing", async () => {
      const t = setup(() => json({ authenticated: false }));
      const done = t.ing.onUnauthorized("Session expired or revoked");
      for (let i = 0; i < 3; i++) {
         await flush();
         expect(t.revoked).toEqual([]);
         vi.advanceTimersByTime(3000);
      }
      await done;
      expect(t.revoked).toEqual(["Session expired or revoked"]);
      expect(t.ws.close).not.toHaveBeenCalled();
   });

   it("doesn't sign out when the socket goes away while it re-asks (DAWN shutting down)", async () => {
      const t = setup(() => json({ authenticated: false }));
      const done = t.ing.onUnauthorized("x");
      await flush();
      t.ing.ws = null; // DAWN closed the socket: the WebUI stopped
      vi.advanceTimersByTime(3000);
      await done;
      expect(t.revoked).toEqual([]);
   });

   it("a manual sign-in while a resume check is in flight opens one socket", async () => {
      let release: (r: Response) => void = () => {};
      const t = setup(() => new Promise<Response>((r) => (release = r)));
      t.ing.wantConnected = false;
      const resume = t.ing.tryResume();
      t.ing.wantConnected = true; // connect() got there first
      release(new Response(JSON.stringify({ authenticated: true, username: "" }), { status: 200 }));
      await resume;
      expect(t.opened()).toBe(0);
   });

   it("reconnects instead when DAWN can't be reached, or says the login holds", async () => {
      const t = setup(down);
      await t.ing.onUnauthorized("x");
      expect(t.revoked).toEqual([]);
      expect(t.ws.close).toHaveBeenCalledTimes(1);
      const u = setup(() => json({ authenticated: true }));
      await u.ing.onUnauthorized("x");
      expect(u.revoked).toEqual([]);
      expect(u.ws.close).toHaveBeenCalledTimes(1);
   });

   it("gives up after a few unconfirmed refusals in a row", async () => {
      const t = setup(() => json({ authenticated: true }));
      for (let i = 0; i < 3; i++) await t.ing.onUnauthorized("x");
      expect(t.revoked).toEqual([]);
      await t.ing.onUnauthorized("x");
      expect(t.revoked).toEqual(["x"]);
   });
});

describe("resuming on page load", () => {
   it("waits for an unreachable DAWN instead of showing the login card", async () => {
      let up = false;
      const t = setup(() => (up ? json({ authenticated: true, username: "" }) : down()));
      t.ing.wantConnected = false;
      await t.ing.tryResume();
      expect(t.statuses).toEqual(["connecting"]);
      up = true;
      vi.advanceTimersByTime(1000);
      await flush();
      expect(t.opened()).toBe(1);
      expect(t.statuses).not.toContain("idle");
   });

   it("resumes from the login card once DAWN says the cookie is good after all", async () => {
      let loggedIn = false;
      const t = setup(() => json({ authenticated: loggedIn, username: "" }));
      t.ing.wantConnected = false;
      await t.ing.tryResume();
      expect(t.statuses).toEqual(["idle"]);
      vi.advanceTimersByTime(5000);
      await flush();
      expect(t.opened()).toBe(0); // still "no": nothing happens
      loggedIn = true;
      vi.advanceTimersByTime(5000);
      await flush();
      await flush();
      expect(t.opened()).toBe(1);
   });
});

describe("a DAWN with login_unavailable", () => {
   it("signs out on UNAUTHORIZED at once, and shrugs off SERVICE_UNAVAILABLE", async () => {
      const t = setup(() => json({ authenticated: true }));
      t.ing.serverFeatures = new Set(["login_unavailable"]);
      t.ing.onFrame(JSON.stringify({ type: "error", payload: { code: "SERVICE_UNAVAILABLE", message: "Couldn't check the login; try again" } }));
      expect(t.revoked).toEqual([]);
      expect(t.statuses).not.toContain("error");
      await t.ing.onUnauthorized("Session expired");
      expect(t.revoked).toEqual(["Session expired"]);
      expect(fetch).not.toHaveBeenCalled();
   });
});

describe("SERVICE_UNAVAILABLE", () => {
   it("gives a refused typed turn back instead of swallowing it", () => {
      const t = setup(() => json({ authenticated: true }));
      t.ing.serverFeatures = new Set(["login_unavailable", "turn_refs"]);
      const rejected: unknown[] = [];
      const notes: string[] = [];
      t.ing.sinks = { conversation: { rejectTurn: (r: unknown) => (rejected.push(r), 1), noteRefusal: (m: string) => notes.push(m), setThinking: () => {} } };
      t.ing.dropTypedEchoRef = () => {};
      t.ing.onFrame(JSON.stringify({ type: "error", payload: { code: "SERVICE_UNAVAILABLE", message: "Couldn't check the login; try again", client_ref: "7", severity: "error" } }));
      expect(rejected).toEqual([{ ref: "7" }]);
      expect(notes[0]).toContain("Couldn't check the login");
   });

   it("keeps probing a ping it answered, so the link doesn't stay unstable while other replies flow", () => {
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
      const t = setup(() => json({ authenticated: true }));
      const pings: number[] = [];
      t.ing.send = (m: { type: string }) => m.type === "ping" && pings.push(1);
      t.ing.pongSupported = true;
      t.ing.startHeartbeat();
      t.ing.onFrame(JSON.stringify({ type: "error", payload: { code: "SERVICE_UNAVAILABLE", message: "x" } }));
      for (let s = 0; s < 40; s += 2) {
         vi.advanceTimersByTime(2000);
         t.ing.lastInboundAt = performance.now(); // other replies keep coming
      }
      expect(pings.length).toBeGreaterThan(1);
      expect(t.ws.close).toHaveBeenCalled(); // no pong at all: a second miss reconnects
      t.ing.stopHeartbeat();
   });
});
