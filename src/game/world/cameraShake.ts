/**
 * AAA camera trauma (Eiserloh / Vlambeer style).
 *
 * - trauma ∈ [0,1], shake = trauma² (or trauma³ for violent hits)
 * - Smooth value-noise offsets (not pure random)
 * - Rotational roll/pitch kick
 * - Directional impulse (kick opposite impact)
 * - Accessibility scale + reduced-motion clamp
 * Presentation only — never mutates gameplay.
 */

export type ShakeSettings = {
  /** 0..1 user scale (0 = off) */
  intensity: number;
  maxOffset: number;
  maxRoll: number;
  decay: number;
  /** Use trauma³ for bigger hits feel snappier */
  cubic: boolean;
};

const DEFAULTS: ShakeSettings = {
  intensity: 1,
  maxOffset: 0.95,
  maxRoll: 0.07,
  decay: 2.05,
  cubic: true, // trauma³ — big hits explode, small ones stay subtle
};

/** Smooth 1D value noise — continuous, not frame-random sparkle. */
function hash1(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

export function valueNoise1(t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f); // smoothstep
  return hash1(i) * (1 - u) + hash1(i + 1) * u;
}

/** Signed noise in [-1,1] */
export function snoise(t: number, seed = 0): number {
  return valueNoise1(t + seed * 17.13) * 2 - 1;
}

export class CameraTrauma {
  trauma = 0;
  /** Lingering directional kick in world XZ */
  kickX = 0;
  kickY = 0;
  kickZ = 0;
  settings: ShakeSettings;
  private reduced = false;

  constructor(settings: Partial<ShakeSettings> = {}) {
    this.settings = { ...DEFAULTS, ...settings };
    if (typeof window !== "undefined") {
      this.reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    }
  }

  setIntensity(v: number) {
    this.settings.intensity = Math.max(0, Math.min(1, v));
  }

  /** Add trauma (clamped). Optional world-space impact direction for kick. */
  add(amount: number, dir?: { x: number; y?: number; z: number }) {
    if (this.reduced) amount *= 0.25;
    const a = amount * this.settings.intensity;
    this.trauma = Math.min(1, this.trauma + a);
    if (dir) {
      const len = Math.hypot(dir.x, dir.z) || 1;
      const k = a * 0.55;
      // kick camera opposite the hit
      this.kickX += (-dir.x / len) * k * this.settings.maxOffset * 1.4;
      this.kickZ += (-dir.z / len) * k * this.settings.maxOffset * 1.4;
      this.kickY += (dir.y ?? 0.2) * k * 0.35;
    }
  }

  /** Sync from sim scalar (legacy cameraShake). */
  absorbSimShake(shake: number) {
    if (shake > this.trauma) this.trauma = Math.min(1, shake);
  }

  step(dt: number) {
    const d = this.settings.decay;
    this.trauma = Math.max(0, this.trauma - d * dt);
    const k = 1 - Math.exp(-8 * dt);
    this.kickX *= 1 - k;
    this.kickY *= 1 - k;
    this.kickZ *= 1 - k;
  }

  /** Current shake magnitude after trauma curve. */
  get magnitude(): number {
    const t = this.trauma;
    const curved = this.settings.cubic ? t * t * t : t * t;
    return curved * this.settings.intensity * (this.reduced ? 0.35 : 1);
  }

  /**
   * Sample position/roll offsets at time t (seconds).
   * Apply AFTER lookAt baseline, as camera-local or world offset.
   */
  sample(tSec: number): { ox: number; oy: number; oz: number; roll: number; pitch: number } {
    const m = this.magnitude;
    if (m < 0.001 && Math.abs(this.kickX) < 0.001) {
      return { ox: 0, oy: 0, oz: 0, roll: 0, pitch: 0 };
    }
    const maxO = this.settings.maxOffset;
    const maxR = this.settings.maxRoll;
    // Independent noise channels (different seeds) for organic multi-axis shake
    const ox = snoise(tSec * 18.7, 1) * m * maxO + this.kickX;
    const oy = snoise(tSec * 21.3, 2) * m * maxO * 0.55 + this.kickY;
    const oz = snoise(tSec * 16.1, 3) * m * maxO * 0.85 + this.kickZ;
    const roll = snoise(tSec * 14.5, 4) * m * maxR;
    const pitch = snoise(tSec * 12.2, 5) * m * maxR * 0.65;
    return { ox, oy, oz, roll, pitch };
  }
}

/** Presentation hitstop — freezes sim ticks briefly without stopping render. */
export class HitStop {
  remaining = 0;
  private readonly max = 0.14;

  add(seconds: number) {
    if (typeof window !== "undefined") {
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      if (reduced) seconds *= 0.35;
    }
    this.remaining = Math.min(this.max, Math.max(this.remaining, seconds));
  }

  /** Returns true if simulation should skip this frame's fixed steps. */
  tick(dt: number): boolean {
    if (this.remaining <= 0) return false;
    this.remaining -= dt;
    return true;
  }
}

export const sharedHitStop = new HitStop();
/** Global trauma bus for combat → camera without prop drilling every event. */
export const sharedTrauma = new CameraTrauma();
