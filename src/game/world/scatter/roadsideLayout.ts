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

export type RoadsideLayout = {
  rail: RailModule[];
  boards: BoardSite[];
  /** Authored beam length; per-instance X scale takes up the local variation. */
  spacing: number;
};

const EMPTY: RoadsideLayout = { rail: [], boards: [], spacing: 6 };

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
  cache = { rail: modules, boards: buildBoards(), spacing };
  cachedFor = key;
  return cache;
}
