/**
 * Procedural structure geometry — one merged BufferGeometry per family.
 *
 * The rules are the same ones scatter/geometry.ts works to, for the same
 * reason: a family is one draw call, so everything a structure is made of has
 * to end up in one geometry with one material. Boxes and low-segment cylinders
 * only — these are read at 40 m/s from 30 to 250 metres, where silhouette is
 * the entire content of the image and a bevel is not.
 *
 * Three conventions everything here obeys, because the placement code depends
 * on all three:
 *
 *  1. LOCAL +Z FACES THE ROAD. Unlinked families are yawed so their +Z points
 *     at the racing line, so anything with a front (a tap hole, a sign plate, a
 *     crane's counter-jib) is authored on +Z and anything that must point away
 *     from the circuit (a crane's main jib) is authored on -Z. That is not
 *     decoration: it is what guarantees an 18m jib overhangs desert rather than
 *     tarmac, without the clearance test having to know about jibs.
 *  2. LINKED FAMILIES SPAN [0, span] IN LOCAL +X, base at the origin end. Same
 *     convention railModuleGeometry established — a module is placed on one
 *     verge anchor and aimed at the next, which is what makes a wall follow a
 *     corner instead of becoming a ring of tangent stubs.
 *  3. EVERY STRUCTURE HAS A PLINTH THAT EXTENDS BELOW y = 0. Ground under a
 *     10m footprint is not flat — the dune profile climbs the moment you leave
 *     the tarmac — so a structure placed at the ground height of its CENTRE
 *     floats at one corner and sinks at the other. A skirt of a metre or so
 *     buries the disagreement instead of showing it. Nothing else in this
 *     project has needed it because nothing else in this project has had a
 *     footprint bigger than a boulder.
 *
 * Vertex colours carry the baked contact darkening that these get instead of a
 * shadow (most families do not cast one — see types.ts) and the per-part
 * tinting that lets one material draw a dark footing and a bright coping.
 */
import * as THREE from "three";
import {
  coloredBox,
  facetedRock,
  mergeOrThrow,
  paintVertices,
} from "../scatter/geometry";
import type { SetpieceShape } from "./types";

type Rgb = [number, number, number];

/**
 * One box part: built at the origin, yawed, then moved into place.
 *
 * Order matters — `coloredBox` translates, so rotating a pre-translated part
 * would orbit it around the structure's origin rather than spin it in place.
 */
function part(
  w: number,
  h: number,
  d: number,
  pos: [number, number, number],
  rgb: Rgb,
  rotY = 0,
): THREE.BufferGeometry {
  const g = coloredBox(w, h, d, [0, 0, 0], rgb);
  if (rotY) g.rotateY(rotY);
  g.translate(pos[0], pos[1], pos[2]);
  return g;
}

/**
 * A warped rock lump — the natural-form counterpart to `part`.
 *
 * `part` is right for everything anybody built and wrong for everything nobody
 * did, and this file had been using it for both. A box is a wall, a container, a
 * pylon or a girder; it is not a boulder, a spoil heap or a basalt remnant, and
 * the difference is not subtle at 20 triangles because the eye reads a hard 90°
 * silhouette edge as "manufactured" before it reads anything else.
 *
 * Same primitive the desert boulders are made of (`facetedRock`), so a spire in
 * the mid ground and the gravel at your wheels are the same rock.
 *
 * `paint` is a function of the part's LOCAL y after placement, so a caller can
 * put contact darkening at the bottom of the lump and a sun-caught face at the
 * top without knowing how the warp happened to land.
 */
function lump(
  seed: number,
  size: [number, number, number],
  pos: [number, number, number],
  paint: (y: number) => Rgb,
  opts: { rot?: [number, number, number]; squashY?: number; lo?: number; range?: number } = {},
): THREE.BufferGeometry {
  const g = facetedRock(seed, {
    squashY: opts.squashY ?? 1,
    lo: opts.lo ?? 0.58,
    range: opts.range ?? 0.72,
  });
  g.scale(size[0], size[1], size[2]);
  const rot = opts.rot;
  if (rot) {
    g.rotateX(rot[0]);
    g.rotateY(rot[1]);
    g.rotateZ(rot[2]);
  }
  g.translate(pos[0], pos[1], pos[2]);
  return paintVertices(g, (_x, y) => paint(y));
}

/**
 * Low-segment cylinder, coloured like a box part.
 *
 * `axis: "x"` lays it along local +X for a pipe run. Segment counts stay at 6-8:
 * a hexagonal pipe is indistinguishable from a round one past about 8m and
 * costs a quarter of the triangles, and these run the length of a circuit.
 */
