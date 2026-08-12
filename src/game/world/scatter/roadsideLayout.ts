/**
 * The ONE derivation of where the roadside furniture stands.
 *
 * Guard rail and sponsor hoardings are now two things at once: instances in an
 * InstancedMesh, and capsules in the sim's static-collider grid. Those live in
 * different halves of the codebase — RoadsideFurniture.tsx imports three, and
 * setpieceColliders.ts must never import three or mission-smoke stops being able
 * to drive the sim headlessly — so the temptation is to derive the layout twice.
 *
 * That does not work here, and not for the usual reason. It is not enough that
 * the two derivations agree on POSITIONS: a destroyed module has to stop being
 * drawn, and the cheapest honest way to say which one died is its INDEX in the
 * list. Two derivations that agree on geometry but disagree by one dropped
 * degenerate segment would silently hide the wrong module — the same class of
 * bug that made the Dead Mile distance markers unbreakable (breaking one would
 * have hidden an unrelated verge post, because they shared EDGE_MARKERS keys).
 *
 * So the list is built once, here, and both consumers walk it by index. The
 * setpiece colliders take the opposite approach — they MIRROR build.ts through
 * shared placement functions — because a set piece never dies and index
 * agreement never has to hold.
 *
 * No three import, deliberately. This module is on the sim's side of the line.
 */
import { getActiveTrackId, getTrackEpoch } from "../../track";
import {
  curvatureThreshold,
  linkedRuns,
  meanSpacing,
  vergePoints,
} from "./placement";

/**
 * Half-thickness of the guard rail's collider, in metres.
 *
 * Read off railModuleGeometry: the post spans local z ±0.07, the beam sits at
 * z 0.053-0.128 and its rib reaches 0.135. The capsule axis runs through the
 * post centre (local z = 0), so 0.18 puts the collider face 4.5cm proud of the
 * furthest thing you can see, which is the same small skin the slag wall's 0.85
 * carries over its 0.75m body.
 *
 * It is deliberately NOT inflated toward "a barrier ought to feel thick". The
 * car is already tested as a circle of its own largest projected half-extent
 * (1.4-2.1m depending on class and yaw), so every metre added here is a metre
 * of invisible wall standing off the rail you can see.
 */
export const RAIL_CAPSULE_R = 0.18;

/**
 * Hoarding collider: a capsule spanning the two legs, not the panel.
 *
 * boardGeometry puts 16cm legs at x ±1.85 and the panel from y 1.63 up — at car
 * height the board IS its legs. The capsule joins them anyway, for the reason
 * the pipeline trestles are solid between their legs: a car does not thread a
 * 3.7m gap between two posts on purpose, and modelling the hole only ever
 * produces a car wedged inside a hoarding. 1.93 + 0.20 = 2.13m half-extent,
 * inside the 2.4m the geometry actually occupies.
 */
export const BOARD_HALF_X = 1.93;
export const BOARD_CAPSULE_R = 0.2;

/**
 * Clearance half-footprint handed to the verge solver for the rail.
 *
 * Was 0.35 — a number chosen when the rail had no collider and only its own
 * silhouette had to clear the gravel. The solver's test is
 * `dist >= half + APRON_M + radius + 0.15`, so this is what turns "the posts
 * look like they clear the run-off" into "the COLLIDER clears the run-off by
 * 0.85 - 0.18 = 0.67m, on every circuit, by construction".
 *
 * Measured against all six circuits the tightest anchor already sits 0.93m out,
 * so raising it moves nothing today; it is here so that a future circuit which
 * doubles back tighter cannot quietly push a capsule onto drivable gravel.
 */
const RAIL_CLEAR_R = 0.7;

/** Nominal metres between the run-off edge and the rail's post line. */
const RAIL_OFFSET = 1;

/**
 * Lamp column collider radius.
 *
 * At car height a lamp is its SHAFT — 0.175m at the base, tapering — plus the
 * 0.15m shear collar at 0.6m. The 0.66m footing is wider but only 0.15m tall,
 * which is under axle height and not something a car is stopped by. So 0.22
 * puts the collider face 4.5cm proud of the widest thing you can hit, which is
 * the same small skin RAIL_CAPSULE_R carries, and it is deliberately NOT the
 * footing's 0.33: a collider sized to a kerb you drive over is an invisible
 * bollard.
 */
