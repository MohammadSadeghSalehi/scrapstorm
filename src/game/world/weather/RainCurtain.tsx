/**
 * The rain curtain: one draw call, zero triangles, zero per-frame CPU work.
 *
 * ── the shape of the cheap version ────────────────────────────────────
 *
 * The obvious implementation is N sprites, or an InstancedMesh of camera-facing
 * quads with their positions integrated on the CPU each frame. Both are wrong
 * here for the same reason the scene already has thirty `useFrame` callbacks and
 * a frame budget it has been seen to miss: rain is a background effect and it
 * must not own any part of the main thread.
 *
 * So it is a single `THREE.Points` whose vertex shader derives the fall from one
 * time uniform:
 *
 *     y = height - mod(seedY + t * fallSpeed, height)
 *
 * The attribute buffer is uploaded once. Per frame the CPU writes three floats
 * (time, and the camera's XZ so the column follows it) and issues one draw. The
 * GPU cost is fill rate on a few thousand small alpha-blended sprites, which is
 * the part that actually scales with tier, which is why the tier lever is the
 * DROP COUNT and not anything structural.
 *
 * ── why gl_PointSize and not quads ────────────────────────────────────
 *
 * A rain streak is a vertically elongated smear, and a point sprite is square.
 * The elongation is done in the FRAGMENT shader instead: `gl_PointCoord` is
 * squeezed horizontally so the lit part of the sprite is a narrow vertical bar
 * with soft ends. That is exact for near-vertical rain seen by a roughly level
 * camera, which is every frame of this game, and it costs nothing. Wind-driven
 * lean is faked by offsetting X with the same fall parameter, so the streaks
 * shear consistently with the direction the drops are travelling.
 *
 * The one thing this cannot do is rain that leans hard across the screen when
 * the camera rolls. That is a real limitation and it is worth a square sprite's
 * worth of savings.
 *
 * ── depth ─────────────────────────────────────────────────────────────
 *
 * `depthWrite: false` and `depthTest: true`. Test on, because rain must be
 * occluded by the car in front of you and by the terrain — rain drawn over a
 * hillside is the single most obvious way this reads as an overlay rather than
 * as weather. Write off, because thousands of alpha-blended fragments writing
 * depth would occlude each other in draw order.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { FRAME } from "../framePriority";
import { qualityManager } from "../quality";
import { mulberry32 } from "../scatter/placement";
import { getTunnels } from "../tunnels";
import { RAIN_BUDGET, type WeatherRainDef } from "./conditions";

const VERT = /* glsl */ `
uniform float uTime;
uniform float uHeight;
uniform float uFall;
uniform vec2  uWind;
uniform float uSize;
/*
 * The nearest tunnel bore, as an oriented box: uCoverC is (cx, roofY, cz),
 * uCoverF is the heading in XZ, uCoverE is (halfLen, halfWidth, floorY) and
 * uCoverOn is 0 when there is no bore. See world/tunnels.ts — the box is the
 * straight-line stand-in for a swept bore, which is exact enough for rain and
 * far cheaper than walking a polyline per drop.
 */
uniform vec3  uCoverC;
uniform vec2  uCoverF;
uniform vec3  uCoverE;
uniform float uCoverOn;
/** World position of the curtain's anchor, since the column follows the camera. */
uniform vec3  uAnchor;
attribute float aSeed;
attribute float aSpeed;
varying float vFade;

void main() {
  vec3 p = position;

  /*
   * Wrap in the SHADER, not on the CPU.
   *
   * aSeed spreads the phase so the column does not fall as one sheet, and
   * aSpeed gives each drop its own terminal velocity — real rain is a
   * distribution of drop sizes and a uniform fall speed reads as a screensaver.
   */
  float fall = fract(aSeed + uTime * uFall * aSpeed / uHeight);
  p.y = uHeight * (1.0 - fall) - uHeight * 0.35;
  p.xz += uWind * fall;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);

  /*
   * Fade the nearest drops out.
   *
   * A drop that passes within a metre of the camera covers a large part of the
   * screen for one frame and reads as a flash. Real rain does this too and a
   * real lens does not care, but a point sprite has no motion blur to soften it.
   */
  float d = -mv.z;
  vFade = smoothstep(1.5, 5.0, d) * (1.0 - smoothstep(0.75, 1.0, fall) * 0.85);

  /*
   * Rain does not fall inside a tunnel.
   *
   * Killed per DROP rather than by fading the whole curtain, because the
   * curtain is anchored to the camera: fading it out would also stop the rain
   * you can see through the portal ahead of you, which is the shot the tunnel
   * exists for. A drop inside the box is simply not drawn.
   */
  if (uCoverOn > 0.5) {
    vec3 w = p + uAnchor;
    vec2 rel = w.xz - uCoverC.xz;
    float along = dot(rel, uCoverF);
    float side  = dot(rel, vec2(-uCoverF.y, uCoverF.x));
    if (abs(along) < uCoverE.x && abs(side) < uCoverE.y &&
        w.y < uCoverC.y && w.y > uCoverE.z - 2.0) {
      vFade = 0.0;
    }
  }

  gl_Position = projectionMatrix * mv;
  // Attenuated, so distant rain thins out instead of tiling the sky with dots.
  gl_PointSize = uSize / max(1.0, d) * 40.0;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uAspect;
varying float vFade;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  // Squeeze X to turn a square sprite into a vertical streak. uAspect is
  // streakWidth / streakLength, so a fatter storm drop is a wider bar.
  float a = 1.0 - smoothstep(0.0, 0.5, length(vec2(c.x / max(0.04, uAspect), c.y)));
  if (a <= 0.001) discard;
  gl_FragColor = vec4(uColor, a * uOpacity * vFade);
}
`;

