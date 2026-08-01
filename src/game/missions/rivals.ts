/**
 * The Scrapline — this game's Blacklist.
 *
 * Fifteen names on a board, rank 15 at the bottom and Marrow at the top. You do
 * not get to challenge the next one by asking: you need MARKERS, which are paid
 * out by events and takedowns, and you need to have run the qualifying events on
 * their circuit. That is the Most Wanted loop — milestones gate the rival, the
 * rival is the reward — with the pursuit replaced by League Heat, because the
 * thing chasing you here is the rest of the field.
 *
 * Every rival carries a driving profile, not just a name and a portrait. The
 * profile is pushed into ai.ts by armMission, so "Ferrite brakes far too late"
 * is a thing you can feel rather than a line in a bio. Keep them distinct: two
 * rivals with the same numbers are one rival with two names.
 *
 * THE DIFFICULTY LADDER lives in those profiles, and it is deliberately not a
 * straight line:
 *
 *  - `pace` rises with rank, but not monotonically. Sparrow at 11 is faster
 *    than Kiln at 10 and Glassjaw at 9; she is also completely harmless. A
 *    board where every step is strictly harder in every way is a slider with
 *    names on it, and the player stops reading the bios by rank 12.
 *  - `pattern` is introduced cheap and revisited expensive. Wask at 15 is a
 *    blocker you can barely feel; Ilo at 4 is the same idea with a bruiser,
 *    maximum aggression and the Foundry's chokes to do it in. By the time a
 *    pattern is genuinely dangerous you have already been taught the answer.
 *  - `mistake` falls as you climb, which is the real reason the top of the
 *    board is hard: down here you win on their errors, up there you have to
 *    manufacture your own openings.
 */
import { DEFAULT_MODIFIERS, type MissionDef, type RivalDef } from "./types";

/** Heat climbs with rank; the top of the board is a manhunt. */
function heatForRank(rank: number): number {
  return Math.min(1, (16 - rank) / 16);
}

