/**
 * WebGPU investigation helpers for Scrapstorm shaders.
 *
 * Three r185 ships:
 *   - three/webgpu  → WebGPURenderer, MeshStandardNodeMaterial, …
 *   - three/tsl     → node graph (mx_* noise, hash, uniforms, positionWorld)
 *
 * Current path (live): WebGL2 + MeshStandardMaterial.onBeforeCompile (gpuDetail.ts).
 * WebGPU path (ready to trial): TSL MeshStandardNodeMaterial (tslSurface.ts).
 *
 * Why not switched yet:
 *   1. Headless Chromium in this sandbox has no navigator.gpu.
 *   2. R3F Canvas needs async gl factory for WebGPURenderer.
 *   3. onBeforeCompile materials are not portable to WebGPU — must rebuild as nodes.
 *   4. Deploy target browsers: WebGPU ~Chrome/Edge solid, Safari/Firefox catching up;
 *      WebGL2 remains the reliable baseline for racing-game reach.
 *
 * When to adopt:
 *   - Need compute-driven bake (height→normal on GPU) or many dynamic materials
 *   - Mobile GPU fill bound on fragment noise and WGSL wins over GLSL inject
 *   - Willing to dual-maintain WebGL fallback or accept WebGPU-only
 */

export type WebGpuCapability = {
  apiPresent: boolean;
  adapterOk: boolean;
  deviceOk: boolean;
  status: "unsupported" | "adapter-missing" | "device-failed" | "ready" | "unknown";
  adapterFeatures: string[];
  recommendation: "stay-webgl" | "trial-webgpu" | "adopt-webgpu";
  notes: string[];
};

type GpuAdapterLike = {
  features: Iterable<string>;
  requestDevice: () => Promise<{ destroy: () => void }>;
};

type GpuLike = {
  requestAdapter: (opts?: {
    powerPreference?: string;
  }) => Promise<GpuAdapterLike | null>;
};

export function detectWebGpuSync(): Pick<
  WebGpuCapability,
  "apiPresent" | "status" | "recommendation" | "notes"
> {
  const notes: string[] = [];
  if (typeof navigator === "undefined") {
    return {
      apiPresent: false,
      status: "unknown",
      recommendation: "stay-webgl",
      notes: ["SSR / non-browser — WebGPU N/A"],
    };
  }
  const apiPresent =
    "gpu" in navigator &&
    !!(navigator as Navigator & { gpu?: unknown }).gpu;
  if (!apiPresent) {
    notes.push("navigator.gpu missing — use WebGL2 + onBeforeCompile path");
    notes.push(
      "Three WebGPURenderer can forceWebGL backend for TSL trial without real WebGPU",
    );
    return {
      apiPresent: false,
      status: "unsupported",
      recommendation: "stay-webgl",
      notes,
    };
  }
  notes.push("navigator.gpu present — async adapter probe recommended");
  return {
    apiPresent: true,
    status: "unknown",
    recommendation: "trial-webgpu",
    notes,
  };
}

/** Full async probe (browser only). Safe to call once at boot. */
export async function probeWebGpu(): Promise<WebGpuCapability> {
  const base = detectWebGpuSync();
  if (!base.apiPresent) {
    return {
      ...base,
      adapterOk: false,
      deviceOk: false,
      adapterFeatures: [],
    };
  }

  const notes = [...base.notes];
  try {
    const gpu = (navigator as Navigator & { gpu: GpuLike }).gpu;
    const adapter = await gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) {
      notes.push("requestAdapter returned null");
      return {
        apiPresent: true,
        adapterOk: false,
        deviceOk: false,
        status: "adapter-missing",
        adapterFeatures: [],
        recommendation: "stay-webgl",
        notes,
      };
    }
    const features = [...adapter.features];
    const device = await adapter.requestDevice();
    device.destroy();
    notes.push("adapter + device OK — WebGPURenderer viable");
    notes.push(
      "Migrate surface detail via MeshStandardNodeMaterial + TSL (see tslSurface.ts)",
    );
    return {
      apiPresent: true,
      adapterOk: true,
      deviceOk: true,
      status: "ready",
      adapterFeatures: features,
      recommendation: "trial-webgpu",
      notes,
    };
  } catch (e) {
    notes.push(`device probe failed: ${String(e)}`);
    return {
      apiPresent: true,
      adapterOk: false,
      deviceOk: false,
      status: "device-failed",
      adapterFeatures: [],
      recommendation: "stay-webgl",
      notes,
    };
  }
}

export const WEBGPU_SHADER_FINDINGS = {
  current: {
    api: "WebGL2",
    material: "MeshStandardMaterial + onBeforeCompile",
    noise: "inline GLSL hash/valueNoise/fBm (noise.glsl.ts)",
    lod: "distance smoothstep in fragment, uShaderOctaves adaptive",
    pros: [
      "Works everywhere R3F works today",
      "Keeps stock PBR lighting/shadows/tone mapping",
      "Hot-path already shipping in TrackMesh / vehicles",
    ],
    cons: [
      "String-inject GLSL is brittle across Three upgrades",
      "No compute path for GPU bake of height/normal maps",
      "Harder to share noise with a future compute bake",
    ],
  },
  webgpuTsl: {
    api: "WebGPU (WebGPURenderer) or WebGL backend via forceWebGL",
    material: "MeshStandardNodeMaterial",
    noise: "TSL mx_noise_float / mx_fractal_noise_float / hash",
    lod: "distance(positionWorld, cameraPosition) nodes + uniforms",
    pros: [
      "Typed node graph — no onBeforeCompile string surgery",
      "Same graph can target WebGPU WGSL or WebGL GLSL",
      "Native path to compute shaders for bake (height→normal, fBm grids)",
      "Better long-term fit for adaptive quality (swap node branches)",
    ],
    cons: [
      "R3F needs custom async gl: () => WebGPURenderer",
      "All onBeforeCompile materials must be rewritten as nodes",
      "WebGPU still missing on some browsers; need fallback policy",
      "This sandbox headless Chromium has no navigator.gpu",
    ],
  },
  decision: {
    now: "stay-webgl — keep gpuDetail.ts as production path",
    next: "optional TSL dual path behind quality flag once WebGPU probe is ready",
    later: "GPU compute bake of recipe maps if re-bake cost matters at 512²+",
  },
} as const;
