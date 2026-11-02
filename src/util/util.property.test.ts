// @vitest-environment jsdom
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { str } from "../ingest/wire.ts";
import { isoDate, todayWindow } from "./time.ts";
import { setAppLogins, tagDawnUrl, tagIfDawnApi } from "./dawn-app.ts";
import { isSafeImageDataUri, parseAttachments } from "../conversation/attachments.ts";

afterEach(() => setAppLogins(false));

/* The heavier properties (each run parses a document in jsdom) get a sized run count; every
   property test has a fuzz-sized timeout from vitest.config.ts (the "property" project). */
describe("str: a DAWN frame field read as text (property)", () => {
   it("always gives a string, never an object's [object Object]", () => {
      fc.assert(
         fc.property(fc.anything(), fc.string(), (v, fallback) => {
            const out = str(v, fallback);
            expect(typeof out).toBe("string");
            if (typeof v === "string") expect(out).toBe(v);
            if (v !== null && typeof v === "object") expect(out).toBe(fallback);
         })
      );
   });
});

/* Zones with clock changes at midnight, half-hour offsets, a day that didn't exist (Apia), a
   repeated midnight (Vostok, Gaza) and days far from 24 hours long (Vostok), over 1990-2036. */
const ZONES = [
   "UTC",
   "America/New_York",
   "America/Santiago",
   "America/Havana",
   "America/St_Johns",
   "Europe/London",
   "Asia/Kolkata",
   "Asia/Kathmandu",
   "Asia/Gaza",
   "Australia/Lord_Howe",
   "Pacific/Apia",
   "Antarctica/Vostok"
];
describe("todayWindow (property)", () => {
   it("contains the instant and spans exactly one calendar day of the zone", () => {
      fc.assert(
         fc.property(
            fc.constantFrom(...ZONES),
            fc.integer({ min: Date.UTC(1990, 0, 1), max: Date.UTC(2036, 11, 31) }),
            (zone, ms) => {
               const { start, end } = todayWindow(zone, ms);
               const t = Math.floor(ms / 1000);
               expect(start).toBeLessThanOrEqual(t);
               expect(t).toBeLessThan(end);
               expect(isoDate(start, zone)).toBe(isoDate(t, zone));
               expect(isoDate(start - 1, zone)).not.toBe(isoDate(t, zone));
               expect(isoDate(end - 1, zone)).toBe(isoDate(t, zone));
               expect(isoDate(end, zone)).not.toBe(isoDate(t, zone));
               /* No fixed length: a zone's day can run far from 24 h (Vostok had a 31-hour and a
               17-hour day in 1994); the calendar boundaries above are the invariant. */
            }
         ),
         { numRuns: 600 }
      );
   });
});

describe("todayWindow on days far from 24 hours", () => {
   it("covers Vostok's 31-hour and 17-hour days of 1994", () => {
      for (const [ms, date] of [
         [Date.UTC(1994, 0, 31, 12), "1994-01-31"],
         [Date.UTC(1994, 10, 1, 12), "1994-11-01"]
      ] as const) {
         const { start, end } = todayWindow("Antarctica/Vostok", ms);
         expect(isoDate(start, "Antarctica/Vostok")).toBe(date);
         expect(isoDate(end - 1, "Antarctica/Vostok")).toBe(date);
         expect(isoDate(end, "Antarctica/Vostok")).not.toBe(date);
      }
   });
});

