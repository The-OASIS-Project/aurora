/*
 * The center anchor (brief S4.4, S6): the one place real 3D earns its keep in
 * v1, because it is pure glow and geometry with no text. It holds the center as
 * the constant "JARVIS shape" and conceptually lights the panels (S3.4).
 *
 * A volumetric reinterpretation of DAWN's existing SVG ring visualizer
 * (dawn/www/js/audio/visualization.js). Two things make it read as real 3D and
 * alive rather than flat decoration:
 *
 *   - DEPTH: scene fog fades the far side of every ring and the far bars into
 *     black, and the core is a fresnel-shaded orb (rim-lit), so form is legible.
 *   - LIFE + PURPOSE: the heart is a ring of radial FFT bars rewritten every
 *     frame (idle shimmer now, voice later), and the two gimbal rings are gauge
 *     ARCS with an orbiting head, not decorative full circles.
 *
 * Signal vocabulary is kept: bar ring = voice FFT, arc rings = throughput /
 * hesitation. Hooks (setLevels/setStrain/setHesitation) are stubbed for wiring
 * to DAWN later. Colors come from tokens.ts. Three.js lives ONLY here.
 */

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

import { PALETTE, hexToRgb01 } from "../design/tokens.ts";

/* PALETTE.text as "r, g, b" (0-255) for canvas rgba() fills, derived from the token so
   the crawl text tracks a palette retune instead of drifting from a hardcoded literal. */
const TEXT_RGB = hexToRgb01(PALETTE.text)
   .map((c) => Math.round(c * 255))
   .join(", ");

/* One gimbal gauge: an arc torus on a fixed tilt that spins about its normal. */
interface Ring {
   mesh: THREE.Mesh;
   spin: number;
   material: THREE.MeshBasicMaterial;
   angle: number; // accumulated rotation (incremental, so speed can vary)
}

const BAR_COUNT = 96;
const BAR_INNER_R = 0.86;
const BAR_BASE_H = 0.05;
const BAR_AMP_H = 0.42;

/* Conversation crawl geometry. The plane is tall and tilted back so it recedes
   toward the reactor; the texture is drawn at high res so the near text is crisp.
   Tunable — placement was set by eye against the fog range and camera distance. */
const CRAWL_TEX_W = 1024;
const CRAWL_TEX_H = 1600;
const CRAWL_W = 7.2; // world width
const CRAWL_H = 11.25; // world height (keeps the texture aspect)
const CRAWL_TILT = -1.2; // radians; top tilts away from the camera
const CRAWL_Y = -1.3; // emerges from below the reactor
const CRAWL_Z = 0.6; // near edge just in front of the core

/* The reactor's conversation state (matches DAWN's state machine). Drives which
   elements are active, so the reactor always shows what DAWN is doing now. */
export type ReactorState = "idle" | "listening" | "thinking" | "speaking" | "error";

interface StateParams {
   barGain: number; // bar-ring amplitude (voice FFT energy)
   coreBase: number; // core intensity floor
   corePulse: number; // core oscillation amplitude
   pulseRate: number; // core oscillation speed
   gaugeGain: number; // gauge-arc activity (throughput/hesitation)
   hue: number; // 0 = teal, 1 = alert red (error)
}

/* Per-state targets. Eased between on transition so states breathe into each
   other. listening/speaking drive the bars; thinking drives the gauges; error
   reddens the core and quiets the rest. */
const STATE_PARAMS: Record<ReactorState, StateParams> = {
   idle: { barGain: 0.45, coreBase: 0.48, corePulse: 0.14, pulseRate: 0.9, gaugeGain: 0.3, hue: 0 },
   listening: { barGain: 1.0, coreBase: 0.8, corePulse: 0.26, pulseRate: 2.1, gaugeGain: 0.34, hue: 0 },
   thinking: { barGain: 0.3, coreBase: 0.7, corePulse: 0.58, pulseRate: 3.4, gaugeGain: 1.0, hue: 0 },
   speaking: { barGain: 1.0, coreBase: 0.92, corePulse: 0.42, pulseRate: 2.6, gaugeGain: 0.42, hue: 0 },
   error: { barGain: 0.16, coreBase: 0.46, corePulse: 0.5, pulseRate: 4.6, gaugeGain: 0.25, hue: 1 }
};

