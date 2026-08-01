import { RACE } from "./balance";
import { VEHICLE_CLASSES } from "./classes";
import { getSurfaceAt, getTrackSamples, nearestTrackIndex } from "./track";
import type { PlayerInput, VehicleState } from "./types";
import { createEmptyInput } from "./input";
import { findLockTarget } from "./combat";

function wrapAngle(a: number) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/* ── league heat / rival directives ───────────────────────────────────
 *
 * The combat layer is this game's stand-in for Most Wanted's police, and this
 * is where that actually happens. Heat is not a difficulty slider bolted onto
 * damage numbers: at high heat the field stops racing the race and starts
 * racing YOU, because the Feed pays a bounty on the player's wreck. The
 * mechanical difference between heat 1 and heat 5 is that at 5 every bot is
 * carrying a lock on you into every corner.
 *
 * Module-level rather than threaded through aiInput's arguments because sim.ts
 * owns that call site and this module does not. The mission runtime sets a
 * directive before the countdown and clears it at the flag; nothing else in the
 * sim needs to know it exists.
 */

/**
 * HOW a rival fights, as distinct from how hard.
 *
 * The single most common way a difficulty ladder goes wrong is that rank 2 is
 * rank 14 with bigger numbers. These are the four ways of being dangerous that
 * are actually different to drive against, and each one wants a different
 * answer from the player rather than more of the same answer:
 *
 *  racer   — the honest baseline. Races the race.
 *  blocker — owns the road ahead of you. Covers the inside, brake-checks the
 *            car in their mirrors. Beaten by taking the line they are not on.
 *  hunter  — does not care about the podium. Comes for you, holds the ultimate
 *            until you are hurt. Beaten by not being hurt.
 *  pacer   — never fires a shot and never makes a mistake. Beaten by driving,
 *            which is the whole point of putting one on the board.
 *  duelist — measures itself against YOU rather than the leader. Will not be
 *            dropped, will not run away, and rams on corner entry.
 */
export type RivalPattern = "racer" | "blocker" | "hunter" | "pacer" | "duelist";

/** Per-rival driving character. Blacklist names should not drive identically. */
export interface RivalProfile {
  /** 0..1 — weapon fire rate, ram commitment, willingness to trade paint. */
  aggression: number;
  /** 0..1 — line quality. High precision removes the idle steering wobble. */
  precision: number;
  /** 0..1 — how much they lift for a corner. Low = overdrives and runs wide. */
  patience: number;
  /** 0..1 — how early the ultimate comes out. */
  ultBias: number;
  /** 0..1 — preference for hunting the bounty target over the nearest car. */
  hunt: number;
  /**
   * 0..1 raw pace: grip, drive and corner commitment.
   *
   * Deliberately separate from `aggression`. A rival can be quick and clean
   * (Sparrow) or slow and vicious (Kiln), and collapsing the two into one
   * "difficulty" number is what makes a ladder feel like a slider.
   */
  pace: number;
  /** 0..1 — how often they throw one away. The player's overtaking window. */
  mistake: number;
  /**
   * 0..1 composure. Under 0.5 they fold when damaged or behind; over 0.5 they
   * get meaner. This is what makes "survive her first two laps" true of Novo
   * and false of Rhee.
   */
  nerve: number;
  pattern: RivalPattern;
}

export const DEFAULT_PROFILE: RivalProfile = {
  aggression: 0.5,
  precision: 0.5,
  patience: 0.5,
  ultBias: 0.5,
  hunt: 0.25,
  pace: 0.3,
  mistake: 0.55,
  nerve: 0.5,
  pattern: "racer",
};