export const LAMP_CAPSULE_R = 0.22;

/**
 * Sign post collider radius.
 *
 * Same rule again, and it lands somewhere that looks wrong until you check the
 * heights: the plate is 2.5m across, but its lower edge is at 2.0m and a car is
 * 1.4m tall, so at any height a car occupies the sign IS its 0.14m post.
 * Half-diagonal 0.099 plus a skin.
 */
export const SIGN_CAPSULE_R = 0.14;

/**
 * Metres out from the run-off edge, per family.
 *
 * The ordering is the whole design: rail at 1 (it has to be the thing you hit),
 * signs at 1.9 behind it, lamps at 3 behind those, hoardings at 5.5. Each band
 * clears the one inside it by more than the two capsule radii involved, so no
 * two pieces of furniture can ever be solid in the same place — which is a
 * property worth having by construction rather than by inspection, because the
 * verge solver pushes anchors OUTWARD when the loop doubles back and two
 * families pushed by different amounts would otherwise cross.
 */
const SIGN_OFFSET = 1.9;
const LAMP_OFFSET = 3;

/**
 * Track samples between lamps on one verge.
 *
 * Sample spacing runs 3.5-4.3m across the six circuits, so 8 gives 28-34m —
 * motorway lighting spacing, and close enough that the rhythm reads at speed
 * without the columns merging into a fence.
 */
const LAMP_STRIDE = 8;
/** Samples between signs. Chevron boards want to be an event, not a texture. */
const SIGN_STRIDE = 11;

/**
 * Clearance half-footprints handed to the verge solver.
 *
 * Larger than the colliders on purpose, and for the reason RAIL_CLEAR_R is:
 * this is what turns "it looks like it clears the run-off" into "the COLLIDER
 * clears the run-off by `CLEAR - CAPSULE` metres on every circuit, by
 * construction". The lamp's is sized to its footing rather than its shaft,
 * because the footing is the part that would visibly sit on drivable gravel.
 */
const LAMP_CLEAR_R = 0.75;
const SIGN_CLEAR_R = 0.55;

/** One beam span: post at `a`, beam running to the next post at `b`. */
export type RailModule = {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  /** Planar span, which is what the collider capsule is. */
  flat: number;
  /** 3D span, which is what the beam geometry is stretched to. */
  len: number;
  /**
   * Which linked run this belongs to. The break cascade is not allowed to cross
   * runs: two stretches of rail can pass within a few metres of each other where
   * the circuit doubles back, and taking out the far one because you hit this
   * one would open a hole in rail nobody touched.
   */
  run: number;
};

/** One sponsor hoarding. */
export type BoardSite = {
  x: number;
  y: number;
  z: number;
  /** Composed yaw: panel normal (local +Z) turned to face the racing line. */
  yaw: number;
  /** Unit XZ direction of the panel's long axis (its local +X). */
  ax: number;
  az: number;
  /** Track sample index, kept only so the livery pick is unchanged. */
  index: number;
};

/**
 * One lamp column. Yawed so its local +Z — the arm, and therefore the light —
 * points at the racing line.
 */
export type LampSite = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** -1 / +1 in the EDGE_MARKERS convention. Which verge it stands on. */
  side: number;
  index: number;
};

/**
 * One catenary span, as a pair of indices into `lamps`.
 *
 * Indices rather than coordinates because a span has to disappear when EITHER
 * of its columns is knocked down. A wire left hanging from a post that is no
 * longer there is the most obvious kind of broken, and it is the failure mode a
 * span that carried its own copy of the endpoints would produce.
 */
export type WireSpan = { a: number; b: number };

/** One chevron board. Same facing convention as a hoarding, plus a toe-in. */
export type SignSite = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  index: number;
};

