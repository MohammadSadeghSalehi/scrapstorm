/**
 * Procedural geometry for the scatter fields and roadside furniture.
 *
 * Everything here is authored as ONE geometry per visual element, because the
 * whole point of the exercise is draw calls: a guard-rail post and its beam are
 * a single mesh so a kilometre of Armco is one InstancedMesh, not two.
 *
 * Nothing loads. Poly Haven props are available (see polyHavenAssets) and are
 * used for the hero set dressing, but a 1k-triangle photogrammetry boulder is
 * the wrong trade at a thousand instances — a 20-triangle faceted rock is
 * indistinguishable past ~15m and fifty times cheaper.
 *
 * Vertex colours carry two things the instance transform cannot: a baked
 * ambient-occlusion darkening toward the base (which is what stops an
 * unshadowed object reading as pasted onto the sand), and per-part tinting
 * inside a merged module, so one material can draw a dark post and a bright
 * galvanised beam.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { mulberry32 } from "./placement";

/**
 * Uniformly coloured box, ready to merge into a module.
 *
 * Exported for setpieces/, which builds its structures out of the same
 * primitive for the same reason: one merged geometry per structure family means
 * a circuit's worth of walls, stacks and gantries is one draw call. A second
 * copy of this helper over there would be a second place for the vertex-colour
 * convention (and the clearGroups() line, which is load-bearing) to drift.
 */
export function coloredBox(
  w: number,
  h: number,
  d: number,
  pos: [number, number, number],
  rgb: [number, number, number],
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(pos[0], pos[1], pos[2]);
  const n = g.attributes.position!.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    c[i * 3] = rgb[0];
    c[i * 3 + 1] = rgb[1];
    c[i * 3 + 2] = rgb[2];
  }
  g.setAttribute("color", new THREE.BufferAttribute(c, 3));
  // Groups only matter for multi-material meshes; merging drops them and the
  // module draws with one material, which is the entire point.
  g.clearGroups();
  return g;
}

export function mergeOrThrow(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  /*
   * mergeGeometries refuses a mix of indexed and non-indexed inputs, and it
   * refuses it by returning null with a console warning — so a module that
   * merges a box (indexed) with a warped icosahedron (non-indexed) does not
   * fail at the merge, it fails at whatever the caller does with the null.
   * Every prop below that combines a cylinder with a rock lump hits this.
   *
   * Flattening the indexed ones is the safe direction: it costs duplicated
   * vertices on parts that were sharing them, but it preserves the normals
   * already computed on each part, so a smooth-shaded column merged with a
   * flat-shaded lump keeps both shadings. Going the other way — welding the
   * non-indexed part — would smooth the facets that are the whole point of it.
   *
   * Uniform inputs (every set-piece family, the rail, the hoarding) take neither
   * branch and are byte-for-byte what they were.
   */
  const indexed = parts.filter((p) => p.index !== null).length;
  const flat =
    indexed === 0 || indexed === parts.length
      ? parts
      : parts.map((p) => (p.index ? p.toNonIndexed() : p));
  const merged = mergeGeometries(flat, false);
  // Dispose the conversions as well as the originals; `toNonIndexed` allocates.
  for (const p of flat) if (!parts.includes(p)) p.dispose();
  for (const p of parts) p.dispose();
  if (!merged) throw new Error("scatter: geometry merge failed");
  return merged;
}

/**
 * Write a vertex colour per vertex, from a function of its position.
 *
 * The ramps in this file were each open-coded over `attributes.position`, which
 * is fine until one of them forgets `needsUpdate` or reads the position
 * attribute after a translate. One painter, applied AFTER the geometry is in its
 * final local pose, means "bright just above the ground" is a statement about
 * where the ground is rather than about which primitive happened to build the
 * part.
 */
export function paintVertices(
  g: THREE.BufferGeometry,
  at: (x: number, y: number, z: number) => [number, number, number],
): THREE.BufferGeometry {
  const p = g.attributes.position as THREE.BufferAttribute;
  const c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const [r, gr, b] = at(p.getX(i), p.getY(i), p.getZ(i));
    c[i * 3] = r;
    c[i * 3 + 1] = gr;
    c[i * 3 + 2] = b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(c, 3));
  g.clearGroups();
  return g;
}

