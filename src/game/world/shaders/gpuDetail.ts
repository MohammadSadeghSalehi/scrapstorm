/**
 * GPU detail + multi-band distance LoD on MeshStandardMaterial.
 *
 * Bands (world-space camera distance):
 *   3 near  < lodNear        full: fBm + ridged + normal pert + oil
 *   2 mid   lodNear..lodMid  albedo + roughness, reduced octaves
 *   1 far   lodMid..lodFar   1-oct valueNoise albedo only
 *   0 cull  >= lodFar        baked maps only (zero noise cost)
 *
 * Quality tier scales intensity + octave cap; bands come from quality.lod*.
 */
import * as THREE from "three";
import { GPU_NOISE_GLSL } from "./noise.glsl";
import type { QualitySettings } from "../quality";

export type SurfaceKind =
  | "asphalt"
  | "dirt"
  | "sand"
  | "metal"
  | "rust"
  | "generic";

export type GpuDetailLodBands = {
  /** Full detail ends (world units) */
  near: number;
  /** Mid detail ends */
  mid: number;
  /** Cheap detail ends — beyond = band 0 */
  far: number;
};

export type GpuDetailHandles = {
  material: THREE.MeshStandardMaterial;
  kind: SurfaceKind;
  /** Optional object-space center for CPU LOD bias (vehicles) */
  anchor: THREE.Vector3 | null;
  uniforms: {
    uCamPos: { value: THREE.Vector3 };
    uTime: { value: number };
    uGpuDetail: { value: number };
    uShaderOctaves: { value: number };
    uLodNear: { value: number };
    uLodMid: { value: number };
    uLodFar: { value: number };
    uDetailScale: { value: number };
    uSurfaceKind: { value: number };
    /** Extra scale on detail (0 = force off, e.g. distant AI) */
    uLodMul: { value: number };
  };
};

const KIND_ID: Record<SurfaceKind, number> = {
  asphalt: 0,
  dirt: 1,
  sand: 2,
  metal: 3,
  rust: 4,
  generic: 5,
};

const registry = new Set<GpuDetailHandles>();

export function getGpuDetailRegistry(): ReadonlySet<GpuDetailHandles> {
  return registry;
}

export function clearGpuDetailRegistry() {
  registry.clear();
}

/** Derive mid band from near/far if quality has no explicit mid. */
export function lodBandsFromQuality(q: QualitySettings): GpuDetailLodBands {
  const near = q.lodNear;
  const far = q.lodFar;
  const mid = q.lodMid ?? near + (far - near) * 0.45;
  return { near, mid, far };
}

