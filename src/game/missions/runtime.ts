/**
 * Mission interpreter.
 *
 * Two entry points and one rule: `stepMission` NEVER mutates the world. It
 * reads a snapshot, updates its own bookkeeping, and returns effects for the
 * caller to apply. That is what lets the same run be driven from the render
 * loop (where the shell already ticks) without needing a hook inside
 * sim.fixedStep, which this module does not own.
 *
 * Timing comes from `snapshot.raceTime`, never from a caller-supplied dt.
 * raceTime only advances while the race is actually running, so pausing,
 * hitstop, a dropped frame and a 144Hz monitor all behave — and a caller that
 * ticks us twice in one frame cannot double-count a survival timer.
 */
import {
  VEHICLE_CLASSES,
  resetFieldRoster,
  setFieldRoster,
} from "../classes";
import { resetAiDirective, setAiDirective, type RivalProfile } from "../ai";
import { getTrackLength, setActiveTrack } from "../track";
import {
  DEFAULT_MODIFIERS,
  type MissionDef,
  type MissionEffect,
  type MissionMutableWorld,
  type MissionRunSummary,
  type MissionSnapshot,
  type MissionVehicleView,
  type Objective,
  type ObjectiveState,
  type ObjectiveStatus,
} from "./types";

/** Objectives that start satisfied and can only be broken. */
const HOLD_KINDS = new Set<Objective["kind"]>([
  "no_wreck",
  "hull_above",
  "escort_alive",
  "stay_near",
]);

interface Bookkeeping {
  /** Health seen last step, per vehicle — the source of damage deltas. */
  prevHealth: Record<string, number>;
  /** Wrecked-last-step flags, for edge detection. */
  prevWrecked: Record<string, boolean>;
  /** Total health removed from each rival, and how much of it we credit you. */
  damageTotal: Record<string, number>;
  damagePlayer: Record<string, number>;
  takedowns: number;
  takenDown: string[];
  playerWrecks: number;
  leadSeconds: number;
  aliveSeconds: number;
  bestLap: number | null;
  seenLapCount: Record<string, number>;
  /** Remaining grace before a stay_near objective actually breaks. */
  nearGrace: Record<number, number>;
  eliminated: string[];
  nextElimAt: number;
  elimWarned: boolean;
}

export interface MissionRun {
  def: MissionDef;
  status: "running" | "complete" | "failed";
  /** Resolved from pace + live track length at creation. */
  lapTarget: number | null;
  raceTarget: number | null;
  startTime: number;
  lastTime: number;
  elapsed: number;
  objectives: ObjectiveState[];
  book: Bookkeeping;
  /** Lines produced this step; the caller drains them into the HUD. */
  announcements: string[];
}

function findPlayer(s: MissionSnapshot): MissionVehicleView | undefined {
  return s.vehicles.find((v) => v.isPlayer);
}

function slotVehicle(
  s: MissionSnapshot,
  slot: number,
): MissionVehicleView | undefined {
  // Mirrors sim.buildField: bots are created in grid order as bot-0, bot-1, ...
  return s.vehicles.find((v) => v.id === `bot-${slot}`);
}

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function labelFor(o: Objective, lapTarget: number | null, raceTarget: number | null): string {
  if (o.label) return o.label;
  switch (o.kind) {
    case "finish_place":
      return o.place === 1 ? "Win the heat" : `Finish P${o.place} or better`;
    case "finish_race":
      return "Cross the line";
    case "takedowns":
      return `Wreck ${o.count} runner${o.count === 1 ? "" : "s"}`;
    case "survive_time":
      return `Survive ${fmtClock(o.seconds)}`;
    case "last_standing":
      return "Be the last car running";
    case "lead_for":
      return `Lead for ${fmtClock(o.seconds)}`;
    case "lap_pace":
      return `Lap under ${lapTarget ? lapTarget.toFixed(1) : "?"}s`;
    case "race_pace":
      return `Total under ${raceTarget ? fmtClock(raceTarget) : "?"}`;
    case "wreck_target":
      return `Wreck the marked car${o.count && o.count > 1 ? ` x${o.count}` : ""}`;
    case "beat_rival":
      return "Finish ahead of the rival";
    case "no_wreck":
      return "Do not get wrecked";
    case "hull_above":
      return `Keep hull above ${Math.round(o.pct * 100)}%`;
    case "escort_alive":
      return `Keep the client above ${Math.round(o.minHullPct * 100)}%`;
    case "stay_near":
      return `Stay within ${o.metres}m of the client`;
  }
}

