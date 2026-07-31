/**
 * The VFX scene: one component that steps every pool, runs every continuous
 * emitter, drives the mesh deformers, and draws the lot.
 *
 * Mounted ONCE from GameScene (see the integration note at the bottom of this
 * file). Everything else in the subsystem is a module, so nothing outside this
 * component needs to know the pools exist.
 *
 * -------------------------------------------------------- DRAW CALL BUDGET
 *   6  particle layers  (SMOKE, FIRE, SPARK, ARC, FLUID, SHIMMER)
 *   1  shockwave rings
 *   3  landscape damage (craters, decals, settled scatter)
 *   ------------------------------------------------------------------------
 *   10 draw calls at high tier, ~3600 triangles at absolute saturation.
 *   Low tier drops ARC + SHIMMER (they never spawn) and the shockwave mesh is
 *   still mounted but empty, so it is 8 calls with far lower caps.
 *
 * Per-frame CPU is one strided pass over 308 particle slots plus one pass over
 * the vehicle and projectile lists. No allocation anywhere in the frame path:
 * every Vector3/Matrix4/Color below is module- or ref-scoped scratch.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { GameSimulation } from "../../sim";
import type { VehicleState, WorldPropState } from "../../types";
import { getGroundHeight } from "../../track";
import { FRAME } from "../framePriority";
import { qualityManager, type QualityTier } from "../quality";
import { softSmokeTexture } from "../softSprite";
import { spawnDebrisBurst } from "../debris";
import {
  VFX_FLAG,
  VFX_LAYER,
  VFX_LAYER_COUNT,
  VFX_STRIDE,
  VFX_F,
  resetVfx,
  setFluidLandHandler,
  setVfxTier,
  stepVfx,
  vfxActive,
  vfxBoostJet,
  vfxData,
  vfxElectricArc,
  vfxExplosion,
  vfxFlags,
  vfxFluidSpray,
  vfxHeatShimmer,
  vfxLayerCap,
  vfxLayerStart,
  vfxLiveTotal,
  vfxOffroadDust,
  vfxProjectileTrail,
  vfxSmokeColumn,
  vfxTyreSmoke,
} from "./particles";
import {
  SHOCKWAVE_MAX,
  resetShockwaves,
  shockwaveLive,
  shockwavePool,
  spawnShockwave,
  stepShockwaves,
} from "./shockwave";
import {
  arcTexture,
  dropletTexture,
  emberTexture,
  fireTexture,
  shimmerTexture,
  shockRingTexture,
} from "./sprites";
import { hashString, vfxSeed } from "./rng";
import { addInstanceAlphaAttribute, attachInstanceAlpha } from "./instanceAlpha";
import { LandscapeDamage } from "../damage/LandscapeDamage";
import {
  addCrater,
  addGouge,
  addOilStain,
  addScorch,
  resetLandscapeDamage,
  stepLandscapeDamage,
} from "../damage/landscape";
import {
  flushVehicleDeformers,
  resetVehicleDeformers,
  syncVehicleDents,
} from "../damage/meshDeform";

/* --------------------------------------------------------------- scratch */

const _pos = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _mat = new THREE.Matrix4();

/**
 * The colour a dying particle is driven toward.
 *
 * Not black. When the per-instance alpha patch is active this only softens the
 * last frames; when it is not (see instanceAlpha.ts) it is the ONLY thing
 * standing between a dissipating puff and a dark blob, because the fade has to
 * be expressed through colour. Matching the scene's warm haze means a puff that
 * has run out of alpha has also run out of contrast.
 */
const HAZE = new THREE.Color(0.78, 0.7, 0.6);

/* ------------------------------------------------------------- emitters */

interface EmitState {
  tyre: number;
  dust: number;
  smoke: number;
  arc: number;
  oil: number;
  boost: number;
  /** Metres driven off-road since the last gouge was laid. */
  gouge: number;
  lastX: number;
  lastZ: number;
  wrecked: boolean;
  groundY: number;
  groundFrame: number;
}

function newEmitState(): EmitState {
  return {
    tyre: 0,
    dust: 0,
    smoke: 0,
    arc: 0,
    oil: 0,
    boost: 0,
    gouge: 0,
    lastX: 0,
    lastZ: 0,
    wrecked: false,
    groundY: 0,
    groundFrame: -1,
  };
}

/**
 * Continuous emitters run on an accumulator, not a probability.
 *
 * A `Math.random() < rate * dt` gate produces a Poisson stream whose gaps are
 * visible at low rates — tyre smoke would come out in clumps and holes. An
 * accumulator emits at a genuinely constant spatial rate, which is what makes a
 * drift leave a continuous ribbon instead of a dotted line.
 */