const CORE_VERT = `
varying vec3 vN;
varying vec3 vV;
void main() {
   vec4 mv = modelViewMatrix * vec4(position, 1.0);
   vV = normalize(-mv.xyz);
   vN = normalize(normalMatrix * normal);
   gl_Position = projectionMatrix * mv;
}`;

/* Fresnel: dim through the body, bright at the grazing rim, so the sphere reads
   as a glowing shell with real curvature instead of a flat disc. */
const CORE_FRAG = `
uniform vec3 uColor;
uniform vec3 uGlow;
uniform float uIntensity;
varying vec3 vN;
varying vec3 vV;
void main() {
   float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
   vec3 col = mix(uColor, uGlow, f) * (0.18 + f * 1.35) * uIntensity;
   gl_FragColor = vec4(col, 1.0);
}`;

export class Anchor {
   private renderer: THREE.WebGLRenderer;
   private scene: THREE.Scene;
   private camera: THREE.PerspectiveCamera;
   private composer: EffectComposer;
   private bloom: UnrealBloomPass;

   private assembly = new THREE.Group();
   private rings: Ring[] = [];
   private core: THREE.Mesh;
   private coreMat: THREE.ShaderMaterial;

   private barRing = new THREE.Group();
   private bars: THREE.InstancedMesh;
   private dummy = new THREE.Object3D();
   private levels: Float32Array | null = null;

   private parallaxTarget = new THREE.Vector2(0, 0);
   private parallax = new THREE.Vector2(0, 0);

   private reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

   private cAccentSoft = new THREE.Color(PALETTE.accentSoft);
   private cAccent = new THREE.Color(PALETTE.accent);
   private cAccentGlow = new THREE.Color(PALETTE.accentGlow);
   private cWarn = new THREE.Color(PALETTE.warn); // gold flare at FFT peaks
   private cCool = new THREE.Color(PALETTE.cool); // second gauge ring
   private cAlert = new THREE.Color(PALETTE.alert);
   private scratch = new THREE.Color();

   /* Reactor state + current (eased) state params. Dedicated core colors so the
      error-hue lerp does not mutate the shared accent colors. */
   private state: ReactorState = "idle";
   private p: StateParams = { ...STATE_PARAMS.idle };
   private coreColor = new THREE.Color(PALETTE.accent);
   private coreGlow = new THREE.Color(PALETTE.accentGlow);
   private lastTime = 0;

   /* Ambient background: a dim drifting particle field plus a few large, very
      faint haze clouds behind the reactor, in the same scene so the full-screen
      canvas has no compositing seam. */
   private nebula!: THREE.Points;
   private clouds = new THREE.Group();
   private softTex!: THREE.Texture;

   /* Conversation crawl: the receded conversation rendered as REAL 3D text in
      this scene, tilted back and rising toward the reactor so the core's glow and
      the scene fog dissolve it into the distance (a Star Wars crawl that lives in
      the same space as the atom, not a DOM overlay). The DOM window owns the
      readable up-close view; this owns the ambient recede. */
   private crawlPlane!: THREE.Mesh;
   private crawlCanvas!: HTMLCanvasElement;
   private crawlCtx!: CanvasRenderingContext2D;
   private crawlTex!: THREE.CanvasTexture;
   private crawlMat!: THREE.MeshBasicMaterial;
   private crawlLines: string[] = [];
   private crawlPresence = 0; // eased 0 (gone) .. 1 (fully shown)
   private crawlTarget = 0;
   private crawlScroll = 0; // slow rise while present, for life

