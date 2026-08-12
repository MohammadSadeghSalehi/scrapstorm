/**
 * Procedural geometry for the three bespoke set pieces.
 *
 * Split from their components for the reason `scatter/geometry.ts` and
 * `setpieces/geometry.ts` are: a `.tsx` file cannot be loaded by jiti (its
 * transform does not take JSX), so geometry that lives beside a component
 * cannot be MEASURED headlessly. Every other family's footprint is guarded by
 * scripts/check-setpiece-footprints.mjs precisely because its builders are in a
 * plain module; these are now on the same footing, and scripts/probe-setpieces
 * reports their triangle counts from here rather than from a comment.
 *
 * Same rules as the other two geometry modules: boxes and low-segment
 * cylinders, vertex colours instead of materials, everything merged so a set
 * piece is one draw call.
 */
import * as THREE from "three";
import { CHASE } from "./camera/speedCurve";
import { coloredBox, coloredCylinder, mergeOrThrow } from "./scatter/geometry";
import { carrierDeckProfile, type CarrierRig as Rig } from "./carrier";
import type { TunnelBore } from "./tunnels";

/* ── start/finish gantry ──────────────────────────────────────────────── */

const STEEL: [number, number, number] = [0.16, 0.15, 0.14];
const STEEL_LIT: [number, number, number] = [0.3, 0.28, 0.26];
const PAINT: [number, number, number] = [0.92, 0.91, 0.88];
const PAINT_RED: [number, number, number] = [0.62, 0.11, 0.09];
const HOUSING: [number, number, number] = [0.05, 0.05, 0.055];

/**
 * Metres above the road plane that nothing overhead may descend below.
 *
 * Every term is the camera's, not a guess:
 *   0.55  the car's ride height — `CHASE` heights are measured from `target.y`
 *   7.2   heightBase
 *   1.5   heightGain, applied in full at the top of the speed range
 *   0.25  the hit punch, which fires on contact and is not rare on lap one
 *   0.52  shake: maxOffset 0.95 x the 0.55 vertical weighting
 *   0.06  the continuous high-speed rumble
 *   0.35  the camera's own near plane, so the slab cannot clip even if it is
 *         never actually intersected
 *   0.9   margin, because a beam that JUST clears reads as a near miss
 */
const GANTRY_CLEAR =
  0.55 + CHASE.heightBase + CHASE.heightGain + 0.25 + 0.95 * 0.55 + CHASE.rumble + 0.35 + 0.9;


/* ── signage atlas ────────────────────────────────────────────────────── */

/**
 * UV rects into the atlas, as [u0, v0, u1, v1].
 *
 * v is measured from the BOTTOM because that is what three's UVs mean, while
 * the canvas draws from the top — so the banner occupies the top half of the
 * canvas and the upper half of v. Getting this backwards puts the sponsor strip
 * on the gantry and the league name on the kerb, which is the kind of thing a
 * screenshot catches and a code reading does not.
 */
export const ATLAS_W = 1024;
export const ATLAS_H = 512;

export const UV = {
  banner: [0, 0.5, 1, 1] as const,
  startFinish: [0, 0.16, 0.5, 0.5] as const,
  sector: [0.5, 0.16, 1, 0.5] as const,
  lap: [0, 0, 1, 0.16] as const,
};

/**
 * A flat panel carrying one atlas rect, in the gantry's local frame.
 *
 * Rotation is applied BEFORE the translate, always. `BufferGeometry.rotateX`
 * spins about the geometry's own origin, so rotating a panel that has already
 * been moved to (0, 0.08, 3) swings it round to (0, -3, 0.08) — a road decal
 * that ends up buried edge-on three metres underground, and one that still
 * looks fine in the source.
 */