function tick(state: number, rate: number, dt: number): { next: number; fire: number } {
  const acc = state + rate * dt;
  const fire = Math.floor(acc);
  // Cap at 3 per frame: after a hitch, replaying two seconds of accumulated
  // tyre smoke in one frame is both a spike and a visible blob.
  return { next: acc - fire, fire: fire > 3 ? 3 : fire };
}

/* ---------------------------------------------------------- alpha curves */

function alphaCurve(layer: number, f: number, clock: number, phase: number): number {
  switch (layer) {
    case VFX_LAYER.SMOKE:
      // Fast in, very slow out — smoke's whole job is to outlast the event.
      return Math.min(1, (1 - f) * 9) * Math.pow(f, 0.62);
    case VFX_LAYER.FIRE:
      // Instant on, square-root out: combustion is brightest at birth and its
      // perceived brightness falls faster than its physical extent.
      return Math.min(1, (1 - f) * 24) * Math.sqrt(f);
    case VFX_LAYER.SPARK:
      // Linear, with a flicker. A spark that fades smoothly reads as an LED.
      return f * (0.72 + 0.28 * Math.sin(clock * 47 + phase * 11));
    case VFX_LAYER.ARC:
      // Hard on, hard off, strobing in between — an arc is a series of
      // discharges, not a glowing wire.
      return (f > 0.55 ? 1 : f * 1.8) * (0.55 + 0.45 * Math.sin(clock * 90 + phase * 23));
    case VFX_LAYER.FLUID:
      return Math.min(1, f * 3.5);
    default:
      // SHIMMER: ease in and out, never fully present.
      return Math.sin(Math.PI * (1 - f));
  }
}

/* ------------------------------------------------------------ component */

interface LayerSpec {
  layer: number;
  key: string;
  map: THREE.Texture;
  additive: boolean;
  opacity: number;
  renderOrder: number;
  toneMapped: boolean;
}

/** Two lights maximum, and the count is FIXED for the component's lifetime. */
const EXPLOSION_LIGHTS = 2;

interface LightSlot {
  x: number;
  y: number;
  z: number;
  life: number;
  maxLife: number;
  peak: number;
  color: THREE.Color;
}