/**
 * Build a run. Resolves pace objectives against the ACTIVE track, so
 * setActiveTrack must already have happened — armMission does both in order.
 */
export function createMissionRun(def: MissionDef, raceTime = 0): MissionRun {
  const length = Math.max(1, getTrackLength());
  let lapTarget: number | null = null;
  let raceTarget: number | null = null;
  for (const o of def.objectives) {
    if (o.kind === "lap_pace") lapTarget = length / Math.max(1, o.pace);
    if (o.kind === "race_pace") raceTarget = (length * def.laps) / Math.max(1, o.pace);
  }

  const objectives: ObjectiveState[] = def.objectives.map((o, index) => ({
    index,
    label: labelFor(o, lapTarget, raceTarget),
    status: HOLD_KINDS.has(o.kind) ? ("met" as ObjectiveStatus) : "pending",
    progress: HOLD_KINDS.has(o.kind) ? 1 : 0,
    detail: "",
    optional: !!o.optional,
  }));

  return {
    def,
    status: "running",
    lapTarget,
    raceTarget,
    startTime: raceTime,
    lastTime: raceTime,
    elapsed: 0,
    objectives,
    announcements: [],
    book: {
      prevHealth: {},
      prevWrecked: {},
      damageTotal: {},
      damagePlayer: {},
      takedowns: 0,
      takenDown: [],
      playerWrecks: 0,
      leadSeconds: 0,
      aliveSeconds: 0,
      bestLap: null,
      seenLapCount: {},
      nearGrace: {},
      eliminated: [],
      nextElimAt: def.modifiers.elimination
        ? def.modifiers.elimination.everySec
        : Infinity,
      elimWarned: false,
    },
  };
}

/**
 * Credit for a rival's health loss.
 *
 * physics.applyDamage takes an ownerId and then throws it away (the parameter is
 * literally named `_ownerId`), and VehicleState has nowhere to record it, so
 * there is no ground truth for "who wrecked that car" without editing files
 * this module does not own. This is the honest approximation: a hit counts as
 * yours if you were close enough and pointed the right way when it landed, or
 * if you were in contact range at all.
 *
 * It over-credits a three-car pile-up and under-credits a disc that ricochets
 * back into someone. Both are acceptable for a mission counter; neither is
 * acceptable for a leaderboard, so do not reuse this for one. See the report for
 * the two-line fix that makes it exact.
 */
function playerCreditFor(
  player: MissionVehicleView | undefined,
  victim: MissionVehicleView,
): number {
  if (!player || !player.alive || player.wreckTimer > 0) return 0;
  const dx = victim.x - player.x;
  const dz = victim.z - player.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 6.5) return 1; // contact: ram, or point blank
  const range = VEHICLE_CLASSES[player.classId].primaryRange * 1.15;
  if (dist > range) return 0;
  const fx = -Math.sin(player.yaw);
  const fz = -Math.cos(player.yaw);
  const dot = (dx / dist) * fx + (dz / dist) * fz;
  return dot > 0.55 ? 1 : 0;
}

function setState(
  st: ObjectiveState,
  status: ObjectiveStatus,
  progress: number,
  detail: string,
) {
  st.status = status;
  st.progress = Math.max(0, Math.min(1, progress));
  st.detail = detail;
}

/**
 * Advance the run. Returns effects for the caller to apply.
 *
 * Safe to call every frame, at any rate, in any phase — it no-ops unless the
 * race clock has moved.
 */