function panel(
  w: number,
  h: number,
  pos: [number, number, number],
  uv: readonly [number, number, number, number],
  rot: [number, number] = [0, 0],
): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const a = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < a.count; i++) {
    a.setXY(
      i,
      uv[0] + a.getX(i) * (uv[2] - uv[0]),
      uv[1] + a.getY(i) * (uv[3] - uv[1]),
    );
  }
  a.needsUpdate = true;
  if (rot[0]) g.rotateX(rot[0]);
  if (rot[1]) g.rotateY(rot[1]);
  g.translate(pos[0], pos[1], pos[2]);
  return g;
}

/* ── structure ────────────────────────────────────────────────────────── */

export function structureGeometry(width: number): {
  frame: THREE.BufferGeometry;
  signs: THREE.BufferGeometry;
  lightSlots: { x: number; y: number }[];
} {
  const half = width * 0.5 + 1.6;
  /** Underside of the lowest overhead member. Nothing hangs below this. */
  const top = GANTRY_CLEAR;
  /** Banner sits above the truss, so the truss height is a fixed 1.7m bay. */
  const trussTop = top + 1.7;
  const bannerW = Math.min(width * 0.78, 19);
  const bannerH = bannerW * 0.14;
  const bannerY = trussTop + 0.25 + bannerH * 0.5;
  const postTop = bannerY + bannerH * 0.5 + 0.5;
  const parts: THREE.BufferGeometry[] = [];

  for (const side of [-1, 1] as const) {
    // Column, base plate, and a raked brace back toward the verge — a portal
    // frame this tall with no brace reads as two poles and a stick.
    parts.push(coloredBox(0.42, postTop, 0.42, [side * half, postTop * 0.5, 0], STEEL));
    parts.push(coloredBox(1.5, 0.5, 1.5, [side * half, 0.25, 0], STEEL_LIT));
    const brace = coloredBox(0.26, 5.2, 0.26, [0, 0, 0], STEEL);
    brace.rotateX(0.42);
    brace.translate(side * half, top * 0.3, -2.2);
    parts.push(brace);
  }
  // Twin chords with a lattice between them: the silhouette of a race gantry is
  // the truss, and a truss is what tells you how far away it is.
  parts.push(coloredBox(half * 2 + 0.42, 0.34, 0.34, [0, top + 0.17, -0.55], STEEL));
  parts.push(coloredBox(half * 2 + 0.42, 0.34, 0.34, [0, top + 0.17, 0.55], STEEL));
  parts.push(coloredBox(half * 2 + 0.42, 0.34, 0.34, [0, trussTop - 0.17, 0], STEEL));
  const bays = Math.max(6, Math.round(half * 0.9));
  for (let i = 0; i <= bays; i++) {
    const x = -half + (2 * half * i) / bays;
    const d = coloredBox(0.16, 2.05, 0.16, [0, 0, 0], STEEL);
    d.rotateZ(i % 2 === 0 ? 0.55 : -0.55);
    d.translate(x, (top + trussTop) * 0.5, 0);
    parts.push(d);
  }

  /*
   * Road paint. Thin boxes on the tarmac rather than a ground plane — a
   * full-width plane at the start line filled the chase FOV as a white wall,
   * which is why the previous pass removed it. Kept, and merged into the same
   * geometry so it stops being two more draw calls.
   */
  const paintW = Math.min(width * 0.62, 14);
  parts.push(coloredBox(paintW, 0.05, 0.6, [0, 0.045, 1.4], PAINT));
  parts.push(coloredBox(paintW, 0.05, 0.3, [0, 0.045, 2.2], PAINT_RED));

  /*
   * Light tree: five columns of two pods, hung on the LEADING face of the truss
   * so they are the first thing lit and the first thing read. The housings are
   * part of the merged frame; only the ten lenses are instanced, because only
   * they change colour.
   */
  const treeW = Math.min(9.5, width * 0.5);
  parts.push(coloredBox(treeW + 0.8, 0.42, 0.42, [0, trussTop - 0.1, -0.62], HOUSING));

  const slots: { x: number; y: number }[] = [];
  for (let i = 0; i < 5; i++) {
    const x = -treeW * 0.5 + (treeW * i) / 4;
    slots.push({ x, y: trussTop - 0.72 });
    slots.push({ x, y: trussTop - 1.34 });
    parts.push(coloredBox(0.66, 1.5, 0.3, [x, trussTop - 1.0, -0.7], HOUSING));
  }

  /*
   * Sign panels.
   *
   * The banner faces the ONCOMING car (local -Z, because the gantry is yawed to
   * the sample's own heading and traffic arrives from -Z) and a second copy
   * faces the other way, so the gantry is not blank on the run down to it from
   * the far side. Everything overhead is above GANTRY_CLEAR by construction —
   * the only panel below it is the road decal, which is on the tarmac.
   */
  const signs: THREE.BufferGeometry[] = [
    panel(bannerW, bannerH, [0, bannerY, -0.3], UV.banner),
    panel(bannerW, bannerH, [0, bannerY, 0.3], UV.banner, [0, Math.PI]),
    panel(3.4, 1.15, [0, top + 0.75, -0.62], UV.startFinish),
    panel(4.6, 1.55, [-half - 0.24, 5.4, 0], UV.sector, [0, -Math.PI / 2]),
    panel(4.6, 1.55, [half + 0.24, 5.4, 0], UV.sector, [0, Math.PI / 2]),
    // Chevron strip laid flat on the tarmac, ahead of the two paint bars.
    panel(paintW, 1.1, [0, 0.055, 3.2], UV.lap, [-Math.PI / 2, 0]),
  ];
  // Plate backing so the panels are not paper-thin from the side.
  parts.push(coloredBox(bannerW + 0.3, bannerH + 0.3, 0.42, [0, bannerY, 0], STEEL));
  parts.push(coloredBox(3.7, 1.4, 0.18, [0, top + 0.75, -0.53], STEEL));

  return {
    frame: mergeOrThrow(parts),
    signs: mergeOrThrow(signs),
    lightSlots: slots,
  };
}


