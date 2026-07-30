/**
 * Unit tests for GPU detail LoD bands.
 *   npx tsx scripts/test-gpu-lod.mjs
 */
import {
  lodBandAtDistance,
  lodBandsFromQuality,
} from "../src/game/world/shaders/gpuDetail.ts";
import { settingsFor } from "../src/game/world/quality.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL", msg);
    failed++;
  } else {
    console.log("ok ", msg);
  }
}

for (const tier of ["low", "medium", "high"]) {
  const q = settingsFor(tier);
  const b = lodBandsFromQuality(q);
  assert(b.near < b.mid && b.mid < b.far, `${tier}: near < mid < far (${b.near}<${b.mid}<${b.far})`);
  assert(lodBandAtDistance(0, b) === 3, `${tier}: dist 0 → band 3`);
  assert(lodBandAtDistance(b.near - 0.01, b) === 3, `${tier}: just under near → 3`);
  assert(lodBandAtDistance((b.near + b.mid) / 2, b) === 2, `${tier}: mid zone → 2`);
  assert(lodBandAtDistance((b.mid + b.far) / 2, b) === 1, `${tier}: far zone → 1`);
  assert(lodBandAtDistance(b.far + 1, b) === 0, `${tier}: past far → 0`);
}

// Explicit mid optional derivation
const noMid = { lodNear: 20, lodFar: 100, gpuDetail: 1, shaderOctaves: 2 };
const derived = lodBandsFromQuality(/** @type {any} */ (noMid));
assert(
  Math.abs(derived.mid - (20 + 80 * 0.45)) < 0.01,
  `derived mid ≈ 56 (got ${derived.mid})`,
);

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nGPU_LOD_OK");
