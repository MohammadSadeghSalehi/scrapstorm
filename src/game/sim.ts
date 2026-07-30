import { BOT_NAMES, CLASS_ORDER, VEHICLE_CLASSES } from "./classes";
import { RACE, COMBAT } from "./balance";
import { aiInput, catchUpFactor } from "./ai";
import {
  findLockTarget,
  stepMines,
  stepParticles,
  stepProjectiles,
  tryDefense,
  tryPrimary,
  tryUltimate,
} from "./combat";
import { createEmptyInput } from "./input";
import {
  collideVehicles,
  isDrifting,
  spawnDamageSmoke,
  stepVehicle,
} from "./physics";
import {
  collideVehiclesWithProps,
  spawnWorldProps,
  stepWorldProps,
} from "./worldProps";
import {
  CHECKPOINTS,
  TRACK_SAMPLES,
  nearestTrackIndex,
  trackProgress,
  setActiveTrack,
  type TrackId,
} from "./track";
import { makeTires } from "./tires";
import { sharedHitStop, sharedTrauma } from "./world/cameraShake";
import { loadMeta, paintHex } from "./meta";
import { GhostRecorder, getGhost, saveGhostIfBest, type GhostRun } from "./ghost";
import type {
  GameEvent,
  MatchPhase,
  PlayerInput,
  SimState,
  VehicleClassId,
  VehicleState,
} from "./types";

const FIXED_DT = 1 / 60;
/** Cap catch-up so GPU stalls don't spiral into multi-step lag */
const MAX_FIXED_STEPS = 5;
const ACC_CAP = 0.1;

/** Fixed showcase pad near start/finish for garage orbit. */
export const SHOWCASE = {
  x: 12,
  y: 0.55,
  z: -18,
  yaw: Math.PI * 0.35,
};

type VehicleRuntime = {
  prevX: number;
  prevZ: number;
  gateCool: number;
  lapStart: number;
};

const runtime = new Map<string, VehicleRuntime>();

function rt(id: string, v: VehicleState): VehicleRuntime {
  let r = runtime.get(id);
  if (!r) {
    r = { prevX: v.x, prevZ: v.z, gateCool: 0, lapStart: 0 };
    runtime.set(id, r);
  }
  return r;
}

function trackYawAt(index: number, lookAhead = 6): number {
  const n = TRACK_SAMPLES.length;
  const a = TRACK_SAMPLES[index % n]!;
  const b = TRACK_SAMPLES[(index + lookAhead) % n]!;
  return Math.atan2(-(b.x - a.x), -(b.z - a.z));
}

function resolvePaint(classId: VehicleClassId): string {
  const def = VEHICLE_CLASSES[classId];
  try {
    const meta = loadMeta();
    const pid = meta.selectedPaint[classId] ?? "stock";
    return paintHex(classId, pid, def.color);
  } catch {
    return def.color;
  }
}

function makeVehicle(
  id: string,
  name: string,
  classId: VehicleClassId,
  isPlayer: boolean,
  gridIndex: number,
  showcase = false,
): VehicleState {
  const def = VEHICLE_CLASSES[classId];
  // Stagger rows so grid cars don't occupy the same sample
  const startIdx = 2 + gridIndex * 3;
  const sample =
    TRACK_SAMPLES[Math.min(startIdx, TRACK_SAMPLES.length - 1)] ??
    TRACK_SAMPLES[0]!;
  // Wide lanes — half-widths ~1.0; 3.6 keeps bumpers clear on start
  const lane = (gridIndex - 1.5) * 3.6;
  const rx = Math.cos(sample.yaw);
  const rz = -Math.sin(sample.yaw);
  const x = showcase ? SHOWCASE.x : sample.x + rx * lane;
  const z = showcase ? SHOWCASE.z : sample.z + rz * lane;
  const y = showcase ? SHOWCASE.y : sample.y + 0.55;
  const yaw = showcase ? SHOWCASE.yaw : trackYawAt(startIdx);

  return {
    id,
    name,
    isPlayer,
    classId,
    x,
    y,
    z,
    yaw,
    speed: 0,
    lateral: 0,
    health: def.health,
    maxHealth: def.health,
    shield: 0,
    weaponCharge: 0.35,
    shieldCharge: 0.4,
    ultimateCharge: 0.15,
    primaryCooldown: 0,
    defenseCooldown: 0,
    ultimateActive: 0,
    defenseActive: 0,
    decoyActive: 0,
    invuln: isPlayer ? 1.5 : 0.5,
    wreckTimer: 0,
    boostTimer: 0,
    lap: 0,
    checkpoint: 1,
    raceProgress: trackProgress(x, z, 0, 1, yaw),
    finished: false,
    finishTime: 0,
    position: gridIndex + 1,
    color: isPlayer ? resolvePaint(classId) : def.color,
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
    tireLoad: 0,
    tireSlip: 0,
    tireTemp: 42,
    tireTempBand: "warm",
    driftMeter: 0,
    uiAccel: 0,
    lapTimes: [],
    lastLapTime: 0,
  };
}

