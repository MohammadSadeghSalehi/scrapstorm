/**
 * Event missions — the qualifying heats between Blacklist duels.
 *
 * Every one of these is data. If you find yourself wanting to add a field here
 * to express a new kind of goal, add an objective kind to types.ts and a case to
 * the interpreter instead; the moment a mission needs a bespoke branch
 * somewhere, the next forty missions will need forty more.
 *
 * On entry fees: they start at nothing and end at 180. The four events with no
 * fee at all (`pro_debut`, `as_sprint`, `cb_squeeze`, `cb_clean`) are load
 * bearing — they are what stops a run of bad luck from becoming a dead save,
 * because they are always available, always free to enter, and still pay on a
 * repeat clear. Do not put a fee on them.
 *
 * On pace targets: these are metres per second averaged over the distance, and
 * they have now had the stopwatch the first pass asked for. Driven headlessly
 * (scripts/mission-smoke.mjs --winrate), the pace a default-profile car actually
 * sustains per circuit is:
 *
 *   ash_spire 19-33   cinder_bowl 49-88   foundry_pit 35-50
 *   rustline  22-30   sable_run   46-59   dead_mile   36-57
 *
 * The originals were set at 35-45% of class top speed and were therefore not
 * targets at all — cb_clean asked for 20 m/s on a circuit that gives fifty, so
 * "one clean lap is all this asks" was satisfied by completing the lap. The
 * numbers below are set near the MEDIAN of what the road gives, which is the
 * only honest place for a time attack: reachable on a good lap, gone on a
 * scrappy one.
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
    entryFee: 40,
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
    entryFee: 120,
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
    // Marrow's qualifier. A field of hunters is the difference between two
    // minutes of hard racing and two minutes of being the only thing on the
    // circuit anybody is driving at.
    modifiers: {
      heat: 0.85,
      bountyOnPlayer: true,
      aggression: 0.4,
      fieldPattern: "hunter",
    },
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
    entryFee: 60,
    beatBefore: "cull-open",
    name: "Cull",
    kind: "elimination",
    trackId: "cinder_bowl",
    laps: 8,
    brief: [
      "Every twenty seconds the Feed cuts the last car.",
      "There is no finish line here. There is only being left.",
    ],
    objectives: [{ kind: "last_standing" }],
    // Blockers, on the circuit with one overtaking spot. A Cull is decided by
    // whether you can get past somebody before the next cut, and a field that
    // covers the inside is the only version of that which is a decision.
    modifiers: {
      heat: 0.45,
      elimination: { everySec: 22, warnSec: 5 },
      fieldPattern: "blocker",
    },
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
      // Both 26 and the 20 that replaced it were guesses, and the 20 was the
      // worse one: the Bowl is the fastest road in the league and a bot puts
      // 47-52 m/s of centreline pace through it under mission conditions, so a
      // target of 20 was cleared by finishing. 40 is roughly the median lap and
      // still leaves this a FREE event — it is one of the four that must always
      // be enterable, so it is the softest of the retuned targets on purpose.
      { kind: "lap_pace", pace: 40 },
      { kind: "no_wreck" },
    ],
    modifiers: { weaponsFree: false, catchUp: 0 },
    reward: { scrap: 180, markers: 3 },
  }),

  /* ── Foundry Pit ───────────────────────────────────────────────────── */
  mission({
    id: "fp_scrum",
    entryFee: 60,
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
    entryFee: 70,
    name: "Piecework",
    kind: "hunt",
    trackId: "foundry_pit",
    laps: 5,
    brief: ["Paid by the wreck tonight.", "Three of them. The bowls are wide; the chokes are not."],
    /*
     * Three wrecks over five Foundry laps cleared 100% of headless attempts,
     * because five laps is long enough that the field takes itself apart while
     * you wait. The clock makes it piecework again: ninety seconds is roughly
     * four laps of the Pit, so the last one has to be hunted rather than
     * collected.
     */
    objectives: [
      { kind: "takedowns", count: 3, bySec: 90 },
      { kind: "finish_race" },
    ],
    modifiers: { heat: 0.4, aggression: 0.3 },
    reward: { scrap: 280, markers: 5 },
  }),
  mission({
    id: "fp_holdout",
    entryFee: 110,
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
    modifiers: {
      heat: 0.75,
      bountyOnPlayer: true,
      aggression: 0.35,
      fieldPattern: "blocker",
    },
    reward: { scrap: 340, markers: 6 },
    beatAfter: "bex-bill",
  }),
  mission({
    id: "fp_kingpit",
    entryFee: 80,
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
    entryFee: 50,
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
    entryFee: 70,
    name: "Threadneedle",
    kind: "time_attack",
    trackId: "rustline",
    laps: 3,
    brief: ["One lap of the Gauntlet, under the number.", "Weapons cold. Nobody to blame."],
    objectives: [
      // 22 was inside the noise of simply getting round: this mission cleared
      // 100% of headless attempts. Measured, the bot's median best lap on the
      // Rustline is around 50 m/s and its worst nights are half that, so 38 is
      // set below the median and above the scrappy runs — a lap you have to
      // actually string together, on the narrowest road in the league.
      { kind: "lap_pace", pace: 38 },
      { kind: "hull_above", pct: 0.7 },
    ],
    modifiers: { weaponsFree: false, catchUp: 0 },
    reward: { scrap: 320, markers: 6 },
  }),
  mission({
    id: "rl_courier",
    entryFee: 100,
    beatBefore: "courier-open",
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
    entryFee: 50,
    name: "Bluebird",
    kind: "time_attack",
    trackId: "sable_run",
    laps: 3,
    brief: ["A mile and a half of committed geometry.", "Nothing to hit. No excuses either."],
    // Measured race pace on the Sable Mile is 36-47 m/s over three laps. 32 was
    // free; 42 asks for a tidy run and gives it back if the crest bites.
    objectives: [{ kind: "race_pace", pace: 42 }],
    modifiers: { weaponsFree: false, catchUp: 0 },
    reward: { scrap: 240, markers: 4 },
  }),
  mission({
    id: "sm_topend",
    entryFee: 60,
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
    entryFee: 100,
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
    beatBefore: "ptok-terms",
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
    entryFee: 80,
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
    entryFee: 80,
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
    entryFee: 110,
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
    entryFee: 140,
    name: "Pipeline Work",
    kind: "hunt",
    trackId: "dead_mile",
    laps: 2,
    /*
     * The catalogue's one wet event, and it is deliberately this one.
     *
     * Rain costs the whole field the same thing — measured, the corner limit
     * falls to 66% of dry and the stopping distance grows 12% for all three
     * classes alike (mission-smoke, weather section) — so it does not make a
     * mission harder so much as SLOWER and less precise. That is fatal to a
     * pace target and merely interesting to a hunt: this one asks for two
     * takedowns and a finish, none of which is on a clock, so the rain buys
     * atmosphere and a real change in how the road drives without moving a
     * threshold. Do not copy it onto anything holding a `lap_pace`.
     */
    weather: "wet",
    brief: [
      "Two of Marrow's outriders are running freight tonight.",
      "Rain on the pipeline. Nobody stops for it, nobody trusts it either.",
      "They will not be running it tomorrow.",
    ],
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
    entryFee: 180,
    beatBefore: "lastcall-open",
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
      fieldPattern: "hunter",
      fieldPaceFloor: 0.55,
    },
    reward: { scrap: 520, markers: 9 },
  }),

  /* ── the plan tier ──────────────────────────────────────────────────
   *
   * Four events that cannot be solved by being quick, added because the board
   * measured flat: the ladder was twenty-two variations on "finish ahead of
   * them" and "wreck some of them", and the only thing that changed as you
   * climbed was how good the other cars were. These four each ask a question
   * the rest of the catalogue never asks:
   *
   *   cb_glasswork  — win it without letting anyone touch you, on the circuit
   *                   with one overtaking spot and a field that covers it.
   *   as_holdline   — get to the front EARLY and then defend, which is the
   *                   opposite skill to everything the board has taught so far.
   *   fp_overtime   — three takedowns against a clock, so where you fight is a
   *                   decision made before the lights.
   *   dm_widowmaker — survive, but not by hiding at the back.
   *
   * Each is a qualifier for the rival whose lesson it is, at exactly that
   * rival's own marker threshold — never above it, or the board would gate a
   * rung behind an event the board says you cannot enter yet.
   */
  mission({
    id: "cb_glasswork",
    entryFee: 90,
    requiresMarkers: 40,
    beatBefore: "glasswork-open",
    name: "Glasswork",
    kind: "race",
    trackId: "cinder_bowl",
    laps: 4,
    brief: [
      "Win it, and bring the panels back on it.",
      "One overtaking spot, and three cars whose job is to be parked in it.",
    ],
    objectives: [
      { kind: "finish_place", place: 1 },
      // 60% was measured killing all three headless attempts while the bot was
      // winning the race on the road (mean finishing position 1.3). A hull floor
      // you cannot survive is not a constraint on how you win, it is a different
      // mission — 45% still forbids bulldozing the hairpin four times and leaves
      // a race in front of it.
      { kind: "hull_above", pct: 0.45 },
      { kind: "no_wreck", optional: true, label: "Not a mark on it" },
    ],
    modifiers: { heat: 0.5, aggression: 0.2, fieldPattern: "blocker" },
    reward: { scrap: 320, markers: 6 },
  }),
  mission({
    id: "as_holdline",
    entryFee: 140,
    requiresMarkers: 100,
    beatBefore: "holdline-open",
    name: "Hold the Line",
    kind: "survival",
    trackId: "ash_spire",
    // Ten laps of the Spire runs about 140 seconds, and seventy of those have to
    // be spent at the front. Seven laps was tried and measured at 98s — asking
    // for 71% of the whole race is not "hold a position", it is "win by a lap".
    laps: 10,
    brief: [
      "New format. Second or better, on the clock, while they are paid to remove you.",
      "Seventy seconds out front. The Feed does not care how you get there.",
    ],
    objectives: [
      // Seventy seconds of a race that runs three or four minutes: reachable
      // in one long stint or four short ones, which is the point — a player who
      // cannot hold it can still bank it in pieces and a player who can holds it
      // once and goes home.
      { kind: "hold_place", place: 2, seconds: 70 },
      { kind: "finish_race" },
      { kind: "hull_above", pct: 0.15 },
    ],
    /*
     * No bounty, and that is a measurement rather than a mercy.
     *
     * The first cut had heat 0.7, a live bounty AND a hunter field, and the
     * headless run died on the hull floor with 3% mean objective progress —
     * i.e. inside the first few seconds, every time. A hunter FIELD is already
     * "everyone is coming for you"; stacking the bounty on top of it is the
     * same instruction twice and the sum is not a hard mission, it is a
     * cutscene of your car being taken apart. The pattern is the lever here,
     * so the pattern is the only one pulled.
     */
    modifiers: {
      heat: 0.55,
      aggression: 0.25,
      fieldPattern: "hunter",
      catchUp: 1.25,
    },
    reward: { scrap: 460, markers: 8 },
  }),
  mission({
    id: "fp_overtime",
    entryFee: 160,
    requiresMarkers: 122,
    beatBefore: "overtime-open",
    name: "Overtime",
    kind: "hunt",
    trackId: "foundry_pit",
    /*
     * Eight, so the flag falls well after the hundred-second deadline — a race
     * that ends first would make the deadline decorative and the mission a
     * straight three-takedown hunt.
     *
     * The margin is much larger than it was thought to be. This said "a Foundry
     * lap runs 13-18 seconds, so six laps end at around ninety", which came from
     * the same truncating cold control that mis-sized dm_widowmaker; the real
     * pace is 26s a lap and eight laps is a 207-second race. Eight still stands
     * — the deadline bites at about the halfway point, which is where a purse
     * closing early is supposed to bite — but it stands on a measurement now
     * rather than on that arithmetic.
     */
    laps: 8,
    brief: [
      "Three wrecks, and the purse closes at a hundred seconds.",
      "The Pit has two chokes. Decide which one you are doing this in.",
    ],
    objectives: [
      { kind: "takedowns", count: 3, bySec: 100 },
      // 25% was measured ending every headless run before the first takedown.
      // A hull floor in a mission that requires ramming has to sit below what
      // three fights cost, or the two objectives are simply contradictory.
      { kind: "hull_above", pct: 0.15 },
      { kind: "finish_race" },
    ],
    modifiers: {
      heat: 0.55,
      aggression: 0.3,
      fieldPattern: "blocker",
      fieldPaceFloor: 0.5,
    },
    reward: { scrap: 500, markers: 8 },
  }),
  mission({
    id: "dm_widowmaker",
    entryFee: 200,
    requiresMarkers: 175,
    beatBefore: "widowmaker-open",
    name: "Widowmaker",
    kind: "survival",
    trackId: "dead_mile",
    /*
     * Four laps for a hundred-and-fifty-second clock.
     *
     * This was eight, and eight came from a measurement the harness was not
     * able to make. The first cut had three: a Dead Mile lap was believed to be
     * 30-48 seconds, so three laps put the flag out around 110 and the survival
     * timer could NEVER land — unwinnable by arithmetic rather than by
     * difficulty, and it read as merely hard until the harness printed a zero.
     * Six then "measured at 153s", clearing 150 by three seconds, which felt too
     * close to trust, so eight.
     *
     * Every one of those numbers came from a control that stopped 2.6 seconds
     * after the MISSION resolved rather than when the distance was driven, so it
     * was reporting how long this mission survives, not how long its laps take.
     * With that fixed the real figure is 51.8s a lap — eight laps is a
     * 414-second race, near seven minutes, for a mission whose longest clock is
     * 150. Four puts the flag at ~207s: the survival timer lands with fifty
     * seconds in hand instead of three, the sixty-second position hold fits
     * inside 0.7 of the race, and the thing is a survival mission rather than an
     * endurance one. See the cold-control note in scripts/mission-smoke.mjs.
     */
    laps: 4,
    brief: [
      "Two and a half minutes on the pipeline with a live bounty.",
      "And you do not get to do it from the back. Top three, a minute of it, total.",
    ],
    objectives: [
      { kind: "survive_time", seconds: 150 },
      /*
       * The clause that makes this different from every other survival mission
       * in the catalogue. Survival has always been solvable by dropping to last
       * and driving carefully; a position requirement means the safest place on
       * the circuit is also the losing one, and the whole run becomes a
       * negotiation between the two.
       */
      { kind: "hold_place", place: 3, seconds: 60 },
      { kind: "hull_above", pct: 0.15 },
    ],
    // The bounty stays — it is the mission's whole premise — so the field
    // pattern goes. Both together measured as a wreck inside the first stint.
    modifiers: {
      heat: 0.8,
      aggression: 0.35,
      bountyOnPlayer: true,
      fieldPaceFloor: 0.58,
    },
    reward: { scrap: 620, markers: 10 },
  }),
];

export const MISSIONS_BY_ID: Record<string, MissionDef> = EVENT_MISSIONS.reduce<
  Record<string, MissionDef>
>((acc, m) => {
  acc[m.id] = m;
  return acc;
}, {});
