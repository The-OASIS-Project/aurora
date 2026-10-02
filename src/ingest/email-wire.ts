/*
 * DawnIngest's side of the email boundary (EmailSource), kept out of the 5000-line dawn-ws.ts.
 * DawnIngest owns the socket and tells this module two things: whether DAWN advertises the
 * `email_client` feature (from each config frame) and whether the link is live.
 *
 * The wire itself (email_list / email_read / ... and the email_changed push) lands with DAWN's
 * P1.1-P1.3 drops (docs/EMAIL_PANEL_DESIGN.md 9.12). Until this module speaks those verbs, it
 * reports the feed as unavailable even if a newer DAWN advertises the flag: claiming "available"
 * with no wire would turn every request into a silent timeout. Every request rejects with
 * UNAVAILABLE rather than sending a verb DAWN may not know.
 */

import type {
   EmailAvailability,
   EmailChanges,
   EmailListQuery,
   EmailListResult,
   EmailMessage,
   EmailMoveResult,
   EmailSink,
   EmailSource,
   EmailUndoResult,
   EmailUnreadCount
} from "./email.ts";
import { EmailRequestError } from "./email.ts";

/* Flipped when this module implements DAWN's email verbs. */
const WIRE_READY = false;

export class DawnEmail implements EmailSource {
   private sink: EmailSink | null = null;
   private availability: EmailAvailability = "unknown";
   private linked = false;
   private wanted = false;

   /* From each config frame: does this DAWN advertise the email verbs? */
   setServerSupport(advertised: boolean): void {
      const next: EmailAvailability = advertised && WIRE_READY ? "available" : "unavailable";
      if (next === this.availability) return;
      this.availability = next;
      this.sink?.setAvailability(next);
   }

   setLinked(on: boolean): void {
      if (on === this.linked) return;
      this.linked = on;
      this.sink?.setLinked(on);
   }

   /* The panel's subscription intent, replayed on reconnect once the wire exists. */
   get subscriptionWanted(): boolean {
      return this.wanted;
   }

   attach(sink: EmailSink): void {
      this.sink = sink;
      sink.setAvailability(this.availability);
      sink.setLinked(this.linked);
   }

   detach(): void {
      this.sink = null;
      this.wanted = false;
   }

   private unavailable<T>(): Promise<T> {
      return Promise.reject(new EmailRequestError("UNAVAILABLE", "Mail isn't available on this DAWN"));
   }

   list(_q: EmailListQuery): Promise<EmailListResult> {
      return this.unavailable();
   }
   read(_accountId: number, _messageId: string, _markRead: boolean): Promise<{ message: EmailMessage; unread: boolean }> {
      return this.unavailable();
   }
   setFlags(_accountId: number, _messageIds: string[], _flags: { unread?: boolean }): Promise<void> {
      return this.unavailable();
   }
   archive(_accountId: number, _messageIds: string[]): Promise<EmailMoveResult> {
      return this.unavailable();
   }
   trash(_accountId: number, _messageIds: string[]): Promise<EmailMoveResult> {
      return this.unavailable();
   }
   undo(_accountId: number, _tokens: string[]): Promise<EmailUndoResult> {
      return this.unavailable();
   }
   unreadCounts(): Promise<EmailUnreadCount[]> {
      return this.unavailable();
   }
   changes(_accountId: number, _sinceState: string): Promise<EmailChanges> {
      return this.unavailable();
   }
   setSubscription(want: boolean, _accountIds?: number[]): void {
      this.wanted = want;
   }
}
