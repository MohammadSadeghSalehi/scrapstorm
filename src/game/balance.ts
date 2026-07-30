/**
 * Scrapstorm League — core design / balance sheet.
 *
 * HUD speed = gameSpeed × 4  →  100 mph ≈ 25 u/s, Vmax 80 ≈ 320.
 * Pure throttle: 0→100 ~10–11s, long top-end crawl; boost unlocks the last stretch.
 */

export const RACE = {
  laps: 3,
  countdownSec: 3,
  maxRaceTime: 420,
  catchUpMax: 0.28,
  catchUpStartGap: 0.28,
} as const;

export const HANDLING = {
  /** Asphalt rolling resistance — low enough to reach high speed, high enough for weight */
  roadDrag: 0.016,
  coastDrag: 0.038,
  brakeDrag: 1.55,
  lateralDecay: 8.2,
  minSteerSpeed: 1.6,
  reverseEnterSpeed: 1.5,
  /** Reverse top speed as a fraction of forward Vmax. */
  reverseMaxFrac: 0.22,
  /** Reverse acceleration as a fraction of forward accel. */
  reverseAccelMul: 0.55,

  driftGrip: 0.16,
  driftTurnMul: 1.85,
  driftHandbrakeDrag: 0.32,
  driftThrottleMul: 1.06,
  driftLateralPush: 0.78,
  driftMaxLatFrac: 0.48,

  driftChargeRate: 1.12,
  driftBoostThreshold: 0.16,
  driftBoostOrange: 0.45,
  driftBoostMax: 1.15,
  driftBoostDuration: 1.4,
  driftBoostMinSpeed: 2.5,

  /**
   * Progressive torque: soft launch → fat mid → hard top taper.
   * Avoids instant 0→100 arcade snap.
   */
  torqueAt0: 0.9,
  torqueAtMid: 0.78,
  torqueAtTop: 0.42,
  launchMul: 1.0,
  launchWindow: 0.28,
  topSpeedEase: 0.9,
  lowSpeedSteerBoost: 1.55,
  highSpeedSteerMul: 0.68,
  engineBrake: 0.16,
  brakeForceMul: 2.55,
  /**
   * Progressive aero base; physics multiplies by (0.2 + sr²·1.4)
   * so low-speed pull stays strong and Vmax is a real climb.
   */
  aeroCoeff: 0.00000055,
} as const;

export const COMBAT = {
  lockCone: 0.1,
  lockBlend: 0.72,
  weaponDrain: 0.09,
  weaponMinMul: 0.55,
  weaponMaxMul: 1.45,
  weaponIdle: 0.06,
  shieldIdle: 0.03,
  ultimateIdle: 0.016,
  draftRange: 14,
  draftMaxRate: 0.62,
  ramUltimateScale: 0.014,
  wreckRespawnHp: 0.65,
  wreckInvuln: 2.0,
  dmgSpeedPenalty: 0.14,
  dmgAccelPenalty: 0.2,
  impactDmgThreshold: 6.5,
  impactDmgScale: 0.55,
  impactStunScale: 0.018,
} as const;

export const OFFROAD = {
  maxSpeedLoss: 0.38,
  accelLoss: 0.4,
  gripLoss: 0.46,
  turnLoss: 0.14,
} as const;
