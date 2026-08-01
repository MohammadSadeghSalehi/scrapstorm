/**
 * The desert scatter fields themselves — placement, sizing and instance
 * transforms, with no renderer attached.
 *
 * Split from ScatterField.tsx on purpose: everything that can put a rock
 * through the road or leave one hovering lives here, and here it can be run and
 * asserted without a canvas.
 */
import * as THREE from "three";
import { driftGeometry, rockGeometry, scrubGeometry } from "./geometry";
import { scatterPoints, type ScatterPoint } from "./placement";
import { getActiveEnvironment } from "../environments";
import type { ScatterLayerDef, Vec3 } from "../environments";
import type { ScatterItem } from "./layerData";

const EULER = new THREE.Euler();
const Q = new THREE.Quaternion();
const P = new THREE.Vector3();
const S = new THREE.Vector3();

/**
 * Colour multiplier between two ends of a ramp.
 *
 * Deliberately not `THREE.Color.lerp`: these multiply the material colour
 * rather than replacing it, and values above 1 are wanted at the bright end.
 */
function tint(lo: Vec3, hi: Vec3, t: number): THREE.Color {
  return new THREE.Color(
    lo[0] + (hi[0] - lo[0]) * t,
    lo[1] + (hi[1] - lo[1]) * t,
    lo[2] + (hi[2] - lo[2]) * t,
  );
}

/**
 * Per-instance tint from a layer's environment ramp, or nothing.
 *
 * `undefined` is not the same as a [1,1,1] ramp: `packLayer` only allocates the
 * per-instance colour buffer — and with it the instanced colour attribute the
 * shader then has to read — if any item in the layer carries a colour at all.
 * A layer that does not want variation should cost nothing for not wanting it.
 */
function rampTint(layer: ScatterLayerDef, t: number): THREE.Color | undefined {
  if (!layer.lo || !layer.hi) return undefined;
  return tint(layer.lo, layer.hi, t);
}

/**
 * Candidates per track sample, after the environment's density multiplier.
 *
 * Density is applied to the CANDIDATE COUNT rather than as a prefix of the
 * finished list, because these presets go above 1 as well as below it — a
 * scrapyard genuinely wants more wind-blown scrap than the desert does, and you
 * cannot take a 2.2x prefix of a list. Rounding to a whole candidate count is
 * fine: the field is rejection-sampled anyway, so the realised density is
 * approximate by construction.
 *
 * Returns 0 for a density of 0, which drops the layer entirely. That is
 * deliberate and it is not the same as a very small density: a handful of
 * surviving desert tufts in a slag pit reads as a bug, not as sparse planting.
 */
function perSampleFor(base: number, density: number): number {
  if (density <= 0) return 0;
  return Math.max(1, Math.round(base * density));
}

/**
 * Largest |x| or |z| in a geometry — its footprint radius at scale 1, which a
 * per-instance scale multiplies to give the world-space footprint.
 *
 * Measured rather than hardcoded, so retuning a rock's warp or a drift's spread
 * cannot silently invalidate the clearance maths below.
 */
export function footprintOf(g: THREE.BufferGeometry): number {
  g.computeBoundingBox();
  const b = g.boundingBox!;
  return Math.max(Math.abs(b.min.x), b.max.x, Math.abs(b.min.z), b.max.z, 1e-3);
}

type Shape = {
  sx: number;
  sy: number;
  sz: number;
  /** Fraction of the instance's height buried in the sand. */
  sink: number;
  tilt: number;
  limit: number;
  color?: THREE.Color;
};

function instancesFrom(
  points: ScatterPoint[],
  footprint: number,
  shape: (p: ScatterPoint) => Shape,
): ScatterItem[] {
  const out: ScatterItem[] = [];
  for (const p of points) {
    const f = shape(p);

    /*
     * Shrink to fit the ground actually available.
     *
     * `scatterPoints` can only police one footprint, and it is given the
     * layer's SMALLEST — otherwise a field that contains both gravel and
     * five-metre outcrops would have to keep its gravel as far from the road as
     * its boulders, which empties exactly the band that matters. So the big
     * instances are sized down where the verge is tight. Nothing here has a
     * collider, so an overhang into the gravel run-off is a rock the player
     * drives through, not a cosmetic problem.
     */
    let { sx, sy, sz } = f;
    const room = Math.max(0.05, p.clear - 0.15);
    const reach = Math.max(sx, sz) * footprint;
    if (reach > room) {
      const k = room / reach;
      sx *= k;
      sy *= k;
      sz *= k;
    }

    EULER.set((p.b - 0.5) * f.tilt, p.a * Math.PI * 2, (p.c - 0.5) * f.tilt);
    Q.setFromEuler(EULER);
    // Partly buried. These cast no shadow, and an object sitting exactly on a
    // surface with no contact shadow reads as hovering above it.
    P.set(p.x, p.y - sy * f.sink, p.z);
    S.set(sx, sy, sz);
    out.push({
      matrix: new THREE.Matrix4().compose(P, Q, S),
      x: p.x,
      y: p.y + sy * 0.4,
      z: p.z,
      r: Math.max(sx * footprint, sz * footprint, sy),
      // Jittered per instance so the field does not vanish along one clean arc
      // as the camera turns. Linear fog starts at 120m and softens the rest.
      limit: f.limit * (0.84 + p.b * 0.32),
      color: f.color,
    });
  }
  return out;
}

