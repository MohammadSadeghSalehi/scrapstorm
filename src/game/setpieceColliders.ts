/**
 * Physics colliders for the built structure in `world/setpieces`.
 *
 * The set-piece system draws a 6.2m slag wall down both verges of the Foundry
 * Pit, container stacks and wreck piles on Rustline, a pipeline on trestles on
 * the Dead Mile. None of it participated in physics, so the wall that visually
 * encloses the circuit was something you drove through — which is worse than
 * not having the wall, because the eye has already been told it is solid.
 *
 * ── why this is not a `PhysProp` list ────────────────────────────────
 *
 * `sim.state.props` is BOTH the collider list and the render list: the props
 * renderer draws a barrel for every entry. Registering 74 wall modules there
 * would scatter 74 barrels along the verge on top of a wall that is already
 * being drawn by an InstancedMesh. Structure colliders are invisible by
 * definition — the set-piece layers are their visual — so they get their own
 * registry, and worldProps.ts consumes it alongside the props.
 *
 * ── why a capsule and not a circle ───────────────────────────────────
 *
 * A wall module spans ~14m between anchors. Approximating it with a circle
 * either leaves 12m gaps you drive through or bulges 7m into the road. A
 * segment inflated by a half-thickness is the exact shape of a wall module, a
 * container run, a pipeline bay and a crushed-car slab, costs one extra
 * point-to-segment projection over a circle, and degenerates to a circle for
 * free when the endpoints coincide (a stack, a pylon, a kiln).
 *
 * ── the derivation is a MIRROR, not a fork ───────────────────────────
 *
 * Anchors come from `corridorAnchors`/`fieldAnchors` — the same functions
 * build.ts calls, with the same placement objects and the same fixed seeds —
 * and linked modules are re-derived through the same `meanSpacing` /
 * `linkedRuns` pair, so the collider list is instance-for-instance the geometry
 * list. The one thing this file owns that build.ts does not is FOOTPRINT: the
 * XZ extent of each shape AT CAR HEIGHT, which is not the bounding box the
 * renderer culls with. See FOOTPRINT below.
 *
 * Deliberately imports `./world/setpieces/placement` and `presets` DIRECTLY
 * rather than the package index, because the index re-exports build.ts and
 * build.ts imports three. The sim must stay renderer-free — that is what lets
 * mission-smoke drive it headlessly.
 */
import { getActiveTrackId, getTrackEpoch } from "./track";
import { linkedRuns, meanSpacing } from "./world/scatter/placement";
import { corridorAnchors, fieldAnchors, type Anchor } from "./world/setpieces/placement";
import { DEFAULT_SETPIECES, SETPIECES } from "./world/setpieces/presets";
import type { SetpieceFamily, SetpieceShape } from "./world/setpieces/types";

/**
 * A capsule in XZ: the segment (x0,z0)-(x1,z1) inflated by `r`.
 *
 * Immovable by construction — there is no mass, no velocity and no hp. A slag
 * wall is not something you knock over, and giving it those fields would invite
 * somebody to try.
 */
export interface StaticCollider {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  r: number;
  /** Family id, for the audit path only. Never read by the solver. */
  family: string;
  /** Query stamp, so a capsule spanning four cells is returned once. */
  stamp: number;
}

/**
 * XZ footprint per shape, AT CAR HEIGHT, in the family's LOCAL space.
 *
 * This is the number that cannot be taken from `boundsOf` and cannot be taken
 * from the placement `radius` either, and both would be wrong in opposite
 * directions:
 *
 *  - `boundsOf` is a bounding SPHERE including height, so a 21m furnace stack
 *    reports ~13m and a 16m crane ~18m. Used as a collider that is an invisible
 *    wall three car-widths out from anything you can see.
 *  - the placement `radius` is the CLEARANCE half-footprint, deliberately sized
 *    to the family's largest scale and its longest reach, so it is a hull
 *    around the object rather than the object.
 *
 * So these are read off ./world/setpieces/geometry.ts by hand, taking only the
 * parts a car at y≈0.55 can actually touch. A furnace stack is an 11m plinth
 * and an 8.2m body: 5.2 half-width, not the 9.4m clearance radius and not the
 * 13m bounding sphere. Erring SMALL is the safe direction — a collider inside
 * the silhouette lets you brush a corner, a collider outside it stops you in
 * open air.
 *
 * `halfX` is the half-length along the module's own +X. Zero means a circle.
 * `null` means the shape deliberately gets no collider at all.
 */