   constructor(canvas: HTMLCanvasElement) {
      this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
      /* Clear/fog color come from the ground token so a palette pivot moves them
         too (they only happen to be black today). */
      const ground = new THREE.Color(PALETTE.ground);
      this.renderer.setClearColor(ground, 0);

      this.scene = new THREE.Scene();
      /* Depth fog: geometry farther from the camera fades toward black. With
         additive materials this dims the far side of rings and bars, which is
         what makes them read as 3D hoops rather than flat ellipses. Range brackets
         the reactor (~2-unit radius) at the camera distance below. The nebula
         opts out of fog so it stays visible at all depths. */
      this.scene.fog = new THREE.Fog(ground, 9, 16);

      this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 120);
      /* Pulled back so the reactor holds a calm centre in the full-screen canvas
         (the rest of the frame is the nebula). */
      this.camera.position.set(0, 0, 11.5);

      this.scene.add(this.assembly);
      this.createNebula();
      this.createCrawl();

      /* Core: fresnel-shaded orb. */
      this.coreMat = new THREE.ShaderMaterial({
         uniforms: {
            uColor: { value: this.coreColor },
            uGlow: { value: this.coreGlow },
            uIntensity: { value: 1 }
         },
         vertexShader: CORE_VERT,
         fragmentShader: CORE_FRAG,
         transparent: true,
         blending: THREE.AdditiveBlending,
         depthWrite: false,
         fog: false
      });
      this.core = new THREE.Mesh(new THREE.SphereGeometry(0.36, 32, 32), this.coreMat);
      this.assembly.add(this.core);

      /* Bar ring: the alive FFT element, tipped toward the viewer. */
      this.bars = new THREE.InstancedMesh(
         new THREE.BoxGeometry(1, 1, 1),
         new THREE.MeshBasicMaterial({
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false
         }),
         BAR_COUNT
      );
      this.bars.instanceColor = new THREE.InstancedBufferAttribute(
         new Float32Array(BAR_COUNT * 3),
         3
      );
      this.barRing.rotation.x = 0.32;
      this.barRing.add(this.bars);
      this.assembly.add(this.barRing);

