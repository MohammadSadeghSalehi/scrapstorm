/**
 * Seeded height field — shared by physics + visual mesh.
 *
 * ONE noise basis, SIX landforms. `sampleDuneField` is the single entry point
 * both `getGroundHeight` (physics) and `meshHeight` (the visible mesh) reach
 * through, so switching the generator per circuit switches both by
 * construction; there is deliberately no way to give the mesh a landform the
 * car cannot drive on. Which branch runs comes from `terrainProfiles.ts`, which
 * `track.ts` points at the active circuit during its rebuild.
 *
 * The track corridor is flattened later, in `duneProfile`.
 */
import {
  getTerrainAnchor,
  getTerrainProfile,
  type TerrainAnchor,
} from "./terrainProfiles";

const SEED = 0x5c2a9f17;

function mulberry32(a: number) {
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Gradient noise lattice (value-noise with smooth hermite) — fast, no deps
const GRAD: [number, number][] = [];
{
  const rng = mulberry32(SEED);
  for (let i = 0; i < 256; i++) {
    const a = rng() * Math.PI * 2;
    GRAD.push([Math.cos(a), Math.sin(a)]);
  }
}

function fade(t: number) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function gradHash(ix: number, iz: number): [number, number] {
  const h =
    ((ix * 374761393 + iz * 668265263 + SEED) >>> 0) % 256;
  return GRAD[h]!;
}

/** Classic Perlin-style 2D noise in ~[-1, 1] */
export function perlin2(x: number, z: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  const u = fade(fx);
  const v = fade(fz);
  const g00 = gradHash(x0, z0);
  const g10 = gradHash(x0 + 1, z0);
  const g01 = gradHash(x0, z0 + 1);
  const g11 = gradHash(x0 + 1, z0 + 1);
  const n00 = g00[0] * fx + g00[1] * fz;
  const n10 = g10[0] * (fx - 1) + g10[1] * fz;
  const n01 = g01[0] * fx + g01[1] * (fz - 1);
  const n11 = g11[0] * (fx - 1) + g11[1] * (fz - 1);
  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return nx0 + (nx1 - nx0) * v;
}

/** fBm octaves → ~[-1,1] */
export function fbm(x: number, z: number, octaves = 5, lac = 2.05, gain = 0.5): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += perlin2(x * freq, z * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lac;
  }
  return sum / Math.max(1e-6, norm);
}

/** Ridged multifractal — sharp dune crests */
export function ridged(x: number, z: number, octaves = 4): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  let weight = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(perlin2(x * freq, z * freq));
    n = n * n * weight;
    sum += n * amp;
    norm += amp;
    weight = Math.min(1, n * 1.4);
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum / Math.max(1e-6, norm);
}

function smoothstep01(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / Math.max(1e-6, b - a)));
  return t * t * (3 - 2 * t);
}

/** Signed noise remapped to 0..1, which almost every landform below wants. */
function unit(n: number): number {
  return n * 0.5 + 0.5;
}

/**
 * `unit(fbm(...))` STRETCHED to actually use 0..1.
 *
 * This exists because the obvious assumption is wrong and fails silently.
 * `fbm` is normalised by its amplitude sum, so it can only reach ±1 if every
 * octave peaks at the same point — which never happens. Measured over 200k
 * samples of the 3-octave field, `unit(fbm)` occupies **0.34 to 0.70**, with
 * p50 at 0.48 and p99 at 0.64. It is a bell, not a uniform.
 *
 * Anything that THRESHOLDS or QUANTISES the raw value therefore does not do
 * what it reads as doing: a `smoothstep(0.6, 0.93, n)` meant to isolate the top
 * few percent of the map isolates nothing at all and returns ~0.05 at its
 * maximum, and a 7-step quantiser only ever emits 3 of its 7 steps. Both of
 * those were in the first version of the landforms below, both looked correct,
 * and both showed up only as a measured height histogram that was far too flat.
 *
 * Fields that merely SCALE the value (a 0.06m ripple term) do not need this and
 * deliberately do not use it.
 */
function unitWide(n: number): number {
  return Math.min(1, Math.max(0, (unit(n) - 0.34) / 0.34));
}

