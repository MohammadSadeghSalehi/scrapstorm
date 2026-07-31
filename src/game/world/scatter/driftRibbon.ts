/**
 * The sand-drift ribbon geometry, with no renderer attached.
 *
 * Split from VergeDrift.tsx for the same reason fields.ts is split from
 * ScatterField.tsx: this strip sits ON the road surface rather than on the
 * ground, so its heights are re-derived from the road mesh's own expressions
 * and a sign error would be invisible in code review and obvious at 200km/h.
 * Kept renderer-free, it can be built and checked against the road plane
 * directly.
 *
 * The heights deliberately do NOT come from getGroundHeight. That query reports
 * the flat corridor physics uses, not the banked road surface the tarmac is
 * actually drawn at, so on a banked corner it would bury the drift on the high
 * side and float it on the low one. These mirror `sampleEdges` in
 * culling/roadSegments.ts instead, bank term included.
 */
import * as THREE from "three";
import { TRACK_SAMPLES } from "../../track";
import { fbm } from "../terrainHeight";
import { APRON_M } from "./placement";
import type { TrackSample } from "../../types";

/** One tile of the sand pack per this many metres, matching the apron's 3.5. */
const TILE_M = 3.5;
/**
 * Clearance above the road surface. Enough to beat depth precision, far too
 * little to read as a step.
 *
 * Small only because the invariant is exact rather than approximate: every
 * vertex here is generated from the same sample, side and lateral offset the
 * road and apron quads are, so it lands on their surface by construction, not
 * near it. Anything that samples the surface independently — a projection onto
 * the centreline, say — disagrees by up to 0.2m at the jump-zone step and needs
 * a clearance large enough to read as a lip.
 */
const LIFT = 0.045;

function bankOf(s: TrackSample): number {
  return (s as TrackSample & { bank?: number }).bank ?? 0;
}

/**
 * Height of the drivable surface at a lateral offset, in the same left/right
 * convention `sampleEdges` uses (+1 = the side its bank term raises).
 */
function surfaceY(s: TrackSample, sideL: number, off: number): number {
  const half = Math.max(1e-3, s.width * 0.5);
  const bank = bankOf(s);
  if (off <= half) {
    // The road is one quad spanning both edges, so its height is linear in the
    // signed offset between them.
    return s.y + 0.02 + bank * 0.45 * sideL * (off / half);
  }
  // Apron drops 0.04 across its width and relaxes the bank from 0.45 to 0.2.
  const t = Math.min(1, (off - half) / APRON_M);
  return s.y + 0.02 - 0.04 * t + bank * (0.45 + (0.2 - 0.45) * t) * sideL;
}

/**
 * How far the drift reaches, in metres, at a point.
 *
 * Driven by world-space noise rather than sample index so the scalloped edge
 * survives the track being resampled, and so both sides drift independently.
 * A constant-width band would read as a painted stripe, which is the failure
 * mode this is meant to fix.
 */
function driftMask(x: number, z: number, sideL: number): number {
  const n = fbm(x * 0.028 + sideL * 17.3, z * 0.028 - sideL * 9.1, 3);
  return Math.min(1, Math.max(0, n * 1.5 + 0.5));
}

export function buildDriftRibbon(): THREE.BufferGeometry | null {
  const samples = TRACK_SAMPLES;
  const n = samples.length;
  if (n < 8) return null;

  const pos: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];

  /** Alpha at the three cross-section rows: on tarmac, at the edge, on gravel. */
  const ALPHA = [0, 0.6, 0.9];

  /**
   * `arc` is passed in rather than read from `s.s` because the closing quad
   * wraps: sample 0 carries s = 0 while its predecessor carries the full lap
   * length, and taking both at face value smears one tile across the entire
   * circuit's worth of UV in a single quad — a visible streak on the start
   * straight, in the one place nobody misses it.
   */
  const rowAt = (s: TrackSample, sideL: number, m: number, arc: number) => {
    const half = s.width * 0.5;
    const dirX = -Math.cos(s.yaw);
    const dirZ = Math.sin(s.yaw);
    const inD = 0.15 + m * 2.35;
    const outD = 1.1 + m * 2.2;
    const offs = [half - inD, half, half + outD];
    return offs.map((off, r) => ({
      x: s.x + dirX * sideL * off,
      y: surfaceY(s, sideL, off) + LIFT,
      z: s.z + dirZ * sideL * off,
      u: arc / TILE_M,
      v: off / TILE_M,
      a: ALPHA[r]!,
    }));
  };

  type Row = ReturnType<typeof rowAt>;
  const push = (p: Row[number]) => {
    pos.push(p.x, p.y, p.z);
    nrm.push(0, 1, 0);
    uv.push(p.u, p.v);
    // Warm the sand slightly as it thickens, so the drift is not a flat
    // stencil of the tile.
    const w = 0.86 + p.a * 0.2;
    col.push(w, w * 0.97, w * 0.9, p.a);
  };

  for (let i = 0; i < n; i++) {
    const a = samples[i]!;
    const b = samples[(i + 1) % n]!;
    const arcA = a.s;
    const arcB =
      i === n - 1 ? a.s + Math.hypot(b.x - a.x, b.z - a.z) : b.s;
    for (const sideL of [-1, 1] as const) {
      const ma = driftMask(a.x, a.z, sideL);
      const mb = driftMask(b.x, b.z, sideL);
      const ra = rowAt(a, sideL, ma, arcA);
      const rb = rowAt(b, sideL, mb, arcB);
      for (let r = 0; r < 2; r++) {
        // Two triangles per band. Winding is not load-bearing: the material is
        // DoubleSide and the normals are written as +Y by hand, so the strip
        // lights correctly whichever way the quad happens to wind.
        push(ra[r]!);
        push(rb[r]!);
        push(rb[r + 1]!);
        push(ra[r]!);
        push(rb[r + 1]!);
        push(ra[r + 1]!);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  // itemSize 4 is what switches three to USE_COLOR_ALPHA; a 3-component colour
  // attribute would silently drop the fade and leave a hard-edged sand stripe.
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 4));
  return g;
}
