import { COMBAT, HANDLING, OFFROAD } from "./balance";
import { VEHICLE_CLASSES } from "./classes";
import { getGroundHeight, getSurfaceAt } from "./track";
import { stepTires, tireGripMul, tireScrubDrag } from "./tires";
import type { Particle, PlayerInput, VehicleClassId, VehicleState } from "./types";

/** OBB half-extents (world units) per class — matches modular mesh footprint */
export const VEHICLE_HITBOX: Record<
  VehicleClassId,
  { halfW: number; halfL: number; radius: number }
> = {
  interceptor: { halfW: 0.92, halfL: 1.68, radius: 1.55 },
  bruiser: { halfW: 1.22, halfL: 1.95, radius: 1.95 },
  trickster: { halfW: 0.88, halfL: 1.52, radius: 1.48 },
};

let partSeq = 0;
function pid() {
  partSeq += 1;
  return `px-${partSeq}-${(Math.random() * 1e9) | 0}`;
}

function surfaceMods(factor: number, classPenalty: number) {
  const f = Math.min(1, Math.max(0, factor * classPenalty));
  return {
    maxSpeedMul: 1 - f * OFFROAD.maxSpeedLoss,
    accelMul: 1 - f * OFFROAD.accelLoss,
    gripMul: 1 - f * OFFROAD.gripLoss,
    turnMul: 1 - f * OFFROAD.turnLoss,
    scrub: f * 2.8,
    slip: f * f * 0.5,
    sink: f * 0.2,
    dust: f,
  };
}

/**
 * Rolling resistance per surface, as an exponential decay rate (see the
 * `v.speed *= 1 - drag * dt` below).
 *
 * These were 0.4 / 0.85 / 1.2 against asphalt's 0.016 — a 25x jump the instant
 * a wheel touched the apron, and 53x on sand. At 60Hz that bleeds 33% of your
 * speed per second on the apron and 58% on sand, which reads as driving into
 * treacle rather than onto soft ground.
 *
 * The real problem was double-penalising: surfaceMods already applies
 * OFFROAD.maxSpeedLoss (0.38) and accelLoss (0.4), so terrain ALREADY caps what
 * you can achieve off the tarmac. The drag then punished you a second time for
 * the same mistake. Softened so the cap does the limiting and the drag only
 * gives soft ground its weight; the handling penalty now comes mostly from
 * grip and steering, which is where an offroad excursion should actually hurt.
 */
function dragForSurface(kind: VehicleState["surface"], factor: number, coasting: boolean): number {
  if (kind === "asphalt") return HANDLING.roadDrag + factor * 0.06 + (coasting ? HANDLING.coastDrag : 0);
  if (kind === "apron") return 0.09 + factor * 0.05 + (coasting ? 0.1 : 0);
  if (kind === "sand") return 0.2 + factor * 0.1 + (coasting ? 0.13 : 0);
  return 0.38 + factor * 0.14 + (coasting ? 0.16 : 0);
}

/**
 * Body-frame (speed, lateral) resolved into world XZ.
 *
 * Exported because impact energy has to be measured in world space: a barrier
 * scrape changes yaw as well as speed, so comparing `v.speed` before and after
 * a collision reports a delta that is partly just the body frame rotating.
 */
export function worldVelocity(v: VehicleState): { vx: number; vz: number } {
  const fx = -Math.sin(v.yaw);
  const fz = -Math.cos(v.yaw);
  const rx = Math.cos(v.yaw);
  const rz = -Math.sin(v.yaw);
  return {
    vx: fx * v.speed + rx * v.lateral,
    vz: fz * v.speed + rz * v.lateral,
  };
}

function applyWorldVel(v: VehicleState, vx: number, vz: number) {
  const fx = -Math.sin(v.yaw);
  const fz = -Math.cos(v.yaw);
  const rx = Math.cos(v.yaw);
  const rz = -Math.sin(v.yaw);
  v.speed = vx * fx + vz * fz;
  v.lateral = vx * rx + vz * rz;
}

/**
 * Ramped steering command for the player, carried across fixed steps.
 *
 * Deliberately not a VehicleState field: types.ts is shared with the UI layer,
 * which builds VehicleState literals of its own, and this is an input
 * conditioner rather than part of the observable vehicle state. `v.steerAngle`
 * cannot serve as the store either — tires.ts overwrites it every step with its
 * own load-weighted visual angle.
 *
 * One scalar because only one vehicle is ever player-controlled. AI is
 * excluded on purpose: aiInput is a continuous closed-loop controller, and
 * inserting a couple hundred milliseconds of phase lag into a loop already
 * correcting on lateral error is how you get bots that weave.
 */
let playerSteerCmd = 0;

