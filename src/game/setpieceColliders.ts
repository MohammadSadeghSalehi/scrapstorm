/**
 * Physics colliders for the built structure in `world/setpieces`, and for the
 * roadside furniture in `world/scatter`.
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
 * ── the guard rail is here for a different reason ────────────────────
 *
 * Set pieces are immovable and their collider list is a mirror of the render
 * list. The guard rail and the sponsor hoardings are neither: they break, and
 * a broken one has to stop being drawn. That makes INDEX AGREEMENT between the
 * two lists load-bearing rather than merely tidy, so unlike the set pieces they
 * are not mirrored — both sides read one shared list, `roadsideLayout()`.
 *
 * They land in this registry rather than `sim.state.props` for the same reason
 * the walls do (a prop is drawn as a barrel, and there are ~200 of these), and
 * because a rail run is a polyline: a circle collider on a 4m beam span either
 * leaves gaps you drive through or bulges into the road.
 *
 * Deliberately imports `./world/setpieces/placement` and `presets` DIRECTLY
 * rather than the package index, because the index re-exports build.ts and
 * build.ts imports three. Same for `world/scatter/roadsideLayout`, whose package
 * index pulls in the React components. The sim must stay renderer-free — that
 * is what lets mission-smoke drive it headlessly.
 */
import { getActiveTrackId, getTrackEpoch } from "./track";
import { carrierCapsules } from "./world/carrier";
import { spawnDebrisBurst } from "./world/debris";
import { tunnelCapsules } from "./world/tunnels";
import { linkedRuns, meanSpacing } from "./world/scatter/placement";
import {
  downBoard,
  downLamp,
  downRailModule,
  resetRoadsideDamage,
} from "./world/scatter/roadsideDamage";
import {
  BOARD_CAPSULE_R,
  BOARD_HALF_X,
  LAMP_CAPSULE_R,
  RAIL_CAPSULE_R,
  roadsideLayout,
} from "./world/scatter/roadsideLayout";
import { corridorAnchors, fieldAnchors, type Anchor } from "./world/setpieces/placement";
import { DEFAULT_SETPIECES, SETPIECES } from "./world/setpieces/presets";
import type { SetpieceFamily, SetpieceShape } from "./world/setpieces/types";

/**
 * A capsule in XZ: the segment (x0,z0)-(x1,z1) inflated by `r`.
 *
 * Immovable while it stands — there is no mass and no velocity. A slag wall is
 * not something you knock over, and giving it those fields would invite
 * somebody to try. The only state a capsule has is whether it is still there,
 * and that is reserved for the two roadside families: `breakAt` is 0 on every
 * set piece, which is what stops a 9 m/s nudge deleting a crane.
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
  /**
   * Closing speed along the contact normal, in m/s, above which this module
   * fails. 0 means it never does.
   */
  breakAt: number;
  /** Index into the matching `roadsideLayout()` list. -1 for set pieces. */
  module: number;
  /**
   * Linked-run id for rail, so a failure cannot cascade into a different
   * stretch of rail that happens to pass close by where the circuit doubles
   * back. -1 for anything that fails alone.
   */
  run: number;
  /**
   * Whether the module still resists for the single frame it fails on.
   *
   * Armco does. It is a structure, and the frame of resistance IS the price of
   * demolishing it — measured at 32% of your speed on a 30-degree excursion and
   * 92% on a square hit, all of it out of the shared deflection routine.
   *
   * A sponsor hoarding does not. It is plywood on scaffold, and charging a car
   * 92% of its speed for one would be the same complaint this pass exists to
   * answer, only inverted: a thing that is obviously not solid behaving like a
   * wall. It goes straight through, and the burst is the feedback.
   */
  resistOnBreak: boolean;
  /** Ground height, for the debris burst. Unused unless `breakAt` > 0. */
  y: number;
  destroyed: boolean;
  /**
   * World height above which this capsule is NOT solid. Absent = solid always.
   *
   * The only vertical information in a system that is otherwise pure XZ, and it
   * exists for exactly one situation: structure a car can be ON TOP OF. The car
   * carrier's trailer flank has to stop a car at road level and be transparent
   * to the same car four metres up on its own deck, and those are the same
   * capsule in plan view. Without this the deck would be unusable — every car
   * that drove up the ramp would be deflected by the sides of the truck it was
   * standing on.
   *
   * Deliberately a CEILING and not a band: everything else in this registry is
   * solid from the ground up, and "solid below y" is the whole of what a
   * drivable roof needs. A general min/max band invites somebody to model a
   * bridge soffit with it, which would then be a wall to anything airborne.
   */
  yTop?: number;
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
  out.push({
    x0,
    z0,
    x1,
    z1,
    r,
    family,
    stamp: 0,
    breakAt: 0,
    module: -1,
    run: -1,
    resistOnBreak: true,
    y: 0,
    destroyed: false,
  });
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

