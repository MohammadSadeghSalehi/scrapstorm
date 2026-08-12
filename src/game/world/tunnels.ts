/**
 * Bored sections — the circuits that go underground, as data.
 *
 * ── which circuits get one, and why not all six ───────────────────────
 *
 * A tunnel is a hole through something. `terrainProfiles.ts` says what each
 * circuit's ground IS, and only three of the six have anything to bore:
 *
 *   rustline    "mesa" — caprock plateaus with near-vertical sides standing over
 *               dry washes. A road threaded through the gaps is the circuit's
 *               stated design; a bore through the caprock instead of around it
 *               is the same idea one step further.
 *   dead_mile   "corrugation" — long parallel ridges at a fixed bearing. A haul
 *               road crossing them at an angle gets CUT through, which is what
 *               the landform is for. It goes on the RETURN leg, which the
 *               set-piece preset deliberately leaves empty ("back beside nothing
 *               but distance markers") and which therefore has no landmark of
 *               its own for 800m.
 *
 * Rejected, with reasons, so nobody re-litigates them:
 *   ash_spire   dunes, and the REFERENCE circuit. Sand does not hold a bore, and
 *               its ground is the transcription everything else is diffed
 *               against.
 *   sable_run   playa. Dead flat by design — "the only way to make a pan read as
 *               a pan is to actually make it flat". There is nothing to go
 *               through, and putting a hill there to bore would undo the one
 *               idea the circuit has.
 *   cinder_bowl crater. The circuit is raced on the FLOOR; the road never
 *               reaches the rim, so a tunnel would be a box sitting on ash.
 *   foundry_pit benches. Plausible as a slag undercroft, but the only straight
 *               long enough is the 20m choke at sample 110, which already
 *               carries a chokeGate collider and is the one place on that
 *               circuit the design wants you able to see the car beside you.
 *
 * ── why the bore FOLLOWS the samples and the rain box does not ────────
 *
 * Walls and roof are swept along the centreline, so curvature costs nothing and
 * the road cannot leave its own tunnel. The rain shader gets a straight-line
 * box instead, because a per-drop polyline walk in a vertex shader would cost
 * more than the rain does — and a box that is a metre out at the portal is a
 * metre of drizzle nobody can see against a rock face.
 *
 * ── the camera is why the roof is 8.2m and not 6 ──────────────────────
 *
 * The chase rig rides `CHASE.heightBase + heightGain` above the car, which is
 * 7.75-9.45m above the road plane before shake. A 6m tunnel would put the camera
 * inside the overburden for the whole bore. Two things fix that together: the
 * clear height is generous, and `tunnelCeiling()` gives the rig a ceiling to
 * duck under with a 14m approach ramp so the duck starts before the portal
 * rather than at it. Neither alone is enough.
 *
 * ── renderer-free ─────────────────────────────────────────────────────
 *
 * Imported by `setpieceColliders.ts`, which the headless sim loads. No `three`
 * here. The React layer builds its geometry from `getTunnels()`.
 */
import type { TrackSample } from "../types";
import type { AnyTrackId } from "../track";

export type TunnelSite = {
  /** Metres along the centreline from sample 0 to the ENTRY portal. */
  s: number;
  /** Bore length, metres. */
  length: number;
  /** Metres of clear space between the tarmac edge and the wall face. */
  margin: number;
  /** Clear height above the road plane. See the header before lowering it. */
  clearance: number;
  /** Wall thickness, for the geometry only. Nothing collides with the outside. */
  wallThick: number;
  /** Roof slab thickness, geometry only. */
  capThick: number;
};

/**
 * Portal fade, metres.
 *
 * How far inside the bore the light has fully gone. Short enough that a 40m
 * tunnel still reaches full darkness in the middle, long enough that the
 * transition is not a switch — a light level that steps on a frame boundary
 * reads as a bug, and this scene has no GI to soften it.
 */
const PORTAL_FADE = 11;

