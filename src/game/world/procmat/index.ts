/**
 * Procedural materials — public API.
 * CPU bake + optional GPU detail/LoD via createProcMaterial.
 */
export {
  bakeProcMaps,
  measureSampleBakeMs,
  cloneMaps,
  clearProcCache,
  type ProcMaps,
  type SamplePoint,
} from "./bake";
export {
  createProcMaterial,
  getRecipeMaps,
  getRecipeBakeSpec,
  checkerMap,
  hazardMap,
  type RecipeId,
  type ProcMaterialOpts,
} from "./recipes";
export {
  fbm,
  fbm2,
  fbm3,
  fbmFast,
  ridged,
  cellular,
  valueNoise,
  hash2,
  warp,
  warpInto,
  clamp01,
  lerp,
  smoothstep,
} from "./noise";
export {
  bench,
  printBenchTable,
  hashLatticeJS,
  valueNoiseHashJS,
  fbm3HashJS,
  makeGrid,
  speedup,
  wasmSimdSupported,
  type BenchResult,
} from "./bench";
export {
  preloadWasmNoise,
  getWasmNoiseStatus,
  getWasmNoiseModule,
  wasmFillFbmGrid,
} from "./wasmRuntime";
