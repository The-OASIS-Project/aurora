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
 * hesitation. Hooks (setLevels/setStrain/setHesitation) are driven live by DAWN
 * (TTS spectrum, token rate, time-to-first-token). Colors come from tokens.ts.
 * Three.js lives ONLY here.
 */

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

import { PALETTE } from "../design/tokens.ts";

/* One gimbal gauge: a comet-trail arc on a fixed tilt that spins about its normal.
   The trail (arcMat, a gradient shader) and the bright orbiting head (headMat, a solid
   glow dot) are separate materials so the head stays crisp while the trail fades. */
interface Ring {
   mesh: THREE.Mesh;
   head: THREE.Mesh;
   spin: number;
   arcMat: THREE.ShaderMaterial;
   headMat: THREE.ShaderMaterial;
   glowMat: THREE.SpriteMaterial; // the head's soft glow halo
   glow: THREE.Color; // the head's hot hue, also the color of the sparks it sheds
   angle: number; // accumulated rotation (incremental, so speed can vary)
}

/* One shed spark: a small glow point that streams off a comet head and is left behind
   in the (slowly-wobbling) assembly frame while the head orbits away, fading as it goes. */
interface Spark {
   pos: THREE.Vector3;
   vel: THREE.Vector3;
   life: number;
   maxLife: number;
   color: THREE.Color;
}
const SPARK_COUNT = 160;

/* Boot power-on ramp duration (seconds): the cold->warm cinematic cold open on load. */
const BOOT_DUR = 1.8;

const BAR_COUNT = 96;
const BAR_INNER_R = 0.86;
const BAR_BASE_H = 0.05;
const BAR_AMP_H = 0.42;

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

/* Gauge-arc trail: a partial torus restyled into a comet. The vertex shader tapers
   the tube toward the tail (scaling the tube offset about the ring centerline), and the
   fragment shader fades alpha head->tail and shifts color from a hot glow at the head to
   the cooler base along the trail. Fog chunks are kept so the far side still fades into
   depth like the rest of the reactor. uv.x is the arc parameter (0..1); uHeadAtEnd flips
   which end the head sits on so the fade always trails behind it. */
const ARC_VERT = `
uniform float uRadius;
uniform float uArcLen;
uniform float uHeadAtEnd;
uniform float uTaper;
varying float vT;
varying float vFacing;
#include <fog_pars_vertex>
void main() {
   float uarc = uv.x * uArcLen;
   vec3 C = vec3(uRadius * cos(uarc), uRadius * sin(uarc), 0.0);
   float t = mix(uv.x, 1.0 - uv.x, uHeadAtEnd); // 0 at the head, 1 at the tail tip
   vT = t;
   float taper = 1.0 - uTaper * t; // full tube at the head, a wisp at the tail
   vec3 O = position - C; // tube offset from the ring centerline (its outward normal dir)
   vec3 transformed = C + O * taper;
   vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
   /* How square-on this bit of tube faces the camera: 1 on the face pointing at us, ->0 at
      the grazing silhouette, used to fade the tail's side edges into a soft plume. */
   vFacing = abs(dot(normalize(mat3(modelViewMatrix) * O), normalize(-mvPosition.xyz)));
   gl_Position = projectionMatrix * mvPosition;
   #include <fog_vertex>
}`;

const ARC_FRAG = `
uniform vec3 uColor;
uniform vec3 uGlow;
uniform float uOpacity;
varying float vT;
varying float vFacing;
#include <fog_pars_fragment>
void main() {
   float a = pow(1.0 - vT, 1.6); // fade to nothing at the tail (no hard end cap)
   float side = pow(clamp(vFacing, 0.0, 1.0), 0.7); // fade the tube's grazing side edges
   vec3 col = mix(uGlow, uColor, smoothstep(0.0, 0.55, vT)); // hot head -> cool trail
   col *= (1.0 + (1.0 - vT) * 0.7); // extra lift right at the head
   gl_FragColor = vec4(col, a * uOpacity * (0.2 + 0.8 * side));
   #include <fog_fragment>
}`;