/**
 * Metres before the mouth at which the camera starts ducking.
 *
 * The chase rig trails the car by `distBase + distGain` (13.5-16.9m), so the
 * car is already well inside when the camera reaches the portal. The ramp is
 * measured at the CAMERA's own position, not the car's, and it has to be long
 * enough that the duck is finished by the time the rig is under the slab.
 *
 * 22m rather than 14: the rig chases its target on a ~0.19s time constant
 * (`lag` 5.2 in LiveCamera), so at 45 m/s a 14m ramp is 0.31s — under two time
 * constants, which lands the camera at the portal still a third of the way up.
 * 22m is 0.49s, and slower cars get proportionally more.
 */
const CEILING_APPROACH = 22;

const TUNNEL_SITES: Partial<Record<AnyTrackId, TunnelSite[]>> = {
  /*
   * Rustline, between the second and third control points — 100m in, straight
   * enough (0.32 rad over 50m), 21m of road, and on the run down to the first
   * narrow squeeze rather than on top of it. The container wall sits at
   * half + 8.9 out (offset 3.4 past a 5.5m apron) and the guard rail at
   * half + 6.5, so a bore at half + 2.4 with 1.6m walls has its OUTER face at
   * half + 4.0 and touches neither.
   */
  rustline: [
    {
      s: 100,
      length: 38,
      margin: 2.4,
      clearance: 8.2,
      wallThick: 1.6,
      capThick: 2.2,
    },
  ],
  /*
   * The Dead Mile's return leg at sample ~355, which the profile scan reports
   * at 0.027 rad over 50m — the straightest 50m in the catalogue outside the
   * Sable Mile. The pipeline stops at arc 0.46 and this is arc 0.65, so the
   * only thing out here is distance markers, which have no collider at all.
   */
  dead_mile: [
    {
      s: 1090,
      length: 46,
      margin: 2.6,
      clearance: 8.2,
      wallThick: 1.8,
      capThick: 2.6,
    },
  ],
};

/** One point on a bore's swept centreline. */
export type BorePoint = {
  x: number;
  y: number;
  z: number;
  /** Right-of-travel unit vector, for sweeping the walls. */
  rx: number;
  rz: number;
  /** Half width of the CLEAR bore at this point (tarmac half + margin). */
  hw: number;
  /** Metres from the entry portal along the bore. */
  d: number;
};

export type TunnelBore = {
  readonly id: string;
  readonly pts: BorePoint[];
  readonly length: number;
  readonly clearance: number;
  readonly wallThick: number;
  readonly capThick: number;
  /** Road plane at the entry portal — the bore is built relative to this. */
  readonly baseY: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  /** Straight-line stand-in for the rain cull. Oriented box in XZ. */
  readonly box: {
    cx: number;
    cz: number;
    fx: number;
    fz: number;
    halfLen: number;
    halfW: number;
    /** World y of the underside of the roof slab. */
    roofY: number;
    /** World y of the road plane. */
    floorY: number;
  };
};

let bores: TunnelBore[] = [];

/**
 * Resolve the active circuit's bores against its samples.
 *
 * Pushed from `track.rebuild()` for the same reason `setActiveTerrainProfile`
 * is: this module must not import `track.ts` back (AGENTS.md §4 — jiti does not
 * survive the cycle), so the track hands over what it has just built.
 */