type Footprint = { halfX: number; r: number } | null;

/**
 * Exported ONLY so scripts/check-setpiece-footprints.mjs can guard it.
 *
 * These numbers are derived by hand from world/setpieces/geometry.ts and there
 * is nothing in the type system connecting the two — retune a furnace and this
 * silently keeps the old width. The script is the tripwire for that.
 */
export const FOOTPRINT: Record<SetpieceShape, Footprint> = {
  // Linked families: halfX is unused, the segment is anchor-to-anchor.
  // Wall body is 1.5m deep (half 0.75) and its plinth 2.4m (half 1.2); 0.85
  // sits between them so the collider face is within 15cm of the face you see.
  slagWall: { halfX: 0, r: 0.85 },
  // Lower container is 2.5m deep, the sill under it 2.9m. 1.3 at the family's
  // 0.95-1.1 scale puts the face on the container, which is what reads.
  containerWall: { halfX: 0, r: 1.3 },
  // At car height a pipe run is its two 0.28m trestle legs at z = ±0.75; the
  // pipes themselves are at 2.3m. Solid anyway: a car does not pass between the
  // legs of a pipeline, and modelling the gap would only ever produce a car
  // wedged inside a trestle.
  pipeRun: { halfX: 0, r: 0.95 },

  // Point families.
  // 2m square concrete column on a 3.4m footing. Half-diagonal of the column.
  chokeGate: { halfX: 0, r: 1.45 },
  // The bottom slab is 4.6 x 2.0. A capsule of half-length 1.3 and radius 1.0
  // is that box to within a rounded corner.
  wreckStack: { halfX: 1.3, r: 1.0 },
  // 4.6m base, 1.5m mast. The 17m jib is at 16.4m and is authored on the
  // away-from-road axis, so it can never be over anything that could hit it.
  craneArm: { halfX: 0, r: 2.3 },
  // 2.4 x 1.7 rock on a 3.4 x 2.6 plinth, free yaw.
  monolith: { halfX: 0.35, r: 0.85 },
  // Vessel at x -1.6 and machine house at x +2.0, both ~3.2m across.
  pumpStation: { halfX: 1.8, r: 1.7 },
  // 11m footing, 8.2m body. Half the footing, not its diagonal.
  furnaceStack: { halfX: 0, r: 5.2 },
  // 4.4m base drum.
  kilnShell: { halfX: 0, r: 4.0 },

  /*
   * Deliberately NOT collidable.
   *
   * furnaceTap rides the furnaces' anchors (`follows`), so a collider here
   * would be a second copy of the stack's, at the same place.
   *
   * distanceMarker is a 22cm post with a sign plate — the same object as the
   * verge markers, which are already `breakable` colliders in worldProps. It
   * cannot join them: breaking a verge post calls `downEdgeAt(x, z)` so the
   * renderer stops drawing it, and that record is keyed to EDGE_MARKERS
   * positions, so a marker snapped here would hide an unrelated verge post
   * somewhere else. A stick that stops the car is worse than a stick that does
   * nothing, so it does nothing. The Dead Mile's return leg therefore has no
   * structure collision at all, which is honest: it has no structure on it.
   */
  furnaceTap: null,
  distanceMarker: null,
};

