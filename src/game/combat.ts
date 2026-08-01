import { COMBAT } from "./balance";
import { VEHICLE_CLASSES } from "./classes";
import { applyDamage } from "./physics";
import { getGroundHeight } from "./track";
import { emitAudioCue } from "./audio/cues";
import type { Mine, Particle, PlayerInput, Projectile, VehicleState } from "./types";
import {
  vfxExplosion,
  vfxHeatShimmer,
  vfxImpactBurst,
  vfxMuzzleFlash,
  vfxProjectileTrail,
  vfxSparkShower,
} from "./world/vfx/particles";
import { spawnShockwave } from "./world/vfx/shockwave";
import { vfxSeed } from "./world/vfx/rng";
import { spawnDebrisBurst } from "./world/debris";
import { addCrater, addImpactMark, addScorch } from "./world/damage/landscape";
import { addVehicleDeformHitWorld } from "./world/damage/meshDeform";
import { sharedTrauma } from "./world/cameraShake";

/**
 * Weapon charge at which the next shot comes out as ordnance.
 *
 * This is the answer to "I never see missiles". Before it, the only missiles in
 * the game were four rockets on ONE class's ultimate, which needs the player to
 * pick that class, fill a meter that takes the better part of a minute, and
 * spend it — a combination most sessions never reach even once. The charge
 * meter, by contrast, refills in about twelve seconds of not shooting, which
 * every car does between engagements, so ordnance becomes a normal beat of a
 * normal race for the player AND for every bot on the grid.
 *
 * A loaded shot spends the WHOLE meter (see tryPrimary), so it is a real
 * decision rather than a free upgrade: hold fire and land one guided rocket, or
 * keep the trigger down and stay on the base weapon.
 */
export const LOADED_AT = 0.7;

/**
 * A projectile hit is the one place in the game where the exact world point of
 * an impact is known, so it is the one place that can put a dent where the shot
 * actually landed rather than on a nominal panel centre. Depth is derived from
 * damage, radius from the projectile's own size — a cannon shell craters a
 * door, a bolt pocks it.
 */
function dentFromProjectile(v: VehicleState, p: Projectile): void {
  const dx = v.x - p.x;
  const dz = v.z - p.z;
  const len = Math.hypot(dx, dz) || 1;
  const depth = Math.min(0.16, 0.025 + p.damage * 0.0032);
  const radius = 0.45 + p.radius * 1.4;
  addVehicleDeformHitWorld(
    v.id,
    p.x,
    p.y,
    p.z,
    dx / len,
    -0.1,
    dz / len,
    v.x,
    v.y,
    v.z,
    v.yaw,
    depth,
    radius,
    vfxSeed(p.x, p.y, p.z),
  );
}

let nextId = 1;
function uid(prefix: string) {
  nextId += 1;
  return `${prefix}-${nextId}-${(Math.random() * 1e9) | 0}`;
}

/** Closest living car that is not `self`, within `range` metres. */
function nearestRival(
  self: VehicleState,
  vehicles: VehicleState[],
  range: number,
): VehicleState | null {
  let best: VehicleState | null = null;
  let bestD2 = range * range;
  for (const o of vehicles) {
    if (o.id === self.id || !o.alive || o.wreckTimer > 0) continue;
    const d2 = (o.x - self.x) ** 2 + (o.z - self.z) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = o;
    }
  }
  return best;
}

/**
 * A missile going off.
 *
 * This is the "proper fire effect" the whole ordnance pass exists for, and it
 * is deliberately a COMPOSITION rather than one bigger explosion call. A blast
 * that is only a fireball reads as a sprite; what makes it read as ordnance is
 * that six independent things happen at the same instant and then decay at six
 * different rates:
 *
 *   flash + fireball  2-3 frames of white, then half a second of combustion
 *                     cooling yellow -> orange -> deep red   (vfxExplosion)
 *   residual burn     ~1.5s of flame still on the target      (BLAST.missile)
 *   soot plume        ~4s, dark at birth and paling as it cools
 *   shockwave         a ground ring, stretched along the missile's own travel
 *   directional metal a spray of sparks and torn panel back along the incoming
 *                     line — NOT radial, which is what separates a hit from a
 *                     firework
 *   scorch + heat     a permanent mark on the ground and, on high tier only,
 *                     haze over the hot volume
 *
 * `dirX/dirZ` is the missile's travel, so everything lopsided leans the way the
 * shot was going. `groundY` must come from getGroundHeight — a ring or a crater
 * placed on the road plane sinks into the desert everywhere off the tarmac.
 */
