/*
 * The conversation surface (brief S4.1). Two faces of one thing:
 *
 *   - FRONT: a scrollable frosted window in the same language as the panels,
 *     readable up close. Each turn is a labelled block (USER / the AI's name) with
 *     a markdown-rendered body, streamed token-by-token.
 *   - RECEDED: when a turn settles and the pointer leaves, the window leans back
 *     from a fixed bottom edge into a trapezoid (real CSS-3D rotateX), its frame
 *     and far edge fading so only dimmed text remains, tipped into the distance.
 *     The lean-DOWN is slow (a recede); the raise back is quick. It never fully
 *     vanishes; move over it and it rises to front to browse.
 *
 * PASSIVE VIEW on the ingest side: ingest pushes stream/thinking + the assistant's
 * display name; the user's submit/focus are reported out. It owns only
 * presentation timing (the front/recede state machine). It never decides replies.
 */

import { renderMarkdown } from "./format.ts";

export interface ConversationController {
   setThinking(thinking: boolean): void;
   startReply(): void;
   appendDelta(delta: string): void;
   endReply(): void;
   showReply(text: string): void;
   setAssistantName(name: string): void;
   loadHistory(msgs: { role: "user" | "assistant"; text: string }[]): void;
   clear(): void;
   destroy(): void;
}

export interface ConversationOptions {
   onSubmit?: (text: string) => void;
   onEngage?: (engaged: boolean) => void;
}

interface Msg {
   role: "user" | "assistant";
   roleEl: HTMLElement;
   body: HTMLElement;
   text: string;
}

const IDLE_MS = 6000; // pointer off the window + settled -> recede
const LONG_IDLE_MS = 45000; // no activity at all -> recede even if hovered/focused
const HOVER_MARGIN = 64; // px slack around the window that still counts as "over"

