import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { GameSimulation } from "../sim";
import { SHOWCASE } from "../sim";
import type { PlayerInput, VehicleState } from "../types";
import {
  GltfVehicleMesh,
  preloadCarModels,
  preloadHeroModel,
} from "../vehicles/GltfCar";
import { ModularVehicleMesh } from "../vehicles/meshes";
import { TrackMesh } from "./TrackMesh";
import { Atmosphere } from "./Atmosphere";
import {
  DraftWake,
  LockLine,
  MinesView,
  Nameplates,
  NearMissPulse,
  ParticlesView,
  ProjectilesView,
  SkidMarks,
  SpeedStreaks,
  VehicleFX,
} from "./Effects";
import type { InputController } from "../input";
import { qualityManager, type QualitySettings } from "./quality";
import { initGltfDecoders } from "./gltfLoaders";
import { CSM } from "three/examples/jsm/csm/CSM.js";
import { GpuDetailDriver } from "./shaders/GpuDetailDriver";
import { probeWebGpu } from "./shaders/webgpu";
import {
  configureWebGL2Renderer,
  EnvLighting,
  preloadPbrLibrary,
  isPbrLibraryReady,
  prefetchHdri,
} from "./webgl2";
import {
  TerrainCullDriver,
  getLastEdgePostCullStats,
  getLastBeaconCullStats,
} from "./culling";
import { preloadWasmNoise } from "./procmat/wasmRuntime";
import { CinematicFx } from "./CinematicFx";
import { PilotMesh } from "../vehicles/PilotMesh";
import { AudioDriver, audioOnInputEdge } from "../audio/AudioDriver";
import { VEHICLE_CLASSES } from "../classes";
import { getTrackEpoch } from "../track";
import { sampleGhost } from "../ghost";
import { makeTires } from "../tires";
import { sharedHitStop, sharedTrauma, snoise } from "./cameraShake";
import { CHASE, approach, speedNorm, speedResponse } from "./camera/speedCurve";
import { getRivalGhost, subscribeRivalGhost } from "../ghostDuel";
import { FRAME } from "./framePriority";
import { PhysicsPropsView } from "./PhysicsPropsView";
import { SceneryDecor, buildDecorList } from "./SceneryDecor";
import { getActiveEnvironment } from "./environments";
import { VfxScene } from "./vfx/VfxScene";
import { WeaponMounts } from "./WeaponMounts";
import type { PostFxInputs } from "./PostFX";
import {
  preloadPhRaceProps,
  preloadSceneryModels,
  type PhModelKey,
} from "./polyHavenAssets";
import { loadWeaponGeometry } from "./weaponMeshes";
/*
 * Only the util maps, deliberately NOT `getRecipeMaps`.
 *
 * `createProcMaterial` prefers the photo PBR pack whenever the library is
 * resident, and the library is the first thing the loader waits for — so
 * pre-baking the procedural recipes would spend seconds of CPU on maps that no
 * material in a normally-loaded race ever reads. The util maps are 64px canvas
 * fills and are used unconditionally.
 */
import { hazardMap, checkerMap } from "./procmat";
import {
  softCircleTexture,
  softCloudTexture,
  softSmokeTexture,
} from "./softSprite";
import {
  arcTexture,
  dropletTexture,
  emberTexture,
  fireTexture,
  shimmerTexture,
  shockRingTexture,
  splatTexture,
} from "./vfx/sprites";
import { buildTerrainAsync, terrainKey, getCachedTerrain } from "./terrainGeometry";
import { terrainSegmentsFor } from "./HeightmapTerrain";
import {
  closeRaceGate,
  getRaceGate,
  isSimHeld,
  listRaceWarmTasks,
  setWorldProgress,
  withDeadline,
  yieldToBrowser,
} from "./raceGate";

const USE_GLTF_CARS = true;
const SIM_STEP = 1 / 60;
/**
 * Enough steps to fully consume the clamped frame delta (80ms / 16.67ms = 5).
 * At 3 the sim could only advance 50ms per rendered frame, so anything under
 * ~20fps left unconsumed time that the loop then discarded — the world ran in
 * slow motion rather than merely choppily.
 */
const SIM_MAX_STEPS = 5;
const SIM_DELTA_CLAMP = 0.08;

/**
 * Cached sim pose for render interpolation.
 *
 * `p*` is the authoritative pose before the most recent fixed step, `c*` the
 * authoritative pose after it. What the meshes read between steps is a blend of
 * the two; neither is ever computed from a blend.
 */
type RenderPose = {
  px: number;
  py: number;
  pz: number;
  pyaw: number;
  cx: number;
  cy: number;
  cz: number;
  cyaw: number;
};

const TAU = Math.PI * 2;

/**
 * Squared distance above which a pose change is a teleport, not motion.
 *
 * One 1/60s step at the fastest speed in the game covers ~1.5 units. A wreck
 * respawn snaps the car to the nearest track sample, which is routinely tens of
 * units — interpolating that would fly the car across the desert over a frame.
 */
const TELEPORT_SQ = 16;

/**
 * Fraction of the current sim step already elapsed, published for anything else
 * in this file that samples on the sim clock (the replay ghosts). Written once
 * per frame in the SIM band, read in PRE_POSE.
 */
let renderAlpha = 0;

/**
 * Put the authoritative post-step pose back before the sim runs again.
 *
 * The meshes read VehicleState directly, so interpolation has to write into the
 * same fields the sim integrates. That is only safe if the sim never sees a
 * blended pose as its starting point — hence restore, step, re-blend, all
 * inside the SIM band before anything else in the frame runs.
 */
function restoreSimPose(
  vehicles: VehicleState[],
  poses: Map<string, RenderPose>,
) {
  if (poses.size === 0) return;
  for (const v of vehicles) {
    const p = poses.get(v.id);
    if (!p) continue;
    v.x = p.cx;
    v.y = p.cy;
    v.z = p.cz;
    v.yaw = p.cyaw;
  }
}

function capturePrevPose(
  vehicles: VehicleState[],
  poses: Map<string, RenderPose>,
) {
  for (const v of vehicles) {
    const p = poses.get(v.id);
    if (p) {
      p.px = v.x;
      p.py = v.y;
      p.pz = v.z;
      p.pyaw = v.yaw;
    } else {
      poses.set(v.id, {
        px: v.x,
        py: v.y,
        pz: v.z,
        pyaw: v.yaw,
        cx: v.x,
        cy: v.y,
        cz: v.z,
        cyaw: v.yaw,
      });
    }
  }
}

function captureCurrPose(
  vehicles: VehicleState[],
  poses: Map<string, RenderPose>,
) {
  for (const v of vehicles) {
    const p = poses.get(v.id);
    if (!p) continue;
    p.cx = v.x;
    p.cy = v.y;
    p.cz = v.z;
    p.cyaw = v.yaw;
  }
}

/**
 * Blend toward the current sim step by the leftover accumulator fraction.
 *
 * This renders up to one step (16.7ms) in the past, which is what makes it
 * interpolation rather than extrapolation: no overshoot to correct, no rubber
 * band when a car hits something. The lag is invisible; the stutter it replaces
 * was not — at 144Hz roughly three frames in five previously drew an identical
 * pose to the one before.
 */
function applyRenderPose(
  vehicles: VehicleState[],
  poses: Map<string, RenderPose>,
  alpha: number,
) {
  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  for (const v of vehicles) {
    const p = poses.get(v.id);
    if (!p) continue;
    const dx = p.cx - p.px;
    const dz = p.cz - p.pz;
    if (dx * dx + dz * dz > TELEPORT_SQ) {
      v.x = p.cx;
      v.y = p.cy;
      v.z = p.cz;
      v.yaw = p.cyaw;
      continue;
    }
    v.x = p.px + dx * a;
    v.y = p.py + (p.cy - p.py) * a;
    v.z = p.pz + dz * a;
    // Shortest arc. Yaw accumulates freely while driving, but a respawn assigns
    // an absolute track heading that can be most of a turn from the current
    // one, and blending the raw numbers would take the long way round.
    let dyaw = p.cyaw - p.pyaw;
    if (dyaw > Math.PI) dyaw -= TAU;
    else if (dyaw < -Math.PI) dyaw += TAU;
    v.yaw = p.pyaw + dyaw * a;
  }
}

function VehicleView(props: {
  vehicle: VehicleState;
  vehicleId?: string;
  sim?: GameSimulation;
  ghost?: boolean;
  forceHero?: boolean;
  decoy?: boolean;
}) {
  if (USE_GLTF_CARS && !props.ghost) {
    return (
      <GltfVehicleMesh
        vehicle={props.vehicle}
        vehicleId={props.vehicleId}
        sim={props.sim}
        ghost={props.ghost}
        forceHero={props.forceHero}
        decoy={props.decoy}
      />
    );
  }
  return (
    <ModularVehicleMesh
      vehicle={props.vehicle}
      vehicleId={props.vehicleId}
      sim={props.sim}
      ghost={props.ghost}
      forceHero={props.forceHero}
    />
  );
}

