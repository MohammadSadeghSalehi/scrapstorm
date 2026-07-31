/**
 * Arcade world props: barrels, crates, scrap piles + soft track barriers.
 * Vehicles knock dynamics around; statics push cars back (circle colliders).
 * Collision uses distance early-outs for perf.
 */
import type { Particle, VehicleState } from "./types";
import { VEHICLE_HITBOX } from "./physics";
import { EDGE_MARKERS, TRACK_SAMPLES, SCENERY } from "./track";
import { VEHICLE_CLASSES } from "./classes";
import { downEdgeAt, resetEdgeDamage } from "./world/edgeDamage";

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
  // Fresh grid — every post stands again.
  resetEdgeDamage();

  /**
   * Track samples either side of the start line kept free of obstacles. The
   * whole field launches abreast and accelerating through here, so anything
   * placed in this stretch guaranteed contact before the first corner.
   */
  const GRID_CLEAR = Math.max(8, Math.floor(TRACK_SAMPLES.length * 0.06));

  // Soft barriers from edge markers. Stride 10 rather than 5: only every Nth
  // post carries a collider anyway, and dense colliders meant clipping a
  // corner put you into something almost immediately.
  //
  // GRID_CLEAR skips the markers flanking the start line entirely. Four cars
  // launching abreast fan out across the full width, so barrier colliders
  // right there turned a normal start into an instant collision.
  for (let i = 0; i < EDGE_MARKERS.length; i += 10) {
    const markerClear = Math.max(10, Math.floor(EDGE_MARKERS.length * 0.06));
    if (i < markerClear || i > EDGE_MARKERS.length - markerClear) continue;
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

  // Dynamic barrels / crates along track — close enough to hit while racing.
  // GRID_CLEAR keeps the launch straight empty; the whole field is bunched and
  // accelerating there, so props in that stretch guaranteed a first-corner
  // pile-up rather than a race.
  const step = Math.max(3, Math.floor(TRACK_SAMPLES.length / 26));
  for (let i = 1; i < TRACK_SAMPLES.length; i += step) {
    if (i < GRID_CLEAR || i > TRACK_SAMPLES.length - GRID_CLEAR * 0.5) continue;
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

  // Light clutter near the grid. This was 14 rows on BOTH sides packed 2
  // samples apart — 28 extra props inside the first ~200m, on top of the
  // distribution above. That is the densest part of the track arriving exactly
  // when the whole grid is accelerating into it, so it cost both frame time
  // and a clean launch. Halved the rows and doubled the spacing, and each row
  // now populates one side only so there is always a clear line through.
  // Starts past GRID_CLEAR — at idx 5 these sat directly on the launch.
  for (let k = 0; k < 7; k++) {
    const idx = GRID_CLEAR + 4 + k * 5;
    const s = TRACK_SAMPLES[idx % TRACK_SAMPLES.length];
    if (!s) continue;
    const rx = Math.cos(s.yaw);
    const rz = -Math.sin(s.yaw);
    for (const side of [k % 2 === 0 ? -1 : 1] as const) {
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

  // A few props ON the racing line (dodge or smash) — also held back past the
  // grid so the opening straight is genuinely clear.
  for (let k = 0; k < 10; k++) {
    const idx = GRID_CLEAR + 12 + k * 16;
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
/**
 * Closing speed (m/s) below which a prop absorbs the hit instead of moving.
 * Low, so props start reacting almost as soon as you are actually rolling —
 * a barrel that ignores a 5 m/s shunt reads as welded to the ground.
 */
const PROP_NUDGE_SPEED = 1.0;
/** Closing speed at which a light prop is fully launched/airborne. */
const PROP_LAUNCH_SPEED = 8;
/** Closing speed above which a barrel ruptures rather than tumbling. */
const BARREL_RUPTURE_SPEED = 16;
/**
 * Closing speed above which a barrier breaks apart instead of holding. Below
 * this it still deflects rather than stopping you — see the static branch.
 */
const BARRIER_BREAK_SPEED = 9;
/** Reference prop mass (a light barrel) that reaction is scaled against. */
const PROP_REF_MASS = 9;

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

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

      // Closing speed is needed before the positional resolve, so a barrier
      // taken hard enough can break instead of being pushed against.
      const rvx = va.vx - p.vx;
      const rvz = va.vz - p.vz;
      const velN = rvx * nx + rvz * nz;

      // Barriers were dynamic:false with hp:999 — indestructible walls lining
      // the track that simply stopped the car dead. Hit one above the break
      // speed and it becomes debris: the car ploughs through with a speed
      // penalty rather than being pinned.
      // Hit hard enough, the barrier is destroyed outright: the collider dies
      // and downEdgeAt tells CulledEdgePosts to stop drawing that post, so the
      // world stays honest. No push-back at all — being bounced backwards off
      // scenery at speed is the thing that felt worst — just a speed cost and
      // hull damage as you plough through.
      if (!p.dynamic && velN > BARRIER_BREAK_SPEED) {
        const drive = Math.min(2.0, velN / BARRIER_BREAK_SPEED);
        p.dead = true;
        p.hp = 0;
        downEdgeAt(p.x, p.z);
        const keep = 0.9 - 0.06 * drive; // heavier hits scrub more speed
        applyWorldVel(v, va.vx * keep, va.vz * keep);
        va.vx *= keep;
        va.vz *= keep;
        v.hitStun = Math.max(v.hitStun, 0.06);
        v.impactFlash = Math.max(v.impactFlash, 0.4);
        v.health = Math.max(0, v.health - 3.5 * drive);
        v.damageVisual = Math.min(
          1,
          Math.max(v.damageVisual, 1 - v.health / v.maxHealth),
        );
        maxImpact = Math.max(maxImpact, velN);
        // Debris thrown along the car's line of travel.
        for (let k = 0; k < 3; k++) {
          spawnPropFx(
            particles,
            p.x + (Math.random() - 0.5) * 1.2,
            p.y + 0.3 + Math.random() * 0.9,
            p.z + (Math.random() - 0.5) * 1.2,
            k === 0 ? "#dc2626" : "#d6d3d1",
          );
        }
        continue;
      }

      // Intact barrier (below break speed): deflect, never reverse.
      //
      // A static prop has invSum = 1/massV, so the shared restitution impulse
      // below worked out to -(1 + e) x approach — it flipped the car's velocity
      // straight back out of the wall. That is the "it stops us dead and throws
      // us back" behaviour. Instead cancel only the component INTO the barrier
      // and keep the component along it, so you scrape past and lose speed in
      // proportion to how square the hit was. Handled entirely here so the
      // generic impulse never runs for barriers.
      if (!p.dynamic) {
        v.x -= nx * pen;
        v.z -= nz * pen;
        v.yaw += (nx * Math.cos(v.yaw) + nz * -Math.sin(v.yaw)) * pen * 0.06;
        const closing = Math.max(0, velN);
        if (closing > 0.4) {
          // Kill the inward component (leaving a sliver avoids re-sticking),
          // then take a speed cost that scales with the impact.
          const removeN = closing * 0.9;
          const scrub = 1 - Math.min(0.3, closing * 0.012);
          const nvx = (va.vx - nx * removeN) * scrub;
          const nvz = (va.vz - nz * removeN) * scrub;
          applyWorldVel(v, nvx, nvz);
          va.vx = nvx;
          va.vz = nvz;
          if (closing > 6) {
            v.impactFlash = Math.max(v.impactFlash, 0.22);
            v.hitStun = Math.max(v.hitStun, 0.04);
            v.health = Math.max(0, v.health - closing * 0.06);
            v.damageVisual = Math.min(
              1,
              Math.max(v.damageVisual, 1 - v.health / v.maxHealth),
            );
          }
        }
        maxImpact = Math.max(maxImpact, Math.abs(velN));
        continue;
      }

      const total = massV + p.mass;
      v.x -= nx * pen * (p.mass / total) * 0.9;
      v.z -= nz * pen * (p.mass / total) * 0.9;
      p.x += nx * pen * (massV / total) * 1.2;
      p.z += nz * pen * (massV / total) * 1.2;
      // Still apply soft push when nested even if not approaching
      if (velN < -0.5 && pen < 0.05) continue;

      const restitution = p.dynamic ? 0.62 : 0.28;
      const invSum = 1 / massV + (p.dynamic ? 1 / p.mass : 0);
      const approach = Math.max(0, velN);
      const j =
        approach > 0.02
          ? (-(1 + restitution) * approach) / invSum
          : -pen * 2.8;
      // No constant floor for dynamic props: a fixed -5.5 meant a barrel was
      // launched just as hard by a crawl as by a full-speed hit. Only keep
      // enough impulse to resolve the penetration; everything above that has
      // to be earned by actual closing speed.
      const jPush = p.dynamic
        ? Math.min(-pen * 2.0, j * 1.25)
        : Math.min(-2.2, j);
      const jx = jPush * nx;
      const jz = jPush * nz;

      applyWorldVel(v, va.vx + jx / massV, va.vz + jz / massV);
      va.vx += jx / massV;
      va.vz += jz / massV;

      if (p.dynamic) {
        const closing = Math.max(0, velN);
        // Heavier props resist the same hit: an 80kg barrier barely shifts
        // where an 8kg barrel is thrown clear.
        const massRatio = PROP_REF_MASS / Math.max(1, p.mass);
        // 0 at a nudge, 1 once there is enough speed to fully launch.
        const speedT = clamp01(
          (closing - PROP_NUDGE_SPEED) / (PROP_LAUNCH_SPEED - PROP_NUDGE_SPEED),
        );

        const launch = 1 + speedT * 2.6 * massRatio;
        p.vx -= (jx / p.mass) * launch;
        p.vz -= (jz / p.mass) * launch;
        // Drag along with the car — more so at speed, so a slow shunt rolls
        // the prop aside instead of firing it down the track.
        const carry = 0.16 + speedT * 0.34;
        p.vx += va.vx * carry;
        p.vz += va.vz * carry;

        // Vertical only once the hit can actually lift the prop's own mass.
        // Previously every contact popped it 2.5m/s upward, so barrels took
        // flight at walking pace.
        if (speedT > 0) {
          p.vy = Math.max(p.vy, speedT * (3.0 + closing * 0.24) * massRatio);
        }
        p.spin +=
          (nx * va.vz - nz * va.vx) * (0.05 + speedT * 0.12) +
          (Math.random() - 0.5) * (0.5 + speedT * 3.0);

        const impact = closing + pen * 4;
        maxImpact = Math.max(maxImpact, impact);

        // A barrel taken at speed ruptures rather than tumbling away.
        if (p.kind === "barrel" && closing > BARREL_RUPTURE_SPEED && !p.dead) {
          p.dead = true;
          p.hp = 0;
          const blast = Math.min(2.4, closing / BARREL_RUPTURE_SPEED);
          p.vy = Math.max(p.vy, 6 * blast);
          p.spin += (Math.random() - 0.5) * 12;
          v.hitStun = Math.max(v.hitStun, 0.14 * blast);
          v.impactFlash = Math.max(v.impactFlash, 0.6);
          v.health = Math.max(0, v.health - 6 * blast);
          v.damageVisual = Math.min(
            1,
            Math.max(v.damageVisual, 1 - v.health / v.maxHealth),
          );
          for (let k = 0; k < 4; k++) {
            spawnPropFx(
              particles,
              p.x + (Math.random() - 0.5) * 1.6,
              p.y + 0.3 + Math.random() * 1.2,
              p.z + (Math.random() - 0.5) * 1.6,
              k < 2 ? "#fb923c" : "#fde68a",
            );
          }
          // Blast radius: throws nearby props and hurts nearby cars, so a
          // cluster of barrels chain-reacts instead of each one popping in
          // isolation. This is what makes them worth aiming at.
          const R = 6.5 * blast;
          const R2 = R * R;
          for (const o of props) {
            if (o === p || o.dead || !o.dynamic) continue;
            const ox = o.x - p.x;
            const oz = o.z - p.z;
            const od2 = ox * ox + oz * oz;
            if (od2 > R2 || od2 < 1e-6) continue;
            const od = Math.sqrt(od2);
            const falloff = (1 - od / R) * blast;
            const push = (26 * falloff) / Math.max(1, o.mass);
            o.vx += (ox / od) * push;
            o.vz += (oz / od) * push;
            o.vy = Math.max(o.vy, 4 * falloff);
            o.spin += (Math.random() - 0.5) * 8 * falloff;
            o.hp -= 22 * falloff;
            if (o.hp <= 0) o.dead = true;
          }
          for (const other of vehicles) {
            if (!other.alive || other.wreckTimer > 0) continue;
            const ox = other.x - p.x;
            const oz = other.z - p.z;
            const od2 = ox * ox + oz * oz;
            if (od2 > R2) continue;
            const falloff = (1 - Math.sqrt(od2) / R) * blast;
            other.health = Math.max(0, other.health - 9 * falloff);
            other.damageVisual = Math.min(
              1,
              Math.max(other.damageVisual, 1 - other.health / other.maxHealth),
            );
            other.impactFlash = Math.max(other.impactFlash, 0.5 * falloff);
            other.hitStun = Math.max(other.hitStun, 0.1 * falloff);
          }
          continue;
        }
        if (impact > 2.5) {
          p.hp -= impact * 1.4;
          p.dent = Math.min(1, p.dent + impact * 0.07);
          v.impactFlash = Math.max(v.impactFlash, 0.22);
          if (impact > 6) {
            v.hitStun = Math.max(v.hitStun, 0.08);
            // Barrels used to be excluded here, so ramming one below the
            // rupture threshold cost nothing at all — they read as scenery.
            // Lighter than a scrap pile, but no longer free.
            const dmgMul = p.kind === "barrel" ? 0.07 : 0.12;
            v.health = Math.max(0, v.health - impact * dmgMul);
            v.damageVisual = Math.min(
              1,
              Math.max(v.damageVisual, 1 - v.health / v.maxHealth),
            );
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
