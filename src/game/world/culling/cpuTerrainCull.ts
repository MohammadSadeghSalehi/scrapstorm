/**
 * CPU-based terrain / prop culling for Scrapstorm.
 *
 * Techniques:
 * 1. Frustum sphere / AABB
 * 2. Distance cull
 * 3. Grid / sector hash
 * 4. Chunked ground tiles
 * 5. Instance stream rebuild (edge posts)
 * 6. Road segments only when tri count ≥ ROAD_SEGMENT_TRI_THRESHOLD
 */

import * as THREE from "three";

// ─── types ───────────────────────────────────────────────────────────

export type CullSphere = {
  x: number;
  y: number;
  z: number;
  r: number;
};

export type CullAABB = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};

export type CullStats = {
  tested: number;
  frustumPass: number;
  distancePass: number;
  visible: number;
  ms: number;
};

export type TerrainCullConfig = {
  maxDistance: number;
  frustumPadding: number;
  backfaceNear: boolean;
};

export const DEFAULT_CULL_CONFIG: TerrainCullConfig = {
  maxDistance: 220,
  frustumPadding: 4,
  backfaceNear: true,
};

// ─── frustum extraction ──────────────────────────────────────────────

const _mat = new THREE.Matrix4();
const _planes: THREE.Plane[] = Array.from({ length: 6 }, () => new THREE.Plane());

export function extractFrustumPlanes(
  camera: THREE.Camera,
  out: THREE.Plane[] = _planes,
): THREE.Plane[] {
  camera.updateMatrixWorld();
  _mat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const me = _mat.elements;

  setPlane(out[0], me[3] + me[0], me[7] + me[4], me[11] + me[8], me[15] + me[12]);
  setPlane(out[1], me[3] - me[0], me[7] - me[4], me[11] - me[8], me[15] - me[12]);
  setPlane(out[2], me[3] - me[1], me[7] - me[5], me[11] - me[9], me[15] - me[13]);
  setPlane(out[3], me[3] + me[1], me[7] + me[5], me[11] + me[9], me[15] + me[13]);
  setPlane(out[4], me[3] + me[2], me[7] + me[6], me[11] + me[10], me[15] + me[14]);
  setPlane(out[5], me[3] - me[2], me[7] - me[6], me[11] - me[10], me[15] - me[14]);
  return out;
}

function setPlane(
  p: THREE.Plane,
  a: number,
  b: number,
  c: number,
  d: number,
) {
  const len = Math.hypot(a, b, c) || 1;
  p.normal.set(a / len, b / len, c / len);
  p.constant = d / len;
}

export function sphereInFrustum(
  s: CullSphere,
  planes: THREE.Plane[],
  padding = 0,
): boolean {
  const r = s.r + padding;
  for (let i = 0; i < 6; i++) {
    const pl = planes[i];
    const dist =
      pl.normal.x * s.x + pl.normal.y * s.y + pl.normal.z * s.z + pl.constant;
    if (dist < -r) return false;
  }
  return true;
}

export function aabbInFrustum(
  box: CullAABB,
  planes: THREE.Plane[],
  padding = 0,
): boolean {
  for (let i = 0; i < 6; i++) {
    const pl = planes[i];
    const nx = pl.normal.x;
    const ny = pl.normal.y;
    const nz = pl.normal.z;
    const px = nx >= 0 ? box.maxX : box.minX;
    const py = ny >= 0 ? box.maxY : box.minY;
    const pz = nz >= 0 ? box.maxZ : box.minZ;
    if (nx * px + ny * py + nz * pz + pl.constant < -padding) return false;
  }
  return true;
}

export function sphereInDistance(
  s: CullSphere,
  camX: number,
  camY: number,
  camZ: number,
  maxDist: number,
): boolean {
  if (maxDist <= 0) return true;
  const dx = s.x - camX;
  const dy = s.y - camY;
  const dz = s.z - camZ;
  const lim = maxDist + s.r;
  return dx * dx + dy * dy + dz * dz <= lim * lim;
}

// ─── grid hash ───────────────────────────────────────────────────────

export type GridCell = {
  ix: number;
  iz: number;
  indices: number[];
};

