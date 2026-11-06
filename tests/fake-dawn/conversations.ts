/* The fake DAWN's saved conversations: a small in-memory store, so a dev session stays consistent
   (a new chat appears in the picker, a turn's messages are there on a reload). Each FakeDawn has
   its own; the stateless fixture answers use a freshly seeded one. Shapes follow webui_history.c
   (the conversation row serializer, load_msg_callback). */

export interface FakeMessage {
   id: number;
   role: "user" | "assistant";
   content: string;
   created_at: number;
}

/* The reasoning a conversation was last set to (the stored picks; DAWN stamps them on the
   conversation at create and on every set_session_llm, and restores them on load). */
export interface ReasoningPick {
   mode: string;
   effort: string;
}

export const DEFAULT_PICK: ReasoningPick = { mode: "adaptive", effort: "medium" };

export interface FakeConversation {
   id: number;
   title: string;
   created_at: number;
   updated_at: number;
   messages: FakeMessage[];
   pick: ReasoningPick;
}

const now = (): number => Math.floor(Date.now() / 1000);

/* How much a store keeps: at most `conversations` (the least recently updated go first) and
   `messages` per conversation (the oldest go first). Unbounded unless set: a long `npm run
   dev:fake` sets it, so a client on the LAN can't grow the server without limit. */
export interface StoreLimit {
   conversations: number;
   messages: number;
}

export class ConversationStore {
   limit: StoreLimit = { conversations: Infinity, messages: Infinity };
   private readonly conversations = new Map<number, FakeConversation>();
   private nextMessageId = 1;
   /* Ids are never reused, even after a delete (DAWN's are AUTOINCREMENT). */
   private nextConversationId = 1;

   /* A store holding one saved conversation with one exchange in it, dated just before now. */
   static seeded(seed: {
      id: number;
      title: string;
      user: string;
      assistant: string;
   }): ConversationStore {
      const store = new ConversationStore();
      const t = now();
      store.nextConversationId = seed.id + 1;
      store.conversations.set(seed.id, {
         id: seed.id,
         title: seed.title,
         pick: { ...DEFAULT_PICK },
         created_at: t - 3600,
         updated_at: t - 60,
         messages: [
            { id: store.nextMessageId++, role: "user", content: seed.user, created_at: t - 120 },
            {
               id: store.nextMessageId++,
               role: "assistant",
               content: seed.assistant,
               created_at: t - 60
            }
         ]
      });
      return store;
   }

   get(id: number): FakeConversation | undefined {
      return this.conversations.get(id);
   }

   /* Most recently updated first, as DAWN lists them. */
   list(): FakeConversation[] {
      return [...this.conversations.values()].sort((a, b) => b.updated_at - a.updated_at);
   }

   /* A new, empty conversation (DAWN creates it on `new_conversation`, with the title given or
      "New Conversation" for none, auth_db_conv.c), with the session's reasoning stamped on it. */
   create(title: string, pick: ReasoningPick): FakeConversation {
      const id = this.nextConversationId++;
      const t = now();
      const conversation = {
         id,
         title: title || "New Conversation",
         created_at: t,
         updated_at: t,
         messages: [],
         pick: { ...pick }
      };
      this.conversations.set(id, conversation);
      while (this.conversations.size > this.limit.conversations) {
         const oldest = this.list().at(-1);
         if (!oldest || oldest === conversation) break;
         this.conversations.delete(oldest.id);
      }
      return conversation;
   }

   /* A message with its id given now, saved later with add() (a reply's id goes out with its
      stream, but the row exists only once the reply is finished). */
   reserve(role: FakeMessage["role"], content: string): FakeMessage {
      return { id: this.nextMessageId++, role, content, created_at: now() };
   }

   /* Saves a message to a conversation and bumps it to the top of the list. False when the
      conversation is gone (deleted meanwhile). */
   add(id: number, message: FakeMessage): boolean {
      const conversation = this.conversations.get(id);
      if (!conversation) return false;
      message.created_at = now();
      conversation.messages.push(message);
      if (conversation.messages.length > this.limit.messages)
         conversation.messages.splice(0, conversation.messages.length - this.limit.messages);
      conversation.updated_at = message.created_at;
      return true;
   }
}

/* One row of `list_conversations_response` (webui_history.c conversation row serializer). */
export function conversationRow(c: FakeConversation): Record<string, unknown> {
   return {
      id: c.id,
      title: c.title,
      created_at: c.created_at,
      updated_at: c.updated_at,
      message_count: c.messages.length,
      is_archived: false,
      is_private: false,
      is_pinned: false,
      origin: "webui"
   };
}
