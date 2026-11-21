// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { DawnIngest } from "./dawn-ws.ts";

/* The album browse page carries DAWN's album key (DAWN #138), which the library sends back to
   open or add the album; an older DAWN sends none. */

const clients: Array<Record<string, any>> = [];
afterEach(() => {
   for (const ing of clients.splice(0)) ing.dispose();
});

it("reads each album's key from the browse page, when DAWN sends one", () => {
   const pages: unknown[] = [];
   const sink = new Proxy({}, { get: () => () => undefined });
   const sinks = new Proxy(
      {},
      {
         get: (_t, name) =>
            name === "music"
               ? new Proxy(
                    {},
                    {
                       get: (_u, m) =>
                          m === "setLibrary" ? (p: unknown) => pages.push(p) : () => {}
                    }
                 )
               : sink
      }
   );
   const ing = new DawnIngest() as unknown as Record<string, any>;
   clients.push(ing);
   ing.emit = () => {};
   ing.start(sinks);
   ing.onFrame(
      JSON.stringify({
         type: "music_library_response",
         payload: {
            browse_type: "albums",
            albums: [
               { key: "41", name: "Greatest Hits", artist: "Queen", track_count: 17 },
               { name: "Old", artist: "", track_count: 3 }
            ],
            offset: 0,
            total_count: 2
         }
      })
   );
   expect(pages.at(-1)).toMatchObject({
      kind: "albums",
      albums: [
         { name: "Greatest Hits", artist: "Queen", tracks: 17, key: "41" },
         { name: "Old", artist: "", tracks: 3 }
      ]
   });
   expect((pages.at(-1) as { albums: object[] }).albums[1]).not.toHaveProperty("key");
});