/**
 * ASH SPIRE — wind-built dune sea. The original field, unchanged.
 *
 * Kept byte-for-byte because it is the reference: if the one circuit whose look
 * was already signed off shifts when a landform table is introduced under it,
 * there is no way to tell a bug in the table from the intended redesign of the
 * other five.
 */
function duneField(x: number, z: number): number {
  // Multi-stage domain warp (Red Blob / advanced fBm technique)
  const w1x = fbm(x * 0.0038 + 10, z * 0.0038 - 3, 3) * 32;
  const w1z = fbm(x * 0.0038 - 7, z * 0.0038 + 19, 3) * 32;
  const w2x = fbm((x + w1x) * 0.012, (z + w1z) * 0.012, 2) * 10;
  const w2z = fbm((x + w1x) * 0.012 + 5, (z + w1z) * 0.012 - 4, 2) * 10;
  const px = (x + w1x + w2x) * 0.0085;
  const pz = (z + w1z + w2z) * 0.0085;

  // Billowy dunes + ridged crests + fine ripple
  const billow = Math.abs(fbm(px * 0.9, pz * 0.9, 4)); // 0..1 peaks
  const macro = ridged(px, pz, 5);
  const meso = fbm(px * 2.6 + 5, pz * 2.6 - 2, 4) * 0.5 + 0.5;
  const micro = fbm(px * 9.0, pz * 9.0, 3) * 0.5 + 0.5;

  let h = macro * 0.48 + billow * 0.22 + meso * 0.22 + micro * 0.08;
  // Terrace-ish redistribution: flatter valleys, sharp crests
  h = Math.pow(Math.max(0, Math.min(1, h)), 1.28);
  // Slight continental mask so map center isn't all peaks
  const dist = Math.hypot(x - 20, z - 40) / 220;
  const mask = 0.55 + 0.45 * Math.min(1, dist);
  return h * mask;
}

/**
 * CINDER BOWL — an ash crater, raced on its floor.
 *
 * A crater is a GAUSSIAN ANNULUS, not a big dune. That distinction is what
 * makes the rim continuous all the way round with a single crest line, instead
 * of a ring of separate hills that happen to be arranged in a circle. Placed
 * against the circuit's own reach so it encloses the racing surface on every
 * layout rather than on the one it was tuned against.
 */
function craterField(x: number, z: number, a: TerrainAnchor): number {
  const r = Math.hypot(x - a.cx, z - a.cz);

  // The rim radius wobbles at the scale of the crater itself. Without this it
  // is a drawn circle, and a drawn circle in a landscape reads as a bug
  // however good the surface detail on it is.
  const wobble = fbm(x * 0.0026 + 3.1, z * 0.0026 - 8.4, 3) * (a.extent * 0.3);
  const rimR = a.extent * 1.55 + wobble;
  const rimW = a.extent * 0.7;
  const t = (r - rimR) / rimW;
  const rim = Math.exp(-t * t * 2.2);

  // Settled ash is nearly level — centimetres of ripple, not metres of dune.
  const floor = unit(fbm(x * 0.011 + 21, z * 0.011 + 5, 3));
  // Radial gullies cut down the outer flank by the same collapse that built it.
  const gully = ridged(x * 0.0075, z * 0.0075, 3);

  return 0.08 + floor * 0.06 + rim * (0.55 + 0.45 * gully) * 0.86;
}

/**
 * FOUNDRY PIT — terraced slag benches inside a working pit.
 *
 * Spoil is POURED, and poured ground has a lip at every lift and no detail at
 * any scale between them. So the field is QUANTISED — the thing a naive
 * implementation gets wrong here is reaching for more octaves to make it look
 * "more industrial", which produces eroded rock in a grey palette. Erosion is
 * exactly what has not happened to this ground.
 */