/**
 * A box that is rotated about all three axes before it is placed.
 *
 * `coloredBox` translates immediately, so a caller that wants a tilted part has
 * to rotate first or the rotation orbits the part around the module's origin
 * instead of spinning it where it stands. setpieces/geometry.ts carries a `part`
 * helper that does this for yaw only; a lamp arm curves in the YZ plane and a
 * sign chevron leans about Z, so the general form lives here with the rest of
 * the shared convention.
 */
export function orientedBox(
  w: number,
  h: number,
  d: number,
  pos: [number, number, number],
  rgb: [number, number, number],
  rot: [number, number, number] = [0, 0, 0],
): THREE.BufferGeometry {
  const g = coloredBox(w, h, d, [0, 0, 0], rgb);
  if (rot[0] || rot[1] || rot[2]) {
    // Intrinsic XYZ, matching THREE.Euler's default order, so a caller reading
    // these numbers back against an Euler gets the same orientation.
    g.rotateX(rot[0]);
    g.rotateY(rot[1]);
    g.rotateZ(rot[2]);
  }
  g.translate(pos[0], pos[1], pos[2]);
  return g;
}

/**
 * Low-segment cylinder or cone, coloured like a box part.
 *
 * Segment counts stay at 6-8 everywhere this is used. A hexagonal lamp column is
 * indistinguishable from a round one past about 6m and costs a third of the
 * triangles, and there are a hundred of them on a circuit.
 *
 * `open` drops both caps, which is right for a pipe or a light cone and wrong
 * for anything you can see the end of.
 */
export function coloredCylinder(
  rTop: number,
  rBottom: number,
  height: number,
  pos: [number, number, number],
  rgb: [number, number, number],
  opts: { segments?: number; open?: boolean; rot?: [number, number, number] } = {},
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(
    rTop,
    rBottom,
    height,
    opts.segments ?? 6,
    1,
    opts.open ?? false,
  );
  const rot = opts.rot;
  if (rot) {
    g.rotateX(rot[0]);
    g.rotateY(rot[1]);
    g.rotateZ(rot[2]);
  }
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

/**
 * Warped icosahedron — the shape every natural lump in this project is made of.
 *
 * Extracted from `rockGeometry` so a boulder, a cactus's swollen base and Sable
 * Run's basalt remnants are the same primitive at different scales, rather than
 * the remnants being what they were: four axis-aligned cuboids standing in for
 * rock, on the one circuit with nothing else to look at.
 *
 * Returns the raw warped solid, centred on the origin and unnormalised, with NO
 * vertex colours — the caller decides where its contact darkening goes, because
 * "down" is not the same direction for a boulder and for a leaning spire.
 *
 * PolyhedronGeometry is non-indexed, so each of the twelve corners appears three
 * to five times in the buffer. Displacing per *vertex* would move those copies
 * independently and split the solid into twenty floating triangles; keying the
 * displacement on the quantised position keeps shared corners welded.
 */
export function facetedRock(
  seed: number,
  opts: { squashY?: number; lo?: number; range?: number } = {},
): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const squashY = opts.squashY ?? 0.72;
  const lo = opts.lo ?? 0.62;
  const range = opts.range ?? 0.55;

  const rng = mulberry32(seed);
  const warp = new Map<string, number>();
  const key = (x: number, y: number, z: number) =>
    `${Math.round(x * 1e3)},${Math.round(y * 1e3)},${Math.round(z * 1e3)}`;

  for (let i = 0; i < pos.count; i++) {
    const k = key(pos.getX(i), pos.getY(i), pos.getZ(i));
    let f = warp.get(k);
    if (f === undefined) {
      f = lo + rng() * range;
      warp.set(k, f);
    }
    pos.setXYZ(i, pos.getX(i) * f, pos.getY(i) * f * squashY, pos.getZ(i) * f);
  }
  pos.needsUpdate = true;

  // Non-indexed + computeVertexNormals gives per-face normals, i.e. flat
  // shading without paying for the derivative instructions `flatShading` adds.
  g.computeVertexNormals();
  return g;
}

/**
 * Faceted desert rock, unit height, base at y = 0.
 *
 * 20 triangles. Per-instance non-uniform scale and yaw supply the variety that
 * would otherwise cost extra geometry buckets — and therefore extra draw calls.
 */
