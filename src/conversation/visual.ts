/*
 * Model-generated visuals. The assistant wraps diagrams/charts in a custom
 * `<dawn-visual title="..." type="svg|html">...</dawn-visual>` tag inline in its reply
 * text (verified against DAWN: webui_server.c sends the full tool result when it contains
 * the tag). This module extracts those blocks and renders each in a SANDBOXED srcdoc
 * iframe.
 *
 * Security: the visual body is untrusted LLM-authored code (an SVG, or HTML that may run
 * Chart.js). It renders in `sandbox="allow-scripts"` WITHOUT allow-same-origin, so it gets
 * a fresh opaque origin and cannot touch this page's DOM, cookies, or storage. It talks to
 * us only through postMessage, and we validate the source window before acting. This is the
 * same isolation the old WebUI uses; do not add allow-same-origin.
 *
 * Theme: the model's code references CSS custom properties (--color-*) and a library of
 * prebuilt classes (.box, .arr, .c-teal, ...). We inject both, mapping DAWN's palette onto
 * Aurora's design tokens so a generated visual adopts the phosphor look.
 */

export interface VisualBlock {
   title: string;
   type: "svg" | "html";
   code: string;
}

export type VisualSegment =
   | { kind: "text"; content: string }
   | { kind: "visual"; visual: VisualBlock };

/* One <dawn-visual> block. Title is attribute-quoted (no nested quotes), type is svg|html,
   body is everything up to the close tag (non-greedy so runs of visuals split cleanly). */
const VISUAL_TAG_RE =
   /<dawn-visual\s+title="([^"]*)"\s+type="(svg|html)">([\s\S]*?)<\/dawn-visual>/g;

/* Does this text contain a visual tag (complete or a streaming-incomplete opener)? */
export function hasVisual(text: string): boolean {
   return text.indexOf("<dawn-visual") !== -1;
}

/* Split a message into ordered text / visual segments for inline placement. */
export function splitVisualSegments(text: string): VisualSegment[] {
   if (!hasVisual(text)) return [{ kind: "text", content: text }];
   const segments: VisualSegment[] = [];
   let last = 0;
   let m: RegExpExecArray | null;
   VISUAL_TAG_RE.lastIndex = 0;
   while ((m = VISUAL_TAG_RE.exec(text)) !== null) {
      const before = text.slice(last, m.index);
      if (before.trim()) segments.push({ kind: "text", content: before });
      segments.push({ kind: "visual", visual: { title: m[1], type: m[2] as "svg" | "html", code: m[3].trim() } });
      last = m.index + m[0].length;
   }
   const after = text.slice(last);
   if (after.trim()) segments.push({ kind: "text", content: after });
   return segments;
}

/* For the streaming render: drop any visual tag (complete, or an unterminated opener from a
   mid-stream break) so raw XML never flashes in the bubble. The real iframes are built once
   the reply finalizes. */
export function stripVisualsForStreaming(text: string): string {
   return text.replace(VISUAL_TAG_RE, "").replace(/<dawn-visual[\s\S]*$/, "").trim();
}

/* --- theme injected into every iframe -------------------------------------- */

let themeCache: string | null = null;
let classCache: string | null = null;

/* Map Aurora's design tokens onto the --color-* vars the model's code expects. Read live so
   it follows a token change. */
function buildThemeCss(): string {
   const s = getComputedStyle(document.documentElement);
   const v = (name: string): string => s.getPropertyValue(name).trim();
   const ground = v("--ground") || "#05070a";
   const raise = v("--ground-raise") || "#0b1016";
   return [
      ":root {",
      `  --color-bg-primary: ${ground};`,
      `  --color-bg-secondary: ${raise};`,
      `  --color-bg-tertiary: ${raise};`,
      `  --color-text-primary: ${v("--text")};`,
      `  --color-text-secondary: ${v("--text-dim")};`,
      `  --color-text-tertiary: ${v("--text-faint")};`,
      `  --color-border: ${v("--accent-soft")};`,
      `  --color-border-light: ${v("--accent-soft")};`,
      `  --color-accent: ${v("--accent")};`,
      "  --border-radius-md: 6px;",
      "  --border-radius-lg: 10px;",
      '  --font-sans: "IBM Plex Sans", system-ui, sans-serif;',
      `  --font-mono: ${v("--font-mono") || '"IBM Plex Mono", monospace'};`,
      "}",
      "body { font-family: var(--font-sans); color: var(--color-text-primary); background: transparent; margin: 0; padding: 0; }"
   ].join("\n");
}

