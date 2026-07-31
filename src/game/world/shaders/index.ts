export {
  attachGpuDetail,
  applyQualityToGpuDetails,
  updateGpuDetailFrame,
  getGpuDetailRegistry,
  clearGpuDetailRegistry,
  lodBandsFromQuality,
  lodBandAtDistance,
  type SurfaceKind,
  type GpuDetailHandles,
  type GpuDetailLodBands,
} from "./gpuDetail";
export { attachRoadWear, type RoadWearOpts } from "./roadWear";
export { GPU_NOISE_GLSL } from "./noise.glsl";
export { GpuDetailDriver } from "./GpuDetailDriver";
export {
  probeWebGpu,
  detectWebGpuSync,
  WEBGPU_SHADER_FINDINGS,
  type WebGpuCapability,
} from "./webgpu";
export {
  createTslDetailMaterial,
  applyQualityToTslSurface,
  type TslSurfaceHandles,
} from "./tslSurface";