export interface AiDirective {
  /** 0..1 League Heat, applied to the whole field on top of race drama. */
  heat: number;
  /** Mission-level aggression trim, added to every profile. */
  aggression: number;
  /** Multiplier on catch-up rubber-banding. 0 disables it (time attack). */
  catchUp: number;
  /** False = bots hold fire entirely. Escort and clean-lap missions need this. */
  weaponsFree: boolean;
  /** Vehicle id the field is being paid to wreck. Usually "player". */
  bountyOn: string | null;
  /** Vehicle id nobody may shoot — the escort target. */
  protect: string | null;
  /** Overrides by vehicle id ("bot-0".."bot-2"), from the rival roster. */
  profiles: Record<string, RivalProfile>;
  /**
   * 0..1 floor under every car's pace, including the anonymous house cars.
   *
   * This is the league getting better as you climb, and it is why rank 12 does
   * not become trivial once you are running rank 4's events: the extras on the
   * grid are no longer the extras you learned on. A floor rather than a
   * replacement, so an authored rival never gets slower than they were written.
   */
  fieldPace: number;
  /** Who the patterns orient themselves around. */
  playerId: string;
}

const NEUTRAL: AiDirective = {
  heat: 0,
  aggression: 0,
  catchUp: 1,
  weaponsFree: true,
  bountyOn: null,
  protect: null,
  profiles: {},
  fieldPace: 0,
  playerId: "player",
};

let directive: AiDirective = { ...NEUTRAL };

export function setAiDirective(next: Partial<AiDirective>): void {
  directive = { ...directive, ...next };
  mood.clear();
}

export function getAiDirective(): Readonly<AiDirective> {
  return directive;
}

/** Free play must not inherit the last mission's manhunt. Call on race exit. */
export function resetAiDirective(): void {
  directive = { ...NEUTRAL, profiles: {} };
  mood.clear();
}

function profileFor(id: string): RivalProfile {
  const p = directive.profiles[id];
  if (!p) {
    // House cars are not characters, but they are not stationary targets
    // either — they drive at whatever the league's current standard is.
    return directive.fieldPace > 0
      ? { ...DEFAULT_PROFILE, pace: Math.max(DEFAULT_PROFILE.pace, directive.fieldPace) }
      : DEFAULT_PROFILE;
  }
  return p.pace >= directive.fieldPace
    ? p
    : { ...p, pace: directive.fieldPace };
}

/* ── mistakes ─────────────────────────────────────────────────────────
 *
 * A field that never errs is not difficult, it is impermeable: every overtake
 * has to be forced with a weapon, and a clean racing line stops being a way to
 * win. So every driver is on a schedule of MOMENTS — a corner taken without
 * lifting, a late brake, an exit run wide — and the schedule's rate is the
 * rival's `mistake` trait.
 *
 * Two rules make the difference between this reading as character and reading
 * as the AI stuttering:
 *
 *  1. A moment only fires IN A CORNER or under close pressure. A car briefly
 *     losing grip on a straight is a bug; the same car understeering out of a
 *     hairpin with you alongside is a race.
 *  2. It is scheduled in world time, not rolled per frame, so it cannot fire
 *     twice in a second on a fast machine and never on a slow one.
 */
interface AiMood {
  /** World time the next moment is allowed to fire. */
  nextErrorAt: number;
  /** World time the current moment ends. 0 = not in one. */
  errorUntil: number;
  /** Last time this driver leaned on the brakes to check the car behind. */
  lastCheckAt: number;
}

const mood = new Map<string, AiMood>();

function moodFor(id: string, time: number, prof: RivalProfile): AiMood {
  let m = mood.get(id);
  if (!m) {
    // Stagger the first moment so a grid of four does not all wobble together
    // on the same corner of lap one.
    m = {
      nextErrorAt: time + 12 + Math.random() * 30,
      errorUntil: 0,
      // Far in the past, not zero: the brake-check reads `time - lastCheckAt`,
      // and a zero here has every blocker standing on the brakes off the line.
      lastCheckAt: -999,
    };
    mood.set(id, m);
  }
  void prof;
  return m;
}

/** Mean seconds between moments. Perfect drivers are simply never due one. */
function errorInterval(prof: RivalProfile): number {
  if (prof.pattern === "pacer") return Infinity;
  return 16 + (1 - prof.mistake) * 74;
}

/**
 * The car's side of driver skill, read by sim.fixedStep and handed to
 * stepVehicle. Must be called AFTER aiInput for the same step — aiInput is what
 * advances the moment schedule.
 */
