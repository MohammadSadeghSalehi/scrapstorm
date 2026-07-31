/**
 * Pooled destruction debris — the chunks a prop actually breaks into.
 *
 * Lives outside `SimState` for the same reason edgeDamage does: the sim owns
 * when a prop dies, the renderer owns what that looks like, and neither sim.ts
 * nor GameScene should have to learn about a third entity list to connect them.
 * worldProps spawns/steps this pool; PhysicsPropsView reads it back.
 *
 * Everything is preallocated at module load. A five-barrel chain reaction is
 * exactly the moment you cannot afford a GC pause, so a burst only ever writes
 * into existing slots — `active` flags, never `push`/`splice`.
 */
import type { PropKind } from "../worldProps";

export const DEBRIS_SHAPE = {
  /** Irregular solid — torn metal, rubble */
  CHUNK: 0,
  /** Long and thin — crate slats, splinters */
  PLANK: 1,
  /** Heavy and flat — concrete */
  SLAB: 2,
  /** Thin sheet — barrel wall, body panel */
  PANEL: 3,
} as const;

export const DEBRIS_SHAPE_COUNT = 4;

/**
 * Hard ceiling on live chunks across the whole world. Sized so a pile-up into
 * a barrel cluster (4-5 simultaneous bursts) still resolves without recycling
 * pieces that are still mid-flight, but small enough that the per-frame pose
 * loop stays in the noise at 150fps.
 */
export const DEBRIS_MAX = 96;

/** Seconds of shrink-and-sink at the end of a piece's life. */
export const DEBRIS_FADE = 0.85;

/** Half-height of each shape at scale 1, for the ground rest plane. */
const SHAPE_HALF_H = [0.17, 0.05, 0.09, 0.03] as const;

export interface DebrisPiece {
  active: boolean;
  shape: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Euler tumble. Free-flying chunks never hold a pose long enough for gimbal
   *  drift to read, and this keeps the pool free of THREE imports. */
  rx: number;
  ry: number;
  rz: number;
  wx: number;
  wy: number;
  wz: number;
  /** Uniform size multiplier applied to the shape geometry. */
  scale: number;
  colorHex: string;
  /** Per-piece brightness jitter so a burst isn't one flat colour. */
  tint: number;
  /** Y the piece rests on — sampled once at the burst, see spawnPropDebris. */
  groundY: number;
  bounce: number;
  drag: number;
  life: number;
  maxLife: number;
  /** Stopped moving — skipped by the integrator until it fades out. */
  asleep: boolean;
}

interface DebrisProfile {
  count: number;
  /** Outward speed (m/s) at reference impact energy. */
  speed: number;
  /** Share of the launch sent straight up. 0 = flat spray, 1 = fountain. */
  up: number;
  /** How hard the burst follows the impactor's travel vs radiating evenly. */
  follow: number;
  /** Peak angular velocity (rad/s). */
  spin: number;
  bounce: number;
  /** Linear damping per second. */
  drag: number;
  life: number;
  size: number;
  shapes: readonly number[];
  palette: readonly string[];
}

const { CHUNK, PLANK, SLAB, PANEL } = DEBRIS_SHAPE;

/**
 * Per-kind break signatures. These are the whole point of the system: the same
 * burst parameters for every prop is what made destruction read as one generic
 * "puff" effect regardless of what you actually hit.
 */
const PROFILES: Record<PropKind, DebrisProfile> = {
  // Pressure vessel: the lid and wall panels go up and out in a near-spherical
  // burst, metal rings off the tarmac, pieces carry a long way.
  barrel: {
    count: 10,
    speed: 7.6,
    up: 1.0,
    follow: 0.35,
    spin: 15,
    bounce: 0.42,
    drag: 1.25,
    life: 3.2,
    size: 0.34,
    shapes: [PANEL, PANEL, CHUNK, PANEL, CHUNK],
    palette: ["#ea580c", "#c2410c", "#7c2d12", "#a8a29e", "#44403c"],
  },
  // Shatters rather than bursts: slats spray along the line of travel, windmill
  // hard, and thud dead on the first bounce. Nothing about wood springs back.
  crate: {
    count: 12,
    speed: 6.0,
    up: 0.45,
    follow: 0.72,
    spin: 19,
    bounce: 0.15,
    drag: 2.35,
    life: 2.6,
    size: 0.36,
    shapes: [PLANK, PLANK, PLANK, SLAB, PANEL],
    palette: ["#d6c7b0", "#b09678", "#8a6f52", "#e7d9c3"],
  },
  // A pile does not explode, it collapses. Low, slow, heavy tumble, and it
  // stays roughly where the pile was.
  scrap: {
    count: 8,
    speed: 3.4,
    up: 0.3,
    follow: 0.5,
    spin: 9,
    bounce: 0.12,
    drag: 3.1,
    life: 2.8,
    size: 0.33,
    shapes: [CHUNK, PANEL, CHUNK, CHUNK],
    palette: ["#a8a29e", "#78716c", "#8a5a3b", "#57534e"],
  },
  // Ploughed through, not blown up: slabs go where the car was going, skid
  // rather than spin, and sit on the road for a while afterwards.
  barrier: {
    count: 11,
    speed: 5.6,
    up: 0.42,
    follow: 0.88,
    spin: 6.5,
    bounce: 0.08,
    drag: 2.05,
    life: 3.6,
    size: 0.42,
    shapes: [SLAB, SLAB, CHUNK, SLAB, CHUNK],
    palette: ["#e7e5e4", "#d6d3d1", "#a8a29e", "#dc2626", "#78716c"],
  },
};