export function rockGeometry(): THREE.BufferGeometry {
  // Squashed on Y: boulders sit, they do not stand.
  const g = facetedRock(0x51c7a3, { squashY: 0.72 });

  g.computeBoundingBox();
  const bb = g.boundingBox!;
  g.translate(0, -bb.min.y, 0);
  const height = Math.max(1e-3, bb.max.y - bb.min.y);
  g.scale(1 / height, 1 / height, 1 / height);

  // Baked contact darkening. These cast no shadow (see ScatterField), so
  // without it a rock is uniformly lit on all sides and floats off the sand.
  const p2 = g.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(p2.count * 3);
  for (let i = 0; i < p2.count; i++) {
    const t = Math.min(1, Math.max(0, p2.getY(i)));
    const v = 0.52 + t * 0.48;
    col[i * 3] = v;
    col[i * 3 + 1] = v * 0.99;
    col[i * 3 + 2] = v * 0.96;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}

/**
 * Dead scrub tuft — a fan of tapered blades, unit height, base at y = 0.
 *
 * Blades rather than the usual crossed alpha-cards: there is no foliage texture
 * in this project, and an untextured crossed quad reads as exactly what it is,
 * two intersecting rectangles. Seven triangles have a real silhouette from
 * every angle and need no alpha test, so the tuft stays in the opaque pass.
 */
export function scrubGeometry(blades = 7): THREE.BufferGeometry {
  const rng = mulberry32(0x9d31f2);
  const pos: number[] = [];
  const col: number[] = [];

  const base: [number, number, number] = [0.30, 0.26, 0.15];
  const tip: [number, number, number] = [1.0, 0.92, 0.62];

  for (let i = 0; i < blades; i++) {
    const az = (i / blades) * Math.PI * 2 + rng() * 0.5;
    const dx = Math.cos(az);
    const dz = Math.sin(az);
    // Perpendicular, so the blade has width across its own facing direction.
    const px = -dz;
    const pz = dx;

    const halfW = 0.045 + rng() * 0.045;
    const root = 0.06 + rng() * 0.1;
    const h = 0.55 + rng() * 0.45;
    const lean = 0.22 + rng() * 0.38;

    const ax = dx * root;
    const az0 = dz * root;
    const tx = dx * lean;
    const tz = dz * lean;

    pos.push(
      ax + px * halfW, 0, az0 + pz * halfW,
      ax - px * halfW, 0, az0 - pz * halfW,
      tx, h, tz,
    );
    col.push(...base, ...base, ...tip);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  // uv is unused by the scrub material but keeps the attribute set uniform if
  // this geometry is ever merged with a boxed module.
  g.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2),
  );
  return g;
}

/**
 * Wind-drifted scrap — a cluster of flat panels half-buried in sand, unit
 * footprint, resting on y = 0.
 *
 * The cluster is baked into the geometry rather than instanced per panel: one
 * drift is one instance, so the field is one draw call instead of four.
 */
export function driftGeometry(panels = 4): THREE.BufferGeometry {
  const rng = mulberry32(0x2f8a41);
  const pos: number[] = [];
  const col: number[] = [];

  for (let i = 0; i < panels; i++) {
    const az = rng() * Math.PI * 2;
    const cx = (rng() - 0.5) * 1.1;
    const cz = (rng() - 0.5) * 1.1;
    const w = 0.28 + rng() * 0.4;
    const l = 0.34 + rng() * 0.5;
    // Panels lie nearly flat with one edge lifted, the way sheet metal settles
    // against a drift. A perfectly flat quad reads as a decal, not an object.
    const lift = 0.06 + rng() * 0.24;
    const c = Math.cos(az);
    const s = Math.sin(az);
    const ex = (x: number, z: number): [number, number] => [
      cx + x * c - z * s,
      cz + x * s + z * c,
    ];
    const [x0, z0] = ex(-w, -l);
    const [x1, z1] = ex(w, -l);
    const [x2, z2] = ex(w, l);
    const [x3, z3] = ex(-w, l);

    const dark: [number, number, number] = [0.42, 0.38, 0.33];
    const lit: [number, number, number] = [0.95, 0.9, 0.8];
    pos.push(x0, 0.01, z0, x1, 0.01, z1, x2, lift, z2);
    pos.push(x0, 0.01, z0, x2, lift, z2, x3, lift, z3);
    col.push(...dark, ...dark, ...lit, ...dark, ...lit, ...lit);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2),
  );
  return g;
}