function pushEvent(state: SimState, kind: GameEvent["kind"], message: string) {
  state.events.unshift({ t: state.time, kind, message });
  if (state.events.length > 12) state.events.length = 12;
}

function buildField(
  guestName: string,
  classId: VehicleClassId,
  showcase: boolean,
): VehicleState[] {
  const list: VehicleState[] = [];
  list.push(makeVehicle("player", guestName || "Racer", classId, true, 0, showcase));
  const others = CLASS_ORDER.filter((c) => c !== classId);
  for (let i = 0; i < 3; i++) {
    const botClass = others[i % others.length] ?? "bruiser";
    list.push(
      makeVehicle(
        `bot-${i}`,
        BOT_NAMES[i % BOT_NAMES.length]!,
        botClass,
        false,
        i + 1,
        false,
      ),
    );
  }
  return list;
}

function createState(
  guestName: string,
  classId: VehicleClassId,
  trackId: TrackId = "ash_spire",
): SimState {
  setActiveTrack(trackId);
  return {
    phase: "menu",
    resumePhase: null,
    time: 0,
    raceTime: 0,
    countdown: RACE.countdownSec,
    vehicles: buildField(guestName, classId, true),
    projectiles: [],
    mines: [],
    particles: [],
    props: spawnWorldProps(),
    events: [],
    lapCount: RACE.laps,
    seed: (Date.now() % 1e9) | 0,
    playerId: "player",
    guestName,
    selectedClass: classId,
    selectedTrack: trackId,
    finishedOrder: [],
    cameraShake: 0,
    cameraKick: null,
    lastHitFlash: 0,
    scrapEarned: 0,
    bestLapThisRace: null,
    ghostBeaten: false,
    ghostSaved: false,
  };
}