export function VfxScene({ sim }: { sim: GameSimulation }) {
  const layerRefs = useRef<(THREE.InstancedMesh | null)[]>([]);
  const alphaAttrs = useRef<(THREE.InstancedBufferAttribute | null)[]>([]);
  const shockRef = useRef<THREE.InstancedMesh | null>(null);
  const lightRefs = useRef<(THREE.PointLight | null)[]>([]);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);
  const playerPos = useRef(new THREE.Vector3());
  const emitters = useRef(new Map<string, EmitState>());
  const deadProps = useRef(new WeakSet<WorldPropState>());
  const epoch = useRef(-1);
  const clock = useRef(0);
  const frame = useRef(0);

  /**
   * Light count is decided ONCE, from the tier at mount, and never changes.
   *
   * Adding or removing a light rewrites `numPointLights` and forces three to
   * recompile every lit material in the scene. This project has been burned by
   * exactly that (see the CSM post-mortem in GameScene): a mid-race recompile
   * storm is far more expensive than the two lights themselves.
   */
  const lightCount = useMemo(() => {
    const t = qualityManager.get().tier;
    return t === "high" ? EXPLOSION_LIGHTS : t === "medium" ? 1 : 0;
  }, []);

  // Sized to the MOUNTED light count, not to the maximum: a slot with no light
  // behind it would silently swallow a flash request that the other slot could
  // have rendered.
  const lights = useMemo<LightSlot[]>(
    () =>
      Array.from({ length: lightCount }, () => ({
        x: 0,
        y: -100,
        z: 0,
        life: 0,
        maxLife: 1,
        peak: 0,
        color: new THREE.Color(1, 0.72, 0.4),
      })),
    [lightCount],
  );

  const specs = useMemo<LayerSpec[]>(
    () => [
      {
        layer: VFX_LAYER.SMOKE,
        key: "smoke",
        map: softSmokeTexture(128),
        additive: false,
        opacity: 0.62,
        renderOrder: 2,
        toneMapped: true,
      },
      {
        layer: VFX_LAYER.FIRE,
        key: "fire",
        map: fireTexture(128),
        additive: true,
        // Tone-mapped on purpose. Additive fire at toneMapped:false blew past
        // the bloom threshold and wrapped everything nearby in a white halo —
        // the same failure the ember sprite was retuned for.
        opacity: 0.85,
        renderOrder: 4,
        toneMapped: true,
      },
      {
        layer: VFX_LAYER.SPARK,
        key: "spark",
        map: emberTexture(64),
        additive: true,
        opacity: 0.75,
        renderOrder: 5,
        toneMapped: true,
      },
      {
        layer: VFX_LAYER.ARC,
        key: "arc",
        map: arcTexture(128, 32),
        additive: true,
        // The one layer that IS allowed past tone mapping: an arc is a
        // millisecond-scale discharge, it is meant to clip, and there are never
        // more than a handful on screen.
        opacity: 0.9,
        renderOrder: 6,
        toneMapped: false,
      },
      {
        layer: VFX_LAYER.FLUID,
        key: "fluid",
        map: dropletTexture(64),
        additive: false,
        opacity: 0.9,
        renderOrder: 3,
        toneMapped: true,
      },
      {
        layer: VFX_LAYER.SHIMMER,
        key: "shimmer",
        map: shimmerTexture(64),
        additive: false,
        opacity: 0.5,
        renderOrder: 7,
        toneMapped: true,
      },
    ],
    [],
  );

  const geos = useMemo(
    () =>
      specs.map(() => {
        const g = new THREE.PlaneGeometry(1, 1);
        // The colour attribute is required for `vertexColors` to actually
        // multiply instanceColor in this build of three; without it the generic
        // attribute resolves to (0,0,0) and every particle renders black.
        const n = g.getAttribute("position").count;
        g.setAttribute(
          "color",
          new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3),
        );
        return g;
      }),
    [specs],
  );

  const mats = useMemo(
    () =>
      specs.map((s) => {
        const m = new THREE.MeshBasicMaterial({
          map: s.map,
          transparent: true,
          opacity: s.opacity,
          depthWrite: false,
          vertexColors: true,
          blending: s.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
          side: THREE.DoubleSide,
          toneMapped: s.toneMapped,
          // A small alphaTest kills the near-empty fringe of every quad, which
          // is pure overdraw on a system whose only real cost is overdraw.
          alphaTest: s.additive ? 0.04 : 0.02,
        });
        attachInstanceAlpha(m);
        return m;
      }),
    [specs],
  );

  const shockGeo = useMemo(() => {
    const g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const n = g.getAttribute("position").count;
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    return g;
  }, []);

  const shockMat = useMemo(() => {
    const m = new THREE.MeshBasicMaterial({
      map: shockRingTexture(128),
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: true,
      alphaTest: 0.02,
    });
    attachInstanceAlpha(m);
    return m;
  }, []);

  useEffect(() => {
    const ownedGeos = geos;
    const ownedMats = mats;
    const sg = shockGeo;
    const sm = shockMat;
    return () => {
      for (const g of ownedGeos) g.dispose();
      for (const m of ownedMats) m.dispose();
      sg.dispose();
      sm.dispose();
    };
  }, [geos, mats, shockGeo, shockMat]);

  /** Oil that lands leaves a stain. Wired here so particles.ts stays pure. */
  useEffect(() => {
    setFluidLandHandler((x, _y, z, size) => {
      addOilStain(x, z, 0.25 + size * 3.2, vfxSeed(x, 0, z));
    });
    return () => setFluidLandHandler(null);
  }, []);

  useEffect(
    () => () => {
      resetVfx();
      resetShockwaves();
      resetVehicleDeformers();
    },
    [],
  );

  /* ------------------------------------------------------------- driver */

  useFrame(({ camera }, dt) => {
    const state = sim.state;
    const tier = qualityManager.get().tier;
    setVfxTier(tier);
    frame.current++;

    // A rebuilt field reuses the same vehicle ids, so every piece of per-id
    // state here — emitter accumulators, deformer bindings, wreck flags — has
    // to go with it, or the new race inherits the old one's damage.
    if (sim.worldEpoch !== epoch.current) {
      epoch.current = sim.worldEpoch;
      emitters.current.clear();
      deadProps.current = new WeakSet<WorldPropState>();
      resetVfx();
      resetShockwaves();
      resetLandscapeDamage();
      resetVehicleDeformers();
      for (const l of lights) l.life = 0;
    }

    const step = dt > 0.06 ? 0.06 : dt;
    clock.current += step;
    const now = clock.current;

    const player = state.vehicles.find((v) => v.isPlayer);
    if (player) playerPos.current.set(player.x, player.y, player.z);
    const px = playerPos.current.x;
    const pz = playerPos.current.z;

    const racing =
      state.phase === "racing" || state.phase === "countdown" || state.phase === "paused";

    if (racing) {
      emitVehicleFx(state.vehicles, emitters.current, step, frame.current, tier);
      emitProjectileTrails(state.projectiles, step, tier);
      emitPropDeaths(state.props as WorldPropState[], deadProps.current, tier, lights);
      emitWrecks(state.vehicles, emitters.current, tier, lights);
      driveDeformers(state.vehicles, now, tier);
    }

    stepVfx(step);
    stepShockwaves(step);
    stepLandscapeDamage(step);
    stepLights(lights, step);

    writeParticles(
      camera,
      layerRefs.current,
      alphaAttrs.current,
      dummy,
      color,
      tier,
      px,
      pz,
    );
    writeShockwaves(shockRef.current, dummy, color);
    writeLights(lightRefs.current, lights, lightCount);

    if (typeof window !== "undefined" && frame.current % 30 === 0) {
      window.__vfxDebug = {
        particles: vfxLiveTotal(),
        shockwaves: shockwaveLive(),
        tier,
      };
    }
  }, FRAME.LATE);

  return (
    <group>
      {specs.map((s, i) => (
        <instancedMesh
          key={s.key}
          ref={(m) => {
            const mesh = m as THREE.InstancedMesh | null;
            layerRefs.current[s.layer] = mesh;
            if (mesh && !alphaAttrs.current[s.layer]) {
              alphaAttrs.current[s.layer] = addInstanceAlphaAttribute(
                mesh.geometry,
                vfxLayerCap(s.layer),
              );
            }
          }}
          args={[geos[i]!, mats[i]!, vfxLayerCap(s.layer)]}
          frustumCulled={false}
          renderOrder={s.renderOrder}
        />
      ))}
      <instancedMesh
        ref={(m) => {
          const mesh = m as THREE.InstancedMesh | null;
          shockRef.current = mesh;
          if (mesh && !mesh.geometry.getAttribute("aAlpha")) {
            addInstanceAlphaAttribute(mesh.geometry, SHOCKWAVE_MAX);
          }
        }}
        args={[shockGeo, shockMat, SHOCKWAVE_MAX]}
        frustumCulled={false}
        renderOrder={4}
      />
      {Array.from({ length: lightCount }, (_, i) => (
        <pointLight
          key={`blast-light-${i}`}
          ref={(l) => {
            lightRefs.current[i] = l as THREE.PointLight | null;
          }}
          position={[0, -100, 0]}
          intensity={0}
          distance={22}
          decay={2}
          castShadow={false}
        />
      ))}
      <LandscapeDamage playerRef={playerPos} />
    </group>
  );
}