/**
 * One Armco module: post at the local origin, beam running from it along local
 * +X to the NEXT post. Foot at y = 0.
 *
 * The beam spans [0, beamLen] rather than straddling the origin so a module can
 * be placed on one verge anchor and aimed at the next one. That is what makes
 * the rail a polyline through a corner instead of a ring of disconnected
 * tangent stubs — the difference is obvious on anything tighter than a sweeper.
 *
 * `beamLen` is the circuit's mean anchor spacing, passed in rather than fixed
 * because sample spacing differs per track; per-instance X scale then takes up
 * the local variation.
 */
export function railModuleGeometry(beamLen: number): THREE.BufferGeometry {
  const post: [number, number, number] = [0.30, 0.28, 0.25];
  const steel: [number, number, number] = [1.0, 0.99, 0.95];
  const rib: [number, number, number] = [0.62, 0.61, 0.58];
  const mid = beamLen * 0.5;
  return mergeOrThrow([
    coloredBox(0.14, 1.12, 0.14, [0, 0.56, 0], post),
    coloredBox(beamLen, 0.3, 0.075, [mid, 0.9, 0.09], steel),
    coloredBox(beamLen, 0.09, 0.05, [mid, 0.68, 0.11], rib),
  ]);
}

/**
 * Roadside hoarding, panel facing local +Z, feet at y = 0.
 *
 * The panel takes the full per-instance colour while the frame and the logo bar
 * are dark in vertex colour, so instancing one geometry still yields a row of
 * differently-liveried sponsor boards from a single draw call.
 */
export function boardGeometry(): THREE.BufferGeometry {
  const frame: [number, number, number] = [0.20, 0.19, 0.18];
  const panel: [number, number, number] = [1, 1, 1];
  const bar: [number, number, number] = [0.1, 0.1, 0.11];
  return mergeOrThrow([
    coloredBox(0.16, 2.5, 0.16, [-1.85, 1.25, 0], frame),
    coloredBox(0.16, 2.5, 0.16, [1.85, 1.25, 0], frame),
    coloredBox(4.6, 1.55, 0.12, [0, 2.4, 0.02], panel),
    coloredBox(4.62, 0.34, 0.17, [0, 1.95, 0.02], bar),
    coloredBox(4.8, 0.14, 0.2, [0, 3.26, 0.02], frame),
  ]);
}

/* ── lamp posts ───────────────────────────────────────────────────────
 *
 * Everything below is authored in ONE convention, and it is the setpieces' one
 * rather than the rail's: LOCAL +Z FACES THE ROAD. A lamp arm reaches over the
 * carriageway and a sign plate is read from it, so both have a front, and the
 * placement code yaws them to point it at the racing line.
 *
 * The wire is the exception and uses the rail's convention (span along local
 * +X, aimed at the next post), because a catenary is a link between two anchors
 * rather than an object with a facing.
 */

/**
 * Height of the lamp column's shaft, and where the arm leaves it.
 *
 * 7.95m of column and 0.78m of rise across the arm puts the lantern at 8.73m.
 * That is not a styling number: `LAMP_REACH` below carries it back over the
 * gravel run-off, and a car that gets airborne off a jump section has to pass
 * UNDER it. 8.7m is roughly six car-heights, which is well past anything the
 * launch-speed table can produce.
 */
const LAMP_SHAFT_H = 7.95;
/** Horizontal reach of the arm, from the column centre toward the road. */
export const LAMP_REACH = 2.42;
/** Lantern centre in the module's local frame — where the light appears to come from. */
export const LAMP_HEAD: [number, number, number] = [0, 8.73, LAMP_REACH];
/**
 * Where a catenary is tied off, in the module's local frame.
 *
 * On the crossarm, on the side AWAY from the road (-Z). Wires that cross the
 * carriageway would be geometry over the racing line with no collider under it,
 * which is the same trap chokeGate's missing top beam exists to avoid — and a
 * wire is worse than a beam, because nobody expects to be able to hit one.
 */
export const LAMP_WIRE_TIE: [number, number, number] = [0, 7.62, -0.92];