/* ── tunnel bores ────────────────────────────────────────────── */

/** Concrete in shade. Not black: a black wall has no silhouette against fog. */
const WALL_IN: [number, number, number] = [0.1, 0.098, 0.092];
/** The outside of the box, which stands in daylight. */
const WALL_OUT: [number, number, number] = [0.36, 0.335, 0.3];
/** Portal headwall face — lighter still, so the mouth reads from 200m out. */
const PORTAL: [number, number, number] = [0.46, 0.43, 0.39];

/**
 * A box spanning two world points, offset laterally, in world space.
 *
 * Segments are extended by `overlap` at each end so the mitre gaps a chain of
 * boxes leaves on a curve are buried inside the neighbouring box rather than
 * being a slot you can see daylight through from inside a tunnel.
 */
function segBox(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  offset: number,
  width: number,
  y0: number,
  y1: number,
  rgb: [number, number, number],
  overlap = 0.2,
): THREE.BufferGeometry | null {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len < 1e-3) return null;
  const ux = dx / len;
  const uz = dz / len;
  // Right of travel, matching the sample frame the bore points carry.
  const rx = -uz;
  const rz = ux;
  const cx = (ax + bx) * 0.5 + rx * offset;
  const cz = (az + bz) * 0.5 + rz * offset;
  const g = coloredBox(width, y1 - y0, len + overlap * 2, [0, 0, 0], rgb);
  g.rotateY(Math.atan2(ux, uz));
  g.translate(cx, (y0 + y1) * 0.5, cz);
  return g;
}

/**
 * `stride` spans two or three bore stations per box instead of one.
 *
 * The low tier's budget is draw calls, but it is not made of nothing, so the
 * bore is also the cheapest thing here to coarsen: skipping a station doubles
 * the box length and the only artefact is the mitre at the joint. On the
 * tightest bore in the catalogue (Rustline, ~155m radius) a 6.2m box chords its
 * arc by 3.1cm, which is a tenth of the 0.2m the boxes already overlap by. It is
 * geometrically free and it halves the triangles.
 */
