// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { mountLogin } from "./login-panel.ts";

function setup() {
   const view = mountLogin(document.body, { onConnect: async () => {}, onLogout: () => {} });
   const chip = document.getElementById("link-chip")!;
   const overlay = document.getElementById("login-overlay")!;
   return { view, chip, overlay, text: () => chip.querySelector(".link-text")!.textContent };
}
afterEach(() => document.body.replaceChildren());

describe("the link chip", () => {
   it("says Disconnected while a dropped link is retried, until it's back", () => {
      const t = setup();
      t.view.setStatus("connected");
      expect(t.text()).toBe("Linked");
      t.view.setStatus("connecting", "reconnecting…");
      expect(t.chip.hidden).toBe(false);
      expect(t.text()).toBe("Disconnected");
      expect(t.chip.dataset.state).toBe("offline");
      t.view.setStatus("connecting"); // the attempt itself
      expect(t.text()).toBe("Disconnected");
      expect(t.overlay.hidden).toBe(true); // never the login card for a drop
      t.view.setStatus("connected");
      expect(t.text()).toBe("Linked");
   });

   it("shows it while a page load waits for DAWN, but never flashes it on a plain resume", () => {
      const t = setup();
      t.view.setStatus("connecting"); // F5 resuming
      expect(t.chip.hidden).toBe(true);
      t.view.setStatus("connecting", "waiting for DAWN…");
      expect(t.text()).toBe("Disconnected");
      t.view.setStatus("error", "Can't reach DAWN. Still trying…");
      expect(t.chip.hidden).toBe(true); // the card says it now
      expect(t.overlay.hidden).toBe(false);
   });
});
