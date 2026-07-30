/**
 * Arcade world props: barrels, crates, scrap piles + soft track barriers.
 * Vehicles knock dynamics around; statics push cars back (circle colliders).
 * Collision uses distance early-outs for perf.
 */
import type { Particle, VehicleState } from "./types";
import { VEHICLE_HITBOX } from "./physics";
import { EDGE_MARKERS, TRACK_SAMPLES, SCENERY } from "./track";
import { VEHICLE_CLASSES } from "./classes";

export type PropKind = "barrel" | "crate" | "scrap" | "barrier";

export interface PhysProp {
  id: string;
  kind: PropKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  /** vertical velocity for hop/launch */
  vy: number;
  vz: number;
  spin: number;
  /** collision radius (XZ) */
  radius: number;
  mass: number;
  dynamic: boolean;
  hp: number;
  scale: number;
  /** scrap visual damage 0..1 */
  dent: number;
  dead: boolean;
}

let seq = 0;
function nid(prefix: string) {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** Build props for the active track (call on grid / track change). */
export function spawnWorldProps(): PhysProp[] {
  const props: PhysProp[] = [];

  // Soft barriers from edge markers (stride 5 for collision budget)
  for (let i = 0; i < EDGE_MARKERS.length; i += 5) {
    const m = EDGE_MARKERS[i];
    props.push({
      id: nid("bar"),
      kind: "barrier",
      x: m.x,
      y: m.y + 0.4,
      z: m.z,
      yaw: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      spin: 0,
      radius: 0.55,
      mass: 80,
      dynamic: false,
      hp: 999,
      scale: 1,
      dent: 0,
      dead: false,
    });
  }

  // Dynamic barrels / crates along track — close enough to hit while racing
  const step = Math.max(3, Math.floor(TRACK_SAMPLES.length / 36));
  for (let i = 1; i < TRACK_SAMPLES.length; i += step) {
    const s = TRACK_SAMPLES[i];
    const rx = Math.cos(s.yaw);
    const rz = -Math.sin(s.yaw);
    const side = i % 2 === 0 ? 1 : -1;
    // On the apron lip so cars brush them at race speed
    const off = s.width * 0.42 + 0.9 + (i % 4) * 0.15;
    const kind: PropKind = i % 3 === 0 ? "crate" : i % 3 === 1 ? "barrel" : "scrap";
    const r = kind === "crate" ? 0.78 : kind === "barrel" ? 0.52 : 0.9;
    props.push({
      id: nid(kind),
      kind,
      x: s.x + rx * side * off,
      y: s.y + (kind === "barrel" ? 0.48 : 0.42),
      z: s.z + rz * side * off,
      yaw: s.yaw + side * 0.4,
      vx: 0,
      vy: 0,
      vz: 0,
      spin: 0,
      radius: r,
      mass: kind === "crate" ? 14 : kind === "barrel" ? 9 : 20,
      dynamic: true,
      hp: kind === "scrap" ? 70 : 38,
      scale: kind === "scrap" ? 1.2 : 1.05,
      dent: 0,
      dead: false,
    });
  }

  // Dense ram corridor near grid — first 200m always has clutter
  for (let k = 0; k < 14; k++) {
    const idx = 3 + k * 2;
    const s = TRACK_SAMPLES[idx % TRACK_SAMPLES.length];
    if (!s) continue;
    const rx = Math.cos(s.yaw);
    const rz = -Math.sin(s.yaw);
    for (const side of [-1, 1] as const) {
      const kind: PropKind = k % 3 === 0 ? "crate" : k % 3 === 1 ? "barrel" : "scrap";
      props.push({
        id: nid(kind),
        kind,
        x: s.x + rx * side * (s.width * 0.38 + 0.85),
        y: s.y + 0.48,
        z: s.z + rz * side * (s.width * 0.38 + 0.85),
        yaw: s.yaw + side * 0.2,
        vx: 0,
        vy: 0,
        vz: 0,
        spin: 0,
        radius: kind === "barrel" ? 0.52 : kind === "crate" ? 0.75 : 0.88,
        mass: kind === "barrel" ? 8 : kind === "crate" ? 12 : 18,
        dynamic: true,
        hp: 36,
        scale: 1.1,
        dent: 0,
        dead: false,
      });
    }
  }

  // A few props ON the racing line (dodge or smash)
  for (let k = 0; k < 12; k++) {
    const idx = 10 + k * 14;
    const s = TRACK_SAMPLES[idx % TRACK_SAMPLES.length];
    if (!s) continue;
    const rx = Math.cos(s.yaw);
    const rz = -Math.sin(s.yaw);
    const side = k % 2 === 0 ? 0.35 : -0.4;
    props.push({
      id: nid("barrel"),
      kind: "barrel",
      x: s.x + rx * side * s.width * 0.25,
      y: s.y + 0.5,
      z: s.z + rz * side * s.width * 0.25,
      yaw: s.yaw,
      vx: 0,
      vy: 0,
      vz: 0,
      spin: 0,
      radius: 0.55,
      mass: 7,
      dynamic: true,
      hp: 28,
      scale: 1.15,
      dent: 0,
      dead: false,
    });
  }

  // Yard cluster near showcase pad
  const s0 = TRACK_SAMPLES[0];
  if (s0) {
    const yard: Array<{ dx: number; dz: number; kind: PropKind }> = [
      { dx: 14, dz: -8, kind: "barrel" },
      { dx: 18, dz: -14, kind: "crate" },
      { dx: 8, dz: -20, kind: "barrel" },
      { dx: 22, dz: -6, kind: "scrap" },
      { dx: 4, dz: -12, kind: "barrel" },
      { dx: 16, dz: 6, kind: "crate" },
      { dx: 28, dz: 10, kind: "barrel" },
      { dx: -6, dz: 8, kind: "scrap" },
      { dx: 10, dz: -10, kind: "barrel" },
      { dx: 20, dz: -18, kind: "crate" },
      { dx: 12, dz: -4, kind: "barrel" },
      { dx: 6, dz: -16, kind: "crate" },
    ];
    for (const y of yard) {
      props.push({
        id: nid(y.kind),
        kind: y.kind,
        x: s0.x + y.dx,
        y: 0.48,
        z: s0.z + y.dz,
        yaw: Math.random() * Math.PI,
        vx: 0,
        vy: 0,
        vz: 0,
        spin: 0,
        radius: y.kind === "barrel" ? 0.52 : y.kind === "crate" ? 0.75 : 0.95,
        mass: y.kind === "barrel" ? 9 : 16,
        dynamic: true,
        hp: 45,
        scale: 1.1,
        dent: 0,
        dead: false,
      });
    }
  }

  // Scenery footprints as static blockers (skip tiny)
  for (const sc of SCENERY) {
    if (sc.scale < 0.7) continue;
    const r =
      sc.kind === "tower" ? 2.0 * sc.scale : sc.kind === "crane" ? 1.6 * sc.scale : 1.3 * sc.scale;
    props.push({
      id: nid("sc"),
      kind: "barrier",
      x: sc.x,
      y: 1,
      z: sc.z,
      yaw: sc.rot,
      vx: 0,
      vy: 0,
      vz: 0,
      spin: 0,
      radius: r,
      mass: 200,
      dynamic: false,
      hp: 999,
      scale: sc.scale,
      dent: 0,
      dead: false,
    });
  }

  return props;
}

function worldVel(v: VehicleState) {
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

function spawnPropFx(
  particles: Particle[] | null,
  x: number,
  y: number,
  z: number,
  color: string,
) {
  if (!particles || particles.length > 50) return;
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * Math.PI * 2;
    particles.push({
      id: `pfx-${seq++}-${i}`,
      x,
      y,
      z,
      vx: Math.cos(a) * (3 + Math.random() * 6),
      vy: 3 + Math.random() * 7,
      vz: Math.sin(a) * (3 + Math.random() * 6),
      life: 0.3 + Math.random() * 0.35,
      maxLife: 0.65,
      color,
      size: 0.14 + Math.random() * 0.18,
      kind: Math.random() > 0.45 ? "debris" : "spark",
    });
  }
}

/** Vehicle ↔ prop collisions (circle). Mutates both. Broadphase: skip far pairs. */
export function collideVehiclesWithProps(
  vehicles: VehicleState[],
  props: PhysProp[],
  particles: Particle[] | null,
): number {
  let maxImpact = 0;
  const STATIC_R = 16;
  const STATIC_R2 = STATIC_R * STATIC_R;

  for (const v of vehicles) {
    if (!v.alive || v.wreckTimer > 0) continue;
    const hb = VEHICLE_HITBOX[v.classId];
    const massV = VEHICLE_CLASSES[v.classId].mass;
    const va = worldVel(v);

    for (const p of props) {
      if (p.dead) continue;
      const dx = p.x - v.x;
      const dz = p.z - v.z;
      const distSq = dx * dx + dz * dz;

      if (!p.dynamic) {
        if (distSq > STATIC_R2) continue;
      } else if (distSq > 120) {
        continue;
      }

      // OBB-aware radius: expand circle by yaw-projected half-extents so
      // long cars don't clip corners through barrels.
      const c = Math.abs(Math.cos(v.yaw));
      const s = Math.abs(Math.sin(v.yaw));
      const obbR =
        Math.max(hb.halfW * c + hb.halfL * s, hb.halfW * s + hb.halfL * c) *
          0.92 +
        p.radius;
      if (distSq >= obbR * obbR || distSq < 1e-8) continue;

      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const nz = dz / dist;
      const pen = obbR - dist;

      if (p.dynamic) {
        const total = massV + p.mass;
        v.x -= nx * pen * (p.mass / total) * 0.9;
        v.z -= nz * pen * (p.mass / total) * 0.9;
        p.x += nx * pen * (massV / total) * 1.2;
        p.z += nz * pen * (massV / total) * 1.2;
      } else {
        // Static barriers: full push-out + slight yaw scrub
        v.x -= nx * pen * 1.15;
        v.z -= nz * pen * 1.15;
        v.yaw += (nx * Math.cos(v.yaw) + nz * -Math.sin(v.yaw)) * pen * 0.08;
      }

      const rvx = va.vx - p.vx;
      const rvz = va.vz - p.vz;
      const velN = rvx * nx + rvz * nz;
      // Still apply soft push when nested even if not approaching
      if (velN < -0.5 && pen < 0.05) continue;

      const restitution = p.dynamic ? 0.62 : 0.28;
      const invSum = 1 / massV + (p.dynamic ? 1 / p.mass : 0);
      const approach = Math.max(0, velN);
      const j =
        approach > 0.02
          ? (-(1 + restitution) * approach) / invSum
          : -pen * 2.8;
      // Light props always launch; walls absorb more
      const jPush = p.dynamic ? Math.min(-5.5, j * 1.25) : Math.min(-2.2, j);
      const jx = jPush * nx;
      const jz = jPush * nz;

      applyWorldVel(v, va.vx + jx / massV, va.vz + jz / massV);
      va.vx += jx / massV;
      va.vz += jz / massV;

      if (p.dynamic) {
        const launch = 1.85 + Math.min(3.2, Math.abs(velN) * 0.1);
        p.vx -= (jx / p.mass) * launch;
        p.vz -= (jz / p.mass) * launch;
        p.vx += va.vx * 0.42;
        p.vz += va.vz * 0.42;
        // Vertical pop for tumbling barrels
        p.vy = Math.max(p.vy, 2.5 + Math.min(8, Math.abs(velN) * 0.15));
        p.spin += (nx * va.vz - nz * va.vx) * 0.1 + (Math.random() - 0.5) * 2.5;
        const impact = Math.abs(velN) + pen * 4;
        maxImpact = Math.max(maxImpact, impact);
        if (impact > 2.5) {
          p.hp -= impact * 1.4;
          p.dent = Math.min(1, p.dent + impact * 0.07);
          v.impactFlash = Math.max(v.impactFlash, 0.22);
          if (impact > 6) {
            v.hitStun = Math.max(v.hitStun, 0.08);
            if (p.kind === "scrap" || p.kind === "crate") {
              v.health = Math.max(0, v.health - impact * 0.12);
              v.damageVisual = Math.min(
                1,
                Math.max(v.damageVisual, 1 - v.health / v.maxHealth),
              );
            }
            spawnPropFx(
              particles,
              p.x,
              p.y,
              p.z,
              p.kind === "barrel" ? "#fb923c" : "#d6d3d1",
            );
          }
          if (p.hp <= 0) {
            p.dead = true;
            p.vx *= 1.6;
            p.vz *= 1.6;
            spawnPropFx(particles, p.x, p.y + 0.3, p.z, "#a8a29e");
          }
        }
      } else {
        const impact = Math.abs(velN);
        maxImpact = Math.max(maxImpact, impact);
        if (impact > 8) {
          v.impactFlash = Math.max(v.impactFlash, 0.18);
          v.hitStun = Math.max(v.hitStun, 0.06);
          v.health = Math.max(0, v.health - impact * 0.07);
          v.damageVisual = Math.min(
            1,
            Math.max(v.damageVisual, 1 - v.health / v.maxHealth),
          );
        }
      }
    }
  }
  return maxImpact;
}

/** Integrate dynamic props after vehicle collisions. */
export function stepWorldProps(props: PhysProp[], dt: number) {
  for (const p of props) {
    if (p.dead || !p.dynamic) continue;
    if (p.vy === undefined) p.vy = 0;
    p.x += p.vx * dt;
    p.z += p.vz * dt;
    p.y += p.vy * dt;
    p.yaw += p.spin * dt;
    const restY = p.kind === "barrel" ? 0.48 : 0.42;
    // Gravity + ground clamp
    p.vy -= 22 * dt;
    if (p.y <= restY) {
      p.y = restY;
      if (p.vy < 0) p.vy *= -0.35;
      if (Math.abs(p.vy) < 0.4) p.vy = 0;
    }
    p.vx *= 1 - 1.9 * dt;
    p.vz *= 1 - 1.9 * dt;
    p.spin *= 1 - 2.2 * dt;
    if (Math.abs(p.vx) < 0.03) p.vx = 0;
    if (Math.abs(p.vz) < 0.03) p.vz = 0;
  }

  const dyn = props.filter((p) => p.dynamic && !p.dead);
  const active = dyn.filter(
    (p) => Math.abs(p.vx) > 0.08 || Math.abs(p.vz) > 0.08 || p.dent > 0,
  );
  const check = active.length ? active : dyn.slice(0, 10);
  for (let i = 0; i < check.length; i++) {
    for (let j = i + 1; j < dyn.length; j++) {
      const a = check[i];
      const b = dyn[j];
      if (a === b) continue;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > 16) continue;
      const r = a.radius + b.radius;
      if (distSq >= r * r || distSq < 1e-8) continue;
      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const nz = dz / dist;
      const pen = (r - dist) * 0.5;
      a.x -= nx * pen;
      a.z -= nz * pen;
      b.x += nx * pen;
      b.z += nz * pen;
      const rvx = a.vx - b.vx;
      const rvz = a.vz - b.vz;
      const vn = rvx * nx + rvz * nz;
      if (vn > 0) {
        a.vx -= vn * nx * 0.5;
        a.vz -= vn * nz * 0.5;
        b.vx += vn * nx * 0.5;
        b.vz += vn * nz * 0.5;
      }
    }
  }
}