/* ── roadside furniture ───────────────────────────────────────────────
 *
 * WHAT BREAKS, AND WHY THESE NUMBERS.
 *
 * The verge marker posts already break, at 2.5 m/s, and their tuning is the
 * argument for these: worldProps' own note records that 9 m/s "meant a 4-inch
 * stick held firm up to 32 km/h and deflected the car — it read as a bollard."
 * That was the wrong reading for a stick. It is exactly the right one for a
 * guard rail, which is a structure whose entire job is to hold a car that is
 * leaving the road and point it back down the circuit. So the rail takes the
 * number the post rejected.
 *
 * The threshold is on the NORMAL component, not on speed, which is what makes
 * it behave like Armco rather than like a wall: arriving at 25 m/s with 15
 * degrees of incidence is 6.5 m/s into the rail and it holds and redirects you;
 * the same 25 m/s at 30 degrees is 12.5 m/s and the section goes.
 *
 * A hoarding takes the verge post's number instead, and for the verge post's
 * reason: 2.5 m/s is walking pace, so in practice it always goes. The band
 * below it exists only so a car creeping into a board cannot slide through an
 * intact one unnoticed.
 */
const RAIL_BREAK_SPEED = 9;
const BOARD_BREAK_SPEED = 2.5;
/**
 * Lamp columns, and why they are the ONE thing here that shears without
 * resisting.
 *
 * A highway lighting column is not incidentally frangible, it is REQUIRED to be:
 * the whole point of a shear coupling at the base is that the column separates
 * and passes over the car instead of stopping it, because a rigid 8m mast is
 * lethal. That is a design property of the real object, so `resistOnBreak` is
 * false — the same setting the hoardings get, for a related reason. Charging a
 * car the rail's 92% of its speed for a post engineered to come off its base
 * would be the identical complaint this pass answers, only inverted.
 *
 * 4 m/s, not the hoarding's 2.5: a steel column is not plywood, and the band
 * below the threshold is what stops a car creeping through an intact one. And
 * unlike the rail there is no cascade — the columns stand 30m apart, and the
 * catenary between two of them going down when one does is a RENDERER concern
 * (see RoadsideLighting), not a second collider failing.
 */
const LAMP_BREAK_SPEED = 4;

/**
 * Metres of rail either side of the impact that fail with it.
 *
 * NOT cosmetic. A car is tested against these capsules as a circle of its
 * largest projected half-extent — 1.4m for a Trickster, 2.1m for a Bruiser at
 * 45 degrees — so a hole narrower than about 4.4m is one the car cannot fit
 * through, and it would be stopped dead by the stubs either side of the gap it
 * had just made. A rail that breaks into an opening you cannot use is worse
 * than one that never breaks, because it costs the speed AND keeps the wall.
 *
 * Measured from the CONTACT POINT rather than from the module, so where along
 * its span you hit decides how much goes: 4m picks up one or two neighbours at
 * every circuit's anchor spacing (3.5-4.3m), which is 7-13m of rail down and
 * comfortably clear of the 4.4m the car needs.
 */
