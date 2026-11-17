/*
 * How a memory batch reads, in words: its summary ("3 learned, 1 updated") and what outside
 * text it read. Shared by the Memory panel and the conversation's memory marks. No DOM.
 */

import type { MemoryBatch } from "../ingest/ingest.ts";

/* What outside text a batch (or a change from another batch) read. */
const OUTSIDE_CAUSES: Record<string, string> = {
   web: "a web page",
   email: "an email",
   research: "a research report",
   messaging: "a message",
   document: "a document",
   calendar: "a calendar event",
   mcp: "another tool's result",
   other: "another tool's result"
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/* "3 learned, 2 confirmed, 1 updated" from a batch's counts. */
export function batchSummary(batch: MemoryBatch): string {
   const c = batch.counts;
   const n = (k: string): number => c[k] ?? 0;
   const parts: string[] = [];
   const add = (count: number, one: string, many: string): void => {
      if (count > 0) parts.push(plural(count, one, many));
   };
   add(n("added"), "learned", "learned");
   add(n("reinforced"), "confirmed", "confirmed");
   add(n("merged") + n("replaced") + n("closed"), "updated", "updated");
   add(n("linked") + n("proposed"), "link", "links");
   add(n("pref_set"), "preference", "preferences");
   add(n("dropped") + n("deferred"), "not kept", "not kept");
   add(n("suggested_forget"), "to review", "to review");
   return parts.length > 0 ? parts.join(", ") : "Nothing new";
}

/* "Read outside text: an email" for a batch or change that read outside text, else "". */
export function outsideText(item: { outside: boolean; outsideFrom: string | null }): string {
   if (!item.outside) return "";
   const cause = item.outsideFrom ? OUTSIDE_CAUSES[item.outsideFrom] : undefined;
   return `Read outside text${cause ? `: ${cause}` : ""}`;
}
