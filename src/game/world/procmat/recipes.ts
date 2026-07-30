/**
 * Material recipes — hybrid Poly Haven PBR (when loaded) + procedural bake fallback.
 * Quality-scaled bake + optional GPU detail/LoD shaders.
 */
import * as THREE from "three";
import { bakeProcMaps, cloneMaps, type ProcMaps, type SamplePoint } from "./bake";
import {
  cellular,
  clamp01,
  fbm2,
  fbm3,
  hash2,
  lerp,
  ridged,
  smoothstep,
  valueNoise,
  warpInto,
} from "./noise";
import { qualityManager } from "../quality";
import { attachGpuDetail, type SurfaceKind } from "../shaders/gpuDetail";
import { clonePbrPack, isPbrLibraryReady } from "../webgl2/textureLibrary";
import { getMaxAnisotropy } from "../webgl2/configure";

export type RecipeId = "asphalt" | "dirt" | "sand" | "metal" | "rust";

const BASE_SIZES: Record<RecipeId, number> = {
  asphalt: 192,
  dirt: 192,
  sand: 160,
  metal: 160,
  rust: 160,
};

const WARP: [number, number] = [0, 0];

function asphaltSample(u: number, v: number): SamplePoint {
  const x = u * 8;
  const y = v * 8;
  warpInto(x, y, 0.22, 1, WARP);
  const macro = fbm3(WARP[0] * 0.7, WARP[1] * 0.7, 2);
  const grit = fbm2(x * 4.5, y * 4.5, 5);
  const crackN = ridged(x * 1.8, y * 1.8, { octaves: 2, seed: 9 });
  const cracks = smoothstep(0.72, 0.92, crackN);
  const oil = smoothstep(0.78, 0.95, fbm2(x * 0.55 + 3, y * 0.55, 11));

  const height = clamp01(0.45 + macro * 0.25 + grit * 0.2 - cracks * 0.35 - oil * 0.12);
  let base = 0.14 + macro * 0.08 + grit * 0.05;
  base = lerp(base, base * 0.45, cracks);
  base = lerp(base, base * 0.35, oil * 0.8);

  return {
    height,
    r: clamp01(base * 0.95),
    g: clamp01(base * 0.92),
    b: clamp01(base * 0.88),
    roughness: clamp01(0.88 + grit * 0.1 - oil * 0.25 + cracks * 0.05),
    metalness: clamp01(oil * 0.08),
    ao: clamp01(1 - cracks * 0.35 - oil * 0.15),
  };
}

function dirtSample(u: number, v: number): SamplePoint {
  const x = u * 6;
  const y = v * 6;
  warpInto(x, y, 0.35, 20, WARP);
  const macro = fbm3(WARP[0] * 0.6, WARP[1] * 0.6, 21);
  const pebbles = cellular(x * 3.2, y * 3.2, 22);
  const fine = fbm2(x * 5, y * 5, 24);
  const height = clamp01(0.35 + macro * 0.35 + (1 - pebbles) * 0.2 + fine * 0.1);
  const warm = 0.42 + macro * 0.18;
  return {
    height,
    r: clamp01(warm * 1.15 + fine * 0.05),
    g: clamp01(warm * 0.88 + fine * 0.04),
    b: clamp01(warm * 0.55),
    roughness: clamp01(0.92 + fine * 0.06),
    metalness: 0,
    ao: clamp01(0.75 + macro * 0.2 + pebbles * 0.05),
  };
}

function sandSample(u: number, v: number): SamplePoint {
  const x = u * 5;
  const y = v * 5;
  const phase = valueNoise(x, y, 30);
  const bands = Math.sin((x + y * 0.35) * 2.2 + phase * 3) * 0.5 + 0.5;
  const macro = fbm2(x * 0.5, y * 0.5, 31);
  const grit = fbm2(x * 6, y * 6, 32);
  const height = clamp01(0.4 + bands * 0.25 + macro * 0.2 + grit * 0.1);
  const base = 0.38 + macro * 0.12 + bands * 0.1;
  return {
    height,
    r: clamp01(base * 1.15 + grit * 0.04),
    g: clamp01(base * 0.9 + grit * 0.03),
    b: clamp01(base * 0.55),
    roughness: 0.98,
    metalness: 0,
    ao: clamp01(0.85 + bands * 0.1),
  };
}

