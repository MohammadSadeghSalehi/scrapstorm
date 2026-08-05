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

/**
 * Grip drift — a held steering lock through a heavy turn breaking traction.
 *
 * Distinct from the handbrake drift above (`HANDLING.drift*`), which is an
 * INPUT: you press Shift, the rear steps out. This is a CONSEQUENCE: you asked
 * the car for more corner than the tyres had and kept asking. Most Wanted's
 * fast corners are won like this, and the handbrake is for the hairpins.
 *
 * ── the entry, and why it is two terms and not one ───────────────────
 *
 * "Longer presses" and "heavy turns" are different things and both have to be
 * true, or the mechanic becomes either a timer (drift after 0.5s of any
 * steering, including a lane change at 30km/h) or a switch (drift the instant
 * you turn hard, which is a car that cannot be driven).
 *
 *   LOAD  = |steer| x speedRatio / (grip x slideBias)
 *
 * One expression of "how hard a corner, how fast, in what car". speedRatio is
 * per-class so it means the same thing in a Bruiser as an Interceptor, and
 * dividing by the LIVE `grip` means the number that decides this is the SAME
 * number the rest of the physics already uses — including the tyre-temperature
 * multiplier and the off-road penalty. Cold tyres and a sand excursion break
 * away early for free, which is exactly right and cost nothing to arrange.
 *
 * `slideBias` (VehicleClassDef) is the part `grip` could not say. Breaking away
 * late and cornering fast are different properties and a heavy car wants
 * opposite answers to them: while they shared one number the Bruiser had to
 * hold the best cornering grip in the game in order to be the hardest to
 * unstick, and it duly won half of every measured race. The thresholds below
 * are the ones this model was authored against and are unchanged; only the way
 * they are reached is.
 *
 * Class-by-class, the steering x speed product needed to reach `breakLoad`:
 *
 *   trickster  0.88 x 0.70  →  0.38   (full lock at 38% of Vmax — built to slide)
 *   interceptor 0.90 x 1.00 →  0.56
 *   bruiser    0.82 x 1.18  →  0.60   (hardest to unstick, as advertised)
 *
 * ── the hold ─────────────────────────────────────────────────────────
 *
 * Past the limit, the slide still has to be COMMITTED to: `holdBase` seconds of
 * sustained lock at the threshold, falling to `holdFloor` when you are well
 * over it. A flick is never a drift; leaning on it through a fast sweeper is.
 * The steering ramp (HANDLING.steerRampLoad) already costs ~0.17s to reach full
 * lock, so a real press-to-slide is roughly 0.3s in a hard corner and 0.75s in
 * a marginal one.
 *
 * ── the exit ─────────────────────────────────────────────────────────
 *
 * Releasing the lock ends it: `active` bleeds out over ~0.4s and the drift
 * charge cashes in as a boost through the existing HANDLING.driftBoost* path,
 * so the payoff and the exit are the same action. Counter-steering ends it
 * faster AND scrubs the slip angle directly, which is what makes a slide
 * something you can place rather than something you sit through.
 */
export const DRIFT = {
  /** m/s floor. Below this a held lock is a manoeuvre, not a slide. */
  minSpeed: 16,
  /** |steer| that counts as "held". Below 0.6x of it the hold timer unwinds. */
  steerMin: 0.5,
  /** LOAD at which the tyres are exactly at the limit. */
  breakLoad: 0.62,
  /** Seconds of sustained lock needed AT the limit... */
  holdBase: 0.55,
  /** ...and once `overFull` past it. */
  holdFloor: 0.18,
  overFull: 0.32,
  /** Engagement / release rate, in units of `active` per second. */
  enterRate: 4.5,
  exitRate: 2.6,
  /** Counter-steer multiplies the release rate and scrubs slip at this rate. */
  counterExit: 2.2,
  counterScrub: 3.4,
  /** Sustain floor: below this steering, or this speed, the slide lets go. */
  sustainSteer: 0.3,
  sustainSpeed: 11,
  /** Grip held while fully sliding. Deliberately well above the handbrake's
   *  0.16 — this is a slide you steer, not one you survive. */
  slideGrip: 0.34,
  /** Extra yaw authority at full slide. This is what rotates the car. */
  yawGain: 0.42,
  /**
   * Slip angle is TARGETED, not integrated from a force, and that is a
   * deliberate departure from the handbrake drift sitting above it.
   *
   * The handbrake branch adds a constant push and applies no lateral decay at
   * all, so the slip angle is an open integral: it grows for as long as you hold
   * the drift and only stops at a hard clamp. That is survivable for a handbrake
   * slide you pulled on purpose, and wrong for one the corner gave you — the
   * angle would depend on how long the corner was rather than on how hard you
   * were driving it.
   *
   * Driving toward `maxLatFrac x speed x engagement x lock` instead means the
   * angle is a readout of the input at every instant. Ease the lock off and the
   * car straightens; hold it and the angle sits where it is. That is the whole
   * difference between a slide you place and a slide you sit out.
   *
   * 0.30 is a 16.7deg slip angle at full commitment — the nose visibly inside
   * the corner, the car travelling wide — against the handbrake's 0.48 (26deg).
   */
  maxLatFrac: 0.3,
  /** How fast the slip angle chases its target, per second. ~0.45s to settle. */
  latRate: 2.6,
  /** Lock at which the slip target is fully expressed. Below it, proportional. */
  fullLock: 0.8,
  /** Speed bled per second at full slide, as an exponential rate. */
  scrub: 0.22,
  /** `active` above which the car counts as drifting for FX, audio and charge. */
  engaged: 0.18,
  /**
   * ── the grip drift is PLAYER-ONLY, and that is a considered decision ──
   *
   * `aiEffect` scales the whole effect for a bot; `aiHoldMul` scales how long
   * one has to hold a lock before it breaks away. Both knobs are real and the
   * state machine runs for every car, so turning rivals' slides on is one number
   * — but it is set to zero, for two reasons that are worth writing down.
   *
   * 1. aiInput is a CLOSED-LOOP CONTROLLER tuned against a car that does not
   *    slide. It steers on heading error at a fixed gain, has no notion of slip
   *    angle, no counter-steer, and no way to modulate a lock it is already
   *    holding at the limit. Changing the plant under a controller without
   *    changing the controller is the textbook way to make a loop unstable, and
   *    it showed: bots holding near-full lock through ordinary corners entered a
   *    slide, ran wide, corrected harder, and entered another.
   * 2. Measured, it made the field's PACE SPREAD unrepeatable. The regression
   *    suite compares distance covered by a pace-0 field against a pace-1 one;
   *    with rivals sliding, the same comparison returned anywhere from -1% to
   *    +7% across runs, because a bot that throws one away in a corner loses far
   *    more than the grip advantage being measured is worth.
   *
   * Rivals are not on rails regardless: the handbrake drift is untouched, and
   * tricksters already brake-and-steer through tight corners, so the field still
   * slides. Giving rivals the grip drift properly means giving aiInput a slip
   * angle to steer against, which is a bigger change than this one.
   */
  aiHoldMul: 1.9,
  aiEffect: 0,
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
