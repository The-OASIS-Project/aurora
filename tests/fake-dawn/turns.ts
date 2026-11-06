/* What the fake DAWN sends for one typed turn, in DAWN's order (webui_text_processing.c,
   session_manager_llm.c, webui_server.c, webui_broadcasts.c): a timed list of frames the core
   schedules. A plain text reply: no reasoning stream, no tools, no speech, no injected context.
   The reply is canned, so the conversation view can be worked on with no daemon. */

export interface TimedFrame {
   /* Milliseconds after the turn started. 0 = at once. */
   at: number;
   frame: object;
   /* Who gets it: the connection that sent the turn, or the user's other browser connections.
      DAWN sends the turn's own frames (state, stream, metrics, the echo) to the sender only;
      message_appended and conversation_list_changed reach every browser of the user, the other
      tabs' message_appended without the client_ref (webui_broadcasts.c). */
   to: "sender" | "others";
}

export interface TurnTiming {
   /* Before the first reply token (DAWN's time to first token). */
   firstTokenMs: number;
   /* Between reply chunks. */
   chunkMs: number;
}

export interface TurnInput {
   text: string;
   clientRef?: string;
   /* The conversation the turn runs in, 0 for none (then nothing is saved). */
   conversationId: number;
   /* The saved user row's id, and the reply's, when the turn runs in a conversation. */
   userMessageId?: number;
   replyMessageId?: number;
   streamId: number;
}

/* The canned reply: says plainly what it is, quotes the message, and exercises markdown. */
export function cannedReply(text: string): string {
   const said = text.length > 200 ? `${text.slice(0, 200)}…` : text;
   return [
      "This is the **fake DAWN**, so this reply is canned. You said:",
      "",
      ...said.split("\n").map((line) => `> ${line}`),
      "",
      "A real DAWN would answer here. Things to try offline:",
      "",
      "- the streaming text and the reactor's states",
      "- markdown: `inline code`, lists, [a link](https://example.com)",
      "- the conversation picker (this chat is in it now)"
   ].join("\n");
}

/* The reply cut into the chunks it streams in (a few words each, spaces kept). */
function chunks(reply: string): string[] {
   return reply.match(/\S+\s*/g) ?? [reply];
}

/* A metrics_update (webui_send.c send_metrics_impl). */
function metrics(state: string, conversationId: number, ttft: number, rate: number): object {
   return {
      type: "metrics_update",
      payload: {
         state,
         ttft_ms: ttft,
         token_rate: rate,
         context_percent: -1,
         input_tokens: 0,
         cached_tokens: 0,
         cache_saved_tokens: 0,
         conversation_id: conversationId
      }
   };
}

/* A state frame: DAWN leaves conversation_id out when there is none (webui_send.c:432). */
function state(name: string, conversationId: number, detail?: string): object {
   return {
      type: "state",
      payload: {
         state: name,
         ...(conversationId > 0 ? { conversation_id: conversationId } : {}),
         ...(detail ? { detail } : {})
      }
   };
}

/* conversation_list_changed (webui_broadcasts.c), on every saved non-tool row. */
function bumped(conversationId: number): object {
   return {
      type: "conversation_list_changed",
      payload: { conversation_id: conversationId, reason: "bumped" }
   };
}

export function turnFrames(input: TurnInput, timing: TurnTiming): TimedFrame[] {
   const { text, clientRef, conversationId: conv, streamId: sid } = input;
   const saved = conv > 0 && input.userMessageId !== undefined;
   const ref = clientRef ? { client_ref: clientRef } : {};
   const reply = cannedReply(text);
   const out: TimedFrame[] = [];
   const at = (ms: number, frame: object): void => void out.push({ at: ms, frame, to: "sender" });
   const others = (ms: number, frame: object): void =>
      void out.push({ at: ms, frame, to: "others" });
   const everyone = (ms: number, frame: object): void => {
      at(ms, frame);
      others(ms, frame);
   };

   /* Received: thinking, the user row saved (list bumped), its echo, its message_appended. */
   at(0, state("thinking", conv, "Processing request..."));
   if (saved) everyone(0, bumped(conv));
   at(0, {
      type: "transcript",
      payload: {
         role: "user",
         text,
         ...(saved
            ? { conversation_id: conv, message_id: input.userMessageId, server_saved: true }
            : {}),
         ...ref
      }
   });
   if (saved) {
      const appended = {
         conversation_id: conv,
         message_id: input.userMessageId,
         role: "user",
         text,
         stream_id: 0
      };
      at(0, { type: "message_appended", payload: { ...appended, ...ref } });
      others(0, { type: "message_appended", payload: appended });
   }

   /* The first token: metrics, speaking, the stream opens with it. */
   const first = timing.firstTokenMs;
   const parts = chunks(reply);
   at(first, metrics("thinking", conv, first, 0));
   at(first, state("speaking", conv));
   at(first, metrics("speaking", conv, 0, 0));
   at(first, { type: "stream_start", payload: { stream_id: sid, conversation_id: conv } });
   /* The chunks, with a "thinking" metrics update carrying the live rate at every 5th token
      (session_manager_llm.c:110; the one at the first token is above). */
   const rateNow = Math.round(1000 / Math.max(timing.chunkMs, 1));
   parts.forEach((delta, i) => {
      const ms = first + i * timing.chunkMs;
      if ((i + 1) % 5 === 0) at(ms, metrics("thinking", conv, first, rateNow));
      at(ms, { type: "stream_delta", payload: { stream_id: sid, conversation_id: conv, delta } });
   });

   /* The end: metrics, stream_end (will_persist only when it will be saved), the reply row
      saved (list bumped, message_appended matched to its bubble by stream_id), then idle. */
   const end = first + parts.length * timing.chunkMs;
   at(end, metrics("idle", conv, first, 0)); // DAWN's final idle metrics carry token_rate 0
   at(end, {
      type: "stream_end",
      payload: {
         stream_id: sid,
         conversation_id: conv,
         reason: "complete",
         ...(saved ? { will_persist: true } : {})
      }
   });
   if (saved && input.replyMessageId !== undefined) {
      everyone(end, bumped(conv));
      everyone(end, {
         type: "message_appended",
         payload: {
            conversation_id: conv,
            message_id: input.replyMessageId,
            role: "assistant",
            text: reply,
            stream_id: sid
         }
      });
   }
   /* The context window, then idle (webui_text_processing.c:704-714). */
   at(end, { type: "context", payload: { current: 0, max: 200000, usage: 0, threshold: 80 } });
   at(end, state("idle", conv));
   at(end, metrics("idle", conv, 0, 0));
   return out;
}