function ChaseCamera({ sim }: { sim: GameSimulation }) {
  const { camera } = useThree();
  const look = useRef(new THREE.Vector3());
  const desired = useRef(new THREE.Vector3());
  /**
   * The smoothed rig position, WITHOUT shake.
   *
   * Shake used to be folded into `desired` and then run through the position
   * lerp, which put a ~5Hz low-pass on an 18Hz signal: the trauma curve was
   * doing its job and the smoothing was eating almost all of it. Keeping the
   * un-shaken rig separate and adding the offset after smoothing is what makes
   * a heavy hit actually move the frame.
   */
  const rig = useRef(new THREE.Vector3());
  const ready = useRef(false);
  const traumaSys = useRef(sharedTrauma);
  const boostPunch = useRef(0);
  const hitPunch = useRef(0);
  const prevBoost = useRef(0);
  const prevFlash = useRef(0);
  const prevShake = useRef(0);
  /**
   * Smoothed normalised speed. Every speed-reactive term below reads this and
   * never the raw value: a wall takes the car from 70 u/s to 0 inside one fixed
   * step, and a rig that tracked that would slam forward and collapse the FOV
   * on the same frame as the hitstop and the shake. Three violent things at
   * once reads as a glitch, not a crash.
   */
  const sn = useRef(0);

  useFrame((_, dt) => {
    const state = sim.state;
    const target = state.vehicles.find((v) => v.isPlayer);
    if (!target) return;
    const shake = state.cameraShake;
    const racing =
      state.phase === "racing" ||
      state.phase === "countdown" ||
      state.phase === "paused";
    const kick = state.cameraKick;
    const ts = traumaSys.current;
    if (shake > prevShake.current + 0.05) {
      const delta = shake - prevShake.current;
      const dir =
        kick && (kick.x !== 0 || kick.z !== 0)
          ? { x: kick.x, z: kick.z }
          : { x: Math.sin(target.yaw), z: Math.cos(target.yaw) };
      ts.add(delta * 0.85, dir);
    } else {
      ts.absorbSimShake(shake);
    }
    prevShake.current = shake;
    ts.step(dt);

    if (target.boostTimer > 0.4 && prevBoost.current <= 0.4) {
      boostPunch.current = 1;
      ts.add(0.12);
    }
    if (target.impactFlash > 0.4 && prevFlash.current <= 0.4) {
      hitPunch.current = 1;
      ts.add(0.28, {
        x: Math.sin(target.yaw + Math.PI),
        z: Math.cos(target.yaw + Math.PI),
      });
    }
    prevBoost.current = target.boostTimer;
    prevFlash.current = target.impactFlash;
    boostPunch.current = Math.max(0, boostPunch.current - dt * 1.8);
    hitPunch.current = Math.max(0, hitPunch.current - dt * 3.2);

    // The one speed curve: normalise once, smooth once, and drive pull-back,
    // height, look-ahead, shake gain and FOV off the same number. Asymmetric so
    // gaining speed is felt immediately and losing it is not thrown back at you.
    const rawSn = speedNorm(target.speed);
    sn.current = approach(
      sn.current,
      rawSn,
      rawSn > sn.current ? CHASE.snRiseTau : CHASE.snFallTau,
      dt,
    );
    const s01 = sn.current;
    const top = speedResponse(s01);

    const fx = -Math.sin(target.yaw);
    const fz = -Math.cos(target.yaw);
    const dist =
      (racing ? CHASE.distBase + CHASE.distGain * s01 : 16) -
      boostPunch.current * 0.8 +
      hitPunch.current * 0.4;
    const height =
      (racing ? CHASE.heightBase + CHASE.heightGain * s01 : 8) +
      hitPunch.current * 0.25;
    const lookAhead =
      CHASE.lookBase + CHASE.lookGain * s01 + boostPunch.current * 1.5;

    desired.current.set(
      target.x - fx * dist,
      target.y + height,
      target.z - fz * dist,
    );

    if (!ready.current) {
      rig.current.copy(desired.current);
      ready.current = true;
    } else {
      const lag =
        target.boostTimer > 0 ? 4.2 : hitPunch.current > 0.2 ? 7.5 : 5.2;
      rig.current.lerp(desired.current, 1 - Math.exp(-lag * dt));
    }

    const tSec = performance.now() * 0.001;
    const s = ts.sample(tSec);
    // Shake reads harder the faster you are going — the same impulse against a
    // stationary car should barely register.
    const gain = CHASE.shakeBase + CHASE.shakeGain * s01;
    camera.position.set(
      rig.current.x + s.ox * gain,
      rig.current.y + s.oy * gain,
      rig.current.z + s.oz * gain,
    );
    // Continuous rumble above the knee. Deliberately tiny: this is the line
    // between "the car is fast" and "the camera is broken".
    const rumble = CHASE.rumble * top;
    if (rumble > 0.0005) {
      camera.position.x += snoise(tSec * 23.7, 6) * rumble;
      camera.position.y += snoise(tSec * 31.1, 7) * rumble * 0.7;
    }

    look.current.set(
      target.x + fx * lookAhead,
      target.y + 1 + (target.boostTimer > 0 ? 0.25 : 0),
      target.z + fz * lookAhead,
    );
    camera.lookAt(look.current);
    if (s.roll !== 0 || s.pitch !== 0) {
      camera.rotateZ(s.roll * gain);
      camera.rotateX(s.pitch * gain);
    }
    const cam = camera as THREE.PerspectiveCamera;
    if (cam.isPerspectiveCamera) {
      // No shake term here on purpose. FOV pumping in sympathy with a
      // positional shake is the classic motion-sickness combination, and the
      // shake is already moving the frame — the punch terms below carry the
      // impact instead, and they decay smoothly.
      const targetFov =
        CHASE.fovBase +
        CHASE.fovSpeedGain * s01 +
        CHASE.fovTopGain * top +
        (target.boostTimer > 0 ? CHASE.fovBoost : 0) +
        (target.driftMeter > 0.5 ? CHASE.fovDrift : 0) +
        boostPunch.current * 8 +
        hitPunch.current * 5;
      // Time constant, never a raw assignment: the target contains hard steps
      // (boost on/off, drift latch) and this is what stops them being a snap.
      cam.fov = approach(cam.fov, targetFov, CHASE.fovTau, dt);
      if (cam.far < 850) cam.far = 900;
      if (cam.near > 0.5) cam.near = 0.35;
      cam.updateProjectionMatrix();
    }
  }, FRAME.POSE);
  return null;
}

function GarageOrbitCamera({ sim }: { sim: GameSimulation }) {
  const { camera } = useThree();
  const angle = useRef(1.15);
  const ready = useRef(false);
  const elev = useRef(0);
  const classKey = useRef("");
  useFrame((_, dt) => {
    const phase = sim.state.phase;
    const active =
      phase === "menu" || phase === "garage" || phase === "finished";
    const target = sim.state.vehicles.find((v) => v.isPlayer);
    if (!active || !target) return;
    const tight = phase === "garage";
    if (classKey.current !== target.classId) {
      classKey.current = target.classId;
      elev.current = 1;
    }
    elev.current = Math.max(0, elev.current - dt * 1.6);
    angle.current += dt * (tight ? 0.48 : 0.32);
    const radius = (tight ? 6.4 : 9.5) + elev.current * 1.1;
    const height =
      (tight ? 2.2 : 3.6) + elev.current * 0.75 + Math.sin(angle.current * 0.55) * 0.2;
    const cx = target.x + Math.cos(angle.current) * radius;
    const cz = target.z + Math.sin(angle.current) * radius;
    const cy = target.y + height;
    if (!ready.current) {
      camera.position.set(cx, cy, cz);
      ready.current = true;
    } else {
      const k = 1 - Math.exp(-4 * dt);
      camera.position.x += (cx - camera.position.x) * k;
      camera.position.y += (cy - camera.position.y) * k;
      camera.position.z += (cz - camera.position.z) * k;
    }
    camera.lookAt(target.x, target.y + (tight ? 1.9 : 2.4), target.z);
    const cam = camera as THREE.PerspectiveCamera;
    if (cam.isPerspectiveCamera) {
      const fov = tight ? 36 + elev.current * 3 : 44;
      cam.fov = THREE.MathUtils.lerp(cam.fov, fov, 1 - Math.exp(-2.8 * dt));
      cam.updateProjectionMatrix();
    }
  }, FRAME.POSE);
  return null;
}

function LiveCamera({ sim }: { sim: GameSimulation }) {
  const [mode, setMode] = useState<"garage" | "chase">(() => {
    const p = sim.state.phase;
    return p === "menu" || p === "garage" || p === "finished" ? "garage" : "chase";
  });
  useFrame(() => {
    const p = sim.state.phase;
    const next =
      p === "menu" || p === "garage" || p === "finished" ? "garage" : "chase";
    if (next !== mode) setMode(next);
  }, FRAME.LATE);
  return mode === "garage" ? (
    <GarageOrbitCamera sim={sim} />
  ) : (
    <ChaseCamera sim={sim} />
  );
}

function ShowcasePad({ color, accent }: { color: string; accent: string }) {
  const ring = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => {
    if (ring.current) ring.current.rotation.z += dt * 0.35;
  }, FRAME.LATE);
  return (
    <group position={[SHOWCASE.x, 0, SHOWCASE.z]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} receiveShadow>
        <circleGeometry args={[5.2, 32]} />
        <meshStandardMaterial color="#1c1917" roughness={0.55} metalness={0.45} />
      </mesh>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]}>
        <ringGeometry args={[3.6, 4, 48]} />
        <meshBasicMaterial
          color={accent}
          transparent
          opacity={0.55}
          depthWrite={false}
          toneMapped={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      <pointLight position={[0, 4.5, 0]} intensity={1.8} color={accent} distance={20} decay={2} />
      <spotLight
        position={[2, 10, 4]}
        angle={0.55}
        penumbra={0.6}
        intensity={2.4}
        color="#ffedd5"
        castShadow={false}
      />
    </group>
  );
}