export function attachGpuDetail(
  material: THREE.MeshStandardMaterial,
  opts: {
    kind?: SurfaceKind;
    detailScale?: number;
    quality?: QualitySettings;
    /** If set, CPU can fade uLodMul by distance to this point */
    anchor?: THREE.Vector3;
  } = {},
): GpuDetailHandles {
  const kind = opts.kind ?? "generic";
  const detailScale = opts.detailScale ?? 12;
  const q = opts.quality;
  const bands = q ? lodBandsFromQuality(q) : { near: 30, mid: 55, far: 100 };

  const uniforms = {
    uCamPos: { value: new THREE.Vector3() },
    uTime: { value: 0 },
    uGpuDetail: { value: q?.gpuDetail ?? 0.7 },
    uShaderOctaves: { value: q?.shaderOctaves ?? 2 },
    uLodNear: { value: bands.near },
    uLodMid: { value: bands.mid },
    uLodFar: { value: bands.far },
    uDetailScale: { value: detailScale },
    uSurfaceKind: { value: KIND_ID[kind] },
    uLodMul: { value: 1 },
  };

  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `
        #include <common>
        varying vec3 vGrokWorldPos;
        varying float vGrokCamDist;
        uniform vec3 uCamPos;
        `,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `
        #include <begin_vertex>
        vGrokWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vGrokCamDist = length(vGrokWorldPos - uCamPos);
        `,
      );

    // Shared LoD preamble used in each inject site
    const LOD_SETUP = /* glsl */ `
      float dist = vGrokCamDist;
      float band = grok_lodBand(dist, uLodNear, uLodMid, uLodFar);
      float fade = grok_lodFade(dist, uLodNear, uLodFar) * uGpuDetail * uLodMul;
    `;

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `
        #include <common>
        uniform vec3 uCamPos;
        uniform float uTime;
        uniform float uGpuDetail;
        uniform float uShaderOctaves;
        uniform float uLodNear;
        uniform float uLodMid;
        uniform float uLodFar;
        uniform float uDetailScale;
        uniform float uSurfaceKind;
        uniform float uLodMul;
        varying vec3 vGrokWorldPos;
        varying float vGrokCamDist;
        ${GPU_NOISE_GLSL}
        `,
      )
      .replace(
        "#include <map_fragment>",
        /* glsl */ `
        #include <map_fragment>
        {
          ${LOD_SETUP}
          // band 0: skip; band 1+: albedo micro
          if (band > 0.5 && fade > 0.01) {
            vec2 gp = vGrokWorldPos.xz * (uDetailScale * 0.035);
            float micro = 0.0;
            float n = 0.0;
            if (band > 2.5) {
              // band 3 — full fBm + ridged
              float oct = uShaderOctaves;
              n = grok_fbm(gp + uTime * 0.01, oct);
              float rdg = grok_ridged(gp * 1.7);
              if (uSurfaceKind < 0.5) {
                micro = (n - 0.5) * 0.14 + (rdg - 0.5) * 0.07;
              } else if (uSurfaceKind < 1.5) {
                micro = (n - 0.5) * 0.16;
                diffuseColor.rg *= 1.0 + 0.04 * fade * n;
              } else if (uSurfaceKind < 2.5) {
                micro = (n - 0.5) * 0.14 + sin(gp.x * 3.0 + n * 2.0) * 0.03;
              } else if (uSurfaceKind < 3.5) {
                micro = (n - 0.5) * 0.1 + rdg * 0.05;
              } else {
                micro = (n - 0.4) * 0.18;
                diffuseColor.r *= 1.0 + micro * fade * 0.5;
                diffuseColor.gb *= 1.0 - micro * fade * 0.15;
                micro = 0.0;
              }
            } else if (band > 1.5) {
              // band 2 — mid: 2-oct fBm
              float oct = min(uShaderOctaves, 2.0);
              n = grok_fbm(gp, oct);
              micro = (n - 0.5) * 0.1;
            } else {
              // band 1 — far: single valueNoise
              n = grok_valueNoise(gp * 1.2);
              micro = (n - 0.5) * 0.06;
            }
            // Crossfade at band edges via continuous fade
            diffuseColor.rgb *= 1.0 + micro * fade;
          }
        }
        `,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        /* glsl */ `
        #include <roughnessmap_fragment>
        {
          ${LOD_SETUP}
          // roughness only band 2+
          if (band > 1.5 && fade > 0.02) {
            vec2 gp = vGrokWorldPos.xz * (uDetailScale * 0.05);
            float n;
            if (band > 2.5) {
              n = grok_valueNoise(gp * 2.3);
              roughnessFactor = clamp(roughnessFactor + (n - 0.5) * 0.18 * fade, 0.04, 1.0);
              if (uSurfaceKind < 0.5) {
                float oil = smoothstep(0.72, 0.92, grok_fbm(gp * 0.4, min(uShaderOctaves, 2.0)));
                roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.65, oil * fade * 0.5);
              }
            } else {
              n = grok_valueNoise(gp * 1.6);
              roughnessFactor = clamp(roughnessFactor + (n - 0.5) * 0.1 * fade, 0.04, 1.0);
            }
          }
        }
        `,
      )
      .replace(
        "#include <normal_fragment_maps>",
        /* glsl */ `
        #include <normal_fragment_maps>
        {
          ${LOD_SETUP}
          // normal pert only band 3 (near), fades out toward lodMid
          if (band > 2.5 && fade > 0.05) {
            float nFade = grok_bandWeight(dist, uLodNear * 0.5, uLodNear * 1.15) * fade;
            if (nFade > 0.04) {
              vec2 gp = vGrokWorldPos.xz * (uDetailScale * 0.08);
              float e = 0.08;
              float hL = grok_valueNoise(gp + vec2(-e, 0.0));
              float hR = grok_valueNoise(gp + vec2( e, 0.0));
              float hD = grok_valueNoise(gp + vec2(0.0, -e));
              float hU = grok_valueNoise(gp + vec2(0.0,  e));
              vec3 nPert = normalize(vec3((hL - hR) * 1.8 * nFade, (hD - hU) * 1.8 * nFade, 1.0));
              normal = normalize(normal + nPert * 0.4 * nFade);
            }
          }
        }
        `,
      );
  };

  const prevKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () =>
    `${prevKey()}|gpuDetailLod3|${kind}|${detailScale}`;

  material.needsUpdate = true;

  const handle: GpuDetailHandles = {
    material,
    kind,
    anchor: opts.anchor ?? null,
    uniforms,
  };
  registry.add(handle);
  return handle;
}

export function applyQualityToGpuDetails(q: QualitySettings) {
  const bands = lodBandsFromQuality(q);
  for (const h of registry) {
    h.uniforms.uGpuDetail.value = q.gpuDetail;
    h.uniforms.uShaderOctaves.value = q.shaderOctaves;
    h.uniforms.uLodNear.value = bands.near;
    h.uniforms.uLodMid.value = bands.mid;
    h.uniforms.uLodFar.value = bands.far;
  }
}

/**
 * Per-frame: camera + time; optional CPU LoD mul for anchored materials
 * (e.g. vehicles — hard-off detail past lodFar to save fragment work).
 */
export function updateGpuDetailFrame(camPos: THREE.Vector3, time: number) {
  for (const h of registry) {
    h.uniforms.uCamPos.value.copy(camPos);
    h.uniforms.uTime.value = time;
    if (h.anchor) {
      const d = camPos.distanceTo(h.anchor);
      const far = h.uniforms.uLodFar.value;
      const mid = h.uniforms.uLodMid.value;
      // Soft CPU gate: 1 near mid, 0 past far
      const mul = 1 - THREE.MathUtils.smoothstep(mid, far, d);
      h.uniforms.uLodMul.value = mul;
    }
  }
}

/** Debug: sample which band a world distance falls into. */
export function lodBandAtDistance(
  dist: number,
  bands: GpuDetailLodBands,
): 0 | 1 | 2 | 3 {
  if (dist < bands.near) return 3;
  if (dist < bands.mid) return 2;
  if (dist < bands.far) return 1;
  return 0;
}