/* --------------------------------------------------------- emitter logic */

function groundFor(v: VehicleState, s: EmitState, frameNo: number): number {
  // One terrain query per vehicle per frame, shared by every emitter on it.
  // getGroundHeight runs a nearest-sample search, and tyre smoke alone would
  // otherwise call it twenty times a second per car.
  if (s.groundFrame !== frameNo) {
    s.groundFrame = frameNo;
    s.groundY = getGroundHeight(v.x, v.z);
  }
  return s.groundY;
}

function emitVehicleFx(
  vehicles: VehicleState[],
  states: Map<string, EmitState>,
  dt: number,
  frameNo: number,
  tier: QualityTier,
): void {
  const rateScale = tier === "low" ? 0.4 : tier === "medium" ? 0.7 : 1;

  for (const v of vehicles) {
    if (!v.alive) continue;
    let s = states.get(v.id);
    if (!s) {
      s = newEmitState();
      s.lastX = v.x;
      s.lastZ = v.z;
      states.set(v.id, s);
    }

    const speed = Math.abs(v.speed);
    const moved = Math.hypot(v.x - s.lastX, v.z - s.lastZ);
    s.lastX = v.x;
    s.lastZ = v.z;

    const seedBase = hashString(v.id);

    // --- tyre smoke: only on grippy surfaces. Rubber has to be able to BURN
    //     against something, and sliding across sand just moves the sand.
    if (v.wreckTimer <= 0 && v.offroadAmount < 0.3 && speed > 11) {
      const slip = Math.abs(v.lateral) / Math.max(8, speed + 2);
      const load = Math.min(1, Math.max(v.driftMeter * 1.4, (slip - 0.22) * 2.4));
      if (load > 0.05) {
        const r = tick(s.tyre, 16 * load * rateScale, dt);
        s.tyre = r.next;
        if (r.fire > 0) {
          const gy = groundFor(v, s, frameNo);
          const fx = -Math.sin(v.yaw);
          const fz = -Math.cos(v.yaw);
          const rx = Math.cos(v.yaw);
          const rz = -Math.sin(v.yaw);
          for (let i = 0; i < r.fire; i++) {
            const side = i % 2 === 0 ? 1 : -1;
            vfxTyreSmoke(
              v.x - fx * 1.15 + rx * side * 0.82,
              gy + 0.12,
              v.z - fz * 1.15 + rz * side * 0.82,
              v.speed * fx,
              v.speed * fz,
              load,
              gy,
              seedBase ^ (frameNo * 2654435761) ^ (i << 8),
            );
          }
        }
      }
    }

    // --- off-road dust
    if (v.wreckTimer <= 0 && v.offroadAmount > 0.22 && speed > 6) {
      const amt = Math.min(1, v.offroadAmount * (0.4 + speed / 40));
      const r = tick(s.dust, 20 * amt * rateScale, dt);
      s.dust = r.next;
      if (r.fire > 0) {
        const gy = groundFor(v, s, frameNo);
        const fx = -Math.sin(v.yaw);
        const fz = -Math.cos(v.yaw);
        const rx = Math.cos(v.yaw);
        const rz = -Math.sin(v.yaw);
        for (let i = 0; i < r.fire; i++) {
          const side = i % 2 === 0 ? 1 : -1;
          vfxOffroadDust(
            v.x - fx * 1.3 + rx * side * 0.9,
            gy,
            v.z - fz * 1.3 + rz * side * 0.9,
            v.speed * fx,
            v.speed * fz,
            amt,
            gy,
            seedBase ^ (frameNo * 40503) ^ (i << 12),
          );
        }
      }

      // --- gouges: laid by DISTANCE, not by time, so a car ploughing at 30m/s
      //     leaves the same trail density as one at 15.
      if (v.offroadAmount > 0.42 && speed > 15) {
        s.gouge += moved;
        if (s.gouge > 6.5) {
          s.gouge = 0;
          const seed = vfxSeed(v.x, 0, v.z);
          addGouge(v.x, v.z, 3.4 + speed * 0.06, 0.5 + v.offroadAmount * 0.5, v.yaw, seed);
        }
      }
    } else {
      s.gouge = 0;
    }

    // --- boost exhaust. Emitted rather than drawn as a fixed sphere so the
    //     plume trails behind the car instead of being welded to it, and so the
    //     flicker is real variation rather than a sine wave on one mesh.
    if (v.boostTimer > 0.05 && v.wreckTimer <= 0) {
      const r = tick(s.boost, 30 * rateScale, dt);
      s.boost = r.next;
      if (r.fire > 0) {
        const fx = -Math.sin(v.yaw);
        const fz = -Math.cos(v.yaw);
        const ex = v.x - fx * 1.55;
        const ez = v.z - fz * 1.55;
        const ey = v.y + 0.38;
        for (let i = 0; i < r.fire; i++) {
          // The exhaust is thrown BACKWARD in world terms even though the car
          // is moving forward faster than the plume — that velocity difference
          // is what makes a boost read as thrust rather than as a sticker.
          vfxBoostJet(ex, ey, ez, fx, fz, v.speed, seedBase ^ (frameNo * 69069) ^ i);
        }
      }
    }

    // --- damage column, arcing, oil. All three key off damageVisual but at
    //     different thresholds, so a car degrades through visibly distinct
    //     stages instead of switching on one composite "damaged" look.
    const dmg = v.damageVisual;
    if (dmg > 0.3 && v.wreckTimer <= 0) {
      const r = tick(s.smoke, (2 + dmg * 9) * rateScale, dt);
      s.smoke = r.next;
      for (let i = 0; i < r.fire; i++) {
        const fx = -Math.sin(v.yaw);
        const fz = -Math.cos(v.yaw);
        vfxSmokeColumn(
          v.x - fx * 0.6,
          v.y + 0.75,
          v.z - fz * 0.6,
          dmg,
          seedBase ^ (frameNo * 22695477) ^ (i << 4),
        );
      }
    }
    if (dmg > 0.55 && tier !== "low" && v.wreckTimer <= 0) {
      const r = tick(s.arc, (dmg - 0.5) * 5 * rateScale, dt);
      s.arc = r.next;
      if (r.fire > 0) {
        const rx = Math.cos(v.yaw);
        const rz = -Math.sin(v.yaw);
        const side = (frameNo & 1) === 0 ? 1 : -1;
        vfxElectricArc(
          v.x + rx * side * 0.7,
          v.y + 0.55,
          v.z + rz * side * 0.7,
          0.55 + dmg * 0.5,
          seedBase ^ (frameNo * 374761393),
        );
      }
    }
    if (dmg > 0.68 && v.wreckTimer <= 0) {
      const r = tick(s.oil, (dmg - 0.65) * 6 * rateScale, dt);
      s.oil = r.next;
      if (r.fire > 0) {
        const gy = groundFor(v, s, frameNo);
        const fx = -Math.sin(v.yaw);
        const fz = -Math.cos(v.yaw);
        vfxFluidSpray(
          v.x - fx * 1.4,
          v.y + 0.28,
          v.z - fz * 1.4,
          v.speed * fx * 0.25,
          0.4,
          v.speed * fz * 0.25,
          // Coolant while the hull is merely hurt, oil once it is failing.
          dmg > 0.82 ? "oil" : "coolant",
          gy,
          seedBase ^ (frameNo * 668265263),
        );
      }
    }
  }
}