function makeGhostVehicleState(
  id: string,
  classId: VehicleState["classId"],
  color: string,
): VehicleState {
  return {
    id,
    name: "Ghost",
    isPlayer: false,
    classId,
    x: 0,
    y: -50,
    z: 0,
    yaw: 0,
    speed: 0,
    lateral: 0,
    health: 100,
    maxHealth: 100,
    shield: 0,
    weaponCharge: 0,
    shieldCharge: 0,
    ultimateCharge: 0,
    primaryCooldown: 0,
    defenseCooldown: 0,
    ultimateActive: 0,
    defenseActive: 0,
    decoyActive: 0,
    invuln: 0,
    wreckTimer: 0,
    boostTimer: 0,
    lap: 0,
    checkpoint: 0,
    raceProgress: 0,
    finished: false,
    finishTime: 0,
    position: 0,
    color,
    damageVisual: 0,
    dentFront: 0,
    dentLeft: 0,
    dentRight: 0,
    dentRear: 0,
    impactFlash: 0,
    lockTargetId: null,
    airTime: 0,
    nearMissBoost: 0,
    alive: true,
    hitStun: 0,
    offroadAmount: 0,
    surface: "asphalt",
    bodyRoll: 0,
    bodyPitch: 0,
    tires: makeTires(classId),
    steerAngle: 0,
    tireLoad: 0.1,
    tireSlip: 0,
    tireTemp: 50,
    tireTempBand: "warm",
    driftMeter: 0,
    uiAccel: 0,
    lapTimes: [],
    lastLapTime: 0,
  };
}

function GhostVehicle({ sim }: { sim: GameSimulation }) {
  const pb = useMemo(
    () => makeGhostVehicleState("ghost-pb", "interceptor", "#a1a1aa"),
    [],
  );
  const rival = useMemo(
    () => makeGhostVehicleState("ghost-rival", "interceptor", "#f472b6"),
    [],
  );
  const [rivalRun, setRivalRun] = useState(getRivalGhost());
  const [active, setActive] = useState(false);
  useEffect(() => {
    setRivalRun(getRivalGhost());
    return subscribeRivalGhost(() => setRivalRun(getRivalGhost()));
  }, []);
  useFrame(() => {
    const phase = sim.state.phase;
    const on =
      phase === "racing" || phase === "countdown" || phase === "paused";
    if (on !== active) setActive(on);
    // raceTime is quantised to the fixed step like everything else, so carry
    // the same leftover fraction the live cars are interpolated by — otherwise
    // the ghost stutters against the car it is racing.
    const t = Math.max(0, sim.state.raceTime + renderAlpha * SIM_STEP);
    const ghost = sim.activeGhost;
    if (!on || !ghost) {
      pb.y = -50;
    } else {
      const pose = sampleGhost(ghost, t);
      if (pose) {
        pb.x = pose.x;
        pb.y = pose.y;
        pb.z = pose.z;
        pb.yaw = pose.yaw;
        pb.color = ghost.color || "#a1a1aa";
        pb.classId = ghost.classId;
        pb.name = ghost.name || "Ghost";
      } else {
        pb.y = -50;
      }
    }
    const r = rivalRun ?? getRivalGhost();
    if (!on || !r || r.trackId !== sim.state.selectedTrack) {
      rival.y = -50;
    } else {
      const pose = sampleGhost(r, t);
      if (pose) {
        rival.x = pose.x;
        rival.y = pose.y;
        rival.z = pose.z;
        rival.yaw = pose.yaw;
        rival.color = r.color || "#f472b6";
        rival.classId = r.classId;
        rival.name = r.name || "Rival";
      } else {
        rival.y = -50;
      }
    }
  }, FRAME.PRE_POSE);
  if (!active) return null;
  return (
    <>
      {sim.activeGhost && <VehicleView vehicle={pb} ghost />}
      {rivalRun && rivalRun.trackId === sim.state.selectedTrack && (
        <VehicleView vehicle={rival} ghost />
      )}
    </>
  );
}

function LiveVehicles({ sim }: { sim: GameSimulation }) {
  const [epoch, setEpoch] = useState(sim.worldEpoch);
  const [ids, setIds] = useState(() =>
    sim.state.vehicles.map((v) => v.id).join(","),
  );
  const [showcase, setShowcase] = useState(
    () =>
      sim.state.phase === "menu" ||
      sim.state.phase === "garage" ||
      sim.state.phase === "finished",
  );

  useFrame(() => {
    if (sim.worldEpoch !== epoch) setEpoch(sim.worldEpoch);
    const nextIds = sim.state.vehicles.map((v) => v.id).join(",");
    if (nextIds !== ids) setIds(nextIds);
    const p = sim.state.phase;
    const sc = p === "menu" || p === "garage" || p === "finished";
    if (sc !== showcase) setShowcase(sc);
  }, FRAME.LATE);

  void epoch;
  void ids;
  const vehicles = sim.state.vehicles;
  const player = vehicles.find((v) => v.isPlayer);
  const def = player
    ? VEHICLE_CLASSES[player.classId]
    : VEHICLE_CLASSES.interceptor;
  const shown = showcase ? vehicles.filter((v) => v.isPlayer) : vehicles;

  return (
    <>
      {showcase && player && (
        <ShowcasePad color={player.color || def.color} accent={def.accent} />
      )}
      {shown.map((v) => (
        <VehicleView
          key={`${v.id}-${epoch}-${v.classId}`}
          vehicle={v}
          sim={sim}
          vehicleId={v.id}
          forceHero={v.isPlayer}
        />
      ))}
      {/*
        Holo Decoy (trickster defence). Mounting is driven by React state, so it
        appears within a HUD tick of the ability firing — but the POSE must not
        be. The decoy is handed the sim and the SOURCE vehicle's id so the mesh
        resolves the live car every frame and applies the offset itself.

        The previous version copied the pose into a snapshot object here, which
        meant the decoy stepped at the React render rate (~10-20Hz, driven by
        the HUD signature in ScrapstormApp) while the car beside it moved at
        60-144Hz. A see-through car juddering next to a smooth one is read as a
        rendering fault, not as an ability — which is how it was reported.
      */}
      {!showcase &&
        vehicles
          .filter((v) => v.decoyActive > 0)
          .map((v) => (
            <VehicleView
              key={`${v.id}-decoy`}
              vehicle={v}
              vehicleId={v.id}
              sim={sim}
              decoy
            />
          ))}
    </>
  );
}

function LiveFx({ sim }: { sim: GameSimulation }) {
  const [tick, setTick] = useState(0);
  const frame = useRef(0);
  useFrame(() => {
    frame.current++;
    if (frame.current % 8 === 0) setTick((t) => t + 1);
  }, FRAME.LATE);
  void tick;
  const state = sim.state;
  const phase = state.phase;
  if (phase === "menu" || phase === "garage" || phase === "finished")
    return null;
  const player = state.vehicles.find((v) => v.isPlayer);
  const lockTarget = state.vehicles.find((v) => v.id === player?.lockTargetId);
  const tier = qualityManager.get().tier;
  return (
    <>
      <SkidMarks vehicles={state.vehicles} />
      <CinematicPlayer sim={sim} />
      <ProjectilesView projectiles={state.projectiles} />
      <MinesView mines={state.mines} />
      {/* Roof hardware for the classes that carry it. Instanced across the
          whole grid, so the field costs two draws rather than one per car. */}
      <WeaponMounts vehicles={state.vehicles} />
      <ParticlesView particles={state.particles} />
      <VehicleFX vehicles={state.vehicles} />
      {tier !== "low" && <SpeedStreaks player={player} />}
      {tier !== "low" && <DraftWake player={player} vehicles={state.vehicles} />}
      <NearMissPulse player={player} />
      <LockLine self={player} target={lockTarget} />
      <Nameplates vehicles={state.vehicles} />
      <GhostVehicle sim={sim} />
      <PhysicsPropsView sim={sim} />
      {/* Inside LiveFx rather than at scene root: LiveFx is already gated to
          race phases, so the particle and damage pools reset on the way back
          to the garage instead of persisting across sessions. */}
      <VfxScene sim={sim} />
    </>
  );
}

