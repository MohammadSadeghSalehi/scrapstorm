/**
 * Seeded fBm desert height field — shared by physics + visual mesh.
 * Domain-warped ridged noise → natural dunes; track corridor flattened in getGroundHeight.
 */
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

/**
 * Domain-warped dune field in 0..1.
 * Large dunes + mid detail + fine ripples.
 */
export function sampleDuneField(x: number, z: number): number {
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

/** Raw dune height meters (no track awareness). */
export function rawDuneHeight(x: number, z: number): number {
  return sampleDuneField(x, z) * 7.5;
}

/** Moisture/rock band helper for coloring (independent field). */
export function sampleRockMask(x: number, z: number): number {
  const n = fbm(x * 0.018 + 40, z * 0.018 - 11, 3) * 0.5 + 0.5;
  return Math.pow(n, 1.6);
}
