/* DAWN's machine state -> the reactor's state and the conversation's activity line. */

import type { ActivityStatus } from "./ingest.ts";
import type { ReactorState } from "../anchor/anchor.ts";

/* DAWN's conversation state -> our reactor state. DAWN has several states with no
   distinct reactor look; they read as "busy" (thinking). Without folding
   tool_call/processing/summarizing in here they hit the default and the core goes
   dark mid-turn (e.g. during tool use). */
export function toReactorState(dawn: string): ReactorState {
   switch (dawn) {
      case "listening":
         return "listening";
      case "thinking":
      case "summarizing":
      case "processing":
      case "tool_call":
         return "thinking";
      case "speaking":
         return "speaking";
      case "error":
         return "error";
      default:
         return "idle";
   }
}

/* DAWN's conversation state (+ its `detail` string) -> the activity chip. Returns
   null for idle/unknown, which clears the chip. tool_call's detail is "Calling
   <name>...", so we lift the tool name out for the chip's secondary text. */
export function toActivity(dawn: string, detail?: string): ActivityStatus | null {
   switch (dawn) {
      case "listening":
         return { label: "Listening" };
      case "thinking":
         return { label: "Thinking" };
      case "summarizing":
         return { label: "Summarizing" };
      case "processing":
         return { label: "Working" };
      case "tool_call": {
         const name = detail?.match(/^Calling\s+(.+?)\.{0,3}\s*$/i)?.[1];
         return { label: "Using tools", detail: name };
      }
      case "speaking":
         return { label: "Speaking" };
      case "error":
         return { label: "Error", tone: "alert" };
      default:
         return null;
   }
}
