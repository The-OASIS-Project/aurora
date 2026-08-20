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
      /* Show the card only when the user is actually needed (enter creds) or while
         a manual login is running. `checking` and a silent auto-resume's
         connecting phase keep it hidden — no blip on a successful F5 resume. */
      const needsUser = status === "idle" || status === "disconnected" || status === "error";
      const manualProgress = manual && (status === "authenticating" || status === "connecting");
      overlay.hidden = chipVisible || !(needsUser || manualProgress);

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
         overlay.remove();
         chip.remove();
      }
   };
}
