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
import { EVENT_LINES, pickLine, rivalBark } from "../story";
import { emitAudioCue } from "../audio/cues";
import {
  DEFAULT_MODIFIERS,
  type MissionDef,
  type MissionEffect,
  type MissionEventKind,
  type MissionModifiers,
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
  /** Player's place last step, for detecting the moment a place changes hands. */
  prevPlayerPos: number;
  /** raceTime of the last radio line. The floor under how often anyone speaks. */
  radioAt: number;
  /** Radio keys already used this run. Every bark lands once or not at all. */
  said: Record<string, boolean>;
  /** Objective statuses last step, for edge-triggered announcements. */
  prevStatus: ObjectiveStatus[];
}

export interface MissionRun {
  def: MissionDef;
  /**
   * The modifiers this run is ACTUALLY using.
   *
   * Not `def.modifiers`: armMission raises heat to the career floor without
   * mutating the shared catalogue entry — which is correct, a MissionDef is
   * module-level data and writing career state into it would leak between
   * saves — but it left the HUD reading the authored number and telling the
   * player the league was calmer than it was.
   */
  modifiers: MissionModifiers;
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
  /**
   * raceTime at which the run stopped being winnable or losable, or null.
   *
   * The shell reads this to decide when to throw the flag. A survival mission
   * is OVER the second its timer lands — leaving the player to drive the
   * remaining four laps of a lap count chosen only to outlast the clock is how
   * a two-minute objective becomes a six-minute race.
   */
  resolvedAt: number | null;
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
    modifiers: { ...DEFAULT_MODIFIERS, ...def.modifiers },
    status: "running",
    lapTarget,
    raceTarget,
    startTime: raceTime,
    lastTime: raceTime,
    elapsed: 0,
    objectives,
    announcements: [],
    resolvedAt: null,
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
      prevPlayerPos: 0,
      // Negative so the very first line of the race is not blocked by the
      // cooldown measuring against a raceTime of zero.
      radioAt: -99,
      said: {},
      prevStatus: objectives.map((o) => o.status),
    },
  };
}

/* ── radio ────────────────────────────────────────────────────────────
 *
 * Most of this game's story is delivered here rather than on a briefing screen,
 * for the reason Most Wanted's was: a beat between races is read once, a line
 * over the radio at 180mph is heard every time it fires and is attached to
 * something the player just did.
 *
 * Two rules keep it from becoming noise, and both are load-bearing:
 *
 *  - Every line has a KEY and fires at most once per run. "Nice hit" on every
 *    hit is wallpaper; "That's the second time tonight" is a race.
 *  - A five second floor between any two lines. Without it a first-corner
 *    pile-up empties the entire script into one truncated HUD chip.
 */
const RADIO_GAP = 5;

function radio(
  run: MissionRun,
  effects: MissionEffect[],
  now: number,
  key: string,
  message: string,
  event: MissionEventKind = "boost",
): void {
  const b = run.book;
  if (!message || b.said[key]) return;
  if (now - b.radioAt < RADIO_GAP) return;
  b.said[key] = true;
  b.radioAt = now;
  run.announcements.push(message);
  effects.push({ kind: "announce", message, event });
}

/** Grid slot for a vehicle id, or -1. Mirrors sim.buildField's naming. */
function slotOf(id: string): number {
  const m = /^bot-(\d+)$/.exec(id);
  return m ? Number(m[1]) : -1;
}

/** The Blacklist name driving a given car this race, if any. */
function rivalIdOf(run: MissionRun, vehicleId: string): string | undefined {
  const slot = slotOf(vehicleId);
  return slot < 0 ? undefined : run.def.grid?.[slot]?.rivalId;
}

