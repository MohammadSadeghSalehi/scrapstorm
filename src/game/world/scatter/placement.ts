/**
 * Where world scatter is allowed to sit.
 *
 * Two constraints drive everything in this file, and both have already cost
 * this project a round of "why is the crate in the air / why did I drive
 * through the pipe":
 *
 * 1. The ground is neither y=0 nor the road plane. Off the tarmac the desert
 *    climbs to roadY + 1.1 + dune*16.5, so a literal height or a track sample's
 *    `y` puts an object metres out. Heights come from `duneProfile`, which is
 *    the same curve `getGroundHeight` evaluates — it was split out of it
 *    precisely so placement code could land on the surface physics reports
 *    without re-deriving it.
 * 2. None of this scatter has a collider, so anything overlapping drivable
 *    surface is something the player passes straight through. An offset taken
 *    from one track sample proves nothing: Ash Spire doubles back on itself, so
 *    a point 8m off the centreline at sample 40 can be sitting on the road at
 *    sample 210. `getSurfaceAt` is the only query that knows about the whole
 *    loop, and candidates that fail it are DROPPED rather than nudged — a nudge
 *    can just as easily push a rock onto a different part of the circuit, and
 *    at these densities losing a few percent of the field costs nothing.
 */
import { TRACK_SAMPLES, duneProfile, getSurfaceAt } from "../../track";
import { sampleDuneField } from "../terrainHeight";
import type { TrackSample } from "../../types";

/**
 * Gravel run-off width. Mirrors `apronW` in culling/roadSegments.ts and the
 * apron band in `getSurfaceAt`. The run-off is drivable — drivers use it — so
 * it counts as track for clearance purposes even though it is not tarmac.
 */
export const APRON_M = 5.5;

/** Breathing room between the run-off edge and the nearest scatter footprint. */
const VERGE_MARGIN = 0.9;

/**
 * Deterministic PRNG.
 *
 * The desert has to be identical on every reload AND on every quality tier.
 * Tier scaling works by drawing a prefix of a rank-sorted list, which is only
 * a *thinning* if the list itself never changes; a reseeded or tier-dependent
 * generator would reshuffle the whole world every time the adaptive scaler
 * moved a step.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type ScatterPoint = {
  x: number;
  y: number;
  z: number;
  /** Distance to the racing line — lets callers shrink or thin by band. */
  dist: number;
  /**
   * Metres of clear ground between this point and the outer edge of the gravel
   * run-off, measured against the WHOLE loop.
   *
   * Callers size instances against this rather than assuming the band they
   * asked for. A rejection test can only ever police a single footprint, and
   * these fields mix half-metre gravel with five-metre outcrops from one point
   * list; sizing to fit means the big pieces appear where there is room for
   * them and the verge keeps the small ones, instead of the whole field being
   * pushed back to clear the largest instance in it.
   */
  clear: number;
  /** Independent 0..1 variates for scale, yaw and tint. */
  a: number;
  b: number;
  c: number;
};

/** Right-of-centreline unit vector, matching the EDGE_MARKERS convention. */
function rightOf(s: TrackSample): [number, number] {
  return [Math.cos(s.yaw), -Math.sin(s.yaw)];
}

/**
 * Ground height at a point whose surface query is already in hand.
 *
 * Identical to `getGroundHeight(x, z)`; spelled out only to avoid a second
 * `nearestTrackIndex` sweep per candidate, which at a few thousand candidates
 * is the dominant cost of building a field.
 */
function settle(x: number, z: number, surf: ReturnType<typeof getSurfaceAt>) {
  return duneProfile(surf.sample.y, sampleDuneField(x, z), surf.dist, surf.half);
}

/**
 * Rejection-sampled points in a band alongside the circuit.
 *
 * Returned in a stable random order (not track order), so drawing the first N
 * gives a spatially uniform subset of the same field — that is the whole tier
 * scaling mechanism, and it means dropping a tier removes scatter rather than
 * replacing it.
 */
