/**
 * Persistent landscape damage — craters, scorch, gouges, oil, impact marks.
 *
 * ADDITIVE OVERLAY ONLY. The terrain is a heightmap built by HeightmapTerrain
 * from `duneProfile`, and nothing in here touches it: craters are separate
 * patch meshes laid ON the sampled surface, everything else is a decal. That is
 * a hard constraint (the terrain module is owned elsewhere) but it is also the
 * right call — re-tessellating a 900m heightmap because a mine went off would
 * cost more than the whole rest of this subsystem put together.
 *
 * The correctness rule that has bitten this project repeatedly: EVERY y in here
 * comes from `getGroundHeight(x, z)`. Not a literal, and not a track sample's
 * `y` — that is the ROAD plane, and the desert climbs many metres above it once
 * you are off the tarmac, which is exactly where most explosions happen.
 *
 * COST: two draw calls total (one instanced decal mesh, one merged crater
 * patch mesh). See LandscapeDamage.tsx for the triangle budget.
 */
import { getGroundHeight, getSurfaceAt } from "../../track";
import { hash01 } from "../vfx/rng";

export const DECAL_MAX = 56;
export const CRATER_MAX = 14;

export const DECAL_KIND = {
  /** Burnt ground under a blast — wide, black, soft. */
  SCORCH: 0,
  /** Churned soil where a car ploughed off-road — long and narrow. */
  GOUGE: 1,
  /** Spilled fluid — small, very dark, sharper edge. */
  OIL: 2,
  /** Bullet/shell strike — small, dark centre. */
  IMPACT: 3,
} as const;
export type DecalKind = (typeof DECAL_KIND)[keyof typeof DECAL_KIND];

export interface GroundDecal {
  active: boolean;
  x: number;
  y: number;
  z: number;
  /** Terrain normal at the decal centre, so it lies flat on a dune face. */
  nx: number;
  ny: number;
  nz: number;
  /** Half-extents in metres, along and across the decal's own axis. */
  along: number;
  across: number;
  /** Rotation about the terrain normal. */
  rot: number;
  kind: DecalKind;
  r: number;
  g: number;
  b: number;
  alpha: number;
  /** Seconds since placement — used only for the brief settle-in fade. */
  age: number;
  /** Monotonic placement order; lowest is recycled first when saturated. */
  stamp: number;
}

export interface Crater {
  active: boolean;
  x: number;
  z: number;
  radius: number;
  depth: number;
  seed: number;
  stamp: number;
}

function makeDecal(): GroundDecal {
  return {
    active: false,
    x: 0,
    y: 0,
    z: 0,
    nx: 0,
    ny: 1,
    nz: 0,
    along: 1,
    across: 1,
    rot: 0,
    kind: DECAL_KIND.SCORCH,
    r: 0.1,
    g: 0.09,
    b: 0.08,
    alpha: 0.7,
    age: 0,
    stamp: 0,
  };
}

const decals: GroundDecal[] = Array.from({ length: DECAL_MAX }, makeDecal);
const craterList: Crater[] = Array.from({ length: CRATER_MAX }, () => ({
  active: false,
  x: 0,
  z: 0,
  radius: 2,
  depth: 0.4,
  seed: 1,
  stamp: 0,
}));

let decalLive = 0;
let craterLive = 0;
let stampCursor = 0;
let decalVersion = 0;
let craterVersion = 0;

/**
 * Metres a decal floats above the sampled ground.
 *
 * Small on purpose. The road ribbon is drawn at `sample.y + 0.02` and BANKS by
 * up to +-0.45m at its edges (roadSegments.pushQuad), so a decal on the outside
 * of a banked corner can be genuinely below the tarmac and get depth-tested
 * away. Compensating for that symmetrically would float every decal on the
 * inside of the same corner by the same amount, and a decal hovering half a
 * metre in the air reads far worse than one that is occasionally missing. So:
 * hug the sampled surface, use polygonOffset for the co-planar case, and accept
 * the banked-edge miss.
 */
export const DECAL_LIFT = 0.055;

/**
 * Terrain normal by central difference.
 *
 * `getGroundHeight` runs a nearest-sample search, so this is 4 extra searches —
 * which is why it happens once at placement and never per frame. The 1.6m
 * epsilon is deliberately coarse: a decal should follow the dune, not the
 * high-frequency noise on top of it, and a tight epsilon on a noisy field
 * produces normals that flap between neighbouring decals.
 */
