/**
 * Explore / bench CPU terrain culling (no browser).
 *   npx tsx scripts/explore-cpu-terrain-cull.mjs
 */
import * as THREE from "three";
import {
  buildGroundTiles,
  buildSphereGrid,
  cullAABBs,
  cullSpheres,
  cullConfigForTier,
  queryGridRadius,
  CPU_CULL_FINDINGS,
} from "../src/game/world/culling/cpuTerrainCull.ts";

console.log("=== CPU terrain culling exploration ===\n");
console.log(CPU_CULL_FINDINGS.summary);
console.log("\nTechniques:");
for (const t of CPU_CULL_FINDINGS.techniques) {
  console.log(`  • ${t.name} (${t.cost}) — ${t.bestFor}`);
}
console.log("\nScrapstorm now:", CPU_CULL_FINDINGS.scrapstormNow);
console.log("\nRecommended:", CPU_CULL_FINDINGS.recommendedOrder.join("\n  "));

// Synthetic camera looking toward origin from SE
const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.4, 420);
camera.position.set(40, 12, -30);
camera.lookAt(20, 0, 40);
camera.updateMatrixWorld();
camera.updateProjectionMatrix();

const cfg = cullConfigForTier("medium");

// Dunes-like spheres
const dunes = [];
for (let i = 0; i < 18; i++) {
  const a = (i / 18) * Math.PI * 2;
  const r = 100 + (i % 5) * 24;
  dunes.push({
    x: Math.cos(a) * r + 20,
    y: -0.7,
    z: Math.sin(a) * r + 40,
    r: 14 + (i % 4) * 5,
  });
}
const duneRes = cullSpheres(dunes, camera, cfg);
console.log("\n--- Dunes (18) ---");
console.log(duneRes.stats);

// Scenery-like
const scenery = [];
for (let i = 0; i < 39; i++) {
  const a = (i / 39) * Math.PI * 2;
  scenery.push({
    x: Math.cos(a) * 90 + 20,
    y: 3,
    z: Math.sin(a) * 70 + 40,
    r: 6,
  });
}
const scnRes = cullSpheres(scenery, camera, cfg);
console.log("\n--- Scenery (39) ---");
console.log(scnRes.stats);

// Ground tiles
const tiles = buildGroundTiles({
  centerX: 20,
  centerZ: 40,
  halfExtent: 340,
  tileSize: 64,
});
const tileRes = cullAABBs(
  tiles.map((t) => t.aabb),
  camera,
  { ...cfg, maxDistance: cfg.maxDistance + 40 },
);
console.log(`\n--- Ground tiles (${tiles.length}) ---`);
console.log(tileRes.stats);
console.log(
  `  culled ${(100 * (1 - tileRes.stats.visible / tiles.length)).toFixed(0)}% of tiles`,
);

// Grid prefilter on 200 edge posts
const posts = [];
for (let i = 0; i < 200; i++) {
  posts.push({
    x: (i % 20) * 16 - 140,
    y: 0.85,
    z: Math.floor(i / 20) * 16 - 50,
    r: 1.2,
  });
}
const grid = buildSphereGrid(posts, 32);
const candidates = queryGridRadius(grid, camera.position.x, camera.position.z, 200);
const t0 = performance.now();
const postRes = cullSpheres(posts, camera, cfg, candidates);
const t1 = performance.now();
const full = cullSpheres(posts, camera, cfg);
console.log("\n--- Edge posts (200) grid vs full ---");
console.log(
  `  grid candidates ${candidates.length} → visible ${postRes.stats.visible} in ${(t1 - t0).toFixed(3)}ms`,
);
console.log(
  `  full test visible ${full.stats.visible} in ${full.stats.ms.toFixed(3)}ms`,
);

// Throughput stress
const many = [];
for (let i = 0; i < 5000; i++) {
  many.push({
    x: (Math.random() - 0.5) * 800,
    y: 0,
    z: (Math.random() - 0.5) * 800,
    r: 2 + Math.random() * 4,
  });
}
const stress = cullSpheres(many, camera, cfg);
console.log("\n--- Stress 5k spheres ---");
console.log(
  `  ${stress.stats.visible}/${stress.stats.tested} visible in ${stress.stats.ms.toFixed(3)}ms`,
);

console.log("\nCPU_CULL_EXPLORE_OK");