function cyl(
  radius: number,
  height: number,
  pos: [number, number, number],
  rgb: Rgb,
  opts: { segments?: number; open?: boolean; axis?: "x" | "y" } = {},
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(
    radius,
    radius,
    height,
    opts.segments ?? 8,
    1,
    opts.open ?? false,
  );
  if (opts.axis === "x") g.rotateZ(-Math.PI / 2);
  g.translate(pos[0], pos[1], pos[2]);
  const n = g.attributes.position!.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    c[i * 3] = rgb[0];
    c[i * 3 + 1] = rgb[1];
    c[i * 3 + 2] = rgb[2];
  }
  g.setAttribute("color", new THREE.BufferAttribute(c, 3));
  g.clearGroups();
  return g;
}

/* ── Foundry Pit ──────────────────────────────────────────────────── */

/**
 * Slag retaining wall — the thing that makes a bowl a bowl.
 *
 * 4.1m tall, which is deliberately just over eye line from a car: you cannot
 * see out of the pit, only along it. The buttress sits at the module's origin
 * end so a run of them gives a rhythm of piers rather than an unbroken slab,
 * and it is what stops a long straight wall reading as a flat-shaded ribbon.
 */
function slagWall(span: number): THREE.BufferGeometry {
  const dark: Rgb = [0.32, 0.29, 0.27];
  const mid: Rgb = [0.62, 0.58, 0.55];
  const lit: Rgb = [0.92, 0.87, 0.8];
  const pier: Rgb = [0.46, 0.43, 0.41];
  const m = span * 0.5;
  return mergeOrThrow([
    part(span, 1.8, 2.4, [m, -0.4, 0], dark),
    part(span, 3.2, 1.5, [m, 2.1, 0], mid),
    part(span, 0.4, 1.9, [m, 3.9, 0], lit),
    part(1.0, 3.0, 2.8, [0.5, 1.0, 0], pier),
  ]);
}

/**
 * Furnace stack — 21m, the only thing in the Foundry Pit taller than the smoke.
 *
 * The offtake duct leans out on -X so the silhouette is asymmetric; a symmetric
 * stack repeated fourteen times reads as one asset placed fourteen times, which
 * is exactly the failure this whole exercise is about.
 */
function furnaceStack(): THREE.BufferGeometry {
  const foot: Rgb = [0.28, 0.25, 0.24];
  const body: Rgb = [0.55, 0.5, 0.47];
  const upper: Rgb = [0.74, 0.68, 0.62];
  const steel: Rgb = [0.44, 0.42, 0.42];
  return mergeOrThrow([
    part(11, 2.6, 11, [0, -0.7, 0], foot),
    part(8.2, 8.5, 8.2, [0, 4.85, 0], body),
    part(5.6, 2.2, 5.6, [0, 10.2, 0], upper),
    part(2.8, 9.5, 2.8, [0, 16.05, 0], upper),
    part(3.4, 0.6, 3.4, [0, 21.1, 0], steel),
    part(5.0, 1.4, 1.4, [-5.6, 7.4, 0], steel),
  ]);
}

/**
 * The tap hole, and what has run out of it.
 *
 * Its own family only because three's emissive is a material uniform: a bright
 * box merged into `furnaceStack` would either be unlit at night or would make
 * the entire 21m stack glow. Rides on the stack's anchors via `follows`, so it
 * is authored in the stack's local space and lands on its +Z face.
 */
function furnaceTap(): THREE.BufferGeometry {
  const hot: Rgb = [1, 0.86, 0.66];
  const spill: Rgb = [1, 0.62, 0.34];
  return mergeOrThrow([
    // Clear of the stack's 11m footing (half-depth 5.5, top at y 0.6): the tap
    // sits above it and the spill runs out past its edge, or both would be
    // swallowed by the plinth they are supposed to be pouring onto.
    part(3.2, 1.8, 1.0, [0, 1.9, 4.6], hot),
    part(2.4, 0.7, 2.8, [0, 0.1, 7.2], spill),
  ]);
}

/**
 * Choke gate pylon — 9.7m of concrete standing where the road is 20m wide.
 *
 * Placed in pairs on both verges of a `narrow` section. There is deliberately
 * NO beam across the top: a span over the road is geometry with no collider
 * sitting exactly where a car goes, which is how a crane once ended up
 * straddling the circuit with nothing to hit. Two heavy verticals close in do
 * the same job to the eye and cannot be driven through, because there is
 * nothing over the road to drive through.
 */
