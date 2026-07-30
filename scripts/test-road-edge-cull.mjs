/**
 * Unit tests: road segment gate + instance stream packing.
 *   npx tsx scripts/test-road-edge-cull.mjs
 */
import * as THREE from "three";
import { TRACK_SAMPLES, EDGE_MARKERS } from "../src/game/track.ts";
import {
  buildTrackRibbon,
  shouldSegmentRoad,
  roadTriCount,
  ROAD_SEGMENT_TRI_THRESHOLD,
} from "../src/game/world/culling/roadSegments.ts";
import {
  createInstanceStream,
  rebuildInstanceCount,
  fitInstanceBounds,
} from "../src/game/world/culling/instanceStream.ts";
import { cullConfigForTier } from "../src/game/world/culling/cpuTerrainCull.ts";

let failed = 0;
function assert(c, m) {
  if (!c) {
    console.error("FAIL", m);
    failed++;
  } else console.log("ok ", m);
}

const n = TRACK_SAMPLES.length;
const tris = roadTriCount(n);
assert(tris === n * 2, `road tris = samples*2 (${tris})`);
assert(
  !shouldSegmentRoad(n),
  `current circuit ${tris} < threshold ${ROAD_SEGMENT_TRI_THRESHOLD} → mono`,
);
assert(
  shouldSegmentRoad(Math.ceil(ROAD_SEGMENT_TRI_THRESHOLD / 2) + 1),
  "above threshold → segment",
);

const mono = buildTrackRibbon(TRACK_SAMPLES);
assert(mono.mode === "mono", `buildTrackRibbon → mono (got ${mono.mode})`);
assert(mono.roadTris === tris, "mono roadTris match");

const forced = buildTrackRibbon(TRACK_SAMPLES, { triThreshold: 100 });
assert(forced.mode === "segmented", "forced low threshold → segmented");
if (forced.mode === "segmented") {
  assert(forced.segments.length >= 4, `segments >= 4 (got ${forced.segments.length})`);
  const sumTris = forced.segments.reduce((a, s) => a + s.triCount, 0);
  // road+apron tris per interval = 6, n intervals
  assert(sumTris === n * 6, `segment tri sum ${sumTris} === n*6 ${n * 6}`);
  console.log(`  segments=${forced.segments.length} samplesPerSeg=${forced.samplesPerSeg}`);
}

// Instance stream
const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.4, 420);
cam.position.set(10, 8, 20);
cam.lookAt(0, 0, 0);
cam.updateMatrixWorld();
cam.updateProjectionMatrix();

const mats = [];
const spheres = [];
const dummy = new THREE.Object3D();
const step = 1;
EDGE_MARKERS.forEach((m, i) => {
  if (i % step !== 0) return;
  dummy.position.set(m.x, m.y + 0.85, m.z);
  dummy.updateMatrix();
  mats.push(dummy.matrix.clone());
  spheres.push({ x: m.x, y: m.y + 0.85, z: m.z, r: 1.4 });
});
const stream = createInstanceStream(mats, spheres);
const geo = new THREE.BoxGeometry(0.28, 1.7, 0.28);
const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), mats.length);
fitInstanceBounds(mesh, spheres);
const stats = rebuildInstanceCount(
  mesh,
  stream,
  cam,
  cullConfigForTier("medium"),
);
assert(mesh.count === stats.visible, "mesh.count === visible");
assert(stats.visible < stats.tested, `culled some posts ${stats.visible}/${stats.tested}`);
assert(stats.ms < 5, `rebuild under 5ms (${stats.ms.toFixed(3)})`);
console.log(`  edge posts ${stats.visible}/${stats.tested} in ${stats.ms.toFixed(3)}ms`);

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nROAD_EDGE_CULL_OK");
