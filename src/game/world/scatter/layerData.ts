/**
 * Instance payload for a scatter layer.
 *
 * Kept separate from the React component so the field builders can be exercised
 * — and their clearance maths checked — without a renderer, a canvas or a
 * texture library. Placement bugs in this project have historically only been
 * visible by driving the circuit; a plain data path is what makes them
 * assertable instead.
 */
import * as THREE from "three";
import type { QualityTier } from "../quality";

export type TierScale = Record<QualityTier, number>;

export type ScatterItem = {
  matrix: THREE.Matrix4;
  /** Cull sphere, in world space. */
  x: number;
  y: number;
  z: number;
  r: number;
  /** Draw distance at the high tier; scaled down per tier at cull time. */
  limit: number;
  color?: THREE.Color;
  /**
   * Atlas cell this instance draws, as `[u0, v0, du, dv]`.
   *
   * Carried alongside the matrix rather than baked into the geometry because
   * that is the entire mechanism by which one InstancedMesh can show sixteen
   * different sign faces. See signFaces.ts for the shader insert that consumes
   * it, and note that it must be REPACKED with the matrices during culling —
   * the cull moves visible instances to the front of the buffer, and an
   * attribute left in source order would hand each surviving sign the picture of
   * whichever one used to be in its slot.
   */
  uv?: readonly [number, number, number, number];
};

/**
 * Per-instance visibility gate for layers whose instances can be destroyed.
 *
 * Structural rather than an import of the damage registry, so layerData stays a
 * plain data module: a field of rocks has no notion of being smashed and must
 * not acquire one just because the guard rail does.
 *
 * `version` exists because the cull skips its repack whenever nothing about the
 * camera has changed. Without something to watch, a rail module destroyed while
 * the player sat still would carry on being drawn.
 */
export type InstanceDamage = {
  isDown(i: number): boolean;
  version(): number;
};

export type ScatterLayerData = {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  matrices: Float32Array;
  colors: Float32Array | null;
  /** Per-instance atlas rects, four floats each. Null if no item carried one. */
  uvs: Float32Array | null;
  cx: Float32Array;
  cy: Float32Array;
  cz: Float32Array;
  cr: Float32Array;
  lim2: Float32Array;
  total: number;
  castShadow: boolean;
  receiveShadow: boolean;
  damage: InstanceDamage | null;
};

const WHITE = new THREE.Color(1, 1, 1);
const FULL_UV: readonly [number, number, number, number] = [0, 0, 1, 1];

/**
 * Flatten instances into the typed arrays the per-frame cull walks.
 *
 * Structure-of-arrays, not an array of Matrix4: the cull loop touches every
 * instance every rebuild, and chasing a few thousand object pointers there is
 * the difference between a cull that costs microseconds and one that shows up
 * in a frame graph.
 */
export function packLayer(opts: {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  items: ScatterItem[];
  castShadow?: boolean;
  receiveShadow?: boolean;
  damage?: InstanceDamage;
}): ScatterLayerData {
  const n = opts.items.length;
  const matrices = new Float32Array(n * 16);
  const anyColor = opts.items.some((it) => it.color);
  const colors = anyColor ? new Float32Array(n * 3) : null;
  const anyUv = opts.items.some((it) => it.uv);
  const uvs = anyUv ? new Float32Array(n * 4) : null;
  const cx = new Float32Array(n);
  const cy = new Float32Array(n);
  const cz = new Float32Array(n);
  const cr = new Float32Array(n);
  const lim2 = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const it = opts.items[i]!;
    matrices.set(it.matrix.elements, i * 16);
    cx[i] = it.x;
    cy[i] = it.y;
    cz[i] = it.z;
    cr[i] = it.r;
    lim2[i] = it.limit * it.limit;
    if (colors) {
      const c = it.color ?? WHITE;
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    if (uvs) {
      // A missing rect is the WHOLE texture, not cell zero: an instance that
      // forgot its face should look obviously wrong rather than quietly wear
      // whichever picture happens to be first in the atlas.
      const r = it.uv ?? FULL_UV;
      uvs[i * 4] = r[0];
      uvs[i * 4 + 1] = r[1];
      uvs[i * 4 + 2] = r[2];
      uvs[i * 4 + 3] = r[3];
    }
  }

  return {
    geometry: opts.geometry,
    material: opts.material,
    matrices,
    colors,
    uvs,
    cx,
    cy,
    cz,
    cr,
    lim2,
    total: n,
    castShadow: opts.castShadow ?? false,
    receiveShadow: opts.receiveShadow ?? false,
    damage: opts.damage ?? null,
  };
}
