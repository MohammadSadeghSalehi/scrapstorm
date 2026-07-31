/**
 * Event missions — the qualifying heats between Blacklist duels.
 *
 * Every one of these is data. If you find yourself wanting to add a field here
 * to express a new kind of goal, add an objective kind to types.ts and a case to
 * the interpreter instead; the moment a mission needs a bespoke branch
 * somewhere, the next forty missions will need forty more.
 *
 * On pace targets: these are metres per second averaged over the distance and
 * they are a FIRST PASS. They were chosen at roughly 35-45% of class top speed,
 * which is deliberately soft — a pace target that cannot be met turns a mission
 * into a wall, and there is no way to measure a real racing average without
 * running the game, which this pass could not do. They want one balance sweep
 * with a stopwatch. Everything else here is structural and does not.
 */
import {
  DEFAULT_MODIFIERS,
  type MissionDef,
  type MissionModifiers,
} from "./types";

type Draft = Omit<MissionDef, "modifiers" | "reward"> & {
  modifiers?: Partial<MissionModifiers>;
  reward?: Partial<MissionDef["reward"]>;
};

function mission(d: Draft): MissionDef {
  return {
    ...d,
    modifiers: { ...DEFAULT_MODIFIERS, ...(d.modifiers ?? {}) },
    reward: { scrap: 120, markers: 2, ...(d.reward ?? {}) },
  };
}

/** Anonymous grid. Named grids are for rivals and escort clients. */
const HOUSE: MissionDef["grid"] = undefined;

