/**
 * TSL surface detail — multi-band LoD mirror of gpuDetail.ts (WebGPU-ready sketch).
 * Not the live track path; live path is onBeforeCompile WebGL2.
 */
import { MeshStandardNodeMaterial } from "three/webgpu";
import {
  Fn,
  float,
  vec3,
  positionWorld,
  cameraPosition,
  time,
  uniform,
  distance,
  smoothstep,
  mx_noise_float,
  mx_fractal_noise_float,
} from "three/tsl";
import type { QualitySettings } from "../quality";
import { lodBandsFromQuality, type SurfaceKind } from "./gpuDetail";

const KIND_ID: Record<SurfaceKind, number> = {
  asphalt: 0,
  dirt: 1,
  sand: 2,
  metal: 3,
  rust: 4,
  generic: 5,
};

export type TslSurfaceHandles = {
  material: MeshStandardNodeMaterial;
  uniforms: {
    uGpuDetail: { value: number };
    uShaderOctaves: { value: number };
    uLodNear: { value: number };
    uLodMid: { value: number };
    uLodFar: { value: number };
    uDetailScale: { value: number };
    uSurfaceKind: { value: number };
  };
};

export function createTslDetailMaterial(
  opts: {
    kind?: SurfaceKind;
    detailScale?: number;
    quality?: QualitySettings;
    color?: string;
    roughness?: number;
    metalness?: number;
  } = {},
): TslSurfaceHandles {
  const kind = opts.kind ?? "generic";
  const q = opts.quality;
  const bands = q
    ? lodBandsFromQuality(q)
    : { near: 30, mid: 55, far: 100 };

  const uGpuDetail = uniform(q?.gpuDetail ?? 0.7);
  const uShaderOctaves = uniform(q?.shaderOctaves ?? 2);
  const uLodNear = uniform(bands.near);
  const uLodMid = uniform(bands.mid);
  const uLodFar = uniform(bands.far);
  const uDetailScale = uniform(opts.detailScale ?? 12);
  const uSurfaceKind = uniform(KIND_ID[kind]);

  const material = new MeshStandardNodeMaterial();
  material.color.set(opts.color ?? "#ffffff");
  material.roughness = opts.roughness ?? 0.85;
  material.metalness = opts.metalness ?? 0.05;

  // band 3: full, band 2: mid fade, band 1: cheap, band 0: off
  // Continuous fade * stepwise octave reduction approximates GLSL bands
  material.colorNode = Fn(() => {
    const base = vec3(material.color.r, material.color.g, material.color.b);
    const dist = distance(positionWorld, cameraPosition);
    const fade = float(1)
      .sub(smoothstep(uLodNear, uLodFar, dist))
      .mul(uGpuDetail);
    const gp = positionWorld.xz.mul(uDetailScale.mul(0.035));
    // Near: full octaves; mid: min(2); far still samples once but fade→0 past lodFar
    const nearW = float(1).sub(smoothstep(uLodNear.mul(0.5), uLodNear, dist));
    const midW = float(1).sub(smoothstep(uLodNear, uLodMid, dist));
    const oct = uShaderOctaves.mul(nearW.add(midW.mul(0.5)).clamp(0.35, 1));
    const n = mx_fractal_noise_float(gp.add(time.mul(0.01)), oct);
    const rdg = mx_noise_float(gp.mul(1.7));
    const micro = n.sub(0.5).mul(0.14).add(rdg.sub(0.5).mul(0.05));
    return base.mul(float(1).add(micro.mul(fade)));
  })();

  material.roughnessNode = Fn(() => {
    const dist = distance(positionWorld, cameraPosition);
    // Roughness only when closer than mid band
    const fade = float(1)
      .sub(smoothstep(uLodNear, uLodMid, dist))
      .mul(uGpuDetail);
    const gp = positionWorld.xz.mul(uDetailScale.mul(0.05));
    const n = mx_noise_float(gp.mul(2.3));
    const r = float(material.roughness).add(n.sub(0.5).mul(0.18).mul(fade));
    return r.clamp(0.04, 1.0);
  })();

  return {
    material,
    uniforms: {
      uGpuDetail,
      uShaderOctaves,
      uLodNear,
      uLodMid,
      uLodFar,
      uDetailScale,
      uSurfaceKind,
    },
  };
}

export function applyQualityToTslSurface(
  h: TslSurfaceHandles,
  q: QualitySettings,
) {
  const bands = lodBandsFromQuality(q);
  h.uniforms.uGpuDetail.value = q.gpuDetail;
  h.uniforms.uShaderOctaves.value = q.shaderOctaves;
  h.uniforms.uLodNear.value = bands.near;
  h.uniforms.uLodMid.value = bands.mid;
  h.uniforms.uLodFar.value = bands.far;
}
