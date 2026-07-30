/**
 * Explore SIMD vectorization for procedural noise.
 *
 * Not production code — a lab that measures:
 *  A) current scalar valueNoise (perm-table lattice)
 *  B) integer-hash lattice (fully SIMD-mappable, no gather)
 *  C) 4-wide SoA batch of (B) — same arithmetic a WASM f32x4 kernel would run
 *  D) theoretical ceiling notes for WASM SIMD / WebGPU
 *
 * Run: npx tsx scripts/explore-simd-noise.mjs
 */
import { valueNoise as scalarPermNoise } from "../src/game/world/procmat/noise.ts";

// ── Feature detect ──────────────────────────────────────────────────────────
function wasmSimdSupported() {
  try {
    // ChromeLabs wasm-feature-detect style: f32x4.extract_lane
    return WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10,
        1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
      ]),
    );
  } catch {
    return false;
  }
}

// ── Integer-hash lattice (i32 mul/xor — SIMD friendly, no table gather) ────
function hashLattice(ix, iy, seed) {
  let n =
    Math.imul(ix | 0, 374761393) +
    Math.imul(iy | 0, 668265263) +
    Math.imul(seed | 0, 1442695041);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function fade(t) {
  return t * t * (3 - 2 * t);
}

/** Scalar value noise using hash lattice (B). */
function valueNoiseHash(x, y, seed = 0) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const a = hashLattice(x0, y0, seed);
  const b = hashLattice(x0 + 1, y0, seed);
  const c = hashLattice(x0, y0 + 1, seed);
  const d = hashLattice(x0 + 1, y0 + 1, seed);
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}

/**
 * 4-wide batch value noise (C).
 * SoA: xs/ys/out are length ≥ 4 Float64/Float32 arrays; processes indices base..base+3.
 * Mirrors a WASM kernel: f32x4 floor/frac/fade/lerp + 4× scalar-or-i32x4 hash.
 */
function valueNoise4(xs, ys, out, base, seed = 0) {
  // Lane 0..3 independent samples — classic "vectorize across pixels"
  for (let lane = 0; lane < 4; lane++) {
    const i = base + lane;
    const x = xs[i];
    const y = ys[i];
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = fade(x - x0);
    const fy = fade(y - y0);
    const a = hashLattice(x0, y0, seed);
    const b = hashLattice(x0 + 1, y0, seed);
    const c = hashLattice(x0, y0 + 1, seed);
    const d = hashLattice(x0 + 1, y0 + 1, seed);
    out[i] = a + (b - a) * fx + (c + (d - c) * fx - (a + (b - a) * fx)) * fy;
  }
}

/**
 * Fully unrolled 4-wide with separate locals (closer to what LLVM emits for f32x4).
 * Still JS — shows arithmetic shape, not hardware SIMD.
 */
function valueNoise4Unrolled(x0, x1, x2, x3, y0, y1, y2, y3, seed) {
  const o = [0, 0, 0, 0];
  const xs = [x0, x1, x2, x3];
  const ys = [y0, y1, y2, y3];
  for (let i = 0; i < 4; i++) {
    const x = xs[i];
    const y = ys[i];
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = fade(x - xi);
    const fy = fade(y - yi);
    const a = hashLattice(xi, yi, seed);
    const b = hashLattice(xi + 1, yi, seed);
    const c = hashLattice(xi, yi + 1, seed);
    const d = hashLattice(xi + 1, yi + 1, seed);
    const ab = a + (b - a) * fx;
    const cd = c + (d - c) * fx;
    o[i] = ab + (cd - ab) * fy;
  }
  return o;
}

// ── Minimal hand-assembled WASM SIMD: f32x4 mul-add throughput probe ──────
// Measures raw f32x4 ALU (not full noise) to bound SIMD vs JS float cost.
function buildSimdMadModule() {
  // (module
  //   (func (export "mad") (param i32 i32 i32 i32)  ;; out, a, b, n floats
  //     ... f32x4 load/mul/add/store loop
  //   ))
  // Hand-rolling full loop is long; use a simpler exported kernel:
  //   mad4(a0,a1,a2,a3, b0..b3, c0..c3) -> stores nothing, returns sum of lanes
  // For real numbers we just document WASM availability + cite expected 2–4×.
  return null;
}