const RAIL_BREAK_SPAN = 4;

/**
 * Rail capsules in `roadsideLayout().rail` order.
 *
 * Kept as its own array purely so the failure cascade can walk neighbours by
 * index instead of searching the grid for them. Entries alias the objects in
 * `colliders`; nothing here owns them.
 */
let railColliders: StaticCollider[] = [];

function roadsideColliders(out: StaticCollider[]): void {
  const layout = roadsideLayout();
  railColliders = [];

  for (let i = 0; i < layout.rail.length; i++) {
    const m = layout.rail[i]!;
    const c: StaticCollider = {
      x0: m.ax,
      z0: m.az,
      x1: m.bx,
      z1: m.bz,
      r: RAIL_CAPSULE_R,
      family: "guardRail",
      stamp: 0,
      breakAt: RAIL_BREAK_SPEED,
      module: i,
      run: m.run,
      resistOnBreak: true,
      // The post foot, so debris bounces on the verge rather than on the road
      // height the anchor was measured from.
      y: m.ay,
      destroyed: false,
    };
    railColliders.push(c);
    out.push(c);
  }

  for (let i = 0; i < layout.boards.length; i++) {
    const b = layout.boards[i]!;
    out.push({
      x0: b.x - b.ax * BOARD_HALF_X,
      z0: b.z - b.az * BOARD_HALF_X,
      x1: b.x + b.ax * BOARD_HALF_X,
      z1: b.z + b.az * BOARD_HALF_X,
      r: BOARD_CAPSULE_R,
      family: "hoarding",
      stamp: 0,
      breakAt: BOARD_BREAK_SPEED,
      module: i,
      // Hoardings stand 22m apart; there is no run to cascade along.
      run: -1,
      resistOnBreak: false,
      y: b.y,
      destroyed: false,
    });
  }

  /*
   * Lamp columns. A circle, which a capsule expresses as a zero-length segment.
   *
   * The renderer thins these by DRAW RANGE and never by density, and that is
   * what makes it safe for them to be solid on a tier that barely draws them:
   * a density prefix would leave the back of the list invisible and collidable
   * — the invisible wall BOARD_DENSITY's note is about — whereas a range cut
   * can only ever hide something further away than the car, and anything close
   * enough to hit is by definition close enough to draw.
   */
  for (let i = 0; i < layout.lamps.length; i++) {
    const l = layout.lamps[i]!;
    out.push({
      x0: l.x,
      z0: l.z,
      x1: l.x,
      z1: l.z,
      r: LAMP_CAPSULE_R,
      family: "lampPost",
      stamp: 0,
      breakAt: LAMP_BREAK_SPEED,
      module: i,
      run: -1,
      resistOnBreak: false,
      y: l.y,
      destroyed: false,
    });
  }
}

/* ── one-off structure ────────────────────────────────────────────────
 *
 * The tunnel bores and the car carrier are not families: there is one of each on
 * the circuits that have them, they are placed by hand at an arc length rather
 * than solved onto the verge, and neither has anything to say about the
 * FOOTPRINT table (a bore's collidable width IS its drawn width, and a carrier's
 * is a height field, not a silhouette). They mirror their own modules the way
 * the set pieces mirror `build.ts` — `world/tunnels.ts` and `world/carrier.ts`
 * are the single source for both the geometry and these capsules, so the wall
 * you see and the wall you hit cannot be two different walls.
 *
 * Both modules are renderer-free by construction, which is what lets this stay
 * importable by the headless sim.
 */