/** Clear on a grid reset so a key held at the flag does not survive into it. */
export function resetSteerRamp() {
  playerSteerCmd = 0;
}

function rampPlayerSteer(target: number, speedRatio: number, dt: number): number {
  const prev = playerSteerCmd;
  // Unwinding — including crossing centre — takes the fast rate, so catching a
  // slide or lifting out of a corner stays sharp. Only committing further into
  // a turn is slowed, which is where the twitch actually lives.
  const releasing = Math.abs(target) < Math.abs(prev) || target * prev < 0;
  const rate = releasing
    ? HANDLING.steerRampRelease
    : HANDLING.steerRampLoad * (1 - speedRatio * HANDLING.steerRampSpeedDrop);
  const max = rate * dt;
  const d = target - prev;
  playerSteerCmd = prev + (d > max ? max : d < -max ? -max : d);
  return playerSteerCmd;
}

/**
 * True when the player is in a handbrake-slide (not a full stop).
 * Shift alone at low speed / no steer = brake. Shift + steer at pace = drift.
 */
export function isDrifting(
  v: VehicleState,
  input: PlayerInput,
  forced?: boolean,
): boolean {
  if (forced) return Math.abs(v.speed) > 8 && Math.abs(input.steering) > 0.12;
  return (
    input.brake &&
    Math.abs(input.steering) > 0.2 &&
    Math.abs(v.speed) > 10
  );
}

