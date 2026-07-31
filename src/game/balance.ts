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

  /**
   * Steering input ramp, in steer units per second (full lock = 1).
   *
   * Keyboard steering is a step function — 0 to full lock between two frames —
   * and the yaw integrator turns that into an instant change of heading. That
   * is the twitch: a 60ms tap intended as a lane correction produces the same
   * initial yaw rate as leaning on the key through a hairpin.
   *
   * Release is faster than load so catching a slide stays sharp; only the
   * commitment into a turn is slowed.
   */
  steerRampLoad: 6.0,
  steerRampRelease: 12,
  /**
   * Fraction of the load rate given up at Vmax. ~170ms to full lock parked,
   * ~260ms flat out — enough weight to feel deliberate, short enough to still
   * dodge something. This is the first number to change if the car feels either
   * twitchy or vague.
   */
  steerRampSpeedDrop: 0.35,
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

/**
 * Game feel — presentation timing that is not physics but has to be tuned
 * against it. Nothing here changes what the sim computes, only how much real
 * time it is handed.
 */
export const FEEL = {
  /**
   * Impact energy, read as the world-space velocity (u/s) the collision solver
   * removed from the player inside a single fixed step.
   *
   * The floor matters more than the ceiling: kerbing a verge post, brushing a
   * barrier or nudging a barrel must produce nothing at all. A hitstop that
   * fires on every contact stops reading as weight within one lap and starts
   * reading as a frame-rate problem.
   */
  hitstopMinDv: 6,
  hitstopFullDv: 26,
  /**
   * Second, independent trigger: the rise in the player's hitStun this step.
   * Every impact path in the codebase already sets hitStun — weapons, barrel
   * rupture, barrier, prop, car-to-car — so this catches hits that hurt without
   * transferring much momentum. A direct rocket is 0.38s of stun and almost no
   * change in velocity.
   */
  hitstopMinStun: 0.1,
  hitstopFullStun: 0.4,
  /** Freeze length in REAL seconds, at zero and at full impact energy. */
  hitstopMinDuration: 0.04,
  hitstopMaxDuration: 0.08,
  /**
   * Sim time scale held during the freeze, at zero and at full energy. A light
   * hit is a hesitation; a heavy one is very nearly stopped. Not zero, because
   * a hard 0 also freezes the particles and debris thrown by the hit, and those
   * still moving — slowly — is most of what sells it.
   */
  hitstopLightScale: 0.4,
  hitstopHeavyScale: 0.05,
  /**
   * Fraction of the freeze spent ramping back up to real time. The rest is held
   * flat, so the release still reads as a snap; this only stops the camera
   * seeing a step change in world velocity on the frame it ends.
   */
  hitstopRelease: 0.25,
  /**
   * After a freeze, incoming energy is scaled by `hitstopCooldownScale` for
   * `hitstopCooldown` seconds.
   *
   * A four-car pile-up produces a qualifying collision on almost every step.
   * Without this the sim spends a full second in slow motion and the game reads
   * as having hung. A genuinely bigger second hit still gets through.
   */
  hitstopCooldown: 0.2,
  hitstopCooldownScale: 0.35,
} as const;

export const OFFROAD = {
  maxSpeedLoss: 0.38,
  accelLoss: 0.4,
  gripLoss: 0.46,
  turnLoss: 0.14,
} as const;