// ── Benches ────────────────────────────────────────────────────────────────
function bench(label, fn, iters = 5) {
  fn(); // warmup
  let best = Infinity;
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  console.log(`  ${label.padEnd(36)} ${best.toFixed(2)} ms`);
  return best;
}

const W = 256;
const H = 256;
const N = W * H;

console.log("=== SIMD noise exploration ===");
console.log("runtime:", process.version);
console.log("wasm_simd:", wasmSimdSupported());
console.log(`grid: ${W}×${H} = ${N} samples\n`);

// Prepare coords for batch path (scanline: x varies, y steps)
const xs = new Float32Array(N);
const ys = new Float32Array(N);
const out = new Float32Array(N);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    xs[i] = x * 0.07;
    ys[i] = y * 0.07;
  }
}

const tPerm = bench("A scalar perm-table valueNoise", () => {
  let s = 0;
  for (let i = 0; i < N; i++) s += scalarPermNoise(xs[i], ys[i], 1);
  if (s === Infinity) throw 0;
});

const tHash = bench("B scalar integer-hash valueNoise", () => {
  let s = 0;
  for (let i = 0; i < N; i++) s += valueNoiseHash(xs[i], ys[i], 1);
  if (s === Infinity) throw 0;
});

const tBatch = bench("C 4-wide SoA batch (hash lattice)", () => {
  for (let i = 0; i < N; i += 4) valueNoise4(xs, ys, out, i, 1);
});

// fbm-like: 3 octaves on full grid (recipe hot path shape)
const tFbmHash = bench("B×3 fbm-shaped (3 oct hash)", () => {
  let s = 0;
  for (let i = 0; i < N; i++) {
    const x = xs[i];
    const y = ys[i];
    s +=
      0.5 * valueNoiseHash(x, y, 1) +
      0.25 * valueNoiseHash(x * 2, y * 2, 2) +
      0.125 * valueNoiseHash(x * 4, y * 4, 3);
  }
  if (s === Infinity) throw 0;
});

const tFbmBatch = bench("C×3 fbm-shaped 4-wide batch", () => {
  const tmp = new Float32Array(N);
  // octave 0
  for (let i = 0; i < N; i += 4) valueNoise4(xs, ys, out, i, 1);
  for (let i = 0; i < N; i++) tmp[i] = 0.5 * out[i];
  // octave 1 — scale coords
  const xs2 = new Float32Array(N);
  const ys2 = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    xs2[i] = xs[i] * 2;
    ys2[i] = ys[i] * 2;
  }
  for (let i = 0; i < N; i += 4) valueNoise4(xs2, ys2, out, i, 2);
  for (let i = 0; i < N; i++) tmp[i] += 0.25 * out[i];
  const xs4 = new Float32Array(N);
  const ys4 = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    xs4[i] = xs[i] * 4;
    ys4[i] = ys[i] * 4;
  }
  for (let i = 0; i < N; i += 4) valueNoise4(xs4, ys4, out, i, 3);
  for (let i = 0; i < N; i++) tmp[i] += 0.125 * out[i];
});

// Correctness: batch ≈ scalar hash
{
  valueNoise4(xs, ys, out, 0, 7);
  const ref = [
    valueNoiseHash(xs[0], ys[0], 7),
    valueNoiseHash(xs[1], ys[1], 7),
    valueNoiseHash(xs[2], ys[2], 7),
    valueNoiseHash(xs[3], ys[3], 7),
  ];
  let maxErr = 0;
  for (let i = 0; i < 4; i++) maxErr = Math.max(maxErr, Math.abs(out[i] - ref[i]));
  console.log(`\ncorrectness max|batch-scalar|: ${maxErr.toExponential(2)}`);
}

// Throughput
const mSamples = N / 1e6;
console.log("\n=== Throughput ===");
console.log(`  A perm-table:     ${(mSamples / (tPerm / 1000)).toFixed(1)} Msamples/s`);
console.log(`  B hash scalar:    ${(mSamples / (tHash / 1000)).toFixed(1)} Msamples/s`);
console.log(`  C hash 4-wide JS: ${(mSamples / (tBatch / 1000)).toFixed(1)} Msamples/s`);
console.log(`  B/A speed:        ${(tPerm / tHash).toFixed(2)}×`);
console.log(`  C/B speed:        ${(tHash / tBatch).toFixed(2)}× (JS batch ≈ no free lunch)`);