function emitProjectileTrails(
  projectiles: { id: string; kind: string; x: number; y: number; z: number; vx: number; vy: number; vz: number }[],
  dt: number,
  tier: QualityTier,
): void {
  if (tier === "low") return;
  // Stateless gate: projectiles are created and destroyed constantly, and a
  // per-id accumulator map would churn entries at the exact moment (a firefight)
  // when allocation matters most. A trail is short enough that Poisson gaps do
  // not read.
  const rate = tier === "medium" ? 26 : 44;
  const p = Math.min(0.9, rate * dt);
  for (const pr of projectiles) {
    if (Math.random() > p) continue;
    vfxProjectileTrail(
      pr.kind as "bolt" | "cannon" | "disc",
      pr.x,
      pr.y,
      pr.z,
      pr.vx,
      pr.vy,
      pr.vz,
      hashString(pr.id) ^ ((pr.x * 977) | 0),
    );
  }
}

function requestLight(
  lights: LightSlot[],
  x: number,
  y: number,
  z: number,
  peak: number,
  life: number,
  r: number,
  g: number,
  b: number,
): void {
  // Empty on low tier — no lights are mounted, so there is nothing to request.
  if (lights.length === 0) return;
  let slot = lights[0]!;
  for (let i = 1; i < lights.length; i++) {
    if (lights[i]!.life < slot.life) slot = lights[i]!;
  }
  // Never steal a brighter, younger flash for a dimmer one.
  if (slot.life > 0 && slot.peak > peak * 1.4) return;
  slot.x = x;
  slot.y = y;
  slot.z = z;
  slot.peak = peak;
  slot.maxLife = life;
  slot.life = life;
  slot.color.setRGB(r, g, b);
}

