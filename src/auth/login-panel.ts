/*
 * Login panel: the one place the dashboard collects credentials. Chrome, like the
 * HUD and menu, so it lives outside the render seam and only reports intent — it
 * hands (username, password) to onConnect and reflects the connection status the
 * ingest reports back. It never sees the session cookie (HttpOnly).
 *
 * Two faces: a centered card while disconnected, and a small corner "linked"
 * chip once the socket is up (so it stays out of the way of the live dashboard).
 */

import type { LinkStatus } from "../ingest/dawn-ws.ts";

export interface LoginOptions {
   onConnect: (username: string, password: string) => Promise<void>;
   onDisconnect: () => void;
   /* User gesture to reclaim the session after another tab took it over (the "superseded"
      takeover card's button). Omit -> the card shows without a reclaim control. */
   onReclaim?: () => void;
}

export interface LoginController {
   setStatus: (status: LinkStatus, detail?: string) => void;
   destroy: () => void;
}

const STATUS_TEXT: Record<LinkStatus, string> = {
   checking: "Linking…",
   idle: "Awaiting link",
   authenticating: "Authenticating…",
   connecting: "Opening channel…",
   connected: "Linked",
   stale: "Link unstable…",
   superseded: "Active in another tab",
   disconnected: "Disconnected",
   error: "Link failed"
};

export function mountLogin(root: HTMLElement, opts: LoginOptions): LoginController {
   const overlay = document.createElement("div");
   overlay.id = "login-overlay";

   const card = document.createElement("form");
   card.id = "login-card";
   card.setAttribute("aria-label", "Connect to DAWN");
   card.innerHTML = `
      <div class="login-brand">D.A.W.N.</div>
      <div class="login-sub">Establish uplink</div>
      <label class="login-field">
         <span>Operator</span>
         <input name="username" type="text" autocomplete="username" autocapitalize="none"
                spellcheck="false" required />
      </label>
      <label class="login-field">
         <span>Passphrase</span>
         <input name="password" type="password" autocomplete="current-password" required />
      </label>
      <button type="submit" class="login-connect">Connect</button>
      <div class="login-status" role="status"></div>
   `;
   overlay.appendChild(card);

   /* Takeover card, shown ONLY when another tab superseded this one (WS close 4001). Not the
      credential form - the user is already authenticated; they just have to choose which tab
      is live. "Use DAWN here" reclaims the session for this tab (evicting the other). */
   const takeover = document.createElement("div");
   takeover.id = "takeover-card";
   takeover.hidden = true;
   takeover.innerHTML = `
      <div class="login-brand">D.A.W.N.</div>
      <div class="login-sub">Active in another tab</div>
      <div class="takeover-msg">DAWN is open in another tab or window. Only one can be live at a time.</div>
      <button type="button" class="takeover-reclaim">Use DAWN here</button>
   `;
   overlay.appendChild(takeover);
   const reclaimBtn = takeover.querySelector<HTMLButtonElement>(".takeover-reclaim")!;
   const onReclaimClick = (): void => opts.onReclaim?.();
   reclaimBtn.addEventListener("click", onReclaimClick);
   if (!opts.onReclaim) reclaimBtn.hidden = true;

   /* The corner chip shown once linked. Click to disconnect. */
   const chip = document.createElement("button");
   chip.id = "link-chip";
   chip.type = "button";
   chip.hidden = true;
   chip.innerHTML = `<span class="link-dot"></span><span class="link-text"></span>`;

   root.append(overlay, chip);

   const username = card.querySelector<HTMLInputElement>('input[name="username"]')!;
   const password = card.querySelector<HTMLInputElement>('input[name="password"]')!;
   const connectBtn = card.querySelector<HTMLButtonElement>(".login-connect")!;
   const statusEl = card.querySelector<HTMLDivElement>(".login-status")!;
   const chipText = chip.querySelector<HTMLSpanElement>(".link-text")!;

   let busy = false;
   let manual = false; // a user-initiated login is in progress (vs silent resume)

   const onSubmit = async (e: Event): Promise<void> => {
      e.preventDefault();
      if (busy) return;
      busy = true;
      manual = true;
      connectBtn.disabled = true;
      try {
         await opts.onConnect(username.value, password.value);
      } catch {
         /* Status is driven by the ingest's onStatus; nothing to do here. */
      } finally {
         busy = false;
         connectBtn.disabled = false;
      }
   };
   card.addEventListener("submit", onSubmit);

   const onChipClick = (): void => opts.onDisconnect();
   chip.addEventListener("click", onChipClick);

   const setStatus = (status: LinkStatus, detail?: string): void => {
      const label = STATUS_TEXT[status];
      statusEl.textContent = detail ? `${label} — ${detail}` : label;
      statusEl.dataset.state = status;
      overlay.dataset.state = status;

      const linked = status === "connected";
      /* The corner chip stands for "link is up" — including the unstable "stale" state,
         which is still a live socket, just probing. It must NOT drop to the login card. */
      const chipVisible = linked || status === "stale";
      if (chipVisible) manual = false;
      /* Superseded: show the takeover card instead of the credential form (the user is
         authenticated; they only choose which tab is live). It owns the overlay in that state. */
      const takenOver = status === "superseded";
      takeover.hidden = !takenOver;
      card.hidden = takenOver;
      /* Show the card only when the user is actually needed (enter creds) or while
         a manual login is running. `checking` and a silent auto-resume's
         connecting phase keep it hidden — no blip on a successful F5 resume. */
      const needsUser = status === "idle" || status === "disconnected" || status === "error";
      const manualProgress = manual && (status === "authenticating" || status === "connecting");
      overlay.hidden = chipVisible || !(takenOver || needsUser || manualProgress);

      chip.hidden = !chipVisible;
      chip.dataset.state = status;
      chipText.textContent = label;
      if (linked) password.value = "";
   };
   setStatus("checking");

   return {
      setStatus,
      destroy: () => {
         card.removeEventListener("submit", onSubmit);
         chip.removeEventListener("click", onChipClick);
         reclaimBtn.removeEventListener("click", onReclaimClick);
         overlay.remove();
         chip.remove();
      }
   };
}