export function aiSkill(v: VehicleState): {
  grip: number;
  power: number;
  turn: number;
} {
  if (v.isPlayer) return { grip: 1, power: 1, turn: 1 };
  const prof = profileFor(v.id);
  const m = mood.get(v.id);
  const erring = !!m && m.errorUntil > 0;
  // Nerve reads the car's condition: a driver with low nerve is measurably
  // slower once their hull is gone, which is what "folds harder" has to mean if
  // it is going to mean anything.
  const hurt = 1 - v.health / Math.max(1, v.maxHealth);
  const nerveTrim = hurt * (0.5 - prof.nerve) * 0.16;
  const pace = Math.max(0, Math.min(1, prof.pace - nerveTrim));
  return {
    grip: (0.93 + pace * 0.14) * (erring ? 0.88 : 1),
    power: 0.965 + pace * 0.075,
    turn: (0.95 + pace * 0.1) * (erring ? 0.9 : 1),
  };
}

/**
 * How far ahead to aim, in METRES, walked along the centreline.
 *
 * This used to be a fixed number of SAMPLES, which was only ever a distance
 * because every circuit happened to be sampled at the same spacing. Worse, a
 * fixed distance is itself wrong: on the Rustline slalom the point 70m ahead is
 * on the far side of two direction reversals, so a bot aiming at it drives the
 * chord — straight off the outside of the first apex and into the scrap.
 *
 * So the walk stops early once the road has turned enough. On a Sable Mile
 * sweeper the heading barely changes and the full distance is used; in a
 * hairpin the target collapses back to the entry and the bot actually turns in.
 * The cost is a short walk (<40 samples) per bot per step.
 */
function lookAheadIndex(
  idx: number,
  wantMetres: number,
  maxTurn: number,
): number {
  const S = getTrackSamples();
  const n = S.length;
  if (n < 3) return idx;
  let dist = 0;
  let turn = 0;
  let i = idx;
  for (let step = 0; step < 60; step++) {
    const a = S[i % n]!;
    const b = S[(i + 1) % n]!;
    dist += Math.hypot(b.x - a.x, b.z - a.z);
    turn += Math.abs(wrapAngle(b.yaw - a.yaw));
    i += 1;
    // The floor is not optional. In the Rustline slalom the heading budget is
    // spent in four samples, and a bot aiming twelve metres ahead is steering at
    // a point it is already on top of — full lock, then full lock the other way.
    if (dist >= wantMetres || (turn >= maxTurn && dist >= MIN_LOOKAHEAD)) break;
  }
  return i % n;
}

/** Metres. Below this the aim point stops being ahead of the car in any useful sense. */
const MIN_LOOKAHEAD = 16;

/**
 * Waypoint racer with class flavor + race drama:
 * - Last lap / behind: more aggression, more defense, earlier ults
 * - Class kits used under pressure (not just random)
 * - League Heat: the field hunts the bounty target instead of the podium
 */