/** Matches stepWorldProps so a chunk falls at the same rate as the prop did. */
const GRAVITY = 22;
const GROUND_FRICTION = 7.5;
const TAU = Math.PI * 2;

function makePiece(): DebrisPiece {
  return {
    active: false,
    shape: 0,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    rx: 0,
    ry: 0,
    rz: 0,
    wx: 0,
    wy: 0,
    wz: 0,
    scale: 1,
    colorHex: "#a8a29e",
    tint: 1,
    groundY: 0,
    bounce: 0.2,
    drag: 2,
    life: 0,
    maxLife: 1,
    asleep: false,
  };
}

const pool: DebrisPiece[] = Array.from({ length: DEBRIS_MAX }, makePiece);
let activeCount = 0;
let cursor = 0;

/**
 * Next writable slot. Free slots first; once saturated the shortest-lived
 * piece goes — recycling by pool order would sometimes kill a chunk that just
 * launched while a settled one sat there for another two seconds.
 */
function acquire(): DebrisPiece {
  if (activeCount < DEBRIS_MAX) {
    for (let i = 0; i < DEBRIS_MAX; i++) {
      const d = pool[(cursor + i) % DEBRIS_MAX]!;
      if (!d.active) {
        cursor = (cursor + i + 1) % DEBRIS_MAX;
        activeCount += 1;
        return d;
      }
    }
  }
  let worst = pool[0]!;
  for (let i = 1; i < DEBRIS_MAX; i++) {
    const d = pool[i]!;
    if (d.life < worst.life) worst = d;
  }
  // Only if the scan above somehow missed a free slot — keeps the counter from
  // drifting under, which would eventually let stepDebris decrement past zero.
  if (!worst.active) activeCount += 1;
  return worst;
}

/**
 * Break a prop apart.
 *
 * `dirX/dirZ` is the impactor's direction of travel (need not be normalised;
 * pass 0,0 for a directionless collapse) and `energy` is roughly
 * closing speed / 12, clamped by the caller — it drives both piece count and
 * launch speed, so a barely-fatal hit crumbles and a full-speed one erupts.
 *
 * `groundY` is sampled once by the caller rather than per chunk per frame:
 * props ride a flat rest height (see stepWorldProps) and debris never travels
 * far enough for the dune field to matter, so a terrain query per piece would
 * be pure cost.
 */
export function spawnPropDebris(
  kind: PropKind,
  x: number,
  y: number,
  z: number,
  dirX: number,
  dirZ: number,
  energy: number,
  groundY: number,
  radius: number,
): void {
  const prof = PROFILES[kind];
  const e = Math.max(0, Math.min(2.2, energy));
  const dirLen = Math.hypot(dirX, dirZ);
  const fx = dirLen > 1e-4 ? dirX / dirLen : 0;
  const fz = dirLen > 1e-4 ? dirZ / dirLen : 0;

  const count = Math.max(3, Math.round(prof.count * (0.5 + 0.5 * Math.min(1, e))));
  const speed = prof.speed * (0.55 + 0.55 * e);
  const spread = Math.max(0.25, radius * 0.55);

  for (let i = 0; i < count; i++) {
    const d = acquire();
    const a = Math.random() * TAU;
    // Radial base direction biased toward the impactor's travel. Blending
    // rather than replacing keeps a cone shape instead of a laser line.
    let ax = Math.cos(a) + fx * prof.follow * 1.7;
    let az = Math.sin(a) + fz * prof.follow * 1.7;
    const al = Math.hypot(ax, az) || 1;
    ax /= al;
    az /= al;

    const sp = speed * (0.5 + Math.random() * 0.95);
    d.active = true;
    d.shape = prof.shapes[i % prof.shapes.length]!;
    d.x = x + ax * spread * Math.random();
    d.y = y + (Math.random() - 0.25) * spread * 0.9;
    d.z = z + az * spread * Math.random();
    d.vx = ax * sp;
    d.vz = az * sp;
    d.vy = speed * prof.up * (0.45 + Math.random() * 0.95);
    d.rx = Math.random() * TAU;
    d.ry = Math.random() * TAU;
    d.rz = Math.random() * TAU;
    d.wx = (Math.random() - 0.5) * prof.spin;
    d.wy = (Math.random() - 0.5) * prof.spin;
    d.wz = (Math.random() - 0.5) * prof.spin;
    d.scale = prof.size * (0.62 + Math.random() * 0.8);
    d.colorHex = prof.palette[(Math.random() * prof.palette.length) | 0]!;
    d.tint = 0.82 + Math.random() * 0.34;
    d.groundY = groundY;
    d.bounce = prof.bounce;
    d.drag = prof.drag;
    // Stagger lifetimes so a burst thins out instead of vanishing as a block.
    d.maxLife = prof.life * (0.75 + Math.random() * 0.5);
    d.life = d.maxLife;
    d.asleep = false;
  }
}

