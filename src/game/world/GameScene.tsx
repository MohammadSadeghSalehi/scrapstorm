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
import { sharedTrauma } from "./cameraShake";
import { getRivalGhost, subscribeRivalGhost } from "../ghostDuel";
import { FRAME } from "./framePriority";
import { PhysicsPropsView } from "./PhysicsPropsView";
import { SceneryDecor } from "./SceneryDecor";
import { preloadPhRaceProps, preloadSceneryModels } from "./polyHavenAssets";

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

function VehicleView(props: {
  vehicle: VehicleState;
  vehicleId?: string;
  sim?: GameSimulation;
  ghost?: boolean;
  forceHero?: boolean;
}) {
  if (USE_GLTF_CARS && !props.ghost) {
    return (
      <GltfVehicleMesh
        vehicle={props.vehicle}
        vehicleId={props.vehicleId}
        sim={props.sim}
        ghost={props.ghost}
        forceHero={props.forceHero}
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
  const ready = useRef(false);
  const traumaSys = useRef(sharedTrauma);
  const boostPunch = useRef(0);
  const hitPunch = useRef(0);
  const prevBoost = useRef(0);
  const prevFlash = useRef(0);
  const prevShake = useRef(0);

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

    const fx = -Math.sin(target.yaw);
    const fz = -Math.cos(target.yaw);
    const speed = Math.abs(target.speed);
    const dist =
      (racing ? 13.5 + Math.min(3.2, speed * 0.035) : 16) -
      boostPunch.current * 0.8 +
      hitPunch.current * 0.4;
    const height =
      (racing ? 7.2 + Math.min(1.6, speed * 0.025) : 8) + hitPunch.current * 0.25;
    const lookAhead = 10 + Math.min(7, speed * 0.09) + boostPunch.current * 1.5;

    desired.current.set(
      target.x - fx * dist,
      target.y + height,
      target.z - fz * dist,
    );
    const tSec = performance.now() * 0.001;
    const s = ts.sample(tSec);
    desired.current.x += s.ox;
    desired.current.y += s.oy;
    desired.current.z += s.oz;

    if (!ready.current) {
      camera.position.copy(desired.current);
      ready.current = true;
    } else {
      const lag =
        target.boostTimer > 0 ? 4.2 : hitPunch.current > 0.2 ? 7.5 : 5.2;
      const k = 1 - Math.exp(-lag * dt);
      camera.position.lerp(desired.current, k);
    }
    look.current.set(
      target.x + fx * lookAhead,
      target.y + 1 + (target.boostTimer > 0 ? 0.25 : 0),
      target.z + fz * lookAhead,
    );
    camera.lookAt(look.current);
    if (s.roll !== 0 || s.pitch !== 0) {
      camera.rotateZ(s.roll);
      camera.rotateX(s.pitch);
    }
    const cam = camera as THREE.PerspectiveCamera;
    if (cam.isPerspectiveCamera) {
      const targetFov =
        56 +
        Math.min(18, speed * 0.24) +
        (target.boostTimer > 0 ? 7 : 0) +
        (target.driftMeter > 0.5 ? 2.5 : 0) +
        boostPunch.current * 8 +
        hitPunch.current * 4 +
        ts.magnitude * 3;
      cam.fov = THREE.MathUtils.lerp(
        cam.fov,
        targetFov,
        1 - Math.exp(-3.6 * dt),
      );
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
    const t = Math.max(0, sim.state.raceTime);
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
      {!showcase &&
        vehicles
          .filter((v) => v.decoyActive > 0)
          .map((v) => {
            const ghost = {
              ...v,
              x: v.x + Math.cos(v.yaw) * 4,
              z: v.z - Math.sin(v.yaw) * 4,
              id: `${v.id}-decoy`,
            };
            return <VehicleView key={ghost.id} vehicle={ghost} ghost />;
          })}
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
      <ParticlesView particles={state.particles} />
      <VehicleFX vehicles={state.vehicles} />
      {tier !== "low" && <SpeedStreaks player={player} />}
      {tier !== "low" && <DraftWake player={player} vehicles={state.vehicles} />}
      <NearMissPulse player={player} />
      <LockLine self={player} target={lockTarget} />
      <Nameplates vehicles={state.vehicles} />
      <GhostVehicle sim={sim} />
      <PhysicsPropsView sim={sim} />
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
  useFrame((state, delta) => {
    // Earliest band (FRAME.SIM), so the counters accumulate across every pass
    // of the frame that follows and the HUD reads a real total.
    state.gl.info.reset();
    if (input.consumePause()) onPauseToggle();
    acc.current += Math.min(delta, SIM_DELTA_CLAMP);
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
    if (steps > 0) onHud();
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

function PostFxLive({ sim }: { sim: GameSimulation }) {
  const [boost, setBoost] = useState(false);
  const [hit, setHit] = useState(false);
  const [speedNorm, setSpeedNorm] = useState(0);
  const [drifting, setDrifting] = useState(false);
  const [on, setOn] = useState(false);
  const [tier, setTier] = useState(qualityManager.get().tier);
  const [PostFX, setPostFX] = useState<null | typeof import("./PostFX").PostFX>(
    null,
  );

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
    const b = (player?.boostTimer ?? 0) > 0;
    const h = (player?.impactFlash ?? 0) > 0.15;
    const sn = Math.min(1, Math.abs(player?.speed ?? 0) / 84);
    const d = (player?.driftMeter ?? 0) > 0.12;
    if (b !== boost) setBoost(b);
    if (h !== hit) setHit(h);
    if (Math.abs(sn - speedNorm) > 0.04) setSpeedNorm(sn);
    if (d !== drifting) setDrifting(d);
  }, FRAME.LATE);

  if (!on || tier === "low" || !PostFX) return null;
  return (
    <PostFX boost={boost} hit={hit} speedNorm={speedNorm} drifting={drifting} />
  );
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
      const r = gl as THREE.WebGLRenderer & {
        compileAsync?: (
          scene: THREE.Object3D,
          camera: THREE.Camera,
        ) => Promise<unknown>;
      };
      try {
        if (typeof r.compileAsync === "function") {
          void r.compileAsync(scene, camera);
        } else {
          // Synchronous fallback: still better than hitching mid-race.
          gl.compile(scene, camera);
        }
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
  // Direction only — magnitude just needs to clear the shadow-camera near plane.
  const dir = useMemo(() => new THREE.Vector3(55, 70, -25), []);

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
      position={[55, 70, -25]}
      intensity={3.0}
      color="#ffe8c8"
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
    // Race-only assets
    void preloadCarModels();
    void preloadPbrLibrary();
    const t = window.setTimeout(() => {
      void preloadPhRaceProps();
    }, 500);
    return () => window.clearTimeout(t);
  }, []);

  const fogNear = 120;
  const fogFar = q.tier === "low" ? 480 : 720;

  return (
    <>
      <color attach="background" args={["#5a7a9e"]} />
      <fog attach="fog" args={["#c8b090", fogNear, fogFar]} />
      <ambientLight intensity={0.62} color="#f4e4c8" />
      <hemisphereLight args={["#ffc898", "#2a1810", 1.1]} />
      {/* CSM owns its own directional lights, so exactly one of these may be
          mounted — two suns would double the diffuse contribution. */}
      {q.shadowEnabled ? <CascadedSun q={q} /> : <SunLight sim={sim} q={q} />}
      <ShaderWarmup />
      <AdaptiveResolution />
      <directionalLight position={[-40, 22, 40]} intensity={0.65} color="#88b8e8" />
      {q.tier !== "low" && (
        <directionalLight position={[20, 12, 30]} intensity={0.3} color="#ffd0a0" />
      )}
      {q.tier !== "low" && <GpuDetailDriver />}
      <TerrainCullDriver />
      <CullStatsPublisher />
      <EnvLighting />
      <Atmosphere />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.25, 0]} receiveShadow>
        <planeGeometry args={[900, 900]} />
        <meshStandardMaterial
          color="#c8a070"
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
 * Wait for everything a race needs before the lights go green.
 *
 * These preloads used to run *during* the race, so the opening lap paid for
 * texture decode, glTF parsing and prop instancing as they landed — props
 * popping in, the world lighting up several seconds late, and frame spikes
 * exactly when the field is bunched and accelerating. Paying for it up front
 * behind a loading state trades a few seconds of wait for a clean start.
 *
 * Failures resolve rather than reject: a missing optional pack should delay
 * the grid, not block it.
 */
export async function prepareRaceAssets(
  onProgress?: (pct: number, label: string) => void,
): Promise<void> {
  const steps: [string, () => Promise<unknown>][] = [
    ["Surfaces", () => preloadPbrLibrary()],
    ["Vehicles", () => preloadCarModels()],
    ["Track props", () => preloadPhRaceProps()],
    // Set dressing: SceneryDecor pulls far more keys than the four race props,
    // and they were still arriving mid-lap (props visibly popping in).
    ["Set dressing", () => preloadSceneryModels()],
    // Warm the HTTP cache for the tier's HDRI. EnvLighting owns the decode, but
    // fetching the file here means the environment is not still downloading
    // when the lights go green — that was the world lighting up seconds late.
    ["Lighting", () => prefetchHdri()],
  ];
  for (let i = 0; i < steps.length; i++) {
    const [label, run] = steps[i]!;
    onProgress?.(Math.round((i / steps.length) * 100), label);
    try {
      await run();
    } catch {
      /* optional asset — never block the grid */
    }
  }
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
