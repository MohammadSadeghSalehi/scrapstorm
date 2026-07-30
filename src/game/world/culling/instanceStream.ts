/**
 * Pack visible instance matrices into an InstancedMesh and set .count.
 * Used by edge posts — O(visible) matrix writes per frame.
 */
import * as THREE from "three";
import {
  cullSpheres,
  type CullSphere,
  type CullStats,
  type TerrainCullConfig,
  DEFAULT_CULL_CONFIG,
} from "./cpuTerrainCull";

export type InstanceStream = {
  spheres: CullSphere[];
  matrices: THREE.Matrix4[];
  /** Scratch — reused every frame */
  _tmp: THREE.Matrix4;
};

export function createInstanceStream(
  matrices: THREE.Matrix4[],
  spheres: CullSphere[],
): InstanceStream {
  if (matrices.length !== spheres.length) {
    throw new Error("instance stream: matrices/spheres length mismatch");
  }
  return { spheres, matrices, _tmp: new THREE.Matrix4() };
}

/**
 * Cull + compact visible instances into mesh[0..count).
 * Returns stats for QA.
 */
export function rebuildInstanceCount(
  mesh: THREE.InstancedMesh,
  stream: InstanceStream,
  camera: THREE.Camera,
  config: TerrainCullConfig = DEFAULT_CULL_CONFIG,
  indices?: number[],
): CullStats {
  const { visible, stats } = cullSpheres(
    stream.spheres,
    camera,
    config,
    indices,
  );
  const n = visible.length;
  for (let k = 0; k < n; k++) {
    mesh.setMatrixAt(k, stream.matrices[visible[k]]);
  }
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
  // keep frustumCulled on the whole mesh; bounding sphere should cover track
  return stats;
}

/** Expand bounding sphere so Three doesn't cull the whole InstancedMesh. */
export function fitInstanceBounds(
  mesh: THREE.InstancedMesh,
  spheres: CullSphere[],
) {
  if (spheres.length === 0) return;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (const s of spheres) {
    minX = Math.min(minX, s.x - s.r);
    minY = Math.min(minY, s.y - s.r);
    minZ = Math.min(minZ, s.z - s.r);
    maxX = Math.max(maxX, s.x + s.r);
    maxY = Math.max(maxY, s.y + s.r);
    maxZ = Math.max(maxZ, s.z + s.r);
  }
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const r = Math.hypot(maxX - cx, maxY - cy, maxZ - cz);
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), r);
  mesh.frustumCulled = false; // we do CPU instance cull ourselves
}
