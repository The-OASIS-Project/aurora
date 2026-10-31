/*
 * The Mail panel's settings that follow the person (docs/EMAIL_PANEL_DESIGN.md 3.9), defined here
 * so the settings store (src/ingest/prefs.ts) never learns what they mean. Each parse treats its
 * input as untrusted: another browser, client or version may have written it.
 */

import { definePref } from "../ingest/prefs.ts";

export type MarkRead = "immediately" | "delayed" | "manual";
export type AfterMove = "list" | "next" | "previous";

/* Mark as read after this long on screen ("After 3 seconds"). */
export const MARK_READ_DELAY_MS = 3000;

const oneOf =
   <T extends string>(values: readonly T[]) =>
   (raw: unknown): T | undefined =>
      typeof raw === "string" && (values as readonly string[]).includes(raw)
         ? (raw as T)
         : undefined;
const bool = (raw: unknown): boolean | undefined => (typeof raw === "boolean" ? raw : undefined);

/* The trusted list's JSON must fit DAWN's per-value cap (9.14): capped by bytes, not count. */
export const TRUSTED_MAX_BYTES = 15 * 1024;

/* A sender address as a trust key: NFC, the domain as a lowercase IDN A-label (punycode), the local
   part lowercased. Never strips +tags or dots (that would trust other mailboxes). null unless it is
   ONE well-formed address that no other raw form maps onto: nothing invisible or bidi anywhere, a
   domain of letters, digits, dots and hyphens only (no path, query, percent or IP), and nothing the
   URL parser would quietly rewrite (an ASCII domain must come back unchanged; a non-ASCII label must
   stay an xn-- label, so full-width "ｂａｎｋ" can't become "bank"). */
export function normalizeAddress(raw: string): string | null {
   const s = raw.normalize("NFC").trim();
   if (/[\p{Cc}\p{Cf}\p{Z}]/u.test(s)) return null; // controls, bidi, zero-width, soft hyphen, spaces
   const at = s.lastIndexOf("@");
   if (at <= 0 || at === s.length - 1 || s.indexOf("@") !== at) return null;
   const local = s.slice(0, at);
   const rawDomain = s.slice(at + 1);
   if (/[<>()[\]\\,;:"]/.test(local)) return null;
   if (!/^[\p{L}\p{M}\p{N}.-]+$/u.test(rawDomain)) return null;
   const rawLabels = rawDomain.split(".");
   if (rawLabels.length < 2 || rawLabels.some((l) => !l)) return null; // no empty label, no trailing dot
   let domain: string;
   try {
      domain = new URL(`http://${rawDomain}`).hostname;
   } catch {
      return null;
   }
   const labels = domain.split(".");
   if (labels.length !== rawLabels.length) return null;
   for (let i = 0; i < labels.length; i++) {
      const r = rawLabels[i];
      const ascii = /^[\x21-\x7e]+$/.test(r);
      if (ascii ? labels[i] !== r.toLowerCase() : !labels[i].startsWith("xn--")) return null;
   }
   if (/^\d+$/.test(labels[labels.length - 1])) return null; // an IP address, not a mail domain
   const out = `${local.toLowerCase()}@${domain}`;
   return new TextEncoder().encode(out).length <= 254 ? out : null;
}

/* Normalize, de-duplicate, keep order, and stop before the JSON would exceed the byte cap. */
export function cleanTrusted(list: readonly unknown[]): string[] {
   const out: string[] = [];
   const seen = new Set<string>();
   let bytes = 2; // []
   const enc = new TextEncoder();
   for (const item of list) {
      if (typeof item !== "string") continue;
      const a = normalizeAddress(item);
      if (!a || seen.has(a)) continue;
      const cost = enc.encode(JSON.stringify(a)).length + (out.length ? 1 : 0);
      if (bytes + cost > TRUSTED_MAX_BYTES) break;
      bytes += cost;
      seen.add(a);
      out.push(a);
   }
   return out;
}

export const TRUSTED_SENDERS = definePref<string[]>({
   key: "mail.trusted_senders",
   default: [],
   parse: (raw) => (Array.isArray(raw) ? cleanTrusted(raw) : undefined)
});
export const ALWAYS_IMAGES = definePref<boolean>({
   key: "mail.always_images",
   default: false,
   parse: bool
});
export const MARK_READ = definePref<MarkRead>({
   key: "mail.mark_read",
   default: "immediately",
   parse: oneOf(["immediately", "delayed", "manual"] as const)
});
export const AFTER_MOVE = definePref<AfterMove>({
   key: "mail.after_move",
   default: "list",
   parse: oneOf(["list", "next", "previous"] as const)
});
export const PREVIEWS = definePref<boolean>({ key: "mail.previews", default: true, parse: bool });
export const SENDER_ONLY = definePref<boolean>({
   key: "mail.sender_only",
   default: false,
   parse: bool
});

/* Keys that loosen privacy: never uploaded from a browser to DAWN on first sync (8.7), and held to
   their strict default until this connection's settings have loaded (3.9). */
export const PRIVACY_KEYS = [TRUSTED_SENDERS.key, ALWAYS_IMAGES.key] as const;
