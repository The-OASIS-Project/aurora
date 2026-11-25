// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DawnIngest } from "./dawn-ws.ts";
import { MusicAudio } from "../audio/music.ts";
import { setAppLogins } from "../util/dawn-app.ts";
import { SCENARIOS, connectFrames } from "../../tests/fake-dawn/scenarios.ts";

/* The dedicated music socket, driven the way the app drives it: the main socket's session and
   config frames open it, DAWN's replies on it attach it, its audio frames feed the decoder, and a
   drop retries until it gives up. It is the only music transport, so each of these is audio or
   silence; the smoke scenarios run with music off, so this is its only automated check. */

class FakeSocket {
   static all: FakeSocket[] = [];
   static readonly CONNECTING = 0;
   static readonly OPEN = 1;
   readyState = 0;
   binaryType = "";
   readonly sent: Array<Record<string, unknown>> = [];
   onopen: (() => void) | null = null;
   onmessage: ((ev: { data: unknown }) => void) | null = null;
   onclose: ((ev: unknown) => void) | null = null;
   onerror: (() => void) | null = null;
   constructor(
      readonly url: string,
      readonly protocol: string
   ) {
      FakeSocket.all.push(this);
   }
   send(t: string): void {
      this.sent.push(JSON.parse(t) as Record<string, unknown>);
   }
   close(): void {}
   open(): void {
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
   }
   frame(f: object): void {
      this.onmessage?.({ data: JSON.stringify(f) });
   }
   /* DAWN dropped it. */
   drop(): void {
      this.readyState = 3;
      this.onclose?.({ code: 1006 });
   }
}

const musicSockets = (): FakeSocket[] => FakeSocket.all.filter((s) => s.protocol === "dawn-music");

let ing: Record<string, any> | null = null;
let errors: string[] = [];
let pushed: Uint8Array[] = [];
beforeEach(() => {
   localStorage.clear();
   setAppLogins(false);
   FakeSocket.all = [];
   errors = [];
   pushed = [];
   vi.useFakeTimers();
   vi.stubGlobal("WebSocket", FakeSocket);
   vi.stubGlobal("__APP_VERSION__", "0.0.0-test"); // defined by Vite at build time
   vi.spyOn(console, "debug").mockImplementation(() => {});
   vi.spyOn(console, "warn").mockImplementation(() => {});
   vi.spyOn(MusicAudio.prototype, "pushFrame").mockImplementation((b: Uint8Array) => {
      pushed.push(b);
      return Promise.resolve();
   });
});
afterEach(() => {
   ing?.dispose();
   ing = null;
   vi.useRealTimers();
   vi.restoreAllMocks();
   vi.unstubAllGlobals();
});

/* Sinks that do nothing, except the music player's error line, which is recorded. */
const sinks = new Proxy(
   {},
   {
      get: (_t, sink) =>
         new Proxy(
            {},
            {
               get:
                  (_u, method) =>
                  (...args: unknown[]) => {
                     if (sink === "music" && method === "setError") errors.push(String(args[0]));
                     return undefined;
                  }
            }
         )
   }
);

/* Connect to a DAWN whose config frame says music is on (or off). */
function connect(musicEnabled: boolean): FakeSocket {
   ing = new DawnIngest();
   ing.start(sinks);
   ing.wantConnected = true;
   ing.openSocket();
   const main = FakeSocket.all[0];
   main.open();
   for (const f of connectFrames(SCENARIOS.signedIn) as Array<{
      type: string;
      payload?: Record<string, unknown>;
   }>) {
      main.frame(
         f.type === "config" ? { ...f, payload: { ...f.payload, music_enabled: musicEnabled } } : f
      );
   }
   return main;
}

it("a DAWN with music: opens the music socket and authenticates it with the session token", () => {
   connect(true);
   const [music] = musicSockets();
   expect(music.url).toContain("/music-ws");
   music.open();
   expect(music.sent).toEqual([
      { type: "auth", token: localStorage.getItem("dawn.hero.sessionToken") }
   ]);
});

it("music audio reaches the decoder without the frame's opcode byte", () => {
   connect(true);
   const [music] = musicSockets();
   music.open();
   music.frame({ type: "auth_ok" });
   /* [0x20 opcode][uint16-LE length 3][3 bytes of opus] */
   music.onmessage!({ data: new Uint8Array([0x20, 3, 0, 9, 8, 7]).buffer });
   expect(pushed.map((b) => [...b])).toEqual([[3, 0, 9, 8, 7]]);
});

it("a dropped music socket retries, then says once that music is unavailable", () => {
   connect(true);
   /* Five reconnects, each dropped before it attaches: 1, 2, 4, 8 then 15 s apart. */
   for (const wait of [1000, 2000, 4000, 8000, 15000]) {
      const n = musicSockets().length;
      musicSockets().at(-1)!.drop();
      vi.advanceTimersByTime(wait - 1);
      expect(musicSockets()).toHaveLength(n); // not yet: it waits
      vi.advanceTimersByTime(1);
      expect(musicSockets()).toHaveLength(n + 1);
   }
   expect(musicSockets()).toHaveLength(6);
   expect(errors).toEqual([]);
   musicSockets().at(-1)!.drop();
   vi.advanceTimersByTime(60_000);
   expect(musicSockets()).toHaveLength(6); // gave up: no seventh
   expect(errors).toEqual(["Music stream unavailable"]);
});

it("a DAWN without music opens no music socket", () => {
   connect(false);
   expect(musicSockets()).toEqual([]);
});