export function aiInput(
  v: VehicleState,
  all: VehicleState[],
  time: number,
  lapCount: number = RACE.laps,
): PlayerInput {
  const input = createEmptyInput();
  if (v.wreckTimer > 0 || !v.alive) return input;

  const def = VEHICLE_CLASSES[v.classId];
  const samples = getTrackSamples();
  const n = samples.length;
  const idx = nearestTrackIndex(v.x, v.z, v.yaw);
  const prof = profileFor(v.id);
  const m = moodFor(v.id, time, prof);
  // The patterns all orient around one car. Resolved once, may be absent
  // (headless tests, a grid with no player) and every use guards for it.
  const mark = all.find((o) => o.id === directive.playerId) ?? null;
  const markDist = mark ? Math.hypot(mark.x - v.x, mark.z - v.z) : Infinity;

  // Drama flags
  const lastLap = v.lap >= lapCount - 1;
  const midPack = v.position >= 2;
  const desperate = v.position === all.filter((x) => x.alive).length || v.health < v.maxHealth * 0.35;
  const heat =
    (lastLap ? 0.35 : 0) +
    (midPack ? 0.15 : 0) +
    // Nerve, not a constant. A driver written as glass gets QUIETER in trouble;
    // one written as a pallbearer gets louder. Same flag, opposite sign.
    (desperate ? (prof.nerve - 0.5) * 0.7 : 0) +
    directive.heat * 0.4 +
    directive.aggression * 0.3 +
    (prof.aggression - 0.5) * 0.3;

  // Metres, not samples. Bruisers commit late, tricksters read early.
  const lookBase = v.classId === "bruiser" ? 30 : v.classId === "trickster" ? 42 : 36;
  const wantMetres =
    (lookBase + Math.abs(v.speed) * 1.25 + (lastLap ? 6 : 0)) *
    (0.85 + prof.patience * 0.3);
  // Impatient drivers keep looking through a corner they should be braking for.
  const maxTurn = 0.55 + prof.patience * 0.45;
  const lookIdx = lookAheadIndex(idx, wantMetres, maxTurn);
  const target = samples[lookIdx]!;
  const near = samples[idx]!;
  const ahead2 = samples[(lookIdx + 5) % n]!;
  const pathYaw = Math.atan2(-(ahead2.x - near.x), -(ahead2.z - near.z));
  const rx = Math.cos(pathYaw);
  const rz = -Math.sin(pathYaw);

  let bias =
    ((v.id.charCodeAt(v.id.length - 1) % 5) - 2) *
    (v.classId === "bruiser" ? 0.7 : 1.15) *
    (1.4 - prof.precision * 0.8);

  /*
   * BLOCKER — the road ahead is theirs.
   *
   * Implemented as a lateral bias toward the pursuer's side of the track rather
   * than as a steering override, so it stays a racing line: they are covering
   * the inside, not swerving at you. Clamped to the road's half width so the
   * cover never walks them into the scenery, and it only engages when the mark
   * is actually behind and close — a blocker on the far side of the circuit is
   * just a driver.
   */
  const behindMe =
    !!mark && markDist < 26 && mark.raceProgress < v.raceProgress;
  if (prof.pattern === "blocker" && behindMe && mark) {
    const off = (mark.x - near.x) * rx + (mark.z - near.z) * rz;
    const cover = Math.max(-1, Math.min(1, off / Math.max(1, near.width * 0.5)));
    bias = cover * near.width * 0.34;
  }

  const tx = target.x + rx * bias;
  const tz = target.z + rz * bias;

  const desiredYaw = Math.atan2(-(tx - v.x), -(tz - v.z));
  const dyaw = wrapAngle(desiredYaw - v.yaw);

  const cornerTight = Math.abs(dyaw) > 0.48;
  const veryTight = Math.abs(dyaw) > 0.82;

  /*
   * Moments. Only in a corner, or with someone close enough to have caused it.
   * Firing one on an empty straight would be indistinguishable from a physics
   * glitch, and would hand the player nothing.
   */
  if (m.errorUntil > 0 && time >= m.errorUntil) {
    m.errorUntil = 0;
    m.nextErrorAt = time + errorInterval(prof) * (0.6 + Math.random() * 0.8);
  }
  if (
    m.errorUntil === 0 &&
    time >= m.nextErrorAt &&
    (cornerTight || markDist < 14) &&
    Math.abs(v.speed) > def.maxSpeed * 0.35
  ) {
    m.errorUntil = time + 0.7 + prof.mistake * 0.5;
  }
  const erring = m.errorUntil > 0;

  input.steering = Math.max(
    -1,
    Math.min(1, dyaw * (2.4 + heat * 0.3) * (erring ? 0.6 : 1)),
  );

  /*
   * Corner speed budget — where `pace` actually earns its keep.
   *
   * Two different reasons to carry more speed into a corner, and they must not
   * be confused. An IMPATIENT rival lifts late and runs wide; that is a flaw you
   * exploit on the exit. A FAST rival lifts late and makes it stick, because
   * aiSkill has given the same car more grip on the same step. Without this term
   * pace was only a top-speed and grip trim, and a grip advantage a driver never
   * asks for is a difficulty setting that cannot be felt.
   */
  const liftSpeed =
    def.maxSpeed *
    (0.74 + (0.5 - prof.patience) * 0.3 + (prof.pace - 0.5) * 0.16);
  input.throttle = !erring && cornerTight && Math.abs(v.speed) > liftSpeed ? 0.55 : 1;

  if (v.classId === "trickster" && cornerTight && Math.abs(v.speed) > 14) {
    input.brake = !erring && Math.abs(dyaw) > 0.38;
    input.steering = Math.max(-1, Math.min(1, dyaw * (erring ? 1.6 : 2.7)));
    input.throttle = 0.85;
  } else {
    input.brake = !erring && veryTight && Math.abs(v.speed) > def.maxSpeed * 0.8;
  }

  /*
   * Blocker brake-check. Rate limited to once every four seconds and only above
   * a real speed, because the failure mode is a car that sits in front of you
   * at walking pace and turns a race into a wall.
   */
  if (
    prof.pattern === "blocker" &&
    behindMe &&
    markDist < 9 &&
    Math.abs(v.speed) > def.maxSpeed * 0.45 &&
    time - m.lastCheckAt > 4
  ) {
    m.lastCheckAt = time;
  }
  if (prof.pattern === "blocker" && time - m.lastCheckAt < 0.45) {
    input.throttle = 0.2;
    input.brake = true;
  }

  // Surface recovery
  const surf = getSurfaceAt(v.x, v.z, v.yaw);
  if (surf.factor > 0.2) {
    const toCenter = Math.atan2(-(near.x - v.x), -(near.z - v.z));
    const recover = wrapAngle(toCenter - v.yaw);
    const pull = Math.min(1, 0.45 + surf.factor);
    input.steering = Math.max(
      -1,
      Math.min(1, recover * 1.85 * pull + dyaw * (1 - pull * 0.5)),
    );
    input.throttle = surf.factor > 0.55 ? 0.72 : 0.88;
    input.brake = false;
    if (v.classId === "interceptor" && surf.factor > 0.4) input.throttle = 0.55;
    if (v.classId === "bruiser" && surf.factor < 0.75) input.throttle = 0.95;
  } else {
    const dist = Math.hypot(v.x - near.x, v.z - near.z);
    if (dist > near.width * 0.34) {
      const toCenter = Math.atan2(-(near.x - v.x), -(near.z - v.z));
      const recover = wrapAngle(toCenter - v.yaw);
      input.steering = Math.max(-1, Math.min(1, recover * 1.55 + dyaw * 0.55));
      input.throttle = 0.78;
      input.brake = false;
    }
  }

  // Boost: more on last lap / trailing
  const boostChance =
    0.1 + heat * 0.25 + (Math.abs(dyaw) < 0.28 ? 0.12 : 0);
  if (v.position > 1 && Math.abs(dyaw) < 0.4) {
    input.boost = Math.sin(time * 3 + v.id.length) > 0.05 - heat;
  } else if (Math.abs(dyaw) < 0.22 && v.speed < def.maxSpeed * 0.9) {
    input.boost = Math.random() < boostChance;
  }

  // Combat
  let lock = findLockTarget(v, all, def.primaryRange * (0.95 + heat * 0.1));

  /*
   * Bounty override — the pursuit mechanic.
   *
   * findLockTarget picks whatever is closest and most centred, which is correct
   * for a race and useless for a manhunt: the bot happily shoots the car beside
   * it while the wanted man drives away. Under a bounty, the target is taken if
   * it is anywhere in a wide forward cone at up to 1.4x normal range, and only
   * then does the ordinary nearest-target logic get a look in.
   *
   * The reach scales with heat and the rival's own hunt trait so that a low-heat
   * race still feels like a race, and so a rival characterised as a hunter plays
   * like one even when the league is calm.
   */
  const huntWeight = Math.min(
    1,
    directive.heat * 0.7 +
      prof.hunt * 0.6 +
      // A HUNTER carries the bounty in their own head. They come for you whether
      // or not the Feed is paying tonight, which is the whole reason they are a
      // different fight rather than a higher number.
      (prof.pattern === "hunter" ? 0.7 : 0),
  );
  const bountyId =
    prof.pattern === "hunter" ? (directive.bountyOn ?? directive.playerId) : directive.bountyOn;
  if (bountyId && huntWeight > 0.15) {
    const bounty = all.find((o) => o.id === bountyId);
    if (bounty && bounty.alive && bounty.wreckTimer <= 0 && bounty.id !== v.id) {
      const d = Math.hypot(bounty.x - v.x, bounty.z - v.z);
      const toMark = Math.atan2(-(bounty.x - v.x), -(bounty.z - v.z));
      const off = Math.abs(wrapAngle(toMark - v.yaw));
      if (d < def.primaryRange * (1 + huntWeight * 0.4) && off < 0.5 + huntWeight * 0.5) {
        lock = bounty.id;
      }
    }
  }
  // Escort ally. Cheaper to drop the lock than to filter every fire site.
  if (directive.protect && lock === directive.protect) lock = null;
  // A PACER does not shoot. Not "shoots rarely" — never. It is the one rival
  // archetype whose entire threat is the stopwatch, and a single stray bolt
  // would rewrite what the fight is about.
  if (prof.pattern === "pacer") lock = null;
  v.lockTargetId = lock;

  // Incoming threat → defense
  let underFire = false;
  for (const o of all) {
    if (o.id === v.id || !o.alive) continue;
    const d = Math.hypot(o.x - v.x, o.z - v.z);
    if (d < 14) {
      const toMe = Math.atan2(-(v.x - o.x), -(v.z - o.z));
      if (Math.abs(wrapAngle(toMe - o.yaw)) < 0.4) underFire = true;
    }
  }
  if (
    underFire &&
    v.defenseCooldown <= 0 &&
    (v.health < v.maxHealth * (0.55 - heat * 0.1) || lastLap)
  ) {
    if (Math.random() < 0.06 + heat * 0.05) input.useDefense = true;
  }

  if (lock && Math.abs(dyaw) < 0.6) {
    const t = all.find((x) => x.id === lock);
    if (t) {
      const d = Math.hypot(t.x - v.x, t.z - v.z);
      const toT = Math.atan2(-(t.x - v.x), -(t.z - v.z));
      const aimOk = Math.abs(wrapAngle(toT - v.yaw)) < 0.48;
      if (aimOk && d < def.primaryRange && directive.weaponsFree) {
        // Cadence is a rival trait, not just a class one. Vance shooting at
        // nearly one and a half times Sparrow's rate is most of what "counts his
        // takedowns on air" means once you are in front of him.
        const fireRate =
          ((v.classId === "interceptor" ? 0.45 : v.classId === "bruiser" ? 0.3 : 0.34) +
            heat * 0.2) *
          (0.55 + prof.aggression * 0.9);
        input.firePrimary = Math.random() < fireRate;
      }
      // Bruiser ram charge. Ramming is not a weapon and survives weaponsFree:
      // an escort mission still has traffic that will lean on you.
      if (v.classId === "bruiser" && d < 12 && aimOk) {
        input.throttle = 1;
        input.boost = true;
        input.brake = false;
        if (d < 8 && Math.abs(wrapAngle(toT - v.yaw)) < 0.25) {
          input.steering = Math.max(-1, Math.min(1, wrapAngle(toT - v.yaw) * 3));
        }
      }
      // Trickster: defense when target behind and close
      if (v.classId === "trickster" && d < 10 && !aimOk && v.defenseCooldown <= 0) {
        if (Math.random() < 0.04 + heat * 0.04) input.useDefense = true;
      }
      if (v.health < v.maxHealth * 0.42 && v.defenseCooldown <= 0 && Math.random() < 0.04 + heat * 0.03) {
        input.useDefense = true;
      }
    }
  }

  /*
   * DUELIST ram, timed rather than ranged.
   *
   * The ordinary bruiser charge fires on distance, which means it lands on the
   * straight where you can simply out-accelerate it. A duellist waits until you
   * are loaded up — steering angle on, car already sliding — because that is the
   * hit you cannot drive out of. It reads as being read.
   */
  if (prof.pattern === "duelist" && mark && markDist < 17 && mark.alive) {
    const busy = Math.abs(mark.steerAngle) > 0.22 || Math.abs(mark.lateral) > 5.5;
    const toMark = wrapAngle(
      Math.atan2(-(mark.x - v.x), -(mark.z - v.z)) - v.yaw,
    );
    if (busy && Math.abs(toMark) < 0.7) {
      input.throttle = 1;
      input.brake = false;
      input.boost = true;
      input.steering = Math.max(-1, Math.min(1, toMark * 2.6));
    }
  }

  // Ultimates — earlier on last lap / desperate / high heat / by rival taste
  const ultThreshold =
    (lastLap || desperate ? 0.72 : 0.88) - (prof.ultBias - 0.5) * 0.3 - directive.heat * 0.12;
  // A hunter does not spend the ultimate on traffic. It is held for the moment
  // the mark is already hurt, which is what makes being hurt around one bad.
  const ultHeld =
    prof.pattern === "hunter" &&
    !!mark &&
    mark.alive &&
    markDist < def.primaryRange * 1.8 &&
    mark.health > mark.maxHealth * 0.55;
  if (
    v.ultimateCharge >= 1 &&
    directive.weaponsFree &&
    !ultHeld &&
    (v.position > 1 || v.health < v.maxHealth * 0.55 || lastLap || directive.heat > 0.5)
  ) {
    if (v.classId === "bruiser" && lock) {
      const t = all.find((x) => x.id === lock);
      if (t && Math.hypot(t.x - v.x, t.z - v.z) < 12) input.useUltimate = true;
    } else if (v.classId === "trickster" && Math.abs(dyaw) < 0.35) {
      input.useUltimate = Math.sin(time * 1.7 + v.id.length) > ultThreshold - 0.05;
    } else if (Math.sin(time * 2.1 + v.id.length) > ultThreshold) {
      input.useUltimate = true;
    }
  }

  // Idle wobble is what makes a bot look human. A precise rival should not have
  // it — that is most of what "this one is better than the last one" reads as.
  input.steering += Math.sin(time * 1.6 + v.id.length * 2) * 0.028 * (1.3 - prof.precision);
  return input;
}

