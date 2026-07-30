/**
 * Best-practice WebGL2 renderer setup for Three r185.
 * Single entry used by GameCanvas + quality tier changes.
 */
import * as THREE from "three";
import type { QualitySettings } from "../quality";

export type WebGL2Caps = {
  isWebGL2: boolean;
  maxAnisotropy: number;
  maxTextureSize: number;
  maxSamples: number;
  floatTextures: boolean;
  renderer: string;
  vendor: string;
};

let cachedCaps: WebGL2Caps | null = null;
let maxAniso = 4;

export function getMaxAnisotropy(): number {
  return maxAniso;
}

export function getWebGL2Caps(): WebGL2Caps | null {
  return cachedCaps;
}

/**
 * Configure a live WebGLRenderer for modern color-managed PBR.
 * Safe to call on every quality change.
 */
export function configureWebGL2Renderer(
  gl: THREE.WebGLRenderer,
  q: QualitySettings,
): WebGL2Caps {
  THREE.ColorManagement.enabled = true;

  // Three dropped WebGL1 in r163 and removed `capabilities.isWebGL2` with it —
  // @types/three still declares it, so `caps.isWebGL2` silently reads
  // `undefined` and every consumer sees WebGL2 as unavailable. Ask the context.
  const caps = gl.capabilities;
  const isWebGL2 =
    typeof WebGL2RenderingContext !== "undefined" &&
    gl.getContext() instanceof WebGL2RenderingContext;
  const maxAnisotropy = Math.max(1, caps.getMaxAnisotropy?.() ?? 4);
  maxAniso = Math.min(maxAnisotropy, q.anisotropy > 0 ? Math.max(q.anisotropy, 1) : maxAnisotropy);

  // On high tier use full GPU anisotropy; low/med clamp via quality
  maxAniso = Math.min(maxAnisotropy, q.tier === "high" ? maxAnisotropy : q.anisotropy || 2);

  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.toneMapping = THREE.ACESFilmicToneMapping;
  gl.toneMappingExposure = q.tier === "low" ? 1.25 : 1.35;

  gl.setClearColor(0x3a5880, 1);
  gl.setPixelRatio(
    Math.min(
      typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
      q.dprMax,
    ),
  );

  // Shadows — modern PCF / soft
  gl.shadowMap.enabled = q.shadowEnabled;
  gl.shadowMap.type = q.softShadows
    ? THREE.PCFSoftShadowMap
    : THREE.PCFShadowMap;
  gl.shadowMap.autoUpdate = true;
  gl.shadowMap.needsUpdate = true;

  // Avoid auto-clear fights with multi-pass FX
  gl.autoClear = true;

  // Reset once per frame from the sim loop instead of after every render.
  // With autoReset on, each EffectComposer pass clears the counters, so the
  // HUD only ever saw the final fullscreen quad (1 call / 1 triangle) rather
  // than the frame's real draw count.
  gl.info.autoReset = false;

  let renderer = "unknown";
  let vendor = "unknown";
  let floatTextures = false;
  let maxSamples = 0;
  try {
    const dbg = gl.getContext().getExtension("WEBGL_debug_renderer_info");
    if (dbg) {
      vendor = String(gl.getContext().getParameter(dbg.UNMASKED_VENDOR_WEBGL) ?? "");
      renderer = String(gl.getContext().getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? "");
    }
    floatTextures = !!gl.extensions.has("EXT_color_buffer_float") || isWebGL2;
    maxSamples = (caps as { maxSamples?: number }).maxSamples ?? 0;
  } catch {
    /* ignore */
  }

  cachedCaps = {
    isWebGL2,
    maxAnisotropy,
    maxTextureSize: caps.maxTextureSize,
    maxSamples,
    floatTextures,
    renderer,
    vendor,
  };

  return cachedCaps;
}

/** Apply quality-driven texture sampling to a texture. */
export function applyTextureQuality(
  tex: THREE.Texture,
  q: QualitySettings,
  opts?: { colorMap?: boolean },
): THREE.Texture {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = Math.min(getMaxAnisotropy(), q.anisotropy || getMaxAnisotropy());
  if (opts?.colorMap) {
    tex.colorSpace = THREE.SRGBColorSpace;
  } else {
    // data maps (normal, rough, metal, ao) stay linear
    tex.colorSpace = THREE.NoColorSpace;
  }
  tex.needsUpdate = true;
  return tex;
}