export function stepMission(
  run: MissionRun,
  snap: MissionSnapshot,
  opts: { fieldSize?: number } = {},
): MissionEffect[] {
  const effects: MissionEffect[] = [];
  if (run.status !== "running") return effects;

  const dt = Math.max(0, snap.raceTime - run.lastTime);
  run.lastTime = snap.raceTime;
  run.elapsed = snap.raceTime - run.startTime;
  const racing = snap.phase === "racing";
  const player = findPlayer(snap);
  const b = run.book;

  /* ── telemetry ─────────────────────────────────────────────────────── */
  for (const v of snap.vehicles) {
    const prev = b.prevHealth[v.id];
    if (prev !== undefined && v.health < prev - 0.01 && !v.isPlayer) {
      const drop = prev - v.health;
      b.damageTotal[v.id] = (b.damageTotal[v.id] ?? 0) + drop;
      b.damagePlayer[v.id] =
        (b.damagePlayer[v.id] ?? 0) + drop * playerCreditFor(player, v);
    }
    b.prevHealth[v.id] = v.health;

    const wrecked = !v.alive || v.wreckTimer > 0;
    const was = b.prevWrecked[v.id] ?? false;
    if (wrecked && !was) {
      if (v.isPlayer) {
        b.playerWrecks += 1;
      } else if (!b.eliminated.includes(v.id)) {
        const total = b.damageTotal[v.id] ?? 0;
        const mine = b.damagePlayer[v.id] ?? 0;
        if (total > 0 && mine / total > 0.45) {
          b.takedowns += 1;
          b.takenDown.push(v.id);
          run.announcements.push(`Takedown — ${v.name}`);
          effects.push({
            kind: "announce",
            message: `Takedown — ${v.name}`,
            event: "wreck",
          });
        }
      }
      // A fresh wreck resets attribution: the next life's damage is a new claim.
      b.damageTotal[v.id] = 0;
      b.damagePlayer[v.id] = 0;
    }
    b.prevWrecked[v.id] = wrecked;

    if (v.lastLapTime > 0.5) {
      const seen = b.seenLapCount[v.id] ?? 0;
      if (v.lap > seen) {
        b.seenLapCount[v.id] = v.lap;
        if (v.isPlayer && (b.bestLap === null || v.lastLapTime < b.bestLap)) {
          b.bestLap = v.lastLapTime;
        }
      }
    }
  }

  if (racing && player) {
    if (player.alive && player.wreckTimer <= 0) b.aliveSeconds += dt;
    if (player.position === 1) b.leadSeconds += dt;
  }

  /* ── elimination ───────────────────────────────────────────────────── */
  const elim = run.def.modifiers.elimination;
  if (elim && racing) {
    const live = snap.vehicles.filter(
      (v) => !b.eliminated.includes(v.id) && v.position > 0,
    );
    if (run.elapsed >= b.nextElimAt - elim.warnSec && !b.elimWarned && live.length > 2) {
      b.elimWarned = true;
      effects.push({
        kind: "announce",
        message: "Last place drops in 5",
        event: "boost",
      });
    }
    if (run.elapsed >= b.nextElimAt && live.length > 1) {
      // Worst SURVIVING position, which is not the same as the largest
      // `position` in the field: eliminated cars keep a position of their own
      // and would be knocked out over and over.
      let worst: MissionVehicleView | undefined;
      for (const v of live) if (!worst || v.position > worst.position) worst = v;
      if (worst) {
        b.eliminated.push(worst.id);
        effects.push({
          kind: "eliminate",
          vehicleId: worst.id,
          message: worst.isPlayer ? "Eliminated" : `${worst.name} is out`,
        });
      }
      b.nextElimAt = run.elapsed + elim.everySec;
      b.elimWarned = false;
    }
  }

  /* ── objectives ────────────────────────────────────────────────────── */
  const fieldSize = opts.fieldSize ?? snap.vehicles.length;
  const raceOver = snap.phase === "finished" || !!player?.finished;

  run.def.objectives.forEach((o, i) => {
    const st = run.objectives[i]!;
    if (st.status === "failed") return;

    switch (o.kind) {
      case "finish_place": {
        const place = player
          ? snap.finishedOrder.indexOf(player.id) + 1 || player.position
          : fieldSize;
        setState(
          st,
          raceOver ? (place <= o.place ? "met" : "failed") : "pending",
          Math.max(0, 1 - (place - 1) / Math.max(1, fieldSize - 1)),
          `P${place}`,
        );
        break;
      }
      case "finish_race": {
        setState(
          st,
          player?.finished ? "met" : "pending",
          player ? Math.min(1, player.lap / Math.max(1, run.def.laps)) : 0,
          `${Math.min(player?.lap ?? 0, run.def.laps)}/${run.def.laps}`,
        );
        break;
      }
      case "takedowns": {
        const n = b.takedowns;
        setState(
          st,
          n >= o.count ? "met" : raceOver ? "failed" : "pending",
          n / o.count,
          `${n}/${o.count}`,
        );
        break;
      }
      case "survive_time": {
        const left = o.seconds - run.elapsed;
        setState(
          st,
          left <= 0 ? "met" : "pending",
          run.elapsed / o.seconds,
          fmtClock(Math.max(0, left)),
        );
        break;
      }
      case "last_standing": {
        const standing = snap.vehicles.filter((v) => !b.eliminated.includes(v.id));
        const playerOut = !!player && b.eliminated.includes(player.id);
        setState(
          st,
          playerOut ? "failed" : standing.length <= 1 && !playerOut ? "met" : "pending",
          1 - (standing.length - 1) / Math.max(1, fieldSize - 1),
          `${standing.length} left`,
        );
        break;
      }
      case "lead_for": {
        setState(
          st,
          b.leadSeconds >= o.seconds ? "met" : raceOver ? "failed" : "pending",
          b.leadSeconds / o.seconds,
          `${fmtClock(Math.max(0, o.seconds - b.leadSeconds))}`,
        );
        break;
      }
      case "lap_pace": {
        const target = run.lapTarget ?? Infinity;
        const best = b.bestLap;
        setState(
          st,
          best !== null && best <= target ? "met" : raceOver ? "failed" : "pending",
          best === null ? 0 : Math.min(1, target / best),
          best === null ? `${target.toFixed(1)}s` : `${best.toFixed(2)}s`,
        );
        break;
      }
      case "race_pace": {
        const target = run.raceTarget ?? Infinity;
        const t = player?.finished ? player.finishTime : snap.raceTime;
        setState(
          st,
          player?.finished && t <= target
            ? "met"
            : t > target
              ? "failed"
              : "pending",
          Math.min(1, t / Math.max(0.01, target)),
          fmtClock(Math.max(0, target - t)),
        );
        break;
      }
      case "wreck_target": {
        const mark = slotVehicle(snap, o.slot);
        const need = o.count ?? 1;
        const got = mark ? b.takenDown.filter((id) => id === mark.id).length : 0;
        setState(
          st,
          got >= need ? "met" : raceOver ? "failed" : "pending",
          got / need,
          `${got}/${need}`,
        );
        break;
      }
      case "beat_rival": {
        const mark = slotVehicle(snap, o.slot);
        const ahead =
          !!player && !!mark && player.raceProgress >= mark.raceProgress;
        setState(
          st,
          raceOver ? (ahead ? "met" : "failed") : "pending",
          ahead ? 1 : 0,
          ahead ? "ahead" : "behind",
        );
        break;
      }
      case "no_wreck": {
        setState(
          st,
          b.playerWrecks > 0 ? "failed" : "met",
          b.playerWrecks > 0 ? 0 : 1,
          b.playerWrecks > 0 ? "wrecked" : "clean",
        );
        break;
      }
      case "hull_above": {
        const pct = player ? player.health / Math.max(1, player.maxHealth) : 1;
        setState(
          st,
          pct <= o.pct ? "failed" : "met",
          pct,
          `${Math.round(pct * 100)}%`,
        );
        break;
      }
      case "escort_alive": {
        const ally = slotVehicle(snap, o.slot);
        const pct = ally ? ally.health / Math.max(1, ally.maxHealth) : 1;
        setState(
          st,
          !ally || pct <= o.minHullPct ? "failed" : "met",
          pct,
          `${Math.round(pct * 100)}%`,
        );
        break;
      }
      case "stay_near": {
        const ally = slotVehicle(snap, o.slot);
        const d = ally && player ? Math.hypot(ally.x - player.x, ally.z - player.z) : 0;
        const grace = b.nearGrace[o.slot] ?? o.graceSec;
        // A grace window, because one bad corner is not a failed escort — and
        // because respawns teleport cars, which would otherwise fail instantly.
        const next = racing && d > o.metres ? grace - dt : Math.min(o.graceSec, grace + dt * 0.5);
        b.nearGrace[o.slot] = next;
        setState(
          st,
          next <= 0 ? "failed" : "met",
          Math.max(0, Math.min(1, 1 - d / Math.max(1, o.metres))),
          d > o.metres ? `${Math.ceil(Math.max(0, next))}s` : `${Math.round(d)}m`,
        );
        break;
      }
    }
  });

  /* ── resolution ────────────────────────────────────────────────────── */
  const required = run.objectives.filter((s) => !s.optional);
  if (required.some((s) => s.status === "failed")) {
    run.status = "failed";
  } else if (required.length > 0 && required.every((s) => s.status === "met")) {
    // Hold-only missions (survive N seconds without wrecking) are complete the
    // moment the achieve objectives land; race-shaped ones need the flag, which
    // finish_place/finish_race already gate on.
    run.status = "complete";
  } else if (raceOver && required.some((s) => s.status === "pending")) {
    run.status = "failed";
  }

  return effects;
}