function detonateMissile(
  p: Projectile,
  vehicles: VehicleState[],
  victim: VehicleState | null,
  groundY: number,
  at: "vehicle" | "ground" | "air" = victim ? "vehicle" : "ground",
): void {
  const seed = vfxSeed(p.x, p.y, p.z);
  const sp = Math.hypot(p.vx, p.vy, p.vz) || 1;
  const dx = p.vx / sp;
  const dy = p.vy / sp;
  const dz = p.vz / sp;
  const grounded = at !== "air";
  // Against a car the blast happens at hull height; against the ground it
  // happens at the ground, and the fireball has to sit ON the surface or it
  // floats. An airburst happens exactly where the missile was.
  const y =
    at === "vehicle"
      ? Math.max(p.y, groundY + 0.55)
      : at === "ground"
        ? groundY + 0.4
        : p.y;
  const energy = 1.05 + Math.min(0.3, p.damage / 110);

  vfxExplosion(p.x, y, p.z, {
    kind: "missile",
    radius: victim ? 2.9 : 2.4,
    energy,
    groundY,
    dirX: dx,
    dirZ: dz,
    seed,
  });
  // A ring is a wave crossing the GROUND. An airburst thirty metres up does not
  // produce one, and drawing it anyway paints a mark under a blast the player
  // can see is nowhere near the floor.
  if (grounded) {
    spawnShockwave(p.x, groundY, p.z, victim ? 3.4 : 2.9, dx, dz, seed, {
      r: 1,
      g: 0.86,
      b: 0.62,
    });
  }
  // Back along the incoming line, not radially: the reversed velocity stands in
  // for the surface normal.
  vfxImpactBurst(
    p.x,
    y,
    p.z,
    -dx,
    -dy + 0.45,
    -dz,
    at === "ground" ? "sand" : "metal",
    1.3,
    groundY,
    seed ^ 0x51e7,
  );
  // No third spark source. The blast profile supplies the radial metal and the
  // impact burst supplies the directional metal; a vfxSparkShower on top of
  // both put a single detonation past 80% of the SPARK layer's live budget on
  // high tier, which starves every other spark on the track for a second.
  // Bodywork off a car, soil out of a crater. Same pool, different signature.
  if (grounded) {
    spawnDebrisBurst(
      victim ? "panel" : "ejecta",
      p.x,
      y,
      p.z,
      dx,
      dz,
      1.5,
      groundY,
      victim ? 1.5 : 1.2,
    );
  }
  // Self-gating on tier: SHIMMER is disabled below high, so this costs nothing
  // there rather than needing its own check.
  vfxHeatShimmer(p.x, y, p.z, 1.9, 0.85, seed ^ 0x7f3d);

  // Terrain damage only where terrain was actually hit.
  if (grounded) {
    if (!addCrater(p.x, p.z, 1.7, 0.34, seed)) {
      addImpactMark(p.x, p.z, 1.5, seed);
    }
    addScorch(p.x, p.z, victim ? 2.6 : 2.2, seed ^ 0x4d21);
  }

  emitAudioCue(
    "ult-blast",
    p.x,
    y,
    p.z,
    grounded ? 1.35 : 0.85,
    !!victim && victim.isPlayer,
  );

  if (victim) {
    // A warhead against a panel folds it in around the contact point. Deeper
    // and wider than a shell, which is the read that the hit was different in
    // kind rather than just bigger.
    addVehicleDeformHitWorld(
      victim.id,
      p.x,
      p.y,
      p.z,
      dx,
      dy - 0.15,
      dz,
      victim.x,
      victim.y,
      victim.z,
      victim.yaw,
      0.22,
      1.5,
      seed,
    );
  }

  /*
   * Screen punch, scaled by how close the player is to it.
   *
   * Presentation only — sharedTrauma is never read by anything that decides
   * gameplay, which is what makes it safe to drive from inside the fixed step.
   * Distance-scaled rather than victim-gated because a rocket going off two car
   * lengths ahead of you should be felt; one on the far side of the circuit
   * should not.
   */
  const player = vehicles.find((o) => o.isPlayer);
  if (player) {
    // 3D, because an airburst can be directly overhead and thirty metres up.
    const d = Math.hypot(player.x - p.x, player.y - y, player.z - p.z);
    if (d < 30) {
      const near = 1 - d / 30;
      sharedTrauma.add(0.16 + near * near * 0.42, {
        x: p.x - player.x,
        y: 0.3,
        z: p.z - player.z,
      });
    }
  }

  // Every other car close enough to be lit by it flashes. No damage: a splash
  // that could wreck a bystander would change how races resolve, and this pass
  // is about what the player can SEE.
  for (const o of vehicles) {
    if (o === victim || !o.alive) continue;
    if (Math.hypot(o.x - p.x, o.z - p.z) < 5.5) {
      o.impactFlash = Math.max(o.impactFlash, 0.16);
    }
  }
}

export function findLockTarget(
  self: VehicleState,
  others: VehicleState[],
  range: number,
): string | null {
  const fx = -Math.sin(self.yaw);
  const fz = -Math.cos(self.yaw);
  let best: string | null = null;
  let bestScore = -Infinity;

  // Overdrive lock: wider cone + range
  const cone =
    self.ultimateActive > 0 && self.classId === "interceptor"
      ? COMBAT.lockCone - 0.12
      : COMBAT.lockCone;
  const rangeMul =
    self.ultimateActive > 0 && self.classId === "interceptor" ? 1.25 : 1;

  for (const o of others) {
    if (o.id === self.id || !o.alive || o.wreckTimer > 0) continue;
    if (o.defenseActive > 0 && o.classId === "interceptor") continue;
    // Decoy: trickster active decoy steals soft-lock occasionally handled by offset nameplate only
    const dx = o.x - self.x;
    const dz = o.z - self.z;
    const dist = Math.hypot(dx, dz);
    if (dist > range * rangeMul || dist < 0.5) continue;
    const nx = dx / dist;
    const nz = dz / dist;
    const dot = nx * fx + nz * fz;
    if (dot < cone) continue;
    // Prefer closer + more centered; slight lead bias for faster targets
    const score = dot * 2.2 - dist / (range * rangeMul) + (o.speed > self.speed ? 0.08 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = o.id;
    }
  }
  return best;
}