function updateCheckpoints(v: VehicleState, state: SimState, dt: number) {
  if (v.finished || v.wreckTimer > 0) {
    if (v.finished) {
      v.raceProgress = Math.max(
        v.raceProgress,
        state.lapCount + 0.001 * (1000 - (v.finishTime || 0)),
      );
    }
    const r = rt(v.id, v);
    r.prevX = v.x;
    r.prevZ = v.z;
    return;
  }

  const r = rt(v.id, v);
  r.gateCool = Math.max(0, r.gateCool - dt);
  const n = CHECKPOINTS.length;
  if (n <= 0) return;

  const gateIdx = ((v.checkpoint % n) + n) % n;
  const gate = CHECKPOINTS[gateIdx];
  if (!gate) return;

  const dx = v.x - gate.x;
  const dz = v.z - gate.z;
  const along = dx * gate.nx + dz * gate.nz;
  const across = -dx * gate.nz + dz * gate.nx;
  const prevAlong =
    (r.prevX - gate.x) * gate.nx + (r.prevZ - gate.z) * gate.nz;

  if (
    r.gateCool <= 0 &&
    prevAlong < 0.35 &&
    along >= -0.15 &&
    prevAlong < along &&
    Math.abs(across) < gate.halfWidth * 1.05
  ) {
    r.gateCool = 0.6;
    const isStart = gateIdx === 0;
    v.checkpoint = (gateIdx + 1) % n;
    if (isStart) {
      v.lap += 1;
      const lapTime = state.raceTime - r.lapStart;
      if (r.lapStart > 0 && lapTime > 0.4) {
        v.lapTimes.push(lapTime);
        v.lastLapTime = lapTime;
        if (state.bestLapThisRace == null || lapTime < state.bestLapThisRace) {
          state.bestLapThisRace = lapTime;
        }
        if (v.isPlayer) {
          pushEvent(state, "lap", `Lap ${v.lap} · ${lapTime.toFixed(2)}s`);
        }
      } else if (r.lapStart === 0 && v.isPlayer && v.lap === 1) {
        pushEvent(state, "lap", `Lap ${v.lap}`);
      }
      r.lapStart = state.raceTime;
      if (v.lap >= state.lapCount) {
        v.finished = true;
        v.finishTime = state.raceTime;
        if (!state.finishedOrder.includes(v.id)) {
          state.finishedOrder.push(v.id);
        }
        if (v.isPlayer) {
          pushEvent(
            state,
            "finish",
            `Finished P${state.finishedOrder.indexOf(v.id) + 1}`,
          );
        }
      }
    }
  }

  r.prevX = v.x;
  r.prevZ = v.z;
  const prog = trackProgress(v.x, v.z, v.lap, v.checkpoint, v.yaw);
  if (prog >= v.raceProgress - 0.04 || Math.floor(prog) > Math.floor(v.raceProgress)) {
    v.raceProgress = prog;
  } else {
    v.raceProgress = v.raceProgress * 0.92 + prog * 0.08;
  }
}

function updateStandings(state: SimState) {
  const order = state.finishedOrder;
  [...state.vehicles]
    .sort((a, b) => {
      if (a.finished && b.finished) {
        const ia = order.indexOf(a.id);
        const ib = order.indexOf(b.id);
        if (ia >= 0 && ib >= 0) return ia - ib;
        return (a.finishTime || 0) - (b.finishTime || 0);
      }
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      const dp = b.raceProgress - a.raceProgress;
      if (dp > 0.01) return 1;
      if (dp < -0.01) return -1;
      if (a.position === b.position) {
        if (Math.abs(b.speed - a.speed) > 1.5) return b.speed - a.speed;
        return a.id.localeCompare(b.id);
      }
      return a.position - b.position;
    })
    .forEach((v, i) => {
      v.position = i + 1;
    });
}

function updateWrecks(state: SimState, dt: number) {
  for (const v of state.vehicles) {
    if (v.wreckTimer > 0) {
      v.wreckTimer = Math.max(0, v.wreckTimer - dt);
      if (v.wreckTimer <= 0) {
        const idx = nearestTrackIndex(v.x, v.z, v.yaw);
        const s = TRACK_SAMPLES[idx]!;
        v.x = s.x;
        v.y = s.y + 0.55;
        v.z = s.z;
        v.yaw = s.yaw;
        v.speed = 0;
        v.lateral = 0;
        v.health = v.maxHealth * COMBAT.wreckRespawnHp;
        v.damageVisual = Math.min(0.55, v.damageVisual);
        v.invuln = COMBAT.wreckInvuln;
        v.alive = true;
        if (v.isPlayer) {
          pushEvent(state, "respawn", "Respawned · armor patched");
        }
      }
    }
    if (v.invuln > 0) v.invuln = Math.max(0, v.invuln - dt);
  }
}

export class GameSimulation {
  state: SimState;
  worldEpoch = 0;
  activeGhost: GhostRun | null = null;
  accumulator = 0;
  lastPlayerHealth = 999;
  ghostRecorder = new GhostRecorder();
  ghostFinalized = false;

  constructor(
    guestName = "Racer",
    classId: VehicleClassId = "interceptor",
    trackId: TrackId = "ash_spire",
  ) {
    this.state = createState(guestName, classId, trackId);
    this.activeGhost = getGhost(trackId);
    this.lastPlayerHealth =
      this.state.vehicles.find((v) => v.isPlayer)?.health ?? 999;
  }