/**
 * Apply effects to the live world.
 *
 * Elimination sets an effectively infinite wreck timer rather than `finished`.
 * That is deliberate and load-bearing: sim.updateStandings sorts every finished
 * car ahead of every unfinished one, so marking an eliminated runner as finished
 * would promote them to P1 on the way out. A permanent wreck timer freezes their
 * progress instead, sim.updateCheckpoints skips them, and they sink through the
 * order naturally as the survivors keep driving.
 */
export function applyMissionEffects(
  world: MissionMutableWorld,
  effects: MissionEffect[],
): void {
  for (const fx of effects) {
    if (fx.kind === "eliminate") {
      const v = world.vehicles.find((x) => x.id === fx.vehicleId);
      if (v) {
        v.health = 0;
        v.alive = false;
        v.wreckTimer = 1e6;
        v.speed *= 0.2;
        v.damageVisual = 1;
      }
      world.events.unshift({ t: world.time, kind: "wreck", message: fx.message });
    } else {
      world.events.unshift({ t: world.time, kind: fx.event, message: fx.message });
    }
    if (world.events.length > 12) world.events.length = 12;
  }
}

/**
 * Put a mission on the track.
 *
 * Order matters and is the whole reason this is a function rather than three
 * calls at the call site: the track has to be active before pace targets can be
 * resolved against its length, and the roster has to be set before the sim
 * builds the grid (buildField reads BOT_NAMES at construction time, inside
 * startCountdown). Call this, then setPhase("countdown").
 */