function terrainNormal(x: number, z: number, out: { x: number; y: number; z: number }) {
  const e = 1.6;
  const hx = getGroundHeight(x + e, z) - getGroundHeight(x - e, z);
  const hz = getGroundHeight(x, z + e) - getGroundHeight(x, z - e);
  const nx = -hx;
  const nz = -hz;
  const ny = 2 * e;
  const len = Math.hypot(nx, ny, nz) || 1;
  out.x = nx / len;
  out.y = ny / len;
  out.z = nz / len;
}

const normalScratch = { x: 0, y: 1, z: 0 };

function acquireDecal(): GroundDecal {
  for (let i = 0; i < DECAL_MAX; i++) {
    const d = decals[i]!;
    if (!d.active) {
      d.active = true;
      decalLive += 1;
      return d;
    }
  }
  // Saturated: oldest goes. Landscape damage is a record of the race, so the
  // right thing to lose is the mark from three corners ago, not the one that
  // was just made under the player's wheels.
  let oldest = decals[0]!;
  for (let i = 1; i < DECAL_MAX; i++) {
    if (decals[i]!.stamp < oldest.stamp) oldest = decals[i]!;
  }
  return oldest;
}

export interface DecalOptions {
  kind: DecalKind;
  /** Half-length along the decal's own axis, metres. */
  along: number;
  /** Half-width across it. Defaults to `along` (round). */
  across?: number;
  /** Yaw about the terrain normal. */
  rot?: number;
  r?: number;
  g?: number;
  b?: number;
  alpha?: number;
}

/**
 * Place a persistent ground mark. `y` and the surface normal are sampled here,
 * once — callers pass XZ only precisely so that no caller can accidentally
 * supply a road-plane y.
 */
export function addGroundDecal(x: number, z: number, opts: DecalOptions): void {
  const d = acquireDecal();
  terrainNormal(x, z, normalScratch);
  d.x = x;
  d.y = getGroundHeight(x, z) + DECAL_LIFT;
  d.z = z;
  d.nx = normalScratch.x;
  d.ny = normalScratch.y;
  d.nz = normalScratch.z;
  d.along = opts.along;
  d.across = opts.across ?? opts.along;
  d.rot = opts.rot ?? 0;
  d.kind = opts.kind;
  d.r = opts.r ?? 0.09;
  d.g = opts.g ?? 0.08;
  d.b = opts.b ?? 0.07;
  d.alpha = opts.alpha ?? 0.75;
  d.age = 0;
  d.stamp = ++stampCursor;
  decalVersion += 1;
}

/**
 * Excavate a crater.
 *
 * Refused on tarmac by design. A crater is real geometry pushed BELOW the
 * sampled surface, and the road ribbon is drawn as a separate banked mesh on
 * top of that surface — so a crater in the road would either be buried or
 * would z-fight along its whole rim. Blasts on asphalt get a scorch decal
 * instead, which is also closer to the truth: you do not crater a road with a
 * proximity mine, you burn it.
 *
 * Returns whether a crater was actually placed, so the caller can fall back.
 */
export function addCrater(
  x: number,
  z: number,
  radius: number,
  depth: number,
  seed: number,
): boolean {
  const surf = getSurfaceAt(x, z);
  if (surf.kind === "asphalt" || surf.dist < surf.half + 1.5) return false;

  let slot: Crater | null = null;
  for (let i = 0; i < CRATER_MAX; i++) {
    const c = craterList[i]!;
    if (!c.active) {
      slot = c;
      c.active = true;
      craterLive += 1;
      break;
    }
    // Overlapping blasts merge instead of stacking two rims into each other.
    const dx = c.x - x;
    const dz = c.z - z;
    if (dx * dx + dz * dz < radius * radius * 0.36) {
      c.radius = Math.max(c.radius, radius);
      c.depth = Math.min(1.4, c.depth + depth * 0.45);
      c.stamp = ++stampCursor;
      craterVersion += 1;
      return true;
    }
  }
  if (!slot) {
    let oldest = craterList[0]!;
    for (let i = 1; i < CRATER_MAX; i++) {
      if (craterList[i]!.stamp < oldest.stamp) oldest = craterList[i]!;
    }
    slot = oldest;
  }
  slot.x = x;
  slot.z = z;
  slot.radius = radius;
  slot.depth = depth;
  slot.seed = seed;
  slot.stamp = ++stampCursor;
  craterVersion += 1;
  return true;
}