function SimDriver({
  sim,
  input,
  onHud,
  onPauseToggle,
  lastInput,
}: {
  sim: GameSimulation;
  input: InputController;
  onHud: () => void;
  onPauseToggle: () => void;
  lastInput: React.MutableRefObject<PlayerInput | null>;
}) {
  const acc = useRef(0);
  const poses = useRef(new Map<string, RenderPose>());
  const epoch = useRef(-1);

  useFrame((state, delta) => {
    // Earliest band (FRAME.SIM), so the counters accumulate across every pass
    // of the frame that follows and the HUD reads a real total.
    state.gl.info.reset();

    /*
     * THE HOLD. This is what actually stops the countdown running before the
     * world is ready.
     *
     * `startCountdown` has already run by the time we get here — the grid is
     * built, the field is placed, the world tree is mounting, and phase is
     * "countdown". What has NOT happened is the clock: `state.countdown` only
     * moves inside `sim.tick`, so simply not calling it freezes the lights on
     * three while the terrain uploads, the props resolve and the shaders
     * compile. Nothing else has to know: the cameras, the HUD, the audio driver
     * and the post chain all keep running against a stationary grid.
     *
     * Returning early also keeps this frame out of `qualityManager.sampleFrame`,
     * which matters more than it looks. Warm-up frames are slow BY DESIGN —
     * that is the work being done — and feeding them to the auto-tier would drop
     * the player to a lower tier before they had driven a metre, which would in
     * turn invalidate the terrain field the loading screen just baked at the old
     * tier and rebuild the whole world.
     */
    if (isSimHeld()) {
      input.consumePause();
      acc.current = 0;
      return;
    }
    if (input.consumePause()) onPauseToggle();

    // A rebuilt field reuses the same vehicle ids ("player", "bot-0", …), so a
    // pose cached from the previous race would be restored straight onto a car
    // that has just been placed on the new grid.
    if (sim.worldEpoch !== epoch.current) {
      epoch.current = sim.worldEpoch;
      poses.current.clear();
    }
    restoreSimPose(sim.state.vehicles, poses.current);

    const raw = Math.min(delta, SIM_DELTA_CLAMP);
    /**
     * Hitstop scales the REAL time handed to the accumulator, so the fixed step
     * itself is untouched — the sim still advances in exact 1/60 increments,
     * just fewer of them per second. Doing it here rather than inside the sim
     * means the stopped time is deferred into the accumulator instead of being
     * thrown away, and a light hit can be a hesitation rather than a stop.
     *
     * Gated on "racing": consuming it during countdown would burn the freeze
     * before the lights go green, and pause/menu do not advance anyway.
     */
    const timeScale =
      sim.state.phase === "racing" ? sharedHitStop.consume(raw) : 1;
    acc.current += raw * timeScale;

    let steps = 0;
    let playerInput: PlayerInput | undefined;
    const needInput =
      sim.state.phase === "racing" || sim.state.phase === "countdown";
    if (needInput) {
      playerInput = input.sample();
      const player = sim.state.vehicles.find((v) => v.isPlayer);
      if (playerInput && player) {
        audioOnInputEdge(lastInput.current, playerInput, player.classId);
      }
      lastInput.current = playerInput ?? null;
    }
    while (acc.current >= SIM_STEP && steps < SIM_MAX_STEPS) {
      // Overwritten each iteration, so after the loop this holds the pose
      // before the LAST step — which is the one the leftover fraction is
      // measured against.
      capturePrevPose(sim.state.vehicles, poses.current);
      sim.tick(SIM_STEP, playerInput ?? null);
      acc.current -= SIM_STEP;
      steps += 1;
    }
    // Carry the remainder into the next frame rather than discarding it.
    // Zeroing here leaked real time on any slow frame, so the race clock (and
    // therefore all physics) advanced slower than wall time — measured at 70%
    // on a ~14fps capture. Clamp only far enough to prevent a death spiral.
    const maxCarry = SIM_STEP * SIM_MAX_STEPS;
    if (acc.current > maxCarry) acc.current = maxCarry;
    if (steps > 0) {
      captureCurrPose(sim.state.vehicles, poses.current);
      onHud();
    }
    // Runs even on a frame that stepped nothing — that is the whole point. At
    // 144Hz most frames step zero times, and without this they redraw the
    // previous pose verbatim.
    // Clamped: on a frame slow enough to exhaust SIM_MAX_STEPS the carry is
    // still several steps deep, and an unclamped fraction would push the ghost
    // sampler ahead of the sim clock rather than behind it.
    renderAlpha = Math.min(1, acc.current / SIM_STEP);
    applyRenderPose(sim.state.vehicles, poses.current, renderAlpha);
    qualityManager.sampleFrame(delta);
  }, FRAME.SIM);
  return null;
}

