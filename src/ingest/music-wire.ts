/* DAWN's music frames -> the music player's types (track rows, library pages, state). */

import type { MusicLibraryPage, MusicState, MusicTrack } from "./ingest.ts";
import { str } from "./wire.ts";

/* One track row from a queue / search / library payload. */
export function toMusicTrack(t: Record<string, unknown>): MusicTrack {
   return {
      path: str(t.path),
      title: str(t.title) || str(t.display_name),
      artist: str(t.artist),
      album: str(t.album),
      durationSec: Number(t.duration_sec ?? 0) || 0
   };
}

/* A music_library_response payload -> one browse page (null for an unknown browse type). */
export function toLibraryPage(p: Record<string, unknown>): MusicLibraryPage | null {
   const arr = (k: string): Array<Record<string, unknown>> =>
      Array.isArray(p[k]) ? (p[k] as Array<Record<string, unknown>>) : [];
   const num = (k: string): number => Number(p[k] ?? 0) || 0;
   switch (p.browse_type) {
      case "stats":
         return {
            kind: "stats",
            tracks: num("track_count"),
            artists: num("artist_count"),
            albums: num("album_count")
         };
      case "tracks":
         return {
            kind: "tracks",
            tracks: arr("tracks").map(toMusicTrack),
            offset: num("offset"),
            total: num("total_count")
         };
      case "artists":
         return {
            kind: "artists",
            artists: arr("artists").map((a) => ({
               name: str(a.name),
               albums: Number(a.album_count ?? 0) || 0,
               tracks: Number(a.track_count ?? 0) || 0
            })),
            offset: num("offset"),
            total: num("total_count")
         };
      case "albums":
         return {
            kind: "albums",
            albums: arr("albums").map((a) => ({
               name: str(a.name),
               artist: str(a.artist),
               tracks: Number(a.track_count ?? 0) || 0,
               ...(typeof a.key === "string" && a.key ? { key: a.key } : {})
            })),
            offset: num("offset"),
            total: num("total_count")
         };
      case "tracks_by_artist":
         return { kind: "artist", name: str(p.artist), tracks: arr("tracks").map(toMusicTrack) };
      case "tracks_by_album":
         return { kind: "album", name: str(p.album), tracks: arr("tracks").map(toMusicTrack) };
      default:
         return null;
   }
}

/* A music_state payload -> our MusicState. `track` is null when the queue is
   empty; `repeat_mode` is an int enum (0/1/2); `volume` is a server-stored hint. */
export function toMusicState(p: Record<string, unknown>): MusicState {
   const t = p.track as Record<string, unknown> | null | undefined;
   let track: MusicTrack | null = null;
   if (t && typeof t === "object") {
      track = {
         path: str(t.path),
         title: str(t.title),
         artist: str(t.artist),
         album: str(t.album),
         durationSec: Number(t.duration_sec ?? 0)
      };
   }
   return {
      playing: p.playing === true,
      paused: p.paused === true,
      track,
      positionSec: Number(p.position_sec ?? 0),
      durationSec: track?.durationSec ?? 0,
      queueLength: Number(p.queue_length ?? 0),
      queueRev: Number(p.queue_rev ?? 0),
      queueIndex: Number(p.queue_index ?? 0),
      shuffle: p.shuffle === true,
      repeatMode: Number(p.repeat_mode ?? 0),
      volume: Number(p.volume ?? 1),
      quality: str(p.quality),
      bitrate: Number(p.bitrate ?? 0),
      sourceFormat: str(p.source_format),
      sourceRate: Number(p.source_rate ?? 0),
      loading: p.loading === true
   };
}
