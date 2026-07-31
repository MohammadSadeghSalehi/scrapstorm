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
}

export const DEFAULT_PROFILE: RivalProfile = {
  aggression: 0.5,
  precision: 0.5,
  patience: 0.5,
  ultBias: 0.5,
  hunt: 0.25,
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
}

const NEUTRAL: AiDirective = {
  heat: 0,
  aggression: 0,
  catchUp: 1,
  weaponsFree: true,
  bountyOn: null,
  protect: null,
  profiles: {},
};

let directive: AiDirective = { ...NEUTRAL };

export function setAiDirective(next: Partial<AiDirective>): void {
  directive = { ...directive, ...next };
}

export function getAiDirective(): Readonly<AiDirective> {
  return directive;
}

/** Free play must not inherit the last mission's manhunt. Call on race exit. */
export function resetAiDirective(): void {
  directive = { ...NEUTRAL, profiles: {} };
}

function profileFor(id: string): RivalProfile {
  return directive.profiles[id] ?? DEFAULT_PROFILE;
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
export function aiInput(v: VehicleState, all: VehicleState[], time: number): PlayerInput {
  const input = createEmptyInput();
  if (v.wreckTimer > 0 || !v.alive) return input;

  const def = VEHICLE_CLASSES[v.classId];
  const samples = getTrackSamples();
  const n = samples.length;
  const idx = nearestTrackIndex(v.x, v.z, v.yaw);
  const prof = profileFor(v.id);

  // Drama flags
  const lastLap = v.lap >= RACE.laps - 1;
  const midPack = v.position >= 2;
  const desperate = v.position === all.filter((x) => x.alive).length || v.health < v.maxHealth * 0.35;
  const heat =
    (lastLap ? 0.35 : 0) +
    (midPack ? 0.15 : 0) +
    (desperate ? 0.25 : 0) +
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

  const bias =
    ((v.id.charCodeAt(v.id.length - 1) % 5) - 2) *
    (v.classId === "bruiser" ? 0.7 : 1.15) *
    (1.4 - prof.precision * 0.8);
  const tx = target.x + rx * bias;
  const tz = target.z + rz * bias;

  const desiredYaw = Math.atan2(-(tx - v.x), -(tz - v.z));
  let dyaw = wrapAngle(desiredYaw - v.yaw);
  input.steering = Math.max(-1, Math.min(1, dyaw * (2.4 + heat * 0.3)));

  const cornerTight = Math.abs(dyaw) > 0.48;
  const veryTight = Math.abs(dyaw) > 0.82;
  // An impatient rival carries 15% more speed into the corner than the line
  // supports. That is not "better" — it is why they run wide and why you can
  // have them on the exit.
  const liftSpeed = def.maxSpeed * (0.74 + (0.5 - prof.patience) * 0.3);
  input.throttle = cornerTight && Math.abs(v.speed) > liftSpeed ? 0.55 : 1;

  if (v.classId === "trickster" && cornerTight && Math.abs(v.speed) > 14) {
    input.brake = Math.abs(dyaw) > 0.38;
    input.steering = Math.max(-1, Math.min(1, dyaw * 2.7));
    input.throttle = 0.85;
  } else {
    input.brake = veryTight && Math.abs(v.speed) > def.maxSpeed * 0.8;
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
  const huntWeight = Math.min(1, directive.heat * 0.7 + prof.hunt * 0.6);
  if (directive.bountyOn && huntWeight > 0.15) {
    const mark = all.find((o) => o.id === directive.bountyOn);
    if (mark && mark.alive && mark.wreckTimer <= 0 && mark.id !== v.id) {
      const d = Math.hypot(mark.x - v.x, mark.z - v.z);
      const toMark = Math.atan2(-(mark.x - v.x), -(mark.z - v.z));
      const off = Math.abs(wrapAngle(toMark - v.yaw));
      if (d < def.primaryRange * (1 + huntWeight * 0.4) && off < 0.5 + huntWeight * 0.5) {
        lock = mark.id;
      }
    }
  }
  // Escort ally. Cheaper to drop the lock than to filter every fire site.
  if (directive.protect && lock === directive.protect) lock = null;
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
        const fireRate =
          (v.classId === "interceptor" ? 0.45 : v.classId === "bruiser" ? 0.3 : 0.34) +
          heat * 0.2;
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

  // Ultimates — earlier on last lap / desperate / high heat / by rival taste
  const ultThreshold =
    (lastLap || desperate ? 0.72 : 0.88) - (prof.ultBias - 0.5) * 0.3 - directive.heat * 0.12;
  if (
    v.ultimateCharge >= 1 &&
    directive.weaponsFree &&
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

/** Rubber-band amount for a vehicle vs race leader (0..catchUpMax). */
export function catchUpFactor(v: VehicleState, all: VehicleState[]): number {
  if (v.isPlayer || v.finished) return 0;
  // A time attack with rubber-banded traffic is not a time attack, and a boss
  // duel where the boss is towed back to you by the physics is not a duel.
  if (directive.catchUp <= 0) return 0;
  let leader = 0;
  for (const o of all) {
    if (o.raceProgress > leader) leader = o.raceProgress;
  }
  const gap = leader - v.raceProgress;
  if (gap < RACE.catchUpStartGap) return 0;
  // Slightly stronger catch-up on last stretch of race progress
  const late = leader > RACE.laps - 0.4 ? 1.2 : 1;
  return (
    Math.min(RACE.catchUpMax * late, (gap - RACE.catchUpStartGap) * 0.14 * late) *
    directive.catchUp
  );
}