export function boreGeometry(t: TunnelBore, stride = 1): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const wt = t.wallThick;
  const cap = t.capThick;
  const step = Math.max(1, Math.round(stride));

  for (let i = 0; i < t.pts.length - 1; i += step) {
    const a = t.pts[i]!;
    const b = t.pts[Math.min(i + step, t.pts.length - 1)]!;
    const hw = (a.hw + b.hw) * 0.5;
    const y0 = Math.min(a.y, b.y) - 1.2;
    const roof = t.baseY + t.clearance;

    for (const side of [-1, 1] as const) {
      // Inner leaf: the face you actually drive past, painted for shade.
      const inner = segBox(
        a.x, a.z, b.x, b.z,
        side * (hw + 0.3), 0.6, y0, roof, WALL_IN,
      );
      if (inner) parts.push(inner);
      // Outer leaf, in daylight. Two thin boxes rather than one thick one so
      // the two faces can be different colours out of one vertex-coloured
      // material — a single box would have to pick one.
      const outer = segBox(
        a.x, a.z, b.x, b.z,
        side * (hw + 0.3 + wt * 0.5), wt, y0, roof + cap, WALL_OUT,
      );
      if (outer) parts.push(outer);
    }

    // Soffit — the underside is what the headlights and the strip lights read
    // against, so it is its own thin dark leaf under the structural slab.
    const soffit = segBox(
      a.x, a.z, b.x, b.z,
      0, (hw + 0.6) * 2, roof - 0.35, roof, WALL_IN,
    );
    if (soffit) parts.push(soffit);
    const slab = segBox(
      a.x, a.z, b.x, b.z,
      0, (hw + 0.6 + wt) * 2, roof, roof + cap, WALL_OUT,
    );
    if (slab) parts.push(slab);
  }

  /*
   * Portal headwalls.
   *
   * A bore with no headwall is a hole in nothing: the eye needs a face for the
   * opening to be an opening. Built as two piers and a lintel rather than a
   * pierced slab, because a hole in a box is not something BoxGeometry does and
   * a portal is exactly three boxes.
   */
  for (const end of [0, t.pts.length - 1]) {
    const p = t.pts[end]!;
    const roof = t.baseY + t.clearance;
    const top = roof + t.capThick + 0.9;
    /*
     * `segBox` lays its box ALONG a->b, so passing the two LATERAL extremes
     * makes the length axis run across the road and the `width` argument the
     * thickness along it. That is what a headwall is: a slab across the mouth,
     * a metre and a half thick.
     */
    const px = (o: number) => p.x + p.rx * o;
    const pz = (o: number) => p.z + p.rz * o;
    for (const side of [-1, 1] as const) {
      const inner = (p.hw + 0.3) * side;
      const outer = (p.hw + 1.9) * side;
      const pier = segBox(
        px(Math.min(inner, outer)), pz(Math.min(inner, outer)),
        px(Math.max(inner, outer)), pz(Math.max(inner, outer)),
        0, 1.5, p.y - 1.2, top, PORTAL, 0,
      );
      if (pier) parts.push(pier);
    }
    const lintel = segBox(
      px(-(p.hw + 1.9)), pz(-(p.hw + 1.9)),
      px(p.hw + 1.9), pz(p.hw + 1.9),
      0, 1.5, roof, top, PORTAL, 0,
    );
    if (lintel) parts.push(lintel);
  }

  return mergeOrThrow(parts);
}

/**
 * Strip lights, as unlit emissive bars along the top of each wall.
 *
 * MeshBasicMaterial on purpose: these have to stay bright while
 * `TunnelAtmosphere` is pulling the scene lights down to a fifth. A
 * MeshStandardMaterial with an emissive would work too, but it would also be a
 * second lit material in a place where the whole point is that lighting is
 * being suppressed.
 */
