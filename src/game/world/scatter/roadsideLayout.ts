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
import { getActiveTrackId, getTrackEpoch, getTrackSamples } from "../../track";
import {
  curvatureThreshold,
  linkedRuns,
  meanSpacing,
  signedCurvature,
  solveAnchor,
  vergePoints,
  type VergePoint,
} from "./placement";
import {
  BOARD_FACE,
  BOARD_FACE_COUNT,
  SIGN_FACE,
  SIGN_FACE_COUNT,
} from "./signFaces";

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
  /** Track sample index. */
  index: number;
  /** Cell of the signage atlas the panel wears. See signFaces.ts. */
  face: number;
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

/** One post-mounted plate. Same facing convention as a hoarding, plus a toe-in. */
export type SignSite = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  index: number;
  /** Cell of the signage atlas the plate wears. See signFaces.ts. */
  face: number;
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

/**
 * Which hoarding wears which face, by position in the list.
 *
 * A cycle rather than a hash of the index, and a deliberately uneven one: the
 * league banner and the two traders should recur, while the circuit board and
 * the notice are one-offs you meet occasionally. A uniform `i % 6` gives every
 * circuit the same tidy rotation, which reads as wallpaper.
 */
const BOARD_CYCLE = [
  BOARD_FACE.circuit,
  BOARD_FACE.traderA,
  BOARD_FACE.league,
  BOARD_FACE.traderB,
  BOARD_FACE.notice,
  BOARD_FACE.traderA,
  BOARD_FACE.league,
  BOARD_FACE.timing,
  BOARD_FACE.traderB,
  BOARD_FACE.league,
];

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
  return points.map((p, i) => {
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
      face: BOARD_CYCLE[i % BOARD_CYCLE.length]! % BOARD_FACE_COUNT,
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

/**
 * Metres between one plate and the next, anywhere on the circuit.
 *
 * Five families now choose anchors independently — corner warnings from a
 * curvature percentile, braking boards from arc length before a corner, sector
 * boards from lap fraction, route markers from a fixed interval, zone warnings
 * from the sample's own `zone`. Nothing stops two of them landing on the same
 * three metres of verge, and two plates occupying each other reads as a bug
 * rather than as dense signage. 9m is a little over the plate's own 2.4m width
 * plus the gap that makes two signs read as two signs.
 */
const SIGN_MIN_GAP = 9;

/**
 * Braking boards, in metres before the corner they serve.
 *
 * Real distances, and the plates say the same numbers — which is worth stating
 * because the tempting alternative was to print the conventional 300/200/100 on
 * boards that are nowhere near 300m apart. A sign that lies about a distance is
 * worse than no sign: the one thing a braking board is for is calibrating how
 * long you have left.
 */
const BRAKE_BOARDS: [number, number][] = [
  [150, SIGN_FACE.brake150],
  [100, SIGN_FACE.brake100],
  [50, SIGN_FACE.brake50],
];

/** Metres between league route markers down a straight. */
const ROUTE_INTERVAL = 210;

/**
 * A sign that has cleared the spacing test, ready to be turned into a site.
 *
 * The toe-in is applied at the end for every family at once, so a new family
 * cannot forget it and end up with one plate on the circuit facing across the
 * road instead of up it.
 */
type SignPick = { p: VergePoint; face: number };

function buildSigns(): SignSite[] {
  const S = getTrackSamples();
  const n = S.length;
  if (n < 8) return [];

  const picks: SignPick[] = [];
  const add = (p: VergePoint | null, face: number) => {
    if (!p) return;
    for (const q of picks) {
      const dx = q.p.x - p.x;
      const dz = q.p.z - p.z;
      if (dx * dx + dz * dz < SIGN_MIN_GAP * SIGN_MIN_GAP) return;
    }
    picks.push({ p, face });
  };

  /** Planar gap between consecutive samples, wrapping. */
  const gap = (i: number) => {
    const a = S[((i % n) + n) % n]!;
    const b = S[((i + 1) % n + n) % n]!;
    return Math.hypot(b.x - a.x, b.z - a.z);
  };
  /**
   * The sample `metres` of road BEFORE `i`.
   *
   * Walked rather than derived from `sample.s`, because `s` is arc length along
   * the centreline and wraps at the start/finish line — subtracting through the
   * wrap silently sends a braking board to the far side of the circuit.
   */
  const back = (i: number, metres: number) => {
    let j = i;
    let d = 0;
    for (let k = 0; k < n && d < metres; k++) {
      j = (j - 1 + n) % n;
      d += gap(j);
    }
    return j;
  };

  const cornerCurve = curvatureThreshold(0.55);
  const chevronCurve = curvatureThreshold(0.32);
  const hairpinCurve = curvatureThreshold(0.1);
  const straightCurve = curvatureThreshold(0.62);
  /*
   * "The approach is not itself a corner", and it is a LOOSER test than
   * `straightCurve`.
   *
   * The first version reused the straight threshold and placed exactly ZERO
   * braking boards on all six circuits, which read as the family not being
   * implemented. `curvatureThreshold(f)` returns the value the top `f` of
   * samples exceed, so 0.62 demands every one of the ~45 samples in a 150m run
   * be in the flattest 38% — on a closed loop that is never true. These are
   * road circuits scratched into a desert, not a drag strip: the run down to a
   * corner drifts. Measured over the six circuits, 0.15 (i.e. "stay out of the
   * top 15% of curvature") is the loosest test that still refuses to put a
   * braking board inside the PREVIOUS corner, and it yields 1/2/2/3/4/6 sets.
   */
  const approachCurve = curvatureThreshold(0.15);

  /*
   * 1. Corner warnings — unchanged in WHERE they stand.
   *
   * Outside of the bend, on the more curved half of the circuit. A chevron
   * board is not decoration that happens to be near a corner: it is the sign
   * that means "the road goes this way", and it belongs on the outside of the
   * turn it is warning about and nowhere else. What is new is that the plate now
   * says WHICH way and how hard, instead of carrying one generic device.
   *
   * The direction is derived, not guessed. `vergePoints(outsideOnly)` puts the
   * anchor on `curve > 0 ? -1 : +1`, and side +1 is the right of travel — so a
   * positive curvature means the outside is on the LEFT, which means the road
   * turns RIGHT. Getting this backwards points every chevron on the circuit into
   * the infield, and it is exactly 50/50 by inspection.
   */
  for (const p of vergePoints({
    stride: SIGN_STRIDE,
    offset: SIGN_OFFSET,
    radius: SIGN_CLEAR_R,
    minCurve: cornerCurve,
    outsideOnly: true,
    phase: 3,
  })) {
    const curve = signedCurvature(p.index);
    const mag = Math.abs(curve);
    const right = curve > 0 ? 1 : 0;
    const base =
      mag >= hairpinCurve
        ? SIGN_FACE.hairpinL
        : mag >= chevronCurve
          ? SIGN_FACE.chevronL
          : SIGN_FACE.bendL;
    add(p, base + right);
  }

  /*
   * 2. Braking boards, at the end of a straight.
   *
   * Only for corners with a genuinely clear approach — the run back to 150m has
   * to be below the straight threshold the whole way. Otherwise the boards land
   * inside the PREVIOUS corner, where they are both unreadable and wrong.
   */
  const majors: number[] = [];
  for (let i = 0; i < n; i++) {
    const mag = Math.abs(signedCurvature(i));
    if (mag < chevronCurve) continue;
    // Local maximum only, and never within 18 samples of the last one kept — a
    // long corner is one corner and wants one set of boards.
    if (mag < Math.abs(signedCurvature(i - 2)) || mag < Math.abs(signedCurvature(i + 2))) {
      continue;
    }
    const last = majors[majors.length - 1];
    if (last !== undefined && i - last < 18) continue;
    majors.push(i);
  }
  for (const i of majors) {
    const outside = signedCurvature(i) > 0 ? -1 : 1;
    const first = back(i, BRAKE_BOARDS[0]![0]);
    // Stop the test 20m short of the corner. The last few metres of an approach
    // are the corner ENTRY and are legitimately curving; including them is the
    // other half of why the first version placed none at all.
    const stop = back(i, 20);
    let clear = true;
    for (let j = first; j !== stop; j = (j + 1) % n) {
      if (Math.abs(signedCurvature(j)) > approachCurve) {
        clear = false;
        break;
      }
    }
    if (!clear) continue;
    for (const [metres, face] of BRAKE_BOARDS) {
      add(
        solveAnchor(back(i, metres), outside, SIGN_OFFSET, SIGN_CLEAR_R),
        face,
      );
    }
  }

  /*
   * 3. Sector boards. Thirds of the lap, on the left verge, which is the side a
   * timing board sits on everywhere else in this project (the gantry hangs its
   * sector plate on both columns, so there is no convention to break).
   */
  let lap = 0;
  for (let i = 0; i < n; i++) lap += gap(i);
  for (let k = 0; k < 3; k++) {
    const want = lap * (0.04 + k / 3);
    let d = 0;
    let at = 0;
    for (let i = 0; i < n && d < want; i++) {
      d += gap(i);
      at = i;
    }
    add(
      solveAnchor(at, -1, SIGN_OFFSET, SIGN_CLEAR_R) ??
        solveAnchor(at, 1, SIGN_OFFSET, SIGN_CLEAR_R),
      SIGN_FACE.sector1 + k,
    );
  }

  /*
   * 4. League route markers, down the straights, alternating verges.
   *
   * This is the family that guarantees a circuit has written signage at all: the
   * three above are conditional on curvature and the one below on zone tags, and
   * a circuit with gentle corners and no hazard zones would otherwise end up
   * with almost nothing to read.
   */
  let since = ROUTE_INTERVAL;
  let flip = 1;
  for (let i = 0; i < n; i++) {
    since += gap(i);
    if (since < ROUTE_INTERVAL) continue;
    if (Math.abs(signedCurvature(i)) > straightCurve) continue;
    const before = picks.length;
    add(solveAnchor(i, flip, SIGN_OFFSET, SIGN_CLEAR_R), SIGN_FACE.route);
    if (picks.length === before) continue;
    since = 0;
    flip = -flip;
  }

  /*
   * 5. Zone warnings. A crest board before a jump, a narrows board before a
   * pinch, a hazard board before a hazard zone — placed at the RUN START, 45m
   * upstream, on both verges where there is room, because a warning you pass
   * while already in the thing it warns about is decoration.
   */
  const ZONE_FACE: Partial<Record<string, number>> = {
    jump: SIGN_FACE.crest,
    narrow: SIGN_FACE.narrows,
    hazard: SIGN_FACE.hazard,
  };
  for (let i = 0; i < n; i++) {
    const z = S[i]!.zone;
    const face = ZONE_FACE[z];
    if (face === undefined) continue;
    if (S[(i - 1 + n) % n]!.zone === z) continue;
    const at = back(i, 45);
    for (const side of [-1, 1] as const) {
      add(solveAnchor(at, side, SIGN_OFFSET, SIGN_CLEAR_R), face);
    }
  }

  return picks.map(({ p, face }) => ({
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw - p.side * (Math.PI * 0.5 - SIGN_TOE),
    index: p.index,
    face: Math.min(SIGN_FACE_COUNT - 1, Math.max(0, face)),
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