export function tryPrimary(
  v: VehicleState,
  input: PlayerInput,
  projectiles: Projectile[],
  vehicles: VehicleState[],
): void {
  if (!input.firePrimary || v.primaryCooldown > 0 || v.wreckTimer > 0 || !v.alive) return;
  const def = VEHICLE_CLASSES[v.classId];

  const chargeMul =
    COMBAT.weaponMinMul + v.weaponCharge * (COMBAT.weaponMaxMul - COMBAT.weaponMinMul);
  /*
   * A loaded shot needs a target. Guidance with nobody to guide toward is an
   * unguided rocket that spent the whole meter, and a player who fires one into
   * an empty straight has been robbed rather than taught something.
   */
  const loaded =
    v.weaponCharge >= LOADED_AT &&
    !!v.lockTargetId &&
    vehicles.some((o) => o.id === v.lockTargetId && o.alive && o.wreckTimer <= 0);
  // Ordnance costs the whole meter and roughly two shots' worth of downtime.
  v.primaryCooldown = loaded ? def.primaryCooldown * 2.1 : def.primaryCooldown;
  v.weaponCharge = loaded ? 0 : Math.max(0, v.weaponCharge - COMBAT.weaponDrain);

  const fx = -Math.sin(v.yaw);
  const fz = -Math.cos(v.yaw);
  const rx = Math.cos(v.yaw);
  const rz = -Math.sin(v.yaw);

  let aimX = fx;
  let aimZ = fz;
  if (v.lockTargetId) {
    const t = vehicles.find((o) => o.id === v.lockTargetId);
    if (t) {
      // Lead target slightly for reliable hits on movers
      const lead = 0.12 + Math.min(0.35, Math.hypot(t.speed, t.lateral) * 0.004);
      const tfx = -Math.sin(t.yaw);
      const tfz = -Math.cos(t.yaw);
      const predX = t.x + tfx * t.speed * lead;
      const predZ = t.z + tfz * t.speed * lead;
      const dx = predX - v.x;
      const dz = predZ - v.z;
      const d = Math.hypot(dx, dz) || 1;
      const tx = dx / d;
      const tz = dz / d;
      if (tx * fx + tz * fz > COMBAT.lockCone) {
        const b = COMBAT.lockBlend;
        aimX = fx * (1 - b) + tx * b;
        aimZ = fz * (1 - b) + tz * b;
        const len = Math.hypot(aimX, aimZ) || 1;
        aimX /= len;
        aimZ /= len;
      }
    }
  }

  const dmg = def.primaryDamage * chargeMul;

  // Audio is emitted here rather than off the input edge because the shot is
  // only real once the cooldown has passed — and because this is the single
  // point every vehicle fires through, which is what finally gives AI weapons
  // a sound. Charge level drives loudness so a full-charge shot lands harder.
  emitAudioCue(
    loaded && v.classId !== "trickster"
      ? "fire-cannon"
      : v.classId === "interceptor"
        ? "fire-bolt"
        : v.classId === "bruiser"
          ? "fire-cannon"
          : "fire-disc",
    v.x,
    v.y + 0.6,
    v.z,
    loaded ? 1.25 : 0.75 + chargeMul * 0.35,
    v.isPlayer,
  );

  // Muzzle flash goes here, not on the input edge, for the same reason the
  // audio cue does: the shot is only real once the cooldown has passed, and
  // this is the single point every vehicle — player and AI — fires through.
  vfxMuzzleFlash(
    v.x + aimX * 1.7,
    // Ordnance leaves the roof rack, not the nose gun, and the flash has to
    // agree with the hardware the player can see on the car.
    v.y + (loaded && v.classId !== "trickster" ? 1.05 : 0.6),
    v.z + aimZ * 1.7,
    aimX,
    aimZ,
    loaded && v.classId !== "trickster"
      ? "rocket"
      : v.classId === "interceptor"
        ? "bolt"
        : v.classId === "bruiser"
          ? "cannon"
          : "disc",
    loaded ? 1 : chargeMul - COMBAT.weaponMinMul,
    vfxSeed(v.x, v.y, v.z),
  );

  /*
   * Loaded shot — the same weapon, loaded with a warhead.
   *
   * Damage is deliberately NOT a buff over the shell it replaces: the meter's
   * existing chargeMul already pays for holding fire, and stacking a second
   * multiplier on top would make "never fire until charged" the only correct
   * way to play. What you buy is GUIDANCE and reach, which is a different
   * weapon rather than a bigger number.
   */
  if (loaded && v.classId !== "trickster") {
    const heavy = v.classId === "bruiser";
    const n = heavy ? 1 : 2;
    for (let i = 0; i < n; i++) {
      const side = n === 1 ? 0 : i === 0 ? -0.55 : 0.55;
      projectiles.push({
        id: uid("msl"),
        ownerId: v.id,
        x: v.x + aimX * 1.9 + rx * side,
        y: v.y + 1.0,
        z: v.z + aimZ * 1.9 + rz * side,
        vx: aimX * (heavy ? 52 : 66),
        // Barely lofted. The salvo version arcs because four rockets need room
        // to fan out; a single aimed shot that climbs first would just look
        // like it missed.
        vy: 1.1,
        vz: aimZ * (heavy ? 52 : 66),
        life: heavy ? 3.4 : 2.6,
        damage: heavy ? dmg : dmg * 0.62,
        kind: "missile",
        bounce: 0,
        radius: heavy ? 0.55 : 0.4,
        seek: v.lockTargetId ?? undefined,
        // Short, not zero: a frame or two of straight flight leaves the launcher
        // before guidance takes over, so the shot reads as fired rather than as
        // teleported onto its target.
        armTime: 0.1 + i * 0.05,
      });
    }
    return;
  }

  if (v.classId === "interceptor") {
    for (const side of [-0.32, 0.32]) {
      projectiles.push({
        id: uid("bolt"),
        ownerId: v.id,
        x: v.x + aimX * 1.6 + rx * side,
        y: v.y + 0.55,
        z: v.z + aimZ * 1.6 + rz * side,
        vx: aimX * def.primarySpeed,
        vy: 0,
        vz: aimZ * def.primarySpeed,
        life: def.primaryRange / def.primarySpeed,
        damage: dmg * 0.55,
        kind: "bolt",
        bounce: 0,
        radius: 0.3,
      });
    }
  } else if (v.classId === "bruiser") {
    /*
     * The bruiser fires ROCKETS, not shells, as its ordinary primary.
     *
     * It was a ballistic slug — a tracer that arced and hit or missed, which is
     * the same thing every arcade racer has. The rocket art exists, the missile
     * kind exists, and putting them on the default shot is what makes a combat
     * racer feel like one: the thing that leaves the car is visibly a rocket,
     * it trails smoke, and it flies TOWARD what you were aiming at.
     *
     * Guidance is deliberately weak here compared with the ultimate salvo — it
     * arms late and turns slowly, so it corrects an imperfect lead rather than
     * removing the need to aim. A primary that cannot miss is not a weapon, it
     * is a delay.
     */
    let mark: VehicleState | null = null;
    let best = def.primaryRange * def.primaryRange;
    for (const o of vehicles) {
      if (o.id === v.id || !o.alive || o.wreckTimer > 0) continue;
      const dx = o.x - v.x;
      const dz = o.z - v.z;
      // Only ahead of the nose: a rocket that turns around and chases someone
      // behind you is a bug that looks like a feature until it kills you.
      if (dx * aimX + dz * aimZ <= 0) continue;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) {
        best = d2;
        mark = o;
      }
    }
    projectiles.push({
      id: uid("rkt"),
      ownerId: v.id,
      x: v.x + aimX * 2.0,
      y: v.y + 0.7,
      z: v.z + aimZ * 2.0,
      vx: aimX * def.primarySpeed,
      vy: 0.25,
      vz: aimZ * def.primarySpeed,
      life: def.primaryRange / def.primarySpeed,
      damage: dmg,
      kind: "missile",
      bounce: 0,
      radius: 0.45,
      seek: mark?.id,
      // Long arm time: most of the flight is unguided, so a clean shot is still
      // the player aiming rather than the missile fixing it.
      armTime: 0.35,
    });
  } else {
    /*
     * The trickster's loaded shot is a fan, not a rocket. Guidance is the wrong
     * upgrade for a class whose whole weapon is a bounce you aimed at a wall:
     * a homing disc would remove the only skill the weapon asks for. Three
     * discs on divergent lines is more of what the weapon already is, and the
     * damage is split so the fan is a spread rather than a triple hit.
     */
    const fan = loaded ? [-0.16, 0, 0.16] : [0];
    for (const spread of fan) {
      const c = Math.cos(spread);
      const s = Math.sin(spread);
      projectiles.push({
        id: uid("disc"),
        ownerId: v.id,
        x: v.x + aimX * 1.5,
        y: v.y + 0.5,
        z: v.z + aimZ * 1.5,
        vx: (aimX * c - aimZ * s) * def.primarySpeed,
        vy: 0,
        vz: (aimX * s + aimZ * c) * def.primarySpeed,
        life: (def.primaryRange / def.primarySpeed) * 1.45,
        damage: loaded ? dmg * 0.62 : dmg,
        kind: "disc",
        bounce: 2,
        radius: 0.36,
      });
    }
  }
}