function metalSample(u: number, v: number): SamplePoint {
  const x = u * 7;
  const y = v * 7;
  const plate = fbm2(x * 0.4, y * 0.4, 40);
  const ridges = ridged(x * 1.2, y * 1.2, { octaves: 3, seed: 41 });
  const scratch = hash2(Math.floor(x * 40), Math.floor(y * 2.2), 42);
  const scratchMask = scratch > 0.93 ? 1 : 0;
  const micro = fbm2(x * 8, y * 8, 43);
  const height = clamp01(0.5 + plate * 0.15 + ridges * 0.25 - scratchMask * 0.2 + micro * 0.05);
  const base = 0.42 + plate * 0.2 + ridges * 0.1 + scratchMask * 0.15;
  return {
    height,
    r: clamp01(base),
    g: clamp01(base * 0.98),
    b: clamp01(base * 0.95),
    roughness: clamp01(0.28 + micro * 0.25 - scratchMask * 0.1 + plate * 0.15),
    metalness: clamp01(0.72 + ridges * 0.15),
    ao: clamp01(0.8 + plate * 0.15),
  };
}

function rustSample(u: number, v: number): SamplePoint {
  const x = u * 6;
  const y = v * 6;
  const cells = cellular(x * 2.2, y * 2.2, 50);
  const blobs = 1 - smoothstep(0.15, 0.55, cells);
  const macro = fbm2(x * 0.7, y * 0.7, 51);
  const pits = ridged(x * 2.5, y * 2.5, { octaves: 2, seed: 52 });
  const height = clamp01(0.4 + macro * 0.2 + blobs * 0.25 - pits * 0.15);
  return {
    height,
    r: clamp01(0.35 + blobs * 0.45 + macro * 0.1),
    g: clamp01(0.16 + blobs * 0.12 + macro * 0.05),
    b: clamp01(0.08 + blobs * 0.05),
    roughness: clamp01(0.75 + blobs * 0.2),
    metalness: clamp01(0.12 + (1 - blobs) * 0.25),
    ao: clamp01(0.7 + cells * 0.25),
  };
}

const SAMPLERS: Record<RecipeId, (u: number, v: number) => SamplePoint> = {
  asphalt: asphaltSample,
  dirt: dirtSample,
  sand: sandSample,
  metal: metalSample,
  rust: rustSample,
};

const NORMAL_STRENGTH: Record<RecipeId, number> = {
  asphalt: 2.4,
  dirt: 3.2,
  sand: 2.0,
  metal: 3.5,
  rust: 3.0,
};

/** Default PBR scalars when using photo maps */
const PBR_DEFAULTS: Record<
  RecipeId,
  { roughness: number; metalness: number; normalScale: number }
> = {
  asphalt: { roughness: 0.92, metalness: 0.02, normalScale: 0.55 },
  dirt: { roughness: 0.95, metalness: 0, normalScale: 0.7 },
  sand: { roughness: 0.98, metalness: 0, normalScale: 0.45 },
  metal: { roughness: 0.38, metalness: 0.82, normalScale: 0.6 },
  rust: { roughness: 0.88, metalness: 0.22, normalScale: 0.65 },
};

function bakeSizeFor(id: RecipeId): number {
  const q = qualityManager.get();
  const raw = BASE_SIZES[id] * q.bakeScale;
  return Math.max(64, Math.round(raw / 16) * 16);
}

export function getRecipeMaps(id: RecipeId): ProcMaps {
  const q = qualityManager.get();
  const size = bakeSizeFor(id);
  return bakeProcMaps(`recipe:${id}:${q.tier}:${size}`, size, SAMPLERS[id], {
    normalStrength: NORMAL_STRENGTH[id] * (q.tier === "low" ? 0.85 : 1),
  });
}

export function getRecipeBakeSpec(id: RecipeId) {
  return {
    size: bakeSizeFor(id),
    sample: SAMPLERS[id],
    normalStrength: NORMAL_STRENGTH[id],
  };
}

export type ProcMaterialOpts = {
  repeat?: [number, number];
  color?: string;
  normalScale?: number;
  roughnessMul?: number;
  metalnessMul?: number;
  transparent?: boolean;
  opacity?: number;
  ao?: boolean;
  gpuDetail?: boolean;
  detailScale?: number;
  /** Prefer photo PBR when library ready (default true) */
  preferPhoto?: boolean;
};

function applyAnisotropy(tex: THREE.Texture | null | undefined, a: number) {
  if (!tex) return;
  tex.anisotropy = a;
  tex.needsUpdate = true;
}