      /* Two gimbal gauge arcs (throughput, hesitation), teal-family so they
         harmonize, each a partial ring with an orbiting head = purpose. */
      this.rings.push(
         this.makeArc(1.5, 0.03, new THREE.Euler(1.15, 0.35, 0), 0.28, Math.PI * 1.35, this.cAccent)
      );
      this.rings.push(
         this.makeArc(1.95, 0.026, new THREE.Euler(0.6, -0.5, 0.9), -0.16, Math.PI * 1.0, this.cCool)
      );

      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.2, 0.32, 0.16);
      this.composer.addPass(this.bloom);
      /* Final pass so that disabling bloom (the kill switch) still renders to
         screen; also does the correct tone-map / colour-space conversion. */
      this.composer.addPass(new OutputPass());

      if (!this.reducedMotion) {
         window.addEventListener("pointermove", this.onPointerMove);
      }
      this.resize();
   }

   /* A gauge arc: a partial torus (thetaLength = arcLen) with a small bright
      head at its leading end that orbits through depth as the ring spins. */
   private makeArc(
      radius: number,
      tube: number,
      tilt: THREE.Euler,
      spin: number,
      arcLen: number,
      color: THREE.Color
   ): Ring {
      const material = new THREE.MeshBasicMaterial({
         color,
         transparent: true,
         opacity: 0.62,
         blending: THREE.AdditiveBlending,
         depthWrite: false
      });
      const mesh = new THREE.Mesh(
         new THREE.TorusGeometry(radius, tube, 12, 120, arcLen),
         material
      );
      mesh.rotation.copy(tilt);

      /* Put the head at the LEADING end for this ring's spin direction, so the
         arc trails the particle like a comet tail rather than leading it. Positive
         spin (CCW) leads at the high-angle end; negative spin (CW) leads at 0. */
      const headAngle = spin >= 0 ? arcLen : 0;
      const head = new THREE.Mesh(new THREE.SphereGeometry(tube * 2.8, 12, 12), material);
      head.position.set(Math.cos(headAngle) * radius, Math.sin(headAngle) * radius, 0);
      mesh.add(head);

      this.assembly.add(mesh);
      return { mesh, spin, material, angle: 0 };
   }

   private onPointerMove = (e: PointerEvent): void => {
      this.parallaxTarget.set(
         (e.clientX / window.innerWidth) * 2 - 1,
         (e.clientY / window.innerHeight) * 2 - 1
      );
   };

   /* A soft round radial-gradient texture (generated, no asset) so points read as
      glows not squares and clouds read as soft haze. */
   private makeSoftTexture(): THREE.Texture {
      const s = 64;
      const cv = document.createElement("canvas");
      cv.width = cv.height = s;
      const ctx = cv.getContext("2d")!;
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.4, "rgba(255,255,255,0.35)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
      return new THREE.CanvasTexture(cv);
   }

   /* Build the background: a dim drifting particle field (soft glows) plus a few
      large, very faint haze clouds, so the frame reads as living space, not void.
      Additive + a touch of bloom gives it atmosphere. */
   private createNebula(): void {
      this.softTex = this.makeSoftTexture();
      const hues = [this.cAccent, this.cCool, new THREE.Color(0x2a3b55)];

      const N = 1400;
      const pos = new Float32Array(N * 3);
      const col = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
         pos[i * 3] = (Math.random() * 2 - 1) * 64;
         pos[i * 3 + 1] = (Math.random() * 2 - 1) * 40;
         pos[i * 3 + 2] = -6 - Math.random() * 46;
         const c = hues[Math.random() < 0.16 ? 0 : Math.random() < 0.5 ? 1 : 2];
         const b = 0.1 + Math.random() * 0.34; // dim, but the stars still register
         col[i * 3] = c.r * b;
         col[i * 3 + 1] = c.g * b;
         col[i * 3 + 2] = c.b * b;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      this.nebula = new THREE.Points(
         geo,
         new THREE.PointsMaterial({
            size: 0.5,
            map: this.softTex,
            sizeAttenuation: true,
            vertexColors: true,
            transparent: true,
            opacity: 0.9,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            fog: false
         })
      );
      /* Never cull: the field rotates, and a stale bounding sphere was making the
         whole cloud vanish once it swung past the frustum test. */
      this.nebula.frustumCulled = false;
      this.scene.add(this.nebula);

      /* Haze clouds: big, VERY dim additive sprites drifting behind everything.
         Dark, desaturated hues with complementary variation (deep teal + indigo
         plus muted violet/rose) so the void has colour without competing with the
         teal-and-gold foreground. */
      const tints = [
         new THREE.Color(0x2c7068), // muted teal
         new THREE.Color(0x303e86), // muted indigo
         new THREE.Color(0x4a3078), // muted violet
         new THREE.Color(0x6a3a58) // dusty rose (complement side)
      ];
      for (let i = 0; i < 9; i++) {
         const sprite = new THREE.Sprite(
            new THREE.SpriteMaterial({
               map: this.softTex,
               color: tints[i % tints.length],
               transparent: true,
               opacity: 0.05 + Math.random() * 0.045,
               blending: THREE.AdditiveBlending,
               depthWrite: false,
               fog: false
            })
         );
         sprite.position.set(
            (Math.random() * 2 - 1) * 34,
            (Math.random() * 2 - 1) * 20,
            -12 - Math.random() * 28
         );
         const sc = 14 + Math.random() * 22;
         sprite.scale.set(sc, sc, 1);
         sprite.frustumCulled = false;
         this.clouds.add(sprite);
      }
      this.scene.add(this.clouds);
   }

   /* Build the crawl surface: a tall plane tilted back so its far (upper) edge
      recedes toward and past the reactor. A CanvasTexture carries the text; the
      scene fog (fog:true) fades the far edge to black for the "into the distance"
      dissolve, and the additive core glowing in front washes whatever passes
      behind it. Normal (non-additive) blending keeps the near text legible. */
   private createCrawl(): void {
      this.crawlCanvas = document.createElement("canvas");
      this.crawlCanvas.width = CRAWL_TEX_W;
      this.crawlCanvas.height = CRAWL_TEX_H;
      this.crawlCtx = this.crawlCanvas.getContext("2d")!;
      this.crawlTex = new THREE.CanvasTexture(this.crawlCanvas);
      this.crawlTex.colorSpace = THREE.SRGBColorSpace;

      this.crawlMat = new THREE.MeshBasicMaterial({
         map: this.crawlTex,
         transparent: true,
         opacity: 0,
         depthWrite: false,
         fog: true
      });
      this.crawlPlane = new THREE.Mesh(
         new THREE.PlaneGeometry(CRAWL_W, CRAWL_H),
         this.crawlMat
      );
      this.crawlPlane.rotation.x = CRAWL_TILT;
      this.crawlPlane.position.set(0, CRAWL_Y, CRAWL_Z);
      this.crawlPlane.visible = false;
      this.crawlPlane.renderOrder = -1; // behind the additive reactor parts
      this.scene.add(this.crawlPlane);
   }

   /* Redraw the crawl canvas: wrapped lines stacked from the BOTTOM (latest
      nearest the camera), older lines climbing toward the fogged distance. */
   private drawCrawl(): void {
      const ctx = this.crawlCtx;
      const W = CRAWL_TEX_W;
      const H = CRAWL_TEX_H;
      ctx.clearRect(0, 0, W, H);
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      const pad = 64;
      const fontPx = 30;
      const lineH = fontPx * 1.4;
      ctx.font = `500 ${fontPx}px "IBM Plex Sans", system-ui, sans-serif`;

      /* Wrap every line to the canvas width, newest last, then draw bottom-up. */
      const wrapped: string[] = [];
      for (const line of this.crawlLines) {
         for (const w of this.wrapText(line, W - pad * 2)) wrapped.push(w);
      }
      let y = H - pad;
      for (let i = wrapped.length - 1; i >= 0 && y > pad; i--) {
         /* Alpha falls off going up (into the distance) as a second cue on top of
            fog, so the top never looks like a hard cut. */
         const depth = (H - pad - y) / (H - pad * 2);
         ctx.fillStyle = `rgba(${TEXT_RGB}, ${(1 - depth * 0.55).toFixed(3)})`;
         ctx.fillText(wrapped[i], W / 2, y);
         y -= lineH;
      }
      this.crawlTex.needsUpdate = true;
   }

   private wrapText(text: string, maxW: number): string[] {
      const words = text.split(/\s+/);
      const lines: string[] = [];
      let cur = "";
      for (const word of words) {
         const test = cur ? `${cur} ${word}` : word;
         if (this.crawlCtx.measureText(test).width > maxW && cur) {
            lines.push(cur);
            cur = word;
         } else {
            cur = test;
         }
      }
      if (cur) lines.push(cur);
      return lines;
   }

   /* Set the crawl's content (the receding conversation). */
   setCrawl(lines: string[]): void {
      this.crawlLines = lines;
      this.drawCrawl();
   }

   /* Target crawl visibility: 1 to raise it into the scene, 0 to dissolve it. */
   setCrawlPresence(target: number): void {
      this.crawlTarget = clamp01(target);
   }

   resize(): void {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      this.renderer.setPixelRatio(dpr);
      this.renderer.setSize(w, h, false);
      this.composer.setPixelRatio(dpr);
      this.composer.setSize(w, h);
      this.bloom.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
   }

   /* Set the reactor's conversation state (idle/listening/thinking/speaking/
      error). Params ease toward the new state so transitions breathe. */
   setState(state: ReactorState): void {
      this.state = state;
   }

   /* Display kill switches (menu / profiling). Bloom is the real GPU cost; the
      star field and clouds are cheap but exposed for comparison. */
   setStarfield(on: boolean): void {
      this.nebula.visible = on;
   }
   setClouds(on: boolean): void {
      this.clouds.visible = on;
   }
   setBloom(on: boolean): void {
      this.bloom.enabled = on;
   }

   frame(time: number): void {
      const dt = Math.min(Math.max(time - this.lastTime, 0), 0.05);
      this.lastTime = time;
      /* Reduced motion: freeze to a static representative frame. `motion` gates
         accumulation and `mt` (frozen at 0) gates every time-based oscillation,
         so nothing animates rather than merely slowing. */
      const motion = this.reducedMotion ? 0 : 1;
      const mt = this.reducedMotion ? 0 : time;

      /* Ease current params toward the active state's targets. */
      const tp = STATE_PARAMS[this.state];
      const k = this.reducedMotion ? 1 : 1 - Math.exp(-2.6 * dt);
      this.p.barGain += (tp.barGain - this.p.barGain) * k;
      this.p.coreBase += (tp.coreBase - this.p.coreBase) * k;
      this.p.corePulse += (tp.corePulse - this.p.corePulse) * k;
      this.p.pulseRate += (tp.pulseRate - this.p.pulseRate) * k;
      this.p.gaugeGain += (tp.gaugeGain - this.p.gaugeGain) * k;
      this.p.hue += (tp.hue - this.p.hue) * k;

      /* Gauge arcs: speed and brightness rise with gauge activity (thinking);
         the outer ring gets a hesitation jitter. Incremental so speed can vary
         without the angle jumping. */
      const jitter = Math.sin(mt * 17) * 0.05 * Math.max(0, this.p.gaugeGain - 0.4);
      this.rings.forEach((r, i) => {
         r.angle += dt * motion * r.spin * (0.7 + this.p.gaugeGain * 0.95);
         r.mesh.rotation.z = r.angle + (i === 1 ? jitter : 0);
         r.material.opacity = 0.4 + this.p.gaugeGain * 0.45;
      });

      this.assembly.rotation.y = Math.sin(mt * 0.11) * 0.22;
      this.assembly.rotation.x = Math.sin(mt * 0.07) * 0.1;

      /* Drift is a slow swirl around the VIEW axis (z) only: that keeps every
         point at a constant depth, so nothing ever rotates behind the camera and
         vanishes. Y is bounded pointer parallax, never a growing rotation. */
      this.nebula.rotation.z = mt * 0.006;
      this.nebula.rotation.y = this.parallax.x * 0.05;
      this.clouds.rotation.z = mt * -0.004;
      this.clouds.rotation.y = this.parallax.x * 0.07;

      /* Crawl: ease presence toward its target; while present, drift slowly up
         so the text rises into the fogged distance. Opacity is shaped so it lingers
         readable near full presence, then dissolves quickly toward the end. */
      this.crawlPresence += (this.crawlTarget - this.crawlPresence) * (1 - Math.exp(-2.2 * dt));
      const shown = this.crawlPresence > 0.004;
      this.crawlPlane.visible = shown;
      if (shown) {
         this.crawlMat.opacity = Math.pow(this.crawlPresence, 0.7) * 0.66;
         this.crawlScroll += dt * motion * 0.12 * this.crawlTarget;
         this.crawlPlane.position.y = CRAWL_Y + this.crawlScroll;
      } else if (this.crawlScroll !== 0) {
         this.crawlScroll = 0;
         this.crawlPlane.position.y = CRAWL_Y;
      }

      const energy = this.updateBars(mt);
      this.barRing.rotation.z = mt * 0.05;

      /* Core: intensity from state (base + pulse) plus a little bar energy; hue
         lerps to alert red on error. */
      const breath = 0.5 + 0.5 * Math.sin(mt * 0.9);
      const pulse = 0.5 + 0.5 * Math.sin(mt * this.p.pulseRate);
      this.core.scale.setScalar((0.92 + 0.08 * breath) * (0.95 + 0.12 * energy));
      this.coreMat.uniforms.uIntensity.value =
         this.p.coreBase + this.p.corePulse * pulse + 0.14 * energy;
      this.coreColor.copy(this.cAccent).lerp(this.cAlert, this.p.hue);
      this.coreGlow.copy(this.cAccentGlow).lerp(this.cAlert, this.p.hue);

      if (!this.reducedMotion) {
         this.parallax.lerp(this.parallaxTarget, 0.05);
         this.assembly.rotation.y += this.parallax.x * 0.25;
         this.assembly.rotation.x += this.parallax.y * 0.18;
      }

      this.composer.render();
   }

   /* Free GPU resources and listeners (HMR / teardown). */
   dispose(): void {
      window.removeEventListener("pointermove", this.onPointerMove);
      this.core.geometry.dispose();
      this.coreMat.dispose();
      this.nebula.geometry.dispose();
      (this.nebula.material as THREE.Material).dispose();
      for (const s of this.clouds.children) {
         (s as THREE.Sprite).material.dispose();
      }
      this.softTex.dispose();
      this.crawlPlane.geometry.dispose();
      this.crawlMat.dispose();
      this.crawlTex.dispose();
      this.bars.geometry.dispose();
      (this.bars.material as THREE.Material).dispose();
      for (const r of this.rings) {
         r.mesh.geometry.dispose();
         r.material.dispose();
      }
      this.composer.dispose();
      this.renderer.dispose();
   }

   private updateBars(t: number): number {
      const slot = (Math.PI * 2) / BAR_COUNT;
      const barW = slot * BAR_INNER_R * 0.5;
      let sum = 0;

      for (let i = 0; i < BAR_COUNT; i++) {
         const a = i * slot;
         let shimmer: number;
         if (this.levels) {
            shimmer = this.levels[i % this.levels.length] ?? 0;
         } else {
            const s1 = 0.5 + 0.5 * Math.sin(t * 2.3 + i * 0.55);
            const s2 = 0.5 + 0.5 * Math.sin(t * 1.4 - i * 0.37 + 1.3);
            const s3 = 0.5 + 0.5 * Math.sin(t * 3.1 + i * 0.9);
            const band = Math.pow(0.5 + 0.5 * Math.sin(t * 1.1 - a * 3), 6);
            shimmer = clamp01((0.35 * s1 + 0.35 * s2 + 0.3 * s3) * 0.8 + band * 0.6);
         }
         sum += shimmer;

         const h = BAR_BASE_H + BAR_AMP_H * shimmer * this.p.barGain;
         const r = BAR_INNER_R + h / 2;
         this.dummy.position.set(Math.cos(a) * r, Math.sin(a) * r, 0);
         this.dummy.rotation.set(0, 0, a - Math.PI / 2);
         this.dummy.scale.set(barW, h, 0.03);
         this.dummy.updateMatrix();
         this.bars.setMatrixAt(i, this.dummy.matrix);

         /* FFT gradient: dim teal base -> cyan mids -> gold flare at the peaks. */
         this.scratch.copy(this.cAccentSoft).lerp(this.cAccent, shimmer);
         this.scratch.lerp(this.cAccentGlow, shimmer * shimmer);
         this.scratch.lerp(this.cWarn, Math.pow(shimmer, 4) * 0.75);
         this.bars.setColorAt(i, this.scratch);
      }
      this.bars.instanceMatrix.needsUpdate = true;
      if (this.bars.instanceColor) this.bars.instanceColor.needsUpdate = true;
      return sum / BAR_COUNT;
   }

   /* --- Signal hooks (stubbed in v1, wired to DAWN later) -------------------- */

   setLevels(bins: Float32Array | null): void {
      this.levels = bins;
   }

   setStrain(load: number): void {
      const c = this.rings[0]?.material.color;
      if (c) c.copy(this.cAccent).lerp(this.cAlert, clamp01(load));
   }

   setHesitation(_load: number): void {
      /* TODO(dawn-wire): apply jitter amplitude to the outer ring. */
   }
}

function clamp01(v: number): number {
   return v < 0 ? 0 : v > 1 ? 1 : v;
}