  setGuest(name: string, classId: VehicleClassId) {
    this.state.guestName = name;
    this.state.selectedClass = classId;
    if (
      this.state.phase === "menu" ||
      this.state.phase === "garage" ||
      this.state.phase === "finished"
    ) {
      this.rebuildShowcase();
    }
  }

  setTrack(trackId: TrackId) {
    this.state.selectedTrack = trackId;
    setActiveTrack(trackId);
    this.state.props = spawnWorldProps();
    this.activeGhost = getGhost(trackId);
    if (
      this.state.phase === "menu" ||
      this.state.phase === "garage" ||
      this.state.phase === "finished"
    ) {
      this.rebuildShowcase();
    } else {
      this.worldEpoch += 1;
    }
  }

  applyPaintColor(hex: string) {
    const p = this.state.vehicles.find((v) => v.isPlayer);
    if (p) p.color = hex;
  }

  rebuildShowcase() {
    runtime.clear();
    this.state.vehicles = buildField(
      this.state.guestName,
      this.state.selectedClass,
      true,
    );
    this.state.props = spawnWorldProps();
    this.state.projectiles = [];
    this.state.mines = [];
    this.state.particles = [];
    this.state.events = [];
    this.state.finishedOrder = [];
    this.state.scrapEarned = 0;
    this.state.bestLapThisRace = null;
    this.state.ghostBeaten = false;
    this.state.ghostSaved = false;
    this.activeGhost = getGhost(this.state.selectedTrack);
    this.worldEpoch += 1;
    this.lastPlayerHealth =
      this.state.vehicles.find((v) => v.isPlayer)?.health ?? 999;
  }

  setPhase(phase: MatchPhase) {
    if (phase === "countdown") {
      this.startCountdown();
      return;
    }
    if (phase === "menu" || phase === "garage") {
      this.state.phase = phase;
      this.rebuildShowcase();
      return;
    }
    if (phase === "paused" && this.state.phase === "racing") {
      this.state.resumePhase = "racing";
      this.state.phase = "paused";
      return;
    }
    // Only "racing", "finished" and a non-racing "paused" reach here, and none
    // of them change world content — the track, vehicles and props are already
    // whatever startCountdown/rebuildShowcase built. worldEpoch feeds sceneKey,
    // and WorldContent is keyed on it, so bumping here tore down and rebuilt
    // the entire 3D scene (terrain, ~70 scenery props, every car, the effect
    // composer) on countdown -> racing — i.e. precisely when the lights go
    // green. The transitions that really do rebuild bump the epoch themselves.
    this.state.phase = phase;
  }

  startCountdown() {
    setActiveTrack(this.state.selectedTrack);
    runtime.clear();
    this.ghostRecorder.reset();
    this.ghostFinalized = false;
    this.activeGhost = getGhost(this.state.selectedTrack);
    this.state.vehicles = buildField(
      this.state.guestName,
      this.state.selectedClass,
      false,
    );
    this.state.props = spawnWorldProps();
    this.state.projectiles = [];
    this.state.mines = [];
    this.state.particles = [];
    this.state.events = [];
    this.state.finishedOrder = [];
    this.state.raceTime = 0;
    this.state.countdown = RACE.countdownSec;
    this.state.cameraShake = 0;
    this.state.cameraKick = null;
    this.state.lastHitFlash = 0;
    this.state.scrapEarned = 0;
    this.state.bestLapThisRace = null;
    this.state.ghostBeaten = false;
    this.state.ghostSaved = false;
    this.state.phase = "countdown";
    this.worldEpoch += 1;
    this.accumulator = 0;
    this.lastPlayerHealth =
      this.state.vehicles.find((v) => v.isPlayer)?.health ?? 999;
    for (const v of this.state.vehicles) {
      const r = rt(v.id, v);
      r.prevX = v.x;
      r.prevZ = v.z;
      r.gateCool = 0;
      r.lapStart = 0;
      v.checkpoint = 1;
      v.lap = 0;
    }
    pushEvent(this.state, "boost", "Grid locked · heat live");
  }

