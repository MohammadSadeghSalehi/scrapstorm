/**
 * Noise + recipe bake benchmarks / correctness.
 */
import {
  fbm,
  fbm2,
  fbm3,
  ridged,
  cellular,
  valueNoise,
  warp,
  clamp01,
  hash2,
} from "../src/game/world/procmat/noise.ts";
import {
  getRecipeBakeSpec,
  getRecipeMaps,
  createProcMaterial,
} from "../src/game/world/procmat/recipes.ts";
import { measureSampleBakeMs, clearProcCache } from "../src/game/world/procmat/bake.ts";

for (let i = 0; i < 80; i++) {
  const n = valueNoise(i * 0.3, i * 0.17, 1);
  if (n < 0 || n > 1) {
    console.error("valueNoise OOR", n);
    process.exit(1);
  }
  const f = fbm(i * 0.1, i * 0.08, { octaves: 4, seed: 2 });
  if (f < 0 || f > 1) {
    console.error("fbm OOR", f);
    process.exit(1);
  }
  if (fbm2(i, i, 3) < 0 || fbm3(i, i, 4) > 1.0001) {
    console.error("fbm2/3 OOR");
    process.exit(1);
  }
  const r = ridged(i * 0.2, i * 0.11, { seed: 3 });
  if (r < 0 || r > 1) {
    console.error("ridged OOR", r);
    process.exit(1);
  }
  const c = cellular(i * 0.15, i * 0.2, 4);
  if (c < 0 || c > 1) {
    console.error("cellular OOR", c);
    process.exit(1);
  }
  const h = hash2(i, i * 3, 9);
  if (h < 0 || h >= 1) {
    console.error("hash2 OOR", h);
    process.exit(1);
  }
}

const a = fbm(2.5, 3.5, { seed: 9, octaves: 4 });
const b = fbm(2.5, 3.5, { seed: 9, octaves: 4 });
if (a !== b) {
  console.error("not deterministic", a, b);
  process.exit(1);
}
const w = warp(1.2, 3.4, 0.5, 0);
if (!Number.isFinite(w.x) || !Number.isFinite(w.y)) {
  console.error("warp bad", w);
  process.exit(1);
}

function bench(label, fn, iters = 1) {
  fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = (performance.now() - t0) / iters;
  console.log(`bench ${label}: ${ms.toFixed(2)} ms`);
  return ms;
}

const N = 256;
bench("valueNoise 256²", () => {
  let s = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) s += valueNoise(x * 0.1, y * 0.1, 1);
  return s;
});
bench("fbm3 256²", () => {
  let s = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) s += fbm3(x * 0.05, y * 0.05, 2);
  return s;
});

clearProcCache();
const ids = ["asphalt", "dirt", "sand", "metal", "rust"];
let total = 0;
for (const id of ids) {
  const spec = getRecipeBakeSpec(id);
  const ms = measureSampleBakeMs(spec.size, spec.sample, {
    normalStrength: spec.normalStrength,
  });
  // second call for stable timing after warmup
  const ms2 = measureSampleBakeMs(spec.size, spec.sample, {
    normalStrength: spec.normalStrength,
  });
  console.log(`bake ${id} ${spec.size}²: ${ms2.toFixed(2)} ms (first ${ms.toFixed(2)})`);
  total += ms2;
  const maps = getRecipeMaps(id);
  if (!maps.map || !maps.normalMap) {
    console.error("missing maps", id);
    process.exit(1);
  }
}
console.log(`all recipes bake total: ${total.toFixed(2)} ms`);

const mat = createProcMaterial("asphalt", { repeat: [2, 2], ao: true });
if (!mat.map || mat.map.repeat.x !== 2) {
  console.error("material maps/repeat fail");
  process.exit(1);
}

// Budget: full pack should be snappy on first load
if (total > 120) {
  console.error("FAIL bake budget", total);
  process.exit(1);
}

console.log("PROCMAT OK", {
  fbm: +a.toFixed(4),
  clamp: clamp01(1.5),
  totalBakeMs: +total.toFixed(2),
  recipes: ids,
});
