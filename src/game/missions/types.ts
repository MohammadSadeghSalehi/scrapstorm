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
import type { RivalPattern, RivalProfile } from "../ai";
import type { VehicleClassId } from "../types";
// The renderer-free half of weather only. `world/weather/index` exists to make
// that importable from the sim graph — do not reach past it to RainCurtain.
import type { WeatherId } from "../world/weather";

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
  /**
   * Hold a position for a while — NOT the same objective as finishing in it.
   *
   * `finish_place` is settled once, at the flag, and everything before it is
   * recoverable; a player can spend the whole race eighth and still clear it
   * with one late move. `hold_place` asks for the opposite thing: be P2 or
   * better and STAY there while the field is paid to remove you. It is the only
   * objective in the set that cannot be solved by pace alone, because pace puts
   * you at the front and then leaves you there with your back to everybody.
   *
   * Accumulated, not consecutive, for the same reason `lead_for` is: a single
   * unlucky corner should cost you seconds, not the run.
   */
  | { kind: "hold_place"; place: number; seconds: number }
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
  /**
   * Deadlines. An ACHIEVE objective still pending when one passes fails.
   *
   * One generic mechanism rather than a `wreck_target_before_lap` kind, because
   * every deadline objective anybody will ever want is an existing objective
   * with a clock on it, and the alternative is the same interpreter branch
   * written once per goal.
   *
   * What a deadline buys, and the reason the late board needs it: without one,
   * "wreck the marked car" over five laps is a patience test that a player
   * clears by waiting for the AI to make a mistake. With one, it is a plan —
   * you have to decide WHERE on the circuit you are going to do it, and go
   * there. Meaningless on a hold objective (they cannot be pending), and the
   * runtime ignores them there rather than pretending otherwise.
   */
  bySec?: number;
  /** Deadline in player laps: fails once the player STARTS this lap. */
  byLap?: number;
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
  /**
   * How the ANONYMOUS cars drive tonight. Null = ordinary racers.
   *
   * This is the late board's cheapest real escalation. Raising heat makes the
   * field shoot more; raising pace makes it faster; neither changes the SHAPE of
   * the problem. A field of blockers in the Foundry means the chokes are held
   * and you have to make your own road. A field of hunters means there is no
   * such thing as a quiet lap. Costs one word per mission.
   */
  fieldPattern: RivalPattern | null;
  /**
   * Floor under the anonymous grid's pace, on top of the career's own.
   *
   * Career fieldPace says how good the league has got since you started. This
   * says that THIS night is not an ordinary night regardless — the Feed put its
   * best extras in the show. Kept separate so a returning player re-running an
   * early event does not find the house cars silently promoted.
   */
  fieldPaceFloor: number;
}

export const DEFAULT_MODIFIERS: MissionModifiers = {
  heat: 0,
  aggression: 0,
  catchUp: 1,
  weaponsFree: true,
  bountyOnPlayer: false,
  protectSlot: null,
  elimination: null,
  fieldPattern: null,
  fieldPaceFloor: 0,
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

/** How hard a mission reads on the board, before the player has run it. */
export type MissionRisk = "low" | "medium" | "high" | "extreme";

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
  /** Aftermath used instead of `beatAfter` when the rival was wrecked, not out-driven. */
  beatAfterWrecked?: string;
  /**
   * Aftermath that plays HOWEVER it went, alongside the branch above.
   *
   * The branch pair answers "what did they make of the way you did it"; this
   * answers "what did they have to tell you". Kade confesses who actually
   * ordered the stack whether you out-drove him or put him in the scrap, and
   * folding that into both branches would mean writing the plot point twice and
   * eventually only updating one copy.
   */
  beatAfterAlways?: string;
  /**
   * The condition this event runs in. Omitted means the circuit's own default,
   * which is dry for all six — see CIRCUIT_DEFAULTS in world/environments.
   *
   * Weather is a MISSION property rather than a circuit property because the
   * circuits are identities and their QA baselines are shot dry; a permanently
   * wet circuit is a different circuit. As an event modifier it is the cheapest
   * real escalation in the game — it changes the shape of the problem rather
   * than the size of the numbers, the way `fieldPattern` does, and unlike heat
   * it costs the field exactly what it costs the player.
   *
   * Only the id is stored. armMission hands it to the weather module, which
   * owns the grip terms; the renderer reads the same id back out for the sky.
   */
  weather?: WeatherId;
  /** Requires this many markers to appear on the board. */
  requiresMarkers?: number;
  /**
   * Scrap staked on the outcome. Paid at the grid, gone if you fail.
   *
   * The system had no failure cost at all: a lost run cooled your heat and paid
   * you for your takedowns, so the optimal play was to enter everything and
   * abandon anything that went wrong. A stake is the smallest honest fix — it
   * is the player's own money, they can see it before they commit, and it makes
   * "restart" a decision instead of a reflex. Deliberately never large enough
   * to soft-lock: `affordable()` gates entry and the low tiers stay free.
   */
  entryFee?: number;
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
  /**
   * Who last damaged this car. Optional to mirror VehicleState, where it has to
   * be optional because a file this module does not own builds a display-only
   * vehicle literal. The runtime treats absent and null the same way and falls
   * back to the proximity heuristic.
   */
  lastHitBy?: string | null;
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
  /**
   * You put the mission's own rival into a wall, as opposed to out-driving them.
   *
   * Recorded because the story asks about it. The two ways of beating Halcyon
   * Vey are not the same event and the league does not react to them the same
   * way; without this the narrative can only know THAT you won.
   */
  rivalWrecked: boolean;
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
  /** Played on the way to the grid, once. Reserved for the nights that matter. */
  beatBefore?: string;
  beatAfter?: string;
  /**
   * Alternative aftermath when the player WRECKED this rival rather than
   * out-driving them. Optional: most names on the board only have one thing to
   * say, and career falls back to `beatAfter` for them.
   */
  beatAfterWrecked?: string;
  /** Plays whichever way it went. See MissionDef.beatAfterAlways. */
  beatAfterAlways?: string;
}