const HALF_PI = Math.PI * 0.5;
const snapRight = (a: number) => Math.round(a / HALF_PI) * HALF_PI;

/** Integrate the pool. Called from stepWorldProps on the fixed sim timestep. */
export function stepDebris(dt: number): void {
  if (activeCount === 0) return;

  for (let i = 0; i < DEBRIS_MAX; i++) {
    const d = pool[i]!;
    if (!d.active) continue;

    d.life -= dt;
    if (d.life <= 0) {
      d.active = false;
      activeCount -= 1;
      continue;
    }
    // Settled pieces still tick down above, but skip the integrator entirely —
    // a road littered with 60 resting chunks should cost nothing.
    if (d.asleep) continue;

    d.vy -= GRAVITY * dt;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.z += d.vz * dt;
    d.rx += d.wx * dt;
    d.ry += d.wy * dt;
    d.rz += d.wz * dt;

    const rest = d.groundY + SHAPE_HALF_H[d.shape]! * d.scale;
    if (d.y <= rest) {
      d.y = rest;
      if (d.vy < 0) d.vy = -d.vy * d.bounce;
      // Scrub slide and tumble together on contact; damping only the linear
      // term leaves chunks pirouetting on the spot forever.
      const fric = 1 - Math.min(0.95, GROUND_FRICTION * dt);
      d.vx *= fric;
      d.vz *= fric;
      d.wx *= fric;
      d.wy *= fric * 1.05;
      d.wz *= fric;

      const flat = d.vx * d.vx + d.vz * d.vz;
      if (d.vy < 0.5 && flat < 0.12) {
        // Ease onto a face rather than freezing balanced on a corner — the
        // single biggest tell that debris is a simulation and not a prop.
        const t = Math.min(1, 9 * dt);
        d.rx += (snapRight(d.rx) - d.rx) * t;
        d.rz += (snapRight(d.rz) - d.rz) * t;
        if (flat < 0.02 && Math.abs(d.vy) < 0.2) {
          d.asleep = true;
          d.rx = snapRight(d.rx);
          d.rz = snapRight(d.rz);
          d.vx = 0;
          d.vy = 0;
          d.vz = 0;
          d.wx = 0;
          d.wy = 0;
          d.wz = 0;
          d.y = rest;
        }
      }
    }

    const drag = 1 - Math.min(0.95, d.drag * dt);
    d.vx *= drag;
    d.vz *= drag;
    // Air spin bleeds slower than translation so chunks keep tumbling in flight.
    const spinDrag = 1 - Math.min(0.9, d.drag * 0.35 * dt);
    d.wx *= spinDrag;
    d.wy *= spinDrag;
    d.wz *= spinDrag;
  }
}

/**
 * Kick settled debris out of a vehicle's path. One-way by design: the car takes
 * no reaction at all, because a loose chunk nudging the handling would undo the
 * carefully-tuned prop impulse response for no visual gain.
 */
export function disturbDebris(
  x: number,
  z: number,
  vx: number,
  vz: number,
  radius: number,
): void {
  if (activeCount === 0) return;
  const speed = Math.hypot(vx, vz);
  if (speed < 3) return;
  const r2 = radius * radius;

  for (let i = 0; i < DEBRIS_MAX; i++) {
    const d = pool[i]!;
    if (!d.active) continue;
    const dx = d.x - x;
    const dz = d.z - z;
    const dist2 = dx * dx + dz * dz;
    if (dist2 > r2 || dist2 < 1e-6) continue;
    const falloff = 1 - Math.sqrt(dist2) / radius;
    const dist = Math.sqrt(dist2);
    d.asleep = false;
    // Scatter outward plus a share of the car's own travel, so chunks spray
    // ahead of the wheel rather than just puffing sideways.
    d.vx += (dx / dist) * speed * 0.22 * falloff + vx * 0.16 * falloff;
    d.vz += (dz / dist) * speed * 0.22 * falloff + vz * 0.16 * falloff;
    d.vy = Math.max(d.vy, speed * 0.14 * falloff);
    d.wx += (Math.random() - 0.5) * speed * falloff;
    d.wz += (Math.random() - 0.5) * speed * falloff;
    // Kicked-up debris gets a stay of execution so it does not wink out
    // mid-bounce right in front of the camera.
    d.life = Math.max(d.life, Math.min(d.maxLife, DEBRIS_FADE + 0.5));
  }
}

/** Read-only view for the renderer. Never mutate from the view layer. */
export function debrisPool(): readonly DebrisPiece[] {
  return pool;
}

export function debrisActiveCount(): number {
  return activeCount;
}

/** Call when a race restarts — the road is swept. */
export function resetDebris(): void {
  if (activeCount === 0) return;
  for (let i = 0; i < DEBRIS_MAX; i++) {
    pool[i]!.active = false;
    pool[i]!.life = 0;
  }
  activeCount = 0;
  cursor = 0;
}
