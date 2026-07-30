import { COMBAT } from "./balance";
import { VEHICLE_CLASSES } from "./classes";
import { applyDamage } from "./physics";
import { getGroundHeight } from "./track";
import type { Mine, Particle, PlayerInput, Projectile, VehicleState } from "./types";

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

export function tryUltimate(v: VehicleState, input: PlayerInput, mines: Mine[]): void {
  if (!input.useUltimate || v.ultimateCharge < 1 || v.wreckTimer > 0 || !v.alive) return;
  v.ultimateCharge = 0;

  if (v.classId === "interceptor") {
    v.ultimateActive = 4.2;
    v.boostTimer = Math.max(v.boostTimer, 2.2);
    v.weaponCharge = 1;
  } else if (v.classId === "bruiser") {
    v.ultimateActive = 3.0;
    v.boostTimer = Math.max(v.boostTimer, 2.8);
    v.defenseActive = Math.max(v.defenseActive, 1.4);
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
    if (p.kind === "cannon") {
      p.vy -= 6 * dt;
      const ground = getGroundHeight(p.x, p.z) + 0.2;
      if (p.y < ground) {
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
        for (let k = 0; k < 6; k++) {
          const a = Math.random() * Math.PI * 2;
          particles.push({
            id: uid("fx"),
            x: m.x,
            y: m.y + 0.3,
            z: m.z,
            vx: Math.cos(a) * 6,
            vy: 3 + Math.random() * 5,
            vz: Math.sin(a) * 6,
            life: 0.4,
            maxLife: 0.5,
            color: "#fdba74",
            size: 0.2,
            kind: "spark",
          });
        }
        mines.splice(i, 1);
        break;
      }
    }
  }
}

function spawnHitSparks(
  particles: Particle[],
  x: number,
  y: number,
  z: number,
  color: string,
) {
  if (particles.length > 110) return;
  for (let i = 0; i < 5; i++) {
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