/**
 * Highway lamp column: footing, shear collar, tapered shaft, curved arm,
 * lantern, and a crossarm for the distribution line. ~120 triangles.
 *
 * The shaft is a six-sided cylinder rather than a box for the reason the whole
 * "remove the cubes" pass exists: a lamp post is the most familiar object on the
 * roadside, and a square one reads as a mistake in a way a square wall does not.
 * Six segments is enough — the silhouette is 15cm wide on screen at any range
 * where the facet count could be counted.
 *
 * The collar at 0.62m is the frangible shear coupling, and it is drawn because
 * it is the visual justification for the collider breaking at 4 m/s (see
 * setpieceColliders). A column that snaps at its base without one would read as
 * the world being flimsy rather than as the post doing its job.
 */
export function lampPostGeometry(): THREE.BufferGeometry {
  const dark: [number, number, number] = [0.26, 0.25, 0.24];
  const shaft: [number, number, number] = [0.72, 0.70, 0.66];
  const arm: [number, number, number] = [0.60, 0.58, 0.55];
  const lantern: [number, number, number] = [0.40, 0.39, 0.37];
  const cap: [number, number, number] = [0.84, 0.80, 0.72];

  const parts: THREE.BufferGeometry[] = [
    // Extends below y = 0. The dune profile climbs the moment you leave the
    // tarmac, so a footing placed at the ground height of its centre floats on
    // one side unless it is buried — the same skirt rule every set piece obeys.
    coloredBox(0.66, 0.74, 0.66, [0, -0.22, 0], dark),
    coloredBox(0.30, 0.24, 0.30, [0, 0.60, 0], dark),
    coloredCylinder(0.115, 0.175, LAMP_SHAFT_H, [0, LAMP_SHAFT_H * 0.5, 0], shaft, {
      segments: 6,
    }),
    // Crossarm and insulator, on the far side from the road.
    coloredBox(0.10, 0.10, 1.15, [0, 7.45, -0.5], dark),
    coloredBox(0.11, 0.16, 0.11, [0, 7.56, -0.92], cap),
  ];

  /*
   * The arm, as four straight segments along a curve.
   *
   * `z` runs a little slower than linear at the root and `y` decelerates into
   * the tip, which between them is the shape of a cast lamp bracket: it leaves
   * the column climbing and arrives over the road nearly level. A single
   * straight strut is the cheap version and it reads as scaffolding.
   */
  const SEG = 4;
  const armPt = (t: number): [number, number] => [
    LAMP_SHAFT_H + 0.78 * (1 - (1 - t) * (1 - t)),
    LAMP_REACH * Math.pow(t, 1.15),
  ];
  for (let i = 0; i < SEG; i++) {
    const [y0, z0] = armPt(i / SEG);
    const [y1, z1] = armPt((i + 1) / SEG);
    const dy = y1 - y0;
    const dz = z1 - z0;
    const len = Math.hypot(dy, dz);
    // A rotation about +X takes local +Z to (0, -sin a, cos a), so this aims the
    // segment's long axis down the chord.
    parts.push(
      orientedBox(
        0.13,
        0.13,
        len * 1.06,
        [0, (y0 + y1) * 0.5, (z0 + z1) * 0.5],
        arm,
        [-Math.atan2(dy, dz), 0, 0],
      ),
    );
  }

  // Lantern, pitched 9 degrees nose-down so its aperture faces the road rather
  // than the horizon.
  parts.push(
    orientedBox(0.54, 0.20, 0.96, [LAMP_HEAD[0], LAMP_HEAD[1], LAMP_HEAD[2]], lantern, [
      0.16, 0, 0,
    ]),
  );
  return mergeOrThrow(parts);
}