function PbrBootstrap({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(isPbrLibraryReady());
  useEffect(() => {
    let alive = true;
    preloadPbrLibrary().then(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  return <group key={ready ? "pbr" : "proc"}>{children}</group>;
}

function CullStatsPublisher() {
  const frame = useRef(0);
  useFrame(() => {
    frame.current++;
    if (frame.current % 15 !== 0) return;
    if (typeof window === "undefined") return;
    const edges = getLastEdgePostCullStats();
    const beacons = getLastBeaconCullStats();
    const base = window.__terrainCull ?? {
      dunes: { visible: [], stats: emptyStats() },
      scenery: { visible: [], stats: emptyStats() },
      ground: { visible: [], stats: emptyStats() },
    };
    window.__terrainCull = {
      ...base,
      edges: edges ?? undefined,
      beacons: beacons
        ? { visible: beacons.visible, tested: beacons.tested }
        : undefined,
    };
  }, FRAME.TELEMETRY);
  return null;
}

function emptyStats() {
  return { tested: 0, frustumPass: 0, distancePass: 0, visible: 0, ms: 0 };
}

/**
 * Draws the scene whenever no EffectComposer is mounted.
 *
 * react-three-fiber only renders by itself while every useFrame subscription
 * sits at priority 0 — its loop ends with
 * `if (!state.internal.priority) gl.render(scene, camera)`. This scene has
 * THIRTY subscribers above zero (the whole FRAME.LATE and FRAME.TELEMETRY
 * bands), so r3f has permanently handed rendering over and the composer inside
 * PostFX was the only thing drawing anything.
 *
 * PostFX is not mounted on the low tier, and not in the garage or showcase, and
 * not until its dynamic import resolves. Measured at HEAD on an RTX 5080: low
 * tier reported 0 draw calls, a 0.45ms frame loop, a black canvas under a live
 * HUD, and "161 fps". The garage was the same — info.render.frame stopped
 * advancing at 42 and stayed there for the twelve seconds it was watched.
 *
 * Priority 1 is the slot the composer itself occupies, so the ordering against
 * every other band is identical whether or not post is running.
 */
const RENDER_PRIORITY = 1;

function SceneRenderer() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  useFrame(() => {
    gl.render(scene, camera);
  }, RENDER_PRIORITY);
  return null;
}

/**
 * Feeds the post chain without re-rendering it.
 *
 * boost/hit/speed/drift used to be React state here, and every change
 * re-rendered PostFX, which re-created the EffectComposer's `children` element,
 * which made @react-three/postprocessing remove and rebuild all six passes. The
 * profiler's pass-wrap counter measured 696 rebuilds in 24 seconds of racing —
 * the whole chain reconstructed about five times a second because the car was
 * accelerating. These are uniforms; they go through a ref the driver reads.
 * Only `on` and `tier` remain state, and both genuinely need a new chain.
 */
function PostFxLive({ sim }: { sim: GameSimulation }) {
  const [on, setOn] = useState(false);
  const [tier, setTier] = useState(qualityManager.get().tier);
  const [PostFX, setPostFX] = useState<null | typeof import("./PostFX").PostFX>(
    null,
  );
  const inputs = useRef<PostFxInputs>({
    boost: false,
    hit: false,
    speedNorm: 0,
    drifting: false,
  });

  useEffect(() => {
    if (tier === "low") return;
    let alive = true;
    void import("./PostFX").then((m) => {
      if (alive) setPostFX(() => m.PostFX);
    });
    return () => {
      alive = false;
    };
  }, [tier]);

  useFrame(() => {
    const p = sim.state.phase;
    const active = p === "racing" || p === "countdown" || p === "paused";
    if (active !== on) setOn(active);
    const t = qualityManager.get().tier;
    if (t !== tier) setTier(t);
    const player = sim.state.vehicles.find((v) => v.isPlayer);
    const i = inputs.current;
    i.boost = (player?.boostTimer ?? 0) > 0;
    i.hit = (player?.impactFlash ?? 0) > 0.15;
    // Same normalisation the chase rig uses. These were independently
    // hard-coded, which is how the blur and the FOV push ended up arriving at
    // different points on the speedo.
    i.speedNorm = speedNorm(player?.speed ?? 0);
    i.drifting = (player?.driftMeter ?? 0) > 0.12;
  }, FRAME.LATE);

  // Mutually exclusive with the composer by construction — never both, so the
  // scene is drawn exactly once per frame either way.
  if (!on || tier === "low" || !PostFX) return <SceneRenderer />;
  return <PostFX inputs={inputs} />;
}

function CinematicPlayer({ sim }: { sim: GameSimulation }) {
  const bag = useRef<{ player: VehicleState | null }>({ player: null });
  useFrame(() => {
    const phase = sim.state.phase;
    bag.current.player =
      phase === "racing" || phase === "countdown" || phase === "paused"
        ? (sim.state.vehicles.find((v) => v.isPlayer) ?? null)
        : null;
  }, FRAME.PRE_POSE);
  return <CinematicFx bag={bag} />;
}

function GaragePilot({ sim }: { sim: GameSimulation }) {
  const [show, setShow] = useState(() => sim.state.phase === "garage");
  useFrame(() => {
    const next = sim.state.phase === "garage";
    if (next !== show) setShow(next);
  }, FRAME.LATE);
  if (!show) return null;
  return <PilotMesh key="pilot" visible position={[2.4, 0, 0.2]} scale={1.12} />;
}

function ShowcaseWorld({ sim }: { sim: GameSimulation }) {
  return (
    <>
      <color attach="background" args={["#14100e"]} />
      <fog attach="fog" args={["#1a1210", 18, 90]} />
      <ambientLight intensity={0.7} color="#f4e4c8" />
      <hemisphereLight args={["#ffc898", "#2a1810", 1.1]} />
      <directionalLight position={[12, 18, 6]} intensity={2.4} color="#ffe8c8" />
      <directionalLight position={[-8, 8, -6]} intensity={0.55} color="#88b8e8" />
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[SHOWCASE.x, -0.05, SHOWCASE.z]}
        receiveShadow
      >
        <circleGeometry args={[40, 48]} />
        <meshStandardMaterial
          color="#3a2a1c"
          roughness={1}
          metalness={0}
          emissive="#1a120c"
          emissiveIntensity={0.0}
        />
      </mesh>
      {/* Always mounted: EnvLighting picks the HDRI or the cheap procedural
          gradient itself, so low tier still gets image-based lighting. */}
      <EnvLighting />
      <LiveVehicles sim={sim} />
      <GaragePilot sim={sim} />
      <LiveCamera sim={sim} />
      {/* The showcase never mounts PostFX, so without this the garage and the
          menu backdrop are a black canvas — see SceneRenderer. */}
      <SceneRenderer />
    </>
  );
}

/**
 * Dynamic resolution scaling — hold a playable framerate by trading pixels.
 *
 * A fixed dprMax has to be pessimistic enough for the weakest GPU in a tier,
 * which wastes a strong one, or optimistic enough to look good, which tanks a
 * weak one. Instead treat the tier's dprMax as a ceiling and scale beneath it
 * from measured frame time: full resolution when there is headroom, dropping
 * toward 60% when there is not.
 *
 * Resizing the drawing buffer reallocates every render target in the post
 * chain, so changes are throttled and hysteretic — never per frame.
 */
function AdaptiveResolution() {
  const { gl } = useThree();
  // Start below the ceiling and climb into it. Opening at full dprMax means a
  // weak GPU renders its first seconds at 4x the pixels before the scaler can
  // react; a strong one reaches 100% within a couple of measurement windows.
  const scale = useRef(0.8);
  const frames = useRef(0);
  const accum = useRef(0);
  const cooldown = useRef(0);

  // Apply the conservative starting scale immediately, before the first
  // measurement window has had a chance to run.
  useEffect(() => {
    const q = qualityManager.get();
    const base = Math.min(window.devicePixelRatio || 1, q.dprMax);
    gl.setPixelRatio(base * scale.current);
    window.__resScale = scale.current;
  }, [gl]);

  useFrame((_, dt) => {
    if (dt > 0.25) return; // tab was backgrounded
    /*
     * Same reasoning as the sim hold: warm-up frames are slow on purpose, and a
     * scaler that believed them would open the race at 60% resolution and take
     * several seconds of real driving to climb back out.
     */
    if (isSimHeld()) {
      frames.current = 0;
      accum.current = 0;
      return;
    }
    accum.current += dt;
    frames.current += 1;
    if (cooldown.current > 0) cooldown.current -= 1;
    if (frames.current < 45) return;

    const fps = frames.current / accum.current;
    frames.current = 0;
    accum.current = 0;
    if (cooldown.current > 0) return;

    let next = scale.current;
    if (fps < 48) next = Math.max(0.6, scale.current - 0.12);
    else if (fps > 58 && scale.current < 1) next = Math.min(1, scale.current + 0.06);
    if (Math.abs(next - scale.current) < 0.005) return;

    scale.current = next;
    const q = qualityManager.get();
    const base = Math.min(
      typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
      q.dprMax,
    );
    gl.setPixelRatio(base * next);
    if (typeof window !== "undefined") window.__resScale = next;
    cooldown.current = 90; // ~1.5s before another change
  }, FRAME.TELEMETRY);

  return null;
}

/**
 * Precompile shader programs so materials do not stall the first time they
 * become visible.
 *
 * three compiles a program lazily, the first frame a material/light/shadow
 * combination is actually rendered. In a racing scene that means a hitch every
 * time something new comes into view — a prop type, a weapon FX, the first
 * shadow caster. compileAsync uses KHR_parallel_shader_compile, so the work
 * happens off the critical path instead of blocking a frame like compile().
 *
 * Two passes: the countdown covers what exists at grid time, and a later pass
 * catches materials created by assets that finished loading afterwards.
 */
function ShaderWarmup() {
  const { gl, scene, camera } = useThree();

  useEffect(() => {
    let cancelled = false;
    const timers: number[] = [];
    const warm = () => {
      if (cancelled) return;
      try {
        // Synchronous compile, deliberately NOT compileAsync.
        //
        // compileAsync snapshots the material set, then re-polls
        // `materialProperties.currentProgram.isReady()` from a setTimeout
        // loop. This scene mutates that set constantly — CSM re-patches
        // shaders every 45 frames, the prop pool clones materials per slot,
        // glTF lands late — so a material's program routinely disappears
        // between snapshot and poll and the poll throws. Because the retries
        // run from a timer rather than inside the promise, that throw is an
        // uncaught timer exception: .catch() on the returned promise cannot
        // see it, which is why guarding it did not help.
        //
        // The synchronous path has no polling loop and cannot hit that. Its
        // cost is a one-off hitch, and prepareRaceAssets already holds a
        // loading screen over exactly this window.
        gl.compile(scene, camera);
      } catch {
        /* warmup is best-effort */
      }
    };
    timers.push(window.setTimeout(warm, 600));
    timers.push(window.setTimeout(warm, 4000));
    return () => {
      cancelled = true;
      for (const t of timers) window.clearTimeout(t);
    };
  }, [gl, scene, camera]);

  return null;
}

/**
 * Minimum time the warm phase spends watching before it will believe the scene
 * has settled.
 *
 * Without a floor the settle detector is trivially satisfied: on a warm cache
 * nothing new is created for twenty frames and it declares victory in a third of
 * a second — before `import("./PostFX")` has even resolved, so the entire post
 * chain still compiles on the first green frame. This is the window the
 * asynchronous stragglers get to announce themselves.
 */
const WARM_MIN_MS = 900;

/** Frames with no new geometry, texture or program before we call it settled. */
const WARM_STABLE_FRAMES = 20;

/**
 * When to stop waiting for the scene to settle and compile anyway.
 *
 * Reached when something is still creating resources every frame — a prop pool
 * that keeps cloning, a texture that keeps failing and retrying. Compiling and
 * starting is strictly better than holding a loading screen over a scene that
 * will never be quiet.
 */
const WARM_SETTLE_BUDGET_MS = 6000;

/** Frames drawn after the compile, so the driver actually links and uploads. */
const WARM_FLUSH_FRAMES = 3;

/** Frames held so the "Compiling shaders" caption reaches the screen first. */
const WARM_ARM_FRAMES = 2;

/**
 * Holds the grid until the mounted world has stopped materialising.
 *
 * WHY A SETTLE DETECTOR RATHER THAN A LIST OF PROMISES
 * ----------------------------------------------------
 * Most of what lands during the countdown is not something this file can await.
 * The scatter fields, the set-piece layers, the road ribbon and the decor
 * batches are built inside other components' `useMemo`/`useEffect` and expose no
 * promise; several of them live in modules this file must not import. A
 * registry of preload hooks covers the ones that can opt in (see
 * `listRaceWarmTasks`), but a gate that only waited on those would be silently
 * incomplete the moment somebody adds a component that does not.
 *
 * So the gate watches the RENDERER instead. `gl.info` counts live geometries,
 * live textures and compiled programs; those numbers only move when something
 * new arrives. When they have not moved for twenty consecutive frames, nothing
 * is still arriving — whatever the source, whether or not it cooperated. That is
 * a property of the frame, which is the thing we actually care about.
 *
 * Deliberately NOT watched: draw calls and triangle counts. Both change every
 * frame while the chase rig settles onto the grid and the culling drivers
 * converge, so including them would mean the scene never reads as stable.
 */
function WorldWarmup() {
  const { gl, scene, camera } = useThree();
  const st = useRef({
    stage: "settle" as "settle" | "arm" | "compile" | "flush" | "done",
    gen: -1,
    started: 0,
    sig: "",
    stable: 0,
    flush: 0,
  });

  useFrame(() => {
    const s = st.current;
    const gate = getRaceGate();
    // Not our race: either nothing is gated (a QA hook jumped straight in) or
    // the assets are still downloading and the world has not been handed over.
    if (!gate.held || gate.phase !== "world") return;

    /*
     * Re-arm on a new gate rather than relying on being remounted.
     *
     * A restart normally tears this tree down (worldEpoch feeds the scene key),
     * so a fresh instance starts at "settle" anyway. This is the belt to that
     * braces: if any future path ever opens the gate without changing the scene
     * key, an instance parked at "done" would sit there while the watchdog ran
     * out — a twelve-second loading screen over a world that was ready.
     */
    if (s.gen !== gate.generation) {
      s.gen = gate.generation;
      s.stage = "settle";
      s.started = 0;
      s.sig = "";
      s.stable = 0;
      s.flush = 0;
    }
    if (s.stage === "done") return;

    const t = performance.now();
    if (s.started === 0) s.started = t;
    const elapsed = t - s.started;

    if (s.stage === "settle") {
      const info = gl.info;
      const sig = `${info.memory.geometries}|${info.memory.textures}|${info.programs?.length ?? 0}`;
      if (sig !== s.sig) {
        s.sig = sig;
        s.stable = 0;
      } else {
        s.stable += 1;
      }
      const settled = elapsed >= WARM_MIN_MS && s.stable >= WARM_STABLE_FRAMES;
      const expired = elapsed >= WARM_SETTLE_BUDGET_MS;
      setWorldProgress(
        Math.min(
          0.75,
          Math.max(elapsed / WARM_SETTLE_BUDGET_MS, s.stable / WARM_STABLE_FRAMES) *
            0.75,
        ),
        "Building world",
      );
      if (settled || expired) s.stage = "arm";
      return;
    }

    if (s.stage === "arm") {
      /*
       * Two frames doing nothing but publishing the label, and it has to be two.
       *
       * `gl.compile` blocks for as long as it takes, so the loading screen must
       * have PAINTED "Compiling shaders" before we call it — otherwise the last
       * thing on screen through the freeze is a bar that says "Building world"
       * and then stops, which is what a hang looks like. One frame is not
       * enough: this runs inside rAF, so the setState here commits on React's
       * scheduler task AFTER this frame has already painted. The commit lands
       * between frames, and the next paint is the one that shows it.
       */
      if (s.flush === 0) {
        setWorldProgress(0.8, "Compiling shaders");
        s.flush = WARM_ARM_FRAMES;
      }
      s.flush -= 1;
      if (s.flush > 0) return;
      s.stage = "compile";
      return;
    }

    if (s.stage === "compile") {
      try {
        // Synchronous, for exactly the reason ShaderWarmup documents above:
        // compileAsync re-polls isReady() from a setTimeout loop and throws out
        // of a timer where no .catch() can see it. The cost is one long frame,
        // and this is the one moment in the game where a long frame is free —
        // there is a loading screen over it and the countdown cannot start.
        gl.compile(scene, camera);
      } catch {
        /* warmup is best-effort; a failed compile just means a lazier first lap */
      }
      s.flush = WARM_FLUSH_FRAMES;
      s.stage = "flush";
      return;
    }

    if (s.stage === "flush") {
      setWorldProgress(0.9 + (1 - s.flush / WARM_FLUSH_FRAMES) * 0.1, "Grid ready");
      s.flush -= 1;
      if (s.flush > 0) return;
      s.stage = "done";
      closeRaceGate("world warm");
    }
  }, FRAME.TELEMETRY);

  return null;
}

/**
 * Half-extent of the sun's shadow frustum, in world units.
 *
 * Widened alongside the 4096 high-tier map: 55m of coverage at 4096 is ~37
 * texels/m, better density AND more of the world shadowed than 42m at 2048.
 * Beyond this radius nothing casts, which is the remaining argument for a real
 * multi-cascade setup.
 */
const SHADOW_EXTENT = 55;

/**
 * Key light whose shadow frustum tracks the player.
 *
 * The sun used to sit at a fixed position with its target left at the world
 * origin, so the ±42 unit shadow box only ever covered the middle of the map —
 * drive away from spawn and every shadow silently disappeared. Keeping the
 * light direction constant while sliding the light and its target along with
 * the car gives full-track shadows at the same map resolution (effectively a
 * single tight cascade).
 *
 * The centre is snapped to whole shadow-map texels: without that, sub-texel
 * movement makes shadow edges crawl and shimmer as you drive.
 */
/**
 * Cascaded shadow maps for the sun.
 *
 * The single following cascade below covers SHADOW_EXTENT metres around the
 * car and nothing outside it casts at all — drive up to a ridge and the whole
 * mid-distance is unshadowed, which is the most obvious remaining gap against
 * an engine like UE. CSM splits the view frustum into several cascades so near
 * geometry gets dense texels while distant geometry still casts.
 *
 * CSM owns its own directional lights, so SunLight must NOT also be mounted —
 * two suns would double the diffuse contribution.
 *
 * It also has to patch every shadow-receiving material's shader. Materials here
 * are created lazily (glTF loads, procedural terrain, pooled props), so the
 * scene is re-swept periodically rather than once; `setupMaterial` is
 * idempotent per material and we track which we've handled.
 */
function CascadedSun({ q }: { q: QualitySettings }) {
  const { scene, camera } = useThree();
  const csmRef = useRef<CSM | null>(null);
  const patched = useRef(new WeakSet<THREE.Material>());
  const frame = useRef(0);

  useEffect(() => {
    if (!q.shadowEnabled) return;
    const csm = new CSM({
      maxFar: Math.min(320, (camera as THREE.PerspectiveCamera).far ?? 320),
      cascades: q.tier === "high" ? 4 : 3,
      mode: "practical",
      parent: scene,
      shadowMapSize: q.shadowMapSize,
      // Matches the previous fixed sun direction so the art reads the same.
      lightDirection: new THREE.Vector3(-55, -70, 25).normalize(),
      lightIntensity: 3.0,
      camera,
      shadowBias: -0.00018,
      lightMargin: 220,
    });
    csm.fade = true;
    for (const l of csm.lights) l.color.set("#ffe8c8");
    csmRef.current = csm;
    return () => {
      csm.remove();
      csm.dispose();
      csmRef.current = null;
    };
  }, [scene, camera, q.shadowEnabled, q.shadowMapSize, q.tier]);

  useFrame(() => {
    const csm = csmRef.current;
    if (!csm) return;
    // Re-sweep occasionally: async glTF loads and pooled props introduce new
    // materials long after mount, and an unpatched material silently ignores
    // the cascades (it keeps sampling the old single shadow map slot).
    if (frame.current++ % 45 === 0) {
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.material) return;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) {
          const sm = mat as THREE.MeshStandardMaterial;
          if (!sm?.isMeshStandardMaterial || patched.current.has(sm)) continue;
          patched.current.add(sm);
          try {
            csm.setupMaterial(sm);
          } catch {
            /* a material CSM cannot patch is better skipped than fatal */
          }
        }
      });
    }
    csm.update();
  }, FRAME.LATE);

  return null;
}

