/**
 * PBR texture library — Poly Haven + ambientCG CC0 packs under /assets/textures.
 * Progressive load: critical road/sand first, rest after first paint.
 *
 * Every map is preferred as .ktx2 and falls back to the original .jpg. The two
 * are not equivalent in cost: a JPEG is small on the wire but decodes to RGBA8,
 * so a 1024x1024 map occupies ~5.3MB of VRAM with its mip chain regardless of
 * how well it compressed. KTX2 stays block-compressed on the GPU, so the same
 * map costs ~0.7MB (ETC1S) or ~1.4MB (UASTC).
 *
 * Run `node scripts/compress-textures.mjs` to produce the .ktx2 files.
 */
import * as THREE from "three";
import type { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { applyTextureQuality, getMaxAnisotropy } from "./configure";
import { getKtx2Loader } from "../gltfLoaders";
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

/**
 * Names of the maps that exist as .ktx2, as "<dir>/<map>" (e.g. "asphalt/diff").
 *
 * Written by scripts/compress-textures.mjs. Consulting a manifest rather than
 * just requesting the .ktx2 and catching the 404 is what keeps the fallback
 * free: without it, an un-encoded checkout would eat one failed request per map
 * — around fifty — before a single texture appeared. A missing manifest costs
 * exactly one 404 and puts the whole library on the JPEG path.
 */
const MANIFEST_URL = "/assets/textures/ktx2-manifest.json";
let manifestPromise: Promise<ReadonlySet<string>> | null = null;

function loadKtx2Manifest(): Promise<ReadonlySet<string>> {
  if (manifestPromise) return manifestPromise;
  manifestPromise = (async () => {
    const files = new Set<string>();
    try {
      const res = await fetch(MANIFEST_URL);
      if (res.ok) {
        const json: unknown = await res.json();
        const list = (json as { files?: unknown })?.files;
        if (Array.isArray(list)) {
          for (const f of list) if (typeof f === "string") files.add(f);
        }
      }
    } catch {
      // Offline, no manifest, or malformed — treated the same as "not encoded".
    }
    return files;
  })();
  return manifestPromise;
}

/**
 * Shared post-load setup for both paths.
 *
 * applyTextureQuality is the single place colour space is decided, and it runs
 * identically for KTX2 and JPEG: `colorMap` maps to SRGBColorSpace, everything
 * else to NoColorSpace. That assignment is what makes three select the sRGB or
 * the linear GL internal format when the texture is uploaded, so a normal,
 * roughness, metalness or AO map tagged sRGB by mistake would be silently
 * gamma-decoded — hence deriving the flag from the call site rather than from
 * the file. It also overrides the colour space KTX2Loader infers from the
 * container, so the two paths cannot drift apart.
 */
function finishTexture(tex: THREE.Texture, colorMap: boolean): THREE.Texture {
  applyTextureQuality(tex, qualityManager.get(), { colorMap });

  if ((tex as THREE.CompressedTexture).isCompressedTexture) {
    // applyTextureQuality asks for runtime mipmap generation, which is right
    // for a decoded JPEG but invalid on a block-compressed texture — WebGL
    // rejects glGenerateMipmap for compressed formats and three calls it
    // unconditionally whenever generateMipmaps is set. The chain is already
    // baked into the .ktx2 by the encode script, so use that instead.
    const levels = (tex as THREE.CompressedTexture).mipmaps?.length ?? 0;
    tex.generateMipmaps = false;
    tex.minFilter =
      levels > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  }
  return tex;
}

/**
 * Load one map, preferring KTX2. Falls back to the JPEG whenever the encoder
 * has not been run, the renderer has not been probed for compressed-format
 * support, or the transcode fails outright.
 */
async function loadOne(
  loader: THREE.TextureLoader,
  base: string,
  map: string,
  colorMap: boolean,
  ktx2: KTX2Loader | null,
  manifest: ReadonlySet<string>,
): Promise<THREE.Texture> {
  const dir = base.slice(base.lastIndexOf("/") + 1);
  if (ktx2 && manifest.has(`${dir}/${map}`)) {
    try {
      return finishTexture(await ktx2.loadAsync(`${base}/${map}.ktx2`), colorMap);
    } catch (e) {
      console.warn(`[pbr] ktx2 failed for ${dir}/${map}, using jpg`, e);
    }
  }
  return finishTexture(await loader.loadAsync(`${base}/${map}.jpg`), colorMap);
}

async function loadPack(
  loader: THREE.TextureLoader,
  id: PbrPackId,
  ktx2: KTX2Loader | null,
  manifest: ReadonlySet<string>,
): Promise<void> {
  if (cache.has(id)) return;
  const spec = PACK_PATHS[id];
  try {
    // The maps of a pack are independent — chaining them made each pack cost
    // 3-5 serial round-trips, so the critical set alone was ~4 requests deep
    // before the road could paint. Optional maps resolve to null on miss.
    const [map, normalMap, roughnessMap, metalnessMap, aoMap] =
      await Promise.all([
        loadOne(loader, spec.base, "diff", true, ktx2, manifest),
        loadOne(loader, spec.base, "nor", false, ktx2, manifest),
        loadOne(loader, spec.base, "rough", false, ktx2, manifest),
        spec.hasMetal
          ? loadOne(loader, spec.base, "metal", false, ktx2, manifest).catch(
              () => null,
            )
          : Promise.resolve(null),
        spec.hasAo
          ? loadOne(loader, spec.base, "ao", false, ktx2, manifest).catch(
              () => null,
            )
          : Promise.resolve(null),
      ]);
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

    // getKtx2Loader only returns an instance once initGltfDecoders has probed
    // the renderer for supported compressed formats. That happens in the Canvas
    // onCreated, which is a layout effect on an ancestor of everything that
    // calls preloadPbrLibrary from a passive effect — React flushes the whole
    // layout phase before any passive effect, so the probe has always run by
    // now. Still treated as optional: a null loader just means JPEG.
    const ktx2 = getKtx2Loader();
    const manifest = await loadKtx2Manifest();

    await Promise.all(CRITICAL.map((id) => loadPack(loader, id, ktx2, manifest)));
    criticalReady = true;

    // Yield to main thread so first frame paints before rest of library
    await new Promise((r) => setTimeout(r, 80));

    // Two packs at a time, yielding between them. JPEG decode and the GPU
    // upload/mipmap pass both land on the main thread, so firing all nine
    // deferred packs at once produced a burst of long frames right after the
    // lights go green — the "sudden drops at first". Trickling them keeps each
    // frame's decode budget small at the cost of a slightly later finish.
    // KTX2 shrinks but does not remove this: the Basis transcode runs on a
    // worker and the mip chain is prebuilt, yet the upload is still main-thread.
    const queue = [...DEFERRED];
    const worker = async () => {
      for (;;) {
        const id = queue.shift();
        if (!id) return;
        await loadPack(loader, id, ktx2, manifest);
        await new Promise((r) => setTimeout(r, 60));
      }
    };
    await Promise.all([worker(), worker()]);
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