export function tryDefense(
  v: VehicleState,
  input: PlayerInput,
  vehicles: VehicleState[],
): void {
  if (!input.useDefense || v.defenseCooldown > 0 || v.wreckTimer > 0 || !v.alive) return;
  const def = VEHICLE_CLASSES[v.classId];
  // Prefer spending shield charge when available
  if (v.shieldCharge < 0.15 && v.classId !== "bruiser") {
    // still allow, but longer downtime feel via partial charge
  }
  v.defenseCooldown = def.defenseCooldown;
  v.shieldCharge = Math.max(0, v.shieldCharge - 0.2);
  emitAudioCue("defense", v.x, v.y + 0.6, v.z, 1, v.isPlayer);

  if (v.classId === "interceptor") {
    v.defenseActive = 1.25;
    v.invuln = Math.max(v.invuln, 1.25);
    v.boostTimer = Math.max(v.boostTimer, 0.55);
  } else if (v.classId === "bruiser") {
    v.defenseActive = 2.6;
    v.shield = Math.max(v.shield, 45 + v.shieldCharge * 35);
  } else {
    v.defenseActive = 3.2;
    v.decoyActive = 3.2;
    void vehicles;
  }
}

export function tryUltimate(
  v: VehicleState,
  input: PlayerInput,
  mines: Mine[],
  vehicles: VehicleState[] = [],
  projectiles: Projectile[] = [],
): void {
  if (!input.useUltimate || v.ultimateCharge < 1 || v.wreckTimer > 0 || !v.alive) return;
  v.ultimateCharge = 0;
  emitAudioCue("ult", v.x, v.y + 0.6, v.z, 1.2, v.isPlayer);

  if (v.classId === "interceptor") {
    /*
     * Overdrive Lock. The buff half is unchanged; what is new is that the lock
     * now LAUNCHES.
     *
     * This was the last ultimate in the game that changed no more than a
     * number: a boost and a full charge meter, i.e. two things the class
     * already had. It was also the ultimate belonging to the DEFAULT class, so
     * a player who never changed cars had no way to ever see a missile — the
     * single largest reason the weapon art in this project had never been seen
     * in play. Two tightly-guided micro-missiles off the deck rails make the
     * ability visible, and make it read as a lock rather than as a stat.
     */
    v.ultimateActive = 4.2;
    v.boostTimer = Math.max(v.boostTimer, 2.2);
    v.weaponCharge = 1;
    const fx = -Math.sin(v.yaw);
    const fz = -Math.cos(v.yaw);
    const rx = Math.cos(v.yaw);
    const rz = -Math.sin(v.yaw);
    const target =
      vehicles.find((o) => o.id === v.lockTargetId && o.alive && o.wreckTimer <= 0) ??
      nearestRival(v, vehicles, 120);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -0.5 : 0.5;
      projectiles.push({
        id: uid("msl"),
        ownerId: v.id,
        x: v.x + rx * side + fx * 1.4,
        y: v.y + 0.95,
        z: v.z + rz * side + fz * 1.4,
        vx: (fx + rx * side * 0.5) * 72,
        vy: 2.6,
        vz: (fz + rz * side * 0.5) * 72,
        life: 3,
        damage: 17,
        kind: "missile",
        bounce: 0,
        radius: 0.4,
        seek: target?.id,
        armTime: 0.12 + i * 0.05,
      });
    }
    emitAudioCue("fire-cannon", v.x, v.y + 0.95, v.z, 1.1, v.isPlayer);
    vfxMuzzleFlash(
      v.x + fx * 1.4,
      v.y + 1,
      v.z + fz * 1.4,
      fx,
      fz,
      "rocket",
      1,
      vfxSeed(v.x, v.y, v.z),
    );
  } else if (v.classId === "bruiser") {
    /*
     * Rocket salvo — four missiles from the roof rack.
     *
     * This ultimate used to be a boost plus a shield, i.e. two things the class
     * already had, only more so. It was the only ultimate that did not change
     * what the player could DO, which made it the obvious place to put an
     * actual weapon rather than inventing a fourth input.
     *
     * Launched with real spread and a short arming delay, so the salvo fans out
     * before guidance pulls it back in. Firing four rockets that converge from
     * the first frame just looks like one fat rocket.
     */
    v.ultimateActive = 2.2;
    v.boostTimer = Math.max(v.boostTimer, 1.6);
    /*
     * Acquire once, at launch, rather than re-acquiring in flight. A salvo that
     * re-targets mid-air chases whoever is momentarily nearest and reads as
     * homing wasps; locking at launch makes the shot the player's decision.
     */
    const target = nearestRival(v, vehicles, 150);
    const fx = -Math.sin(v.yaw);
    const fz = -Math.cos(v.yaw);
    const rx = Math.cos(v.yaw);
    const rz = -Math.sin(v.yaw);
    for (let i = 0; i < 4; i++) {
      const side = (i % 2 === 0 ? 1 : -1) * (0.42 + Math.floor(i / 2) * 0.3);
      const spread = side * 0.34;
      projectiles.push({
        id: uid("msl"),
        ownerId: v.id,
        x: v.x + rx * side * 1.5 + fx * 1.2,
        y: v.y + 1.15,
        z: v.z + rz * side * 1.5 + fz * 1.2,
        vx: (fx + rx * spread) * 46,
        // Lofted: a rocket that leaves flat reads as a bullet. The seek term
        // below pulls it back down onto the target.
        vy: 5.5 + Math.floor(i / 2) * 1.2,
        vz: (fz + rz * spread) * 46,
        life: 4.2,
        damage: 26,
        kind: "missile",
        bounce: 0,
        radius: 0.55,
        seek: target?.id,
        armTime: 0.28 + i * 0.06,
      });
    }
    emitAudioCue("fire-cannon", v.x, v.y + 1.1, v.z, 1.15, v.isPlayer);
    vfxMuzzleFlash(
      v.x + fx * 1.6,
      v.y + 1.2,
      v.z + fz * 1.6,
      fx,
      fz,
      "rocket",
      1,
      vfxSeed(v.x, v.y, v.z),
    );
  } else {
    v.ultimateActive = 1.4;
    const fx = -Math.sin(v.yaw);
    const fz = -Math.cos(v.yaw);
    const rx = Math.cos(v.yaw);
    const rz = -Math.sin(v.yaw);
    for (let i = 0; i < 5; i++) {
      const back = 2 + i * 2.1;
      const side = (i % 2 === 0 ? 1 : -1) * 1.15;
      const mx = v.x - fx * back + rx * side;
      const mz = v.z - fz * back + rz * side;
      mines.push({
        id: uid("mine"),
        ownerId: v.id,
        x: mx,
        z: mz,
        y: getGroundHeight(mx, mz) + 0.1,
        life: 16,
        armed: 0.4 + i * 0.07,
        radius: 2.5,
        damage: 30,
      });
    }
    // One cue for the whole volley: five clanks in five frames is a rattle, and
    // the engine's per-kind gate would swallow four of them anyway.
    emitAudioCue("mine-drop", v.x, v.y, v.z, 1, v.isPlayer);
  }
}