/* ── uniform grid broadphase ──────────────────────────────────────────
 *
 * 24m cells. Larger than the longest capsule (a ~14m wall module plus its
 * radius) so a module lands in at most 2x2 cells, and large enough that a car's
 * ~2m query touches 1-4 cells. Built once per circuit; queried per vehicle per
 * fixed step, which is 4 queries at 60Hz.
 *
 * A grid rather than a linear scan not because 136 capsules is expensive — it
 * is not — but because the alternative is O(vehicles x colliders) growing every
 * time a circuit gains a family, and the point of a set-piece registry is that
 * circuits are expected to gain families.
 */
const CELL = 24;

/** Exact for |cell| < 32768, i.e. ±786km of world. Circuits are ~600m. */
function cellKey(cx: number, cz: number): number {
  return (cx + 32768) * 65536 + (cz + 32768);
}

let colliders: StaticCollider[] = [];
let cells = new Map<number, StaticCollider[]>();
/** `${trackId}#${epoch}` the current list was derived for. */
let builtFor = "";
let queryStamp = 0;

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function push(
  out: StaticCollider[],
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  r: number,
  family: string,
) {
  out.push({ x0, z0, x1, z1, r, family, stamp: 0 });
}

function familyColliders(family: SetpieceFamily, out: StaticCollider[]): void {
  const fp = FOOTPRINT[family.shape];
  // No footprint, or a `follows` family that has no placement of its own.
  if (!fp || !family.placement) return;
  const p = family.placement;
  const anchors: Anchor[] =
    p.mode === "corridor" ? corridorAnchors(p) : fieldAnchors(p);
  if (!anchors.length) return;
  const [lo, hi] = p.scale;

  if (p.mode === "corridor" && p.link) {
    /*
     * Same span and same 2.4x join tolerance as build.linkedInstances, because
     * a collider run that bridges a gap the geometry does not is an invisible
     * wall across a deliberate opening. `flat < 0.4` is skipped there too.
     */
    const span = Math.max(2, meanSpacing(anchors));
    for (const run of linkedRuns(anchors, span * 2.4)) {
      for (let i = 0; i < run.length - 1; i++) {
        const a = run[i]!;
        const b = run[i + 1]!;
        if (Math.hypot(b.x - a.x, b.z - a.z) < 0.4) continue;
        push(out, a.x, a.z, b.x, b.z, fp.r * lerp(lo, hi, a.a), family.id);
      }
    }
    return;
  }

  const free = p.mode === "field" && !p.faceRoad;
  for (const an of anchors) {
    const s = lerp(lo, hi, an.a);
    const r = fp.r * s;
    if (fp.halfX <= 0) {
      push(out, an.x, an.z, an.x, an.z, r, family.id);
      continue;
    }
    /*
     * The instance's local +X in world XZ.
     *
     * build.pointInstances yaws by `atan2(an.tx, an.tz)`, and a three.js
     * rotation about +Y takes local +X to (cos y, -sin y). With that yaw,
     * sin = tx and cos = tz (the toward-road vector is unit), so local +X is
     * simply (tz, -tx) — the along-the-verge direction, which is exactly the
     * axis a 4.6m car wreck is long in. A free-yaw family (a monolith, which
     * must not square up to the road) uses its own stable variate instead.
     */
    let ax: number;
    let az: number;
    if (free) {
      const y = an.a * Math.PI * 2;
      ax = Math.cos(y);
      az = -Math.sin(y);
    } else {
      ax = an.tz;
      az = -an.tx;
    }
    const h = fp.halfX * s;
    push(out, an.x - ax * h, an.z - az * h, an.x + ax * h, an.z + az * h, r, family.id);
  }
}

/**
 * Re-derive the active circuit's structure colliders.
 *
 * Called from spawnWorldProps, so every path that builds a grid — createState,
 * setTrack, rebuildShowcase, startCountdown — gets them without a second hook.
 *
 * Cached on `${trackId}#${epoch}` and single-entry: restarting a heat on the
 * same circuit is free (the common case, and mission-smoke restarts a lot),
 * while a track change pays the placement solve once. Holding all six would
 * cost more resident memory than it saves, which is the same call track.ts
 * makes about the sample packs themselves.
 */