function bespokeColliders(out: StaticCollider[]): void {
  for (const t of tunnelCapsules()) {
    out.push({
      x0: t.x0,
      z0: t.z0,
      x1: t.x1,
      z1: t.z1,
      r: t.r,
      family: "tunnelWall",
      stamp: 0,
      breakAt: 0,
      module: -1,
      run: -1,
      resistOnBreak: true,
      y: t.y,
      destroyed: false,
    });
  }
  for (const c of carrierCapsules()) {
    out.push({
      x0: c.x0,
      z0: c.z0,
      x1: c.x1,
      z1: c.z1,
      r: c.r,
      family: "carrier",
      stamp: 0,
      breakAt: 0,
      module: -1,
      run: -1,
      resistOnBreak: true,
      y: c.y,
      destroyed: false,
      yTop: c.yTop,
    });
  }
}

/**
 * Take a module out of the world.
 *
 * Two records, and both are needed: `destroyed` is what the solver reads, and
 * the damage registry is what the InstancedMesh reads. Neither can be derived
 * from the other — the collider list is rebuilt per circuit and the renderer's
 * is rebuilt per epoch, and they are not the same lifetime.
 */
function fell(c: StaticCollider): void {
  if (c.destroyed) return;
  c.destroyed = true;
  if (c.family === "guardRail") downRailModule(c.module);
  else if (c.family === "lampPost") downLamp(c.module);
  else downBoard(c.module);
}

/**
 * Fail a module and, for rail, the section around it.
 *
 * Returns the radius of the hole, for sizing the debris burst.
 */
function breakRoadside(c: StaticCollider, hitX: number, hitZ: number): number {
  fell(c);
  if (c.family !== "guardRail" || c.module < 0) return 2.2;

  let reach = c.r;
  // Walk outward along the run in both directions. Stops at the first module
  // out of span rather than scanning the whole run: railColliders is in layout
  // order, so the walk is monotonically further away.
  for (const dir of [-1, 1]) {
    for (let k = c.module + dir; k >= 0 && k < railColliders.length; k += dir) {
      const n = railColliders[k]!;
      if (n.run !== c.run) break;
      const mx = (n.x0 + n.x1) * 0.5;
      const mz = (n.z0 + n.z1) * 0.5;
      const d = Math.hypot(mx - hitX, mz - hitZ);
      if (d > RAIL_BREAK_SPAN) break;
      fell(n);
      if (d > reach) reach = d;
    }
  }
  return reach + 1.5;
}

/* ── closing speed, and why it is measured rather than passed in ──────
 *
 * A module cannot decide whether it failed without knowing how fast the thing
 * that hit it was going, and this file is never handed that. The contract with
 * worldProps is `capsuleContact(collider, x, z, radius)` — a point, no vehicle,
 * no velocity. The natural fix is a hook over there, which is how the debris
 * pool gets the car's travel (`disturbDebris(x, z, vx, vz, r)`), and that is
 * still the right long-term shape. It is not taken here because worldProps is
 * being edited elsewhere and a second author in that file is how the barrier
 * impulse got reintroduced last time.
 *
 * What is available turns out to be the real number rather than a model of it.
 * `querySetpieceColliders` is called exactly once per vehicle per fixed step
 * with that vehicle's position, and position is what the integrator produces —
 * so the displacement of a query point between two steps IS its velocity over
 * that step, including every collision the solver already resolved.
 *
 * Identity across steps is by nearest previous probe, which is sound rather
 * than lucky: vehicle-vehicle collision never lets two car centres closer than
 * ~2.7m (physics.ts, `ra + rb` at 0.88), while a car at 45 m/s covers 0.75m in
 * a step. A probe is therefore always far nearer its own last position than any
 * other car's. Anything beyond MATCH_R is a new probe with no velocity — which
 * is also what a respawn teleport looks like, and a teleport must never be able
 * to demolish a rail.
 *
 * Both failure modes point the safe way. A mis-association implies a jump of at
 * least the car-to-car separation, which is larger than MAX_STEP, so it yields
 * ZERO velocity rather than an invented one: the worst it can do is fail to
 * break a rail for one frame. Nothing here can break a rail that was not hit.
 */
