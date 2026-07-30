/**
 * Explore WASM SIMD hash-lattice noise vs scalar JS.
 *
 * Kernel: src/game/world/procmat/wasm/hash_lattice_simd.{wat,wasm}
 * Run: node scripts/explore-wasm-simd-hash.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hash2 } from "../src/game/world/procmat/noise.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.join(
  __dirname,
  "../src/game/world/procmat/wasm/hash_lattice_simd.wasm",
);

function hashLatticeJS(ix, iy, seed) {
  let n =
    Math.imul(ix | 0, 374761393) +
    Math.imul(iy | 0, 668265263) +
    Math.imul(seed | 0, 1442695041);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n = (n ^ (n >>> 16)) >>> 0;
  return n / 4294967296;
}

function fade(t) {
  return t * t * (3 - 2 * t);
}

function valueNoiseHashJS(x, y, seed = 0) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const a = hashLatticeJS(x0, y0, seed);
  const b = hashLatticeJS(x0 + 1, y0, seed);
  const c = hashLatticeJS(x0, y0 + 1, seed);
  const d = hashLatticeJS(x0 + 1, y0 + 1, seed);
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}

function fbm3HashJS(x, y, seed = 0) {
  return (
    (0.5 * valueNoiseHashJS(x, y, seed) +
      0.25 * valueNoiseHashJS(x * 2, y * 2, seed + 1) +
      0.125 * valueNoiseHashJS(x * 4, y * 4, seed + 2)) /
    0.875
  );
}

function wasmSimdOk() {
  try {
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

const bytes = fs.readFileSync(wasmPath);
const { instance } = await WebAssembly.instantiate(bytes);
const {
  memory,
  fill_value_noise,
  fill_fbm3,
  value_noise4_ptr,
  hash4_ptr,
} = instance.exports;

function ensureBytes(need) {
  const pages = Math.ceil(need / 65536);
  const have = memory.buffer.byteLength / 65536;
  if (pages > have) memory.grow(pages - have);
}

function f32View(ptr, n) {
  return new Float32Array(memory.buffer, ptr, n);
}
function i32View(ptr, n) {
  return new Int32Array(memory.buffer, ptr, n);
}

function bench(label, fn, iters = 7) {
  fn();
  let best = Infinity;
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  console.log(`  ${label.padEnd(42)} ${best.toFixed(3)} ms`);
  return best;
}

console.log("=== WASM SIMD hash-lattice exploration ===");
console.log("runtime:", process.version);
console.log("wasm_simd:", wasmSimdOk());
console.log("module bytes:", bytes.byteLength);

// ── Correctness: hash (small buffers at start of memory) ───────────────────
{
  ensureBytes(48);
  const ix = i32View(0, 4);
  const iy = i32View(16, 4);
  const out = f32View(32, 4);
  ix.set([0, 1, -3, 42]);
  iy.set([0, 2, 7, -1]);
  hash4_ptr(32, 0, 16, 9);
  let maxErr = 0;
  for (let i = 0; i < 4; i++) {
    const ref = hashLatticeJS(ix[i], iy[i], 9);
    const ref2 = hash2(ix[i], iy[i], 9);
    maxErr = Math.max(maxErr, Math.abs(out[i] - ref), Math.abs(out[i] - ref2));
  }
  console.log(`\nhash4 max|wasm-js|: ${maxErr.toExponential(2)}`);
  if (maxErr > 1e-6) {
    console.error("HASH MISMATCH", [...out]);
    process.exit(1);
  }
}

// ── Correctness: value noise ───────────────────────────────────────────────
{
  ensureBytes(112);
  const xs = f32View(64, 4);
  const ys = f32View(80, 4);
  const out = f32View(96, 4);
  xs.set([0.1, 1.5, 3.25, -2.1]);
  ys.set([0.2, 2.5, -1.75, 4.0]);
  value_noise4_ptr(96, 64, 80, 3);
  let maxErr = 0;
  for (let i = 0; i < 4; i++) {
    maxErr = Math.max(maxErr, Math.abs(out[i] - valueNoiseHashJS(xs[i], ys[i], 3)));
  }
  console.log(`value_noise4 max|wasm-js|: ${maxErr.toExponential(2)}`);
  if (maxErr > 1e-5) {
    console.error("VN MISMATCH", [...out]);
    process.exit(1);
  }
}

// ── Grid: grow once, then views ────────────────────────────────────────────
const W = 256;
const H = 256;
const N = W * H;
const XS = 0;
const YS = N * 4;
const OUT = N * 8;
ensureBytes(N * 12 + 64);

const xs = f32View(XS, N);
const ys = f32View(YS, N);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    xs[i] = x * 0.07;
    ys[i] = y * 0.07;
  }
}

// Host copies (stable, not WASM memory)
const xsH = new Float32Array(N);
const ysH = new Float32Array(N);
xsH.set(xs);
ysH.set(ys);
const outH = new Float32Array(N);

console.log(`\ngrid: ${W}×${H} = ${N} samples\n`);

const tJsVn = bench("JS hash valueNoise (scalar loop)", () => {
  for (let i = 0; i < N; i++) outH[i] = valueNoiseHashJS(xsH[i], ysH[i], 1);
});

const tWasmVn = bench("WASM SIMD fill_value_noise", () => {
  fill_value_noise(OUT, XS, YS, N, 1);
});

const tJsFbm = bench("JS hash fbm3 (scalar loop)", () => {
  for (let i = 0; i < N; i++) outH[i] = fbm3HashJS(xsH[i], ysH[i], 2);
});

const tWasmFbm = bench("WASM SIMD fill_fbm3", () => {
  fill_fbm3(OUT, XS, YS, N, 2);
});

{
  fill_value_noise(OUT, XS, YS, N, 5);
  const o = f32View(OUT, N);
  let maxErr = 0;
  for (let i = 0; i < N; i += 97) {
    maxErr = Math.max(maxErr, Math.abs(o[i] - valueNoiseHashJS(xsH[i], ysH[i], 5)));
  }
  console.log(`\ngrid sample max|wasm-js|: ${maxErr.toExponential(2)}`);
  if (maxErr > 1e-5) {
    console.error("GRID MISMATCH");
    process.exit(1);
  }
}

const mS = N / 1e6;
console.log("\n=== Throughput ===");
console.log(`  JS  valueNoise:  ${(mS / (tJsVn / 1000)).toFixed(1)} Msamples/s`);
console.log(`  WASM valueNoise: ${(mS / (tWasmVn / 1000)).toFixed(1)} Msamples/s`);
console.log(`  speedup VN:      ${(tJsVn / tWasmVn).toFixed(2)}×`);
console.log(`  JS  fbm3:        ${(mS / (tJsFbm / 1000)).toFixed(1)} Msamples/s`);
console.log(`  WASM fbm3:       ${(mS / (tWasmFbm / 1000)).toFixed(1)} Msamples/s`);
console.log(`  speedup fbm3:    ${(tJsFbm / tWasmFbm).toFixed(2)}×`);

const asphaltN = 192 * 192;
const vnPerPx = 11;
const noiseEvals = asphaltN * vnPerPx;
const jsMs = (noiseEvals / 1e6 / (mS / (tJsVn / 1000))) * 1000;
const wasmMs = (noiseEvals / 1e6 / (mS / (tWasmVn / 1000))) * 1000;
console.log("\n=== Asphalt bake noise-only model (≈11 VN/px @ 192²) ===");
console.log(`  JS estimate:   ${jsMs.toFixed(2)} ms`);
console.log(`  WASM estimate: ${wasmMs.toFixed(2)} ms`);
console.log(`  saved:         ${(jsMs - wasmMs).toFixed(2)} ms`);

console.log(`
=== WASM SIMD hash lattice — findings ===

KERNEL
  hash:  i32x4 mul/add + v128.xor + i32x4.shr_u + f32x4.convert_i32x4_u
  noise: f32x4.floor → trunc_sat → 4× corner hash → f32x4 fade/lerp
  axis:  4 independent pixels per v128

WHY HASH LATTICE
  No gathers. Pure arithmetic maps 1:1 to WASM SIMD.
  4 corner hashes still run as full-width ops (across pixels).

MATCHING JS
  Same constants as hash2 → max error ~1e-8 on f32 path.

WIRE-IN CRITERIA
  Yes: re-bake / ≥512² / many recipes / mobile first paint
  No:  one-shot ≤192² cached pack (~30 ms total already)
`);

console.log("EXPLORE_WASM_SIMD_HASH_OK", {
  speedupVn: +(tJsVn / tWasmVn).toFixed(2),
  speedupFbm3: +(tJsFbm / tWasmFbm).toFixed(2),
  tJsVn: +tJsVn.toFixed(3),
  tWasmVn: +tWasmVn.toFixed(3),
  tJsFbm: +tJsFbm.toFixed(3),
  tWasmFbm: +tWasmFbm.toFixed(3),
});
