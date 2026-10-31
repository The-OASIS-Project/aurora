/*
 * The two "forget what a conversation taught" confirms (forget_conversation_memories): the
 * offer DAWN prompts after a conversation is marked private (conversation_learned counts),
 * and the picker's manual Forget on any row. Both are DESTRUCTIVE writes over the user's own
 * memory, so both are named confirms and the write fires only from the Forget button. Both
 * start focused on Keep: the offer opens unprompted after a server reply, so a stray Enter
 * must keep, never delete. Chrome, outside the render seam.
 */

import { openDialog, openDialogWhenFree, type DialogAction } from "../menu/dialog.ts";
import type { LearnedCounts, MemoryForgetSink } from "../ingest/ingest.ts";

/* DAWN's own fine print (www/js/ui/settings/forget-learned.js), shared by both dialogs. */
const SCOPE_NOTE =
   'This includes anything saved here with "remember". What another conversation also taught ' +
   "stays, as do imported memories. An older version a removed memory had replaced is removed " +
   "too, so it does not come back as current. Memories saved before September 2026 may not " +
   "record where they came from; check the Memory panel for those.";

const countNoun = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const forgetActions = (onForget: () => void): DialogAction[] => [
   { label: "Keep", onClick: () => {}, autofocus: true },
   { label: "Forget", danger: true, onClick: onForget }
];

/* The post-private offer, fed by the ingest's memoryForget sink. */
export function mountForgetLearned(opts: {
   onForget(conversationId: number): void;
}): MemoryForgetSink {
   return {
      offerForgetLearned(
         conversationId: number,
         counts: LearnedCounts,
         assistantName: string,
         stillValid: () => boolean
      ): void {
         let what = countNoun(counts.memories, "memory", "memories");
         if (counts.outdated > 0) {
            what += `, ${countNoun(counts.outdated, "older version", "older versions")} of memories`;
         }
         if (counts.relations > 0) {
            what += ` and ${countNoun(counts.relations, "connection", "connections")} between people and things`;
         }
         /* Unprompted: never displaces a dialog the user has open, and Forget arms after a beat. */
         openDialogWhenFree({
            title: "Forget what was learned?",
            armDelayMs: 600,
            key: `forget-learned:${conversationId}`,
            stillValid,
            body:
               `${assistantName} already learned ${what} from this conversation (and any continuation ` +
               "of it) before it was private. Forget them too? This cannot be undone.",
            note: SCOPE_NOTE,
            actions: forgetActions(() => opts.onForget(conversationId))
         });
      }
   };
}

/* The picker's manual Forget, for any conversation (private or not). No counts up front: DAWN
   only counts a private conversation, so the result notice reports what was forgotten. */
export function confirmForgetMemories(title: string, onForget: () => void): void {
   openDialog({
      title: "Forget what was learned?",
      body:
         `Forget every memory learned from "${title || "Untitled"}" (and any continuation of it)? ` +
         "The conversation itself stays. This cannot be undone.",
      note: SCOPE_NOTE,
      actions: forgetActions(onForget)
   });
}