export const RIVALS: RivalDef[] = [
  {
    id: "wask",
    rank: 15,
    name: "GRIT",
    realName: "Tanner Wask",
    crew: "Sump Rats",
    classId: "bruiser",
    // Ash Spire, not the Foundry: rank 15 unlocks at zero markers and the
    // Foundry does not open until six. A duel on a circuit the board says you
    // cannot reach yet is the ladder contradicting itself on its first rung.
    homeTrack: "ash_spire",
    profile: {
      aggression: 0.55, precision: 0.3, patience: 0.6, ultBias: 0.3, hunt: 0.2,
      pace: 0.16, mistake: 0.7, nerve: 0.45, pattern: "blocker",
    },
    bio: "Runs the bottom of the board like a doorman. Everyone starts here.",
    taunt: "New paint. Won't last.",
    beaten: "Board's yours to climb. Don't thank me.",
    unlock: { markers: 0, events: ["pro_debut"] },
    duel: {
      laps: 4,
      kind: "race",
      objectives: [{ kind: "finish_place", place: 1 }],
      modifiers: { heat: heatForRank(15) },
      brief: ["Wask holds fifteen and he holds it cheap.", "Beat him and the board admits you exist."],
    },
    reward: { scrap: 180, markers: 2, title: "Ranked", pinkSlip: "a crate of Wask's spare plate" },
    beatAfter: "beat-first-rung",
  },
  {
    id: "nim",
    rank: 14,
    name: "HALFPIPE",
    realName: "Osa Nim",
    crew: "Sump Rats",
    classId: "trickster",
    homeTrack: "cinder_bowl",
    profile: {
      aggression: 0.4, precision: 0.6, patience: 0.35, ultBias: 0.7, hunt: 0.2,
      pace: 0.24, mistake: 0.62, nerve: 0.4, pattern: "racer",
    },
    bio: "Drops mines into corners she has already left. Wins on other people's panic.",
    taunt: "Watch the exit. Not the entry. The exit.",
    beaten: "Fine. Fine! You looked where I told you not to.",
    unlock: { markers: 4, events: ["cb_squeeze"] },
    duel: {
      laps: 4,
      kind: "race",
      objectives: [
        { kind: "finish_place", place: 1 },
        { kind: "no_wreck", optional: true },
      ],
      modifiers: { heat: heatForRank(14) },
      brief: ["Nim's whole game is the corner after the corner.", "Mines. Everywhere. Do not follow her line."],
    },
    reward: { scrap: 220, markers: 3, title: "Bowl Runner", pinkSlip: "her spare mine rack" },
  },
  {
    id: "vance",
    rank: 13,
    name: "TALLY",
    realName: "Odo Vance",
    crew: "Feed Regulars",
    classId: "interceptor",
    homeTrack: "ash_spire",
    profile: {
      aggression: 0.7, precision: 0.5, patience: 0.5, ultBias: 0.5, hunt: 0.6,
      pace: 0.3, mistake: 0.6, nerve: 0.55, pattern: "hunter",
    },
    bio: "Counts his takedowns on air. Has never once counted his losses.",
    taunt: "Number forty-one, coming up.",
    beaten: "Off by one. I'll fix the tally.",
    unlock: { markers: 9, events: ["as_bounty"] },
    duel: {
      laps: 3,
      kind: "hunt",
      objectives: [
        { kind: "wreck_target", slot: 0 },
        { kind: "finish_place", place: 2 },
      ],
      modifiers: { heat: heatForRank(13), aggression: 0.2 },
      brief: ["Vance wants you on the highlight reel.", "Put him on it instead. Then finish."],
    },
    reward: { scrap: 260, markers: 3, title: "Counted", pinkSlip: "his bolt cannon tuning" },
  },
  {
    id: "sook",
    rank: 12,
    name: "FERRITE",
    realName: "Bel Sook",
    crew: "Rustline Local",
    classId: "bruiser",
    homeTrack: "rustline",
    profile: {
      aggression: 0.75, precision: 0.35, patience: 0.15, ultBias: 0.4, hunt: 0.35,
      pace: 0.34, mistake: 0.78, nerve: 0.6, pattern: "racer",
    },
    bio: "Brakes so late she has been through the chicane barrier twice this season.",
    taunt: "I don't lift. Ask the barrier.",
    beaten: "Should've lifted.",
    unlock: { markers: 15, events: ["rl_scrapline"] },
    duel: {
      laps: 4,
      kind: "race",
      objectives: [{ kind: "finish_place", place: 1 }, { kind: "hull_above", pct: 0.25 }],
      modifiers: { heat: heatForRank(12) },
      brief: ["Sook overdrives every apex on the Rustline.", "Let her. Be there on the exit."],
    },
    reward: { scrap: 300, markers: 4, title: "Chicane Cutter", pinkSlip: "a Rustline pit key" },
  },
  {
    id: "ait",
    rank: 11,
    name: "SPARROW",
    realName: "Iven Ait",
    crew: "Long Sable",
    classId: "interceptor",
    homeTrack: "sable_run",
    profile: {
      aggression: 0.4, precision: 0.85, patience: 0.8, ultBias: 0.4, hunt: 0.2,
      pace: 0.55, mistake: 0.05, nerve: 0.6, pattern: "pacer",
    },
    bio: "Never touches anyone. Never needs to. Cleanest line in the league.",
    taunt: "I'll be where you were.",
    beaten: "You were quicker. That is all it was.",
    unlock: { markers: 22, events: ["sm_bluebird"] },
    duel: {
      laps: 3,
      kind: "time_attack",
            objectives: [{ kind: "race_pace", pace: 34 }, { kind: "finish_place", place: 2 }],
      modifiers: { heat: heatForRank(11), catchUp: 0, weaponsFree: false },
      brief: ["Sparrow does not fight. Sparrow drives.", "Weapons cold. This one is on the clock."],
    },
    reward: { scrap: 340, markers: 4, title: "Clean Hands", pinkSlip: "his telemetry" },
    beatAfterWrecked: "wrecked-sparrow",
  },
  {
    id: "marsh",
    rank: 10,
    name: "KILN",
    realName: "Doru Marsh",
    crew: "Foundry Set",
    classId: "bruiser",
    homeTrack: "foundry_pit",
    profile: {
      aggression: 0.9, precision: 0.4, patience: 0.55, ultBias: 0.6, hunt: 0.7,
      pace: 0.36, mistake: 0.5, nerve: 0.7, pattern: "blocker",
    },
    bio: "Parks in the choke and charges whatever arrives. It works more than it should.",
    taunt: "Gap's mine. Come take it.",
    beaten: "Nobody's ever come through there before.",
    unlock: { markers: 30, events: ["fp_scrum", "fp_takedown"] },
    duel: {
      laps: 5,
      kind: "duel",
      objectives: [{ kind: "wreck_target", slot: 0, count: 2 }],
      modifiers: { heat: heatForRank(10), aggression: 0.25 },
      brief: ["Marsh owns the west choke and he knows it.", "Twice. Put him down twice."],
    },
    reward: { scrap: 380, markers: 5, title: "Pitbreaker", pinkSlip: "the Foundry gate code" },
    beatAfter: "beat-kiln",
    beatAfterWrecked: "wrecked-kiln",
  },
  {
    id: "novo",
    rank: 9,
    name: "GLASSJAW",
    realName: "Ilza Novo",
    crew: "Feed Regulars",
    classId: "trickster",
    homeTrack: "cinder_bowl",
    profile: {
      aggression: 0.6, precision: 0.75, patience: 0.4, ultBias: 0.8, hunt: 0.4,
      pace: 0.52, mistake: 0.35, nerve: 0.2, pattern: "racer",
    },
    bio: "Fastest hands on the board, least hull. Decides races in one corner.",
    taunt: "One mistake each. I'm not making mine.",
    beaten: "Glass. Told you.",
    unlock: { markers: 40, events: ["cb_elim"] },
    duel: {
      laps: 4,
      kind: "duel",
      objectives: [{ kind: "beat_rival", slot: 0 }, { kind: "finish_place", place: 2 }],
      modifiers: { heat: heatForRank(9) },
      brief: ["Novo hits hard and folds harder.", "Survive her first two laps and she is yours."],
    },
    reward: { scrap: 420, markers: 5, title: "Second Corner", pinkSlip: "her decoy emitter" },
  },
  {
    id: "reyes",
    rank: 8,
    name: "CATHODE",
    realName: "Sim Reyes",
    crew: "Long Sable",
    classId: "interceptor",
    homeTrack: "sable_run",
    profile: {
      aggression: 0.65, precision: 0.8, patience: 0.7, ultBias: 0.6, hunt: 0.5,
      pace: 0.5, mistake: 0.3, nerve: 0.6, pattern: "hunter",
    },
    bio: "Holds a lock from further out than anyone thinks is legal. It is legal.",
    taunt: "You're already in frame.",
    beaten: "Lost the lock. Lost the rest.",
    unlock: { markers: 52, events: ["sm_topend", "sm_flyover"] },
    duel: {
      laps: 3,
      kind: "race",
      objectives: [{ kind: "finish_place", place: 1 }, { kind: "hull_above", pct: 0.3 }],
      modifiers: { heat: heatForRank(8), bountyOnPlayer: true },
      brief: ["Reyes has the Feed's bounty on you tonight.", "The whole field is paid to look your way."],
    },
    reward: { scrap: 460, markers: 6, title: "Marked", pinkSlip: "his long-lock array" },
    beatAfter: "beat-bounty",
  },
  {
    id: "ogun",
    rank: 7,
    name: "BELLOWS",
    realName: "Ade Ogun",
    crew: "Pipeline Haulers",
    classId: "bruiser",
    homeTrack: "dead_mile",
    profile: {
      aggression: 0.5, precision: 0.7, patience: 0.9, ultBias: 0.3, hunt: 0.3,
      pace: 0.48, mistake: 0.03, nerve: 0.95, pattern: "racer",
    },
    bio: "Never quick. Never gone. Has finished every Dead Mile ever run.",
    taunt: "It's a long road. You'll see.",
    beaten: "Long road. You lasted it.",
    unlock: { markers: 66, events: ["dm_longhaul", "dm_ironlung"] },
    duel: {
      laps: 2,
      kind: "race",
      objectives: [{ kind: "finish_place", place: 1 }, { kind: "no_wreck" }],
      modifiers: { heat: heatForRank(7) },
      brief: ["Two laps of the Dead Mile, and Ogun does not make mistakes.", "One wreck and it is over. Drive it home."],
    },
    reward: { scrap: 520, markers: 6, title: "Ironlung", pinkSlip: "a full hull rebuild" },
  },
  {
    id: "vey",
    rank: 6,
    name: "HALCYON",
    realName: "Halcyon Vey",
    crew: "Ex-Marrow",
    classId: "trickster",
    homeTrack: "rustline",
    profile: {
      aggression: 0.45, precision: 0.9, patience: 0.6, ultBias: 0.5, hunt: 0.15,
      pace: 0.7, mistake: 0.08, nerve: 0.7, pattern: "pacer",
    },
    bio: "Drove for Marrow until the night they took your car. Has not spoken to him since.",
    taunt: "I'm not going to make this easy. I am going to make it fair.",
    beaten: "Good. Now you're worth talking to.",
    unlock: { markers: 82, events: ["rl_threadneedle"] },
    duel: {
      laps: 4,
      kind: "race",
      objectives: [{ kind: "finish_place", place: 1 }],
      modifiers: { heat: heatForRank(6), weaponsFree: false, catchUp: 0.4 },
      brief: ["Vey has called weapons cold. She means it.", "She was in the car behind you the night of the stack. Win it clean."],
    },
    reward: { scrap: 580, markers: 7, title: "Witness", pinkSlip: "what she saw" },
    beatAfter: "outraced-vey",
    beatAfterWrecked: "wrecked-vey",
  },
  {
    id: "ptok",
    rank: 5,
    name: "SABLE",
    realName: "Yona Ptok",
    crew: "The House",
    classId: "interceptor",
    homeTrack: "sable_run",
    profile: {
      aggression: 0.7, precision: 0.85, patience: 0.75, ultBias: 0.7, hunt: 0.55,
      pace: 0.62, mistake: 0.25, nerve: 0.65, pattern: "hunter",
    },
    bio: "Sold you your first three heats. Takes a cut of everything, including this.",
    taunt: "Business. You understand.",
    beaten: "Costly. For me.",
    unlock: { markers: 100, events: ["sm_convoy"] },
    duel: {
      laps: 3,
      kind: "race",
      objectives: [{ kind: "finish_place", place: 1 }, { kind: "takedowns", count: 1, optional: true }],
      modifiers: { heat: heatForRank(5), bountyOnPlayer: true, aggression: 0.15 },
      brief: ["The fixer races too. Everyone forgets that.", "He has already sold your position to the other three."],
    },
    reward: { scrap: 640, markers: 7, title: "Unbought", pinkSlip: "his book of debts" },
  },
  {
    id: "ilo",
    rank: 4,
    name: "ORGAN GRINDER",
    realName: "Wren Ilo",
    crew: "Foundry Set",
    classId: "bruiser",
    homeTrack: "foundry_pit",
    profile: {
      aggression: 1, precision: 0.55, patience: 0.5, ultBias: 0.85, hunt: 0.85,
      pace: 0.55, mistake: 0.3, nerve: 0.85, pattern: "blocker",
    },
    bio: "Does not race. Processes. The Foundry is where the board sends people to stop.",
    taunt: "In you go.",
    beaten: "Out again. Rare.",
    unlock: { markers: 122, events: ["fp_holdout", "fp_kingpit"] },
    duel: {
      laps: 6,
      kind: "survival",
      objectives: [
        { kind: "survive_time", seconds: 150 },
        { kind: "no_wreck" },
        { kind: "takedowns", count: 2, optional: true },
      ],
      modifiers: { heat: heatForRank(4), bountyOnPlayer: true, aggression: 0.35 },
      brief: ["Two and a half minutes in the Pit with all of it pointed at you.", "Ilo does not need to beat you. He needs you to stop."],
    },
    reward: { scrap: 720, markers: 8, title: "Unprocessed", pinkSlip: "the Pit itself" },
    beatAfter: "beat-grinder",
  },
  {
    id: "kade",
    rank: 3,
    name: "SUMP",
    realName: "Ren Kade",
    crew: "Marrow's Crew",
    classId: "trickster",
    homeTrack: "rustline",
    profile: {
      aggression: 0.85, precision: 0.7, patience: 0.3, ultBias: 0.9, hunt: 0.9,
      pace: 0.72, mistake: 0.2, nerve: 0.5, pattern: "hunter",
    },
    bio: "Marrow's outrider. Was on your inside at the flare stack. Was smiling.",
    taunt: "You remember the stack. I remember the stack.",
    beaten: "He'll just send the next one.",
    unlock: { markers: 148, events: ["rl_courier"] },
    duel: {
      laps: 4,
      kind: "duel",
      objectives: [{ kind: "wreck_target", slot: 0 }, { kind: "finish_place", place: 1 }],
      modifiers: { heat: heatForRank(3), bountyOnPlayer: true, aggression: 0.4 },
      brief: ["Kade put you in the stack. Kade is on the Rustline tonight.", "Wreck him. Then win it anyway."],
    },
    reward: { scrap: 820, markers: 9, title: "Even", pinkSlip: "his half of the story" },
    beatBefore: "duel-kade",
    beatAfter: "outraced-kade",
    beatAfterWrecked: "wrecked-kade",
  },
  {
    id: "rhee",
    rank: 2,
    name: "PALLBEARER",
    realName: "Sena Rhee",
    crew: "Marrow's Crew",
    classId: "bruiser",
    homeTrack: "dead_mile",
    profile: {
      aggression: 0.95, precision: 0.8, patience: 0.85, ultBias: 0.7, hunt: 0.95,
      pace: 0.78, mistake: 0.1, nerve: 1, pattern: "hunter",
    },
    bio: "The last car anyone sees. Runs the Dead Mile because it gives her time to work.",
    taunt: "Nobody gets past me twice.",
    beaten: "Then go and take it back.",
    unlock: { markers: 180, events: ["dm_pipeline", "dm_lastcall"] },
    duel: {
      laps: 2,
      kind: "duel",
      objectives: [
        { kind: "beat_rival", slot: 0 },
        { kind: "finish_place", place: 1 },
        { kind: "hull_above", pct: 0.15 },
      ],
      modifiers: { heat: heatForRank(2), bountyOnPlayer: true, aggression: 0.5, catchUp: 0.5 },
      brief: ["Rhee has three and a half kilometres to take you apart.", "Do not give her the long straight."],
    },
    reward: { scrap: 960, markers: 10, title: "Number Two", pinkSlip: "the road to Marrow" },
    beatBefore: "duel-rhee",
    beatAfter: "quist-offer",
  },
  {
    id: "marrow",
    rank: 1,
    name: "MARROW",
    realName: "Dain Marrow",
    crew: "Marrow's Crew",
    classId: "interceptor",
    homeTrack: "ash_spire",
    profile: {
      aggression: 0.9, precision: 1, patience: 0.9, ultBias: 0.8, hunt: 1,
      pace: 0.9, mistake: 0.05, nerve: 0.9, pattern: "duelist",
    },
    bio: "Champion of the Scrapline. Drives your car. Has done for a year and a half.",
    taunt: "It runs better for me.",
    beaten: "It was never mine. Take it.",
    unlock: { markers: 220, events: ["as_gauntlet"] },
    duel: {
      laps: 5,
      kind: "duel",
      objectives: [
        { kind: "finish_place", place: 1 },
        { kind: "beat_rival", slot: 0 },
        { kind: "wreck_target", slot: 0, optional: true },
      ],
      modifiers: { heat: 1, bountyOnPlayer: true, aggression: 0.6, catchUp: 0.35 },
      brief: [
        "Ash Spire. Same corner. Same stack. Same car — his side of it.",
        "The whole board is watching and every one of them is paid to stop you.",
      ],
    },
    reward: {
      scrap: 1800,
      markers: 20,
      title: "The Ardent",
      pinkSlip: "your car",
    },
    beatBefore: "duel-marrow",
    beatAfter: "final",
    beatAfterWrecked: "wrecked-marrow",
  },
];

