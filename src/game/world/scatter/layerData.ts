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
  }

  return {
    geometry: opts.geometry,
    material: opts.material,
    matrices,
    colors,
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