export function armMission(
  def: MissionDef,
  opts: { heatFloor?: number } = {},
): MissionRun {
  setActiveTrack(def.trackId);

  const mods = { ...DEFAULT_MODIFIERS, ...def.modifiers };
  // Career heat raises the floor but never lowers an authored ceiling —
  // see career.effectiveHeat for why that asymmetry is the point.
  mods.heat = Math.min(1, Math.max(mods.heat, opts.heatFloor ?? 0));
  const grid = def.grid ?? [];
  setFieldRoster(grid);

  const profiles: Record<string, RivalProfile> = {};
  grid.forEach((slot, i) => {
    if (slot.profile) profiles[`bot-${i}`] = slot.profile;
  });

  setAiDirective({
    heat: mods.heat,
    aggression: mods.aggression,
    catchUp: mods.catchUp,
    weaponsFree: mods.weaponsFree,
    bountyOn: mods.bountyOnPlayer ? "player" : null,
    protect: mods.protectSlot !== null ? `bot-${mods.protectSlot}` : null,
    profiles,
  });

  return createMissionRun(def, 0);
}

/** Hand the world back to free play. */
export function disarmMission(): void {
  resetAiDirective();
  resetFieldRoster();
}

export function summarise(
  run: MissionRun,
  snap: MissionSnapshot,
): MissionRunSummary {
  const player = findPlayer(snap);
  const place = player
    ? snap.finishedOrder.indexOf(player.id) + 1 || player.position
    : snap.vehicles.length;
  return {
    missionId: run.def.id,
    outcome:
      run.status === "complete"
        ? "complete"
        : run.status === "failed"
          ? "failed"
          : "abandoned",
    place,
    raceTime: player?.finished ? player.finishTime : snap.raceTime,
    bestLap: run.book.bestLap,
    takedowns: run.book.takedowns,
    objectives: run.objectives.map((o) => ({ ...o })),
    bonusMet: run.objectives.filter((o) => o.optional && o.status === "met").length,
  };
}