function chokeGate(): THREE.BufferGeometry {
  const foot: Rgb = [0.3, 0.28, 0.26];
  const col: Rgb = [0.68, 0.64, 0.6];
  const cap: Rgb = [0.42, 0.4, 0.39];
  const band: Rgb = [1.0, 0.78, 0.24];
  return mergeOrThrow([
    part(3.4, 1.6, 3.4, [0, -0.4, 0], foot),
    part(2.0, 8.6, 2.0, [0, 4.6, 0], col),
    part(2.8, 0.7, 2.8, [0, 9.3, 0], cap),
    part(1.4, 0.9, 1.6, [0, 9.9, 0.9], cap),
    part(2.2, 0.5, 2.2, [0, 7.6, 0], band),
  ]);
}

/* ── Rustline ─────────────────────────────────────────────────────── */

/**
 * Four crushed cars, stacked and not quite square.
 *
 * Each slab is yawed a few degrees off its neighbours. A perfectly aligned
 * stack reads as a crate; the misalignment is the whole difference between
 * "boxes" and "a scrapyard".
 */
function wreckStack(): THREE.BufferGeometry {
  const rust: Rgb = [0.52, 0.32, 0.22];
  const paint: Rgb = [0.66, 0.62, 0.58];
  const dark: Rgb = [0.34, 0.28, 0.25];
  const pale: Rgb = [0.8, 0.74, 0.66];
  return mergeOrThrow([
    part(4.6, 1.0, 2.0, [0, 0.35, 0], dark, 0.08),
    part(4.4, 0.95, 1.9, [0.4, 1.3, 0.25], rust, -0.16),
    part(4.1, 0.85, 1.85, [-0.3, 2.18, -0.15], paint, 0.27),
    part(3.7, 0.75, 1.7, [0.25, 2.98, 0.1], rust, -0.34),
    part(0.85, 0.7, 0.85, [2.0, 3.6, 0.1], pale, 0.5),
  ]);
}

/**
 * Container stack — a wall of boxes two high, 5.1m.
 *
 * The upper container is shorter than the lower one and offset along the run,
 * so a linked row steps rather than presenting one continuous 5m face. Tight to
 * the verge this is what makes a 22m road feel like an 14m one.
 */
function containerWall(span: number): THREE.BufferGeometry {
  const sill: Rgb = [0.26, 0.24, 0.22];
  const lower: Rgb = [0.7, 0.5, 0.34];
  const upper: Rgb = [0.44, 0.52, 0.5];
  const post: Rgb = [0.34, 0.31, 0.29];
  return mergeOrThrow([
    part(span, 0.5, 2.9, [span * 0.5, -0.1, 0], sill),
    part(span, 2.6, 2.5, [span * 0.5, 1.3, 0], lower),
    part(span * 0.72, 2.5, 2.44, [span * 0.4, 3.85, 0.12], upper),
    part(0.35, 5.2, 2.7, [0.18, 2.6, 0], post),
  ]);
}

/**
 * Yard crane — 16m mast with the jib thrown out along local -Z.
 *
 * -Z is the away-from-road direction once the family is yawed to face the
 * circuit, so an 18m boom is guaranteed to hang over scrap rather than over the
 * racing line no matter where on the loop it lands. That is why the placement
 * radius only has to cover the counter-jib side (~5.3m) instead of the crane's
 * full 23m reach: the geometry itself resolves the half that would otherwise be
 * a clearance problem.
 */
function craneArm(): THREE.BufferGeometry {
  const base: Rgb = [0.3, 0.27, 0.25];
  const steel: Rgb = [0.78, 0.6, 0.28];
  const dark: Rgb = [0.4, 0.36, 0.33];
  const cab: Rgb = [0.6, 0.64, 0.66];
  return mergeOrThrow([
    part(4.6, 1.6, 4.6, [0, -0.2, 0], base),
    part(1.5, 15, 1.5, [0, 8.0, 0], steel),
    part(2.4, 1.8, 2.6, [0, 15.4, -1.2], cab),
    part(1.1, 1.0, 17, [0, 16.4, -9.6], steel),
    part(1.1, 0.9, 5.0, [0, 16.4, 2.8], dark),
    part(2.2, 1.6, 2.0, [0, 15.6, 4.6], base),
    part(0.7, 1.2, 0.7, [0, 12.5, -7.0], dark),
  ]);
}

/* ── Sable Run ────────────────────────────────────────────────────── */