/**
 * Credit for a rival's health loss.
 *
 * The victim now carries `lastHitBy`, written by physics.applyDamage and by the
 * ram path in collideVehicles, so this is EXACT whenever it is present: the car
 * that put the damage on is named, and nobody standing nearby gets paid for it.
 *
 * The proximity fallback survives for the case where it is genuinely absent —
 * a display-only vehicle built outside the sim, or damage from a path that
 * predates the field. It over-credits a three-car pile-up and under-credits a
 * disc that ricochets back into someone; acceptable for a mission counter,
 * never for a leaderboard.
 */
function playerCreditFor(
  player: MissionVehicleView | undefined,
  victim: MissionVehicleView,
): number {
  if (!player || !player.alive || player.wreckTimer > 0) return 0;
  if (victim.lastHitBy != null) return victim.lastHitBy === player.id ? 1 : 0;
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
          // The rival gets the next word. A named car going down in silence is
          // the difference between a mission counter and a rivalry.
          const rid = rivalIdOf(run, v.id);
          if (rid) {
            radio(
              run,
              effects,
              snap.raceTime,
              `down-${rid}`,
              rivalBark(rid, "down"),
              "wreck",
            );
          }
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

  /* ── radio ─────────────────────────────────────────────────────────── */
  if (racing && player) {
    const now = snap.raceTime;
    const others = snap.vehicles.filter((v) => !v.isPlayer);
    const seed = Math.round(now);

    // Who you are actually here for. Held back a couple of seconds so it does
    // not land underneath the countdown.
    const headliner = run.def.grid?.[0]?.rivalId;
    if (headliner && now > 2) {
      radio(run, effects, now, `open-${headliner}`, rivalBark(headliner, "open"));
    }

    if (b.prevPlayerPos > 0 && player.position !== b.prevPlayerPos) {
      if (player.position === 1) {
        radio(run, effects, now, "took-lead", pickLine(EVENT_LINES.took_lead, seed));
      } else if (player.position > b.prevPlayerPos) {
        // Whoever now holds the place you just lost is the car that took it.
        const passer = others.find((r) => r.position === b.prevPlayerPos);
        const rid = passer ? rivalIdOf(run, passer.id) : undefined;
        if (rid) radio(run, effects, now, `pass-${rid}`, rivalBark(rid, "pass"), "hit");
        else radio(run, effects, now, "lost-place", pickLine(EVENT_LINES.lost_place, seed), "hit");
      }
    }
    b.prevPlayerPos = player.position;

    if (player.health < player.maxHealth * 0.3) {
      radio(run, effects, now, "player-hurt", pickLine(EVENT_LINES.player_hurt, seed), "hit");
    }
    for (const r of others) {
      if (r.alive && r.wreckTimer <= 0 && r.health < r.maxHealth * 0.35) {
        const rid = rivalIdOf(run, r.id);
        if (rid) radio(run, effects, now, `hurt-${rid}`, rivalBark(rid, "hurt"), "hit");
      }
    }
    if (run.def.laps > 1 && player.lap >= run.def.laps - 1) {
      radio(run, effects, now, "last-lap", pickLine(EVENT_LINES.last_lap, seed), "lap");
    }
    if (run.def.modifiers.bountyOnPlayer && now > 6) {
      radio(run, effects, now, "bounty", pickLine(EVENT_LINES.heat_up, seed), "hit");
    }
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

  /* ── objective transitions ─────────────────────────────────────────── */
  /*
   * Announced on the EDGE, not on the state. A hold objective is "met" on every
   * one of the ten thousand steps it survives, and an interpreter that reported
   * state rather than change would say so on every one of them.
   *
   * Failure is louder than success on purpose: an objective quietly going red
   * behind the HUD, and the run being over without the player knowing why, is
   * the single worst thing this layer can do to someone.
   */
  const cuePlayer = findPlayer(snap);
  run.objectives.forEach((st, i) => {
    const was = b.prevStatus[i];
    if (was === st.status) return;
    b.prevStatus[i] = st.status;
    if (!racing) return;
    if (st.status === "failed") {
      const line = st.optional
        ? `Bonus lost — ${st.label}`
        : `${st.label.toUpperCase()} — FAILED`;
      run.announcements.push(line);
      effects.push({ kind: "announce", message: line, event: "wreck" });
      // Positional at the player: an objective outcome is about them, so it
      // should not pan to wherever the triggering car happened to be.
      if (cuePlayer)
        emitAudioCue(
          "objective-lost",
          cuePlayer.x,
          // MissionVehicleView is deliberately narrow and carries no y; a
          // fixed cabin height is right for a cue that is about the player
          // rather than about a point in the world.
          1.0,
          cuePlayer.z,
          st.optional ? 0.7 : 1,
          true,
        );
      b.radioAt = snap.raceTime;
    } else if (st.status === "met" && was === "pending") {
      const line = `Objective — ${st.label}`;
      run.announcements.push(line);
      effects.push({ kind: "announce", message: line, event: "pickup" });
      if (cuePlayer)
        emitAudioCue(
          "objective-won",
          cuePlayer.x,
          // MissionVehicleView is deliberately narrow and carries no y; a
          // fixed cabin height is right for a cue that is about the player
          // rather than about a point in the world.
          1.0,
          cuePlayer.z,
          st.optional ? 0.7 : 1,
          true,
        );
      b.radioAt = snap.raceTime;
    }
  });

  /* ── resolution ────────────────────────────────────────────────────── */
  const required = run.objectives.filter((s) => !s.optional);
  /*
   * A hold objective is "met" from the first step. A mission whose required
   * objectives are ALL holds is therefore satisfied before the lights go out,
   * and would have completed itself on step one — you cannot win "do not get
   * wrecked" by existing for a frame.
   *
   * So completion needs either something that had to be ACHIEVED, or the flag.
   * Nothing in the catalogue is currently hold-only, which is exactly why this
   * had to be caught by a test rather than by playing it.
   */
  const hasAchieve = run.def.objectives.some(
    (o, i) => !run.objectives[i]!.optional && !HOLD_KINDS.has(o.kind),
  );
  if (required.some((s) => s.status === "failed")) {
    run.status = "failed";
  } else if (
    required.length > 0 &&
    required.every((s) => s.status === "met") &&
    (hasAchieve || raceOver)
  ) {
    run.status = "complete";
  } else if (raceOver && required.some((s) => s.status === "pending")) {
    run.status = "failed";
  }

  if (run.status !== "running" && run.resolvedAt === null) {
    run.resolvedAt = snap.raceTime;
    const line = run.status === "complete" ? "OBJECTIVES CLEAR" : "RUN LOST";
    run.announcements.push(line);
    effects.push({
      kind: "announce",
      message: line,
      event: run.status === "complete" ? "finish" : "wreck",
    });
    // The rival gets the last word too, and it is a different word depending on
    // which way it went.
    const headliner = run.def.grid?.[0]?.rivalId;
    if (headliner) {
      const bark = rivalBark(headliner, run.status === "complete" ? "lost" : "won");
      if (bark) {
        run.announcements.push(bark);
        effects.push({ kind: "announce", message: bark, event: "finish" });
      }
    }
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
  opts: { heatFloor?: number; fieldPace?: number } = {},
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
    // The standard of the whole grid, named or not. Anonymous house cars are
    // the ones a returning player notices least and should notice most.
    fieldPace: Math.max(0, Math.min(1, opts.fieldPace ?? 0)),
    playerId: "player",
  });

  const run = createMissionRun(def, 0);
  run.modifiers = mods;
  return run;
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
  // The rival is whichever grid slot carries their id — not assumed to be slot
  // 0, even though duelMission always puts them there. An event mission that
  // ever names a rival elsewhere should not silently report `false` forever.
  const rivalSlot = run.def.rivalId
    ? (run.def.grid?.findIndex((g) => g.rivalId === run.def.rivalId) ?? -1)
    : -1;
  return {
    missionId: run.def.id,
    rivalWrecked:
      rivalSlot >= 0 && run.book.takenDown.includes(`bot-${rivalSlot}`),
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
