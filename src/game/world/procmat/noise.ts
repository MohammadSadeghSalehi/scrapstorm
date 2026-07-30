/**
 * Fast deterministic noise for procedural materials.
 *
 * Optimizations vs sin-hash value noise:
 *  - integer avalanche hash (no Math.sin)
 *  - 256-entry perm table (hashed once at init)
 *  - specialized fbm2/fbm3 with precomputed norms
 *  - warp uses 1 octave (not 3×fBm × 2)
 *  - cellular keeps d² until the final sqrt
 */

const PERM = new Uint8Array(512);
(function initPerm() {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  // deterministic shuffle (LCG)
  let s = 0x9e3779b9 >>> 0;
  for (let i = 255; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
})();

/** Integer hash → [0,1). Also exported for scratch/speckle. */
export function hash2(ix: number, iy: number, seed = 0): number {
  // Fold to int lattice
  let n = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 1442695041);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n = (n ^ (n >>> 16)) >>> 0;
  return n / 4294967296;
}

/** Lattice value from perm table + seed salt. */
function lattice(ix: number, iy: number, seed: number): number {
  // Mix seed into indices cheaply
  const sx = (ix + seed * 17) & 255;
  const sy = (iy + seed * 31) & 255;
  return PERM[PERM[sx] + sy] * (1 / 255);
}

function fade(t: number): number {
  // smootherstep cubic:  t*t*(3-2t) — enough for tileables
  return t * t * (3 - 2 * t);
}

/** Bilinear value noise in [0,1]. */
export function valueNoise(x: number, y: number, seed = 0): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const a = lattice(x0, y0, seed);
  const b = lattice(x0 + 1, y0, seed);
  const c = lattice(x0, y0 + 1, seed);
  const d = lattice(x0 + 1, y0 + 1, seed);
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}

/** Precomputed sum of amp series amp0 * (1-gain^n)/(1-gain) with amp0=0.5, gain=0.5. */
const FBM_NORM = /* octaves 1..6 */ [0.5, 0.75, 0.875, 0.9375, 0.96875, 0.984375];

/** Fractal Brownian motion — layered value noise. */
export function fbm(
  x: number,
  y: number,
  opts?: { octaves?: number; lacunarity?: number; gain?: number; seed?: number },
): number {
  const octaves = opts?.octaves ?? 3;
  const seed = opts?.seed ?? 0;
  // Fast path: default gain/lac — covers 95% of recipe calls
  if ((opts?.gain === undefined || opts.gain === 0.5) && (opts?.lacunarity === undefined || opts.lacunarity === 2)) {
    return fbmFast(x, y, octaves, seed);
  }
  const lac = opts?.lacunarity ?? 2;
  const gain = opts?.gain ?? 0.5;
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + i);
    norm += amp;
    amp *= gain;
    freq *= lac;
  }
  return sum / (norm || 1);
}

/** Fixed gain=0.5, lac=2 — branch-free inner path. */
export function fbmFast(x: number, y: number, octaves = 3, seed = 0): number {
  const n = octaves < 1 ? 1 : octaves > 6 ? 6 : octaves;
  let sum = 0;
  let amp = 0.5;
  let fx = x;
  let fy = y;
  for (let i = 0; i < n; i++) {
    sum += amp * valueNoise(fx, fy, seed + i);
    amp *= 0.5;
    fx *= 2;
    fy *= 2;
  }
  return sum / FBM_NORM[n - 1];
}

/** 2-octave fBm — hottest path for grit. */
export function fbm2(x: number, y: number, seed = 0): number {
  return (0.5 * valueNoise(x, y, seed) + 0.25 * valueNoise(x * 2, y * 2, seed + 1)) / 0.75;
}

/** 3-octave fBm. */
export function fbm3(x: number, y: number, seed = 0): number {
  return (
    (0.5 * valueNoise(x, y, seed) +
      0.25 * valueNoise(x * 2, y * 2, seed + 1) +
      0.125 * valueNoise(x * 4, y * 4, seed + 2)) /
    0.875
  );
}

/** Ridged multifractal — scraped metal / cracks. */
export function ridged(
  x: number,
  y: number,
  opts?: { octaves?: number; seed?: number },
): number {
  const octaves = opts?.octaves ?? 3;
  const seed = opts?.seed ?? 0;
  let amp = 0.5;
  let fx = x;
  let fy = y;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = valueNoise(fx, fy, seed + i);
    // 1 - |2n-1| then square for sharper ridges
    const r = 1 - Math.abs(n * 2 - 1);
    sum += amp * r * r;
    norm += amp;
    amp *= 0.5;
    fx *= 2.1;
    fy *= 2.1;
  }
  return sum / (norm || 1);
}

/**
 * Domain warp — 1 octave per axis (was 3-oct fBm × 2 ≈ 24 valueNoise).
 * Still organic enough for asphalt/dirt macro.
 */
export function warp(
  x: number,
  y: number,
  strength = 0.35,
  seed = 0,
): { x: number; y: number } {
  const wx = valueNoise(x * 0.8, y * 0.8, seed) * 2 - 1;
  const wy = valueNoise(x * 0.8 + 19.2, y * 0.8 - 7.1, seed + 3) * 2 - 1;
  return { x: x + wx * strength, y: y + wy * strength };
}

/** In-place warp into out array [x,y] to avoid object alloc in hot loops. */
export function warpInto(
  x: number,
  y: number,
  strength: number,
  seed: number,
  out: [number, number],
): void {
  const wx = valueNoise(x * 0.8, y * 0.8, seed) * 2 - 1;
  const wy = valueNoise(x * 0.8 + 19.2, y * 0.8 - 7.1, seed + 3) * 2 - 1;
  out[0] = x + wx * strength;
  out[1] = y + wy * strength;
}

/** Cellular (Worley) distance in [0,1]. */
export function cellular(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let minD = 1e9;
  for (let oy = -1; oy <= 1; oy++) {
    const yy = yi + oy;
    for (let ox = -1; ox <= 1; ox++) {
      const xx = xi + ox;
      // Reuse one lattice hash for both offsets
      const h = lattice(xx, yy, seed);
      const h2 = lattice(xx, yy, seed + 1);
      const cx = xx + h;
      const cy = yy + h2;
      const dx = x - cx;
      const dy = y - cy;
      const d = dx * dx + dy * dy;
      if (d < minD) minD = d;
    }
  }
  // sqrt only once
  return minD < 1 ? Math.sqrt(minD) : 1;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}