/* The prebuilt class library the model draws against (DAWN's visual guidelines). Aurora is
   always dark, so only the dark ramp variant is emitted. */
function buildVisualClasses(): string {
   const ramps: Record<string, [string, string, string, string]> = {
      purple: ["#EEEDFE", "#AFA9EC", "#534AB7", "#3C3489"],
      teal: ["#E1F5EE", "#5DCAA5", "#0F6E56", "#085041"],
      coral: ["#FAECE7", "#F0997B", "#993C1D", "#712B13"],
      pink: ["#FBEAF0", "#ED93B1", "#993556", "#72243E"],
      gray: ["#F1EFE8", "#B4B2A9", "#5F5E5A", "#444441"],
      blue: ["#E6F1FB", "#85B7EB", "#185FA5", "#0C447C"],
      green: ["#EAF3DE", "#97C459", "#3B6D11", "#27500A"],
      amber: ["#FAEEDA", "#EF9F27", "#854F0B", "#633806"],
      red: ["#FCEBEB", "#F09595", "#A32D2D", "#791F1F"]
   };
   let ramp = "";
   for (const [name, r] of Object.entries(ramps)) {
      const sel = `.c-${name}`;
      /* Dark: 800 fill, 200 stroke, light text. */
      ramp +=
         `${sel} rect, ${sel} ellipse, ${sel} circle, ${sel} polygon, ${sel} path:not([fill="none"]) { fill: ${r[3]}; stroke: ${r[1]}; }\n` +
         `${sel} text, ${sel} .th, ${sel} .t { fill: #f0f0f0; }\n` +
         `${sel} .ts { fill: #ccc; }\n`;
   }
   return (
      ".t { font-family: var(--font-sans); font-size: 14px; fill: var(--color-text-primary); }\n" +
      ".ts { font-family: var(--font-sans); font-size: 12px; fill: var(--color-text-secondary); }\n" +
      ".th { font-family: var(--font-sans); font-size: 14px; font-weight: 500; fill: var(--color-text-primary); }\n" +
      ".box { fill: var(--color-bg-secondary); stroke: var(--color-border); stroke-width: 0.5; }\n" +
      ".arr { stroke: var(--color-text-secondary); stroke-width: 1.5; fill: none; }\n" +
      ".node { cursor: pointer; }\n" +
      ".node:hover { opacity: 0.85; }\n" +
      ramp
   );
}

function themeCss(): string {
   if (!themeCache) themeCache = buildThemeCss();
   return themeCache;
}
function visualClasses(): string {
   if (!classCache) classCache = buildVisualClasses();
   return classCache;
}

/* Read the aspect ratio from an SVG viewBox, for an initial iframe height before the resize
   bridge refines it. */
