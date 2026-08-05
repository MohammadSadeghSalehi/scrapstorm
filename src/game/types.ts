export type VehicleClassId = "interceptor" | "bruiser" | "trickster";

/*
 * Widened to the whole catalogue.
 *
 * This was a two-circuit union, and it was load-bearing in a way that is easy
 * to miss: sim.setTrack() assigns a track-module id into this field, and Menus
 * passes one into a callback typed with it — which strictFunctionTypes checks
 * CONTRAVARIANTLY, so a narrow parameter type here rejects a wider argument.
 * The practical effect was that startCountdown would call
 * setActiveTrack(state.selectedTrack) and silently revert any mission started
 * on one of the four new circuits.
 *
 * Re-exported from track.ts rather than restated, so the type and the
 * TRACK_CATALOG it describes cannot drift apart.
 */
import type { AnyTrackId as TrackId } from "./track";
export type { TrackId };

export type MatchPhase =
  | "menu"
  | "garage"
  | "countdown"
  | "racing"
  | "paused"
  | "finished";

export type SurfaceKind = "asphalt" | "apron" | "sand" | "deep";

export type TireTempBand = "cold" | "warm" | "optimal" | "hot" | "critical";

export interface PlayerInput {
  sequence: number;
  steering: number; // -1..1, + = left
  throttle: number; // 0..1
  brake: boolean;
  /**
   * Held S / down. Distinct from `brake`, which Shift also sets for the
   * handbrake — you should not roll backwards out of a drift. Optional so
   * replay/ghost/AI input producers stay valid without change.
   */
  reverse?: boolean;
  firePrimary: boolean;
  useDefense: boolean;
  useUltimate: boolean;
  boost: boolean;
}

export interface VehicleClassDef {
  id: VehicleClassId;
  name: string;
  tagline: string;
  color: string;
  accent: string;
  maxSpeed: number;
  accel: number;
  turnRate: number;
  grip: number;
  /**
   * How hard this chassis is to UNSTICK, independent of how fast it corners.
   *
   * `grip` alone had to mean both, and the two want opposite things from a
   * heavy car: a hauler understeers (low cornering grip) but does not snap
   * sideways (high breakaway threshold). Multiplies the denominator of the
   * grip-drift load in physics.stepGripDrift — >1 is harder to slide, <1 is
   * built to. See DRIFT in balance.ts.
   */
  slideBias: number;
  mass: number;
  health: number;
  primaryCooldown: number;
  primaryDamage: number;
  primarySpeed: number;
  primaryRange: number;
  defenseCooldown: number;
  ultimateCost: number;
  offroadPenalty: number;
  description: string;
  primaryLabel: string;
  defenseLabel: string;
  ultimateLabel: string;
}

/** Per-wheel soft-body tire sample (arcade spring-damper). */
export interface TireState {
  /** 0..1 spring compression (0 = extension, 1 = full bump) */
  compress: number;
  /** Compression velocity for spring-damper (1/s) */
  compressVel: number;
  lat: number;
  long: number;
  slip: number;
  spin: number;
  temp: number;
}