export type RoadsideLayout = {
  rail: RailModule[];
  boards: BoardSite[];
  lamps: LampSite[];
  wires: WireSpan[];
  signs: SignSite[];
  /** Authored beam length; per-instance X scale takes up the local variation. */
  spacing: number;
  /** Authored catenary span; same deal for the wire geometry. */
  wireSpacing: number;
};

const EMPTY: RoadsideLayout = {
  rail: [],
  boards: [],
  lamps: [],
  wires: [],
  signs: [],
  spacing: 6,
  wireSpacing: 30,
};

let cache: RoadsideLayout = EMPTY;
/** `${trackId}#${epoch}` the cached layout was derived for. */
let cachedFor = "";

function buildRail(): { modules: RailModule[]; spacing: number } {
  // Top ~40% of the circuit by curvature. Rail belongs where a car leaves the
  // road, which is the outside of a bend, and nowhere else.
  const points = vergePoints({
    stride: 1,
    offset: RAIL_OFFSET,
    radius: RAIL_CLEAR_R,
    minCurve: curvatureThreshold(0.4),
    outsideOnly: true,
  });
  if (points.length < 4) return { modules: [], spacing: 6 };

  const spacing = meanSpacing(points);
  const runs = linkedRuns(points, spacing * 2.4);
  const modules: RailModule[] = [];
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r]!;
    for (let i = 0; i < run.length - 1; i++) {
      const a = run[i]!;
      const b = run[i + 1]!;
      const flat = Math.hypot(b.x - a.x, b.z - a.z);
      // Degenerate span. Dropped HERE and only here, so the renderer and the
      // collider list cannot disagree about how many modules there are.
      if (flat < 0.4) continue;
      modules.push({
        ax: a.x,
        ay: a.y,
        az: a.z,
        bx: b.x,
        by: b.y,
        bz: b.z,
        flat,
        len: Math.hypot(flat, b.y - a.y),
        run: r,
      });
    }
  }
  return { modules, spacing };
}

function buildBoards(): BoardSite[] {
  // Flattest ~45% of the circuit: a hoarding wants to be read at speed on
  // approach, which only works down a straight.
  const points = vergePoints({
    stride: 7,
    offset: 5.5,
    radius: 3,
    maxCurve: curvatureThreshold(0.55),
    phase: 3,
    reach: 4,
  });
  return points.map((p) => {
    // Panel normal is local +Z; turn it to face the racing line. Sign flips
    // with the verge, or half the boards would advertise to the desert.
    const yaw = p.yaw - p.side * Math.PI * 0.5;
    // A three.js rotation about +Y takes local +X to (cos, -sin). With this
    // yaw that works out to the road tangent, which is the axis the 4.6m panel
    // is long in — so the capsule's 1.93m arms run ALONG the verge and its
    // 0.20m radius is the whole of its reach toward the road.
    return {
      x: p.x,
      y: p.y,
      z: p.z,
      yaw,
      ax: Math.cos(yaw),
      az: -Math.sin(yaw),
      index: p.index,
    };
  });
}

/**
 * Toe-in of a sign plate toward oncoming traffic, in radians.
 *
 * A hoarding faces square across the road because it is an advertisement and it
 * is read from anywhere. A chevron board is read from ONE direction, on the
 * approach, so it is turned 14 degrees back up the circuit.
 *
 * The sign of this is derived, not guessed, and it is the kind of thing that is
 * 50/50 by inspection: `buildSamples` sets `yaw = atan2(-dx, -dz)`, so the
 * direction of travel is -(sin yaw, cos yaw). A three.js rotation about +Y by
 * `yaw - side*PI/2` puts the plate's local +Z on -side*(cos yaw, -sin yaw),
 * which is the run across the road toward the racing line; differentiating that
 * in the rotation angle gives -side * travel. So adding `+side*TOE` rotates the
 * normal toward -travel, i.e. into the oncoming car, on BOTH verges.
 */
const SIGN_TOE = 0.24;

