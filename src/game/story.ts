/**
 * Scrapstorm League — world, cast and beats.
 *
 * Terse on purpose. The story that works in a game like this is the one you get
 * in fifteen seconds on a loading screen and four words over the radio at
 * 200mph; anything longer is a cutscene nobody watches twice. Every beat below
 * is at most three short lines plus a flavour sting, and every bark is under ten
 * words because it has to be readable while you are being rammed.
 *
 * Beats are keyed to PROGRESSION, not to a linear script — missions/career.ts
 * fires them by id when the condition that earns them happens. That way the
 * story tracks what the player actually did rather than a chapter counter.
 */

export type StoryBeat = {
  id: string;
  title: string;
  body: string;
  flavor?: string;
  /** Who is on the radio. Undefined = the Feed's commentary. */
  voice?: string;
  /** Roughly where in the climb this lands, for ordering a recap screen. */
  act?: 1 | 2 | 3;
};

export const WORLD = {
  league: "Scrapstorm League",
  circuit: "Ash Spire Circuit",
  era: "Year 47 After the Last Pipeline",
  tagline: "Drift. Draft. Dent the legend.",
  /** The broadcast that owns the league, and therefore owns the sport. */
  network: "The Spire Feed",
  /** The board you climb. Fifteen names. */
  board: "the Scrapline",
} as const;

export const CAST = {
  player: {
    name: "You",
    was: "A Scrapline runner one corner from a rank.",
  },
  marrow: {
    name: "MARROW",
    real: "Dain Marrow",
    role: "Champion, rank 1",
    line: "Drives your car. Has done for eighteen months.",
  },
  bex: {
    name: "BEX",
    real: "Bex Otoro",
    role: "Crew chief",
    line: "Rebuilt you a car out of two dead ones and a grudge.",
  },
  quist: {
    name: "QUIST",
    real: "Ivo Quist",
    role: "Feed producer",
    line: "Decides who the audience is allowed to like.",
  },
  vey: {
    name: "HALCYON",
    real: "Halcyon Vey",
    role: "Rank 6",
    line: "Drove for Marrow the night of the stack. Has not driven for him since.",
  },
} as const;

/**
 * Menu lore. LORE[0] is rendered on the front screen, so it carries the whole
 * premise on its own — treat it as the logline and keep it two sentences.
 */
export const LORE: StoryBeat[] = [
  {
    id: "cold-open",
    title: "Eighteen months ago",
    body: "Marrow put you into the flare stack on the last lap and the league called your wreck salvage. He has been driving your car ever since.",
    flavor: "The Feed cut to an advert before you stopped rolling.",
    act: 1,
  },
  {
    id: "premise",
    title: "The Scrapline",
    body: "Fifteen names on a board. Beat one and you take their number. Marrow holds one.",
    flavor: "Nobody has taken a rank off him in two seasons.",
    act: 1,
  },
  {
    id: "interceptor",
    title: "Interceptor — Glass Ghost",
    body: "Built from a hot-rod spine and stolen thrusters. Soft-locks prey, then disappears into dust.",
    flavor: "If you can see the bolts, you're already losing paint.",
  },
  {
    id: "bruiser",
    title: "Bruiser — Sand King",
    body: "Expedition hauler with a scrap cannon bolted to the ribs. Owns the dunes. Hates corners that think they're clever.",
    flavor: "Mass is a strategy.",
  },
  {
    id: "trickster",
    title: "Trickster — False Road",
    body: "Cyber-hatch drift frame. Best mini-turbos in the league. Leaves mines where your confidence used to be.",
    flavor: "The line is a suggestion.",
  },
  {
    id: "rules",
    title: "House rules",
    body: "Hold the slide to charge turbo. Ram fills ultimate. Offroad eats speed. Finish with metal left.",
    flavor: "Cameras love a near-miss.",
  },
];

/**
 * Progression beats, fired by career.applyMissionResult.
 *
 * The arc is Most Wanted's, because Most Wanted's works: you are wronged in the
 * first thirty seconds, you climb, the people at the top notice you climbing and
 * try to buy you, and the last race is the first race again with the roles
 * swapped. What is ours is the shape of the threat — the escalation is not a
 * police force arriving, it is the field being paid to stop racing and come for
 * you.
 */