/** Ages decals. Cheap enough to run every frame; nothing here is removed by age. */
export function stepLandscapeDamage(dt: number): void {
  if (decalLive === 0) return;
  for (let i = 0; i < DECAL_MAX; i++) {
    const d = decals[i]!;
    if (d.active && d.age < 4) d.age += dt;
  }
}

export function landscapeDecals(): readonly GroundDecal[] {
  return decals;
}
export function landscapeCraters(): readonly Crater[] {
  return craterList;
}
export function landscapeDecalLive(): number {
  return decalLive;
}
export function landscapeCraterLive(): number {
  return craterLive;
}
/** Bumped on every placement so the renderer can skip rebuilding when idle. */
export function landscapeDecalVersion(): number {
  return decalVersion;
}
export function landscapeCraterVersion(): number {
  return craterVersion;
}

export function resetLandscapeDamage(): void {
  for (let i = 0; i < DECAL_MAX; i++) decals[i]!.active = false;
  for (let i = 0; i < CRATER_MAX; i++) craterList[i]!.active = false;
  decalLive = 0;
  craterLive = 0;
  stampCursor = 0;
  decalVersion += 1;
  craterVersion += 1;
}

/* --------------------------------------------------- convenience presets */

/** Burnt ground under a blast. Seeded aspect + rotation so no two match. */
export function addScorch(x: number, z: number, radius: number, seed: number): void {
  const a = hash01(seed);
  const b = hash01(seed ^ 0x9e37);
  const c = hash01(seed ^ 0x51ed);
  addGroundDecal(x, z, {
    kind: DECAL_KIND.SCORCH,
    along: radius * (0.85 + a * 0.5),
    across: radius * (0.72 + b * 0.55),
    rot: c * Math.PI * 2,
    // Scorch is not black — it is a warm charcoal over sand, and pure black
    // reads as a hole in the terrain rather than a burn on it.
    r: 0.1 + a * 0.05,
    g: 0.085 + a * 0.04,
    b: 0.075 + a * 0.03,
    alpha: 0.5 + b * 0.28,
  });
}

/** Churned soil where a car ploughed. `rot` is the direction of travel. */
export function addGouge(
  x: number,
  z: number,
  length: number,
  width: number,
  rot: number,
  seed: number,
): void {
  const a = hash01(seed);
  addGroundDecal(x, z, {
    kind: DECAL_KIND.GOUGE,
    along: length * (0.8 + a * 0.45),
    across: width * (0.85 + hash01(seed ^ 0x2f1) * 0.4),
    rot,
    // Turned-over sand is DARKER and slightly redder than the surface: the dry
    // top layer is what is pale, and a gouge exposes what is under it.
    r: 0.34 + a * 0.08,
    g: 0.26 + a * 0.06,
    b: 0.17 + a * 0.04,
    alpha: 0.42 + a * 0.22,
  });
}

export function addOilStain(x: number, z: number, radius: number, seed: number): void {
  const a = hash01(seed);
  addGroundDecal(x, z, {
    kind: DECAL_KIND.OIL,
    along: radius * (0.8 + a * 0.6),
    across: radius * (0.7 + hash01(seed ^ 0x77) * 0.6),
    rot: hash01(seed ^ 0x1234) * Math.PI * 2,
    r: 0.055,
    g: 0.05,
    b: 0.048,
    alpha: 0.62 + a * 0.25,
  });
}

export function addImpactMark(x: number, z: number, radius: number, seed: number): void {
  const a = hash01(seed);
  addGroundDecal(x, z, {
    kind: DECAL_KIND.IMPACT,
    along: radius * (0.75 + a * 0.5),
    across: radius * (0.75 + hash01(seed ^ 0x5a) * 0.5),
    rot: a * Math.PI * 2,
    r: 0.14,
    g: 0.12,
    b: 0.1,
    alpha: 0.45 + a * 0.3,
  });
}