function benchField(x: number, z: number, a: TerrainAnchor): number {
  const r = Math.hypot(x - a.cx, z - a.cz) / a.extent;
  /*
   * Past the working floor the ground climbs into the pit wall, which is what
   * makes this circuit enclosed rather than merely dark.
   *
   * 1.45 rather than 1.15: the circuit hugs its own extent, so `half + 70` —
   * where the open-ground band begins — already lands at r ~ 1.7. Starting the
   * wall at 1.15 meant the 10th percentile of visible open ground was 14.8m up
   * and there was no bench floor left to see, only wall.
   */
  const wall = smoothstep01(1.45, 2.4, r);

  const w = fbm(x * 0.0042 + 13, z * 0.0042 - 6, 2) * 46;
  // unitWide, not unit: a quantiser fed the raw 0.34..0.70 band emits three of
  // its seven steps and the terracing all but disappears. See unitWide.
  const n = unitWide(fbm((x + w) * 0.0036, (z + w) * 0.0036, 3));
  const STEPS = 7;
  const step = Math.floor(n * STEPS);
  const within = n * STEPS - step;
  // The bench top drains slightly outward and its face is not quite vertical;
  // both are small terms and both are what stop it reading as a staircase.
  const bench = step / STEPS + within * 0.055 + unit(fbm(x * 0.03, z * 0.03, 2)) * 0.03;

  return bench * 0.38 + wall * 0.62;
}

/**
 * RUSTLINE — mesa and wash.
 *
 * The redistribution is a NARROW smoothstep, not a power curve. What makes a
 * mesa a mesa is the ABSENCE of intermediate ground: caprock top, cliff, wash
 * floor, nothing between. Any smooth remap of fBm puts ground at every height
 * in between and gives back rolling hills with a hard palette.
 */
function mesaField(x: number, z: number): number {
  const w = fbm(x * 0.003 + 9, z * 0.003 + 2, 3) * 55;
  const n = unit(fbm((x + w) * 0.0034 - 4, (z + w) * 0.0034 + 7, 4));
  const cap = smoothstep01(0.47, 0.565, n);

  const capTop = 0.78 + unit(fbm(x * 0.02, z * 0.02, 2)) * 0.14;
  const washFloor = 0.02 + unit(fbm(x * 0.014 + 30, z * 0.014 - 9, 3)) * 0.07;
  let h = washFloor + (capTop - washFloor) * cap;

  // Braided channels cut through everything, mesas included — that is what
  // left the mesas standing. `ridged` peaks along its crest LINES, so the
  // channel is where the mask is high and the multiplier has to be inverted.
  const channel = 1 - smoothstep01(0.55, 0.86, ridged(x * 0.0052 + 17, z * 0.0052 - 3, 4));
  h *= 0.35 + 0.65 * channel;
  return h;
}

/**
 * SABLE MILE — a cracked basalt playa with rare inselbergs.
 *
 * Dead flat, deliberately. A dune field at 10% amplitude is not a pan: the eye
 * reads scale from SHAPE before it reads it from size, so small dunes look like
 * dunes seen from further away and the circuit just feels smaller. The pan is
 * therefore a couple of metres over half a kilometre, and all the height in the
 * budget goes to a handful of isolated bergs that a flat-out lap can measure
 * itself against.
 */
function playaField(x: number, z: number): number {
  const pan = unit(fbm(x * 0.0055 + 61, z * 0.0055 - 23, 3));
  const crack = unit(fbm(x * 0.09, z * 0.09, 2));
  const flat = pan * 0.035 + crack * 0.008;

  /*
   * pow on a smoothstep keeps the bergs to a few percent of the area. Widening
   * either bound turns landmarks back into texture.
   *
   * Two measurements went into these numbers, and the naive version of each
   * failed silently:
   *
   *  - The bounds are on the WIDENED field. On the raw field
   *    `smoothstep(0.60, 0.93, k)` never exceeded 0.21, because the raw field
   *    itself never exceeds 0.70 — the bergs topped out at 1.8m.
   *  - The CARRIER FREQUENCY has to fit several cells inside the circuit. At
   *    0.0021 the noise wavelength is ~480m and the playa is ~640m across, so
   *    barely one cell was visible and the field's global tail never occurred
   *    locally at all: measured p999 over the actual circuit was 0.686 against
   *    a global max of 1.0. A threshold tuned against the global distribution
   *    is not a threshold on THIS map.
   */
  const k = unitWide(fbm(x * 0.0052 + 7, z * 0.0052 + 31, 3));
  const berg = Math.pow(smoothstep01(0.6, 0.84, k), 1.6);
  const shape = 0.45 + 0.55 * ridged(x * 0.01 - 5, z * 0.01 + 2, 4);

  return flat + berg * shape * 0.95;
}