export function stepVehicle(
  v: VehicleState,
  input: PlayerInput,
  dt: number,
  opts?: {
    drifting?: boolean;
    particles?: Particle[] | null;
    catchUp?: number;
    /**
     * Driver skill, as multipliers on what the CAR can do rather than on what
     * it is asked to do.
     *
     * This is the difference between a hard rival and a fast one. Bolting
     * difficulty onto top speed alone produces a car you cannot pass on the
     * straight and can walk away from in every corner — the worst of both. A
     * better driver here holds more grip and rotates a little quicker, so they
     * are hard to shake through a sequence of corners and beatable on a
     * mistake, which is where overtakes should come from.
     *
     * Kept deliberately narrow (roughly ±7% grip, ±4% power). These stack with
     * catch-up and with class stats; wider and the field stops feeling like it
     * is driving the same cars you are.
     */
    skill?: { grip: number; power: number; turn: number } | null,
  },
): { driftCharge: number; ramSpeed: number } {
  v.impactFlash = Math.max(0, v.impactFlash - dt);
  v.hitStun = Math.max(0, v.hitStun - dt);

  if (v.wreckTimer > 0 || !v.alive) {
    v.speed *= Math.max(0, 1 - 3.5 * dt);
    v.lateral *= Math.max(0, 1 - 5 * dt);
    v.bodyRoll *= Math.max(0, 1 - 4 * dt);
    v.bodyPitch *= Math.max(0, 1 - 4 * dt);
    v.driftMeter = 0;
    if (v.tires) {
      for (const t of v.tires) {
        t.compress *= Math.max(0, 1 - 3 * dt);
        t.lat *= Math.max(0, 1 - 4 * dt);
        t.long *= Math.max(0, 1 - 4 * dt);
        t.slip *= Math.max(0, 1 - 3 * dt);
        t.spin *= Math.max(0, 1 - 2 * dt);
        if (t.temp !== undefined) t.temp += (38 - t.temp) * Math.min(1, 0.6 * dt);
      }
    }
    integratePos(v, dt);
    return { driftCharge: 0, ramSpeed: 0 };
  }

  const def = VEHICLE_CLASSES[v.classId];
  const prevSpeed = v.speed;
  let maxSpeed = def.maxSpeed;
  let accel = def.accel;
  let turnRate = def.turnRate;
  let grip = def.grip;

  const dmg = Math.min(1, v.damageVisual);
  maxSpeed *= 1 - dmg * COMBAT.dmgSpeedPenalty;
  accel *= 1 - dmg * COMBAT.dmgAccelPenalty;

  const skill = opts?.skill;
  if (skill) {
    grip *= skill.grip;
    maxSpeed *= skill.power;
    accel *= skill.power;
    turnRate *= skill.turn;
  }

  /*
   * Catch-up is allowed to go NEGATIVE.
   *
   * A boss who cannot be dropped is the point of a boss; a boss who vanishes
   * over the horizon at half distance is a loading screen. ai.catchUpFactor
   * returns a small negative trim for a duelling rival that is too far AHEAD,
   * which reads as them waiting for you rather than as the physics towing you
   * back. The negative side is clamped much tighter than the positive one so it
   * can never turn into a car that is visibly parked.
   */
  const catchUp = Math.min(0.22, Math.max(-0.1, opts?.catchUp ?? 0));
  if (catchUp !== 0) {
    maxSpeed *= 1 + catchUp;
    accel *= 1 + catchUp * 1.25;
  }

  if (v.boostTimer > 0) {
    maxSpeed *= 1.18;
    accel *= 1.32;
    v.boostTimer = Math.max(0, v.boostTimer - dt);
  }
  if (v.nearMissBoost > 0) {
    maxSpeed *= 1.09;
    v.nearMissBoost = Math.max(0, v.nearMissBoost - dt);
  }
  if (v.ultimateActive > 0 && v.classId === "bruiser") {
    maxSpeed *= 1.32;
    accel *= 1.5;
    grip = Math.min(grip, 0.55);
  }
  if (v.ultimateActive > 0 && v.classId === "interceptor") {
    maxSpeed *= 1.18;
    accel *= 1.12;
  }
  if (v.defenseActive > 0 && v.classId === "interceptor") {
    maxSpeed *= 1.08;
  }

  if (input.boost) {
    accel *= 1.22;
    maxSpeed *= 1.05;
  }

  const surf = getSurfaceAt(v.x, v.z, v.yaw);
  const mods = surfaceMods(surf.factor, def.offroadPenalty);
  v.surface = surf.kind;
  v.offroadAmount = Math.min(1, surf.factor);

  maxSpeed *= mods.maxSpeedMul;
  accel *= mods.accelMul;
  grip *= mods.gripMul;
  turnRate *= mods.turnMul;
  grip *= tireGripMul(v);

  if (input.boost && surf.factor > 0.25) {
    accel *= 1 - surf.factor * 0.3;
    maxSpeed *= 1 - surf.factor * 0.1;
  }

  if (surf.factor > 0.2 && Math.abs(v.speed) > 18) {
    turnRate *= 1 - Math.min(0.22, (Math.abs(v.speed) - 18) * 0.005 * surf.factor);
  }

  if (v.hitStun > 0) {
    turnRate *= 0.55;
    accel *= 0.7;
  }

  const speedRatio = Math.min(1, Math.abs(v.speed) / Math.max(1, maxSpeed));
  const lowBoost = 1 + (1 - speedRatio) * ((HANDLING.lowSpeedSteerBoost ?? 1.3) - 1);
  const highMul =
    speedRatio > 0.65
      ? 1 - (speedRatio - 0.65) * (1 - (HANDLING.highSpeedSteerMul ?? 0.75)) / 0.35
      : 1;
  turnRate *= lowBoost * Math.max(0.55, highMul);

  // Progressive torque: soft launch → fat mid → hard taper near Vmax
  const t0 = HANDLING.torqueAt0 ?? 0.9;
  const tMid = HANDLING.torqueAtMid ?? 0.78;
  const tTop = HANDLING.torqueAtTop ?? 0.42;
  let torqueMul: number;
  if (speedRatio < 0.4) {
    const u = speedRatio / 0.4;
    torqueMul = t0 + (tMid - t0) * u * u;
  } else {
    const u = (speedRatio - 0.4) / 0.6;
    // ease-in taper so the last third of the speedo is a real climb
    const ee = u * u * (1.15 - 0.15 * u);
    torqueMul = tMid + (tTop - tMid) * ee;
  }
  if (
    input.throttle > 0.9 &&
    Math.abs(v.speed) < maxSpeed * 0.14 &&
    !input.brake
  ) {
    torqueMul *= HANDLING.launchMul ?? 1.0;
  }

  const wantDrift = isDrifting(v, input, opts?.drifting);

  if (wantDrift) {
    const thr = Math.max(input.throttle, input.boost ? 1 : 0);
    v.speed += thr * accel * torqueMul * HANDLING.driftThrottleMul * dt;
    v.speed *= Math.max(0, 1 - HANDLING.driftHandbrakeDrag * dt);
  } else if (input.brake) {
    const brakeMul =
      (HANDLING.brakeForceMul ?? 2.2) *
      (1 + surf.factor * 0.15) *
      (1 + Math.min(0.35, Math.abs(v.speed) / 120));
    if (v.speed > 0.4) {
      v.speed -= accel * brakeMul * dt;
      if (v.speed < 0) v.speed = 0;
    } else if (input.reverse) {
      // Rolled to a stop with S still held: pull away backwards instead of
      // sitting pinned at zero. reverseMaxFrac below caps it well under the
      // forward top speed, and Shift-only braking never reaches this branch.
      v.speed -= accel * (HANDLING.reverseAccelMul ?? 0.55) * torqueMul * dt;
    } else if (v.speed < 0) {
      v.speed += accel * Math.max(brakeMul, 1.3) * dt;
      if (v.speed > 0) v.speed = 0;
    }
    v.bodyPitch = Math.min(0.22, (v.bodyPitch ?? 0) * 0.9 + 0.08);
  } else {
    v.speed += input.throttle * accel * torqueMul * dt;
    if (input.throttle > 0.8 && Math.abs(v.speed) < maxSpeed * 0.25) {
      v.bodyPitch = Math.max(-0.14, (v.bodyPitch ?? 0) * 0.9 - 0.05);
    }
  }

  const coasting = input.throttle < 0.12 && !input.brake && !input.boost && !wantDrift;
  let drag = dragForSurface(surf.kind, surf.factor, coasting);
  if (coasting && Math.abs(v.speed) > 5) {
    drag += HANDLING.engineBrake ?? 0.1;
  }
  if (input.brake && !wantDrift && v.speed > 2) drag += HANDLING.brakeDrag * 0.22;
  drag += mods.scrub * (Math.abs(v.lateral) / Math.max(8, Math.abs(v.speed) + 4)) * 0.35;
  drag += tireScrubDrag(v) * 0.85;

  const spAbs = Math.abs(v.speed);
  // Progressive aero: light early, heavy near Vmax (weighty top-end crawl)
  const aeroSr = Math.min(1, spAbs / Math.max(1, maxSpeed));
  const aero =
    spAbs * spAbs * (HANDLING.aeroCoeff ?? 0.00000055) * (0.2 + aeroSr * aeroSr * 1.4);
  drag += aero;
  v.speed *= Math.max(0, 1 - drag * dt);
  if (v.speed > maxSpeed) {
    if (surf.factor > 0.15) v.speed = maxSpeed;
    else
      v.speed += (maxSpeed - v.speed) * Math.min(1, (HANDLING.topSpeedEase ?? 1.15) * dt);
  }
  if (v.speed < -maxSpeed * HANDLING.reverseMaxFrac) {
    v.speed = -maxSpeed * HANDLING.reverseMaxFrac;
  }

  const holdingDrift = wantDrift && Math.abs(input.steering) > 0.12 && v.speed > 6;

  if (holdingDrift) {
    grip = Math.min(grip, HANDLING.driftGrip + surf.factor * 0.06);
    turnRate *= HANDLING.driftTurnMul * (v.classId === "trickster" ? 1.1 : 1);
    const chargeMul =
      (0.65 + Math.abs(input.steering) * 0.55) *
      (v.classId === "trickster" ? 1.12 : 1) *
      (surf.factor < 0.35 ? 1 : 0.7);
    v.driftMeter = Math.min(
      HANDLING.driftBoostMax,
      v.driftMeter + HANDLING.driftChargeRate * dt * chargeMul,
    );
  } else if (!wantDrift && v.driftMeter > 0) {
    if (
      v.driftMeter >= HANDLING.driftBoostThreshold &&
      Math.abs(v.speed) >= HANDLING.driftBoostMinSpeed
    ) {
      const power = Math.min(1, v.driftMeter / HANDLING.driftBoostMax);
      const stage =
        v.driftMeter >= HANDLING.driftBoostMax * 0.92
          ? 1.28
          : v.driftMeter >= HANDLING.driftBoostOrange
            ? 1.15
            : 1;
      v.boostTimer = Math.max(
        v.boostTimer,
        HANDLING.driftBoostDuration * (0.55 + power * 0.7) * stage,
      );
      v.speed = Math.min(
        maxSpeed * (1.18 + stage * 0.1),
        Math.max(v.speed, 0) + (12 + power * 18) * stage,
      );
      v.impactFlash = Math.max(v.impactFlash, 0.18 + power * 0.12);
      if (opts?.particles) {
        spawnDriftBoostFx(v, opts.particles, power);
      }
    }
    v.driftMeter = 0;
  } else if (wantDrift && v.speed <= 6 && v.driftMeter > 0) {
    v.driftMeter *= Math.max(0, 1 - 0.9 * dt);
  }

  const drifting = holdingDrift;

  // Steering. Everything downstream of here — yaw, drift push, body lean, tyre
  // slip — reads the RAMPED command rather than the raw key state, so a tap is
  // a nudge and the car, the wheels and the lean all agree on what was asked
  // for. steerAngle itself is owned by stepTires (it weights the visual angle
  // by load), so it is not set here.
  const speedFactor = Math.min(
    1,
    Math.max(0.12, Math.abs(v.speed) / Math.max(HANDLING.minSteerSpeed, 4)),
  );
  const steerRaw = Math.max(-1, Math.min(1, input.steering));
  const steerIn = v.isPlayer
    ? rampPlayerSteer(steerRaw, speedRatio, dt)
    : steerRaw;
  if (Math.abs(v.speed) > 0.4) {
    const sign = v.speed >= 0 ? 1 : -1;
    v.yaw += steerIn * turnRate * speedFactor * sign * dt;
  }

  // Lateral grip / drift push
  if (drifting) {
    const push = HANDLING.driftLateralPush * steerIn * Math.min(1, Math.abs(v.speed) / 28);
    v.lateral += push * accel * dt;
    const maxLat = Math.abs(v.speed) * (HANDLING.driftMaxLatFrac ?? 0.48);
    v.lateral = Math.max(-maxLat, Math.min(maxLat, v.lateral));
  } else {
    const decay = HANDLING.lateralDecay * (0.55 + grip * 0.65);
    v.lateral *= Math.max(0, 1 - decay * dt);
  }

  // Body lean
  const targetRoll = -steerIn * Math.min(0.28, Math.abs(v.speed) / 90) * (drifting ? 1.35 : 1);
  v.bodyRoll += (targetRoll - v.bodyRoll) * Math.min(1, 6 * dt);
  if (!input.brake && !(input.throttle > 0.8 && Math.abs(v.speed) < maxSpeed * 0.25)) {
    v.bodyPitch *= Math.max(0, 1 - 4 * dt);
  }

  // Tires
  stepTires(v, input, {
    dt,
    drifting,
    surfaceKind: surf.kind,
    surfaceFactor: surf.factor,
    roughness: surf.roughness,
    speedRatio,
    grounded: v.airTime <= 0,
    landed: false,
    steer: steerIn,
  });

  // FX
  if (opts?.particles) {
    if (surf.factor > 0.18 && Math.abs(v.speed) > 8) {
      spawnOffroadDust(v, opts.particles, surf.factor, dt);
    }
    if (drifting && Math.abs(v.speed) > 10) {
      spawnTireSmoke(v, opts.particles, dt);
    }
    if (input.brake && !drifting && Math.abs(v.speed) > 14) {
      spawnBrakeSmoke(v, opts.particles, dt);
    }
    if (Math.abs(v.speed) > maxSpeed * 0.72 && surf.factor < 0.2) {
      spawnSpeedWash(v, opts.particles, dt);
    }
  }

  integratePos(v, dt);
  v.uiAccel = v.uiAccel * 0.82 + ((v.speed - prevSpeed) / Math.max(1e-4, dt)) * 0.18;

  return {
    driftCharge: v.driftMeter,
    ramSpeed: Math.max(0, v.speed),
  };
}

