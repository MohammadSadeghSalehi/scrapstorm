import { RACE } from "./balance";
import { VEHICLE_CLASSES } from "./classes";
import { TRACK_SAMPLES, getSurfaceAt, nearestTrackIndex } from "./track";
import type { PlayerInput, VehicleState } from "./types";
import { createEmptyInput } from "./input";
import { findLockTarget } from "./combat";

function wrapAngle(a: number) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * Waypoint racer with class flavor + race drama:
 * - Last lap / behind: more aggression, more defense, earlier ults
 * - Class kits used under pressure (not just random)
 */
export function aiInput(v: VehicleState, all: VehicleState[], time: number): PlayerInput {
  const input = createEmptyInput();
  if (v.wreckTimer > 0 || !v.alive) return input;

  const def = VEHICLE_CLASSES[v.classId];
  const n = TRACK_SAMPLES.length;
  const idx = nearestTrackIndex(v.x, v.z, v.yaw);

  // Drama flags
  const lastLap = v.lap >= RACE.laps - 1;
  const midPack = v.position >= 2;
  const desperate = v.position === all.filter((x) => x.alive).length || v.health < v.maxHealth * 0.35;
  const heat = (lastLap ? 0.35 : 0) + (midPack ? 0.15 : 0) + (desperate ? 0.25 : 0);

  const lookBase = v.classId === "bruiser" ? 10 : v.classId === "trickster" ? 14 : 12;
  const look = lookBase + Math.floor(Math.abs(v.speed) * 0.4) + (lastLap ? 2 : 0);
  const target = TRACK_SAMPLES[(idx + look) % n];
  const near = TRACK_SAMPLES[idx];
  const ahead2 = TRACK_SAMPLES[(idx + look + 5) % n];
  const pathYaw = Math.atan2(-(ahead2.x - near.x), -(ahead2.z - near.z));
  const rx = Math.cos(pathYaw);
  const rz = -Math.sin(pathYaw);

  const bias =
    ((v.id.charCodeAt(v.id.length - 1) % 5) - 2) * (v.classId === "bruiser" ? 0.7 : 1.15);
  const tx = target.x + rx * bias;
  const tz = target.z + rz * bias;

  const desiredYaw = Math.atan2(-(tx - v.x), -(tz - v.z));
  let dyaw = wrapAngle(desiredYaw - v.yaw);
  input.steering = Math.max(-1, Math.min(1, dyaw * (2.4 + heat * 0.3)));

  const cornerTight = Math.abs(dyaw) > 0.48;
  const veryTight = Math.abs(dyaw) > 0.82;
  input.throttle = cornerTight && Math.abs(v.speed) > def.maxSpeed * 0.74 ? 0.55 : 1;

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
  const lock = findLockTarget(v, all, def.primaryRange * (0.95 + heat * 0.1));
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
      if (aimOk && d < def.primaryRange) {
        const fireRate =
          (v.classId === "interceptor" ? 0.45 : v.classId === "bruiser" ? 0.3 : 0.34) +
          heat * 0.2;
        input.firePrimary = Math.random() < fireRate;
      }
      // Bruiser ram charge
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

  // Ultimates — earlier on last lap / desperate
  const ultThreshold = lastLap || desperate ? 0.72 : 0.88;
  if (v.ultimateCharge >= 1 && (v.position > 1 || v.health < v.maxHealth * 0.55 || lastLap)) {
    if (v.classId === "bruiser" && lock) {
      const t = all.find((x) => x.id === lock);
      if (t && Math.hypot(t.x - v.x, t.z - v.z) < 12) input.useUltimate = true;
    } else if (v.classId === "trickster" && Math.abs(dyaw) < 0.35) {
      input.useUltimate = Math.sin(time * 1.7 + v.id.length) > ultThreshold - 0.05;
    } else if (Math.sin(time * 2.1 + v.id.length) > ultThreshold) {
      input.useUltimate = true;
    }
  }

  input.steering += Math.sin(time * 1.6 + v.id.length * 2) * 0.028;
  return input;
}

/** Rubber-band amount for a vehicle vs race leader (0..catchUpMax). */
export function catchUpFactor(v: VehicleState, all: VehicleState[]): number {
  if (v.isPlayer || v.finished) return 0;
  let leader = 0;
  for (const o of all) {
    if (o.raceProgress > leader) leader = o.raceProgress;
  }
  const gap = leader - v.raceProgress;
  if (gap < RACE.catchUpStartGap) return 0;
  // Slightly stronger catch-up on last stretch of race progress
  const late = leader > RACE.laps - 0.4 ? 1.2 : 1;
  return Math.min(RACE.catchUpMax * late, (gap - RACE.catchUpStartGap) * 0.14 * late);
}
