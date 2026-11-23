/* DAWN's saved conversation rows -> what the transcript draws: message text, tool calls and
   results, email refs, and a title from a first message. */

import type { ToolCall } from "./ingest.ts";
import type { EmailRef } from "./email.ts";

/* DAWN's cut for an email ref's display strings (160 bytes on a character boundary, control
   characters as spaces), done before sending so the bubble shows what a reload will. */
export function displayCut(s: string): string {
   let out = s.replace(/\p{Cc}/gu, " ");
   const enc = new TextEncoder();
   while (enc.encode(out).length > 160) out = Array.from(out).slice(0, -1).join("");
   return out;
}

/* A row's `email_ref` (P1.4) -> our EmailRef, or undefined. Its strings are display-only and
   attacker-influenced (a sender's own From and Subject): the view binds them as text. */
export function toEmailRef(v: unknown): EmailRef | undefined {
   if (!v || typeof v !== "object") return undefined;
   const o = v as Record<string, unknown>;
   const accountId =
      typeof o.account_id === "number" && Number.isInteger(o.account_id) && o.account_id > 0
         ? o.account_id
         : 0;
   const messageId = typeof o.message_id === "string" ? o.message_id : "";
   /* DAWN's id rule: 1-191 bytes, no control characters (it is sent back in email_read). */
   if (
      !accountId ||
      !messageId.trim() ||
      new TextEncoder().encode(messageId).length > 191 ||
      /\p{Cc}/u.test(messageId)
   )
      return undefined;
   return {
      accountId,
      messageId,
      sender: typeof o.from === "string" ? o.from : "",
      subject: typeof o.subject === "string" ? o.subject : ""
   };
}

/* A conversation title from its first message (mirrors the WebUI's generateTitleFromMessage):
   the first non-empty line, trimmed, capped at 50 chars with an ellipsis. Empty -> "" (which the
   HUD + DAWN both render as the "New conversation" placeholder). */
export function titleFromMessage(content: string): string {
   const firstLine = (content.split("\n")[0] ?? "").trim();
   if (!firstLine) return "";
   return firstLine.length <= 50 ? firstLine : `${firstLine.slice(0, 47)}...`;
}

/* DAWN's conversation history and transcripts carry raw Anthropic content blocks: a tool
   call is an assistant turn whose `content` is a `[{type:"tool_use",...}]` array (as a JSON
   string), and a tool result is a `user` turn holding `[{type:"tool_result",...}]`. Those
   are protocol plumbing, not prose (DAWN started persisting them for reload-faithful history,
   commit f0b0f23), so the reply surface must not print them verbatim. Interpret one message
   into what the console should show: its human text and/or the tool names it invoked (as
   chips). tool_result blocks are the data returning to the model - nothing to display. Mixed
   turns (a text block beside a tool_use) return both. Returns null when there is nothing to
   show (a pure tool_result, empty); a message that isn't a content-block array is plain text.
   NOTE: the CURRENT DAWN persists tools in a SEPARATE `tool_calls` column (parseToolCalls
   below), not inside content - this block-array path is a legacy fallback (name-only, no id). */
export function interpretMessage(raw: string): { text?: string; tools?: ToolCall[] } | null {
   const text = (raw ?? "").trim();
   if (!text) return null;
   /* Only structured content starts with [ or { ; a normal answer is plain text. */
   if (text[0] !== "[" && text[0] !== "{") return { text: raw };
   let parsed: unknown;
   try {
      parsed = JSON.parse(text);
   } catch {
      return { text: raw }; // not JSON, just text that happens to start with a bracket
   }
   const blocks = Array.isArray(parsed) ? parsed : [parsed];
   /* If the elements don't look like content blocks (e.g. the user literally typed a JSON
      array), it isn't tool plumbing - show it verbatim. */
   const looksLikeBlocks = blocks.every(
      (b) =>
         b !== null && typeof b === "object" && typeof (b as { type?: unknown }).type === "string"
   );
   if (!looksLikeBlocks) return { text: raw };
   const textParts: string[] = [];
   const tools: ToolCall[] = [];
   for (const b of blocks as Array<{
      type?: string;
      text?: unknown;
      name?: unknown;
      id?: unknown;
   }>) {
      if (b.type === "text" && typeof b.text === "string") textParts.push(b.text);
      else if (b.type === "tool_use") {
         tools.push({
            id: typeof b.id === "string" ? b.id : "",
            name: typeof b.name === "string" && b.name ? b.name : "tool"
         });
      }
   }
   const joined = textParts.join("").trim();
   if (!joined && !tools.length) return null; // pure tool_result / unknown blocks -> skip
   return { text: joined || undefined, tools: tools.length ? tools : undefined };
}

/* A reloaded tool result, keyed by tool_call_id: its text plus the persisted confirmed-failure
   verdict. NOTE the key-name split - reload carries `is_error` (the DB column), the LIVE tool_step
   frame carries `error`; same concept, two message types. */
export interface ReloadedToolResult {
   result: string;
   error: boolean;
}

/* Parse DAWN's persisted `tool_calls` column (an OpenAI-format JSON array:
   [{id, type:"function", function:{name, arguments}}]) into ordered ToolCall pills for reload.
   `results` maps a tool_call_id to its result text + error verdict (from the paired `role:"tool"`
   rows). This is the REAL reload tool source (content-block tool_use in interpretMessage is a
   legacy fallback). Untrusted -> parsed defensively; the view binds every field via textContent. */
export function parseToolCalls(raw: unknown, results: Map<string, ReloadedToolResult>): ToolCall[] {
   if (raw == null) return [];
   let arr: unknown = raw;
   if (typeof raw === "string") {
      try {
         arr = JSON.parse(raw);
      } catch {
         return [];
      }
   }
   if (!Array.isArray(arr)) return [];
   const out: ToolCall[] = [];
   for (const el of arr as Array<{
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
   }>) {
      if (el == null || typeof el !== "object") continue;
      const id = typeof el.id === "string" ? el.id : "";
      const fn = el.function ?? {};
      const name = typeof fn.name === "string" && fn.name ? fn.name : "tool";
      const args = typeof fn.arguments === "string" ? fn.arguments : undefined;
      const r = id ? results.get(id) : undefined;
      out.push({ id, name, args, result: r?.result, error: r?.error ? true : undefined });
   }
   return out;
}
