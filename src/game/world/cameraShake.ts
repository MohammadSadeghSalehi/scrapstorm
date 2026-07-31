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

import { FEEL } from "../balance";

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

/**
 * Impact hitstop — a scale on the sim's clock, not a frame skip.
 *
 * The previous version answered "should this frame's fixed steps be skipped?",
 * which can only express a total freeze, and it was consumed inside the sim's
 * own tick — after the driver had already subtracted a full step from its
 * accumulator, so the stopped time was silently discarded rather than deferred.
 *
 * Scaling the real time fed into the fixed accumulator instead keeps the step
 * size at exactly 1/60 (the sim stays deterministic and merely advances more
 * slowly), returns the time properly to the accumulator, and makes a light hit
 * expressible as a hesitation rather than a stop.
 *
 * Presentation only. Nothing that decides gameplay may read this.
 */
export class HitStop {
  private remaining = 0;
  private duration = 0;
  private scale = 1;
  private cooldown = 0;
  private reduced = false;

  constructor() {
    if (typeof window !== "undefined") {
      this.reduced =
        window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    }
  }

  get active(): boolean {
    return this.remaining > 0;
  }

  /**
   * Request a stop. `energy01` is normalised impact energy in [0,1]; both the
   * duration and how hard the clock is pulled scale with it, so a scrape and a
   * head-on are not the same event with the same pause.
   *
   * Re-triggering during a stop deepens and extends, never shortens: the second
   * car in a pile-up must not cut the first impact short.
   */
  trigger(energy01: number) {
    let e = energy01 < 0 ? 0 : energy01 > 1 ? 1 : energy01;
    if (this.cooldown > 0) e *= FEEL.hitstopCooldownScale;
    if (e <= 0.02) return;

    let dur =
      FEEL.hitstopMinDuration +
      (FEEL.hitstopMaxDuration - FEEL.hitstopMinDuration) * e;
    let sc =
      FEEL.hitstopLightScale +
      (FEEL.hitstopHeavyScale - FEEL.hitstopLightScale) * e;
    if (this.reduced) {
      // Shorter and much less severe rather than off: a hit that produces no
      // response at all is a legibility loss, and the nausea risk here is the
      // time distortion, not its existence.
      dur *= 0.5;
      sc = 1 - (1 - sc) * 0.35;
    }

    if (this.remaining > 0) {
      this.duration = Math.max(this.duration, dur);
      this.remaining = Math.max(this.remaining, dur);
      this.scale = Math.min(this.scale, sc);
    } else {
      this.duration = dur;
      this.remaining = dur;
      this.scale = sc;
    }
  }

  /**
   * Advance by one frame of REAL time and return the scale to apply to the sim
   * clock. Must be called exactly once per rendered frame, by the fixed-step
   * driver and nowhere else.
   */
  consume(dtReal: number): number {
    if (this.cooldown > 0) {
      this.cooldown -= dtReal;
      if (this.cooldown < 0) this.cooldown = 0;
    }
    if (this.remaining <= 0) return 1;
    this.remaining -= dtReal;
    if (this.remaining <= 0) {
      this.remaining = 0;
      this.cooldown = FEEL.hitstopCooldown;
      return 1;
    }
    // t runs 1 -> 0 across the stop. Held flat until the release window so the
    // recovery still reads as a snap.
    const t = this.remaining / this.duration;
    if (t < FEEL.hitstopRelease) {
      return this.scale + (1 - this.scale) * (1 - t / FEEL.hitstopRelease);
    }
    return this.scale;
  }

  /** Clear on a grid reset so a finish-line crash cannot bleed into the next race. */
  reset() {
    this.remaining = 0;
    this.duration = 0;
    this.scale = 1;
    this.cooldown = 0;
  }
}

export const sharedHitStop = new HitStop();
/** Global trauma bus for combat → camera without prop drilling every event. */
export const sharedTrauma = new CameraTrauma();
