/*
 * Tool turns saved as text notes. Older voice conversations were saved without their tool
 * calls' structure; DAWN's v92/v93 migrations rewrote those turns as plain assistant text:
 *   - an assistant message ending in "[Tool Call: <name>]" notes (one per call, separated by a
 *     blank line, optionally after some prose), or "[Tool Call: its name and arguments weren't
 *     saved]" when the call itself was never saved;
 *   - then one or more assistant messages holding "[Tool Result: <text>]" notes (several
 *     results may share one message, joined exactly as "]\n\n[Tool Result: "). v93 writes an
 *     empty result as "(no text)"; v92 omits empty results, so the counts can mismatch.
 * This turns them back into the same tool pills as a structured turn, mirroring DAWN's WebUI
 * (www/js/ui/tool-notes.js). Nothing is invented: no call id, and no name or arguments beyond
 * what the notes say. Reload-only; all strings stay untrusted (the view binds via textContent).
 */

import type { ToolCall } from "./ingest.ts";

const CALL = "[Tool Call: ";
const RESULT = "[Tool Result: ";
const UNSAVED = "its name and arguments weren't saved";
const SEP = "\n\n";

/* The subset of a load_conversation row this reads. */
export interface NoteRow {
   role: string;
   content: string;
   tool_calls?: unknown;
}

/* An assistant text row: no structured tool_calls (a structured turn is never a note). */
function isAssistantText(m: NoteRow | undefined): m is NoteRow {
   return (
      !!m &&
      m.role === "assistant" &&
      typeof m.content === "string" &&
      !(Array.isArray(m.tool_calls) && m.tool_calls.length > 0)
   );
}

/* The prose before a message's call notes and the notes' names, or null when the message
   doesn't END in call notes. */
function parseCalls(text: string): { prose: string; names: string[] } | null {
   const start = text.startsWith(CALL) ? 0 : text.indexOf(SEP + CALL);
   if (start < 0) return null;
   const prose = start === 0 ? "" : text.slice(0, start);
   const rest = start === 0 ? text : text.slice(start + SEP.length);
   const names: string[] = [];
   for (const part of rest.split(SEP)) {
      if (!part.startsWith(CALL) || !part.endsWith("]")) return null;
      names.push(part.slice(CALL.length, -1));
   }
   return { prose, names };
}

/* The results a result-note message holds, in order, or null when it isn't one. A result's own
   text may contain anything, so split only on the exact seam DAWN joins them with. */
function parseResults(text: string): string[] | null {
   if (!text.startsWith(RESULT) || !text.endsWith("]")) return null;
   return text.slice(RESULT.length, -1).split("]" + SEP + RESULT);
}

/* If rows[i] is a tool-call note: its prose, the pills (calls paired in order with the results
   from the following result-note rows; extra results get an unnamed call, extra calls an empty
   result), and how many following rows were consumed. null otherwise. `idBase` keeps the pill
   ids unique and stable across reloads (e.g. the message's DB id). */
export function collectToolNotes(
   rows: NoteRow[],
   i: number,
   idBase: string
): { prose: string; tools: ToolCall[]; consumed: number } | null {
   const msg = rows[i];
   if (!isAssistantText(msg)) return null;
   const calls = parseCalls(msg.content);
   if (!calls) return null;
   const results: string[] = [];
   let consumed = 0;
   for (let j = i + 1; j < rows.length; j++) {
      const next = rows[j];
      const parsed = isAssistantText(next) ? parseResults(next.content) : null;
      if (!parsed) break;
      results.push(...parsed);
      consumed++;
   }
   const tools: ToolCall[] = [];
   const n = Math.max(calls.names.length, results.length);
   for (let k = 0; k < n; k++) {
      const name = calls.names[k];
      const known = !!name && name !== UNSAVED;
      tools.push({
         id: `note-${idBase}-${k}`,
         name: known ? name : "tool",
         args: known ? undefined : "Tool details weren’t saved with this conversation",
         result: k < results.length ? results[k] : ""
      });
   }
   return { prose: calls.prose, tools, consumed };
}