function emitPropDeaths(
  props: WorldPropState[],
  seen: WeakSet<WorldPropState>,
  tier: QualityTier,
  lights: LightSlot[],
): void {
  for (const p of props) {
    if (!p.dead || seen.has(p)) continue;
    seen.add(p);

    const scale = p.scale || 1;
    const seed = vfxSeed(p.x, p.y, p.z);
    const gy = getGroundHeight(p.x, p.z);
    const dirLen = Math.hypot(p.vx, p.vz) || 1;
    const dx = p.vx / dirLen;
    const dz = p.vz / dirLen;

    if (p.kind === "barrel") {
      vfxExplosion(p.x, p.y + 0.5, p.z, {
        kind: "barrel",
        radius: 2.1 * scale,
        energy: 1.1,
        groundY: gy,
        dirX: dx,
        dirZ: dz,
        seed,
      });
      spawnShockwave(p.x, gy, p.z, 2.4 * scale, dx, dz, seed);
      addCrater(p.x, p.z, 1.9 * scale, 0.42, seed);
      addScorch(p.x, p.z, 2.6 * scale, seed);
      spawnDebrisBurst("ejecta", p.x, p.y, p.z, dx, dz, 1.1, gy, 1.2 * scale);
      requestLight(lights, p.x, p.y + 1.2, p.z, 26 * scale, 0.42, 1, 0.62, 0.26);
      if (tier === "high") vfxHeatShimmer(p.x, p.y + 1, p.z, 2.4 * scale, 1.4, seed);
    } else {
      // Crates and scrap do not detonate — they burst into dust and splinters.
      vfxExplosion(p.x, p.y + 0.3, p.z, {
        kind: "small",
        radius: 1.2 * scale,
        energy: 0.6,
        groundY: gy,
        dirX: dx,
        dirZ: dz,
        seed,
      });
      addScorch(p.x, p.z, 0.9 * scale, seed);
    }
  }
}

function emitWrecks(
  vehicles: VehicleState[],
  states: Map<string, EmitState>,
  tier: QualityTier,
  lights: LightSlot[],
): void {
  for (const v of vehicles) {
    let s = states.get(v.id);
    if (!s) {
      s = newEmitState();
      s.lastX = v.x;
      s.lastZ = v.z;
      states.set(v.id, s);
    }
    const wrecked = v.wreckTimer > 0;
    if (wrecked === s.wrecked) continue;
    s.wrecked = wrecked;
    if (!wrecked) continue;

    const seed = vfxSeed(v.x, v.y, v.z);
    const gy = getGroundHeight(v.x, v.z);
    const fx = -Math.sin(v.yaw);
    const fz = -Math.cos(v.yaw);
    vfxExplosion(v.x, v.y + 0.7, v.z, {
      kind: "wreck",
      radius: 2.6,
      energy: 1.3,
      groundY: gy,
      dirX: fx,
      dirZ: fz,
      seed,
    });
    spawnShockwave(v.x, gy, v.z, 3.2, fx, fz, seed);
    addScorch(v.x, v.z, 3.4, seed);
    addCrater(v.x, v.z, 2.2, 0.34, seed);
    // Bodywork comes off along the direction of travel, not radially — a car
    // that stops dead sheds its panels forward.
    spawnDebrisBurst("panel", v.x, v.y + 0.4, v.z, fx, fz, 1.2, gy, 1.4);
    requestLight(lights, v.x, v.y + 1.4, v.z, 30, 0.5, 1, 0.55, 0.2);
    if (tier === "high") vfxHeatShimmer(v.x, v.y + 1.2, v.z, 3, 2.6, seed);
  }
}

