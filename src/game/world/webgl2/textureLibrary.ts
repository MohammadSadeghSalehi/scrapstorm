/**
 * PBR texture library — Poly Haven + ambientCG CC0 packs under /assets/textures.
 * Progressive load: critical road/sand first, rest after first paint.
 */
import * as THREE from "three";
import { applyTextureQuality, getMaxAnisotropy } from "./configure";
import { qualityManager } from "../quality";
import type { RecipeId } from "../procmat/recipes";

export type PbrPackId =
  | RecipeId
  | "rock"
  | "concrete"
  | "gravel"
  | "paint"
  | "carpaint"
  | "scrap_panel"
  | "carbon";

export type PbrPack = {
  id: PbrPackId;
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  metalnessMap: THREE.Texture | null;
  aoMap: THREE.Texture | null;
  source: string;
};

const PACK_PATHS: Record<
  PbrPackId,
  {
    base: string;
    hasMetal?: boolean;
    hasAo?: boolean;
    source: string;
  }
> = {
  asphalt: {
    base: "/assets/textures/asphalt",
    hasAo: true,
    source: "Poly Haven asphalt_02 (CC0)",
  },
  dirt: {
    base: "/assets/textures/dirt",
    hasAo: true,
    source: "Poly Haven dirt_floor (CC0)",
  },
  sand: {
    base: "/assets/textures/sand",
    source: "Poly Haven sand_01 (CC0)",
  },
  metal: {
    base: "/assets/textures/metal",
    hasMetal: true,
    source: "Poly Haven metal_plate (CC0)",
  },
  rust: {
    base: "/assets/textures/rust",
    source: "Poly Haven rusty_metal (CC0)",
  },
  rock: {
    base: "/assets/textures/rock",
    hasAo: true,
    source: "ambientCG Rock020 (CC0)",
  },
  concrete: {
    base: "/assets/textures/concrete",
    hasAo: true,
    source: "Poly Haven concrete_floor_painted (CC0)",
  },
  gravel: {
    base: "/assets/textures/gravel",
    hasAo: true,
    source: "Poly Haven gravelly_sand (CC0)",
  },
  paint: {
    base: "/assets/textures/paint",
    hasMetal: true,
    source: "Poly Haven corrugated_iron (CC0)",
  },
  carpaint: {
    base: "/assets/textures/carpaint",
    hasAo: true,
    source: "Poly Haven blue_metal_plate (CC0) — painted vehicle panels",
  },
  scrap_panel: {
    base: "/assets/textures/scrap_panel",
    hasAo: true,
    source: "Poly Haven container_side (CC0) — battered scrap hull",
  },
  carbon: {
    base: "/assets/textures/carbon",
    hasMetal: true,
    source: "ambientCG Metal032 (CC0) — dark metallic trim",
  },
};

/** Load these first so road/terrain paint immediately */
const CRITICAL: PbrPackId[] = ["asphalt", "sand", "dirt", "metal"];
const DEFERRED: PbrPackId[] = (
  Object.keys(PACK_PATHS) as PbrPackId[]
).filter((id) => !CRITICAL.includes(id));

const cache = new Map<PbrPackId, PbrPack>();
let loadPromise: Promise<void> | null = null;
let loaded = false;
let criticalReady = false;

function loadOne(
  loader: THREE.TextureLoader,
  url: string,
  colorMap: boolean,
): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (tex) => {
        applyTextureQuality(tex, qualityManager.get(), { colorMap });
        resolve(tex);
      },
      undefined,
      (err) => reject(err),
    );
  });
}

async function loadPack(
  loader: THREE.TextureLoader,
  id: PbrPackId,
): Promise<void> {
  if (cache.has(id)) return;
  const spec = PACK_PATHS[id];
  try {
    const map = await loadOne(loader, `${spec.base}/diff.jpg`, true);
    const normalMap = await loadOne(loader, `${spec.base}/nor.jpg`, false);
    const roughnessMap = await loadOne(
      loader,
      `${spec.base}/rough.jpg`,
      false,
    );
    let metalnessMap: THREE.Texture | null = null;
    let aoMap: THREE.Texture | null = null;
    if (spec.hasMetal) {
      try {
        metalnessMap = await loadOne(loader, `${spec.base}/metal.jpg`, false);
      } catch {
        metalnessMap = null;
      }
    }
    if (spec.hasAo) {
      try {
        aoMap = await loadOne(loader, `${spec.base}/ao.jpg`, false);
      } catch {
        aoMap = null;
      }
    }
    const q = qualityManager.get();
    map.anisotropy = Math.min(getMaxAnisotropy(), q.anisotropy || 4);
    cache.set(id, {
      id,
      map,
      normalMap,
      roughnessMap,
      metalnessMap,
      aoMap,
      source: spec.source,
    });
  } catch (e) {
    console.warn(`[pbr] failed to load ${id}`, e);
  }
}

/** Preload PBR packs. Critical first (road ready ASAP), rest deferred. */
export function preloadPbrLibrary(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    if (typeof window === "undefined") return;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");

    await Promise.all(CRITICAL.map((id) => loadPack(loader, id)));
    criticalReady = true;

    // Yield to main thread so first frame paints before rest of library
    await new Promise((r) => setTimeout(r, 80));
    await Promise.all(DEFERRED.map((id) => loadPack(loader, id)));
    loaded = true;
  })();

  return loadPromise;
}

export function isPbrLibraryReady(): boolean {
  return criticalReady || loaded;
}

export function getPbrPack(id: PbrPackId): PbrPack | null {
  return cache.get(id) ?? null;
}

export function listLoadedPacks(): PbrPackId[] {
  return Array.from(cache.keys());
}

/** Clone maps with independent repeat/offset for a mesh. */
export function clonePbrPack(
  id: PbrPackId,
  repeatU = 1,
  repeatV = 1,
): PbrPack | null {
  const src = cache.get(id);
  if (!src) return null;
  const map = src.map.clone();
  const normalMap = src.normalMap.clone();
  const roughnessMap = src.roughnessMap.clone();
  const metalnessMap = src.metalnessMap?.clone() ?? null;
  const aoMap = src.aoMap?.clone() ?? null;
  for (const t of [map, normalMap, roughnessMap, metalnessMap, aoMap]) {
    if (!t) continue;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeatU, repeatV);
    t.needsUpdate = true;
  }
  return {
    id,
    map,
    normalMap,
    roughnessMap,
    metalnessMap,
    aoMap,
    source: src.source,
  };
}