describe("DAWN URL tagging (property)", () => {
   const segment = fc.constantFrom(
      "api",
      "images",
      "x",
      "a b",
      "%2F",
      "..",
      "?",
      "&",
      "#",
      "=",
      "app"
   );
   const path = fc.array(segment, { maxLength: 5 }).map((p) => "/" + p.join("/"));
   /* tagDawnUrl appends to a bare DAWN path (every caller hands it one, once); tagIfDawnApi is
      the one that meets URLs which may already carry the tag. */
   it("tagDawnUrl gives an untagged path exactly one app=aurora, keeps the fragment last, and is a no-op with per-app logins off", () => {
      fc.assert(
         fc.property(path, fc.boolean(), (url, on) => {
            setAppLogins(on);
            const out = tagDawnUrl(url);
            if (!on) {
               expect(out).toBe(url);
               return;
            }
            const hash = url.indexOf("#");
            if (hash >= 0) expect(out.endsWith(url.slice(hash))).toBe(true);
            expect(out.split("app=aurora").length - 1).toBe(1);
         })
      );
   });
   /* Generating web URLs is costly (~2 s for this property alone on the Jetson). */
   it("tagIfDawnApi tags this origin's /api/ URLs exactly once, and leaves everything else untouched", () => {
      const origin = () => window.location.origin;
      fc.assert(
         fc.property(
            fc.oneof(
               fc.webUrl(),
               path,
               path.map((p) => origin() + "/api" + p),
               fc.constantFrom("/api/../x", "/api%2F..", "/api/x?app=aurora", origin() + "/api/x#f")
            ),
            (url) => {
               setAppLogins(true);
               const out = tagIfDawnApi(url);
               const u = new URL(url, window.location.href);
               if (u.origin !== window.location.origin || !u.pathname.startsWith("/api/")) {
                  expect(out).toBe(url);
                  return;
               }
               const tagged = new URL(out, window.location.href);
               expect(tagged.searchParams.getAll("app")).toEqual(
                  u.searchParams.has("app") ? u.searchParams.getAll("app") : ["aurora"]
               );
               expect(tagIfDawnApi(out)).toBe(out); // idempotent
            }
         )
      );
   });
});

/* Attachment markers as they appear in a message, valid and hostile. */
const marker = fc.oneof(
   fc.stringMatching(/^[a-zA-Z0-9]{12}$/).map((id) => `[IMAGE:img_${id}]`),
   fc.constantFrom(
      "[IMAGE:img_short]",
      "[IMAGE:img_aaaaaaaaaaaaa]",
      "[IMAGE:data:image/png;base64,iVBORw0KGgo=]",
      "[IMAGE:data:image/svg+xml;base64,PHN2Zz4=]",
      "[IMAGE:data:image/png,not-base64]",
      "[IMAGE:data:text/html;base64,PHNjcmlwdD4=]",
      "[IMAGE:javascript:alert(1)]",
      "[IMAGE:https://evil.example/x.png]"
   )
);
const docMarker = fc.constantFrom(
   "[ATTACHED DOCUMENT: notes.txt (12 bytes) blob:blb_aaaaaaaaaaaa]\nhello\n[END DOCUMENT]\n",
   "[ATTACHED DOCUMENT: x.md (3 bytes) blob:javascript:alert(1)]\nx\n[END DOCUMENT]\n",
   "[ATTACHED DOCUMENT: y.md (3 bytes) blob:blb_../../api/x]\ny\n[END DOCUMENT]\n",
   "[ATTACHED DOCUMENT: z.txt (5 bytes)]\nzzzzz\n[END DOCUMENT]\n"
);
describe("attachments (property)", () => {
   it("parseAttachments keeps only well-formed image refs (an id, or a raster base64 data URI) and blob ids", () => {
      fc.assert(
         fc.property(
            fc.array(docMarker, { maxLength: 2 }),
            fc.string({ maxLength: 40 }),
            fc.array(marker, { maxLength: 4 }),
            fc.constantFrom("user", "assistant" as const),
            (docs, text, imgs, role) => {
               const raw = docs.join("") + text + imgs.map((m) => "\n" + m).join("");
               const out = parseAttachments(raw, role);
               expect(typeof out.text).toBe("string");
               for (const img of out.images) {
                  expect(
                     /^img_[a-zA-Z0-9]{12}$/.test(img.ref) ||
                        (isSafeImageDataUri(img.ref) &&
                           /;base64,[A-Za-z0-9+/]+={0,2}$/.test(img.ref))
                  ).toBe(true);
                  expect(img.isDataUri).toBe(img.ref.startsWith("data:"));
               }
               for (const d of out.docs)
                  if (d.blobId !== undefined) expect(d.blobId).toMatch(/^blb_[a-zA-Z0-9]{12}$/);
               if (role === "assistant") expect(out.docs).toEqual([]);
            }
         ),
         { numRuns: 300 }
      );
   });
   it("isSafeImageDataUri never admits SVG or a non-image", () => {
      fc.assert(
         fc.property(fc.string(), (s) => {
            const uri = `data:${s}`;
            if (isSafeImageDataUri(uri))
               expect(/^data:image\/(jpeg|jpg|png|gif|webp);/i.test(uri)).toBe(true);
            expect(isSafeImageDataUri(`data:image/svg+xml;${s}`)).toBe(false);
         })
      );
   });
});
