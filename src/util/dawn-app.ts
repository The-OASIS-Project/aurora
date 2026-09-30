/*
 * DAWN's per-app logins (`app_logins`): with it, Aurora has its own login cookie
 * (dawn_session_aurora), and EVERY DAWN URL it builds or renders must carry `app=aurora`, or DAWN
 * authenticates it as the WebUI's login (the wrong user, or a 401). A query param, never a header
 * (DAWN reads custom headers only on some builds). The ingest turns it on from /api/auth/status;
 * the markdown renderer uses it for same-origin /api links in replies. Off against an older DAWN.
 */

export const APP_NAME = "aurora";

let appLogins = false;

export function setAppLogins(on: boolean): void {
   appLogins = on;
}

export function appLoginsOn(): boolean {
   return appLogins;
}

/* Tag a DAWN path/URL with this app (merged with `&` when it already has a query). Unchanged when
   per-app logins are off. */
export function tagDawnUrl(url: string): string {
   if (!appLogins) return url;
   const hash = url.indexOf("#");
   const base = hash < 0 ? url : url.slice(0, hash);
   const frag = hash < 0 ? "" : url.slice(hash);
   return `${base}${base.includes("?") ? "&" : "?"}app=${APP_NAME}${frag}`;
}

/* For a URL found in rendered content: tag it only if it points at this origin's DAWN API. */
export function tagIfDawnApi(url: string): string {
   if (!appLogins) return url;
   try {
      const u = new URL(url, window.location.origin);
      if (u.origin !== window.location.origin || !u.pathname.startsWith("/api/")) return url;
      if (u.searchParams.has("app")) return url;
      u.searchParams.set("app", APP_NAME);
      return u.pathname + u.search + u.hash;
   } catch {
      return url;
   }
}
