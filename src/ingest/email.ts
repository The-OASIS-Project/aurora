/*
 * The email boundary: what the Mail panel can ask of a mail source, and what a source pushes
 * back. Mirrors DAWN's planned email verbs one to one (docs/EMAIL_PANEL_DESIGN.md section 9),
 * so the live client (DawnIngest, once DAWN advertises `email_client`) and the dev simulator
 * (email-sim.ts) are interchangeable behind it.
 *
 * Deliberately NOT part of IngestSinks: a source is bound to the panel with attach(), so
 * exactly one source ever feeds it. Every string in these types is untrusted (email is
 * attacker-authored); views bind them via textContent, and bodies only go through the email
 * render pipeline (src/email/render-body.ts).
 */

/* Coded failures, per account or per message. A view maps these to copy; it never shows
   provider text as the only explanation. */
export type EmailErrorCode =
   | "AUTH_REVOKED"
   | "AUTH_FAILED"
   | "UNREACHABLE"
   | "TIMEOUT"
   | "RATE_LIMITED"
   | "READ_ONLY"
   | "NOT_FOUND"
   | "CURSOR_STALE"
   | "FOLDER_MISSING"
   | "NO_TRASH"
   | "CANNOT_CALCULATE"
   | "UNSUPPORTED_QUERY"
   | "ALREADY_THERE"
   | "LEFT_FLAGGED"
   | "NOT_REMOVED"
   | "UNAVAILABLE";

export type EmailAccountStatus = "ok" | "auth_revoked" | "auth_failed" | "unreachable";

/* One of the user's mail accounts (from DAWN's account list; setup lives in DAWN's WebUI). */
export interface EmailAccount {
   id: number;
   address: string;
   displayName: string;
   readOnly: boolean;
}

/* A list row. A message is identified by the PAIR (accountId, messageId): IMAP ids are
   "folder:uid", unique only within one account. */
export interface EmailRow {
   accountId: number;
   messageId: string;
   threadId?: string;
   fromName: string;
   fromAddr: string;
   subject: string;
   date: number; // epoch seconds, the server's receive time (not the spoofable Date: header)
   preview: string;
   unread: boolean;
   starred?: boolean;
   important?: boolean;
   hasAttachments?: boolean;
}

export interface EmailAddress {
   name: string;
   addr: string;
}

export interface EmailAttachment {
   partId: string;
   filename: string;
   mime: string;
   size: number;
   inline: boolean;
   contentId?: string;
}

/* A full message (email_read). bodyHtml is the decoded HTML part, raw: the panel sanitizes. */
export interface EmailMessage {
   accountId: number;
   messageId: string;
   threadId?: string;
   subject: string;
   fromName: string;
   fromAddr: string;
   to: EmailAddress[];
   cc: EmailAddress[];
   /* The real recipient counts when DAWN cut a list (it sends at most 32 of each). */
   toTotal?: number;
   ccTotal?: number;
   replyTo?: EmailAddress;
   date: number;
   bodyText: string;
   bodyHtml?: string;
   textTruncated: boolean;
   htmlTruncated: boolean;
   attachments: EmailAttachment[];
   /* More attachments than listed (DAWN's MIME walk stopped at its part cap). */
   attachmentsTruncated?: boolean;
}

export interface EmailFailure {
   code: EmailErrorCode;
   message: string;
}

export interface EmailListQuery {
   accountIds?: number[]; // absent = every account
   unreadOnly?: boolean;
   query?: string; // present = search
   cursor?: string;
   limit?: number;
}

export interface EmailListResult {
   rows: EmailRow[];
   cursor: string | null; // null = end of the list
   partial: Array<{ accountId: number } & EmailFailure>;
}

/* A move the user can take back: the token reverses it server-side for a short while. */
export interface EmailUndoable {
   messageId: string;
   undo: string;
}

export interface EmailMoveResult {
   done: EmailUndoable[];
   failed: Array<{ messageId: string } & EmailFailure>;
}

export interface EmailUndoResult {
   restored: Array<{ undo: string; row: EmailRow }>;
   failed: Array<{ undo: string } & EmailFailure>;
}

export interface EmailUnreadCount {
   accountId: number;
   inboxUnread: number;
   status: EmailAccountStatus;
}

/* A delta for one account (JMAP-style): what was created, changed, or removed since `state`. */
export interface EmailChanges {
   accountId: number;
   state: string;
   created: EmailRow[];
   updated: EmailRow[];
   destroyed: string[];
}

/* A reference the user hands to the assistant ("Discuss"). The panel and the conversation view
   both import it from here, never from each other. sender/subject are display-only. */
export interface EmailRef {
   accountId: number;
   messageId: string;
   sender: string;
   subject: string;
}

export type EmailAvailability = "unknown" | "available" | "unavailable";

/* Thrown (as a rejected promise) by a request that failed as a whole. */
export class EmailRequestError extends Error {
   constructor(
      readonly code: EmailErrorCode,
      message: string
   ) {
      super(message);
   }
}

/* What a source pushes to the panel. */
export interface EmailSink {
   setAvailability(a: EmailAvailability): void;
   setAccounts(accounts: EmailAccount[]): void;
   setUnreadCounts(counts: EmailUnreadCount[]): void;
   applyChanges(changes: EmailChanges): void;
   /* The link to the source dropped or returned (offline state; resubscribe + catch up). */
   setLinked(linked: boolean): void;
}

export interface EmailSource {
   attach(sink: EmailSink): void;
   detach(): void;
   list(q: EmailListQuery): Promise<EmailListResult>;
   read(accountId: number, messageId: string, markRead: boolean): Promise<{ message: EmailMessage; unread: boolean }>;
   setFlags(accountId: number, messageIds: string[], flags: { unread?: boolean }): Promise<void>;
   archive(accountId: number, messageIds: string[]): Promise<EmailMoveResult>;
   trash(accountId: number, messageIds: string[]): Promise<EmailMoveResult>;
   undo(accountId: number, tokens: string[]): Promise<EmailUndoResult>;
   unreadCounts(): Promise<EmailUnreadCount[]>;
   changes(accountId: number, sinceState: string): Promise<EmailChanges>;
   /* Live updates on/off for these accounts (absent = all). The source replays the intent on a
      reconnect. */
   setSubscription(want: boolean, accountIds?: number[]): void;
}