export function buildSphereGrid(
  spheres: CullSphere[],
  cellSize: number,
): { cellSize: number; cells: Map<string, GridCell> } {
  const cells = new Map<string, GridCell>();
  for (let i = 0; i < spheres.length; i++) {
    const s = spheres[i];
    const ix = Math.floor(s.x / cellSize);
    const iz = Math.floor(s.z / cellSize);
    const key = `${ix},${iz}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { ix, iz, indices: [] };
      cells.set(key, cell);
    }
    cell.indices.push(i);
  }
  return { cellSize, cells };
}

export function queryGridRadius(
  grid: { cellSize: number; cells: Map<string, GridCell> },
  cx: number,
  cz: number,
  radius: number,
): number[] {
  const out: number[] = [];
  const cs = grid.cellSize;
  const minIx = Math.floor((cx - radius) / cs);
  const maxIx = Math.floor((cx + radius) / cs);
  const minIz = Math.floor((cz - radius) / cs);
  const maxIz = Math.floor((cz + radius) / cs);
  for (let ix = minIx; ix <= maxIx; ix++) {
    for (let iz = minIz; iz <= maxIz; iz++) {
      const cell = grid.cells.get(`${ix},${iz}`);
      if (cell) out.push(...cell.indices);
    }
  }
  return out;
}

// ─── chunked ground ──────────────────────────────────────────────────

export type GroundTile = {
  id: number;
  x: number;
  z: number;
  half: number;
  sphere: CullSphere;
  aabb: CullAABB;
};

export function buildGroundTiles(opts: {
  centerX: number;
  centerZ: number;
  halfExtent: number;
  tileSize: number;
  y?: number;
}): GroundTile[] {
  const y = opts.y ?? -0.9;
  const tiles: GroundTile[] = [];
  const n = Math.max(1, Math.ceil((opts.halfExtent * 2) / opts.tileSize));
  const originX = opts.centerX - opts.halfExtent;
  const originZ = opts.centerZ - opts.halfExtent;
  let id = 0;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = originX + (ix + 0.5) * opts.tileSize;
      const z = originZ + (iz + 0.5) * opts.tileSize;
      const half = opts.tileSize * 0.5;
      const dist = Math.hypot(x - opts.centerX, z - opts.centerZ);
      if (dist > opts.halfExtent + half * 0.5) continue;
      tiles.push({
        id: id++,
        x,
        z,
        half,
        sphere: { x, y, z, r: half * Math.SQRT2 },
        aabb: {
          minX: x - half,
          maxX: x + half,
          minY: y - 0.5,
          maxY: y + 0.5,
          minZ: z - half,
          maxZ: z + half,
        },
      });
    }
  }
  return tiles;
}

// ─── batch cull ──────────────────────────────────────────────────────

export function cullSpheres(
  spheres: CullSphere[],
  camera: THREE.Camera,
  config: TerrainCullConfig = DEFAULT_CULL_CONFIG,
  indices?: number[],
): { visible: number[]; stats: CullStats } {
  const t0 =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  const planes = extractFrustumPlanes(camera);
  const cam = camera.position;
  const list = indices ?? spheres.map((_, i) => i);
  const visible: number[] = [];
  let frustumPass = 0;
  let distancePass = 0;

  for (let k = 0; k < list.length; k++) {
    const i = list[k];
    const s = spheres[i];
    if (!sphereInDistance(s, cam.x, cam.y, cam.z, config.maxDistance)) {
      continue;
    }
    distancePass++;
    if (!sphereInFrustum(s, planes, config.frustumPadding)) continue;
    frustumPass++;
    visible.push(i);
  }

  const t1 =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  return {
    visible,
    stats: {
      tested: list.length,
      frustumPass,
      distancePass,
      visible: visible.length,
      ms: t1 - t0,
    },
  };
}

export function cullAABBs(
  boxes: CullAABB[],
  camera: THREE.Camera,
  config: TerrainCullConfig = DEFAULT_CULL_CONFIG,
): { visible: number[]; stats: CullStats } {
  const t0 =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  const planes = extractFrustumPlanes(camera);
  const cam = camera.position;
  const visible: number[] = [];
  let frustumPass = 0;
  let distancePass = 0;

  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const cx = (b.minX + b.maxX) * 0.5;
    const cy = (b.minY + b.maxY) * 0.5;
    const cz = (b.minZ + b.maxZ) * 0.5;
    const r =
      Math.hypot(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ) * 0.5;
    if (!sphereInDistance({ x: cx, y: cy, z: cz, r }, cam.x, cam.y, cam.z, config.maxDistance)) {
      continue;
    }
    distancePass++;
    if (!aabbInFrustum(b, planes, config.frustumPadding)) continue;
    frustumPass++;
    visible.push(i);
  }

  const t1 =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  return {
    visible,
    stats: {
      tested: boxes.length,
      frustumPass,
      distancePass,
      visible: visible.length,
      ms: t1 - t0,
    },
  };
}

export function cullConfigForTier(
  tier: "low" | "medium" | "high",
): TerrainCullConfig {
  if (tier === "low") {
    return { maxDistance: 140, frustumPadding: 6, backfaceNear: true };
  }
  if (tier === "high") {
    return { maxDistance: 280, frustumPadding: 3, backfaceNear: true };
  }
  return { maxDistance: 200, frustumPadding: 4, backfaceNear: true };
}

export const CPU_CULL_FINDINGS = {
  summary:
    "CPU frustum + distance culling for dunes, scenery, ground tiles, edge instance streams; road mono until tri count grows.",
  techniques: [
    {
      name: "Frustum sphere",
      cost: "O(6) planes · object",
      bestFor: "dunes, towers, beacons",
    },
    {
      name: "Frustum AABB",
      cost: "O(6) · object",
      bestFor: "ground tiles, road segments",
    },
    {
      name: "Distance radius",
      cost: "O(1) · object",
      bestFor: "early reject",
    },
    {
      name: "Grid prefilter",
      cost: "O(cells) then O(local N)",
      bestFor: "edge posts",
    },
    {
      name: "Chunked ground",
      cost: "tile count × cull",
      bestFor: "sand fill-rate",
    },
    {
      name: "Instance stream",
      cost: "O(visible) matrix writes",
      bestFor: "edge posts InstancedMesh.count",
    },
    {
      name: "Road segments",
      cost: "draw calls × segments",
      bestFor: "only when roadTris ≥ 3000",
    },
  ],
  scrapstormNow: {
    sandDisc: "chunked tiles + cull",
    dunes: "sphere cull",
    scenery: "sphere cull",
    edges: "grid + instance count rebuild",
    roadApron: "mono at 560 tris; segments if ≥ 3000",
  },
  recommendedOrder: [
    "1. Cull dunes + scenery — done",
    "2. Chunk sand — done",
    "3. Edge post instance count — done",
    "4. Road segments gated by tri threshold — done",
  ],
} as const;