export function stepProjectiles(
  projectiles: Projectile[],
  vehicles: VehicleState[],
  particles: Particle[],
  dt: number,
): void {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    if (p.kind === "missile") {
      /*
       * Guidance. Steers the VELOCITY DIRECTION toward the target rather than
       * adding an acceleration toward it — an acceleration term makes a missile
       * that overshoots and then loops, which looks like a bug even though it is
       * physically reasonable. Rotating the heading with a capped turn rate
       * gives the arc a rocket actually flies and guarantees it cannot exceed
       * its own speed.
       *
       * armTime keeps guidance off at launch so a salvo fans out first.
       */
      p.armTime = (p.armTime ?? 0) - dt;
      const tgt =
        (p.armTime ?? 0) <= 0 && p.seek
          ? vehicles.find((o) => o.id === p.seek && o.alive && o.wreckTimer <= 0)
          : undefined;
      if (tgt) {
        const speed = Math.hypot(p.vx, p.vy, p.vz) || 1;
        // Lead the target slightly; aiming at where it is guarantees a tail chase.
        const lead = Math.min(1.2, speed > 1 ? 0.55 : 0);
        const tx = tgt.x + (-Math.sin(tgt.yaw) * tgt.speed) * lead - p.x;
        const ty = tgt.y + 0.5 - p.y;
        const tz = tgt.z + (-Math.cos(tgt.yaw) * tgt.speed) * lead - p.z;
        const tl = Math.hypot(tx, ty, tz) || 1;
        // ~110 deg/s. Enough to correct a launch spread, not enough to follow a
        // car that jinks — dodging a missile has to remain possible.
        const turn = Math.min(1, (1.9 * dt) / Math.max(0.15, tl / speed));
        p.vx += (tx / tl * speed - p.vx) * turn;
        p.vy += (ty / tl * speed - p.vy) * turn;
        p.vz += (tz / tl * speed - p.vz) * turn;
        const ns = Math.hypot(p.vx, p.vy, p.vz) || 1;
        p.vx = (p.vx / ns) * speed;
        p.vy = (p.vy / ns) * speed;
        p.vz = (p.vz / ns) * speed;
      } else {
        p.vy -= 4 * dt;
      }
      // Its own trail: a burning motor plus a hanging white smoke line, which
      // is what lets you read a salvo's arc and see it curving toward you. It
      // used to borrow the cannon's propellant smoke, i.e. a lobbed shell.
      vfxProjectileTrail("missile", p.x, p.y, p.z, p.vx, p.vy, p.vz, vfxSeed(p.x, p.y, p.z));
      const groundY = getGroundHeight(p.x, p.z);
      if (p.y < groundY + 0.25) {
        detonateMissile(p, vehicles, null, groundY);
        projectiles.splice(i, 1);
        continue;
      }
    }
    if (p.kind === "cannon") {
      p.vy -= 6 * dt;
      const groundY = getGroundHeight(p.x, p.z);
      const ground = groundY + 0.2;
      if (p.y < ground) {
        // Only the first real bounce is worth hearing — and worth SEEING. A
        // shell that has settled keeps re-entering this branch every step with
        // a near-zero vy, so gating the terrain damage on the same threshold as
        // the audio is what stops one shell excavating a trench.
        if (p.vy < -2.5) {
          emitAudioCue("shell-land", p.x, p.y, p.z, 0.8, false);
          const seed = vfxSeed(p.x, p.y, p.z);
          const impactE = Math.min(1.2, -p.vy / 14);
          vfxExplosion(p.x, groundY + 0.25, p.z, {
            kind: "shell",
            radius: 1.1 + impactE * 0.7,
            energy: 0.5 + impactE,
            groundY,
            dirX: p.vx,
            dirZ: p.vz,
            seed,
          });
          spawnDebrisBurst(
            "ejecta",
            p.x,
            groundY + 0.2,
            p.z,
            p.vx,
            p.vz,
            impactE,
            groundY,
            0.7,
          );
          // addCrater refuses on tarmac (see landscape.ts) — a shell burns the
          // road rather than digging it, so the scorch is the fallback.
          if (!addCrater(p.x, p.z, 1.0 + impactE * 0.8, 0.22 + impactE * 0.2, seed)) {
            addScorch(p.x, p.z, 1.1 + impactE * 0.6, seed);
          } else {
            addScorch(p.x, p.z, 1.5 + impactE * 0.7, seed ^ 0x1f3a);
          }
        }
        p.y = ground;
        p.vy *= -0.22;
        p.vx *= 0.88;
        p.vz *= 0.88;
      }
    }

    if (p.life <= 0) {
      // A missile that simply blinks out of existence at the end of its burn is
      // the most obvious "that was a bug" moment the weapon can produce, and it
      // is what happens to every shot that misses. Self-destruct instead: the
      // motor runs out and the warhead goes off wherever it is.
      if (p.kind === "missile") {
        const gy = getGroundHeight(p.x, p.z);
        detonateMissile(p, vehicles, null, gy, p.y < gy + 1.2 ? "ground" : "air");
      }
      projectiles.splice(i, 1);
      continue;
    }

    let hit = false;
    for (const v of vehicles) {
      if (v.id === p.ownerId || !v.alive || v.wreckTimer > 0) continue;
      if (v.defenseActive > 0 && v.classId === "interceptor") continue;
      const dx = v.x - p.x;
      const dy = v.y + 0.4 - p.y;
      const dz = v.z - p.z;
      const dist = Math.hypot(dx, dy, dz);
      // Generous hit radius for mobile soft-lock reliability
      if (dist < p.radius + 1.35) {
        const len = Math.hypot(dx, dz) || 1;
        applyDamage(v, p.damage, p.ownerId, dx / len, dz / len);
        // Ordnance staggers; a bolt pocks. Same code path, different weight.
        v.hitStun = Math.max(v.hitStun, p.kind === "missile" ? 0.34 : 0.1);
        v.impactFlash = Math.max(v.impactFlash, p.kind === "missile" ? 0.4 : 0.12);
        v.speed += ((p.vx * dx + p.vz * dz) / len) * (p.kind === "missile" ? 0.03 : 0.018);
        if (p.kind === "missile") {
          detonateMissile(p, vehicles, v, getGroundHeight(p.x, p.z));
        } else {
          spawnHitSparks(particles, p.x, p.y, p.z, p.kind === "cannon" ? "#fdba74" : "#5eead4");
          // Rich impact, keyed off the weapon: the bolt is an energy discharge
          // (arcs, no debris), the shell and the disc are kinetic (sparks and
          // scale off the panel). The reversed projectile velocity stands in for
          // the surface normal, which is what makes the spray go back the way the
          // shot came rather than exploding radially.
          const seed = vfxSeed(p.x, p.y, p.z);
          const il = Math.hypot(p.vx, p.vy, p.vz) || 1;
          const groundY = getGroundHeight(p.x, p.z);
          vfxImpactBurst(
            p.x,
            p.y,
            p.z,
            -p.vx / il,
            -p.vy / il + 0.35,
            -p.vz / il,
            p.kind === "bolt" ? "energy" : "metal",
            0.35 + p.damage / 45,
            groundY,
            seed,
          );
          // A shell is a chemical round: it burns on contact. Sparks alone read
          // as a stone hitting a panel, which is what the cannon looked like.
          if (p.kind === "cannon") {
            vfxExplosion(p.x, p.y, p.z, {
              kind: "small",
              radius: 0.85,
              energy: 0.5 + p.damage / 55,
              groundY,
              dirX: p.vx / il,
              dirZ: p.vz / il,
              seed: seed ^ 0x3311,
            });
          }
          dentFromProjectile(v, p);
        }
        // The impact belongs to the victim, not the shooter: `self` is what
        // decides whether the player hears it dry (their own hull) or panned.
        emitAudioCue(
          p.kind === "cannon"
            ? "hit-cannon"
            : p.kind === "disc"
              ? "hit-disc"
              : p.kind === "missile"
                ? "mine-blast"
                : "hit-bolt",
          p.x,
          p.y,
          p.z,
          p.kind === "missile" ? 1.4 : 0.6 + p.damage / 40,
          v.isPlayer,
        );
        // Shooter ultimate trickle on hit
        const owner = vehicles.find((o) => o.id === p.ownerId);
        if (owner) {
          owner.ultimateCharge = Math.min(1, owner.ultimateCharge + 0.035);
        }
        if (p.kind === "disc" && p.bounce > 0) {
          p.bounce -= 1;
          p.vx *= -0.88;
          p.vz *= -0.88;
          p.ownerId = v.id;
          p.damage *= 0.72;
          p.life = Math.max(p.life, 0.4);
        } else {
          hit = true;
        }
        break;
      }
    }
    if (hit) projectiles.splice(i, 1);
  }
}

