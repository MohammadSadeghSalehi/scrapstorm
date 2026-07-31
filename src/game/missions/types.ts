/**
 * Mission data model.
 *
 * The whole point of this file is that a mission is DATA. There is exactly one
 * switch over objective kinds in the codebase (runtime.ts) and it is the
 * interpreter; adding "survive four minutes on the Dead Mile with the field
 * paid to wreck you" must not add a branch anywhere else, and does not.
 *
 * The types here deliberately do not import SimState. The runtime reads a
 * structural VIEW of the sim (MissionSnapshot below) which SimState happens to
 * satisfy, so missions can be evaluated from the render loop, from a test, or
 * from a fixed step, and this module never has to be edited when the sim grows
 * a field.
 */
import type { AnyTrackId } from "../track";
import type { RivalProfile } from "../ai";
import type { VehicleClassId } from "../types";

/** Presentation grouping — icon, colour, and how the brief is worded. */
export type MissionKind =
  | "race"
  | "elimination"
  | "survival"
  | "hunt"
  | "escort"
  | "time_attack"
  | "duel";

/**
 * Objectives come in two flavours and the runtime tells them apart by kind
 * rather than by a flag, because it is a property of what the objective MEANS:
 *
 *  - ACHIEVE: starts pending, can become met. Nothing fails it early.
 *  - HOLD:    starts met, can only ever be broken. `no_wreck`, `hull_above`,
 *             `escort_alive`, `stay_near`.
 *
 * A `pace` is metres per second averaged over the distance, not a lap time in
 * seconds. Lap times are meaningless as portable data — 32 s is a great lap on
 * Cinder Bowl and an abandoned one on the Dead Mile — so the target is resolved
 * against the live track length when the run is created.
 */
export type ObjectiveDef =
  /* achieve */
  | { kind: "finish_place"; place: number }
  | { kind: "finish_race" }
  | { kind: "takedowns"; count: number }
  | { kind: "survive_time"; seconds: number }
  | { kind: "last_standing" }
  | { kind: "lead_for"; seconds: number }
  | { kind: "lap_pace"; pace: number }
  | { kind: "race_pace"; pace: number }
  | { kind: "wreck_target"; slot: number; count?: number }
  | { kind: "beat_rival"; slot: number }
  /* hold */
  | { kind: "no_wreck" }
  | { kind: "hull_above"; pct: number }
  | { kind: "escort_alive"; slot: number; minHullPct: number }
  | { kind: "stay_near"; slot: number; metres: number; graceSec: number };

export type ObjectiveKind = ObjectiveDef["kind"];

export type Objective = ObjectiveDef & {
  /** Bonus goal: does not fail the mission, pays extra markers. */
  optional?: boolean;
  /** Overrides the generated HUD wording. */
  label?: string;
};

/**
 * Everything a mission can change about how the race behaves.
 *
 * Only knobs that are actually honoured live here. `heat`, `aggression`,
 * `catchUp`, `weaponsFree`, `bountyOnPlayer` and `protectSlot` are pushed
 * straight into the AI directive by armMission; `elimination` is executed by
 * the runtime as an effect. Nothing in this shape is aspirational.
 */
export interface MissionModifiers {
  /** 0..1 league heat. Above ~0.5 the field starts hunting rather than racing. */
  heat: number;
  /** Flat aggression trim on top of heat. */
  aggression: number;
  /** Rubber-band multiplier. 0 for anything timed. */
  catchUp: number;
  /** False = bots hold fire. Ramming still happens. */
  weaponsFree: boolean;
  /** Pay the field to wreck the player. This is the pursuit. */
  bountyOnPlayer: boolean;
  /** Grid slot nobody may shoot. */
  protectSlot: number | null;
  /** Knock out the last-placed runner on a timer. */
  elimination: { everySec: number; warnSec: number } | null;
}

export const DEFAULT_MODIFIERS: MissionModifiers = {
  heat: 0,
  aggression: 0,
  catchUp: 1,
  weaponsFree: true,
  bountyOnPlayer: false,
  protectSlot: null,
  elimination: null,
};

/**
 * One named car on the grid. Slot i becomes vehicle `bot-${i}`, which is what
 * every `slot:` in an objective refers to.
 *
 * The driving profile rides along on the slot rather than being looked up from a
 * registry keyed by rivalId. A registry would mean rivals.ts registering itself
 * as an import side effect, and package.json declares `sideEffects: false` —
 * exactly the sort of thing a bundler is entitled to drop, leaving every rival
 * silently driving the default profile in a production build and nowhere else.
 */