/**
 * THE DEAD MILE — corrugated ground the haul road is cut across.
 *
 * ANISOTROPIC, and that is the whole read. fBm has no preferred direction at
 * any amplitude or octave count, so the only way to get ground that a road was
 * obviously cut ACROSS rather than laid over is a directional carrier. The
 * carrier is warped rather than curved: real corrugation meanders about a
 * bearing, it does not follow a spline.
 */
function corrugationField(x: number, z: number): number {
  const CA = Math.cos(0.62);
  const SA = Math.sin(0.62);
  const warp = fbm(x * 0.0016 + 3, z * 0.0016 - 11, 3) * 140;
  const u = (x * CA + z * SA + warp) / 165;
  // Slightly biased toward the crest, so the swales are broad and the ridges
  // narrow — the asymmetry of a wind-built corrugation rather than a sine wave.
  const band = Math.pow(0.5 - 0.5 * Math.cos(u * Math.PI * 2), 0.78);

  // Crest height varies ALONG the ridge, or it is a washboard and not a range.
  const along = unit(fbm(x * 0.003 - 7, z * 0.003 + 4, 3));
  const fine = unit(fbm(x * 0.016 + 2, z * 0.016 - 6, 3));

  return band * (0.3 + 0.7 * along) * 0.86 + fine * 0.12;
}

/**
 * The active circuit's height field, 0..1.
 *
 * Every consumer of ground height in the game funnels through here — physics
 * (`getGroundHeight`), the visible mesh (`meshHeight`), scatter placement,
 * setpiece placement and scenery settling. That is intentional and it is the
 * only reason a per-circuit landform is safe to introduce at all: there is one
 * curve, so the mesh and the collision surface cannot disagree the way they
 * once did by 3.5m.
 */
export function sampleDuneField(x: number, z: number): number {
  const p = getTerrainProfile();
  const a = getTerrainAnchor();

  let h: number;
  switch (p.landform) {
    case "crater":
      h = craterField(x, z, a);
      break;
    case "benches":
      h = benchField(x, z, a);
      break;
    case "mesa":
      h = mesaField(x, z);
      break;
    case "playa":
      h = playaField(x, z);
      break;
    case "corrugation":
      h = corrugationField(x, z);
      break;
    default:
      h = duneField(x, z);
      break;
  }

  /*
   * Relax the landform toward a low outskirt near the edge of the patch.
   *
   * Not polish — clearance. The world-locked mountain ring starts 300m from
   * this same centre and buries its inner rows only 40m, so a 30m crater rim
   * still at full height at a 440m half-span would intersect the range instead
   * of sitting inside it. It also removes the step where the heightfield ends
   * and the flat sand underlay takes over.
   *
   * Skipped entirely when fadeFrom is Infinity, which is how Ash Spire's field
   * stays bit-identical to the one the ring was tuned against.
   */
  if (p.fadeFrom !== Infinity) {
    const r = Math.hypot(x - a.cx, z - a.cz);
    const f = smoothstep01(p.fadeFrom, p.fadeTo, r);
    if (f > 0) {
      const outskirt =
        p.edgeLevel * (0.55 + 0.45 * unit(fbm(x * 0.006 + 90, z * 0.006 - 40, 3)));
      h += (outskirt - h) * f;
    }
  }

  return Math.max(0, h);
}

/** Raw dune height meters (no track awareness). */
export function rawDuneHeight(x: number, z: number): number {
  return sampleDuneField(x, z) * 7.5;
}

/**
 * The independent rock / crust mask, 0..1.
 *
 * Read as "where the ground is a different MATERIAL rather than a different
 * height" — bare outcrop on a scoured dune face, slag debris on a bench, alkali
 * crust on a pan. Frequency and exponent are per-circuit because those two
 * numbers are the difference between broad mineral staining across a whole
 * playa and fine patchy debris over a slag bench, and no palette can express
 * that: the same mask drives both the vertex colouring and a real height term
 * in `duneProfile`.
 */
export function sampleRockMask(x: number, z: number): number {
  const p = getTerrainProfile();
  const n = unit(fbm(x * p.rockFreq + 40, z * p.rockFreq - 11, 3));
  return Math.pow(n, p.rockPower);
}
