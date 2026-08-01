import { COMBAT } from "./balance";
import { VEHICLE_CLASSES } from "./classes";
import { applyDamage } from "./physics";
import { getGroundHeight } from "./track";
import { emitAudioCue } from "./audio/cues";
import type { Mine, Particle, PlayerInput, Projectile, VehicleState } from "./types";
import {
  vfxExplosion,
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
  v.primaryCooldown = def.primaryCooldown;

  const chargeMul =
    COMBAT.weaponMinMul + v.weaponCharge * (COMBAT.weaponMaxMul - COMBAT.weaponMinMul);
  v.weaponCharge = Math.max(0, v.weaponCharge - COMBAT.weaponDrain);

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
    v.classId === "interceptor"
      ? "fire-bolt"
      : v.classId === "bruiser"
        ? "fire-cannon"
        : "fire-disc",
    v.x,
    v.y + 0.6,
    v.z,
    0.75 + chargeMul * 0.35,
    v.isPlayer,
  );

  // Muzzle flash goes here, not on the input edge, for the same reason the
  // audio cue does: the shot is only real once the cooldown has passed, and
  // this is the single point every vehicle — player and AI — fires through.
  vfxMuzzleFlash(
    v.x + aimX * 1.7,
    v.y + 0.6,
    v.z + aimZ * 1.7,
    aimX,
    aimZ,
    v.classId === "interceptor" ? "bolt" : v.classId === "bruiser" ? "cannon" : "disc",
    chargeMul - COMBAT.weaponMinMul,
    vfxSeed(v.x, v.y, v.z),
  );

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
    projectiles.push({
      id: uid("cannon"),
      ownerId: v.id,
      x: v.x + aimX * 2.0,
      y: v.y + 0.7,
      z: v.z + aimZ * 2.0,
      vx: aimX * def.primarySpeed,
      vy: 0.4,
      vz: aimZ * def.primarySpeed,
      life: def.primaryRange / def.primarySpeed,
      damage: dmg,
      kind: "cannon",
      bounce: 0,
      radius: 0.45,
    });
  } else {
    projectiles.push({
      id: uid("disc"),
      ownerId: v.id,
      x: v.x + aimX * 1.5,
      y: v.y + 0.5,
      z: v.z + aimZ * 1.5,
      vx: aimX * def.primarySpeed,
      vy: 0,
      vz: aimZ * def.primarySpeed,
      life: (def.primaryRange / def.primarySpeed) * 1.45,
      damage: dmg,
      kind: "disc",
      bounce: 2,
      radius: 0.36,
    });
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
    v.ultimateActive = 4.2;
    v.boostTimer = Math.max(v.boostTimer, 2.2);
    v.weaponCharge = 1;
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
    let target: VehicleState | null = null;
    let bestD2 = 150 * 150;
    for (const o of vehicles) {
      if (o.id === v.id || !o.alive || o.wreckTimer > 0) continue;
      const d2 = (o.x - v.x) ** 2 + (o.z - v.z) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        target = o;
      }
    }
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
      "cannon",
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
      // "cannon" is the heaviest trail the vocabulary has; a dedicated
      // missile profile belongs in vfx/particles.ts, which is not this pass.
      vfxProjectileTrail("cannon", p.x, p.y, p.z, p.vx, p.vy, p.vz, vfxSeed(p.x, p.y, p.z));
      const groundY = getGroundHeight(p.x, p.z);
      if (p.y < groundY + 0.25) {
        vfxExplosion(p.x, groundY + 0.3, p.z, {
          kind: "mine",
          radius: 2.4,
          energy: 1.5,
          groundY,
          dirX: p.vx,
          dirZ: p.vz,
          seed: vfxSeed(p.x, p.y, p.z),
        });
        emitAudioCue("shell-land", p.x, p.y, p.z, 1.1, false);
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
        v.hitStun = Math.max(v.hitStun, 0.1);
        v.impactFlash = Math.max(v.impactFlash, 0.12);
        v.speed += ((p.vx * dx + p.vz * dz) / len) * 0.018;
        spawnHitSparks(particles, p.x, p.y, p.z, p.kind === "cannon" ? "#fdba74" : "#5eead4");
        // Rich impact, keyed off the weapon: the bolt is an energy discharge
        // (arcs, no debris), the shell and the disc are kinetic (sparks and
        // scale off the panel). The reversed projectile velocity stands in for
        // the surface normal, which is what makes the spray go back the way the
        // shot came rather than exploding radially.
        {
          const seed = vfxSeed(p.x, p.y, p.z);
          const il = Math.hypot(p.vx, p.vy, p.vz) || 1;
          vfxImpactBurst(
            p.x,
            p.y,
            p.z,
            -p.vx / il,
            -p.vy / il + 0.35,
            -p.vz / il,
            p.kind === "bolt" ? "energy" : "metal",
            0.35 + p.damage / 45,
            getGroundHeight(p.x, p.z),
            seed,
          );
          dentFromProjectile(v, p);
        }
        // The impact belongs to the victim, not the shooter: `self` is what
        // decides whether the player hears it dry (their own hull) or panned.
        emitAudioCue(
          p.kind === "cannon"
            ? "hit-cannon"
            : p.kind === "disc"
              ? "hit-disc"
              : "hit-bolt",
          p.x,
          p.y,
          p.z,
          0.6 + p.damage / 40,
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