export function stepMines(
  mines: Mine[],
  vehicles: VehicleState[],
  particles: Particle[],
  dt: number,
): void {
  for (let i = mines.length - 1; i >= 0; i--) {
    const m = mines[i];
    m.life -= dt;
    m.armed = Math.max(0, m.armed - dt);
    if (m.life <= 0) {
      mines.splice(i, 1);
      continue;
    }
    if (m.armed > 0) continue;
    for (const v of vehicles) {
      if (v.id === m.ownerId || !v.alive || v.wreckTimer > 0) continue;
      if (v.defenseActive > 0 && v.classId === "interceptor") continue;
      const d = Math.hypot(v.x - m.x, v.z - m.z);
      if (d < m.radius) {
        const nx = (v.x - m.x) / Math.max(0.01, d);
        const nz = (v.z - m.z) / Math.max(0.01, d);
        applyDamage(v, m.damage, m.ownerId, nx, nz);
        v.speed *= 0.42;
        v.hitStun = Math.max(v.hitStun, 0.38);
        v.impactFlash = Math.max(v.impactFlash, 0.25);
        spawnHitSparks(particles, m.x, m.y + 0.5, m.z, "#f87171");
        emitAudioCue("mine-blast", m.x, m.y + 0.5, m.z, 1.3, v.isPlayer);

        /*
         * The full blast. `m.y` is where the mine was PLACED (tryUltimate
         * already sampled getGroundHeight for it), but the mine may have been
         * dropped a while ago and the blast damage has to land on the ground
         * under it right now — so the terrain is re-sampled here rather than
         * trusting a cached y. Everything downstream (crater floor, scorch,
         * shockwave, spark rest plane) hangs off that one number.
         */
        const groundY = getGroundHeight(m.x, m.z);
        const seed = vfxSeed(m.x, m.y, m.z);
        vfxExplosion(m.x, groundY + 0.45, m.z, {
          kind: "mine",
          radius: m.radius * 0.72,
          energy: 1.15,
          groundY,
          dirX: nx,
          dirZ: nz,
          seed,
        });
        spawnShockwave(m.x, groundY, m.z, m.radius * 0.85, nx, nz, seed, {
          r: 1,
          g: 0.94,
          b: 0.86,
        });
        spawnDebrisBurst(
          "ejecta",
          m.x,
          groundY + 0.3,
          m.z,
          nx,
          nz,
          1.2,
          groundY,
          m.radius * 0.5,
        );
        if (!addCrater(m.x, m.z, m.radius * 0.8, 0.5, seed)) {
          addImpactMark(m.x, m.z, m.radius * 0.7, seed);
        }
        addScorch(m.x, m.z, m.radius * 1.05, seed ^ 0x2c9d);
        // A mine detonating under a car folds the floorpan up into it: the
        // deform direction is straight down-to-up through the contact point.
        addVehicleDeformHitWorld(
          v.id,
          v.x - nx * 0.4,
          groundY + 0.2,
          v.z - nz * 0.4,
          -nx * 0.35,
          0.9,
          -nz * 0.35,
          v.x,
          v.y,
          v.z,
          v.yaw,
          0.13,
          1.25,
          seed,
        );

        mines.splice(i, 1);
        break;
      }
    }
  }
}