export function rebuildSetpieceColliders(): void {
  const key = `${getActiveTrackId()}#${getTrackEpoch()}`;
  if (key === builtFor) return;
  builtFor = key;

  const def = SETPIECES[getActiveTrackId()] ?? DEFAULT_SETPIECES;
  const out: StaticCollider[] = [];
  for (const family of def.families) familyColliders(family, out);

  colliders = out;
  cells = new Map();
  for (const c of out) {
    const minX = Math.min(c.x0, c.x1) - c.r;
    const maxX = Math.max(c.x0, c.x1) + c.r;
    const minZ = Math.min(c.z0, c.z1) - c.r;
    const maxZ = Math.max(c.z0, c.z1) + c.r;
    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
      for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
        const k = cellKey(cx, cz);
        let list = cells.get(k);
        if (!list) {
          list = [];
          cells.set(k, list);
        }
        list.push(c);
      }
    }
  }
}

/** Total capsules on the active circuit. Audit / reporting only. */
export function setpieceColliderCount(): number {
  return colliders.length;
}

/** Per-family capsule counts on the active circuit. Audit only. */
export function setpieceColliderBreakdown(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of colliders) out[c.family] = (out[c.family] ?? 0) + 1;
  return out;
}

/**
 * Capsules whose inflated footprint could reach within `reach` of (x, z).
 *
 * Returns a SHARED array — valid only until the next call. The solver processes
 * one vehicle at a time and consumes the result immediately, and the
 * alternative is an allocation per vehicle per fixed step.
 */
const scratch: StaticCollider[] = [];

export function querySetpieceColliders(
  x: number,
  z: number,
  reach: number,
): readonly StaticCollider[] {
  scratch.length = 0;
  if (colliders.length === 0) return scratch;
  queryStamp += 1;
  const cx0 = Math.floor((x - reach) / CELL);
  const cx1 = Math.floor((x + reach) / CELL);
  const cz0 = Math.floor((z - reach) / CELL);
  const cz1 = Math.floor((z + reach) / CELL);
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      const list = cells.get(cellKey(cx, cz));
      if (!list) continue;
      for (const c of list) {
        if (c.stamp === queryStamp) continue;
        c.stamp = queryStamp;
        scratch.push(c);
      }
    }
  }
  return scratch;
}

/**
 * Contact between a point-with-radius and a capsule.
 *
 * `nx, nz` points FROM the query point TOWARD the capsule axis — the same
 * convention `collideVehiclesWithProps` uses for a prop's normal, so the
 * deflection response is shared rather than mirrored.
 *
 * Reused object: one contact is resolved before the next is asked for.
 */
export interface Contact {
  hit: boolean;
  nx: number;
  nz: number;
  pen: number;
}

const contact: Contact = { hit: false, nx: 0, nz: 0, pen: 0 };

export function capsuleContact(
  c: StaticCollider,
  x: number,
  z: number,
  radius: number,
): Contact {
  const sx = c.x1 - c.x0;
  const sz = c.z1 - c.z0;
  const len2 = sx * sx + sz * sz;
  let px = c.x0;
  let pz = c.z0;
  if (len2 > 1e-8) {
    // Clamped projection: a capsule is a segment, not a line, so a car past the
    // end of a wall module must see the end cap and not an infinite wall.
    let t = ((x - c.x0) * sx + (z - c.z0) * sz) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    px = c.x0 + sx * t;
    pz = c.z0 + sz * t;
  }
  const dx = px - x;
  const dz = pz - z;
  const d2 = dx * dx + dz * dz;
  const sum = c.r + radius;
  if (d2 >= sum * sum || d2 < 1e-8) {
    contact.hit = false;
    return contact;
  }
  const d = Math.sqrt(d2);
  contact.hit = true;
  contact.nx = dx / d;
  contact.nz = dz / d;
  contact.pen = sum - d;
  return contact;
}