export interface MissionGridSlot {
  name: string;
  /**
   * Preferred class. NOT honoured yet — sim.buildField assigns classes by
   * rotating CLASS_ORDER. See the report for the two-line change.
   */
  classId?: VehicleClassId;
  color?: string;
  rivalId?: string;
  profile?: RivalProfile;
}

export interface MissionReward {
  scrap: number;
  /** The Blacklist currency. Rivals unlock on a marker threshold. */
  markers: number;
  /** Paid once, on the first clear. */
  firstClearBonus?: number;
  unlockTrack?: AnyTrackId;
}

export interface MissionDef {
  id: string;
  name: string;
  kind: MissionKind;
  trackId: AnyTrackId;
  laps: number;
  /** Two or three lines of radio, delivered on the grid. Keep them short. */
  brief: string[];
  objectives: Objective[];
  modifiers: MissionModifiers;
  reward: MissionReward;
  /** Named grid, slot 0 first. Empty = anonymous house cars. */
  grid?: MissionGridSlot[];
  /** Rival this mission is a duel with. */
  rivalId?: string;
  /** Story beat ids fired before / after. Resolved against story.ts. */
  beatBefore?: string;
  beatAfter?: string;
  /** Requires this many markers to appear on the board. */
  requiresMarkers?: number;
}

/* ── the structural view of the sim ──────────────────────────────────── */

export interface MissionVehicleView {
  id: string;
  name: string;
  isPlayer: boolean;
  classId: VehicleClassId;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  health: number;
  maxHealth: number;
  alive: boolean;
  wreckTimer: number;
  lap: number;
  position: number;
  finished: boolean;
  finishTime: number;
  raceProgress: number;
  lastLapTime: number;
}

/** Event kinds SimState already understands. Missions must not invent one. */
export type MissionEventKind =
  | "hit"
  | "wreck"
  | "respawn"
  | "lap"
  | "finish"
  | "boost"
  | "pickup";

/**
 * SimState satisfies this structurally — pass `sim.state` straight in. Read-only
 * so it is obvious that evaluation never mutates the world; the runtime asks for
 * changes by returning effects instead.
 */
export interface MissionSnapshot {
  phase: string;
  raceTime: number;
  playerId: string;
  vehicles: readonly MissionVehicleView[];
  finishedOrder: readonly string[];
  events: readonly { t: number; kind: string; message: string }[];
}

/** The narrow mutable slice applyMissionEffects is allowed to touch. */
export interface MissionMutableWorld {
  raceTime: number;
  vehicles: {
    id: string;
    health: number;
    alive: boolean;
    wreckTimer: number;
    speed: number;
    damageVisual: number;
  }[];
  events: { t: number; kind: MissionEventKind; message: string }[];
  time: number;
}

export type MissionEffect =
  | { kind: "eliminate"; vehicleId: string; message: string }
  | { kind: "announce"; message: string; event: MissionEventKind };

export type ObjectiveStatus = "pending" | "met" | "failed";

export interface ObjectiveState {
  index: number;
  label: string;
  status: ObjectiveStatus;
  /** 0..1 for a bar. Always meaningful, even for hold conditions. */
  progress: number;
  /** Short right-aligned readout: "2/3", "0:41", "68%". */
  detail: string;
  optional: boolean;
}

export interface MissionRunSummary {
  missionId: string;
  outcome: "complete" | "failed" | "abandoned";
  place: number;
  raceTime: number;
  bestLap: number | null;
  takedowns: number;
  objectives: ObjectiveState[];
  /** Optional objectives that were met — drives bonus markers. */
  bonusMet: number;
}

export interface RivalDef {
  id: string;
  /** 15 is the bottom of the board, 1 is Marrow. Mirrors the Blacklist. */
  rank: number;
  name: string;
  realName: string;
  crew: string;
  classId: VehicleClassId;
  homeTrack: AnyTrackId;
  profile: RivalProfile;
  bio: string;
  /** One line each. They are heard, not read — keep them under ten words. */
  taunt: string;
  beaten: string;
  unlock: { markers: number; events: string[] };
  duel: {
    laps: number;
    kind: MissionKind;
    objectives: Objective[];
    modifiers: Partial<MissionModifiers>;
    brief: string[];
  };
  reward: MissionReward & { title: string; pinkSlip: string };
  beatAfter?: string;
}