export function setActiveTunnels(id: AnyTrackId, samples: TrackSample[]): void {
  bores = [];
  const sites = TUNNEL_SITES[id];
  if (!sites || samples.length < 8) return;
  const n = samples.length;

  for (let si = 0; si < sites.length; si++) {
    const site = sites[si]!;
    let start = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(samples[i]!.s - site.s);
      if (d < bestD) {
        bestD = d;
        start = i;
      }
    }

    const pts: BorePoint[] = [];
    let acc = 0;
    let i = start;
    /*
     * Walk forward until the bore is long enough, wrapping. `<= length` rather
     * than `< length` so the last point lands ON or past the exit portal and the
     * swept geometry closes; a bore whose last quad stops short leaves a gap you
     * can see daylight through from inside.
     */
    for (let k = 0; k < n; k++) {
      const s = samples[i]!;
      pts.push({
        x: s.x,
        y: s.y,
        z: s.z,
        rx: Math.cos(s.yaw),
        rz: -Math.sin(s.yaw),
        hw: s.width * 0.5 + site.margin,
        d: acc,
      });
      const nx = samples[(i + 1) % n]!;
      acc += Math.hypot(nx.x - s.x, nx.z - s.z);
      i = (i + 1) % n;
      if (acc > site.length) break;
    }
    if (pts.length < 3) continue;
    const length = pts[pts.length - 1]!.d;
    if (length < 8) continue;

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of pts) {
      const reach = p.hw + site.wallThick + 1;
      if (p.x - reach < minX) minX = p.x - reach;
      if (p.x + reach > maxX) maxX = p.x + reach;
      if (p.z - reach < minZ) minZ = p.z - reach;
      if (p.z + reach > maxZ) maxZ = p.z + reach;
    }

    const a = pts[0]!;
    const b = pts[pts.length - 1]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    let widest = 0;
    for (const p of pts) if (p.hw > widest) widest = p.hw;

    bores.push({
      id: `${id}-tunnel-${si}`,
      pts,
      length,
      clearance: site.clearance,
      wallThick: site.wallThick,
      capThick: site.capThick,
      baseY: a.y,
      minX,
      maxX,
      minZ,
      maxZ,
      box: {
        cx: (a.x + b.x) * 0.5,
        cz: (a.z + b.z) * 0.5,
        fx: dx / len,
        fz: dz / len,
        halfLen: len * 0.5,
        // A curved bore's straight box has to be wide enough to still contain
        // the road at the bulge, or rain falls through the middle of it.
        halfW: widest + (length - len) * 0.5 + 1.5,
        roofY: a.y + site.clearance,
        floorY: a.y,
      },
    });
  }
}

export function getTunnels(): readonly TunnelBore[] {
  return bores;
}

/** Whether the active circuit has any bore at all. One integer compare. */
export function hasTunnels(): boolean {
  return bores.length > 0;
}

/**
 * Nearest point on a bore's centreline, as (lateral distance, distance along).
 *
 * Written out rather than reusing `track.nearestTrackIndex` because that would
 * be the import cycle this module exists on the other side of — and because a
 * bore is a dozen points, so an exact point-to-segment walk is cheaper than a
 * coarse-then-refine search over three hundred.
 *
 * `along` is signed and unclamped: negative means "not there yet", which is what
 * `tunnelCeiling` needs for its approach ramp.
 */
function projectOnBore(
  t: TunnelBore,
  x: number,
  z: number,
): { lat: number; along: number } {
  let bestLat = Infinity;
  let bestAlong = 0;
  for (let i = 0; i < t.pts.length - 1; i++) {
    const a = t.pts[i]!;
    const b = t.pts[i + 1]!;
    const sx = b.x - a.x;
    const sz = b.z - a.z;
    const len2 = sx * sx + sz * sz;
    if (len2 < 1e-6) continue;
    let u = ((x - a.x) * sx + (z - a.z) * sz) / len2;
    // The FIRST and LAST segments extend past their ends, so a point short of
    // the entry portal still gets a negative `along` instead of being snapped
    // to zero. Everything between clamps normally.
    if (i > 0 && u < 0) u = 0;
    if (i < t.pts.length - 2 && u > 1) u = 1;
    const px = a.x + sx * u;
    const pz = a.z + sz * u;
    const lat = Math.hypot(x - px, z - pz);
    if (lat < bestLat) {
      bestLat = lat;
      bestAlong = a.d + (b.d - a.d) * u;
    }
  }
  return { lat: bestLat, along: bestAlong };
}

function smoothstep01(t: number): number {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return u * u * (3 - 2 * u);
}