/**
 * What the lamp emits, as geometry. ~44 triangles, additive, no light source.
 *
 * ── why this is not a light ───────────────────────────────────────────
 *
 * A real point light per lamp is out by a factor of a hundred: three uploads the
 * whole light list to every lit material, and the fragment cost is per-light
 * per-pixel on a tier that has been measured at 25fps. Even a pooled handful is
 * a trap, because the pool SIZE is baked into every compiled shader — changing
 * how many lights exist recompiles every material in the scene, so a pool that
 * grew or shrank with the quality tier would hitch the whole world mid-race on
 * exactly the machines that triggered the tier change.
 *
 * So the light is drawn instead of computed, in two parts:
 *
 *  - a lens blob at the lantern, which is the source you can see; and
 *  - an open cone flaring from under the lantern down PAST the ground, whose
 *    vertex colours peak just above y = 0.
 *
 * The cone is doing the real work. Additive and double-sided, its near and far
 * walls both add, so the middle is brighter than the edges without a gradient
 * texture; and because its bottom rim is buried 0.9m below the base, the bright
 * band lands ON the ground on a slope instead of hovering over it on the high
 * side. A flat disc was the obvious alternative and it cannot survive the dune
 * profile: over a 6m radius the ground moves far enough that half the pool
 * floats.
 *
 * What this does NOT do is illuminate anything. Nothing else in the scene gets
 * brighter for standing near a lamp. It is a painted pool of light, and at
 * racing speed against a 0.14-intensity moon that is the part the eye reads.
 */
export function lampGlowGeometry(): THREE.BufferGeometry {
  const [hx, hy, hz] = LAMP_HEAD;

  const lens = new THREE.IcosahedronGeometry(0.34, 0);
  lens.scale(1, 0.46, 1);
  lens.translate(hx, hy - 0.16, hz);
  paintVertices(lens, () => [1, 0.97, 0.9]);

  /*
   * Open cone, top at the lantern, rim buried below the footing.
   *
   * Twelve segments: this is a soft blended shape whose edge is never sharp, so
   * facets are invisible in a way they are not on a lit solid.
   */
  const TOP_Y = hy - 0.24;
  /*
   * 1.6m below the column's own base, not a token skirt.
   *
   * The rim has to stay buried on the DOWNHILL side of the pool as well as the
   * uphill one. The lamp's base height is sampled at its own footing, and the
   * dune profile can be a metre lower six metres away — if the rim surfaced
   * there, the bright band would be left hanging in the air as a ring, which is
   * a far worse artefact than the pool being slightly small.
   */
  const BOTTOM_Y = -1.6;
  const H = TOP_Y - BOTTOM_Y;
  const cone = new THREE.CylinderGeometry(0.42, 6.4, H, 12, 1, true);
  cone.translate(hx, BOTTOM_Y + H * 0.5, hz);
  paintVertices(cone, (_x, y) => {
    /*
     * Zero at the buried rim, peaking just clear of the ground, then falling
     * away up the shaft. The rise to the peak is what hides the intersection
     * with the terrain: wherever the cone happens to cut the surface, it is
     * already fading, so the cut is a soft edge rather than a drawn line.
     */
    const v =
      y < 0.35
        ? Math.max(0, (y - BOTTOM_Y) / (0.35 - BOTTOM_Y)) * 0.95
        : 0.95 * Math.exp(-(y - 0.35) / 3.4) + 0.06;
    return [v, v * 0.96, v * 0.88];
  });

  return mergeOrThrow([lens, cone]);
}

/**
 * One catenary span: tied off at the local origin, running to the next tie at
 * local +X. 48 triangles.
 *
 * Two conductors, because one tube at 40 m/s is a line and two at different
 * heights is plumbing — the same call `pipeRun` makes. Each is swept as a CROSS
 * of two ribbons rather than a tube: a tube at this radius costs six times the
 * triangles to describe a silhouette that is under two pixels wide, while a
 * cross has a silhouette from every angle and cannot disappear edge-on the way a
 * single ribbon does.
 *
 * The sag is a parabola, not a true catenary. Over the spans here the two differ
 * by under a centimetre, and the parabola is one multiply.
 *
 * `span` is the circuit's mean lamp spacing; per-instance X scale takes up the
 * local variation and deliberately does NOT scale the sag with it. A longer span
 * really would hang lower, but the error is centimetres against a 1.4m droop and
 * the alternative is a geometry per span length, which is a draw call per span.
 */