/**
 * Basalt remnant — 13m, slender, and the ONLY built thing on this circuit.
 *
 * Sable Run's design is restraint: a mile and a half of fourth-gear geometry
 * whose drama is scale and an empty horizon, and set dressing near the road
 * would destroy exactly the thing that makes it different from the other five.
 * These sit 100-230m out, far enough that they never pass close, and they exist
 * for one reason — with nothing between the car and the ridge there is no
 * parallax, and with no parallax a 400m-wide playa and a 4km one look identical.
 *
 * ── this was four boxes, and that was the bug ─────────────────────────
 *
 * The rest of this file is boxes because the rest of this file is things people
 * welded. A remnant is not. Four axis-aligned cuboids with a whole-object yaw —
 * every face still vertical, every silhouette edge still a hard right angle —
 * is the single most conspicuous "primitive mesh" in the world, and it was
 * conspicuous in the worst available place: sixteen instances at up to 1.9x
 * scale, drawn out to 460m, on the one circuit that has nothing else to look at
 * and whose entire job is to make you believe in the distance.
 *
 * Now four warped lumps of the same primitive the desert boulders use, stacked
 * with generous overlap so the joins are inside the solid, each yawed and
 * tilted independently. 80 triangles against the boxes' 48 — 1,280 against 768
 * across the circuit's sixteen instances, on a family that is already the only
 * geometry Sable Run draws.
 */
function monolith(): THREE.BufferGeometry {
  /*
   * Vertical ramp from a buried, unlit foot to a sun-caught cap, with a faint
   * horizontal banding on top of it.
   *
   * The banding is the cheapest thing in this function and it is doing real
   * work: an unbroken gradient over 13m of rock reads as a painted cone, while
   * even a 6% ripple at roughly two-metre intervals reads as bedding. It is the
   * same argument `bandHeight` makes for the ridge ranges, at one-hundredth of
   * the cost, and unlike them it survives being seen from 40m away.
   */
  const shade = (y: number): Rgb => {
    const t = Math.min(1, Math.max(0, (y + 0.8) / 13.6));
    const band = 1 + Math.sin(y * 1.55) * 0.055;
    const v = (0.33 + t * t * 0.56) * band;
    return [v, v * 0.965, v * 0.925];
  };

  return mergeOrThrow([
    // Buried skirt. Same rule as every plinth here: the ground under a 3m
    // footprint is not flat, and a metre below y = 0 hides the disagreement.
    lump(0x4b1d77, [1.45, 1.15, 1.18], [0, -0.15, 0], shade, {
      rot: [0.05, 0.4, -0.06],
      squashY: 0.9,
    }),
    lump(0x91c2e5, [1.0, 4.2, 0.74], [0, 4.1, 0], shade, { rot: [0, 0.2, 0.04] }),
    lump(0x2f7ab4, [0.78, 2.2, 0.58], [0.22, 9.0, 0.1], shade, {
      rot: [0.03, -0.5, -0.1],
    }),
    lump(0xd3410a, [0.46, 1.15, 0.36], [0.42, 11.6, 0.16], shade, {
      rot: [0, 1.1, 0.22],
    }),
  ]);
}

/* ── Dead Mile ────────────────────────────────────────────────────── */

/**
 * Pipeline on trestles — the circuit's name written along the verge.
 *
 * Linked and continuous, so it runs unbroken for the whole outbound leg and
 * then stops. Two pipes rather than one: a single tube at this distance is a
 * line, and two at different heights is plumbing.
 */
function pipeRun(span: number): THREE.BufferGeometry {
  const pipe: Rgb = [0.72, 0.68, 0.6];
  const small: Rgb = [0.5, 0.44, 0.38];
  const steel: Rgb = [0.42, 0.4, 0.38];
  const foot: Rgb = [0.3, 0.28, 0.26];
  return mergeOrThrow([
    cyl(0.55, span, [span * 0.5, 2.3, 0], pipe, {
      segments: 6,
      open: true,
      axis: "x",
    }),
    cyl(0.3, span, [span * 0.5, 1.55, 0.8], small, {
      segments: 6,
      open: true,
      axis: "x",
    }),
    part(0.28, 2.4, 0.28, [0.3, 1.2, 0.75], steel),
    part(0.28, 2.4, 0.28, [0.3, 1.2, -0.75], steel),
    part(0.3, 0.25, 2.1, [0.3, 2.45, 0], steel),
    part(1.6, 0.6, 2.4, [0.3, -0.1, 0], foot),
  ]);
}