/**
 * How enclosed a world point is: 0 in the open, 1 under the middle of a bore.
 *
 * Drives the light knock-down and the rain cull. Deliberately a scalar rather
 * than a boolean — a step in scene brightness on the frame the car crosses a
 * portal reads as a rendering fault, and there is no GI here to hide it.
 */
export function tunnelCover(x: number, z: number): number {
  let best = 0;
  for (let i = 0; i < bores.length; i++) {
    const t = bores[i]!;
    if (x < t.minX || x > t.maxX || z < t.minZ || z > t.maxZ) continue;
    const { lat, along } = projectOnBore(t, x, z);
    if (along < 0 || along > t.length) continue;
    // Lateral falloff too: standing outside the wall line, in the cutting
    // beside the portal, is not the same as being inside.
    const widthAt = t.pts[0]!.hw + 1.5;
    if (lat > widthAt) continue;
    const ends = Math.min(along, t.length - along);
    const c = smoothstep01(ends / PORTAL_FADE) * (1 - smoothstep01((lat - widthAt * 0.7) / (widthAt * 0.5)));
    if (c > best) best = c;
  }
  return best;
}

/**
 * World y a following camera must stay under at this point, or `Infinity`.
 *
 * Ramps in over `CEILING_APPROACH` metres BEFORE the portal so the rig is
 * already low when it arrives. Without the ramp the duck happens on the frame
 * the camera crosses the mouth, which is a 2m vertical jerk at 40 m/s.
 */
export function tunnelCeiling(x: number, z: number): number {
  let cap = Infinity;
  for (let i = 0; i < bores.length; i++) {
    const t = bores[i]!;
    if (
      x < t.minX - CEILING_APPROACH ||
      x > t.maxX + CEILING_APPROACH ||
      z < t.minZ - CEILING_APPROACH ||
      z > t.maxZ + CEILING_APPROACH
    ) {
      continue;
    }
    const { lat, along } = projectOnBore(t, x, z);
    if (lat > t.pts[0]!.hw + t.wallThick + 2) continue;
    if (along > t.length + CEILING_APPROACH) continue;
    // 1.1m of headroom under the slab: more than the 0.35 near plane by enough
    // that shake cannot push the near plane through the concrete.
    const inside = t.baseY + t.clearance - 1.1;
    if (along >= 0) {
      if (inside < cap) cap = inside;
      continue;
    }
    const k = smoothstep01((along + CEILING_APPROACH) / CEILING_APPROACH);
    if (k <= 0) continue;
    // Blend from "no limit" toward the slab. Expressed as a height ABOVE the
    // ceiling that shrinks to zero, so the approach is smooth in world units
    // rather than in a ratio nobody can picture.
    const v = inside + (1 - k) * 40;
    if (v < cap) cap = v;
  }
  return cap;
}

/** A wall run for the collider registry. Full height — a tunnel wall is a wall. */
export type TunnelCapsule = {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  r: number;
  y: number;
};

/** Half the wall's collidable face. Faces sit `r` inside the drawn surface. */
const WALL_R = 0.55;

export function tunnelCapsules(): TunnelCapsule[] {
  const out: TunnelCapsule[] = [];
  for (const t of bores) {
    for (let i = 0; i < t.pts.length - 1; i++) {
      const a = t.pts[i]!;
      const b = t.pts[i + 1]!;
      for (const side of [-1, 1] as const) {
        const ax = a.x + a.rx * side * (a.hw + WALL_R);
        const az = a.z + a.rz * side * (a.hw + WALL_R);
        const bx = b.x + b.rx * side * (b.hw + WALL_R);
        const bz = b.z + b.rz * side * (b.hw + WALL_R);
        if (Math.hypot(bx - ax, bz - az) < 0.4) continue;
        out.push({ x0: ax, z0: az, x1: bx, z1: bz, r: WALL_R, y: a.y });
      }
    }
  }
  return out;
}