function SunLight({ sim, q }: { sim: GameSimulation; q: QualitySettings }) {
  const ref = useRef<THREE.DirectionalLight>(null);
  /*
   * Direction only — magnitude just needs to clear the shadow-camera near
   * plane. Note this is the KEY LIGHT direction, deliberately not the same as
   * the drawn sun disc: the disc has to clear the ridgeline, while the key
   * light's elevation sets shadow length and has to stay inside the 55m
   * cascade. The environments keep their azimuths aligned so shadows still
   * point away from the sun you can see.
   */
  const dir = useMemo(
    () => new THREE.Vector3(...getActiveEnvironment().light.dir),
    [],
  );

  useFrame(() => {
    const light = ref.current;
    if (!light) return;
    const p = sim.state.vehicles.find((v) => v.isPlayer);
    if (!p) return;
    const texel = (SHADOW_EXTENT * 2) / Math.max(1, q.shadowMapSize);
    const cx = Math.round(p.x / texel) * texel;
    const cz = Math.round(p.z / texel) * texel;
    light.position.set(cx + dir.x, dir.y, cz + dir.z);
    light.target.position.set(cx, 0, cz);
    light.target.updateMatrixWorld();
    light.updateMatrixWorld();
  }, FRAME.LATE);

  return (
    <directionalLight
      ref={ref}
      position={getActiveEnvironment().light.dir}
      intensity={getActiveEnvironment().light.intensity}
      color={getActiveEnvironment().light.color}
      castShadow={q.shadowEnabled}
      shadow-mapSize-width={q.shadowMapSize}
      shadow-mapSize-height={q.shadowMapSize}
      shadow-camera-near={5}
      shadow-camera-far={200}
      shadow-camera-left={-SHADOW_EXTENT}
      shadow-camera-right={SHADOW_EXTENT}
      shadow-camera-top={SHADOW_EXTENT}
      shadow-camera-bottom={-SHADOW_EXTENT}
      shadow-bias={-0.00025}
      shadow-normalBias={0.035}
    />
  );
}