export function mountConversation(
   root: HTMLElement,
   opts: ConversationOptions = {}
): ConversationController {
   const mount = root.querySelector<HTMLElement>("#convo")!;
   const form = root.querySelector<HTMLFormElement>("#composer")!;
   const input = root.querySelector<HTMLInputElement>("#composer-input")!;

   const win = document.createElement("div");
   win.className = "convo-window empty";
   for (const c of ["tl", "tr", "bl", "br"]) {
      const corner = document.createElement("span");
      corner.className = `panel-corner ${c}`;
      win.appendChild(corner);
   }
   const scroll = document.createElement("div");
   scroll.className = "convo-scroll";
   win.appendChild(scroll);
   mount.appendChild(win);

   const messages: Msg[] = [];
   let streaming: Msg | null = null;
   let assistantName = "DAWN"; // replaced by the configured ai_name once known
   let active = false;
   let thinking = false;
   let focused = false;
   let hovering = false;
   let shortTimer = 0;
   let longTimer = 0;
   let raf = 0;

   const scrollToEnd = (): void => {
      win.scrollTop = win.scrollHeight;
   };

   const appendMsg = (role: "user" | "assistant", text: string): Msg => {
      win.classList.remove("empty");
      const el = document.createElement("div");
      el.className = `convo-msg ${role}`;

      const roleEl = document.createElement("div");
      roleEl.className = "convo-role";
      roleEl.textContent = role === "user" ? "USER" : assistantName;

      const body = document.createElement("div");
      body.className = "convo-body";
      if (role === "user") body.textContent = text;
      else body.innerHTML = renderMarkdown(text);

      el.append(roleEl, body);
      scroll.appendChild(el);
      const msg: Msg = { role, roleEl, body, text };
      messages.push(msg);
      scrollToEnd();
      return msg;
   };

   /* Streaming markdown: re-render the growing reply at most once per frame so a
      fast token stream does not re-parse per token. */
   const scheduleRender = (): void => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
         raf = 0;
         if (streaming) {
            streaming.body.innerHTML = renderMarkdown(streaming.text);
            scrollToEnd();
         }
      });
   };

   const summon = (): void => {
      if (!active) {
         active = true;
         win.classList.remove("receded");
         scrollToEnd();
      }
      armIdle();
   };

   const recede = (): void => {
      if (!active || messages.length === 0) return;
      active = false;
      win.classList.add("receded"); // leans back slowly, dims, edges fade — persists
   };

   /* Two countdowns: the short one recedes once the pointer is off the window;
      the long one recedes on total inactivity even while hovered or focused
      (reset by any real activity, which flows through summon()). */
   function armIdle(): void {
      window.clearTimeout(shortTimer);
      window.clearTimeout(longTimer);
      if (thinking || messages.length === 0) return;
      longTimer = window.setTimeout(recede, LONG_IDLE_MS);
      if (!hovering && !focused) shortTimer = window.setTimeout(recede, IDLE_MS);
   }

   /* --- ingest-facing (passive view) --------------------------------------- */

   const setThinking = (t: boolean): void => {
      thinking = t;
      win.classList.toggle("thinking", t);
      if (t) summon();
      else armIdle();
   };

   const startReply = (): void => {
      summon();
      streaming = appendMsg("assistant", "");
      win.classList.remove("thinking");
   };

   const appendDelta = (delta: string): void => {
      if (!streaming) startReply();
      streaming!.text += delta;
      scheduleRender();
      summon();
   };

   const endReply = (): void => {
      if (raf) {
         cancelAnimationFrame(raf);
         raf = 0;
      }
      if (streaming) streaming.body.innerHTML = renderMarkdown(streaming.text);
      streaming = null;
      scrollToEnd();
      setThinking(false);
   };

   const showReply = (text: string): void => {
      streaming = null;
      appendMsg("assistant", text);
      setThinking(false);
      summon();
   };

   const setAssistantName = (name: string): void => {
      if (!name) return;
      assistantName = name;
      for (const m of messages) {
         if (m.role === "assistant") m.roleEl.textContent = name;
      }
   };

   /* Empty the surface (a tool reset the conversation). */
   const clear = (): void => {
      if (raf) {
         cancelAnimationFrame(raf);
         raf = 0;
      }
      window.clearTimeout(shortTimer);
      window.clearTimeout(longTimer);
      streaming = null;
      thinking = false;
      active = false;
      scroll.replaceChildren();
      messages.length = 0;
      win.classList.remove("thinking", "receded");
      win.classList.add("empty");
   };

   /* Replace the transcript with a loaded conversation, then show it briefly so
      there is somewhere to start; it recedes on its own after the idle interval. */
   const loadHistory = (msgs: { role: "user" | "assistant"; text: string }[]): void => {
      if (raf) {
         cancelAnimationFrame(raf);
         raf = 0;
      }
      streaming = null;
      scroll.replaceChildren();
      messages.length = 0;
      for (const m of msgs) if (m.text) appendMsg(m.role, m.text);
      if (messages.length > 0) summon();
   };

   /* --- user-facing -------------------------------------------------------- */

   const onSubmit = (e: SubmitEvent): void => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      appendMsg("user", text);
      summon();
      opts.onSubmit?.(text);
   };
   const onInput = (): void => summon(); // typing counts as activity
   const engage = (): void => {
      focused = true;
      summon();
      opts.onEngage?.(true);
   };
   const disengage = (): void => {
      focused = false;
      armIdle();
      opts.onEngage?.(false);
   };

   /* Pointer over the window (with slack) keeps it up or brings it back; leaving
      arms the recede. The transformed (leaned) window still reports a hittable
      box, so hovering the receded text raises it again. */
   const onMove = (e: PointerEvent): void => {
      if (messages.length === 0) return;
      const r = win.getBoundingClientRect();
      const over =
         e.clientX >= r.left - HOVER_MARGIN &&
         e.clientX <= r.right + HOVER_MARGIN &&
         e.clientY >= r.top - HOVER_MARGIN &&
         e.clientY <= r.bottom + HOVER_MARGIN;
      if (over) {
         hovering = true;
         summon();
      } else if (hovering) {
         hovering = false;
         armIdle();
      }
   };

   form.addEventListener("submit", onSubmit);
   input.addEventListener("input", onInput);
   input.addEventListener("focus", engage);
   input.addEventListener("blur", disengage);
   window.addEventListener("pointermove", onMove);

   return {
      setThinking,
      startReply,
      appendDelta,
      endReply,
      showReply,
      setAssistantName,
      loadHistory,
      clear,
      destroy: () => {
         window.clearTimeout(shortTimer);
         window.clearTimeout(longTimer);
         if (raf) cancelAnimationFrame(raf);
         form.removeEventListener("submit", onSubmit);
         input.removeEventListener("input", onInput);
         input.removeEventListener("focus", engage);
         input.removeEventListener("blur", disengage);
         window.removeEventListener("pointermove", onMove);
         win.remove();
      }
   };
}
