/**
 * Adaptive graphics quality — GPU budget + multi-band detail LoD.
 * Defaults conservative so first load stays playable.
 */

export type QualityTier = "low" | "medium" | "high";

export type QualitySettings = {
  tier: QualityTier;
  dprMax: number;
  antialias: boolean;
  shadowEnabled: boolean;
  shadowMapSize: number;
  softShadows: boolean;
  bakeScale: number;
  anisotropy: number;
  gpuDetail: number;
  shaderOctaves: number;
  lodNear: number;
  lodMid?: number;
  lodFar: number;
  particleMax: number;
  skidMax: number;
  dustCount: number;
  duneSegments: number;
  skySegments: number;
  vehicleNormals: boolean;
  allVehicleShadows: boolean;
  hdriEnv: boolean;
};

const PRESETS: Record<QualityTier, Omit<QualitySettings, "tier">> = {
  low: {
    dprMax: 1,
    antialias: false,
    shadowEnabled: false,
    shadowMapSize: 512,
    softShadows: false,
    bakeScale: 0.4,
    anisotropy: 2,
    gpuDetail: 0,
    shaderOctaves: 1,
    lodNear: 10,
    lodMid: 20,
    lodFar: 42,
    particleMax: 40,
    skidMax: 36,
    dustCount: 28,
    duneSegments: 6,
    skySegments: 20,
    vehicleNormals: false,
    allVehicleShadows: false,
    hdriEnv: false,
  },
  medium: {
    dprMax: 1.15,
    antialias: true,
    shadowEnabled: true,
    shadowMapSize: 768,
    softShadows: false,
    bakeScale: 0.55,
    anisotropy: 4,
    gpuDetail: 0.25,
    shaderOctaves: 2,
    lodNear: 12,
    lodMid: 28,
    lodFar: 60,
    particleMax: 72,
    skidMax: 56,
    dustCount: 56,
    duneSegments: 8,
    skySegments: 28,
    vehicleNormals: true,
    allVehicleShadows: false,
    hdriEnv: true,
  },
  high: {
    dprMax: 1.35,
    antialias: true,
    shadowEnabled: true,
    shadowMapSize: 1024,
    softShadows: false,
    bakeScale: 0.8,
    anisotropy: 8,
    gpuDetail: 0.55,
    shaderOctaves: 3,
    lodNear: 20,
    lodMid: 48,
    lodFar: 90,
    particleMax: 110,
    skidMax: 90,
    dustCount: 90,
    duneSegments: 12,
    skySegments: 40,
    vehicleNormals: true,
    allVehicleShadows: false,
    hdriEnv: true,
  },
};

export function detectQualityTier(): QualityTier {
  if (typeof navigator === "undefined") return "medium";
  const cores = navigator.hardwareConcurrency || 4;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  // Never start on high — scale up only after stable FPS
  if (mobile) return "low";
  if (cores <= 4 || (mem != null && mem <= 4)) return "low";
  return "medium";
}

export function settingsFor(tier: QualityTier): QualitySettings {
  return { tier, ...PRESETS[tier] };
}

type Listener = (s: QualitySettings) => void;

class QualityManager {
  private settings: QualitySettings;
  private listeners = new Set<Listener>();
  private emaFt = 16.7;
  private lowFrames = 0;
  private highFrames = 0;
  private auto = true;

  constructor() {
    this.settings = settingsFor(detectQualityTier());
  }

  get(): QualitySettings {
    return this.settings;
  }

  getFpsEma(): number {
    return 1000 / Math.max(1, this.emaFt);
  }

  setTier(tier: QualityTier, opts?: { auto?: boolean }) {
    if (opts?.auto === false) this.auto = false;
    if (opts?.auto === true) this.auto = true;
    if (this.settings.tier === tier) return;
    this.settings = settingsFor(tier);
    for (const l of this.listeners) l(this.settings);
  }

  setAuto(on: boolean) {
    this.auto = on;
  }

  isAuto() {
    return this.auto;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  sampleFrame(dt: number) {
    if (!this.auto) {
      const ft = Math.min(50, Math.max(4, dt * 1000));
      this.emaFt = this.emaFt * 0.86 + ft * 0.14;
      return;
    }
    const ft = Math.min(50, Math.max(4, dt * 1000));
    this.emaFt = this.emaFt * 0.86 + ft * 0.14;
    const fps = 1000 / this.emaFt;

    // Drop quality quickly when lagging
    if (fps < 40) {
      this.lowFrames++;
      this.highFrames = 0;
      if (this.lowFrames > 12) {
        this.lowFrames = 0;
        if (this.settings.tier === "high") this.setTier("medium");
        else if (this.settings.tier === "medium") this.setTier("low");
      }
    } else if (fps > 56) {
      this.highFrames++;
      this.lowFrames = 0;
      // Slow climb only — avoid thrash
      if (this.highFrames > 360) {
        this.highFrames = 0;
        if (this.settings.tier === "low") this.setTier("medium");
        else if (this.settings.tier === "medium") this.setTier("high");
      }
    } else {
      this.lowFrames = Math.max(0, this.lowFrames - 1);
      this.highFrames = Math.max(0, this.highFrames - 1);
    }
  }
}

export const qualityManager = new QualityManager();