export function lampGeometry(t: TunnelBore): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = [];
  const roof = t.baseY + t.clearance;
  const glow: [number, number, number] = [1, 0.86, 0.6];
  // One bar every ~9m, so a 38m bore gets four a side and the spacing reads as
  // speed when you pass under them.
  const step = 9;
  for (let d = step * 0.5; d < t.length; d += step) {
    // Walk the polyline to the point at arc length d.
    let i = 0;
    while (i < t.pts.length - 2 && t.pts[i + 1]!.d < d) i++;
    const a = t.pts[i]!;
    const b = t.pts[i + 1]!;
    const f = (d - a.d) / Math.max(1e-3, b.d - a.d);
    const x = a.x + (b.x - a.x) * f;
    const z = a.z + (b.z - a.z) * f;
    const rx = a.rx;
    const rz = a.rz;
    const hw = a.hw;
    for (const side of [-1, 1] as const) {
      const g = coloredBox(0.22, 0.18, 2.6, [0, 0, 0], glow);
      g.rotateY(Math.atan2(-rz, -rx));
      g.translate(x + rx * side * (hw - 0.05), roof - 0.75, z + rz * side * (hw - 0.05));
      parts.push(g);
    }
  }
  if (!parts.length) return null;
  return mergeOrThrow(parts);
}


/* ── car carrier ─────────────────────────────────────────────── */

type Rgb = [number, number, number];

const DECK: Rgb = [0.17, 0.16, 0.15];
const KERB: Rgb = [0.42, 0.23, 0.11];
const CHASSIS: Rgb = [0.3, 0.19, 0.13];
const CAB: Rgb = [0.46, 0.15, 0.1];
const GLASS: Rgb = [0.08, 0.11, 0.13];
const TYRE: Rgb = [0.06, 0.06, 0.065];

/** Deck plates along the run. Eight is where the stair-stepping stops reading. */
const DECK_SEGMENTS = 8;