function integratePos(v: VehicleState, dt: number) {
  const fx = -Math.sin(v.yaw);
  const fz = -Math.cos(v.yaw);
  const rx = Math.cos(v.yaw);
  const rz = -Math.sin(v.yaw);
  v.x += (fx * v.speed + rx * v.lateral) * dt;
  v.z += (fz * v.speed + rz * v.lateral) * dt;
  const ground = getGroundHeight(v.x, v.z);
  const targetY = ground + 0.55;
  if (v.y < targetY - 0.02) {
    v.y = targetY;
    v.airTime = 0;
  } else if (v.y > targetY + 0.15) {
    v.airTime += dt;
    v.y += -18 * dt;
    if (v.y < targetY) {
      v.y = targetY;
      v.airTime = 0;
    }
  } else {
    v.y += (targetY - v.y) * Math.min(1, 14 * dt);
    v.airTime = 0;
  }
}

export function applyDamage(
  v: VehicleState,
  amount: number,
  ownerId?: string,
  fromNx?: number,
  fromNz?: number,
) {
  if (v.invuln > 0 || !v.alive || v.wreckTimer > 0) return;
  if (v.defenseActive > 0 && v.classId === "interceptor") {
    amount *= 0.35;
  }
  if (v.shield > 0) {
    const absorb = Math.min(v.shield, amount);
    v.shield -= absorb;
    amount -= absorb;
  }
  if (amount <= 0) return;
  // Credit is recorded only for damage that actually landed — after invuln,
  // after the shield ate its share. A shot fully absorbed by a Phase Slip did
  // not hurt anyone and must not claim the wreck that follows it.
  if (ownerId && ownerId !== v.id) {
    v.lastHitBy = ownerId;
    v.lastHitAge = 0;
  }
  v.health = Math.max(0, v.health - amount);
  v.damageVisual = Math.min(1, Math.max(v.damageVisual, 1 - v.health / v.maxHealth));
  v.impactFlash = Math.max(v.impactFlash, 0.22 + Math.min(0.4, amount * 0.02));
  v.hitStun = Math.max(v.hitStun, Math.min(0.45, amount * COMBAT.impactStunScale));
  if (fromNx != null && fromNz != null) {
    const fx = -Math.sin(v.yaw);
    const fz = -Math.cos(v.yaw);
    const along = fromNx * fx + fromNz * fz;
    const side = fromNx * Math.cos(v.yaw) + fromNz * -Math.sin(v.yaw);
    if (along > 0.2) v.dentFront = Math.min(1, v.dentFront + amount * 0.012);
    else if (along < -0.2) v.dentRear = Math.min(1, v.dentRear + amount * 0.012);
    if (side > 0.3) v.dentRight = Math.min(1, v.dentRight + amount * 0.01);
    else if (side < -0.3) v.dentLeft = Math.min(1, v.dentLeft + amount * 0.01);
    // Knockback soft
    v.speed += along * amount * 0.015;
    v.lateral += side * amount * 0.012;
  }
  if (v.health <= 0) {
    v.alive = false;
    v.wreckTimer = 2.8;
    v.speed *= 0.35;
  }
}