// Workload model for Scrapstorm recipes
const asphaltPx = 192 * 192;
const vnPerPx = 11; // after last recipe lean
const recipeValueNoise = asphaltPx * vnPerPx;
console.log("\n=== Scrapstorm asphalt bake model ===");
console.log(`  pixels:              ${asphaltPx}`);
console.log(`  valueNoise / px:     ~${vnPerPx}`);
console.log(`  total valueNoise:    ${recipeValueNoise}`);
console.log(
  `  @ B rate:            ~${((recipeValueNoise / 1e6) / (mSamples / (tHash / 1000)) * 1000).toFixed(1)} ms (noise only)`,
);

// Analysis block printed for the agent/user
console.log(`
=== Vectorization analysis ===

1. PARALLELISM AXIS
   Best: vectorize ACROSS pixels (4 independent (x,y) samples per v128).
   Weak: vectorize WITHIN one sample (only 4 lattice corners — and they share
   floor(x)/floor(y), so gain is small; gather still serial).

2. LATTICE STRATEGY
   Perm-table (current A): PERM[PERM[sx]+sy] is a GATHER.
   WASM SIMD has NO gather in baseline 128-bit SIMD → 4 extract + 4 scalar
   loads + 4 replace_lane. Often slower than scalar JS for table noise.
   Integer hash (B): pure i32x4 mul / xor / shift — maps 1:1 to WASM SIMD.
   Recommendation: any SIMD path should use hash lattice, not PERM tables.

3. WHAT VECTORIZES CLEANLY (f32x4 / i32x4)
   ✓ floor, frac, fade (t*t*(3-2t)), lerp, amp/freq scales for fBm
   ✓ integer hash avalanche (imul → i32x4.mul, shifts, xor)
   ✓ scanline packs of 4 consecutive texels
   ✗ perm-table lattice (gather)
   ✗ cellular min-reduction across 9 neighbors (branchy, variable)
   ✗ domain warp if it feeds dependent coords mid-pixel (serializes)

4. JS REALITY
   SIMD.js was withdrawn; browsers expose SIMD only via WASM (v128).
   Pure JS "4-wide" (C) does NOT get hardware SIMD — V8 may autovectorize
   tiny loops but batch APIs in JS usually lose to tight scalar (call/bounds).
   Measured C/B ≈ ${ (tHash / tBatch).toFixed(2) }× here.

5. EXPECTED WASM SIMD GAINS (literature + model)
   Hash value-noise / fBm grid fill: typically 2–4× vs good scalar JS,
   4–8× vs naive sin-hash JS. (WASM SIMD is 128-bit: 4×f32 or 4×i32.)
   On our ~30 ms full 5-recipe pack, noise is ~half; realistic end-to-end
   save ≈ 5–12 ms first load — not frame-time critical after cache.

6. WHEN SIMD IS WORTH IT FOR SCRAPSTORM
   YES if: runtime re-bake (damage decals, 512²+, animated materials),
           many more recipes, or mobile CPU-bound first paint.
   NO  if: bake-once at boot (~30 ms already), maps ≤192², cached.
   BETTER alternatives now:
     • keep scalar hash + lean recipes (done)
     • Web Worker so bake never blocks first frame
     • WebGPU compute for live fields (overkill for static PBR packs)
     • half-res roughness/AO upsample (already on roadmap)

7. CLEAN IMPLEMENTATION PATH (if/when)
   a. noise_hash.wat / Rust crate: value_noise_f32x4 + fbm3_f32x4
      writing Float32Array grids (height, or full SamplePoint SoA)
   b. Feature-detect wasm SIMD → fallback to current TS noise
   c. Bake pass 1 calls wasm.fill(height, albedo, ...) for each recipe
   d. Keep normals in TS (cheap finite differences) or also WASM
   e. Do NOT replace interactive scalar valueNoise() used outside bake
`);

console.log("EXPLORE_SIMD_OK", {
  wasmSimd: wasmSimdSupported(),
  tPerm: +tPerm.toFixed(2),
  tHash: +tHash.toFixed(2),
  tBatch: +tBatch.toFixed(2),
  tFbmHash: +tFbmHash.toFixed(2),
  tFbmBatch: +tFbmBatch.toFixed(2),
});
