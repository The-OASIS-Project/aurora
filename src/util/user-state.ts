/*
 * Per-user browser state, and its teardown on a user switch. Aurora keeps some of the signed-in
 * user's data in localStorage so a reload resumes where they left off. None of it may survive
 * into another user's login on the same browser, so a logout, a revoked session, or a login as
 * someone else clears it (and the caller reloads the page so every panel starts empty).
 *
 * Layout preferences (panel positions, visibility, list heights, volume) are per machine, not
 * per user, and stay.
 */

/* The signed-in user, so a login as someone else is detected even after a page reload. */
const LAST_USER_KEY = "dawn.hero.lastUser";
/* Why the last session ended (revoked/expired), shown on the login card after the reload. */
const END_REASON_KEY = "dawn.hero.sessionEndReason";

/* Keys holding the signed-in user's data. Each is owned by another module; keep this list in
   step when one is added. */
const USER_KEYS = [
   "dawn.hero.sessionToken", // dawn-ws TOKEN_KEY: the WS session to resume (the user's LLM session)
   "dawn.hero.convId", // dawn-ws CONV_KEY: the conversation to reopen
   "dawn.hero.hud", // hud HUD_CACHE_KEY: last telemetry (conversation title, model, ...)
   "dawn.hero.rateEma", // dawn-ws RATE_EMA_KEY: token-rate average
   "dawn.hero.cacheSums", // dawn-ws CACHE_SUM_KEY: prompt-cache totals
   "dawn.hero.sessionKeepalive", // dawn-ws KEEPALIVE_KEY: this user's "Always on" consent
   "dawn.hero.mailPrefs" // email-panel MAIL_PREFS_KEY: account filter + per-account notify (account ids)
];

function tryStorage(fn: () => void): void {
   try {
      fn();
   } catch {
      /* storage disabled / blocked: nothing persisted to clear */
   }
}

/* Notice cards persist their snap/position under a key built from the notice id, which for an
   alert or observation contains its text: sweep them too. */
const NOTICE_PREFIX = "aurora.notice.";

/* Remove every per-user key (the last-user marker is kept unless `forgetUser`). */
export function clearUserState(opts: { forgetUser?: boolean } = {}): void {
   tryStorage(() => {
      for (const k of USER_KEYS) localStorage.removeItem(k);
      if (opts.forgetUser) localStorage.removeItem(LAST_USER_KEY);
      const notices: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
         const k = localStorage.key(i);
         if (k && k.startsWith(NOTICE_PREFIX)) notices.push(k);
      }
      for (const k of notices) localStorage.removeItem(k);
   });
}

/* The key another tab's login writes (for a `storage` listener). */
export const LAST_USER_STORAGE_KEY = LAST_USER_KEY;

/* True when `username` differs from the user this browser last signed in as (or none is
   recorded, the safe default). Exact match (trimmed): DAWN usernames are case-sensitive, so
   "Vision" and "vision" are different accounts. */
export function isDifferentUser(username: string): boolean {
   let last: string | null = null;
   tryStorage(() => {
      last = localStorage.getItem(LAST_USER_KEY);
   });
   return last === null || (last as string).trim() !== username.trim();
}

export function rememberUser(username: string): void {
   tryStorage(() => localStorage.setItem(LAST_USER_KEY, username.trim()));
}

/* Carry a session-end reason across the reload (sessionStorage: this tab only). */
export function stashEndReason(reason: string | undefined): void {
   if (!reason) return;
   tryStorage(() => sessionStorage.setItem(END_REASON_KEY, reason));
}

export function takeEndReason(): string | undefined {
   let reason: string | null = null;
   tryStorage(() => {
      reason = sessionStorage.getItem(END_REASON_KEY);
      sessionStorage.removeItem(END_REASON_KEY);
   });
   return reason ?? undefined;
}