export function createProcMaterial(
  id: RecipeId,
  opts: ProcMaterialOpts = {},
): THREE.MeshStandardMaterial {
  const q = qualityManager.get();
  const [rx, ry] = opts.repeat ?? [1, 1];
  const nBase =
    opts.normalScale ??
    PBR_DEFAULTS[id].normalScale ??
    (id === "sand" ? 0.35 : id === "dirt" ? 0.55 : 0.4);

  const useNormal = q.tier !== "low" || id === "asphalt" || id === "metal";
  const useAo = opts.ao !== false && q.tier !== "low";
  const aniso = Math.min(getMaxAnisotropy(), q.anisotropy || 4);

  // Hybrid: Poly Haven photo maps when preloaded
  const pbr =
    opts.preferPhoto !== false && isPbrLibraryReady()
      ? clonePbrPack(id, rx, ry)
      : null;

  let mat: THREE.MeshStandardMaterial;

  if (pbr) {
    applyAnisotropy(pbr.map, aniso);
    applyAnisotropy(pbr.roughnessMap, aniso);
    applyAnisotropy(pbr.normalMap, aniso);
    applyAnisotropy(pbr.metalnessMap, aniso);
    applyAnisotropy(pbr.aoMap, aniso);

    const d = PBR_DEFAULTS[id];
    mat = new THREE.MeshStandardMaterial({
      map: pbr.map,
      roughnessMap: pbr.roughnessMap,
      normalMap: useNormal ? pbr.normalMap : null,
      metalnessMap: pbr.metalnessMap,
      aoMap: useAo ? pbr.aoMap : null,
      aoMapIntensity: 0.9,
      color: opts.color ?? "#ffffff",
      roughness: Math.min(1, d.roughness * (opts.roughnessMul ?? 1)),
      metalness: Math.min(1, d.metalness * (opts.metalnessMul ?? 1)),
      normalScale: new THREE.Vector2(nBase, nBase),
      transparent: opts.transparent ?? false,
      opacity: opts.opacity ?? 1,
      envMapIntensity: id === "metal" || id === "rust" ? 0.85 : 0.35,
    });
  } else {
    const maps = cloneMaps(getRecipeMaps(id), rx, ry);
    applyAnisotropy(maps.map, aniso);
    applyAnisotropy(maps.roughnessMap, aniso);
    applyAnisotropy(maps.normalMap, aniso);
    applyAnisotropy(maps.metalnessMap, aniso);
    applyAnisotropy(maps.aoMap, aniso);

    mat = new THREE.MeshStandardMaterial({
      map: maps.map,
      roughnessMap: maps.roughnessMap,
      normalMap: useNormal ? maps.normalMap : null,
      metalnessMap: maps.metalnessMap,
      aoMap: useAo ? maps.aoMap : null,
      aoMapIntensity: 0.85,
      color: opts.color ?? "#ffffff",
      roughness: Math.min(1, maps.avgRoughness * (opts.roughnessMul ?? 1)),
      metalness: Math.min(1, maps.avgMetalness * (opts.metalnessMul ?? 1)),
      normalScale: new THREE.Vector2(nBase, nBase),
      transparent: opts.transparent ?? false,
      opacity: opts.opacity ?? 1,
      envMapIntensity: id === "metal" || id === "rust" ? 0.7 : 0.25,
    });
  }

  if (opts.gpuDetail !== false) {
    attachGpuDetail(mat, {
      kind: id as SurfaceKind,
      detailScale:
        opts.detailScale ?? (id === "sand" ? 8 : id === "asphalt" ? 14 : 11),
      quality: q,
    });
  }

  return mat;
}

const utilCache = new Map<string, THREE.Texture>();

export function checkerMap(): THREE.Texture {
  const key = "util:checker";
  const hit = utilCache.get(key);
  if (hit) return hit;
  if (typeof document === "undefined") {
    const t = new THREE.DataTexture(new Uint8Array([20, 20, 20, 255]), 1, 1);
    t.needsUpdate = true;
    utilCache.set(key, t);
    return t;
  }
  const s = 64;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const ctx = c.getContext("2d")!;
  const cells = 8;
  const cell = s / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? "#0c0a09" : "#fafaf9";
      ctx.fillRect(x * cell, y * cell, cell + 1, cell + 1);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  utilCache.set(key, tex);
  return tex;
}

export function hazardMap(): THREE.Texture {
  const key = "util:hazard";
  const hit = utilCache.get(key);
  if (hit) return hit;
  if (typeof document === "undefined") {
    const t = new THREE.DataTexture(new Uint8Array([245, 158, 11, 255]), 1, 1);
    t.needsUpdate = true;
    utilCache.set(key, t);
    return t;
  }
  const s = 64;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#1c1917";
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = "#f59e0b";
  for (let i = -s; i < s * 2; i += 16) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 8, 0);
    ctx.lineTo(i + 8 + s, s);
    ctx.lineTo(i + s, s);
    ctx.closePath();
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  utilCache.set(key, tex);
  return tex;
}