export function catenaryWireGeometry(span: number): THREE.BufferGeometry {
  const SEG = 6;
  const T = 0.05;
  const pos: number[] = [];
  const col: number[] = [];

  const quad = (
    v: [number, number, number][],
    rgb: [number, number, number],
  ) => {
    pos.push(...v[0]!, ...v[1]!, ...v[2]!, ...v[0]!, ...v[2]!, ...v[3]!);
    for (let i = 0; i < 6; i++) col.push(...rgb);
  };

  const conductor = (
    zOff: number,
    yOff: number,
    sag: number,
    rgb: [number, number, number],
  ) => {
    for (let i = 0; i < SEG; i++) {
      const t0 = i / SEG;
      const t1 = (i + 1) / SEG;
      const x0 = span * t0;
      const x1 = span * t1;
      const y0 = yOff - sag * 4 * t0 * (1 - t0);
      const y1 = yOff - sag * 4 * t1 * (1 - t1);
      // Vertical ribbon, then horizontal. Together they read as one round wire.
      quad(
        [
          [x0, y0 - T, zOff],
          [x0, y0 + T, zOff],
          [x1, y1 + T, zOff],
          [x1, y1 - T, zOff],
        ],
        rgb,
      );
      quad(
        [
          [x0, y0, zOff - T],
          [x0, y0, zOff + T],
          [x1, y1, zOff + T],
          [x1, y1, zOff - T],
        ],
        rgb,
      );
    }
  };

  conductor(0, 0, span * 0.045, [0.30, 0.29, 0.28]);
  conductor(0.3, -0.42, span * 0.052, [0.22, 0.21, 0.2]);

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2),
  );
  return g;
}

/* ── roadside signage ─────────────────────────────────────────────────── */

/**
 * Half-width of the sign plate, and the height of its lower edge.
 *
 * The lower edge is the number that matters and 2.0m is not generous styling:
 * the collider is the POST only (see setpieceColliders), so at any height a car
 * can reach, the sign has to BE its post. A plate hanging at windscreen height
 * with nothing solid behind it is something you drive through, which is the
 * complaint this whole layer exists to answer.
 */
export const SIGN_PLATE_HALF_X = 1.21;
export const SIGN_PLATE_BASE_Y = 2.0;

/**
 * Circuit furniture: a chevron board on a single post. ~96 triangles.
 *
 * Deliberately UNTEXTURED, and the choice is worth recording because generated
 * sign artwork was the obvious alternative. Instanced signs need per-instance
 * atlas cells to say anything different from one another, three has no
 * per-instance UV without patching the shader, and a patch that silently fails
 * to apply gives every sign on the circuit the same face — a failure this
 * project has already shipped twice in the equivalent form (a fallback masking a
 * mesh that never decoded). Vertex-coloured devices cannot fail that way: the
 * chevron either exists in the buffer or the geometry does not build.
 *
 * The plate's face is left at vertex colour 1 so the MATERIAL colour comes
 * through unchanged, and the material takes `surfaces.stripe` — the one colour
 * in the environment that is authored as retroreflective and lifts back toward
 * white as the hour darkens. The post is at 0.28 so it takes only a quarter of
 * that lift, which is exactly how a sign behaves in headlights.
 */
export function signGeometry(): THREE.BufferGeometry {
  const dark: [number, number, number] = [0.24, 0.23, 0.22];
  const post: [number, number, number] = [0.28, 0.27, 0.26];
  const face: [number, number, number] = [1, 1, 1];
  const rail: [number, number, number] = [0.18, 0.17, 0.16];
  const amber: [number, number, number] = [1.0, 0.58, 0.1];
  const hazard: [number, number, number] = [0.92, 0.16, 0.08];

  const midY = SIGN_PLATE_BASE_Y + 0.66;
  return mergeOrThrow([
    coloredBox(0.46, 0.54, 0.46, [0, -0.18, 0], dark),
    coloredBox(0.14, SIGN_PLATE_BASE_Y + 1.4, 0.14, [0, (SIGN_PLATE_BASE_Y + 1.4) * 0.5, 0], post),
    coloredBox(SIGN_PLATE_HALF_X * 2, 1.32, 0.07, [0, midY, 0.1], face),
    coloredBox(SIGN_PLATE_HALF_X * 2 + 0.1, 0.1, 0.11, [0, midY + 0.7, 0.1], rail),
    coloredBox(SIGN_PLATE_HALF_X * 2 + 0.1, 0.1, 0.11, [0, midY - 0.7, 0.1], rail),
    // Chevron: an upper bar falling to the right and a lower one rising to it.
    // A rotation about +Z takes local +X to (cos a, sin a), so the signs of
    // these two angles are what point the device rather than splay it.
    orientedBox(1.5, 0.22, 0.04, [-0.06, midY + 0.26, 0.155], amber, [0, 0, -0.62]),
    orientedBox(1.5, 0.22, 0.04, [-0.06, midY - 0.26, 0.155], amber, [0, 0, 0.62]),
    coloredBox(SIGN_PLATE_HALF_X * 2, 0.16, 0.05, [0, midY - 0.53, 0.155], hazard),
  ]);
}