function parseViewBox(code: string): { width: number; height: number } | null {
   /* Quote-agnostic: the model now prefers single-quoted attributes (its code rides inside a
      JSON string, so single quotes avoid escaping). */
   const m = code.match(/viewBox\s*=\s*(["'])([^"']*)\1/);
   if (!m) return null;
   const p = m[2].trim().split(/\s+/);
   if (p.length >= 4) return { width: parseFloat(p[2]), height: parseFloat(p[3]) };
   return null;
}

/* --- the cross-iframe bridge (one delegated listener) ---------------------- */

const knownWindows = new WeakSet<Window>();
const resizeMap = new Map<Window, { iframe: HTMLIFrameElement; lastH: number }>();
const vendorCache = new Map<string, string>();

/* The script injected into each iframe: a sendPrompt() the model's onclick handlers call,
   and a debounced ResizeObserver that reports body height up to us. */
const BRIDGE_SCRIPT =
   "<scr" +
   "ipt>\n" +
   'function sendPrompt(t){parent.postMessage({type:"dawn_prompt",text:t},"*")}\n' +
   "var _lastH=0,_tid=0;\n" +
   "new ResizeObserver(function(){clearTimeout(_tid);_tid=setTimeout(function(){" +
   'var h=document.body.scrollHeight;if(h!==_lastH){_lastH=h;parent.postMessage({type:"dawn_visual_resize",height:h},"*")}},100)}).observe(document.body);\n' +
   "</scr" +
   "ipt>\n";

/* First in every visual's <head>: the model-written code runs scripts (sandboxed, opaque origin)
   but must never reach the network, or an injected instruction could beacon data out (a remote
   image, fetch(), new Image()). Vendor code is inlined, so nothing legitimate needs a remote load.
   CSP only ever tightens: a meta the model writes later can't loosen this one. */
const VISUAL_CSP =
   '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; ' +
   "style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'\">";

/* Runs before the model's code: WebRTC isn't governed by CSP, and a STUN server name can carry data
   out in a DNS lookup, so the constructors are removed (charts and drawings never need them). This
   narrows the channel (a nested srcdoc frame could still bring a fresh copy: a residual risk, noted in
   EMAIL_PANEL_DESIGN 4.7). */
const VISUAL_PRELUDE =
   "<scr" +
   "ipt>try{delete window.RTCPeerConnection;delete window.webkitRTCPeerConnection;" +
   "window.RTCPeerConnection=undefined;window.webkitRTCPeerConnection=undefined}catch(e){}</scr" +
   "ipt>";

/* Replace <script src="/js/vendor/X"> with the inlined vendor code (a sandboxed srcdoc
   iframe has no base URL, so it can't load external scripts). Fetched once, cached, and
   </script>-escaped so the vendor body can't close the tag early.

   Quote-agnostic (single OR double): the model reaches for single-quoted HTML attributes to
   avoid escaping inside render_visual's JSON, so a "-only match would silently skip inlining
   and leave a dead external <script> - blanking the chart. (Mirrors DAWN's visual-render.js.) */
async function inlineVendor(content: string): Promise<string> {
   const tags = content.match(/<script\s+src=(["'])(\/js\/vendor\/[^"']+)\1\s*>\s*<\/script>/gi);
   if (!tags) return content;
   let out = content;
   for (const tag of tags) {
      const src = tag.match(/src=(["'])([^"']+)\1/)?.[2];
      if (!src) continue;
      /* The src is model-generated (reachable by prompt injection): resolve it and require it to
         stay under /js/vendor/ after normalization, so "/js/vendor/../../api/images/<id>" can't
         pull the user's data into the visual's sandbox. Fetched WITHOUT cookies - the vendor
         scripts are public static files. */
      let path = "";
      try {
         path = new URL(src, window.location.origin).pathname;
      } catch {
         path = "";
      }
      if (!path.startsWith("/js/vendor/") || src.includes("\\")) {
         out = out.replace(tag, "");
         continue;
      }
      let code = vendorCache.get(path);
      if (code === undefined) {
         try {
            const res = await fetch(path, { credentials: "omit" });
            code = res.ok ? (await res.text()).replace(/<\/script/gi, "<\\/script") : "";
         } catch {
            code = ""; // vendor unavailable: drop the tag, the visual degrades rather than hangs
         }
         vendorCache.set(path, code);
      }
      out = out.replace(tag, "<scr" + "ipt>" + code + "</scr" + "ipt>");
   }
   return out;
}

function triggerDownload(v: VisualBlock): void {
   const ext = v.type === "svg" ? "svg" : "html";
   const mime = v.type === "svg" ? "image/svg+xml" : "text/html";
   let body: string;
   if (v.type === "svg") {
      /* Inline the theme + classes as a <defs><style> so the saved file renders
         standalone, add the xmlns + a ground-colored backdrop. */
      const style = `<defs><style>${themeCss()}${visualClasses()}</style></defs>`;
      body = v.code.replace(/(<svg[^>]*>)/, `$1\n${style}`);
      if (body.indexOf("xmlns=") === -1) body = body.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ');
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--ground").trim() || "#05070a";
      body = body.replace(/(<\/defs>\s*)/, `$1<rect width="100%" height="100%" fill="${bg}"/>\n`);
   } else {
      body = `<!DOCTYPE html><html><head><style>${themeCss()}${visualClasses()}</style></head><body>${v.code}</body></html>`;
   }
   const url = URL.createObjectURL(new Blob([body], { type: mime }));
   const a = document.createElement("a");
   a.href = url;
   a.download = `${(v.title || "visual").replace(/[^A-Za-z0-9._() -]+/g, "_")}.${ext}`;
   document.body.appendChild(a);
   a.click();
   a.remove();
   window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/* Build the container (download button + sandboxed iframe) for one visual. */
export function createVisualFrame(v: VisualBlock): HTMLElement {
   const container = document.createElement("div");
   container.className = "convo-visual";
   container.setAttribute("data-visual-title", v.title); // title is DAWN text; attribute, not HTML

   const dl = document.createElement("button");
   dl.type = "button";
   dl.className = "convo-visual-download";
   dl.title = `Download ${v.type === "svg" ? "SVG" : "HTML"}`;
   dl.setAttribute("aria-label", "Download visual");
   dl.textContent = "↓";
   dl.addEventListener("click", () => triggerDownload(v));
   container.appendChild(dl);

   const iframe = document.createElement("iframe");
   iframe.sandbox.add("allow-scripts"); // NO allow-same-origin: opaque origin, no page access
   iframe.title = `Visual: ${v.title}`;
   iframe.className = "convo-visual-frame";

   let content: string;
   if (v.type === "svg") {
      content =
         "<!DOCTYPE html><html><head>" +
         VISUAL_CSP +
         VISUAL_PRELUDE +
         "<style>" +
         themeCss() +
         visualClasses() +
         "body{margin:0;padding:0;overflow:hidden}svg{display:block;width:100%;height:auto}" +
         "</style></head><body>\n" +
         BRIDGE_SCRIPT +
         v.code +
         "</body></html>";
      const vb = parseViewBox(v.code);
      iframe.style.height =
         vb && vb.width > 0 ? `${Math.min(Math.ceil((vb.height / vb.width) * 680), vb.height, 800)}px` : "400px";
   } else {
      /* Chart.js sizing: a responsive chart locks to the canvas's default 300x150 ratio at
         construction, so wrap the canvas in a definite-height box and flip the chart to
         maintainAspectRatio:false at runtime (mirrors the old WebUI's fix). */
      const isChart = v.code.indexOf("<canvas") !== -1 && /\bnew\s+Chart\s*\(/.test(v.code);
      let canvasCss = "";
      let chartFix = "";
      let code = v.code;
      if (isChart) {
         const maxH = code.match(/max-height\s*:\s*(\d+)px/i);
         const boxH = maxH ? Math.min(parseInt(maxH[1], 10), 380) : 380;
         canvasCss =
            "html,body{height:100%}body{margin:0;padding:0;overflow:hidden}" +
            `.dawn-chart-box{position:relative;width:100%;height:${boxH}px}` +
            ".dawn-chart-box>canvas{display:block!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;margin:0!important}";
         code = code.replace(/(<canvas\b[^>]*>\s*<\/canvas>)/gi, '<div class="dawn-chart-box">$1</div>');
         chartFix =
            "<scr" +
            "ipt>\nfunction _dawnFill(){if(!window.Chart)return;var m=Chart.instances||{};" +
            "Object.keys(m).forEach(function(k){var c=m[k];try{c.options.maintainAspectRatio=false;c.options.responsive=true;c.resize()}catch(e){}})}\n" +
            "requestAnimationFrame(function(){requestAnimationFrame(_dawnFill)});setTimeout(_dawnFill,1100);\n" +
            "</scr" +
            "ipt>\n";
      }
      content =
         "<!DOCTYPE html><html><head>" +
         VISUAL_CSP +
         VISUAL_PRELUDE +
         "<style>" +
         themeCss() +
         visualClasses() +
         canvasCss +
         "</style></head><body>\n" +
         BRIDGE_SCRIPT +
         code +
         chartFix +
         "</body></html>";
      iframe.style.height = "400px";
   }

   /* Vendor scripts (Chart.js) must be inlined; fetch may be async, so attach the frame now
      and set srcdoc once ready. */
   void inlineVendor(content).then((resolved) => {
      iframe.srcdoc = resolved;
   });
   container.appendChild(iframe);

   /* The srcdoc loads once. A later load means the visual's own code navigated the frame (the
      page's frame-src should already have refused it): drop the frame, never keep what it went to. */
   let srcdocLoads = 0;
   iframe.addEventListener("load", () => {
      if (!iframe.getAttribute("srcdoc")) return; // the initial about:blank, before srcdoc is set
      if (++srcdocLoads > 1) {
         if (iframe.contentWindow) {
            knownWindows.delete(iframe.contentWindow);
            resizeMap.delete(iframe.contentWindow);
         }
         const note = document.createElement("div");
         note.className = "convo-visual-blocked";
         note.textContent = "This visual tried to leave its frame and was closed.";
         iframe.replaceWith(note);
         return;
      }
      if (iframe.contentWindow) {
         knownWindows.add(iframe.contentWindow);
         resizeMap.set(iframe.contentWindow, { iframe, lastH: 0 });
      }
   });
   return container;
}

/* Install the one delegated message listener (resize + sendPrompt) and a theme-change cache
   invalidator. Returns a disposer. `onPrompt` receives a node's click-to-prompt text. */
/* A visual's prompt longer than this is cut (DAWN's WebUI uses the same cap). */
export const VISUAL_PROMPT_MAX = 2000;
/* At most one visual prompt per this window (about a gesture's activation lifetime). */
export const VISUAL_PROMPT_GAP_MS = 5000;

/* Whether the page has a recent user gesture. A missing API counts as none. */
function recentGesture(): boolean {
   const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
   return !!ua && ua.isActive;
}

/* The text to send for a visual's prompt, or null to send nothing (no recent gesture, or empty). */
export function visualPromptText(raw: string, gesture: boolean): string | null {
   const text = raw.trim();
   return text && gesture ? text.slice(0, VISUAL_PROMPT_MAX) : null;
}

export function initVisuals(onPrompt: (text: string) => void): () => void {
   const onMessage = (e: MessageEvent): void => {
      const d = e.data as { type?: string; text?: string; height?: number } | null;
      if (!d || !e.source) return;
      const src = e.source as Window;
      if (d.type === "dawn_prompt" && typeof d.text === "string" && knownWindows.has(src)) {
         /* A visual is model-written, so its prompt is not the person speaking: the host sends it
            as its own turn marked from_visual (DAWN lets no confirm count in that turn). Only after
            a recent gesture, so a script running on load sends nothing; that is a first filter
            only (a click anywhere on the page counts), from_visual is the real control. */
         const text = visualPromptText(d.text, recentGesture());
         if (text !== null) onPrompt(text);
      } else if (d.type === "dawn_visual_resize") {
         const entry = resizeMap.get(src);
         if (entry && typeof d.height === "number" && d.height > 0 && d.height !== entry.lastH) {
            entry.lastH = d.height;
            entry.iframe.style.height = `${d.height}px`;
         }
      }
   };
   window.addEventListener("message", onMessage);

   /* A palette/theme swap invalidates the cached CSS so the next visual rebuilds. Existing
      iframes keep their baked-in theme until re-rendered - acceptable, matches the WebUI. */
   const observer = new MutationObserver(() => {
      themeCache = null;
      classCache = null;
   });
   observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });

   return () => {
      window.removeEventListener("message", onMessage);
      observer.disconnect();
      resizeMap.clear();
   };
}