type Probe = { x: number; z: number; vx: number; vz: number; seen: number };

/** Four racers plus headroom for showcase/replay cameras that also query. */
const PROBE_MAX = 8;
const MATCH_R2 = 1.2 * 1.2;
/** sim.ts FIXED_DT. Collision only ever runs on that clock. */
const STEP_RATE = 60;
/** 45 m/s in one step. Beyond this the delta is a teleport, not motion. */
const MAX_STEP2 = 0.75 * 0.75;

const probes: Probe[] = [];
let probeClock = 0;
/** The probe the last `querySetpieceColliders` call belonged to. */
let liveProbe: Probe | null = null;

function trackProbe(x: number, z: number): Probe {
  probeClock += 1;
  let best: Probe | null = null;
  let bestD2 = MATCH_R2;
  let stalest: Probe | null = null;
  for (const p of probes) {
    const dx = p.x - x;
    const dz = p.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = p;
    }
    if (!stalest || p.seen < stalest.seen) stalest = p;
  }

  if (best) {
    const dx = x - best.x;
    const dz = z - best.z;
    if (dx * dx + dz * dz > MAX_STEP2) {
      best.vx = 0;
      best.vz = 0;
    } else {
      best.vx = dx * STEP_RATE;
      best.vz = dz * STEP_RATE;
    }
    best.x = x;
    best.z = z;
    best.seen = probeClock;
    return best;
  }

  const p =
    probes.length < PROBE_MAX
      ? { x, z, vx: 0, vz: 0, seen: probeClock }
      : stalest!;
  if (probes.length < PROBE_MAX) probes.push(p);
  p.x = x;
  p.z = z;
  p.vx = 0;
  p.vz = 0;
  p.seen = probeClock;
  return p;
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
  /*
   * Damage is cleared BEFORE the cache check, not after it.
   *
   * Restarting a heat on the same circuit is the common case and takes the
   * early-out below, but it is also exactly the case where the rail has to be
   * standing again. Every path that builds a grid reaches here (spawnWorldProps
   * calls it unconditionally, right beside resetEdgeDamage), so this is the
   * same reset semantics the verge posts get, for free and without a second
   * hook in worldProps.
   */
  resetRoadsideDamage();
  for (const c of colliders) c.destroyed = false;

  const key = `${getActiveTrackId()}#${getTrackEpoch()}`;
  if (key === builtFor) return;
  builtFor = key;

  const def = SETPIECES[getActiveTrackId()] ?? DEFAULT_SETPIECES;
  const out: StaticCollider[] = [];
  for (const family of def.families) familyColliders(family, out);
  roadsideColliders(out);
  bespokeColliders(out);

  colliders = out.concat(rockColliders);
  reindex();
}

/*
 * Boulders, registered from the RENDER side.
 *
 * The scatter fields are built with three (geometry footprints decide the
 * instance radius), and this module must stay renderer-free — that is what lets
 * mission-smoke drive the whole sim headlessly. So rather than re-deriving the
 * placement here from the same seeds and drifting the moment a footprint
 * changes, the component that draws the rocks hands over the instances it
 * actually drew. The collider and the thing you can see cannot disagree,
 * because they are the same list.
 *
 * Only the metre-scale outcrops. Gravel is decoration — a few thousand pebble
 * capsules would cost more broadphase than every wall on the circuit combined,
 * and stopping a car on a stone the size of a football is not the complaint.
 */
let rockColliders: StaticCollider[] = [];

export function registerRockColliders(
  items: readonly { x: number; z: number; r: number }[],
): void {
  rockColliders = [];
  for (const it of items) {
    // A boulder is a circle, which a capsule expresses as a zero-length
    // segment — no special case needed anywhere downstream.
    if (it.r < ROCK_MIN_RADIUS) continue;
    rockColliders.push({
      x0: it.x,
      z0: it.z,
      x1: it.x,
      z1: it.z,
      // The drawn radius is the instance's bounding extent; a car should be
      // stopped by the rock, not by its halo, so take the part that is
      // actually solid at wheel height.
      r: it.r * ROCK_SOLID_FRAC,
      family: "boulder",
      stamp: 0,
      breakAt: Infinity,
      module: -1,
      run: -1,
      resistOnBreak: true,
      y: 0,
      destroyed: false,
    });
  }
  colliders = colliders.filter((c) => c.family !== "boulder").concat(rockColliders);
  reindex();
}