function RaceWorld({
  sim,
  input,
  onHud,
  onPauseToggle,
  lastInput,
}: {
  sim: GameSimulation;
  input: InputController;
  onHud: () => void;
  onPauseToggle: () => void;
  lastInput: React.MutableRefObject<PlayerInput | null>;
}) {
  const q = qualityManager.get();
  const trackEpoch = getTrackEpoch();

  useEffect(() => {
    /*
     * Safety net, not the load path.
     *
     * `prepareRaceAssets` has already awaited all three behind the loading
     * screen, so on the normal route these are cache hits that resolve on the
     * microtask queue. They stay because the loading screen is not the only door
     * into a race: the QA `__scrapstorm.startRace` hook and a direct phase
     * mutation both mount this tree with nothing preloaded, and a race with no
     * road texture is worse than one that pops.
     *
     * The 500ms setTimeout that used to wrap the props is gone. It existed to
     * keep the prop fetch off the first frames of the race, which is a sensible
     * thing to want and completely the wrong way to get it — it guaranteed the
     * props landed mid-lap. The gate is how that is bought now.
     */
    void preloadCarModels();
    void preloadPbrLibrary();
    void preloadPhRaceProps();
  }, []);

  /*
   * One read per render of the world tree, not per frame — WorldContent is
   * keyed by track, so this resolves once per circuit.
   */
  const env = getActiveEnvironment();
  const fogNear = env.fog.near;
  const fogFar = q.tier === "low" ? env.fog.farLow : env.fog.far;

  return (
    <>
      <color attach="background" args={[env.sky.background]} />
      <fog attach="fog" args={[env.fog.color, fogNear, fogFar]} />
      <ambientLight
        intensity={env.light.ambient.intensity}
        color={env.light.ambient.color}
      />
      <hemisphereLight
        args={[
          env.light.hemisphere.sky,
          env.light.hemisphere.ground,
          env.light.hemisphere.intensity,
        ]}
      />
      {/*
        REVERTED to the single following cascade.

        CSM was tried here and measurably made things worse: it adds one
        directional light PER cascade, each at full intensity, and only
        materials it has patched know to treat them as one sun sampled by
        depth. Anything unpatched — and the sweep provably left receivers
        unpatched, including the terrain plane — sees three suns at full
        strength. Measured in-scene: 5 directional lights at
        [0.65, 0.3, 3, 3, 3]. Result was an over-lit, flat frame whose shadows
        did not read (a pixel shadowed by one cascade still takes full light
        from the other two), and it cost 3 extra shadow passes: 151fps -> 81fps
        on an RTX 5080.

        Doing this properly needs every shadow-receiving material routed
        through setupMaterial at creation time, not swept periodically after
        the fact. Until that plumbing exists, one tight player-following
        cascade is both cheaper and better looking.
      */}
      <SunLight sim={sim} q={q} />
      <ShaderWarmup />
      {/* Holds the countdown at three until this tree has stopped changing. */}
      <WorldWarmup />
      <AdaptiveResolution />
      <directionalLight
        position={env.light.fill.dir}
        intensity={env.light.fill.intensity}
        color={env.light.fill.color}
      />
      {q.tier !== "low" && (
        <directionalLight
          position={env.light.rim.dir}
          intensity={env.light.rim.intensity}
          color={env.light.rim.color}
        />
      )}
      {q.tier !== "low" && <GpuDetailDriver />}
      <TerrainCullDriver />
      <CullStatsPublisher />
      <EnvLighting />
      <Atmosphere />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.25, 0]} receiveShadow>
        <planeGeometry args={[900, 900]} />
        <meshStandardMaterial
          color={env.surfaces.sand}
          roughness={1}
          metalness={0}
          emissive="#8a6038"
          emissiveIntensity={0.0}
        />
      </mesh>
      <PbrBootstrap>
        <TrackMesh trackEpoch={trackEpoch} />
      </PbrBootstrap>
      {q.tier === "high" && <SceneryDecor />}
      <LiveVehicles sim={sim} />
      <LiveFx sim={sim} />
      <LiveCamera sim={sim} />
      <SimDriver
        sim={sim}
        input={input}
        onHud={onHud}
        onPauseToggle={onPauseToggle}
        lastInput={lastInput}
      />
      <AudioDriver sim={sim} lastInput={lastInput} />
      <PostFxLive sim={sim} />
    </>
  );
}

function WorldContent({
  sim,
  input,
  onHud,
  onPauseToggle,
}: {
  sim: GameSimulation;
  input: InputController;
  onHud: () => void;
  onPauseToggle: () => void;
}) {
  const lastInput = useRef<PlayerInput | null>(null);
  const [showcase, setShowcase] = useState(
    () =>
      sim.state.phase === "menu" ||
      sim.state.phase === "garage" ||
      sim.state.phase === "finished",
  );
  useFrame(() => {
    const p = sim.state.phase;
    const sc = p === "menu" || p === "garage" || p === "finished";
    if (sc !== showcase) setShowcase(sc);
  }, FRAME.LATE);

  return showcase ? (
    <>
      <ShowcaseWorld sim={sim} />
      <SimDriver
        sim={sim}
        input={input}
        onHud={onHud}
        onPauseToggle={onPauseToggle}
        lastInput={lastInput}
      />
    </>
  ) : (
    <RaceWorld
      sim={sim}
      input={input}
      onHud={onHud}
      onPauseToggle={onPauseToggle}
      lastInput={lastInput}
    />
  );
}

export function GameCanvas({
  sim,
  input,
  onHud,
  onPauseToggle,
  sceneKey,
}: {
  sim: GameSimulation;
  input: InputController;
  onHud: () => void;
  onPauseToggle: () => void;
  sceneKey: string;
}) {
  const q = qualityManager.get();
  const dpr = useMemo(() => {
    if (typeof window === "undefined") return 1;
    return Math.min(window.devicePixelRatio || 1, q.dprMax);
  }, [q.dprMax]);

  useEffect(() => {
    // Showcase only needs the hero mesh — not full PBR library / AI cars
    const cls =
      sim.state.vehicles.find((v) => v.isPlayer)?.classId ?? "interceptor";
    void preloadHeroModel(cls);

    const late = window.setTimeout(() => {
      void preloadWasmNoise();
      void probeWebGpu().then((cap) => {
        if (typeof window !== "undefined") {
          window.__webgpuProbe = {
            status: cap.status,
            recommendation: cap.recommendation,
          };
        }
      });
    }, 3000);

    if (typeof window !== "undefined") {
      window.__quality = {
        get: () => qualityManager.get(),
        setTier: (t: "low" | "medium" | "high") =>
          qualityManager.setTier(t, { auto: false }),
        setAuto: (on: boolean) => qualityManager.setAuto(on),
        getFps: () => qualityManager.getFpsEma(),
      };
      // Diagnostics: whether a race is currently held at the grid and why. The
      // symptom of a gate bug is "the countdown never starts", which from the
      // outside is indistinguishable from a hung frame — this is how a probe
      // tells the two apart without guessing from a screenshot.
      window.__raceGate = {
        get: () => getRaceGate(),
        release: () => closeRaceGate("manual release"),
      };
    }
    return () => window.clearTimeout(late);
  }, [sim]);

  return (
    <Canvas
      className="game-canvas"
      dpr={dpr}
      shadows={q.shadowEnabled}
      camera={{ position: [8, 14, 22], fov: 55, near: 0.35, far: 900 }}
      gl={{
        antialias: q.antialias,
        alpha: false,
        powerPreference: "high-performance",
        // Keeping the backbuffer alive costs bandwidth on every frame and
        // blocks the driver from discarding it. QA captures through the
        // compositor now (page.screenshot), so only opt in behind ?capture.
        preserveDrawingBuffer:
          typeof window !== "undefined" &&
          new URLSearchParams(window.location.search).has("capture"),
        stencil: false,
        depth: true,
      }}
      onCreated={({ gl, scene, camera }) => {
        const caps = configureWebGL2Renderer(gl, qualityManager.get());
        // KTX2 needs to probe the renderer for supported compressed formats
        // before any glTF referencing a .ktx2 texture is decoded.
        initGltfDecoders(gl);
        if (typeof window !== "undefined") {
          // Scene handle for QA: lets a probe walk the graph to identify a
          // stray object by geometry/material rather than guessing from a
          // screenshot.
          window.__scene = scene;
          window.__webgl2Caps = caps;
          // Live getters, not a snapshot: gl.info.autoReset is on, so these
          // read the last frame's real numbers, and exposure/intensity are
          // rewritten on every quality-tier change.
          window.__renderDebug = {
            get exposure() {
              return gl.toneMappingExposure;
            },
            get envIntensity() {
              return scene.environmentIntensity;
            },
            get hasEnv() {
              return !!scene.environment;
            },
            get drawCalls() {
              return gl.info.render.calls;
            },
            get triangles() {
              return gl.info.render.triangles;
            },
            get programs() {
              return gl.info.programs?.length ?? 0;
            },
            get textures() {
              return gl.info.memory.textures;
            },
            get geometries() {
              return gl.info.memory.geometries;
            },
            get cam() {
              return [
                +camera.position.x.toFixed(1),
                +camera.position.y.toFixed(1),
                +camera.position.z.toFixed(1),
              ] as [number, number, number];
            },
          };
        }
      }}
      style={{ position: "absolute", inset: 0, touchAction: "none" }}
    >
      <WorldContent
        key={sceneKey}
        sim={sim}
        input={input}
        onHud={onHud}
        onPauseToggle={onPauseToggle}
      />
    </Canvas>
  );
}

/**
 * Rasterise every sprite atlas the effect layers ask for at mount.
 *
 * All of these are canvas draws behind a module-level cache, so the only thing
 * that matters is hitting the same key the consumer will: the sizes below are
 * the ones Effects, VfxScene and Atmosphere actually request, not the defaults.
 * A wrong size is not a failure, just a second atlas nobody uses.
 */
function warmSpriteAtlases(): void {
  const jobs: (() => unknown)[] = [
    () => softSmokeTexture(128),
    () => softCloudTexture(192),
    () => softCircleTexture(),
    () => fireTexture(128),
    () => emberTexture(64),
    () => arcTexture(128, 32),
    () => dropletTexture(64),
    () => shimmerTexture(64),
    () => splatTexture(128),
    () => shockRingTexture(128),
    // Beacon stripes. Cheap, but CulledBeacons asks for it during the mount we
    // are trying to keep quiet.
    () => hazardMap(),
    () => checkerMap(),
  ];
  for (const job of jobs) {
    try {
      job();
    } catch {
      /* a sprite that will not rasterise is a missing decal, not a dead race */
    }
  }
}