export function scatterPoints(opts: {
  seed: number;
  /** Candidates attempted per track sample, before rejection. */
  perSample: number;
  /** Band start/end, measured outward from the OUTER edge of the run-off. */
  near: number;
  far: number;
  /** Half-footprint of the item, added to the clearance test. */
  radius: number;
  /** >1 pulls density toward the verge, <1 pushes it out into the desert. */
  bias?: number;
  /** Post-offset world jitter, in metres. Without it the field reads as two
   *  neat hedgerows tracing the circuit. */
  jitter?: number;
}): ScatterPoint[] {
  const samples = TRACK_SAMPLES;
  const n = samples.length;
  const out: ScatterPoint[] = [];
  if (n < 4) return out;

  const rng = mulberry32(opts.seed);
  const bias = opts.bias ?? 1;
  const jitter = opts.jitter ?? 5;
  const span = opts.far - opts.near;

  for (let i = 0; i < n; i++) {
    const a = samples[i]!;
    const b = samples[(i + 1) % n]!;
    const [rx, rz] = rightOf(a);

    for (let k = 0; k < opts.perSample; k++) {
      // Anchor anywhere along the interval, so density does not spike at the
      // sample points themselves.
      const t = rng();
      const side = rng() < 0.5 ? -1 : 1;
      const band = opts.near + Math.pow(rng(), bias) * span;
      const off = a.width * 0.5 + APRON_M + band;
      const x =
        a.x + (b.x - a.x) * t + rx * side * off + (rng() - 0.5) * jitter;
      const z =
        a.z + (b.z - a.z) * t + rz * side * off + (rng() - 0.5) * jitter;

      const surf = getSurfaceAt(x, z);
      const clear = surf.dist - (surf.half + APRON_M);
      // `radius` is the SMALLEST footprint the caller will place here; anything
      // larger is shrunk to fit by the caller using `clear`.
      if (clear < VERGE_MARGIN + opts.radius) continue;

      out.push({
        x,
        z,
        y: settle(x, z, surf),
        dist: surf.dist,
        clear,
        a: rng(),
        b: rng(),
        c: rng(),
      });
    }
  }

  // Fisher-Yates on the same stream: the prefix of the shuffled list is a
  // uniform sample of the field, which is what makes tier thinning invisible.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/**
 * The curvature value that the top `fraction` of samples exceed.
 *
 * "Corner" is not a fixed number of radians — it depends on the circuit. Taking
 * a percentile of the track's own curvature distribution puts guard rails on
 * Cinder Bowl's hairpins in the same proportion as on Ash Spire's sweepers,
 * where a hardcoded threshold would either wrap one end to end or leave the
 * other bare.
 */
export function curvatureThreshold(fraction: number, reach = 3): number {
  const n = TRACK_SAMPLES.length;
  if (n < 8) return 0;
  const mags: number[] = [];
  for (let i = 0; i < n; i++) mags.push(Math.abs(curvatureAt(i, reach)));
  mags.sort((a, b) => b - a);
  const idx = Math.min(n - 1, Math.max(0, Math.floor(n * fraction)));
  return mags[idx]!;
}

export type VergePoint = {
  x: number;
  y: number;
  z: number;
  /** Track yaw at the anchor, so furniture can align to the road. */
  yaw: number;
  /** -1 / +1 in the EDGE_MARKERS convention. */
  side: number;
  index: number;
};

/**
 * Signed curvature at a sample, normalised so it is comparable everywhere.
 *
 * Sign follows the same cross product `buildSamples` uses for bank: positive
 * means the road bends such that the outside of the corner is side -1.
 */
function curvatureAt(i: number, reach: number): number {
  const n = TRACK_SAMPLES.length;
  const p = TRACK_SAMPLES[i]!;
  const a = TRACK_SAMPLES[(i - reach + n * 2) % n]!;
  const b = TRACK_SAMPLES[(i + reach) % n]!;
  const t0x = p.x - a.x;
  const t0z = p.z - a.z;
  const t1x = b.x - p.x;
  const t1z = b.z - p.z;
  const l0 = Math.hypot(t0x, t0z) || 1;
  const l1 = Math.hypot(t1x, t1z) || 1;
  return (t0x * t1z - t0z * t1x) / (l0 * l1);
}

/**
 * Evenly spaced anchors along the verge, for continuous furniture.
 *
 * Unlike `scatterPoints` these keep track order, because a guard rail is only
 * a guard rail if consecutive modules line up.
 */
export function vergePoints(opts: {
  /** Samples between modules. */
  stride: number;
  /** Distance outward from the run-off edge. */
  offset: number;
  /** Half-footprint, added to the clearance test. */
  radius: number;
  /** Emit only where |curvature| is at least this (0 = everywhere). */
  minCurve?: number;
  /** Emit only where |curvature| is at most this. */
  maxCurve?: number;
  /** true: outside of the bend only. false: both verges. */
  outsideOnly?: boolean;
  /** Sample offset, so two kinds of furniture do not share anchors. */
  phase?: number;
  /** Samples over which curvature is measured. */
  reach?: number;
}): VergePoint[] {
  const samples = TRACK_SAMPLES;
  const n = samples.length;
  const out: VergePoint[] = [];
  if (n < 8) return out;

  const stride = Math.max(1, Math.round(opts.stride));
  const minCurve = opts.minCurve ?? 0;
  const maxCurve = opts.maxCurve ?? Infinity;
  const reach = opts.reach ?? 3;

  for (let k = opts.phase ?? 0; k < n; k += stride) {
    const i = k % n;
    const s = samples[i]!;
    const curve = curvatureAt(i, reach);
    const mag = Math.abs(curve);
    if (mag < minCurve || mag > maxCurve) continue;

    const [rx, rz] = rightOf(s);
    const sides = opts.outsideOnly ? [curve > 0 ? -1 : 1] : [-1, 1];

    for (const side of sides) {
      /*
       * Same whole-loop clearance rule as the scatter fields, but SOLVED rather
       * than tested.
       *
       * Continuous furniture cannot use the fields' reject-on-failure policy: a
       * dropped module is a hole in a guard rail, which reads as broken in a
       * way that a missing rock does not. The offset is nominal — the anchor's
       * own half-width plus the run-off — while the test uses the half-width of
       * whichever sample turns out to be nearest, and the track's width varies
       * from 24m to 32m. Where those disagree the rail simply bulges outward
       * until it clears, which is invisible; the first version rejected instead
       * and produced two rail modules on the entire circuit.
       */
      let off = s.width * 0.5 + APRON_M + opts.offset;
      let placed = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        const x = s.x + rx * side * off;
        const z = s.z + rz * side * off;
        const surf = getSurfaceAt(x, z);
        const need = surf.half + APRON_M + opts.radius + 0.15;
        if (surf.dist >= need) {
          out.push({ x, z, y: settle(x, z, surf), yaw: s.yaw, side, index: i });
          placed = true;
          break;
        }
        off += Math.max(0.5, need - surf.dist + 0.2);
      }
      // Genuinely nowhere to put it — the loop doubles back on itself here.
      void placed;
    }
  }
  return out;
}

/**
 * Median spacing between consecutive modules on one verge, in metres.
 *
 * Guard-rail beams are one geometry at one authored length (that is what makes
 * a kilometre of rail a single draw call), and per-instance X scale takes up
 * the difference — so this number sets the scale factor everyone else works
 * from. Median, not mean: anchors are dropped between separate stretches of
 * rail, and a couple of 35m jumps in the list drag a mean far off the spacing
 * that actually occurs, which then stretches every post on the circuit.
 */
export function meanSpacing(points: VergePoint[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (a.side !== b.side) continue;
    gaps.push(Math.hypot(b.x - a.x, b.z - a.z));
  }
  if (!gaps.length) return 6;
  gaps.sort((x, y) => x - y);
  return gaps[Math.floor(gaps.length * 0.5)]!;
}