/**
 * Rubber-band amount for a vehicle (−0.1 .. catchUpMax).
 *
 * Three rules make this defensible rather than cheap, and they are the whole
 * reason this is not two lines:
 *
 *  1. It is measured against the LEADER, not the player, so a player who is
 *     winning by a mile is not personally chased. Being fast is allowed to be
 *     rewarded.
 *  2. It fades to nothing inside 30 metres of the player. The thing that reads
 *     as cheating is not a car that is quick on the far side of the circuit, it
 *     is watching a car glued to your bumper up a straight it has no business
 *     matching you on. Out of sight it keeps the field together; in your mirror
 *     it is off.
 *  3. It can be negative, but only for a duellist and only when they are ahead
 *     of the PLAYER. A boss that disappears at half distance is not a fight.
 */
export function catchUpFactor(
  v: VehicleState,
  all: VehicleState[],
  lapCount: number = RACE.laps,
): number {
  if (v.isPlayer || v.finished) return 0;
  // A time attack with rubber-banded traffic is not a time attack, and a boss
  // duel where the boss is towed back to you by the physics is not a duel.
  if (directive.catchUp <= 0) return 0;

  const mark = all.find((o) => o.id === directive.playerId) ?? null;
  const prof = profileFor(v.id);

  if (prof.pattern === "duelist" && mark) {
    // Anchored to you, symmetric, and clamped tight in both directions.
    const gap = mark.raceProgress - v.raceProgress;
    const trim = Math.max(-0.09, Math.min(0.16, gap * 0.5)) * directive.catchUp;
    return nearFade(v, mark, trim);
  }

  let leader = 0;
  for (const o of all) {
    if (o.raceProgress > leader) leader = o.raceProgress;
  }
  const gap = leader - v.raceProgress;
  if (gap < RACE.catchUpStartGap) return 0;
  // Slightly stronger catch-up on last stretch of race progress
  const late = leader > lapCount - 0.4 ? 1.2 : 1;
  const amount =
    Math.min(RACE.catchUpMax * late, (gap - RACE.catchUpStartGap) * 0.14 * late) *
    directive.catchUp;
  return mark ? nearFade(v, mark, amount) : amount;
}

/** Rule 2 above: no assistance a player can watch happening. */
function nearFade(v: VehicleState, mark: VehicleState, amount: number): number {
  if (amount <= 0) return amount;
  const d = Math.hypot(mark.x - v.x, mark.z - v.z);
  if (d >= 30) return amount;
  return amount * Math.max(0, (d - 8) / 22);
}