export const EVENT_MISSIONS: MissionDef[] = [
  /* ── prologue ─────────────────────────────────────────────────────── */
  mission({
    id: "pro_debut",
    name: "Borrowed Metal",
    kind: "race",
    trackId: "ash_spire",
    laps: 2,
    brief: [
      "Bex bolted this thing together out of two other things.",
      "Three laps of Spire. Finish it and the board gives you a number.",
    ],
    objectives: [
      { kind: "finish_place", place: 3 },
      { kind: "no_wreck", optional: true, label: "Bring it back whole" },
    ],
    modifiers: { heat: 0, catchUp: 1.2 },
    reward: { scrap: 90, markers: 2, firstClearBonus: 60 },
    grid: HOUSE,
    beatBefore: "cold-open",
    beatAfter: "first-heat",
  }),

  /* ── Ash Spire ─────────────────────────────────────────────────────── */
  mission({
    id: "as_sprint",
    name: "Spire Sprint",
    kind: "race",
    trackId: "ash_spire",
    laps: 3,
    brief: ["Standard televised heat.", "Draft, ram, take the arena wide."],
    objectives: [{ kind: "finish_place", place: 2 }],
    reward: { scrap: 140, markers: 2 },
  }),
  mission({
    id: "as_bounty",
    name: "Feed Bounty",
    kind: "hunt",
    trackId: "ash_spire",
    laps: 3,
    brief: [
      "The Feed has painted one car red and set a price on it.",
      "Wreck it before someone else banks the purse.",
    ],
    objectives: [
      { kind: "wreck_target", slot: 0 },
      { kind: "finish_race" },
      { kind: "takedowns", count: 2, optional: true },
    ],
    modifiers: { heat: 0.3, aggression: 0.2 },
    reward: { scrap: 200, markers: 4 },
    grid: [{ name: "RED MARK" }, { name: "Ash Coil" }, { name: "Volt Rake" }],
  }),
  mission({
    id: "as_gauntlet",
    name: "The Gauntlet",
    kind: "survival",
    trackId: "ash_spire",
    laps: 6,
    brief: [
      "Every crew still on the board wants your rank tonight.",
      "Two minutes. Stay running.",
    ],
    objectives: [
      { kind: "survive_time", seconds: 120 },
      { kind: "hull_above", pct: 0.1 },
      { kind: "takedowns", count: 3, optional: true },
    ],
    modifiers: { heat: 0.85, bountyOnPlayer: true, aggression: 0.4 },
    reward: { scrap: 420, markers: 8 },
    beatAfter: "gauntlet-run",
  }),

  /* ── Cinder Bowl ───────────────────────────────────────────────────── */
  mission({
    id: "cb_squeeze",
    name: "The Squeeze",
    kind: "race",
    trackId: "cinder_bowl",
    laps: 4,
    brief: ["Kidney loop, one real overtaking spot.", "Take the hairpin or take the hit."],
    objectives: [{ kind: "finish_place", place: 1 }],
    reward: { scrap: 160, markers: 3 },
  }),
  mission({
    id: "cb_elim",
    name: "Cull",
    kind: "elimination",
    trackId: "cinder_bowl",
    laps: 8,
    brief: [
      "Every twenty seconds the Feed cuts the last car.",
      "There is no finish line here. There is only being left.",
    ],
    objectives: [{ kind: "last_standing" }],
    modifiers: { heat: 0.45, elimination: { everySec: 22, warnSec: 5 } },
    reward: { scrap: 260, markers: 5 },
  }),
  mission({
    id: "cb_clean",
    name: "Cold Weapons",
    kind: "time_attack",
    trackId: "cinder_bowl",
    laps: 3,
    brief: ["Weapons cold, clock hot.", "One clean lap is all this asks. It is not nothing."],
    objectives: [
      { kind: "lap_pace", pace: 26 },
      { kind: "no_wreck" },
    ],
    modifiers: { weaponsFree: false, catchUp: 0 },
    reward: { scrap: 180, markers: 3 },
  }),

  /* ── Foundry Pit ───────────────────────────────────────────────────── */
  mission({
    id: "fp_scrum",
    name: "Scrum",
    kind: "elimination",
    trackId: "foundry_pit",
    laps: 10,
    brief: [
      "Six hundred metres of lap and two chokes to share.",
      "Last car in the Pit takes the purse.",
    ],
    objectives: [{ kind: "last_standing" }],
    modifiers: { heat: 0.5, elimination: { everySec: 18, warnSec: 5 } },
    reward: { scrap: 240, markers: 4 },
  }),
  mission({
    id: "fp_takedown",
    name: "Piecework",
    kind: "hunt",
    trackId: "foundry_pit",
    laps: 5,
    brief: ["Paid by the wreck tonight.", "Three of them. The bowls are wide; the chokes are not."],
    objectives: [
      { kind: "takedowns", count: 3 },
      { kind: "finish_race" },
    ],
    modifiers: { heat: 0.4, aggression: 0.3 },
    reward: { scrap: 280, markers: 5 },
  }),
  mission({
    id: "fp_holdout",
    name: "Holdout",
    kind: "survival",
    trackId: "foundry_pit",
    laps: 12,
    brief: [
      "The Pit gate is shut and the bounty is live.",
      "Ninety seconds. Nowhere to disengage.",
    ],
    objectives: [
      { kind: "survive_time", seconds: 90 },
      { kind: "no_wreck" },
    ],
    modifiers: { heat: 0.75, bountyOnPlayer: true, aggression: 0.35 },
    reward: { scrap: 340, markers: 6 },
  }),
  mission({
    id: "fp_kingpit",
    name: "King of the Pit",
    kind: "race",
    trackId: "foundry_pit",
    laps: 8,
    brief: ["Lead. Keep leading.", "Forty-five seconds out front, total. They do not have to be consecutive."],
    objectives: [
      { kind: "lead_for", seconds: 45 },
      { kind: "finish_race" },
    ],
    modifiers: { heat: 0.5, catchUp: 1.3 },
    reward: { scrap: 300, markers: 5 },
  }),

  /* ── Rustline ──────────────────────────────────────────────────────── */
  mission({
    id: "rl_scrapline",
    name: "Scrapline",
    kind: "race",
    trackId: "rustline",
    laps: 4,
    brief: [
      "Narrowest road in the league and a slalom nobody likes.",
      "The conveyor at the top will launch you whether you meant it or not.",
    ],
    objectives: [{ kind: "finish_place", place: 2 }],
    modifiers: { heat: 0.25 },
    reward: { scrap: 200, markers: 4 },
  }),
  mission({
    id: "rl_threadneedle",
    name: "Threadneedle",
    kind: "time_attack",
    trackId: "rustline",
    laps: 3,
    brief: ["One lap of the Gauntlet, under the number.", "Weapons cold. Nobody to blame."],
    objectives: [
      { kind: "lap_pace", pace: 22 },
      { kind: "hull_above", pct: 0.6 },
    ],
    modifiers: { weaponsFree: false, catchUp: 0 },
    reward: { scrap: 320, markers: 6 },
  }),
  mission({
    id: "rl_courier",
    name: "Courier",
    kind: "escort",
    trackId: "rustline",
    laps: 4,
    brief: [
      "Bex is running a load through the Rustline and the Feed knows it.",
      "Keep her running. Keep close. She cannot fight.",
    ],
    objectives: [
      { kind: "escort_alive", slot: 0, minHullPct: 0.3 },
      { kind: "stay_near", slot: 0, metres: 120, graceSec: 8 },
      { kind: "finish_race" },
    ],
    modifiers: { heat: 0.6, protectSlot: 0, aggression: 0.3 },
    reward: { scrap: 380, markers: 7 },
    grid: [
      { name: "BEX (client)", classId: "bruiser", color: "#facc15" },
      { name: "Chrome Jackal" },
      { name: "Sand Widow" },
    ],
    beatAfter: "bex-run",
  }),

  /* ── Sable Mile ────────────────────────────────────────────────────── */
  mission({
    id: "sm_bluebird",
    name: "Bluebird",
    kind: "time_attack",
    trackId: "sable_run",
    laps: 3,
    brief: ["A mile and a half of committed geometry.", "Nothing to hit. No excuses either."],
    objectives: [{ kind: "race_pace", pace: 32 }],
    modifiers: { weaponsFree: false, catchUp: 0 },
    reward: { scrap: 240, markers: 4 },
  }),
  mission({
    id: "sm_topend",
    name: "Top End",
    kind: "race",
    trackId: "sable_run",
    laps: 3,
    brief: ["Full-course heat. Weapons live.", "The crest goes light above about eighty. Be ready for it."],
    objectives: [{ kind: "finish_place", place: 1 }],
    modifiers: { heat: 0.35 },
    reward: { scrap: 260, markers: 4 },
  }),
  mission({
    id: "sm_convoy",
    name: "Convoy",
    kind: "escort",
    trackId: "sable_run",
    laps: 3,
    brief: [
      "House cargo, House rules, House cut.",
      "Ptok's man drives the middle. Nothing touches him.",
    ],
    objectives: [
      { kind: "escort_alive", slot: 0, minHullPct: 0.45 },
      { kind: "finish_place", place: 2 },
    ],
    modifiers: { heat: 0.55, protectSlot: 0, aggression: 0.25 },
    reward: { scrap: 340, markers: 6 },
    grid: [
      { name: "HOUSE LOAD", classId: "bruiser", color: "#a78bfa" },
      { name: "Cinder Hook" },
      { name: "Null Spire" },
    ],
  }),
  mission({
    id: "sm_flyover",
    name: "Flyover",
    kind: "hunt",
    trackId: "sable_run",
    laps: 3,
    brief: ["Two wrecks and the flag, in that order.", "The Feed wants the crest shot. Give them the crest shot."],
    objectives: [
      { kind: "takedowns", count: 2 },
      { kind: "finish_place", place: 2 },
    ],
    modifiers: { heat: 0.45, aggression: 0.3 },
    reward: { scrap: 300, markers: 5 },
  }),

  /* ── The Dead Mile ─────────────────────────────────────────────────── */
  mission({
    id: "dm_longhaul",
    name: "Long Haul",
    kind: "race",
    trackId: "dead_mile",
    laps: 2,
    brief: ["Out along the pipeline, up the grade, around the tanks, home.", "Twice. Pace yourself; nobody wins this in the first kilometre."],
    objectives: [{ kind: "finish_place", place: 2 }],
    modifiers: { heat: 0.3 },
    reward: { scrap: 280, markers: 5 },
  }),
  mission({
    id: "dm_ironlung",
    name: "Iron Lung",
    kind: "race",
    trackId: "dead_mile",
    laps: 2,
    brief: ["Same road. No repairs, no respawn worth having.", "Come back with a car."],
    objectives: [
      { kind: "no_wreck" },
      { kind: "hull_above", pct: 0.2 },
      { kind: "finish_place", place: 2 },
    ],
    modifiers: { heat: 0.5, aggression: 0.25 },
    reward: { scrap: 360, markers: 6 },
  }),
  mission({
    id: "dm_pipeline",
    name: "Pipeline Work",
    kind: "hunt",
    trackId: "dead_mile",
    laps: 2,
    brief: ["Two of Marrow's outriders are running freight tonight.", "They will not be running it tomorrow."],
    objectives: [
      { kind: "wreck_target", slot: 0 },
      { kind: "wreck_target", slot: 1 },
      { kind: "finish_race" },
    ],
    modifiers: { heat: 0.7, aggression: 0.4 },
    reward: { scrap: 440, markers: 8 },
    grid: [
      { name: "OUTRIDER I", classId: "interceptor" },
      { name: "OUTRIDER II", classId: "bruiser" },
      { name: "Grind Petal" },
    ],
  }),
  mission({
    id: "dm_lastcall",
    name: "Last Call",
    kind: "elimination",
    trackId: "dead_mile",
    laps: 4,
    brief: [
      "Long road, short list. One car drops every forty seconds.",
      "The far turn is where they will try it.",
    ],
    objectives: [
      { kind: "last_standing" },
      { kind: "hull_above", pct: 0.15 },
    ],
    modifiers: {
      heat: 0.8,
      bountyOnPlayer: true,
      elimination: { everySec: 40, warnSec: 6 },
    },
    reward: { scrap: 520, markers: 9 },
  }),
];

export const MISSIONS_BY_ID: Record<string, MissionDef> = EVENT_MISSIONS.reduce<
  Record<string, MissionDef>
>((acc, m) => {
  acc[m.id] = m;
  return acc;
}, {});