/** Below this drawn radius a rock is scenery, not an obstacle. */
const ROCK_MIN_RADIUS = 1.6;
/** Fraction of the drawn extent that is solid at wheel height. */
const ROCK_SOLID_FRAC = 0.62;

function reindex(): void {
  const out = colliders;
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
  // Before the empty early-out: the probe has to stay warm across a circuit
  // with no colliders, or the first step after a track change reports the
  // distance between two circuits as a velocity.
  liveProbe = trackProbe(x, z);
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
        // A felled module stays in its cells rather than being spliced out.
        // Rebuilding the grid mid-race to save one boolean test would cost more
        // than every query it saves.
        if (c.destroyed) continue;
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
  /*
   * A module felled EARLIER IN THIS SAME STEP is still in the caller's
   * candidate list — the query that built it ran before the impact. Without
   * this, breaking a section would deflect the car once per module in it, and
   * the second deflection would arrive with the car already stopped by the
   * first, which reads as the hole you just made stopping you.
   */
  if (c.destroyed) {
    contact.hit = false;
    return contact;
  }
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

  /*
   * Failure, and why a broken rail is still reported as a hit.
   *
   * The obvious alternative — report a miss so the car ploughs through
   * untouched — makes a smashed rail free, and the whole complaint being
   * answered here is that the rail was free. The one thing this file can spend
   * is the contact itself: returning it hands the break frame to
   * deflectOffStatic, which cancels the component INTO the rail and keeps the
   * tangential one. On a glancing hit that is a redirect down the circuit; on a
   * square one it is most of your speed. Both are what a guard rail section
   * failing under you actually costs, and both come out of the one deflection
   * routine every immovable thing in this game shares rather than a second
   * impulse path — reinventing that impulse is what produced the barriers that
   * threw the car backwards.
   *
   * It is exactly ONE frame. The section is gone by the next query, and the
   * neighbours felled with it are skipped at the top of this function, so a
   * break can never charge the same car twice for the same hole.
   */
  if (c.breakAt > 0 && liveProbe) {
    const qdx = liveProbe.x - x;
    const qdz = liveProbe.z - z;
    // The probe must belong to the query that produced this candidate. 2m of
    // slack covers deflectOffStatic having pushed the car out of an earlier
    // contact in the same step; any other caller is nowhere near it and simply
    // never breaks anything.
    if (qdx * qdx + qdz * qdz < 4) {
      const velN = liveProbe.vx * contact.nx + liveProbe.vz * contact.nz;
      if (velN > c.breakAt) {
        // Armco and a sheared lamp column are both heavy: slabs and steel that
        // go where the car was going, low spin, and stay put afterwards. A
        // hoarding is sheet material that planes away, and it is hit two metres
        // higher because at car height a board is only its legs.
        const heavy = c.family === "guardRail" || c.family === "lampPost";
        const spread = breakRoadside(c, px, pz);
        spawnDebrisBurst(
          heavy ? "barrier" : "panel",
          px,
          c.y + (heavy ? 0.9 : 2),
          pz,
          liveProbe.vx,
          liveProbe.vz,
          // 1.0 at the threshold, saturating at 2.2 inside the burst.
          velN / c.breakAt,
          c.y,
          spread,
        );
        // Plywood. Reporting a miss is what makes the car pass through with its
        // speed intact — see `resistOnBreak`.
        if (!c.resistOnBreak) contact.hit = false;
      }
    }
  }
  return contact;
}
