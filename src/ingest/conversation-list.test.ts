// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DawnIngest } from "./dawn-ws.ts";
import { setAppLogins } from "../util/dawn-app.ts";

/* The conversation picker's list: one list or search request in flight at a time, a refresh asked
   for meanwhile queued rather than raced (two page-0 replies could be read as an append and
   duplicate the list), a load-more labelled as an append, and DAWN's conversation_list_changed
   pushes coalesced into one refresh. Driven through the picker's calls and DAWN's frames. */

type Sent = { type: string; payload?: Record<string, unknown> };
type ListCall = { rows: number; opts: { append?: boolean; searching?: boolean } };
let ing: Record<string, any> | null = null;
let sent: Sent[] = [];
let lists: ListCall[] = [];

beforeEach(() => {
   localStorage.clear();
   setAppLogins(false);
   sent = [];
   lists = [];
   vi.useFakeTimers();
   vi.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => {
   ing?.dispose();
   ing = null;
   vi.useRealTimers();
   vi.restoreAllMocks();
});

/* Sinks that do nothing, except the picker's list, which is recorded. */
const sinks = new Proxy(
   {},
   {
      get: (_t, sink) =>
         new Proxy(
            {},
            {
               get:
                  (_u, method) =>
                  (...args: unknown[]) => {
                     if (sink === "conversationList" && method === "setList")
                        lists.push({
                           rows: (args[0] as unknown[]).length,
                           opts: args[1] as ListCall["opts"]
                        });
                     return undefined;
                  }
            }
         )
   }
);

function connect(): void {
   ing = new DawnIngest();
   ing.start(sinks);
   ing.ws = {
      readyState: WebSocket.OPEN,
      send: (t: string) => sent.push(JSON.parse(t) as Sent),
      close: () => {}
   };
}
const frame = (type: string, payload: Record<string, unknown>): void =>
   ing!.onFrame(JSON.stringify({ type, payload }));
const listsSent = (): Sent[] => sent.filter((m) => m.type === "list_conversations");
const page = (n: number) => ({
   conversations: Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `c${i + 1}` })),
   total: n
});

it("a refresh asked for while a list is in flight waits for its reply, then goes once", () => {
   connect();
   ing!.listConversations({ limit: 50, offset: 0 });
   frame("rename_conversation_response", { success: false }); // asks for a refetch now
   frame("rename_conversation_response", { success: false });
   expect(listsSent()).toHaveLength(1); // not raced
   frame("list_conversations_response", page(3));
   expect(listsSent()).toHaveLength(2); // the queued one, once
   expect(listsSent()[1].payload).toEqual({ limit: 50, offset: 0 });
});

it("a load-more reply is an append; a first page is a replace", () => {
   connect();
   ing!.listConversations({ limit: 50, offset: 50 });
   frame("list_conversations_response", page(2));
   ing!.listConversations({ limit: 50, offset: 0 });
   frame("list_conversations_response", page(4));
   expect(lists.map((l) => l.opts.append)).toEqual([true, false]);
});

it("a refresh asked for during a search isn't lost: it goes when the search answers", () => {
   connect();
   ing!.searchConversations("notes", false);
   frame("set_pinned_response", { success: false, conversation_id: 1 });
   expect(listsSent()).toHaveLength(0);
   frame("search_conversations_response", page(1));
   expect(lists.at(-1)!.opts.searching).toBe(true);
   expect(listsSent()).toHaveLength(1);
});

it("DAWN's list changes refresh once, after a pause, but not for this tab's own active turn", () => {
   connect();
   ing!.loadConversation(7);
   sent = [];
   frame("conversation_list_changed", { conversation_id: 7, reason: "bumped" }); // our own turn
   vi.advanceTimersByTime(1000);
   expect(listsSent()).toHaveLength(0);
   for (const id of [3, 4, 3])
      frame("conversation_list_changed", { conversation_id: id, reason: "bumped" });
   vi.advanceTimersByTime(699);
   expect(listsSent()).toHaveLength(0);
   vi.advanceTimersByTime(1);
   expect(listsSent()).toHaveLength(1); // one refresh for the burst
   frame("list_conversations_response", page(2));
   frame("conversation_list_changed", { conversation_id: 7, reason: "created" }); // never filtered
   vi.advanceTimersByTime(700);
   expect(listsSent()).toHaveLength(2);
});

it("a refused rename refetches at once; a successful one through the pause", () => {
   connect();
   frame("rename_conversation_response", { success: true });
   expect(listsSent()).toHaveLength(0);
   vi.advanceTimersByTime(700);
   expect(listsSent()).toHaveLength(1);
   frame("list_conversations_response", page(1));
   frame("rename_conversation_response", { success: false });
   expect(listsSent()).toHaveLength(2);
});