/**
 * Legacy spark puff, kept because the shared `particles` array is also what the
 * HUD-adjacent systems and physics.ts feed, and pulling combat out of it
 * entirely would change the pacing of that pool for everyone.
 *
 * Halved, though: the real sparks now come from the pooled VFX layer, which
 * bounces off the terrain and stretches along its velocity. Running both at the
 * old count just doubled the overdraw for no extra read.
 */
function spawnHitSparks(
  particles: Particle[],
  x: number,
  y: number,
  z: number,
  color: string,
) {
  vfxSparkShower(x, y, z, 0, 0, 0.7, getGroundHeight(x, z), vfxSeed(x, y, z));
  if (particles.length > 110) return;
  for (let i = 0; i < 2; i++) {
    const a = Math.random() * Math.PI * 2;
    particles.push({
      id: uid("spk"),
      x,
      y,
      z,
      vx: Math.cos(a) * (3 + Math.random() * 5),
      vy: 2 + Math.random() * 4,
      vz: Math.sin(a) * (3 + Math.random() * 5),
      life: 0.2 + Math.random() * 0.2,
      maxLife: 0.4,
      color,
      size: 0.1 + Math.random() * 0.1,
      kind: "spark",
    });
  }
}

export function stepParticles(particles: Particle[], dt: number) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) {
      particles.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    if (p.kind === "smoke" || p.kind === "dust") {
      p.vy *= 1 - 0.6 * dt;
      p.vy += (p.kind === "dust" ? 0.4 : 0.8) * dt;
      p.vx *= 1 - 0.8 * dt;
      p.vz *= 1 - 0.8 * dt;
      p.size += dt * (p.kind === "dust" ? 0.85 : 0.5);
    } else {
      p.vy -= 12 * dt;
    }
  }
}