/* Comet-head glow: the inverse of the core's fresnel - brightest where the sphere faces
   the camera (its center) and fading to nothing at the rim, so the head reads as a soft
   glowing ball instead of a flat additive disc with a hard edge (which, lit on one side by
   the crossing tail, looked like an eclipsing moon). Reuses CORE_VERT for vN/vV. */
const HEAD_FRAG = `
uniform vec3 uColor;
uniform float uOpacity;
varying vec3 vN;
varying vec3 vV;
void main() {
   float f = abs(dot(normalize(vN), normalize(vV))); // 1 at the center, 0 at the rim
   float g = pow(f, 1.3);
   gl_FragColor = vec4(uColor * (0.55 + 0.85 * g), g * uOpacity);
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
   /* The hot end of the cool ring's comet head, the cool-ring analogue of accentGlow. */
   private cCoolGlow = new THREE.Color(PALETTE.coolGlow);
   private cAlert = new THREE.Color(PALETTE.alert);
   private scratch = new THREE.Color();

   /* Reactor state + current (eased) state params. Dedicated core colors so the
      error-hue lerp does not mutate the shared accent colors. */
   private state: ReactorState = "idle";
   private p: StateParams = { ...STATE_PARAMS.idle };
   private coreColor = new THREE.Color(PALETTE.accent);
   private coreGlow = new THREE.Color(PALETTE.accentGlow);
   private lastTime = 0;
   /* Hesitation (0..1) from DAWN's time-to-first-token, eased toward its target. It
      scales the outer ring's jitter amplitude in frame() (gated by gauge activity). */
   private hesitation = 0;
   private hesitationTarget = 0;

   /* Boot power-on ramp (the cinematic cold open). A one-shot cold->warm envelope:
      bootGain scales the reactor's light/bars/gauges up from black and the assembly up
      into place; bootSpin (computed in frame) whips the gauge heads fast then settles them
      to their normal orbit. The reactor is held fully dark (bootGain 0) until startBoot()
      is called, so the composition root can let the background nebula linger first and let
      the reactor's shaders compile behind the dark reactor before it ignites (crisp). Under
      reduced motion frame() forces bootGain to 1 (starts fully on, no ramp). */
   private bootT = 0;
   private booting = false;
   private bootGain = 0;

   /* Ambient background: a dim drifting particle field plus a few large, very
      faint haze clouds behind the reactor, in the same scene so the full-screen
      canvas has no compositing seam. */
   private nebula!: THREE.Points;
   private clouds = new THREE.Group();
   private softTex!: THREE.Texture;

   /* Comet spark field: points shed from the orbiting heads that drift and fade. Held in
      assembly space (added to the assembly) so they wobble with the whole reactor but do
      NOT orbit with a ring's fast spin - which is what leaves them behind the head. */
   private sparks: Spark[] = [];
   private sparkGeo!: THREE.BufferGeometry;
   private sparkPoints!: THREE.Points;
   private sparkPos!: Float32Array;
   private sparkCol!: Float32Array;
   private sparkNext = 0; // ring-buffer write cursor
   private sparkAccum: number[] = []; // per-ring fractional spawn accumulators (sized to rings)
   private vHead = new THREE.Vector3(); // scratch: a head's assembly-space position
   private vTmp = new THREE.Vector3(); // scratch: spawn direction

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
         /* Write depth (unlike the other additive glows) so the core OCCLUDES the parts of
            the orbiting comet trails/heads that pass behind it: additive blending alone has
            no depth sorting, so a tail behind the core would otherwise show straight through
            it. Paired with a low renderOrder so the core lays down its depth BEFORE the
            trails are tested; parts of a trail in front of the core still draw normally. */
         depthWrite: true,
         fog: false
      });
      this.core = new THREE.Mesh(new THREE.SphereGeometry(0.36, 32, 32), this.coreMat);
      this.core.renderOrder = -2; // lay depth before the heads (-1) and the trails (0)
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
         this.makeArc(1.5, 0.06, new THREE.Euler(1.15, 0.35, 0), 0.28, Math.PI * 1.35, this.cAccent, this.cAccentGlow)
      );
      this.rings.push(
         this.makeArc(1.95, 0.0525, new THREE.Euler(0.6, -0.5, 0.9), -0.16, Math.PI * 1.0, this.cCool, this.cCoolGlow)
      );
      this.createSparks();

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

   /* A gauge arc as a comet: a partial torus (thetaLength = arcLen) whose trail starts at
      the particle's full width and tapers/fades to nothing toward the tail (ARC_VERT/
      ARC_FRAG), led by a bright glowing head that orbits through depth as the ring spins.
      `headR` is the particle radius; the trail's base tube is sized to it so the tail is as
      wide as the head before it tapers. `color` is the cool trail hue, `glow` the hot head. */
   private makeArc(
      radius: number,
      headR: number,
      tilt: THREE.Euler,
      spin: number,
      arcLen: number,
      color: THREE.Color,
      glow: THREE.Color
   ): Ring {
      /* Head at the LEADING end for this spin direction, so the trail follows behind it.
         Positive spin (CCW) leads at the high-angle end; negative spin (CW) leads at 0. */
      const headAtEnd = spin >= 0;
      const tube = headR; // the comet's full base width; the nucleus sits INSIDE it
      const uniforms = THREE.UniformsUtils.merge([
         THREE.UniformsLib.fog,
         {
            uColor: { value: new THREE.Color() },
            uGlow: { value: new THREE.Color() },
            uOpacity: { value: 0.62 },
            uRadius: { value: radius },
            uArcLen: { value: arcLen },
            uHeadAtEnd: { value: headAtEnd ? 1 : 0 },
            uTaper: { value: 0.9 } // tail tube ~10% of the head's -> a fine wisp
         }
      ]);
      (uniforms.uColor.value as THREE.Color).copy(color);
      (uniforms.uGlow.value as THREE.Color).copy(glow);
      const arcMat = new THREE.ShaderMaterial({
         uniforms,
         vertexShader: ARC_VERT,
         fragmentShader: ARC_FRAG,
         transparent: true,
         blending: THREE.AdditiveBlending,
         depthWrite: false,
         fog: true
      });
      const mesh = new THREE.Mesh(
         new THREE.TorusGeometry(radius, tube, 16, 180, arcLen),
         arcMat
      );
      mesh.rotation.copy(tilt);

      /* The head is a bright ADDITIVE glow nucleus - blown-out bright so it reads as a solid
         dot, but same additive language as the trail so the two blend into ONE comet. It
         WRITES depth and renders at -1 (after the core, before the trail) so it OCCLUDES the
         part of the trail that curves behind it: without that, at orbit angles where the tail
         loops behind the head the trail bleeds over the nucleus (its "back side" showing
         through) and reads as a second item. Because the head is additive (not an opaque
         disc), its bright glow fills the region it occludes, so the tail flows out of the
         nucleus as one piece where it counts (the bright center) instead of the hard seam a
         solid disc gave either way it was layered. The soft center-bright falloff (HEAD_FRAG)
         keeps it from reading as a hard-edged disc; the faint rim still writes depth, so at
         some angles a hair of darkening can sit at the very edge - subtle at this head size. */
      const headMat = new THREE.ShaderMaterial({
         uniforms: {
            uColor: { value: glow.clone() },
            uOpacity: { value: 0.95 }
         },
         vertexShader: CORE_VERT,
         fragmentShader: HEAD_FRAG,
         transparent: true,
         blending: THREE.AdditiveBlending,
         depthWrite: true,
         fog: false
      });
      const headAngle = headAtEnd ? arcLen : 0;
      const head = new THREE.Mesh(new THREE.SphereGeometry(headR, 16, 16), headMat);
      head.position.set(Math.cos(headAngle) * radius, Math.sin(headAngle) * radius, 0);
      head.renderOrder = -1;
      mesh.add(head);

      /* A small soft additive halo behind the head for a touch of glow: a camera-facing
         sprite of the same round texture the nebula uses. depthTest on, so it's hidden when
         the head passes behind the core. */
      const glowMat = new THREE.SpriteMaterial({
         map: this.softTex,
         color: glow,
         transparent: true,
         opacity: 0.5,
         blending: THREE.AdditiveBlending,
         depthWrite: false,
         fog: false
      });
      const halo = new THREE.Sprite(glowMat);
      halo.scale.setScalar(headR * 2.6);
      head.add(halo);

      this.assembly.add(mesh);
      return { mesh, head, spin, arcMat, headMat, glowMat, glow, angle: 0 };
   }

   /* Build the shed-spark point cloud (positions/colours updated per frame). Points start
      parked far off-screen and dark until spawned. */
   private createSparks(): void {
      this.sparkPos = new Float32Array(SPARK_COUNT * 3);
      this.sparkCol = new Float32Array(SPARK_COUNT * 3);
      for (let i = 0; i < SPARK_COUNT; i++) {
         this.sparks.push({
            pos: new THREE.Vector3(0, 0, -999),
            vel: new THREE.Vector3(),
            life: 0,
            maxLife: 1,
            color: new THREE.Color()
         });
         this.sparkPos[i * 3 + 2] = -999;
      }
      this.sparkGeo = new THREE.BufferGeometry();
      this.sparkGeo.setAttribute("position", new THREE.BufferAttribute(this.sparkPos, 3));
      this.sparkGeo.setAttribute("color", new THREE.BufferAttribute(this.sparkCol, 3));
      this.sparkPoints = new THREE.Points(
         this.sparkGeo,
         new THREE.PointsMaterial({
            size: 0.0935,
            map: this.softTex,
            sizeAttenuation: true,
            vertexColors: true,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            fog: true
         })
      );
      this.sparkPoints.frustumCulled = false;
      this.assembly.add(this.sparkPoints);
      /* One spawn accumulator per ring (sized to whatever rings exist, so adding an arc
         later just works rather than silently shedding no sparks). */
      this.sparkAccum = this.rings.map(() => 0);
   }

   /* Emit one spark at `at` (assembly space): small random offset, a velocity that drifts
      outward from the reactor centre plus jitter (so it streams off the head's flank), and
      a short random life. Ring buffer, so old sparks are reused. */
   private spawnSpark(at: THREE.Vector3, color: THREE.Color): void {
      const s = this.sparks[this.sparkNext];
      this.sparkNext = (this.sparkNext + 1) % SPARK_COUNT;
      s.pos.copy(at);
      s.pos.x += (Math.random() * 2 - 1) * 0.04;
      s.pos.y += (Math.random() * 2 - 1) * 0.04;
      s.pos.z += (Math.random() * 2 - 1) * 0.04;
      this.vTmp.copy(at).setLength(0.13 + Math.random() * 0.17); // outward from centre
      s.vel.set(
         this.vTmp.x + (Math.random() * 2 - 1) * 0.16,
         this.vTmp.y + (Math.random() * 2 - 1) * 0.16,
         this.vTmp.z + (Math.random() * 2 - 1) * 0.16
      );
      s.maxLife = 1.0 + Math.random() * 1.1;
      s.life = s.maxLife;
      s.color.copy(color);
   }

   /* Advance every spark: drift, slow, and fade (colour scaled by life^2 so an additive
      point dims smoothly to nothing). Writes straight into the shared buffers. */
   private updateSparks(dt: number): void {
      for (let i = 0; i < SPARK_COUNT; i++) {
         const s = this.sparks[i];
         const j = i * 3;
         if (s.life <= 0) {
            this.sparkCol[j] = this.sparkCol[j + 1] = this.sparkCol[j + 2] = 0;
            continue;
         }
         s.life -= dt;
         s.pos.addScaledVector(s.vel, dt);
         s.vel.multiplyScalar(Math.max(0, 1 - dt * 1.6)); // ease to a drift
         const f = Math.max(0, s.life / s.maxLife);
         const b = f * (2.0 - f); // bright at birth, smooth ease-out to nothing
         this.sparkPos[j] = s.pos.x;
         this.sparkPos[j + 1] = s.pos.y;
         this.sparkPos[j + 2] = s.pos.z;
         this.sparkCol[j] = s.color.r * b;
         this.sparkCol[j + 1] = s.color.g * b;
         this.sparkCol[j + 2] = s.color.b * b;
      }
      this.sparkGeo.attributes.position.needsUpdate = true;
      this.sparkGeo.attributes.color.needsUpdate = true;
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

   /* Ignite the reactor: run the boot power-on ramp from cold. The composition root calls
      this after letting the background linger (and the shaders warm); calling it again is a
      scripted demo re-trigger (the cold open) without a full page reload. No-op under
      reduced motion (the reactor is already fully on there). */
   startBoot(): void {
      if (this.reducedMotion) return;
      this.bootT = 0;
      this.booting = true;
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
      this.hesitation += (this.hesitationTarget - this.hesitation) * k;

      /* Boot power-on: a one-shot cold->warm ramp on load. bootGain fades the core, bars,
         and gauges up from black; bootSpin whips the gauge heads fast then settles; the
         assembly scales up into place (below). Reduced motion appears fully on. */
      if (this.booting && !this.reducedMotion) {
         this.bootT = Math.min(this.bootT + dt, BOOT_DUR);
         if (this.bootT >= BOOT_DUR) this.booting = false;
      }
      const bootGain = this.reducedMotion ? 1 : easeOutCubic(this.bootT / BOOT_DUR);
      this.bootGain = bootGain;
      const bootSpin = 1 + (1 - bootGain) * 5; // 6x at ignition, settling to 1x

      /* Gauge arcs: speed and brightness rise with gauge activity (thinking). The outer
         ring carries the hesitation signal as a VELOCITY surge, not a positional wobble:
         its orbital speed swells and ebbs so the head lurches - stalls, then catches up -
         while always moving forward (the factor stays > 0), which the old angle-jitter
         broke by rocking the head backward. Depth rises with DAWN's real hesitation
         (time-to-first-token), gated by gauge activity so an idle ring stays smooth, and
         capped so the head can near-stall but never reverse. The oscillation has zero mean,
         so the average orbit rate is unchanged - only its evenness reads the signal. */
      const surgeDepth = Math.min(0.85, 1.4 * Math.max(0, this.p.gaugeGain - 0.4) * this.hesitation);
      const surge = 1 + surgeDepth * Math.sin(mt * 5); // in [0.15, 1.85]: forward-only lurch
      this.rings.forEach((r, i) => {
         const speed = r.spin * (0.7 + this.p.gaugeGain * 0.95) * (i === 1 ? surge : 1) * bootSpin;
         r.angle += dt * motion * speed;
         r.mesh.rotation.z = r.angle;
         r.arcMat.uniforms.uOpacity.value = (0.4 + this.p.gaugeGain * 0.45) * bootGain;
         r.headMat.uniforms.uOpacity.value = 0.95 * bootGain; // heads ignite with the trails
         /* Head stays opaque (a solid nucleus); only the halo glow responds to activity. */
         r.glowMat.opacity = (0.4 + this.p.gaugeGain * 0.35) * bootGain;
      });

      /* Shed comet sparks from each head (skipped under reduced motion - they are motion).
         Spawn in the head's assembly-space position so, added to the assembly, they are
         left behind as the ring spins the head onward. Rate rises a little with activity. */
      if (!this.reducedMotion) {
         this.rings.forEach((r, i) => {
            r.mesh.updateMatrix(); // refresh the local matrix from the rotation just set
            this.vHead.copy(r.head.position).applyMatrix4(r.mesh.matrix);
            this.sparkAccum[i] += dt * (14 + this.p.gaugeGain * 22) * bootGain;
            while (this.sparkAccum[i] >= 1) {
               this.sparkAccum[i] -= 1;
               this.spawnSpark(this.vHead, r.glow);
            }
         });
         this.updateSparks(dt);
      }

      this.assembly.rotation.y = Math.sin(mt * 0.11) * 0.22;
      this.assembly.rotation.x = Math.sin(mt * 0.07) * 0.1;
      this.assembly.scale.setScalar(0.72 + 0.28 * bootGain); // grows into place as it powers on

      /* Drift is a slow swirl around the VIEW axis (z) only: that keeps every
         point at a constant depth, so nothing ever rotates behind the camera and
         vanishes. Y is bounded pointer parallax, never a growing rotation. */
      this.nebula.rotation.z = mt * 0.006;
      this.nebula.rotation.y = this.parallax.x * 0.05;
      this.clouds.rotation.z = mt * -0.004;
      this.clouds.rotation.y = this.parallax.x * 0.07;

      const energy = this.updateBars(mt);
      this.barRing.rotation.z = mt * 0.05;

      /* Core: intensity from state (base + pulse) plus a little bar energy; hue
         lerps to alert red on error. */
      const breath = 0.5 + 0.5 * Math.sin(mt * 0.9);
      const pulse = 0.5 + 0.5 * Math.sin(mt * this.p.pulseRate);
      this.core.scale.setScalar((0.92 + 0.08 * breath) * (0.95 + 0.12 * energy));
      this.coreMat.uniforms.uIntensity.value =
         (this.p.coreBase + this.p.corePulse * pulse + 0.14 * energy) * bootGain;
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
      this.bars.geometry.dispose();
      (this.bars.material as THREE.Material).dispose();
      for (const r of this.rings) {
         r.mesh.geometry.dispose();
         r.head.geometry.dispose();
         r.arcMat.dispose();
         r.headMat.dispose();
         r.glowMat.dispose();
      }
      this.sparkGeo.dispose();
      (this.sparkPoints.material as THREE.Material).dispose();
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

         const h = (BAR_BASE_H + BAR_AMP_H * shimmer * this.p.barGain) * this.bootGain;
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

   /* --- Signal hooks (driven live by DAWN via the reactor sink) -------------- */

   setLevels(bins: Float32Array | null): void {
      this.levels = bins;
   }

   setStrain(load: number): void {
      const r = this.rings[0];
      if (!r) return;
      const l = clamp01(load);
      /* Redden the trail (both its cool and hot stops) and its head toward alert. */
      (r.arcMat.uniforms.uColor.value as THREE.Color).copy(this.cAccent).lerp(this.cAlert, l);
      (r.arcMat.uniforms.uGlow.value as THREE.Color).copy(this.cAccentGlow).lerp(this.cAlert, l);
      (r.headMat.uniforms.uColor.value as THREE.Color).copy(this.cAccentGlow).lerp(this.cAlert, l);
   }

   setHesitation(load: number): void {
      /* Drives the depth of the outer ring's velocity surge in frame() (a forward-only
         lurch, not a positional wobble), gated by gauge activity so a stale reading can't
         disturb an idle ring. */
      this.hesitationTarget = clamp01(load);
   }
}

function clamp01(v: number): number {
   return v < 0 ? 0 : v > 1 ? 1 : v;
}

/* Ease-out cubic on a clamped 0..1 input: fast rise settling gently into place, the
   envelope shape for the boot power-on ramp. */
function easeOutCubic(t: number): number {
   const c = clamp01(t);
   return 1 - Math.pow(1 - c, 3);
}
