/**
 * Procedural noise benchmarks — runnable snippets.
 *
 *   npx tsx scripts/bench-noise.mjs
 *   npx tsx scripts/bench-noise.mjs --size 512
 *
 * Source snippets (copy-paste friendly):
 *   src/game/world/procmat/bench/snippets.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bench,
  printBenchTable,
  snippetA_scalarValueNoise,
  snippetA2_scalarFbm3,
  snippetB_wasmValueNoise,
  snippetB2_wasmFbm3,
  snippetC_recipeBakes,
  snippetD_microOps,
  loadWasmNoise,
  wasmSimdSupported,
  speedup,
  valueNoiseHashJS,
  hashLatticeJS,
} from "../src/game/world/procmat/bench/snippets.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.join(
  __dirname,
  "../src/game/world/procmat/wasm/hash_lattice_simd.wasm",
);

const sizeIdx = process.argv.indexOf("--size");
const SIZE =
  sizeIdx >= 0
    ? parseInt(process.argv[sizeIdx + 1], 10)
    : 256;

console.log("=== Noise benchmark suite ===");
console.log("grid:", `${SIZE}×${SIZE}`);
console.log("wasm_simd:", wasmSimdSupported());
console.log("");

// ── Snippet copy-paste reference ───────────────────────────────────────────
console.log(`// ── Snippet reference (src/game/world/procmat/bench/snippets.ts) ──
//
// // A — scalar hash valueNoise grid
// const { xs, ys, out, n } = makeGrid(${SIZE});
// bench("JS valueNoise", () => {
//   for (let i = 0; i < n; i++) out[i] = valueNoiseHashJS(xs[i], ys[i], 1);
// });
//
// // B — WASM SIMD fill (count % 4 === 0, 16-byte aligned ptrs)
// mod.fill_value_noise(outPtr, xsPtr, ysPtr, n, /*seed*/ 1);
// mod.fill_fbm3(outPtr, xsPtr, ysPtr, n, /*seed*/ 2);
//
// // C — full recipe bake (sample + normals)
// measureSampleBakeMs(size, sample, { normalStrength });
//
// // D — micro: hash / valueNoise / fbm3 × 1e6
// for (let i = 0; i < 1e6; i++) hashLatticeJS(i, i, 1);
`);

console.log("--- A / A2  scalar JS ---");
const a = snippetA_scalarValueNoise(SIZE, SIZE);
const a2 = snippetA2_scalarFbm3(SIZE, SIZE);
printBenchTable([a, a2]);

let b = null;
let b2 = null;
if (wasmSimdSupported() && fs.existsSync(wasmPath)) {
  console.log("\n--- B / B2  WASM SIMD ---");
  const mod = await loadWasmNoise(fs.readFileSync(wasmPath));
  b = snippetB_wasmValueNoise(mod, SIZE, SIZE);
  b2 = snippetB2_wasmFbm3(mod, SIZE, SIZE);
  printBenchTable([b, b2]);
  console.log(`\n  speedup valueNoise  ${speedup(a, b).toFixed(2)}×`);
  console.log(`  speedup fbm3        ${speedup(a2, b2).toFixed(2)}×`);
} else {
  console.log("\n--- B / B2  skipped (no wasm simd or missing .wasm) ---");
}

console.log("\n--- C  recipe bakes ---");
const cRows = await snippetC_recipeBakes();
printBenchTable(cRows);
const cTotal = cRows.reduce((s, r) => s + r.ms, 0);
console.log(
  `  ${"C  all recipes total".padEnd(40)} ${cTotal.toFixed(3).padStart(8)} ms`,
);

console.log("\n--- D  micro ops (1e6 evals) ---");
const dRows = snippetD_microOps(1_000_000);
printBenchTable(dRows);

{
  const h = hashLatticeJS(3, 7, 9);
  const v = valueNoiseHashJS(1.25, 2.5, 3);
  if (!(h >= 0 && h < 1 && v >= 0 && v <= 1)) {
    console.error("sanity fail", { h, v });
    process.exit(1);
  }
}

const demo = bench("inline demo (hash×100k)", () => {
  let s = 0;
  for (let i = 0; i < 100_000; i++) s += hashLatticeJS(i, i * 2, 1);
  if (s === Infinity) throw 0;
});
console.log("\n--- inline demo ---");
printBenchTable([demo]);

console.log("\nBENCH_NOISE_OK", {
  size: SIZE,
  valueNoiseJsMs: +a.ms.toFixed(3),
  valueNoiseWasmMs: b ? +b.ms.toFixed(3) : null,
  fbm3JsMs: +a2.ms.toFixed(3),
  fbm3WasmMs: b2 ? +b2.ms.toFixed(3) : null,
  speedupVn: b ? +speedup(a, b).toFixed(2) : null,
  speedupFbm3: b2 ? +speedup(a2, b2).toFixed(2) : null,
  recipeTotalMs: +cTotal.toFixed(2),
});