export function spawnDamageSmoke(v: VehicleState, particles: Particle[], dt: number) {
  if (v.damageVisual < 0.22 || !v.alive) return;
  if (Math.random() > Math.min(0.55, v.damageVisual * 0.55) * Math.min(1, dt * 60)) return;
  const fx = -Math.sin(v.yaw);
  const fz = -Math.cos(v.yaw);
  particles.push({
    id: pid(),
    x: v.x - fx * 1.1 + (Math.random() - 0.5) * 0.4,
    y: v.y + 0.7 + Math.random() * 0.3,
    z: v.z - fz * 1.1 + (Math.random() - 0.5) * 0.4,
    vx: (Math.random() - 0.5) * 1.2,
    vy: 0.8 + Math.random() * 1.4,
    vz: (Math.random() - 0.5) * 1.2,
    life: 0.7 + Math.random() * 0.6,
    maxLife: 1.2,
    color: v.damageVisual > 0.65 ? "#8a7a68" : "#b0a090",
    size: 0.55 + v.damageVisual * 0.7,
    kind: "smoke",
  });
}

/**
 * OBB-ish vehicle vs vehicle collision.
 * Soft at low speed so grid pack doesn't thrash launch.
 */
export function collideVehicles(
  a: VehicleState,
  b: VehicleState,
  particles: Particle[] | null,
): number {
  if (!a.alive || !b.alive) return 0;
  if (a.wreckTimer > 0 || b.wreckTimer > 0) return 0;

  const ha = VEHICLE_HITBOX[a.classId];
  const hb = VEHICLE_HITBOX[b.classId];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const distSq = dx * dx + dz * dz;
  const rad = ha.radius + hb.radius;
  if (distSq > rad * rad || distSq < 1e-8) return 0;

  const dist = Math.sqrt(distSq);
  const ca = Math.abs(Math.cos(a.yaw));
  const sa = Math.abs(Math.sin(a.yaw));
  const cb = Math.abs(Math.cos(b.yaw));
  const sb = Math.abs(Math.sin(b.yaw));
  const ra =
    Math.max(ha.halfW * ca + ha.halfL * sa, ha.halfW * sa + ha.halfL * ca) * 0.88;
  const rb =
    Math.max(hb.halfW * cb + hb.halfL * sb, hb.halfW * sb + hb.halfL * cb) * 0.88;
  const minDist = ra + rb;
  if (dist >= minDist) return 0;

  const nx = dx / dist;
  const nz = dz / dist;
  const pen = minDist - dist;

  const massA = VEHICLE_CLASSES[a.classId].mass;
  const massB = VEHICLE_CLASSES[b.classId].mass;
  const total = massA + massB;

  // Soft start: strong positional separate, weak impulse when nearly stopped
  const speedPair = Math.abs(a.speed) + Math.abs(b.speed) + Math.abs(a.lateral) + Math.abs(b.lateral);
  const soft = Math.min(1, speedPair / 14);

  a.x -= nx * pen * (massB / total) * (0.55 + soft * 0.45);
  a.z -= nz * pen * (massB / total) * (0.55 + soft * 0.45);
  b.x += nx * pen * (massA / total) * (0.55 + soft * 0.45);
  b.z += nz * pen * (massA / total) * (0.55 + soft * 0.45);

  const va = worldVelocity(a);
  const vb = worldVelocity(b);
  const rvx = va.vx - vb.vx;
  const rvz = va.vz - vb.vz;
  const velN = rvx * nx + rvz * nz;
  if (velN > 0.4) return Math.abs(velN) * 0.2 * soft;

  const restitution = 0.12 + soft * 0.22;
  const invSum = 1 / massA + 1 / massB;
  const j = (-(1 + restitution) * Math.min(0, velN)) / invSum;
  // Cap impulse hard at crawl so start grid doesn't flip speed sign
  const jCap = 4 + soft * 28;
  const jClamped = Math.max(-jCap, Math.min(jCap, j)) * (0.35 + soft * 0.65);
  const jx = jClamped * nx;
  const jz = jClamped * nz;

  applyWorldVel(a, va.vx - jx / massA, va.vz - jz / massA);
  applyWorldVel(b, vb.vx + jx / massB, vb.vz + jz / massB);

  // Kill residual thrash at near-zero
  if (speedPair < 4) {
    a.lateral *= 0.4;
    b.lateral *= 0.4;
    if (Math.abs(a.speed) < 1.5) a.speed *= 0.5;
    if (Math.abs(b.speed) < 1.5) b.speed *= 0.5;
  }

  const closing = Math.max(0, -velN);
  const impact = (closing + pen * 3.5) * soft;

  if (closing >= COMBAT.impactDmgThreshold && soft > 0.55) {
    const force = (closing - COMBAT.impactDmgThreshold) * COMBAT.impactDmgScale;
    /*
     * Ramming is the other half of takedown credit, and it is the half a
     * damage-owner id cannot express: nobody "fires" a collision. Each car
     * names the other, because in a genuine hit both of them are responsible
     * for the closing speed — the runtime decides whose fault it was by which
     * one is still driving afterwards.
     */
    if (a.invuln <= 0) {
      a.lastHitBy = b.id;
      a.lastHitAge = 0;
      const dmgA = force * 12 * (massB / total);
      a.health = Math.max(0, a.health - dmgA);
      a.damageVisual = Math.min(1, Math.max(a.damageVisual, 1 - a.health / a.maxHealth));
      a.impactFlash = Math.max(a.impactFlash, 0.3 + force * 0.04);
      a.hitStun = Math.max(a.hitStun, force * COMBAT.impactStunScale);
      const afx = -Math.sin(a.yaw);
      const afz = -Math.cos(a.yaw);
      const alongA = nx * afx + nz * afz;
      if (alongA > 0.2) a.dentFront = Math.min(1, a.dentFront + force * 0.04);
      else if (alongA < -0.2) a.dentRear = Math.min(1, a.dentRear + force * 0.04);
      if (a.health <= 0) {
        a.alive = false;
        a.wreckTimer = 2.8;
      }
    }
    if (b.invuln <= 0) {
      b.lastHitBy = a.id;
      b.lastHitAge = 0;
      const dmgB = force * 12 * (massA / total);
      b.health = Math.max(0, b.health - dmgB);
      b.damageVisual = Math.min(1, Math.max(b.damageVisual, 1 - b.health / b.maxHealth));
      b.impactFlash = Math.max(b.impactFlash, 0.3 + force * 0.04);
      b.hitStun = Math.max(b.hitStun, force * COMBAT.impactStunScale);
      const bfx = -Math.sin(b.yaw);
      const bfz = -Math.cos(b.yaw);
      const alongB = -nx * bfx - nz * bfz;
      if (alongB > 0.2) b.dentFront = Math.min(1, b.dentFront + force * 0.04);
      else if (alongB < -0.2) b.dentRear = Math.min(1, b.dentRear + force * 0.04);
      if (b.health <= 0) {
        b.alive = false;
        b.wreckTimer = 2.8;
      }
    }
    if (particles) {
      for (let i = 0; i < 4; i++) {
        particles.push({
          id: pid(),
          x: (a.x + b.x) * 0.5,
          y: (a.y + b.y) * 0.5 + 0.4,
          z: (a.z + b.z) * 0.5,
          vx: (Math.random() - 0.5) * 8,
          vy: 1 + Math.random() * 4,
          vz: (Math.random() - 0.5) * 8,
          life: 0.25 + Math.random() * 0.25,
          maxLife: 0.5,
          color: "#ffcc88",
          size: 0.12 + Math.random() * 0.12,
          kind: "spark",
        });
      }
    }
  }

  return impact;
}

