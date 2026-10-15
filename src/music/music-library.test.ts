// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountMusicLibrary } from "./music-library.ts";
import type { MusicState, MusicTrack } from "../ingest/ingest.ts";

const track = (n: number): MusicTrack => ({ path: `/m/${n}.flac`, title: `Song ${n}`, artist: `Artist ${n}`, album: "Album", durationSec: 200 + n });

function setup(open = true) {
   if (open) localStorage.setItem("dawn.hero.musicLibOpen", "1");
   const calls = { control: [] as Array<[string, Record<string, unknown> | undefined]>, queue: 0, search: [] as string[], library: [] as Array<[string, Record<string, unknown> | undefined]> };
   const view = mountMusicLibrary({
      control: (a, p) => calls.control.push([a, p]),
      queueList: () => calls.queue++,
      search: (q) => calls.search.push(q),
      library: (t, p) => calls.library.push([t, p])
   });
   document.body.appendChild(view.el);
   const q = <T extends Element>(sel: string): T => view.el.querySelector<T>(sel)!;
   const rows = (): HTMLElement[] => Array.from(view.el.querySelectorAll<HTMLElement>(".music-lib-row"));
   return { view, calls, q, rows };
}

beforeEach(() => {
   Element.prototype.scrollIntoView ??= function () {}; // jsdom has no layout
   vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
   vi.useRealTimers();
   localStorage.clear();
   document.body.replaceChildren();
});

describe("music queue", () => {
   it("asks for the queue when opened, and lists it with the current track marked", () => {
      const t = setup();
      expect(t.calls.queue).toBe(1);
      t.view.setQueue({ tracks: [track(1), track(2), track(3)], currentIndex: 1 });
      expect(t.rows().length).toBe(3);
      expect(t.rows()[1].getAttribute("aria-current")).toBe("true");
      expect(t.rows()[0].querySelector(".music-lib-title")?.textContent).toBe("Song 1");
   });

   it("plays a row on a click, and removes one with minus (then re-reads the queue)", () => {
      const t = setup();
      t.view.setQueue({ tracks: [track(1), track(2)], currentIndex: 0 });
      t.rows()[1].querySelector<HTMLButtonElement>(".music-lib-main")!.click();
      expect(t.calls.control.pop()).toEqual(["play_index", { index: 1 }]);
      t.rows()[0].querySelector<HTMLButtonElement>(".music-lib-act")!.click();
      expect(t.calls.control.pop()).toEqual(["remove_from_queue", { index: 0 }]);
      expect(t.calls.queue).toBe(2);
      /* Applied at once: the next click in the list already uses the new indices. */
      expect(t.rows().length).toBe(1);
      t.rows()[0].querySelector<HTMLButtonElement>(".music-lib-act")!.click();
      expect(t.calls.control.pop()).toEqual(["remove_from_queue", { index: 0 }]);
   });

   it("re-asks for the library once DAWN is talking, if the first ask was too early", () => {
      localStorage.setItem("dawn.hero.musicLibTab", "library");
      const t = setup();
      expect(t.calls.library).toEqual([["stats", undefined]]); // sent before the link was up
      t.view.setState({ queueLength: 0, queueIndex: 0, track: null } as unknown as MusicState);
      expect(t.calls.library).toEqual([["stats", undefined], ["stats", undefined]]);
      t.view.setLibrary({ kind: "stats", tracks: 1, artists: 1, albums: 1 });
      t.view.setState({ queueLength: 1, queueIndex: 0, track: track(1) } as unknown as MusicState);
      expect(t.calls.library.length).toBe(2); // has a page now: no more asks
   });

   it("filters, and clears the queue", () => {
      const t = setup();
      t.view.setQueue({ tracks: [track(1), track(2), track(12)], currentIndex: 0 });
      const filter = t.q<HTMLInputElement>(".music-lib-tools input");
      filter.value = "song 1";
      filter.dispatchEvent(new Event("input"));
      expect(t.rows().map((r) => r.querySelector(".music-lib-title")?.textContent)).toEqual(["Song 1", "Song 12"]);
      t.q<HTMLButtonElement>(".music-lib-text-btn").click();
      expect(t.calls.control.pop()).toEqual(["clear_queue", undefined]);
   });

   it("re-reads the queue when it moves while open (coalesced)", () => {
      const t = setup();
      const state = (len: number) => ({ queueLength: len, queueIndex: 0, track: track(1) }) as unknown as MusicState;
      t.view.setState(state(3));
      t.view.setState(state(4));
      t.view.setState(state(5));
      vi.advanceTimersByTime(200);
      expect(t.calls.queue).toBe(2); // the opening read, then one for the burst
   });

   it("does nothing while closed", () => {
      const t = setup(false);
      expect(t.view.el.hidden).toBe(true);
      expect(t.calls.queue).toBe(0);
   });
});