export const RIVALS_BY_RANK = [...RIVALS].sort((a, b) => b.rank - a.rank);

export function rivalById(id: string): RivalDef | undefined {
  return RIVALS.find((r) => r.id === id);
}

/**
 * Build the duel mission for a rival.
 *
 * Generated rather than hand-written fifteen times: a duel is always "this
 * rival, on their circuit, at their heat, plus the objectives they specify", and
 * fifteen near-identical literals would have drifted apart within a week. The
 * rival is always grid slot 0, which is what every `slot: 0` in the duel
 * objectives above refers to.
 */
export function duelMission(rival: RivalDef): MissionDef {
  const support = RIVALS_BY_RANK.filter(
    (r) => r.id !== rival.id && r.rank > rival.rank,
  ).slice(-2);
  return {
    id: `duel_${rival.id}`,
    name: `#${rival.rank} ${rival.name}`,
    kind: rival.duel.kind,
    trackId: rival.homeTrack,
    laps: rival.duel.laps,
    brief: rival.duel.brief,
    objectives: rival.duel.objectives,
    modifiers: { ...DEFAULT_MODIFIERS, ...rival.duel.modifiers },
    reward: {
      scrap: rival.reward.scrap,
      markers: rival.reward.markers,
      unlockTrack: rival.reward.unlockTrack,
    },
    grid: [
      {
        name: rival.name,
        classId: rival.classId,
        rivalId: rival.id,
        profile: rival.profile,
      },
      // Two lower-ranked names as the supporting cast, so a duel still looks
      // like a heat rather than a one-on-one in an empty desert.
      ...support.map((r) => ({
        name: r.name,
        classId: r.classId,
        rivalId: r.id,
        profile: r.profile,
      })),
    ],
    rivalId: rival.id,
    beatBefore: rival.beatBefore,
    beatAfter: rival.beatAfter,
    beatAfterWrecked: rival.beatAfterWrecked,
    // A fifth of the purse, staked. Derived rather than authored so a rival
    // whose reward is retuned cannot end up with a stake worth more than the
    // race is — the exact failure that makes a wager feel like a punishment.
    entryFee: Math.round(rival.reward.scrap * 0.2),
    requiresMarkers: rival.unlock.markers,
  };
}

export const DUEL_MISSIONS: MissionDef[] = RIVALS_BY_RANK.map(duelMission);