export function RainCurtain({ rain }: { rain: WeatherRainDef | null }) {
  const q = qualityManager.get();
  const budget = RAIN_BUDGET[q.tier];
  const count = rain ? Math.round(rain.drops * budget.dropScale) : 0;

  const geo = useMemo(() => {
    if (!rain || count <= 0) return null;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    const speed = new Float32Array(count);
    // Deterministic, for the same reason the dust motes are: two builds have to
    // be comparable frame by frame or a visual diff proves nothing.
    const rng = mulberry32(0x51ed ^ (count * 2654435761));
    for (let i = 0; i < count; i++) {
      /*
       * Uniform in a DISC, not in a square.
       *
       * sqrt on the radius is the part that is easy to get wrong: sampling r
       * linearly piles the drops into the middle, and since the column follows
       * the camera that shows up as a dense cloud sitting on the car with clear
       * air around it.
       */
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * rain.radius;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = 0;
      pos[i * 3 + 2] = Math.sin(a) * r;
      seed[i] = rng();
      speed[i] = 0.7 + rng() * 0.6;
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    g.setAttribute("aSpeed", new THREE.BufferAttribute(speed, 1));
    // The column is camera-anchored and wraps in the shader, so no bounding
    // sphere three can compute is meaningful. Culling it would blink the whole
    // curtain out whenever the camera looked away from the origin.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    return g;
  }, [rain, count]);

  const mat = useMemo(() => {
    if (!rain) return null;
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uHeight: { value: rain.height },
        uFall: { value: rain.fallSpeed },
        uWind: { value: new THREE.Vector2(rain.windX, rain.windZ) },
        uSize: { value: rain.streakLength },
        uColor: { value: new THREE.Color(rain.color) },
        uOpacity: { value: rain.opacity },
        uAspect: { value: rain.streakWidth / Math.max(0.01, rain.streakLength) },
        uCoverC: { value: new THREE.Vector3() },
        uCoverF: { value: new THREE.Vector2(1, 0) },
        uCoverE: { value: new THREE.Vector3() },
        uCoverOn: { value: 0 },
        uAnchor: { value: new THREE.Vector3() },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // Normal, not additive. Rain is grey water in front of a grey sky: adding
      // it makes a storm brighter than the overcast it is falling out of.
      blending: THREE.NormalBlending,
      fog: false,
    });
  }, [rain]);

  useEffect(
    () => () => {
      geo?.dispose();
      mat?.dispose();
    },
    [geo, mat],
  );

  const ref = useRef<THREE.Points>(null);

  useFrame((state, dt) => {
    if (!mat || !ref.current) return;
    // Real time, not sim time. Rain does not slow down for a hitstop — the
    // freeze is a camera effect and weather is not part of the impact.
    mat.uniforms.uTime.value += dt;
    ref.current.position.x = state.camera.position.x;
    ref.current.position.z = state.camera.position.z;
    ref.current.position.y = state.camera.position.y;
    (mat.uniforms.uAnchor!.value as THREE.Vector3).copy(ref.current.position);

    /*
     * Publish the NEAREST bore, not all of them.
     *
     * The curtain's radius is tens of metres and the circuits that have tunnels
     * have one apiece; carrying a list into the shader would be a uniform array
     * and a loop per drop for a case that does not exist. Picking per frame on
     * the CPU is three subtractions.
     */
    const bores = getTunnels();
    if (!bores.length) {
      mat.uniforms.uCoverOn!.value = 0;
      return;
    }
    let near = bores[0]!;
    if (bores.length > 1) {
      let best = Infinity;
      for (const t of bores) {
        const d =
          (t.box.cx - ref.current.position.x) ** 2 +
          (t.box.cz - ref.current.position.z) ** 2;
        if (d < best) {
          best = d;
          near = t;
        }
      }
    }
    mat.uniforms.uCoverOn!.value = 1;
    (mat.uniforms.uCoverC!.value as THREE.Vector3).set(
      near.box.cx,
      near.box.roofY,
      near.box.cz,
    );
    (mat.uniforms.uCoverF!.value as THREE.Vector2).set(near.box.fx, near.box.fz);
    (mat.uniforms.uCoverE!.value as THREE.Vector3).set(
      near.box.halfLen,
      near.box.halfW,
      near.box.floorY,
    );
  }, FRAME.LATE);

  if (!geo || !mat) return null;
  return <points ref={ref} geometry={geo} material={mat} frustumCulled={false} />;
}