export const STORY_BEATS: StoryBeat[] = [
  {
    id: "first-heat",
    title: "Borrowed metal",
    voice: "BEX",
    body: "It's not your car. It's not anyone's car. Bring it back and I'll make it worse.",
    flavor: "Rank 16 of 15. They had to add a line to the board.",
    act: 1,
  },
  {
    id: "beat-first-rung",
    title: "On the board",
    voice: "QUIST",
    body: "There you are. The audience likes a climb. Keep climbing, I'll keep the cameras on you.",
    flavor: "He says it like it is a gift. It is a leash.",
    act: 1,
  },
  {
    id: "bex-run",
    title: "The load",
    voice: "BEX",
    body: "That freight was parts. Your parts. Now stop looking at me like that and go and win something.",
    act: 1,
  },
  {
    id: "beat-kiln",
    title: "Heat",
    voice: "BEX",
    body: "Feed's put a standing price on your hull. Every crew on the board can see it.",
    flavor: "You are no longer racing them. They are hunting you.",
    act: 2,
  },
  {
    id: "beat-bounty",
    title: "Paid attention",
    body: "Three cars came off the grid tonight pointed at you and nobody was even pretending otherwise.",
    flavor: "Ratings are up.",
    act: 2,
  },
  {
    id: "gauntlet-run",
    title: "Two minutes",
    voice: "QUIST",
    body: "Do you know what that was worth? Nobody survives the Gauntlet in a rebuild. Nobody sensible.",
    act: 2,
  },
  {
    id: "vey-turns",
    title: "The witness",
    voice: "HALCYON",
    body: "I was on your outside at the stack. Marrow didn't lose control. He counted to three and turned in.",
    flavor: "She has been carrying that for eighteen months.",
    act: 2,
  },
  {
    id: "beat-grinder",
    title: "Out of the Pit",
    voice: "BEX",
    body: "Nobody comes out of the Foundry. You came out of the Foundry. Sit down, you're bleeding.",
    act: 2,
  },
  {
    id: "kade-confesses",
    title: "Half the story",
    voice: "SUMP",
    body: "It wasn't Marrow's idea. It was never Marrow's idea. Ask who sells the highlight package.",
    flavor: "He is looking at the camera when he says it.",
    act: 3,
  },
  {
    id: "quist-offer",
    title: "The offer",
    voice: "QUIST",
    body: "Take rank two. Stay there. I'll pay you champion money to keep the story going another season.",
    flavor: "He paid Marrow the same, the night of the stack.",
    act: 3,
  },
  {
    id: "final",
    title: "Same corner",
    voice: "MARROW",
    body: "Eighteen months I kept it warm for you. Go on then. Take it off me on air.",
    flavor: "The Feed did not cut to an advert this time.",
    act: 3,
  },
];

export const BEATS_BY_ID: Record<string, StoryBeat> = [...LORE, ...STORY_BEATS].reduce<
  Record<string, StoryBeat>
>((acc, b) => {
  acc[b.id] = b;
  return acc;
}, {});

export function beat(id: string): StoryBeat | undefined {
  return BEATS_BY_ID[id];
}

export const RACE_BRIEFINGS: Record<string, string[]> = {
  ash_spire: [
    "Ash Spire: reclaimed refinery loop. Apron is mean, sand is meaner.",
    "First corner is a meat grinder — don't overcook the entry.",
    "Draft the leader, then break their line with a ram.",
  ],
  cinder_bowl: [
    "Cinder Bowl: one real overtaking spot and everyone knows where it is.",
    "The hairpin rewards patience. Nobody here has any.",
  ],
  foundry_pit: [
    "Foundry Pit: two bowls, two chokes, six hundred metres of nowhere to hide.",
    "Whoever holds the west choke holds the race.",
  ],
  rustline: [
    "Rustline: eighteen metres wide in places. Bring it back with mirrors.",
    "Slalom at the top is a walking-pace corner pretending to be three.",
    "The conveyor launches whether you were ready or not.",
  ],
  sable_run: [
    "Sable Mile: nothing tighter than fourth. Commit or get out of the way.",
    "The crest goes light near top end. Land it straight.",
  ],
  dead_mile: [
    "Dead Mile: out along the pipeline, up the grade, round the tanks, home.",
    "Six metres of climb. Everything comes back downhill faster than you left it.",
    "Nobody wins this in the first kilometre. Plenty lose it there.",
  ],
  default: [
    "Heat is live. Make them remember your paint.",
    "Drift charges turbo. Turbo wins corners.",
    "Weapons free after green.",
  ],
};

/**
 * In-motion radio.
 *
 * This is where most of the story actually gets delivered — a beat between
 * races is read once, a bark during a race is heard every time it fires. Keep
 * every line short enough to parse at speed and neutral enough to survive being
 * heard fifty times.
 */
export const EVENT_LINES = {
  lap: [
    "Sector clean — keep the rubber hot.",
    "Lap banked. Don't gift the pack a slipstream.",
    "Clock's watching. Push the line.",
  ],
  hit: ["Paint traded.", "They felt that.", "Chassis complains. Keep going."],
  boost: ["Turbo lit.", "Overdrive — hold the wheel.", "Purple meter. Eat the straight."],
  finish_win: ["P1. The Spire chants your name.", "Heat sealed. Scrap is yours."],
  finish_loss: [
    "Survived the heat. Next time: higher.",
    "Metal still attached. Come back hungrier.",
  ],
  /** Fired when the player takes a rival apart. */
  takedown: [
    "That one's off the board.",
    "Salvage rights, yours.",
    "The Feed loved that. You should hate that they loved it.",
  ],
  /** Fired when league heat crosses into hunt territory. */
  heat_up: [
    "Price on your hull just went up.",
    "They've stopped racing each other.",
    "Every mirror has someone in it now.",
  ],
  /** Fired when a mission objective fails mid-race. */
  objective_lost: ["That's gone.", "Objective's dead. Salvage the rest."],
  /** Boss duel opener. */
  duel: ["This is the one.", "No cameras cut away from this."],
} as const;

export function pickLine(pool: readonly string[], seed = 0): string {
  if (!pool.length) return "";
  return pool[Math.abs(seed) % pool.length]!;
}

export function briefingFor(trackId: string): string[] {
  return RACE_BRIEFINGS[trackId] ?? RACE_BRIEFINGS.default!;
}