/**
 * One item of the load screen.
 *
 * `budgetMs` is not a nicety. The dev server hands out 274MB over HTTP/1.1 with
 * six connections, and a single wedged response would otherwise hold the loading
 * screen open forever — which is a worse outcome than the hitch this whole path
 * exists to remove. On expiry the underlying work is NOT cancelled: it keeps
 * downloading and lands mid-race, exactly as it did before any of this existed.
 * That is the documented degraded mode.
 */
type LoadStep = {
  label: string;
  /** Share of the bar. Roughly proportional to measured cost on a cold cache. */
  weight: number;
  budgetMs: number;
  run: () => Promise<unknown>;
};

/** Ceiling on the terrain bake specifically. It cannot stall, only be slow. */
const TERRAIN_BUDGET_MS = 20_000;

/**
 * Wait for everything a race needs before the lights go green.
 *
 * WHAT CHANGED AND WHY IT MATTERS
 * -------------------------------
 * This used to be five fire-and-await steps whose progress bar reported the
 * index of the step ABOUT to start — so it showed 0/20/40/60/80 and then jumped
 * to 100, regardless of the fact that the first step was worth several seconds
 * and the last was worth a few hundred milliseconds. It also had no timeouts at
 * all: any one of the five could hang the loading screen indefinitely.
 *
 * Now every step carries a weight and a deadline, the terrain bake runs
 * CONCURRENTLY with the downloads (it is pure CPU that yields between slices, so
 * it costs nothing to run it while the network is the bottleneck), and the whole
 * thing feeds a bar that measures real completed work.
 *
 * WHAT IS DELIBERATELY NOT HERE. Anything built inside another component's
 * `useMemo` — the road ribbon, the scatter fields, the set-piece layers, the
 * decor batches — cannot be usefully preloaded, because those components rebuild
 * it themselves on mount and dispose it on unmount with no shared cache. That
 * work is covered by holding the countdown while the world mounts (see
 * `WorldWarmup`), not by doing it twice here.
 *
 * Failures resolve rather than reject throughout: a missing optional pack should
 * delay the grid, not block it.
 */
export async function prepareRaceAssets(
  onProgress?: (pct: number, label: string) => void,
): Promise<void> {
  const tier = qualityManager.get().tier;
  const env = getActiveEnvironment();
  const epoch = getTrackEpoch();
  const segs = terrainSegmentsFor(tier);

  /*
   * The exact sizes SceneryDecor will ask for, derived rather than copied.
   *
   * The template cache is keyed by `key|targetLen`, and the hand-written list
   * inside preloadSceneryModels had already drifted from what decor requests —
   * so coveredCar at 4.6, barrier at 1.7 and three of the four boulder sizes
   * were unwarmed and landed mid-lap. Only high tier mounts SceneryDecor, so
   * only high tier pays for this.
   */
  const decorJobs: [PhModelKey, number][] =
    tier === "high"
      ? buildDecorList(tier).map((d) => [d.key, d.targetLen] as [PhModelKey, number])
      : [];

  const steps: LoadStep[] = [
    // First, and by some distance the heaviest: everything that draws a surface
    // waits on this, and `createProcMaterial` silently falls back to a CPU bake
    // for any material built before it lands.
    { label: "Surfaces", weight: 22, budgetMs: 25_000, run: () => preloadPbrLibrary() },
    { label: "Vehicles", weight: 16, budgetMs: 25_000, run: () => preloadCarModels() },
    {
      // All five, though only some classes carry roof hardware: the projectile
      // and mine meshes are requested by Effects the first time one is fired,
      // which is mid-race by definition. They are cached forever once loaded.
      label: "Weapons",
      weight: 6,
      budgetMs: 15_000,
      run: () =>
        Promise.all(
          (["rocket", "saw", "mine", "turret", "launcher"] as const).map((id) =>
            loadWeaponGeometry(id),
          ),
        ),
    },
    { label: "Track props", weight: 8, budgetMs: 15_000, run: () => preloadPhRaceProps() },
    // Set dressing: SceneryDecor and CullableScenery pull far more keys than the
    // four race props, and they were still arriving mid-lap (props popping in).
    {
      label: "Set dressing",
      weight: 12,
      budgetMs: 20_000,
      run: () => preloadSceneryModels(decorJobs),
    },
    // Warm the HTTP cache for the tier's HDRI. EnvLighting owns the decode, but
    // fetching the file here means the environment is not still downloading
    // when the lights go green — that was the world lighting up seconds late.
    { label: "Lighting", weight: 6, budgetMs: 15_000, run: () => prefetchHdri() },
    {
      /*
       * The post chain is a dynamic import, and it is not requested until
       * PostFxLive sees the phase go to "countdown" — i.e. after the lights are
       * already counting. Pulling the chunk here means only the pass
       * construction and its shader compiles are left, and WorldWarmup covers
       * those. Skipped on low, which never mounts it.
       */
      label: "Post chain",
      weight: 4,
      budgetMs: 12_000,
      run: () => (tier === "low" ? Promise.resolve() : import("./PostFX")),
    },
    {
      label: "Effects",
      weight: 3,
      budgetMs: 5_000,
      run: async () => {
        warmSpriteAtlases();
      },
    },
    {
      /*
       * Whatever else registered itself. This is the seam for modules the loader
       * does not import — audio banks and anything a later feature adds — so
       * that they can join the load phase with one line instead of this file
       * growing a dependency on each of them.
       */
      label: "Systems",
      weight: 4,
      budgetMs: 10_000,
      run: () =>
        Promise.all(
          listRaceWarmTasks().map((t) =>
            withDeadline(Promise.resolve().then(t.run), 8_000, t.label),
          ),
        ),
    },
  ];

  /*
   * The terrain bake is worth nothing on the bar if it is already cached, which
   * is the normal case for a second race on the same circuit — and giving a
   * free step a quarter of the bar is exactly how a progress bar starts lying.
   */
  const cached = getCachedTerrain(terrainKey(segs, env.id, epoch)) !== null;
  const terrainWeight = cached ? 0 : 26;
  const total = steps.reduce((n, s) => n + s.weight, 0) + terrainWeight;

  let done = 0;
  let terrainFrac = cached ? 1 : 0;
  let label = steps[0]!.label;
  const report = () =>
    onProgress?.(
      Math.min(99, Math.round(((done + terrainFrac * terrainWeight) / total) * 100)),
      label,
    );

  /*
   * Concurrent with the downloads, on purpose.
   *
   * This is ~750ms of pure main-thread fBm at the high tier and the network is
   * the bottleneck for most of the load, so running it in the gaps costs
   * essentially nothing in wall clock and takes the single largest stall out of
   * the mount. `buildTerrainAsync` slices itself under one frame, so the garage
   * behind the loading screen keeps animating throughout.
   */
  const terrain = cached
    ? Promise.resolve(null)
    : buildTerrainAsync(segs, env, epoch, (f) => {
        terrainFrac = f;
        report();
      }).catch((e) => {
        // Handled HERE and not at the await below. Nothing observes this promise
        // for several seconds while the download steps run, and an unattached
        // rejection in that window is an uncaught error in the console — and, in
        // a browser configured to break on them, a stop. The mesh falls back to
        // its blocking build.
        console.warn("[prepareRaceAssets] terrain bake failed", e);
        return null;
      });

  report();
  for (const step of steps) {
    label = step.label;
    report();
    await withDeadline(
      Promise.resolve().then(step.run),
      step.budgetMs,
      step.label,
    );
    done += step.weight;
    report();
  }

  if (!cached) {
    label = "Terrain";
    report();
    await withDeadline(terrain, TERRAIN_BUDGET_MS, "Terrain");
    terrainFrac = 1;
  }

  // One more yield before the world is allowed to mount. Everything above just
  // finished uploading textures and geometry; handing the frame back lets the
  // browser flush that before it is asked to build a scene graph on top of it.
  await yieldToBrowser();
  onProgress?.(100, "Ready");
}

export function wireControlsTest(
  sim: GameSimulation,
  input: InputController,
) {
  if (typeof window === "undefined") return;
  window.__controlsTest = {
    getYaw: () => sim.state.vehicles.find((v) => v.isPlayer)?.yaw ?? 0,
    getSpeed: () => sim.state.vehicles.find((v) => v.isPlayer)?.speed ?? 0,
    setSteer: (v: number) => {
      input.forcedSteer = v;
    },
    setKeys: (codes: string[]) => {
      input.keys.clear();
      for (const c of codes) input.keys.add(c);
    },
  };
}

declare global {
  interface Window {
    __controlsTest?: {
      getYaw: () => number;
      getSpeed: () => number;
      setSteer: (v: number) => void;
      setKeys: (codes: string[]) => void;
    };
    __quality?: {
      get: () => ReturnType<typeof qualityManager.get>;
      setTier: (t: "low" | "medium" | "high") => void;
      setAuto: (on: boolean) => void;
      getFps: () => number;
    };
    __raceGate?: {
      get: () => import("./raceGate").RaceGateSnapshot;
      release: () => void;
    };
    __webgl2Caps?: import("./webgl2/configure").WebGL2Caps;
    /** Live scene graph — QA/diagnostics only. */
    __scene?: THREE.Scene;
    /** Current dynamic-resolution multiplier applied under the tier's dprMax. */
    __resScale?: number;
    __webgpuProbe?: { status: string; recommendation: string };
    __terrainCull?: unknown;
    __roadRibbon?: unknown;
  }
}