export type ScatterFields = {
  geometries: { rock: THREE.BufferGeometry; scrub: THREE.BufferGeometry; drift: THREE.BufferGeometry };
  rock: ScatterItem[];
  scrub: ScatterItem[];
  drift: ScatterItem[];
};

export function buildScatterFields(): ScatterFields {
  /*
   * Density and tint come from the environment; PLACEMENT does not.
   *
   * The clearance rules in placement.ts are a safety property — nothing here
   * has a collider, so anything overlapping drivable surface is something the
   * player drives straight through — and an environment is an art decision. Art
   * decisions do not get to move the band the field is allowed to occupy. All
   * an environment can do is ask for more or fewer candidates inside it, and
   * change what colour they are.
   */
  const env = getActiveEnvironment().scatter;

  const geometries = {
    rock: rockGeometry(),
    scrub: scrubGeometry(),
    drift: driftGeometry(),
  };
  const fpRock = footprintOf(geometries.rock);
  const fpScrub = footprintOf(geometries.scrub);
  const fpDrift = footprintOf(geometries.drift);

  /*
   * Outcrops come FIRST in the rock layer and gravel after, because tier
   * scaling keeps a prefix of the list: the metre-scale boulders carrying the
   * mid-ground silhouette survive every tier drop, and it is the gravel that
   * thins. They share a geometry and a material with the gravel, so ordering
   * them this way costs no extra draw call.
   */
  const outcrops = scatterPoints({
    seed: 0x77c3a1,
    perSample: perSampleFor(1, env.rock.density),
    near: 12,
    far: 128,
    radius: 2.0 * 0.9 * fpRock,
    bias: 0.85,
    jitter: 18,
  }).slice(0, Math.round(120 * env.rock.density));

  const gravel = scatterPoints({
    seed: 0x1a2b3c,
    perSample: perSampleFor(5, env.rock.density),
    near: 0.6,
    far: 46,
    radius: 0.4 * 0.85 * fpRock,
    bias: 1.7,
    jitter: 7,
  });

  const rock = [
    ...instancesFrom(outcrops, fpRock, (p) => {
      const s = 2.0 + p.a * 3.3;
      return {
        sx: s * (0.9 + p.b * 0.45),
        sy: s * (0.55 + p.c * 0.5),
        sz: s * (0.9 + (1 - p.b) * 0.45),
        sink: 0.34,
        tilt: 0.16,
        limit: 300,
        color: rampTint(env.rock, p.c),
      };
    }),
    ...instancesFrom(gravel, fpRock, (p) => {
      // Squared: most of the field is ankle height and a handful are boulders.
      // A uniform size distribution reads as a field of identical lumps.
      const s = 0.4 + p.a * p.a * 2.3;
      return {
        sx: s * (0.85 + p.b * 0.4),
        sy: s * (0.58 + p.c * 0.55),
        sz: s * (0.85 + (1 - p.b) * 0.4),
        sink: 0.3,
        tilt: 0.22,
        limit: 150,
        color: rampTint(env.rock, p.c),
      };
    }),
  ];

  const scrub = instancesFrom(
    scatterPoints({
      seed: 0x33f1d0,
      perSample: perSampleFor(8, env.scrub.density),
      near: 0.4,
      far: 34,
      radius: 0.32 * 0.8 * fpScrub,
      bias: 2.2,
      jitter: 6,
    }),
    fpScrub,
    (p) => {
      const h = 0.32 + p.a * 0.74;
      const w = h * (0.8 + p.b * 0.7);
      return {
        sx: w,
        sy: h,
        sz: w,
        sink: 0.08,
        tilt: 0.12,
        limit: 105,
        color: rampTint(env.scrub, p.c),
      };
    },
  );

  const drift = instancesFrom(
    scatterPoints({
      seed: 0x5be271,
      perSample: perSampleFor(2, env.drift.density),
      near: 0.5,
      far: 26,
      radius: 0.85 * fpDrift,
      bias: 1.6,
      jitter: 8,
    }),
    fpDrift,
    (p) => {
      const s = 0.85 + p.a * 1.7;
      return {
        sx: s,
        sy: s * (0.6 + p.b * 0.6),
        sz: s,
        // Far shallower than the rocks': `sy` is a scale on geometry that is
        // only ~0.26 units tall, so the same 0.3 that half-buries a boulder
        // would swallow a drift whole.
        sink: 0.03,
        tilt: 0.1,
        limit: 140,
        color: rampTint(env.drift, p.c),
      };
    },
  );

  return { geometries, rock, scrub, drift };
}