/* ── vegetation ───────────────────────────────────────────────────────── */

/**
 * Saguaro and a barrel cactus at its foot, unit height, base at y = 0.
 *
 * ~104 triangles for a stand, not for one plant: the companion is baked into the
 * geometry the same way `driftGeometry` bakes its panel cluster, so a field of
 * cactus stands is one instance each and one draw call in total rather than
 * three.
 *
 * The arms are the whole reason this is worth having. A columnar cactus with no
 * arms is a green post and reads as a mistake; the asymmetric pair — one high
 * and long, one low and short — is the entire silhouette, and it is what makes a
 * scatter field say "desert" rather than "scrub with something taller in it".
 * Per-instance yaw hides the fact that every stand has the same two arms.
 *
 * Barrel: a warped icosahedron rather than a squashed cylinder. It is the same
 * primitive the boulders use, it is 20 triangles either way, and a ribbed lump
 * is a much better barrel cactus than a hexagonal drum.
 */
export function cactusGeometry(): THREE.BufferGeometry {
  const shade: [number, number, number] = [0.34, 0.42, 0.28];
  const body: [number, number, number] = [0.72, 0.86, 0.58];

  /** Elbowed arm: a horizontal stub out of the trunk, then a vertical riser. */
  const arm = (
    side: number,
    outAt: number,
    reach: number,
    rise: number,
    r: number,
  ): THREE.BufferGeometry[] => [
    coloredCylinder(r, r * 1.05, reach + r * 2, [(side * reach) / 2, outAt, 0], body, {
      segments: 6,
      open: true,
      rot: [0, 0, Math.PI / 2],
    }),
    coloredCylinder(r * 0.72, r, rise, [side * reach, outAt + rise * 0.5 - r, 0], body, {
      segments: 6,
    }),
  ];

  const barrel = facetedRock(0x3cb15e, { squashY: 0.62, lo: 0.78, range: 0.34 });
  barrel.scale(0.42, 0.42, 0.42);
  barrel.translate(0.72, 0.2, 0.46);
  paintVertices(barrel, (_x, y) => {
    const t = Math.min(1, Math.max(0, y / 0.4));
    return [
      shade[0] + (body[0] - shade[0]) * t,
      shade[1] + (body[1] - shade[1]) * t,
      shade[2] + (body[2] - shade[2]) * t,
    ];
  });

  const g = mergeOrThrow([
    coloredCylinder(0.09, 0.26, 4.0, [0, 2.0, 0], body, { segments: 7 }),
    ...arm(1, 2.35, 0.58, 1.45, 0.125),
    ...arm(-1, 1.55, 0.44, 0.95, 0.105),
    barrel,
  ]);

  /*
   * Contact darkening plus a sun-facing lift, baked in for the same reason the
   * rocks carry it: nothing in these fields casts a shadow, and an object that
   * is uniformly lit from base to tip floats off the sand no matter how well it
   * is placed. The lift at the top is what separates a 4m column from the ridge
   * behind it when both are in the same haze.
   */
  const p = g.attributes.position as THREE.BufferAttribute;
  const c = g.attributes.color as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const t = Math.min(1, Math.max(0, p.getY(i) / 4.0));
    const k = 0.58 + t * 0.5;
    c.setXYZ(
      i,
      c.getX(i) * k,
      c.getY(i) * k,
      c.getZ(i) * Math.min(1, k * (1 - t * 0.12)),
    );
  }
  c.needsUpdate = true;

  g.computeBoundingBox();
  const bb = g.boundingBox!;
  g.translate(0, -bb.min.y, 0);
  const height = Math.max(1e-3, bb.max.y - bb.min.y);
  g.scale(1 / height, 1 / height, 1 / height);
  return g;
}
