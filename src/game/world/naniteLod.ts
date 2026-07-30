/**
 * Nanite-inspired geometry LoD for WebGL2 (NOT Unreal Nanite).
 *
 * True Nanite = virtualized cluster streaming, GPU-driven culling, continuous
 * LOD with meshlets. Browsers lack that pipeline in stock Three/WebGL2.
 *
 * What we ship instead (browser-portable “Nanite spirit”):
 *  1. Multi-band vehicle mesh LoD (hero / mid / far) by camera distance
 *  2. GPU material detail bands (already in gpuDetail.ts)
 *  3. CPU frustum + distance cull for scenery/edges (culling/*)
 *  4. Instance stream count rebuild for posts/beacons
 *
 * Recommendation: stay WebGL2 hybrid; full Nanite needs engine-level
 * meshlet tooling (or future WebGPU + custom cluster renderer).
 */

import { qualityManager } from "./quality";

export type MeshLodBand = 0 | 1 | 2;

export const NANITE_FINDINGS = {
  trueNanite: false,
  engine: "Unreal Engine 5 Nanite",
  browserPort: "not available as drop-in",
  substitutes: [
    "distance mesh LoD (this module)",
    "GPU shader detail LoD (gpuDetail)",
    "CPU sphere/AABB cull + instance rebuild",
    "adaptive quality tiers",
  ],
  whenToRevisit: "WebGPU mesh shaders + cluster culling mature in Three.js",
} as const;

/** Distance thresholds (meters) for vehicle mesh LoD. */
export function vehicleLodBands(): { near: number; mid: number } {
  const t = qualityManager.get().tier;
  if (t === "low") return { near: 18, mid: 42 };
  if (t === "high") return { near: 32, mid: 70 };
  return { near: 24, mid: 55 };
}

/**
 * Band 0 = hero detail (player always, close bots)
 * Band 1 = mid (secondary plates omitted)
 * Band 2 = far (silhouette only)
 */
export function meshLodForDistance(dist: number, forceHero = false): MeshLodBand {
  if (forceHero) return 0;
  const { near, mid } = vehicleLodBands();
  if (dist <= near) return 0;
  if (dist <= mid) return 1;
  return 2;
}

export function meshLodLabel(b: MeshLodBand): string {
  return b === 0 ? "hero" : b === 1 ? "mid" : "far";
}
