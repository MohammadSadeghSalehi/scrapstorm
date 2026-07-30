/**
 * Benchmark snippets for procmat noise / WASM SIMD.
 * Run: node scripts/bench-noise.mjs
 */
export {
  bench,
  withThroughput,
  formatBenchRow,
  printBenchTable,
  hashLatticeJS,
  valueNoiseHashJS,
  fbm3HashJS,
  snippetA_scalarValueNoise,
  snippetA2_scalarFbm3,
  snippetB_wasmValueNoise,
  snippetB2_wasmFbm3,
  snippetC_recipeBakes,
  snippetD_microOps,
  loadWasmNoise,
  wasmSimdSupported,
  makeGrid,
  speedup,
  type BenchResult,
  type WasmNoiseModule,
} from "./snippets";
