/**
 * Multi-map baker: one coherent sample function → albedo / roughness / normal / metalness.
 * Optimized: integer packing, inv-sqrt normals, no Math.round, tight loops.
 */
import * as THREE from "three";

export type SamplePoint = {
  height: number;
  r: number;
  g: number;
  b: number;
  roughness: number;
  metalness: number;
  ao?: number;
};

export type ProcMaps = {
  map: THREE.Texture;
  roughnessMap: THREE.Texture;
  normalMap: THREE.Texture;
  metalnessMap: THREE.Texture;
  aoMap: THREE.Texture;
  avgRoughness: number;
  avgMetalness: number;
};

const textureCache = new Map<string, ProcMaps>();

function solidTex(r: number, g: number, b: number, space: THREE.ColorSpace): THREE.DataTexture {
  const data = new Uint8Array([r, g, b, 255]);
  const tex = new THREE.DataTexture(data, 1, 1);
  tex.colorSpace = space;
  tex.needsUpdate = true;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function makeDataTexture(
  data: Uint8Array,
  size: number,
  colorSpace: THREE.ColorSpace,
): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size);
  tex.colorSpace = colorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function toByte(v: number): number {
  const x = (v * 255 + 0.5) | 0;
  return x < 0 ? 0 : x > 255 ? 255 : x;
}

/**
 * Pure CPU bake timing: one sample pass + normal pass (no GPU textures).
 * Used by tests / profiling — does not touch the texture cache.
 */
export function measureSampleBakeMs(
  size: number,
  sample: (u: number, v: number) => SamplePoint,
  opts?: { normalStrength?: number },
): number {
  const n = size * size;
  const height = new Float32Array(n);
  const inv = 1 / size;
  const t0 = performance.now();
  let sum = 0;
  for (let y = 0; y < size; y++) {
    const v = y * inv;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const s = sample(x * inv, v);
      height[row + x] = s.height;
      sum += s.r + s.roughness;
    }
  }
  const strength = opts?.normalStrength ?? 2.8;
  const last = size - 1;
  for (let y = 0; y < size; y++) {
    const yD = y === 0 ? last : y - 1;
    const yU = y === last ? 0 : y + 1;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const xL = x === 0 ? last : x - 1;
      const xR = x === last ? 0 : x + 1;
      const nx = (height[row + xL] - height[row + xR]) * strength;
      const ny = (height[yD * size + x] - height[yU * size + x]) * strength;
      sum += nx + ny;
    }
  }
  void sum;
  return performance.now() - t0;
}

export function bakeProcMaps(
  key: string,
  size: number,
  sample: (u: number, v: number) => SamplePoint,
  opts?: { normalStrength?: number },
): ProcMaps {
  const hit = textureCache.get(key);
  if (hit) return hit;

  if (typeof document === "undefined") {
    const fb: ProcMaps = {
      map: solidTex(80, 80, 80, THREE.SRGBColorSpace),
      roughnessMap: solidTex(220, 220, 220, THREE.NoColorSpace),
      normalMap: solidTex(128, 128, 255, THREE.NoColorSpace),
      metalnessMap: solidTex(0, 0, 0, THREE.NoColorSpace),
      aoMap: solidTex(255, 255, 255, THREE.NoColorSpace),
      avgRoughness: 0.9,
      avgMetalness: 0,
    };
    textureCache.set(key, fb);
    return fb;
  }

  const n = size * size;
  const height = new Float32Array(n);
  const albedo = new Uint8Array(n * 4);
  const rough = new Uint8Array(n * 4);
  const metal = new Uint8Array(n * 4);
  const ao = new Uint8Array(n * 4);

  let sumR = 0;
  let sumM = 0;
  const inv = 1 / size;

  for (let y = 0; y < size; y++) {
    const v = y * inv;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const s = sample(x * inv, v);
      const i = row + x;
      height[i] = s.height;
      const o = i << 2;
      albedo[o] = toByte(s.r);
      albedo[o + 1] = toByte(s.g);
      albedo[o + 2] = toByte(s.b);
      albedo[o + 3] = 255;
      const rv = toByte(s.roughness);
      rough[o] = rv;
      rough[o + 1] = rv;
      rough[o + 2] = rv;
      rough[o + 3] = 255;
      const mv = toByte(s.metalness);
      metal[o] = mv;
      metal[o + 1] = mv;
      metal[o + 2] = mv;
      metal[o + 3] = 255;
      const av = toByte(s.ao ?? 1);
      ao[o] = av;
      ao[o + 1] = av;
      ao[o + 2] = av;
      ao[o + 3] = 255;
      sumR += s.roughness;
      sumM += s.metalness;
    }
  }

  const strength = opts?.normalStrength ?? 2.8;
  const normal = new Uint8Array(n * 4);
  const last = size - 1;
  for (let y = 0; y < size; y++) {
    const yD = y === 0 ? last : y - 1;
    const yU = y === last ? 0 : y + 1;
    const row = y * size;
    const rowD = yD * size;
    const rowU = yU * size;
    for (let x = 0; x < size; x++) {
      const xL = x === 0 ? last : x - 1;
      const xR = x === last ? 0 : x + 1;
      let nx = (height[row + xL] - height[row + xR]) * strength;
      let ny = (height[rowD + x] - height[rowU + x]) * strength;
      const invLen = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= invLen;
      ny *= invLen;
      const nz = invLen;
      const o = (row + x) << 2;
      normal[o] = ((nx * 0.5 + 0.5) * 255 + 0.5) | 0;
      normal[o + 1] = ((ny * 0.5 + 0.5) * 255 + 0.5) | 0;
      normal[o + 2] = ((nz * 0.5 + 0.5) * 255 + 0.5) | 0;
      normal[o + 3] = 255;
    }
  }

  const maps: ProcMaps = {
    map: makeDataTexture(albedo, size, THREE.SRGBColorSpace),
    roughnessMap: makeDataTexture(rough, size, THREE.NoColorSpace),
    normalMap: makeDataTexture(normal, size, THREE.NoColorSpace),
    metalnessMap: makeDataTexture(metal, size, THREE.NoColorSpace),
    aoMap: makeDataTexture(ao, size, THREE.NoColorSpace),
    avgRoughness: sumR / n,
    avgMetalness: sumM / n,
  };
  textureCache.set(key, maps);
  return maps;
}

export function cloneMaps(
  src: ProcMaps,
  repeatX: number,
  repeatY: number,
): ProcMaps {
  const wrap = (t: THREE.Texture) => {
    const c = t.clone();
    c.wrapS = c.wrapT = THREE.RepeatWrapping;
    c.repeat.set(repeatX, repeatY);
    c.needsUpdate = true;
    return c;
  };
  return {
    map: wrap(src.map),
    roughnessMap: wrap(src.roughnessMap),
    normalMap: wrap(src.normalMap),
    metalnessMap: wrap(src.metalnessMap),
    aoMap: wrap(src.aoMap),
    avgRoughness: src.avgRoughness,
    avgMetalness: src.avgMetalness,
  };
}

export function clearProcCache() {
  textureCache.clear();
}