  togglePause() {
    if (this.state.phase === "racing") {
      this.state.resumePhase = "racing";
      this.state.phase = "paused";
    } else if (this.state.phase === "paused") {
      this.resume();
    }
  }

  resume() {
    if (this.state.phase === "paused") {
      this.state.phase = this.state.resumePhase ?? "racing";
      this.state.resumePhase = null;
    }
  }

  restartRace() {
    this.startCountdown();
  }

  tick(dt: number, playerInput: PlayerInput | null) {
    const state = this.state;
    if (
      state.phase === "paused" ||
      state.phase === "menu" ||
      state.phase === "garage"
    ) {
      state.time += dt;
      for (const v of state.vehicles) {
        if (v.isPlayer && (state.phase === "menu" || state.phase === "garage")) {
          v.yaw += dt * 0.15;
        }
      }
      return;
    }
    if (state.phase === "finished") {
      state.time += dt;
      return;
    }
    // Hit-stop: slow clock presentation
    if (sharedHitStop.tick(dt)) {
      state.time += dt * 0.15;
      return;
    }
    this.accumulator += Math.min(dt, ACC_CAP);
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_FIXED_STEPS) {
      this.fixedStep(FIXED_DT, playerInput);
      this.accumulator -= FIXED_DT;
      steps += 1;
    }
    if (this.accumulator > FIXED_DT * 2) this.accumulator = 0;
  }

  fixedStep(dt: number, playerInput: PlayerInput | null) {
    const state = this.state;
    state.time += dt;
    state.cameraShake = Math.max(0, state.cameraShake - dt * 2.2);
    state.lastHitFlash = Math.max(0, state.lastHitFlash - dt);
    if (state.cameraShake < 0.02) state.cameraKick = null;

    if (state.phase === "countdown") {
      state.countdown -= dt;
      for (const v of state.vehicles) {
        v.speed = 0;
        v.lateral = 0;
        v.invuln = Math.max(0, v.invuln - dt);
      }
      if (state.countdown <= 0) {
        state.countdown = 0;
        state.phase = "racing";
        state.raceTime = 0;
        for (const v of state.vehicles) {
          rt(v.id, v).lapStart = 0;
        }
        pushEvent(state, "boost", "GREEN — push");
      }
      return;
    }
    if (state.phase !== "racing") return;

    state.raceTime += dt;

    for (const v of state.vehicles) {
      if (v.finished) {
        v.speed *= Math.max(0, 1 - 1.8 * dt);
        v.lateral *= Math.max(0, 1 - 3 * dt);
        continue;
      }

      const input = v.isPlayer
        ? (playerInput ?? createEmptyInput())
        : aiInput(v, state.vehicles, state.time);
      const drifting = isDrifting(v, input);
      const catchUp = v.isPlayer ? 0 : catchUpFactor(v, state.vehicles);

      v.weaponCharge = Math.min(1, v.weaponCharge + COMBAT.weaponIdle * dt);
      v.shieldCharge = Math.min(1, v.shieldCharge + COMBAT.shieldIdle * dt);
      v.ultimateCharge = Math.min(1, v.ultimateCharge + COMBAT.ultimateIdle * dt);
      if (v.defenseActive > 0) v.defenseActive = Math.max(0, v.defenseActive - dt);
      if (v.ultimateActive > 0) v.ultimateActive = Math.max(0, v.ultimateActive - dt);
      if (v.decoyActive > 0) v.decoyActive = Math.max(0, v.decoyActive - dt);
      if (v.primaryCooldown > 0) v.primaryCooldown = Math.max(0, v.primaryCooldown - dt);
      if (v.defenseCooldown > 0) v.defenseCooldown = Math.max(0, v.defenseCooldown - dt);
      if (v.boostTimer > 0) v.boostTimer = Math.max(0, v.boostTimer - dt);
      if (v.nearMissBoost > 0) v.nearMissBoost = Math.max(0, v.nearMissBoost - dt);

      stepVehicle(v, input, dt, {
        drifting,
        particles: state.particles,
        catchUp,
      });
      spawnDamageSmoke(v, state.particles, dt);

      const def = VEHICLE_CLASSES[v.classId];
      v.lockTargetId = findLockTarget(v, state.vehicles, def.primaryRange * 1.12);
      tryPrimary(v, input, state.projectiles, state.vehicles);
      tryDefense(v, input, state.vehicles);
      tryUltimate(v, input, state.mines);
      updateCheckpoints(v, state, dt);
    }

    // Two-pass collisions: first with FX, second resolve residual
    for (let pass = 0; pass < 2; pass++) {
      const parts = pass === 0 ? state.particles : null;
      for (let i = 0; i < state.vehicles.length; i++) {
        for (let j = i + 1; j < state.vehicles.length; j++) {
          const impact = collideVehicles(
            state.vehicles[i]!,
            state.vehicles[j]!,
            parts,
          );
          if (pass === 0 && impact > 16) {
            const a = state.vehicles[i]!;
            const b = state.vehicles[j]!;
            state.cameraShake = Math.min(1.2, state.cameraShake + 0.25 + impact * 0.008);
            state.cameraKick = { x: b.x - a.x, z: b.z - a.z };
            if (impact > 28 && (a.isPlayer || b.isPlayer)) {
              sharedHitStop.add(0.045 + Math.min(0.06, (impact - 28) * 0.002));
              sharedTrauma.add(0.2 + Math.min(0.35, impact * 0.004), {
                x: b.x - a.x,
                z: b.z - a.z,
              });
            }
          }
        }
      }
    }

    const propImpact = collideVehiclesWithProps(
      state.vehicles,
      state.props,
      state.particles,
    );
    if (propImpact > 14) {
      state.cameraShake = Math.min(1, state.cameraShake + 0.12 + propImpact * 0.004);
    }
    stepWorldProps(state.props, dt);
    stepProjectiles(state.projectiles, state.vehicles, state.particles, dt);
    stepMines(state.mines, state.vehicles, state.particles, dt);
    stepParticles(state.particles, dt);
    // Keep particle pool modest for GPU
    if (state.particles.length > 90) state.particles.length = 90;

    updateWrecks(state, dt);
    updateStandings(state);

    const player = state.vehicles.find((v) => v.isPlayer);
    if (player && player.health < this.lastPlayerHealth - 1) {
      const dmg = this.lastPlayerHealth - player.health;
      state.lastHitFlash = 0.25;
      state.cameraShake = Math.min(1, state.cameraShake + 0.2);
      state.cameraKick = {
        x: Math.sin(player.yaw),
        z: Math.cos(player.yaw),
      };
      if (dmg > 8) sharedHitStop.add(0.05);
      sharedTrauma.add(Math.min(0.45, 0.12 + dmg * 0.015));
    }
    if (player) this.lastPlayerHealth = player.health;

    if (player && !player.finished) {
      this.ghostRecorder.push(
        dt,
        state.raceTime,
        player.x,
        player.y,
        player.z,
        player.yaw,
      );
    }
    if (
      player?.finished &&
      state.raceTime > player.finishTime + 2.2
    ) {
      this.finalizeGhost(player);
      state.phase = "finished";
    }
    if (state.raceTime > RACE.maxRaceTime) {
      if (player) this.finalizeGhost(player);
      state.phase = "finished";
    }
  }

  finalizeGhost(player: VehicleState) {
    if (this.ghostFinalized) return;
    this.ghostFinalized = true;
    const samples = this.ghostRecorder.finalize();
    if (samples.length < 8) return;
    const run: GhostRun = {
      trackId: this.state.selectedTrack,
      classId: player.classId,
      name: player.name,
      color: player.color,
      totalTime: player.finishTime || this.state.raceTime,
      samples,
      savedAt: Date.now(),
    };
    const prev = getGhost(this.state.selectedTrack);
    const saved = saveGhostIfBest(run);
    this.state.ghostSaved = saved;
    if (prev && run.totalTime < prev.totalTime) {
      this.state.ghostBeaten = true;
    }
    if (saved) this.activeGhost = run;
  }
}