function spawnDriftBoostFx(v: VehicleState, particles: Particle[], power: number) {
  const fx = -Math.sin(v.yaw);
  const fz = -Math.cos(v.yaw);
  for (let i = 0; i < 6 + Math.floor(power * 6); i++) {
    particles.push({
      id: pid(),
      x: v.x - fx * 1.2,
      y: v.y + 0.3,
      z: v.z - fz * 1.2,
      vx: -fx * (4 + power * 8) + (Math.random() - 0.5) * 3,
      vy: 0.5 + Math.random() * 2,
      vz: -fz * (4 + power * 8) + (Math.random() - 0.5) * 3,
      life: 0.35 + Math.random() * 0.3,
      maxLife: 0.65,
      color: power > 0.7 ? "#fde68a" : "#fdba74",
      size: 0.2 + power * 0.25,
      kind: "spark",
    });
  }
}

export function spawnOffroadDust(
  v: VehicleState,
  particles: Particle[],
  factor: number,
  dt: number,
) {
  // Rate and size scale with SPEED as well as softness. Previously only the
  // surface factor mattered, so crawling across sand threw the same cloud as a
  // full-speed slide — the dust carried no information about how hard you were
  // driving. A rooster tail is the main visual payoff of going off-road.
  const sp = Math.abs(v.speed);
  const spN = Math.min(1, sp / 40);
  const rate = Math.min(0.95, factor * (0.5 + spN * 1.1));
  if (Math.random() > rate * Math.min(1, dt * 55)) return;
  const fx = -Math.sin(v.yaw);
  const fz = -Math.cos(v.yaw);
  const rx = Math.cos(v.yaw);
  const rz = -Math.sin(v.yaw);
  // Thrown from behind whichever rear wheel, alternating, rather than one
  // point on the centreline — two plumes read as wheels digging in.
  const side = Math.random() < 0.5 ? -1 : 1;
  particles.push({
    id: pid(),
    x: v.x - fx * 0.9 + rx * side * 0.8 + (Math.random() - 0.5) * 0.5,
    y: v.y + 0.12,
    z: v.z - fz * 0.9 + rz * side * 0.8 + (Math.random() - 0.5) * 0.5,
    // Kicked backwards along travel: faster car, longer plume.
    vx: (Math.random() - 0.5) * 2 - fx * (1.2 + spN * 6),
    vy: 0.5 + Math.random() * 1.1 + spN * 1.4,
    vz: (Math.random() - 0.5) * 2 - fz * (1.2 + spN * 6),
    life: 0.6 + Math.random() * 0.5 + spN * 0.35,
    maxLife: 1.35,
    color: "#d4b48c",
    size: 0.6 + factor * 0.7 + spN * 0.9 + Math.random() * 0.4,
    kind: "dust",
  });
}

