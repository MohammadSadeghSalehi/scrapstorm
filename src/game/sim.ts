import {
  BOT_NAMES,
  CLASS_ORDER,
  VEHICLE_CLASSES,
  getFieldRoster,
  slotOfVehicle,
} from "./classes";
import { RACE, COMBAT, FEEL } from "./balance";
import { aiInput, aiSkill, catchUpFactor } from "./ai";
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
  isHandbrakeDrift,
  resetDriftState,
  resetSteerRamp,
  spawnDamageSmoke,
  stepVehicle,
  worldVelocity,
} from "./physics";
import {
  collideVehiclesWithProps,
  spawnWorldProps,
  stepWorldProps,
} from "./worldProps";
import {
  // CHECKPOINTS has the same live-binding problem as TRACK_SAMPLES did and
  // track.ts exports no accessor for it. See the report: one added
  // `getCheckpoints()` there makes this file fully testable off a real circuit.
  getCheckpoints,
  getGroundHeight,
  getTrackDef,
  getTrackLength,
  getTrackSamples,
  getTrackEpoch,
  nearestTrackIndex,
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

/* ── starting grid ───────────────────────────────────────────────────
 *
 * Rows are measured in SAMPLES because that is what the track exposes, and
 * every circuit in the catalogue is resampled to TARGET_SAMPLE_SPACING — a
 * measured 3.12-3.16m mean on all six — so three samples is 9.4m everywhere
 * rather than a different distance per road. If a future circuit ever changes
 * that, this is the constant that has to become metres.
 */
/**
 * Two abreast, two deep. A four-car single file spread the field over 28m of
 * road and put P4 far enough back that the start was decided before anyone
 * touched a corner; two rows of two is a start line, and it puts the player's
 * only front-row company where they can be seen and hit.
 */
const GRID_ROWS = 2;
const GRID_COLS = 2;
/** Samples between grid rows. ~9.4m — over two Bruiser lengths (halfL 1.95). */
const GRID_ROW_SAMPLES = 3;
/**
 * Sample index of the REAR row. The front row therefore lands on sample 11,
 * exactly where the previous four-row ladder put pole, so the length of lap one
 * is unchanged and every authored pace target still means what it measured.
 *
 * Both rows stay inside worldProps' GRID_CLEAR (>= 8 samples, and 6% of the
 * sample count on every circuit in the catalogue, which is more), so the launch
 * straight is still swept of barrels and verge posts.
 */
const GRID_REAR_SAMPLE = 8;
/**
 * Metres either side of the centreline, so the two cars in a row sit 6.8m
 * apart. Measured (scripts/balance-grid.mjs): 4.36m of air between the widest
 * pair of bodies, and 6.38m from the outer flank to the road edge on the
 * narrowest start line in the catalogue (Cinder Bowl, 22m).
 */
const GRID_LANE_M = 3.4;

/**
 * Hysteresis on a position change, in METRES of centreline progress.
 *
 * This used to be a flat 0.01 of `raceProgress`, which is 1% of A LAP — 6.6m on
 * the Foundry Pit and 17m on the Dead Mile. Two cars seventeen metres apart
 * being called a tie is not hysteresis, it is a standings table that lags a pass
 * by most of a straight, and it lagged it by a different amount on every
 * circuit. Expressed in metres it is the same on all six.
 */
const STANDINGS_HOLD_M = 4;

/**
 * Seconds after a gate registers during which no gate may register.
 *
 * This was 0.6s, and 0.6s is LONGER THAN THE GAP BETWEEN TWO GATES on the fast
 * circuits. Gate spacing is 41m at its tightest (Cinder Bowl; Foundry Pit 46m,
 * Rustline 55m), and a car at 80 m/s covers 41m in 0.51s — a drift boost or an
 * Overdrive Lock takes that to 104 m/s and 0.39s. Any car quick enough through
 * that stretch had the NEXT gate swallowed by the cooldown, and since
 * `v.checkpoint` only advances on a registered crossing, the miss is not
 * cosmetic: the car cannot complete the lap until it comes round and takes the
 * skipped gate again.
 *
 * The cooldown only ever needed to stop one crossing double-registering across
 * consecutive steps, and the gate list advances on every trigger anyway, so
 * 0.15s does that job with a factor of three in hand: 15m at the very highest
 * speed in the game, against a 41m minimum gate spacing.
 */
const GATE_COOLDOWN = 0.15;

/**
 * Gate half-width, as a multiple of the authored `halfWidth` (0.62 x road).
 *
 * At 1.05 a gate reached only 0.65 of the road's width from the centreline —
 * about 4m past the tarmac edge on a 26m road, i.e. inside the apron. A car that
 * ran wide onto the sand at a gate simply did not register it, and then, exactly
 * as above, could not finish the lap. Widening to ~1.0 x the full road width
 * covers the apron and several metres of sand.
 *
 * It cannot let a car claim a gate from the wrong leg of the loop: the widest
 * this produces is 28m on the Dead Mile, whose two legs pass ~95m apart, and the
 * crossing still has to be through the plane in the forward direction.
 */
const GATE_WIDTH_MUL = 1.6;

function rt(id: string, v: VehicleState): VehicleRuntime {
  let r = runtime.get(id);
  if (!r) {
    r = { prevX: v.x, prevZ: v.z, gateCool: 0, lapStart: 0 };
    runtime.set(id, r);
  }
  return r;
}

/*
 * getTrackSamples(), not the TRACK_SAMPLES binding.
 *
 * `export let TRACK_SAMPLES` is a live binding under real ESM and a SNAPSHOT
 * under any CJS transpile — track.ts documents this at length and exports the
 * accessor precisely for it. Reading the binding here meant that after
 * setActiveTrack switched to a longer circuit, nearestTrackIndex (live, inside
 * track.ts) could return an index past the end of the stale array this file was
 * still holding, and the respawn path in updateWrecks would throw on it. It
 * only reproduces where the module graph is transpiled — which is to say, in
 * every headless test of this file that has ever been attempted.
 */
function trackYawAt(index: number, lookAhead = 6): number {
  const S = getTrackSamples();
  const n = S.length;
  const a = S[index % n]!;
  const b = S[(index + lookAhead) % n]!;
  return Math.atan2(-(b.x - a.x), -(b.z - a.z));
}

/* ── race progress ───────────────────────────────────────────────────
 *
 * `track.trackProgress` is OFF BY ONE SECTOR, and the effect is not a rounding
 * error — it destroys the quantity entirely. Measured on ash_spire, walking the
 * centreline as a car that crosses every gate correctly:
 *
 *   sample   true arc   trackProgress   error
 *      0      0.0000       0.0714       +64.9m
 *     72      0.2505       0.2857       +32.0m
 *    144      0.4967       0.5714       +67.9m
 *    264      0.9136       0.9286       +13.6m
 *
 * Every reported value is an exact multiple of 1/14. It is a STAIRCASE: it
 * jumps a whole sector at each gate and then does not move again until the next
 * one, so within a sector every car on the circuit has identical progress no
 * matter where in that 65m they are.
 *
 * The cause: `v.checkpoint` names the gate a car is heading FOR, so the sector
 * it occupies runs from gate `checkpoint - 1` to gate `checkpoint`. trackProgress
 * reads the sector as `[checkpoint/n, (checkpoint+1)/n)` — one sector too far
 * along — so the car's true arc is always BELOW its own sector floor and the
 * clamp pins it there. Its `checkpoint === 0` special case spells the correct
 * formula out (`(n-1)/n`), which is why the one sector before the start line is
 * the only one that reads correctly.
 *
 * What it cost, everywhere raceProgress is read:
 *   · standings could not separate two cars in the same sector at all, so the
 *     order inside a sector was whatever the hysteresis fallback said;
 *   · ai.catchUpFactor measured gaps to the leader in 65m quanta;
 *   · ai's `blocker` pattern tests `mark.raceProgress < v.raceProgress`, which
 *     is false for a car right behind you in the same sector — so blockers did
 *     not block until you happened to be a sector back;
 *   · the mission runtime's "player is ahead of the mark" check, same.
 *
 * Fixed here rather than in track.ts because this is the only caller and
 * track.ts is not this change's to edit. Gate arc positions are MEASURED rather
 * than assumed to be k/n — buildCheckpointsFrom places gates by sample index and
 * index is only approximately proportional to distance (worst deviation across
 * the catalogue: 0.66% of a lap, 5.3m on Rustline).
 */
let gateArc: number[] = [];
let gateArcEpoch = -1;

function gateArcs(): number[] {
  const epoch = getTrackEpoch();
  if (epoch === gateArcEpoch) return gateArc;
  gateArcEpoch = epoch;
  const S = getTrackSamples();
  const L = Math.max(1e-6, getTrackLength());
  gateArc = getCheckpoints().map((g) => {
    const s = S[nearestTrackIndex(g.x, g.z)];
    return s ? s.s / L : 0;
  });
  return gateArc;
}

/**
 * Whole laps + [0,1) around the circuit, continuous within a sector.
 *
 * Takes the five fields it needs rather than a VehicleState, so the grid
 * builder can ask for a car's starting progress before that car exists.
 */
function raceProgressOf(
  x: number,
  z: number,
  yaw: number,
  lap: number,
  checkpoint: number,
): number {
  const arcs = gateArcs();
  const n = arcs.length;
  if (n === 0) return lap;
  const S = getTrackSamples();
  const L = Math.max(1e-6, getTrackLength());
  const idx = nearestTrackIndex(x, z, yaw);
  const arc = (S[idx]?.s ?? 0) / L;

  // The sector the car is IN starts at the gate it last crossed.
  const sector = (((checkpoint - 1) % n) + n) % n;
  const lo = arcs[sector]!;
  const next = sector === n - 1 ? 1 : arcs[sector + 1]!;
  const span = Math.max(1e-4, next - lo);

  /*
   * Signed offset from the sector start, taken the short way round the loop, so
   * a car sitting a metre behind the line it just crossed reads as the start of
   * its sector rather than as almost a full lap ahead.
   */
  let rel = arc - lo;
  if (rel < -0.5) rel += 1;
  else if (rel > 0.5) rel -= 1;
  // Clamped INTO the sector: the sequential gate is the authority on which
  // sector you are in, arc-length only refines where inside it. A car that has
  // run wide past the next gate without triggering it is held at the boundary
  // rather than credited with a sector it has not been given.
  const within = lo + Math.max(0, Math.min(span - 1e-4, rel));
  return lap + within;
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
  /*
   * THE GRID RUNS FORWARD FROM POLE, and it did not.
   *
   * `startIdx = 2 + gridIndex * 3` put grid slot 0 — the player, whose
   * `position` is initialised to 1 — at the sample NEAREST the start line, and
   * slot 3 nine samples further down the road. Sample spacing is ~3.14m on
   * every circuit in the catalogue (TARGET_SAMPLE_SPACING, verified: 3.12-3.16
   * mean across all six), so the car the HUD called P4 physically started ~28m
   * AHEAD of the car it called P1. Pole was the back of the grid.
   *
   * Slot 0 now takes the FRONT row and the rows walk backwards, so the reported
   * order and the physical order are the same thing.
   *
   * Slots fill left-then-right within a row: 0 and 1 share the front row, 2 and
   * 3 the rear. Pole takes the LEFT lane (`col === 0` → -1) purely so the
   * player, who is always slot 0, starts on the same side of the road every
   * race and can learn where their mirror is.
   */
  const S = getTrackSamples();
  const slot = Math.min(GRID_ROWS * GRID_COLS - 1, Math.max(0, gridIndex));
  const row = Math.floor(slot / GRID_COLS);
  const col = slot % GRID_COLS;
  const startIdx =
    GRID_REAR_SAMPLE + (GRID_ROWS - 1 - row) * GRID_ROW_SAMPLES;
  const sample = S[Math.min(startIdx, S.length - 1)] ?? S[0]!;
  const lane = (col === 0 ? -1 : 1) * GRID_LANE_M;
  const rx = Math.cos(sample.yaw);
  const rz = -Math.sin(sample.yaw);
  const x = showcase ? SHOWCASE.x : sample.x + rx * lane;
  const z = showcase ? SHOWCASE.z : sample.z + rz * lane;
  // getGroundHeight, not sample.y: sample.y is the ROAD plane, and while the
  // lane offset is well inside the flat corridor on every circuit today, a
  // narrower one would put the outside car on the berm roll-off.
  const y = showcase ? SHOWCASE.y : getGroundHeight(x, z) + 0.55;
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
    raceProgress: raceProgressOf(x, z, yaw, 0, 1),
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
    vy: 0,
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
    lastHitBy: null,
    lastHitAge: 0,
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
  // A mission's roster owns the identity of each slot. Absent one (free play)
  // this falls back to the old rotation, so nothing changes for a quick heat.
  const roster = getFieldRoster();
  for (let i = 0; i < 3; i++) {
    const slot = roster[i];
    const botClass = slot?.classId ?? others[i % others.length] ?? "bruiser";
    const bot = makeVehicle(
      `bot-${i}`,
      BOT_NAMES[i % BOT_NAMES.length]!,
      botClass,
      false,
      i + 1,
      false,
    );
    // Livery is how you tell the marked car from the traffic at 180mph. A
    // mission that paints slot 0 red has said something the HUD cannot.
    if (slot?.color) bot.color = slot.color;
    list.push(bot);
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
    // Per circuit, not a global three. RACE.laps is a 90-second race on the
    // Foundry Pit and a six-minute one on the Dead Mile. Missions override this
    // immediately after arming; free play now gets a sane default per road.
    lapCount: getTrackDef(trackId).laps,
    seed: (Date.now() % 1e9) | 0,
    playerId: "player",
    guestName,
    selectedClass: classId,
    selectedTrack: trackId,
    finishedOrder: [],
    weaponsHot: false,
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
  // getCheckpoints(), not the CHECKPOINTS binding: `export let` is live under
  // real ESM but a CJS transpile snapshots it at module init, so after a track
  // switch this read returned the previous circuit's gates. Exactly the bug
  // that made updateWrecks throw, and the reason TRACK_SAMPLES already moved.
  const checkpoints = getCheckpoints();
  const n = checkpoints.length;
  if (n <= 0) return;

  const gateIdx = ((v.checkpoint % n) + n) % n;
  const gate = checkpoints[gateIdx];
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
    Math.abs(across) < gate.halfWidth * GATE_WIDTH_MUL
  ) {
    r.gateCool = GATE_COOLDOWN;
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
  const prog = raceProgressOf(v.x, v.z, v.yaw, v.lap, v.checkpoint);
  if (prog >= v.raceProgress - 0.04 || Math.floor(prog) > Math.floor(v.raceProgress)) {
    v.raceProgress = prog;
  } else {
    v.raceProgress = v.raceProgress * 0.92 + prog * 0.08;
  }
}

/**
 * Race positions from race progress.
 *
 * THE OLD COMPARATOR WAS NOT A TOTAL ORDER, and that is not a style objection.
 * It returned "tied" for any pair within 0.01 laps and then fell back to the
 * PREVIOUS frame's position, so with a = 0.005 behind b, b = 0.005 behind c and
 * a = 0.010 behind c, it reported a~b, b~c and a<c simultaneously. Array.prototype
 * .sort is explicitly undefined on an inconsistent comparator: the result is
 * whatever the engine's merge happens to do with it, which is how a standings
 * table develops a mind of its own in a close pack — the exact situation it
 * exists to describe.
 *
 * Rewritten as a SORT KEY, which cannot be inconsistent by construction:
 *
 *   finished cars   → a descending band above every runner, in crossing order
 *   everyone else   → raceProgress, plus a small bonus for the place they
 *                     currently hold
 *
 * The bonus is the hysteresis, and being part of the key rather than a branch is
 * what makes it transitive. A car has to gain STANDINGS_HOLD_M / fieldSize of
 * centreline — one metre on a four-car grid — over the car ahead before it takes
 * the place, so side-by-side running does not flicker and a genuine pass shows
 * up within a car length instead of within a straight.
 */
function updateStandings(state: SimState) {
  const order = state.finishedOrder;
  const n = Math.max(1, state.vehicles.length);
  // Metres of progress, expressed in laps, so the deadband is the same distance
  // on a 656m circuit and a 1702m one.
  const stick = STANDINGS_HOLD_M / Math.max(1, getTrackLength());
  const key = new Map<string, number>();
  for (const v of state.vehicles) {
    if (v.finished) {
      const idx = order.indexOf(v.id);
      // Well above any reachable lap count, so a finisher outranks every runner
      // however far round the leader is.
      key.set(v.id, 1e6 - (idx >= 0 ? idx : 999));
    } else {
      key.set(v.id, v.raceProgress + stick * ((n - v.position) / n));
    }
  }
  [...state.vehicles]
    .sort((a, b) => {
      const d = key.get(b.id)! - key.get(a.id)!;
      // Exact equality only, and then a stable id tiebreak — the deadband is
      // already in the key.
      if (d !== 0) return d > 0 ? 1 : -1;
      return a.id.localeCompare(b.id);
    })
    .forEach((v, i) => {
      v.position = i + 1;
    });
}

/**
 * Normalised impact energy in [0,1] for the player, over one fixed step.
 *
 * Two independent signals, taken at whichever is larger:
 *
 * - The world-velocity delta, which is the physical energy of the hit. This is
 *   the one that matters for anything you drive into.
 * - The rise in hitStun, which every impact path in the codebase sets. A direct
 *   rocket barely changes the car's velocity but is unambiguously a big hit,
 *   and would score zero on the delta alone.
 *
 * Both have a floor well above incidental contact. A hitstop that fires when
 * you clip a verge post stops meaning anything within a lap.
 */
function impactEnergy(
  player: VehicleState,
  preVx: number,
  preVz: number,
  preStun: number,
): number {
  const pv = worldVelocity(player);
  const dv = Math.hypot(pv.vx - preVx, pv.vz - preVz);
  const eDv =
    (dv - FEEL.hitstopMinDv) / (FEEL.hitstopFullDv - FEEL.hitstopMinDv);
  const stunRise = player.hitStun - preStun;
  const eStun =
    (stunRise - FEEL.hitstopMinStun) /
    (FEEL.hitstopFullStun - FEEL.hitstopMinStun);
  const e = eDv > eStun ? eDv : eStun;
  return e < 0 ? 0 : e > 1 ? 1 : e;
}

function updateWrecks(state: SimState, dt: number) {
  for (const v of state.vehicles) {
    if (v.wreckTimer > 0) {
      v.wreckTimer = Math.max(0, v.wreckTimer - dt);
      if (v.wreckTimer <= 0) {
        /*
         * NO YAW HINT. nearestTrackIndex adds `dyaw^2 * 18` to the squared
         * distance when given one — worth about 13m of position at half a turn
         * of error — and a wreck's yaw is whatever it was spinning at when the
         * hull failed. On a circuit that doubles back on itself (all six do; the
         * Dead Mile's legs pass within ~95m) that penalty is enough to pick a
         * sample on the OTHER leg because it happens to point the way the
         * wreck ended up facing, and respawn the car across the infield facing
         * a direction it never drove. Position alone cannot do that.
         */
        const idx = nearestTrackIndex(v.x, v.z);
        const S = getTrackSamples();
        const s = S[idx]!;
        /*
         * Set back from the centreline, alternating by grid slot. Every wreck
         * used to be put on the exact centreline, so a multi-car pile-up
         * respawned two stationary cars inside each other and the solver spent
         * the next second pushing them apart.
         */
        const slot = slotOfVehicle(v.id);
        const lane = (slot < 0 ? 0 : slot % 2 === 0 ? -1 : 1) * 2.2;
        const rx = Math.cos(s.yaw);
        const rz = -Math.sin(s.yaw);
        v.x = s.x + rx * lane;
        v.z = s.z + rz * lane;
        v.y = getGroundHeight(v.x, v.z) + 0.55;
        v.yaw = s.yaw;
        v.speed = 0;
        v.lateral = 0;
        // A respawn is a teleport, and a teleport must not inherit the fall it
        // was rescued from — `integratePos` would spend the stale vy as a launch.
        v.vy = 0;
        v.health = v.maxHealth * COMBAT.wreckRespawnHp;
        v.damageVisual = Math.min(0.55, v.damageVisual);
        v.invuln = COMBAT.wreckInvuln;
        v.alive = true;
        // A new life is a new claim. Whoever put them into the last wall does
        // not also own the next one.
        v.lastHitBy = null;
        v.lastHitAge = 0;
        /*
         * THE TELEPORT MUST NOT COUNT AS A GATE CROSSING.
         *
         * updateCheckpoints decides a crossing from `prev` behind the gate plane
         * and `current` in front of it, and while a car is wrecked it keeps
         * updating `prev` at the wreck's position. Respawning moved the car
         * without moving `prev`, so the next step compared a point at the crash
         * site with a point on the road — a straight line that can pass through
         * any number of gate planes, including the start line. A car wrecked
         * just before the flag could respawn straight into a lap it had not
         * driven. Re-anchoring `prev` and holding the gate cooldown for the
         * length of the respawn makes the jump invisible to the lap counter.
         */
        const r = rt(v.id, v);
        r.prevX = v.x;
        r.prevZ = v.z;
        r.gateCool = Math.max(r.gateCool, 0.35);
        // Re-derived rather than eased toward: a car recovered a long way from
        // where it died would take seconds to converge through the smoothing in
        // updateCheckpoints, and would be mis-ranked for all of them.
        v.raceProgress = raceProgressOf(v.x, v.z, v.yaw, v.lap, v.checkpoint);
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
  /**
   * Replay ghost is opt-in (menu toggle, default off). A translucent duplicate
   * car sharing the grid reads as a rendering bug unless you asked for it.
   */
  ghostEnabled = false;
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
    this.activeGhost = this.ghostEnabled ? getGhost(trackId) : null;
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
    // Callers that arm a mission set lapCount again straight after this; the
    // circuit default is what a quick heat gets.
    this.state.lapCount = getTrackDef(trackId).laps;
    this.state.props = spawnWorldProps();
    this.activeGhost = this.ghostEnabled ? getGhost(trackId) : null;
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
    this.activeGhost = this.ghostEnabled ? getGhost(this.state.selectedTrack) : null;
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
    // Feel state persists across races because it lives outside SimState —
    // without this a crash on the last corner leaves the new grid in slow
    // motion, and a key held at the flag starts you already at full lock.
    sharedHitStop.reset();
    resetSteerRamp();
    // Same reason as the steer ramp: drift engagement lives outside SimState, so
    // a car that crossed the line sideways would otherwise start the next heat
    // already in a slide.
    resetDriftState();
    this.ghostRecorder.reset();
    this.ghostFinalized = false;
    this.activeGhost = this.ghostEnabled ? getGhost(this.state.selectedTrack) : null;
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
    /*
     * The hold has to be re-armed with the clock it is measured against.
     *
     * `raceTime` is reset here and `weaponsHot` was not, so the flag survived
     * into the next heat: the opening hold worked exactly once per session and
     * every restart after that began with the guns already live and no WEAPONS
     * FREE call. A latch keyed to a counter that resets must be reset beside it.
     */
    this.state.weaponsHot = false;
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
    // Hitstop is NOT applied here any more. The fixed-step driver scales the
    // real time it feeds its accumulator before it ever calls tick(), so the
    // stopped time is deferred rather than discarded and the step size stays
    // exactly FIXED_DT. Freezing inside tick() threw away time the driver had
    // already committed, and could only ever express a total stop.
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

    /*
     * The guns come live, once, and everybody is told.
     *
     * Announced rather than silent because a rule the player cannot see is
     * indistinguishable from a bug: pressing fire and getting nothing for ten
     * seconds reads as broken input, not as a rolling start. The event goes
     * through the same channel as the lap and finish callouts, so it gets the
     * announcer line and the HUD radio strip without a special case.
     */
    if (!state.weaponsHot && state.raceTime >= COMBAT.weaponsHotAt) {
      state.weaponsHot = true;
      pushEvent(state, "weapons", "WEAPONS FREE");
    }

    for (const v of state.vehicles) {
      if (v.finished) {
        v.speed *= Math.max(0, 1 - 1.8 * dt);
        v.lateral *= Math.max(0, 1 - 3 * dt);
        continue;
      }

      const input = v.isPlayer
        ? (playerInput ?? createEmptyInput())
        : aiInput(v, state.vehicles, state.time, state.lapCount);
      /*
       * The HANDBRAKE predicate, deliberately, not isDrifting().
       *
       * isDrifting() is now a query over both drift modes, and stepVehicle feeds
       * whatever it is handed back in as `forced` hysteresis for the handbrake
       * branch. Passing the combined answer would let a grip drift silently arm
       * the handbrake physics — 0.16 grip and a 1.85x turn multiplier — without
       * the handbrake ever being touched.
       */
      const drifting = isHandbrakeDrift(v, input);
      const catchUp = v.isPlayer
        ? 0
        : catchUpFactor(v, state.vehicles, state.lapCount);
      // Read AFTER aiInput: that call is what advances this driver's mistake
      // schedule, and the grip drop has to land on the same step as the moment.
      const skill = v.isPlayer ? null : aiSkill(v);

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
        skill,
      });
      spawnDamageSmoke(v, state.particles, dt);

      // Takedown credit expires. Six seconds is long enough to cover "shot,
      // spun, hit the wall" and short enough that a rival who dies to the
      // scenery a lap later is nobody's kill.
      if (v.lastHitBy) {
        v.lastHitAge = (v.lastHitAge ?? 0) + dt;
        if (v.lastHitAge > 6) v.lastHitBy = null;
      }

      const def = VEHICLE_CLASSES[v.classId];
      v.lockTargetId = findLockTarget(v, state.vehicles, def.primaryRange * 1.12);
      /*
       * WEAPONS COLD FOR THE OPENING SECONDS. See COMBAT.weaponsHotAt.
       *
       * Locks still resolve while the hold is on, so the HUD can show a target
       * being tracked and the moment the guns come live is a release rather
       * than a search. Defence is also left available: it is the one input that
       * cannot start a fight, and taking it away would mean a car rammed off
       * the line has no answer at all.
       */
      if (state.weaponsHot) {
        tryPrimary(v, input, state.projectiles, state.vehicles);
        tryUltimate(v, input, state.mines, state.vehicles, state.projectiles);
      }
      tryDefense(v, input, state.vehicles);
      updateCheckpoints(v, state, dt);
    }

    const player = state.vehicles.find((v) => v.isPlayer);
    /**
     * Baseline for this step's impact energy, taken after every vehicle has
     * driven but before anything can collide.
     *
     * Impact energy is read as the world velocity the solver takes off the
     * player across the step, rather than from any individual collision's
     * reported number, because none of those numbers describe what the player
     * absorbed: collideVehiclesWithProps returns a max over the whole field, so
     * it fires for a bot clipping a barrel on the far side of the track, and
     * collideVehicles reports a closing speed for a pair regardless of how the
     * mass ratio split it. The delta covers cars, props, barriers, blast
     * knockback and weapon recoil in one measurement, and is proportional to
     * what actually happened to the player by construction.
     */
    let preVx = 0;
    let preVz = 0;
    let preStun = 0;
    if (player) {
      const pv = worldVelocity(player);
      preVx = pv.vx;
      preVz = pv.vz;
      preStun = player.hitStun;
    }

    /*
     * A landing is an impact, so it goes through the impact reactions.
     *
     * `landingImpact` is published by the integrator for exactly one step (see
     * physics.ts). Drained here rather than read, so a frame in which the sim
     * does not reach this point cannot leave a stale value to fire twice.
     *
     * Only the player shakes the camera — it is the player's camera — but every
     * car throws dust, because a rival slamming down off the carrier ahead of
     * you is one of the few things in this game that says how big the jump was.
     */
    for (const v of state.vehicles) {
      const land = v.landingImpact ?? 0;
      if (land <= 0) continue;
      v.landingImpact = 0;
      if (land > 3) {
        spawnDamageSmoke(v, state.particles, Math.min(0.05, land * 0.004));
        if (v.isPlayer) {
          sharedTrauma.add(Math.min(0.4, land * 0.03));
          // Loud enough to be a beat, quiet enough not to read as a crash: a
          // clean landing is a good thing that happened, not a mistake.
          if (land > 6) pushEvent(state, "hit", "Landed");
        }
      }
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
              // Hitstop is triggered once per step from the measured player
              // velocity delta below, not per colliding pair — a three-car
              // sandwich is one hit, not three.
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

    // Everything that can hit the player has now run. One measurement, one
    // hitstop request.
    if (player) sharedHitStop.trigger(impactEnergy(player, preVx, preVz, preStun));

    updateWrecks(state, dt);
    updateStandings(state);

    if (player && player.health < this.lastPlayerHealth - 1) {
      const dmg = this.lastPlayerHealth - player.health;
      state.lastHitFlash = 0.25;
      state.cameraShake = Math.min(1, state.cameraShake + 0.2);
      state.cameraKick = {
        x: Math.sin(player.yaw),
        z: Math.cos(player.yaw),
      };
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
    if (saved && this.ghostEnabled) this.activeGhost = run;
  }
}