function driveDeformers(vehicles: VehicleState[], now: number, tier: QualityTier): void {
  for (const v of vehicles) {
    // Every car accumulates hits, on screen or not — the REBUILD is what is
    // budgeted, not the record of the damage. An AI car that spent the lap
    // being shot at should arrive at the next corner already crumpled, not
    // start crumpling the moment you look at it.
    syncVehicleDents(v.id, v.dentFront, v.dentLeft, v.dentRight, v.dentRear);
  }
  flushVehicleDeformers({
    now,
    // A dent that lands 120ms after the impact is indistinguishable from one
    // that lands on the frame of it, and coalescing means a burst of four hits
    // costs one rebuild rather than four.
    minInterval: tier === "low" ? 0.4 : 0.12,
    // Skipping the normal pass on low tier keeps the silhouette (which is the
    // point) and drops the expensive half.
    recomputeNormals: tier !== "low",
    maxPerFrame: tier === "high" ? 2 : 1,
  });
}

function stepLights(lights: LightSlot[], dt: number): void {
  for (const l of lights) {
    if (l.life > 0) l.life = Math.max(0, l.life - dt);
  }
}

/* ------------------------------------------------------------- rendering */

function writeLights(
  refs: (THREE.PointLight | null)[],
  lights: LightSlot[],
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    const ref = refs[i];
    const l = lights[i];
    if (!ref || !l) continue;
    if (l.life <= 0) {
      if (ref.intensity !== 0) ref.intensity = 0;
      continue;
    }
    const f = l.life / l.maxLife;
    // Quartic: a blast light is essentially a spike. A linear falloff reads as
    // someone turning a lamp down.
    ref.intensity = l.peak * f * f * f * f;
    ref.position.set(l.x, l.y, l.z);
    ref.color.copy(l.color);
  }
}

function writeShockwaves(
  mesh: THREE.InstancedMesh | null,
  dummy: THREE.Object3D,
  color: THREE.Color,
): void {
  if (!mesh) return;
  const alphaAttr = mesh.geometry.getAttribute("aAlpha") as
    | THREE.InstancedBufferAttribute
    | undefined;
  const alphaArr = alphaAttr?.array as Float32Array | undefined;
  let n = 0;
  if (shockwaveLive() > 0) {
    const pool = shockwavePool();
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i]!;
      if (!s.active) continue;
      const f = s.life / s.maxLife;
      const t = 1 - f;
      // Ease-out expansion: the wave is fastest at the instant of the blast.
      const r = s.r0 + (s.r1 - s.r0) * (1 - (1 - t) * (1 - t));
      const a = s.alpha * f * f;
      dummy.position.set(s.x, s.y, s.z);
      dummy.rotation.set(0, Math.atan2(s.dirX, s.dirZ), 0);
      dummy.scale.set(r * 2, 1, r * 2 * s.aniso);
      dummy.updateMatrix();
      mesh.setMatrixAt(n, dummy.matrix);
      color.setRGB(s.r, s.g, s.b).multiplyScalar(0.5 + a * 0.5);
      mesh.setColorAt(n, color);
      if (alphaArr) alphaArr[n] = a;
      n++;
    }
  }
  dummy.position.set(0, -900, 0);
  dummy.rotation.set(0, 0, 0);
  dummy.scale.setScalar(0.0001);
  dummy.updateMatrix();
  for (let i = n; i < SHOCKWAVE_MAX; i++) {
    mesh.setMatrixAt(i, dummy.matrix);
    if (alphaArr) alphaArr[i] = 0;
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  if (alphaAttr) alphaAttr.needsUpdate = true;
  mesh.visible = n > 0;
}