export function spawnTireSmoke(v: VehicleState, particles: Particle[], dt: number) {
  if (Math.random() > 0.55 * Math.min(1, dt * 60)) return;
  const fx = -Math.sin(v.yaw);
  const fz = -Math.cos(v.yaw);
  const rx = Math.cos(v.yaw);
  const rz = -Math.sin(v.yaw);
  for (const side of [-1, 1] as const) {
    particles.push({
      id: pid(),
      x: v.x - fx * 0.9 + rx * side * 0.75,
      y: v.y + 0.12,
      z: v.z - fz * 0.9 + rz * side * 0.75,
      vx: (Math.random() - 0.5) * 1.5 - fx * 0.8,
      vy: 0.6 + Math.random() * 1.1,
      vz: (Math.random() - 0.5) * 1.5 - fz * 0.8,
      life: 0.7 + Math.random() * 0.5,
      maxLife: 1.2,
      color: "#c4b8a8",
      size: 0.7 + Math.random() * 0.55,
      kind: "smoke",
    });
  }
}

export function spawnBrakeSmoke(v: VehicleState, particles: Particle[], dt: number) {
  if (Math.random() > 0.4 * Math.min(1, dt * 60)) return;
  const fx = -Math.sin(v.yaw);
  const fz = -Math.cos(v.yaw);
  particles.push({
    id: pid(),
    x: v.x - fx * 1.0 + (Math.random() - 0.5) * 0.6,
    y: v.y + 0.1,
    z: v.z - fz * 1.0 + (Math.random() - 0.5) * 0.6,
    vx: (Math.random() - 0.5) * 1.2,
    vy: 0.3 + Math.random() * 0.8,
    vz: (Math.random() - 0.5) * 1.2,
    life: 0.4 + Math.random() * 0.35,
    maxLife: 0.75,
    color: "#b0a898",
    size: 0.5 + Math.random() * 0.35,
    kind: "smoke",
  });
}

export function spawnSpeedWash(v: VehicleState, particles: Particle[], dt: number) {
  if (Math.random() > 0.25 * Math.min(1, dt * 60)) return;
  const fx = -Math.sin(v.yaw);
  const fz = -Math.cos(v.yaw);
  particles.push({
    id: pid(),
    x: v.x + (Math.random() - 0.5) * 1.8,
    y: v.y + 0.4 + Math.random() * 0.5,
    z: v.z + (Math.random() - 0.5) * 1.8,
    vx: -fx * (2 + Math.random() * 4),
    vy: (Math.random() - 0.3) * 0.6,
    vz: -fz * (2 + Math.random() * 4),
    life: 0.18 + Math.random() * 0.15,
    maxLife: 0.35,
    color: "#f0e6d4",
    size: 0.12 + Math.random() * 0.1,
    kind: "spark",
  });
}