/** Pumping station — 8.4m skid, vessel and stack. Punctuates the pipeline. */
function pumpStation(): THREE.BufferGeometry {
  const deck: Rgb = [0.4, 0.38, 0.36];
  const vessel: Rgb = [0.76, 0.72, 0.64];
  const house: Rgb = [0.58, 0.5, 0.4];
  const steel: Rgb = [0.44, 0.42, 0.4];
  const foot: Rgb = [0.28, 0.27, 0.26];
  return mergeOrThrow([
    part(8.0, 1.2, 6.0, [0, -0.5, 0], foot),
    part(7.0, 0.8, 5.0, [0, 0.2, 0], deck),
    cyl(1.5, 5.2, [-1.6, 3.4, 0], vessel, { segments: 8 }),
    part(3.2, 2.8, 3.0, [2.0, 2.0, 0], house),
    part(0.7, 5.5, 0.7, [2.6, 5.6, -0.9], steel),
    part(7.0, 0.16, 0.12, [0, 1.7, 2.5], steel),
  ]);
}

/**
 * Distance marker — a post and a plate, facing the road.
 *
 * The cheapest structure in the set and the one doing the most work: on the
 * return leg there is no pipeline, so these are the only thing telling you how
 * far is left, which is the difference between "a long road" and "a haul".
 */
function distanceMarker(): THREE.BufferGeometry {
  const post: Rgb = [0.36, 0.34, 0.32];
  const plate: Rgb = [0.92, 0.88, 0.8];
  const chevron: Rgb = [1.0, 0.66, 0.2];
  return mergeOrThrow([
    part(0.5, 0.6, 0.5, [0, -0.15, 0], post),
    part(0.22, 3.4, 0.22, [0, 1.7, 0], post),
    part(1.5, 0.9, 0.1, [0, 3.0, 0.14], plate),
    part(1.5, 0.22, 0.13, [0, 2.4, 0.15], chevron),
  ]);
}

/* ── Cinder Bowl ──────────────────────────────────────────────────── */

/**
 * Burnt-out kiln, part collapsed.
 *
 * A light touch on purpose: Cinder Bowl is a circuit that already reads, and
 * the brief on it is "keep it recognisable". One family, a handful of instances
 * in the mid ground, enough to say the ash underfoot came from somewhere.
 */
function kilnShell(): THREE.BufferGeometry {
  const base: Rgb = [0.3, 0.26, 0.24];
  const shell: Rgb = [0.56, 0.46, 0.4];
  const burnt: Rgb = [0.36, 0.3, 0.28];
  return mergeOrThrow([
    cyl(4.4, 1.6, [0, 0.2, 0], base),
    cyl(3.6, 6.4, [0, 4.2, 0], shell),
    part(3.0, 1.2, 2.0, [1.6, 7.2, 0.6], burnt, 0.4),
    // The spill was a 4.0 x 0.8 x 2.6 box, which is a crate of ash rather than a
    // heap of it. A squashed lump costs the same 20 triangles and is the one
    // part of this family that is not something anybody built.
    lump(
      0x5ea72c,
      [2.3, 0.62, 1.5],
      [-4.6, 0.28, 1.4],
      (y) => {
        const t = Math.min(1, Math.max(0, y / 0.9));
        const v = 0.46 + t * 0.34;
        return [v, v * 0.94, v * 0.86];
      },
      { rot: [0, 0.9, 0.08], squashY: 0.7, lo: 0.62, range: 0.6 },
    ),
    part(1.0, 3.4, 1.0, [-2.6, 6.0, -2.2], burnt, 0.2),
  ]);
}

/**
 * The catalogue.
 *
 * `span` is the circuit's median anchor spacing, supplied by the builder. Only
 * the linked families use it; the rest ignore it, which is why it is a
 * parameter on every entry rather than a second registry.
 */
export const SETPIECE_GEOMETRY: Record<
  SetpieceShape,
  (span: number) => THREE.BufferGeometry
> = {
  slagWall,
  furnaceStack: () => furnaceStack(),
  furnaceTap: () => furnaceTap(),
  chokeGate: () => chokeGate(),
  wreckStack: () => wreckStack(),
  containerWall,
  craneArm: () => craneArm(),
  monolith: () => monolith(),
  pipeRun,
  pumpStation: () => pumpStation(),
  distanceMarker: () => distanceMarker(),
  kilnShell: () => kilnShell(),
};

/** Bounding sphere of a built geometry, for the per-instance cull. */
export function boundsOf(g: THREE.BufferGeometry): {
  radius: number;
  midY: number;
} {
  g.computeBoundingBox();
  const b = g.boundingBox!;
  const midY = (b.min.y + b.max.y) * 0.5;
  const hx = Math.max(Math.abs(b.min.x), Math.abs(b.max.x));
  const hz = Math.max(Math.abs(b.min.z), Math.abs(b.max.z));
  const hy = (b.max.y - b.min.y) * 0.5;
  return { radius: Math.hypot(Math.hypot(hx, hz), hy), midY };
}