function writeParticles(
  camera: THREE.Camera,
  meshes: (THREE.InstancedMesh | null)[],
  alphas: (THREE.InstancedBufferAttribute | null)[],
  dummy: THREE.Object3D,
  color: THREE.Color,
  tier: QualityTier,
  px: number,
  pz: number,
): void {
  const data = vfxData();
  const active = vfxActive();
  const flags = vfxFlags();
  const F = VFX_F;
  const clock = performance.now() * 0.001;
  const cull = tier === "low" ? 85 : tier === "medium" ? 130 : 190;
  const cull2 = cull * cull;

  for (let layer = 0; layer < VFX_LAYER_COUNT; layer++) {
    const mesh = meshes[layer];
    if (!mesh) continue;
    const cap = vfxLayerCap(layer);
    const start = vfxLayerStart(layer);
    const alphaAttr = alphas[layer];
    const alphaArr = alphaAttr?.array as Float32Array | undefined;
    let n = 0;

    for (let k = 0; k < cap; k++) {
      const i = start + k;
      if (!active[i]) continue;
      const o = i * VFX_STRIDE;
      const x = data[o + F.X]!;
      const y = data[o + F.Y]!;
      const z = data[o + F.Z]!;
      const dx = x - px;
      const dz = z - pz;
      if (dx * dx + dz * dz > cull2) continue;

      const f = data[o + F.LIFE]! / data[o + F.MAXLIFE]!;
      const age = 1 - f;
      const rot = data[o + F.ROT]!;
      const a = alphaCurve(layer, f, clock, rot) * data[o + F.ALPHA]!;
      if (a < 0.012) continue;

      const size = data[o + F.SIZE0]! + (data[o + F.SIZE1]! - data[o + F.SIZE0]!) * age;
      const stretch = data[o + F.STRETCH]!;
      const fl = flags[i]!;

      if (fl & VFX_FLAG.ALIGN && stretch > 0) {
        const vx = data[o + F.VX]!;
        const vy = data[o + F.VY]!;
        const vz = data[o + F.VZ]!;
        const sp = Math.hypot(vx, vy, vz);
        if (sp > 0.35) {
          _up.set(vx / sp, vy / sp, vz / sp);
          _toCam.set(camera.position.x - x, camera.position.y - y, camera.position.z - z);
          _right.crossVectors(_up, _toCam);
          const rl = _right.length();
          if (rl > 1e-4) {
            _right.multiplyScalar(1 / rl);
            _fwd.crossVectors(_right, _up);
            // Streak length grows with speed: a spark at 20m/s should be a
            // line, the same spark rolling to a stop should be a dot.
            const len = size * (1 + stretch * Math.min(sp, 26) * 0.052);
            _mat.makeBasis(_right, _up, _fwd);
            _scale.set(size, len, 1);
            _mat.scale(_scale);
            _pos.set(x, y, z);
            _mat.setPosition(_pos);
            mesh.setMatrixAt(n, _mat);
            writeColor(mesh, color, data, o, F, layer, age, a, n, alphaArr);
            n++;
            continue;
          }
        }
      }

      dummy.position.set(x, y, z);
      dummy.quaternion.copy(camera.quaternion);
      if (rot !== 0) dummy.rotateZ(rot);
      // ARC uses a 4:1 sprite; squashing the quad to match stops the bolt
      // being drawn inside a mostly-empty square of overdraw.
      if (layer === VFX_LAYER.ARC) dummy.scale.set(size * 2, size * 0.5, 1);
      else dummy.scale.set(size, size, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(n, dummy.matrix);
      writeColor(mesh, color, data, o, F, layer, age, a, n, alphaArr);
      n++;
    }

    dummy.position.set(0, -900, 0);
    dummy.quaternion.identity();
    dummy.scale.setScalar(0.0001);
    dummy.updateMatrix();
    for (let i = n; i < cap; i++) {
      mesh.setMatrixAt(i, dummy.matrix);
      if (alphaArr) alphaArr[i] = 0;
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (alphaAttr) alphaAttr.needsUpdate = true;
    mesh.visible = n > 0;
  }
}

function writeColor(
  mesh: THREE.InstancedMesh,
  color: THREE.Color,
  data: Float32Array,
  o: number,
  F: typeof VFX_F,
  layer: number,
  age: number,
  a: number,
  slot: number,
  alphaArr: Float32Array | undefined,
): void {
  const r = data[o + F.R0]! + (data[o + F.R1]! - data[o + F.R0]!) * age;
  const g = data[o + F.G0]! + (data[o + F.G1]! - data[o + F.G0]!) * age;
  const b = data[o + F.B0]! + (data[o + F.B1]! - data[o + F.B0]!) * age;
  color.setRGB(r, g, b);
  if (layer === VFX_LAYER.SMOKE || layer === VFX_LAYER.FLUID) {
    // Belt and braces: fold a softened copy of the fade into the colour too, so
    // that if the per-instance alpha patch ever silently stops applying (see
    // instanceAlpha.ts) this degrades to a colour fade rather than to smoke
    // that never dies. `lerp` toward the haze rather than toward black keeps
    // the failure mode readable instead of leaving dark blobs on the sand.
    color.lerp(HAZE, (1 - a) * 0.45);
    color.multiplyScalar(0.6 + a * 0.4);
  } else {
    color.multiplyScalar(0.45 + a * 0.55);
  }
  mesh.setColorAt(slot, color);
  if (alphaArr) alphaArr[slot] = a;
}

declare global {
  interface Window {
    /** Live VFX counters — QA/diagnostics only. */
    __vfxDebug?: { particles: number; shockwaves: number; tier: string };
  }
}