export interface VehicleState {
  id: string;
  name: string;
  isPlayer: boolean;
  classId: VehicleClassId;
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  lateral: number;
  health: number;
  maxHealth: number;
  shield: number;
  weaponCharge: number;
  shieldCharge: number;
  ultimateCharge: number;
  primaryCooldown: number;
  defenseCooldown: number;
  ultimateActive: number;
  defenseActive: number;
  decoyActive: number;
  invuln: number;
  wreckTimer: number;
  boostTimer: number;
  lap: number;
  checkpoint: number;
  raceProgress: number;
  finished: boolean;
  finishTime: number;
  position: number;
  color: string;
  damageVisual: number;
  /** 0..1 crumple zones for mesh deformation */
  dentFront: number;
  dentLeft: number;
  dentRight: number;
  dentRear: number;
  impactFlash: number;
  lockTargetId: string | null;
  airTime: number;
  nearMissBoost: number;
  alive: boolean;
  hitStun: number;
  offroadAmount: number;
  surface: SurfaceKind;
  bodyRoll: number;
  bodyPitch: number;
  tires: TireState[];
  steerAngle: number;
  tireLoad: number;
  tireSlip: number;
  tireTemp: number;
  tireTempBand: TireTempBand;
  driftMeter: number;
  /** Smoothed longitudinal accel for HUD (sim units / s) */
  uiAccel: number;
  lapTimes: number[];
  lastLapTime: number;
  /**
   * Who last put damage on this car, and how long ago in sim seconds.
   *
   * Takedown attribution used to be a proximity-and-facing guess made by the
   * mission runtime, because applyDamage took an ownerId and threw it away.
   * Recording it on the VICTIM rather than tallying it on the attacker is what
   * keeps it one field: every damage path already has the victim in hand.
   *
   * `lastHitAge` exists so credit expires. Without it a rival you shot on lap
   * one and never touched again would still be "your" takedown when they put it
   * into a wall four minutes later. sim.fixedStep ages it and clears the
   * attribution once it is stale.
   *
   * Both are OPTIONAL, and that is not laziness: world/GameScene.tsx builds a
   * display-only VehicleState literal and is owned elsewhere. A required field
   * here would break a file this change has no business editing.
   */
  lastHitBy?: string | null;
  lastHitAge?: number;
}

export interface Projectile {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  damage: number;
  kind: "bolt" | "cannon" | "disc" | "missile";
  /**
   * Homing target, missiles only.
   *
   * An id rather than a reference so the projectile stays plain data that can
   * cross the sim/audio/VFX boundary and survive a structuredClone. Resolved
   * against the vehicle list each step; a target that wrecks or vanishes simply
   * stops being found and the missile flies straight, which is the behaviour we
   * want anyway.
   */
  seek?: string;
  /** Seconds before guidance engages, so a salvo spreads before it converges. */
  armTime?: number;
  bounce: number;
  radius: number;
}

export interface Mine {
  id: string;
  ownerId: string;
  x: number;
  z: number;
  y: number;
  life: number;
  armed: number;
  radius: number;
  damage: number;
}

export interface Particle {
  id: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  kind?: "spark" | "smoke" | "debris" | "dust";
}

export interface GameEvent {
  t: number;
  kind: "hit" | "wreck" | "respawn" | "lap" | "finish" | "boost" | "pickup";
  message: string;
}

/** World physics props (barrels, crates, barriers) */
export interface WorldPropState {
  id: string;
  kind: "barrel" | "crate" | "scrap" | "barrier";
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vy: number;
  vz: number;
  spin: number;
  radius: number;
  mass: number;
  dynamic: boolean;
  hp: number;
  scale: number;
  dent: number;
  dead: boolean;
}

export interface SimState {
  phase: MatchPhase;
  resumePhase: MatchPhase | null;
  time: number;
  raceTime: number;
  countdown: number;
  vehicles: VehicleState[];
  projectiles: Projectile[];
  mines: Mine[];
  particles: Particle[];
  props: WorldPropState[];
  events: GameEvent[];
  lapCount: number;
  seed: number;
  playerId: string;
  guestName: string;
  selectedClass: VehicleClassId;
  selectedTrack: TrackId;
  finishedOrder: string[];
  cameraShake: number;
  /** World XZ impact direction for directional camera kick */
  cameraKick: { x: number; z: number } | null;
  lastHitFlash: number;
  scrapEarned: number;
  bestLapThisRace: number | null;
  /** ghost beat this heat */
  ghostBeaten: boolean;
  /** new personal best ghost saved */
  ghostSaved: boolean;
}

export interface TrackSample {
  x: number;
  y: number;
  z: number;
  yaw: number;
  width: number;
  zone: "race" | "arena" | "narrow" | "hazard" | "jump";
  s: number;
}

export interface CheckpointGate {
  index: number;
  x: number;
  z: number;
  nx: number;
  nz: number;
  halfWidth: number;
}

export interface SurfaceInfo {
  kind: SurfaceKind;
  factor: number;
  roughness: number;
  dist: number;
  half: number;
  sample: TrackSample;
}