function buildLamps(): {
  lamps: LampSite[];
  wires: WireSpan[];
  wireSpacing: number;
} {
  const points = vergePoints({
    stride: LAMP_STRIDE,
    offset: LAMP_OFFSET,
    radius: LAMP_CLEAR_R,
    // Both verges, every kind of section. Lighting is infrastructure: a circuit
    // lit only through its corners reads as a corner that has been decorated,
    // not as a road that has lamps on it.
    phase: 5,
  });
  if (points.length < 2) return { lamps: [], wires: [], wireSpacing: 30 };

  const lamps: LampSite[] = points.map((p) => ({
    x: p.x,
    y: p.y,
    z: p.z,
    // Same rule as a hoarding: turn the module's local +Z onto the racing line.
    // The sign flips with the verge, or half the lamps light the desert.
    yaw: p.yaw - p.side * Math.PI * 0.5,
    side: p.side,
    index: p.index,
  }));

  /*
   * Runs are built PER VERGE, and that is not a tidiness point.
   *
   * `vergePoints` emits side -1 then side +1 at every anchor, so consecutive
   * entries in the list ALWAYS differ in side. Handing that straight to
   * `linkedRuns` — which is what the guard rail does, because the rail is
   * outside-only and therefore single-sided — joins nothing at all: every run
   * is length one and every one of them is discarded. The result is a circuit
   * of lamp posts with no wire between any of them, which looks like the wires
   * simply were not implemented.
   */
  const perSide = [-1, 1].map((side) =>
    lamps
      .map((l, lamp) => ({ x: l.x, z: l.z, side: l.side, lamp }))
      .filter((l) => l.side === side),
  );

  // Median consecutive gap, over both verges. Median rather than mean for the
  // same reason `meanSpacing` is: the list has deliberate holes where the
  // solver could not place a column, and two 90m jumps drag a mean far off the
  // span that actually occurs — which would then stretch every wire on the
  // circuit.
  const gaps: number[] = [];
  for (const own of perSide) {
    for (let i = 1; i < own.length; i++) {
      gaps.push(
        Math.hypot(own[i]!.x - own[i - 1]!.x, own[i]!.z - own[i - 1]!.z),
      );
    }
  }
  gaps.sort((a, b) => a - b);
  const wireSpacing = gaps.length ? gaps[Math.floor(gaps.length * 0.5)]! : 30;

  const wires: WireSpan[] = [];
  for (const own of perSide) {
    for (const run of linkedRuns(own, wireSpacing * 1.9)) {
      for (let i = 0; i < run.length - 1; i++) {
        const a = run[i]!;
        const b = run[i + 1]!;
        if (Math.hypot(b.x - a.x, b.z - a.z) < 0.4) continue;
        wires.push({ a: a.lamp, b: b.lamp });
      }
    }
  }

  return { lamps, wires, wireSpacing };
}

function buildSigns(): SignSite[] {
  // Outside of the bend, on the more curved half of the circuit. A chevron
  // board is not decoration that happens to be near a corner — it is the sign
  // that means "the road goes this way", and it belongs on the outside of the
  // turn it is warning about and nowhere else.
  const points = vergePoints({
    stride: SIGN_STRIDE,
    offset: SIGN_OFFSET,
    radius: SIGN_CLEAR_R,
    minCurve: curvatureThreshold(0.55),
    outsideOnly: true,
    phase: 3,
  });
  return points.map((p) => ({
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw - p.side * (Math.PI * 0.5 - SIGN_TOE),
    index: p.index,
  }));
}

/**
 * The active circuit's furniture layout.
 *
 * Cached on `${trackId}#${epoch}`, single entry, for the same reason the
 * set-piece colliders are: the derivation walks every track sample through
 * `getSurfaceAt` (up to five clearance attempts each), and both the renderer's
 * one-off build and the sim's per-grid rebuild land on the same key, so the
 * solve is paid once per circuit rather than once per consumer.
 */
export function roadsideLayout(): RoadsideLayout {
  const key = `${getActiveTrackId()}#${getTrackEpoch()}`;
  if (key === cachedFor) return cache;
  const { modules, spacing } = buildRail();
  const { lamps, wires, wireSpacing } = buildLamps();
  cache = {
    rail: modules,
    boards: buildBoards(),
    lamps,
    wires,
    signs: buildSigns(),
    spacing,
    wireSpacing,
  };
  cachedFor = key;
  return cache;
}
