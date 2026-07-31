/**
 * The one speed curve.
 *
 * FOV widening, chase pull-back, camera height, look-ahead, shake gain and the
 * radial motion blur in PostFX all key off "how fast am I going". Each of them
 * previously owned its own normalisation and its own shaping, so they arrived
 * at different points on the speedo: the blur ramped in while the FOV was
 * already saturated, and the pull-back capped at a speed the car can only reach
 * on boost. Three unrelated effects rather than one sensation.
 *
 * Everything speed-reactive goes through here. Nothing in this file allocates
 * or touches the GPU — it is pure arithmetic evaluated a handful of times per
 * frame.
 */

/**
 * Speed (world u/s) that normalises to 1.
 *
 * Matches the divisor PostFX's radial blur is driven by. Vmax for the fastest
 * class sits a little under this, so 1.0 is reached only on boost — which is
 * the point: the top of the band should be somewhere you visit, not somewhere
 * you live.
 */
export const SPEED_REF = 84;

export function speedNorm(speed: number): number {
  const s = Math.abs(speed) / SPEED_REF;
  return s > 1 ? 1 : s;
}

/**
 * Where the "loud" cues start. Below this only the gentle terms (pull-back,
 * look-ahead, base FOV) are moving; above it the top-end push, extra shake and
 * the motion blur come in together.
 */
export const RESPONSE_KNEE = 0.34;

/**
 * Shaped response for the loud cues, 0 below the knee and quadratic above it.
 *
 * Deliberately the same curve PostFX applies to blur strength. If these two
 * disagree the blur arrives on its own and reads as a rendering artefact
 * rather than as speed.
 */
export function speedResponse(sn: number): number {
  const r = (sn - RESPONSE_KNEE) / (1 - RESPONSE_KNEE);
  if (r <= 0) return 0;
  return r > 1 ? 1 : r * r;
}

/**
 * Frame-rate independent approach toward a target with a time constant.
 *
 * `tau` is the seconds to close ~63% of the gap. Using this rather than a bare
 * `lerp(a, b, 0.1)` matters here specifically because the game runs anywhere
 * between 30 and 144Hz and a per-frame fraction would make the camera feel
 * different on every machine.
 */
export function approach(
  current: number,
  target: number,
  tau: number,
  dt: number,
): number {
  if (tau <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

/**
 * Chase rig tuning. All of it is feel, none of it is physics — change freely.
 *
 * The FOV numbers are the ones worth touching first: `fovSpeedGain` is how
 * much the frame opens up across the whole speed range, `fovTopGain` is the
 * extra push reserved for the top of it.
 */
export const CHASE = {
  /** Standing-still FOV. The whole rig is built up from this. */
  fovBase: 56,
  /** Widening applied linearly across the speed range. */
  fovSpeedGain: 12,
  /** Extra widening loaded above the knee — flat out this stacks on the above. */
  fovTopGain: 7,
  fovBoost: 6,
  fovDrift: 2.5,
  /**
   * FOV smoothing. Rise is quick because the widening IS the acceleration cue;
   * fall is slow because a frame that narrows as fast as the car decelerates is
   * the single most nauseating thing a chase camera can do. Never apply the
   * target raw.
   */
  fovTau: 0.12,

  /**
   * Normalised-speed smoothing, feeding every other term below.
   *
   * A wall takes the car from 70 u/s to 0 in one fixed step. Without this the
   * rig would slam forward and the FOV collapse on the frame of impact, on top
   * of the hitstop and the shake — three violent things at once, which reads as
   * a glitch rather than a crash. Falling is much slower than rising.
   */
  snRiseTau: 0.12,
  snFallTau: 0.45,

  distBase: 13.5,
  distGain: 3.4,
  heightBase: 7.2,
  heightGain: 1.5,
  lookBase: 10,
  lookGain: 7,

  /** Shake amplitude multiplier at zero speed and the gain added by speed. */
  shakeBase: 0.6,
  shakeGain: 0.7,
  /**
   * Continuous high-speed rumble, in world units, applied above the knee.
   * Small on purpose — this is the difference between "the car is fast" and
   * "the camera is broken". Set to 0 to remove it entirely.
   */
  rumble: 0.055,
} as const;