describe("music library", () => {
   const openLibrary = (t: ReturnType<typeof setup>) => t.q<HTMLButtonElement>('[data-tab="library"]').click();

   it("opens on the library stats and browses into a page with More", () => {
      const t = setup();
      openLibrary(t);
      expect(t.calls.library.pop()).toEqual(["stats", undefined]);
      t.view.setLibrary({ kind: "stats", tracks: 120, artists: 9, albums: 14 });
      view_stat(t, 0).click();
      expect(t.calls.library.pop()).toEqual(["tracks", { offset: 0, limit: 50 }]);
      t.view.setLibrary({ kind: "tracks", tracks: [track(1), track(2)], offset: 0, total: 3 });
      expect(t.rows().length).toBe(2);
      const more = t.q<HTMLButtonElement>(".music-lib-more");
      expect(more.hidden).toBe(false);
      more.click();
      more.click(); // a double click asks once
      expect(t.calls.library.pop()).toEqual(["tracks", { offset: 2, limit: 50 }]);
      expect(t.calls.library.length).toBe(0); // the second click sent nothing
      t.view.setLibrary({ kind: "tracks", tracks: [track(3)], offset: 2, total: 3 });
      t.view.setLibrary({ kind: "tracks", tracks: [track(3)], offset: 2, total: 3 }); // a duplicate page is ignored
      expect(t.rows().length).toBe(3);
      expect(more.hidden).toBe(true);
   });

   it("plays a track on a click and adds one with plus", () => {
      const t = setup();
      openLibrary(t);
      t.view.setLibrary({ kind: "tracks", tracks: [track(7)], offset: 0, total: 1 });
      t.rows()[0].querySelector<HTMLButtonElement>(".music-lib-main")!.click();
      expect(t.calls.control.pop()).toEqual(["play", { path: "/m/7.flac", title: "Song 7", artist: "Artist 7", album: "Album", duration_sec: 207 }]);
      t.rows()[0].querySelector<HTMLButtonElement>(".music-lib-act")!.click();
      expect(t.calls.control.pop()?.[0]).toBe("add_to_queue");
   });

   it("opens an artist, or adds all of it", () => {
      const t = setup();
      openLibrary(t);
      t.view.setLibrary({ kind: "artists", artists: [{ name: "Nightwish", albums: 3, tracks: 30 }], offset: 0, total: 1 });
      t.rows()[0].querySelector<HTMLButtonElement>(".music-lib-act")!.click();
      expect(t.calls.control.pop()).toEqual(["add_artist", { artist: "Nightwish" }]);
      t.rows()[0].querySelector<HTMLButtonElement>(".music-lib-main")!.click();
      expect(t.calls.library.pop()).toEqual(["tracks_by_artist", { artist: "Nightwish" }]);
   });

   it("searches on Enter and shows the results", () => {
      const t = setup();
      openLibrary(t);
      const box = t.view.el.querySelectorAll<HTMLInputElement>(".music-lib-input")[1];
      box.value = "source:plex nightwish";
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      expect(t.calls.search).toEqual(["source:plex nightwish"]);
      t.view.setSearchResults("source:plex nightwish", [track(4)]);
      expect(t.rows().length).toBe(1);
   });

   it("binds DAWN's text as text, never markup", () => {
      const t = setup();
      t.view.setQueue({ tracks: [{ ...track(1), title: "<img src=x onerror=alert(1)>" }], currentIndex: 0 });
      expect(t.view.el.querySelector("img")).toBeNull();
      expect(t.rows()[0].querySelector(".music-lib-title")?.textContent).toBe("<img src=x onerror=alert(1)>");
   });
});

function view_stat(t: ReturnType<typeof setup>, i: number): HTMLButtonElement {
   return t.view.el.querySelectorAll<HTMLButtonElement>(".music-lib-stat")[i];
}

describe("music library paging by scrolling", () => {
   it("loads the next page when the end of the list comes into view", async () => {
      let fire: (on: boolean) => void = () => {};
      class FakeIO {
         constructor(cb: (e: Array<{ isIntersecting: boolean }>) => void) {
            fire = (on) => cb([{ isIntersecting: on }]);
         }
         observe(): void {}
         unobserve(): void {}
         disconnect(): void {}
      }
      const real = globalThis.IntersectionObserver;
      (globalThis as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;
      try {
         const t = setup();
         t.q<HTMLButtonElement>('[data-tab="library"]').click();
         t.view.setLibrary({ kind: "tracks", tracks: [track(1), track(2)], offset: 0, total: 4 });
         t.calls.library.length = 0;
         fire(true);
         expect(t.calls.library).toEqual([["tracks", { offset: 2, limit: 50 }]]);
         expect(t.q<HTMLButtonElement>(".music-lib-more").textContent).toBe("Loading more…");
         fire(true); // still in view while it loads: no second ask
         expect(t.calls.library.length).toBe(1);
         t.view.setLibrary({ kind: "tracks", tracks: [track(3), track(4)], offset: 2, total: 4 });
         fire(true); // the end of the list: nothing more to ask for
         expect(t.calls.library.length).toBe(1);
         expect(t.rows().length).toBe(4);
      } finally {
         (globalThis as { IntersectionObserver: unknown }).IntersectionObserver = real;
      }
   });
});