export function carrierGeometry(c: Rig): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  /** three's rotateY(t) sends local +Z to (sin t, 0, cos t) — the heading. */
  const theta = Math.atan2(c.fx, c.fz);
  const deckAt = (u: number) => c.height * carrierDeckProfile(u / c.length);

  /** Place a box at local (u along, t lateral, y up), optionally pitched. */
  const box = (
    w: number,
    h: number,
    l: number,
    u: number,
    t: number,
    y: number,
    rgb: Rgb,
    pitch = 0,
  ) => {
    const g = coloredBox(w, h, l, [0, 0, 0], rgb);
    if (pitch) g.rotateX(-pitch);
    g.rotateY(theta);
    g.translate(
      c.x + c.fx * u + c.rx * t,
      c.y + y,
      c.z + c.fz * u + c.rz * t,
    );
    parts.push(g);
  };

  /** An inclined plate spanning the deck between two stations. */
  const plate = (
    u0: number,
    u1: number,
    width: number,
    thick: number,
    lift: number,
    lateral: number,
    rgb: Rgb,
  ) => {
    const y0 = deckAt(u0) + lift;
    const y1 = deckAt(u1) + lift;
    const du = u1 - u0;
    const dy = y1 - y0;
    box(
      width,
      thick,
      Math.hypot(du, dy) + 0.06,
      (u0 + u1) * 0.5,
      lateral,
      (y0 + y1) * 0.5,
      rgb,
      Math.atan2(dy, du),
    );
  };

  for (let i = 0; i < DECK_SEGMENTS; i++) {
    const u0 = (c.length * i) / DECK_SEGMENTS;
    const u1 = (c.length * (i + 1)) / DECK_SEGMENTS;
    // Deck plate. Its TOP is the surface the ground query returns, so the plate
    // is hung entirely below that line by half its own thickness.
    plate(u0, u1, c.halfW * 2, 0.22, -0.11, 0, DECK);
    // Kerb rails, and the chassis rail under them.
    for (const side of [-1, 1] as const) {
      plate(u0, u1, 0.3, 0.24, 0.1, side * (c.halfW - 0.15), KERB);
      plate(u0, u1, 0.34, 0.7, -0.57, side * (c.halfW - 0.17), CHASSIS);
    }
  }

  /*
   * Below-deck body, from the point the deck stands clear of the ground. This
   * is what the flank capsules in `carrierCapsules()` stand for, so it starts
   * at the same 0.8m the walls do — a panel drawn where there is no collider
   * would be the invisible-wall complaint with the sign flipped.
   */
  const bodyFrom = c.length * Math.sqrt(Math.min(1, 0.8 / Math.max(0.01, c.height)));
  const BODY_SEGS = 6;
  for (let i = 0; i < BODY_SEGS; i++) {
    const u0 = bodyFrom + ((c.length - bodyFrom) * i) / BODY_SEGS;
    const u1 = bodyFrom + ((c.length - bodyFrom) * (i + 1)) / BODY_SEGS;
    const mid = (u0 + u1) * 0.5;
    const hgt = deckAt(mid) - 0.55;
    if (hgt < 0.3) continue;
    for (const side of [-1, 1] as const) {
      box(0.22, hgt, u1 - u0 + 0.05, mid, side * (c.halfW - 0.1), hgt * 0.5, CHASSIS);
    }
  }

  // Rear bogie: three axles under the low end of the deck, where a transporter
  // carries its weight.
  for (let a = 0; a < 3; a++) {
    const u = c.length * 0.24 + a * 1.85;
    for (const side of [-1, 1] as const) {
      // rot lays the drum on its side so it is a wheel and not a bollard; the
      // yaw that follows aims its axle across the rig.
      const g = coloredCylinder(0.52, 0.52, 0.34, [0, 0, 0], TYRE, {
        segments: 8,
        rot: [0, 0, Math.PI / 2],
      });
      g.rotateY(theta);
      g.translate(
        c.x + c.fx * u + c.rx * side * (c.halfW - 0.25),
        c.y + 0.52,
        c.z + c.fz * u + c.rz * side * (c.halfW - 0.25),
      );
      parts.push(g);
    }
  }
  // Loading ramp foot — the plate that meets the road at the mouth.
  box(c.halfW * 2 + 0.4, 0.14, 2.4, 0.5, 0, 0.07, KERB);

  /*
   * Tractor unit, under the overhanging front of the deck.
   *
   * `cabHeight` is a contract, not a look: `carrierCapsules` publishes it as the
   * cab capsule's `yTop`, so a car launching off a deck that is higher than this
   * passes over the roof instead of into it. Draw it taller than the collider
   * says and the launch clips a truck the physics has already let it through.
   */
  const cabMid = c.length + c.cabLength * 0.5;
  box(c.cabHalfW * 2, c.cabHeight - 0.9, c.cabLength * 0.62, cabMid + 0.4, 0, (c.cabHeight - 0.9) * 0.5 + 0.9, CAB);
  box(c.cabHalfW * 2 - 0.12, 0.95, 0.22, cabMid - c.cabLength * 0.26, 0, c.cabHeight - 0.75, GLASS);
  box(c.cabHalfW * 2 - 0.3, 0.9, c.cabLength * 0.9, cabMid, 0, 0.62, CHASSIS);
  for (let a = 0; a < 2; a++) {
    const u = c.length + 1.5 + a * 3.4;
    for (const side of [-1, 1] as const) {
      const g = coloredCylinder(0.58, 0.58, 0.36, [0, 0, 0], TYRE, {
        segments: 8,
        rot: [0, 0, Math.PI / 2],
      });
      g.rotateY(theta);
      g.translate(
        c.x + c.fx * u + c.rx * side * (c.cabHalfW - 0.1),
        c.y + 0.58,
        c.z + c.fz * u + c.rz * side * (c.cabHalfW - 0.1),
      );
      parts.push(g);
    }
  }

  return mergeOrThrow(parts);
}

