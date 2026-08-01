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

  /*
   * Consequence beats.
   *
   * Every pair below is the SAME moment reached two ways: you out-drove them, or
   * you took them apart. career.applyMissionResult picks between them from what
   * the run actually recorded, which is the only version of "your choices
   * matter" this game can honestly offer — there is no dialogue wheel here, only
   * a steering wheel, so the choice has to be read off the road.
   */
  {
    id: "wrecked-kiln",
    title: "Through the choke",
    voice: "BEX",
    body: "You didn't go round him. You went through him. The Feed ran it four times.",
    flavor: "Marsh will not have forgotten by the time you meet again.",
    act: 2,
  },
  {
    id: "wrecked-sparrow",
    title: "Clean hands, dirty race",
    voice: "HALCYON",
    body: "Ait has never put a mark on anyone in nine seasons. You put him in a wall.",
    flavor: "Nobody on the board says anything. Everybody on the board noticed.",
    act: 2,
  },
  {
    id: "wrecked-vey",
    title: "The witness, silenced",
    voice: "QUIST",
    body: "Vey was about to say something on air. Now she is in a garage instead. Convenient.",
    flavor: "He is not accusing you. He is filing it.",
    act: 3,
  },
  {
    id: "outraced-vey",
    title: "Fair, then",
    voice: "HALCYON",
    body: "You could have put me in the barrier at the chicane. You went round. Sit down — I'll tell you about the stack.",
    act: 3,
  },
  {
    id: "wrecked-kade",
    title: "Even",
    voice: "SUMP",
    body: "Eighteen months and you finally did it back. Feel like anything? Thought not.",
    flavor: "You are the only one of the two of you still driving.",
    act: 3,
  },
  {
    id: "outraced-kade",
    title: "Worse than even",
    voice: "SUMP",
    body: "You beat me clean. On the Rustline. In front of him. He'll take that out of me, not you.",
    act: 3,
  },
  {
    id: "wrecked-marrow",
    title: "Salvage",
    voice: "BEX",
    body: "Eighteen months ago the league called your wreck salvage. Tonight they'll have to call his.",
    flavor: "Same corner. Same word. Different car in it.",
    act: 3,
  },

  /* Heat — the pursuit escalating, fired by career.applyMissionResult. */
  {
    id: "heat-rising",
    title: "Standing price",
    voice: "BEX",
    body: "Three crews were on the wire before you'd cooled down. They're not booking races. They're booking you.",
    flavor: "League Heat 3. Every event now starts hot.",
    act: 2,
  },
  {
    id: "heat-max",
    title: "Manhunt",
    voice: "QUIST",
    body: "Congratulations. You are the most valuable object on this circuit and every driver on it knows the number.",
    flavor: "League Heat 5. Nothing you enter is a race any more.",
    act: 3,
  },
  {
    id: "first-blood",
    title: "The first one",
    voice: "BEX",
    body: "That's your first car off the board. It gets easier. That's the part to watch.",
    act: 1,
  },
  /*
   * Openers. Fired by MissionDef.beatBefore, on the way to the grid.
   *
   * Kept to the handful of nights that are actually a turn in the story. A beat
   * before every race is a loading screen with words on it, and the player
   * learns to click through it — which then costs you the ones that matter.
   */
  {
    id: "cull-open",
    title: "The Cull",
    voice: "QUIST",
    body: "Every twenty seconds we cut the last car. The audience does not watch for the winner.",
    flavor: "There is no finish line in a Cull. There is only being left.",
    act: 1,
  },
  {
    id: "courier-open",
    title: "The load",
    voice: "BEX",
    body: "I am driving this one. You are keeping me alive. Do not get clever, do not get far away.",
    flavor: "She has never asked you for anything before.",
    act: 2,
  },
  {
    id: "lastcall-open",
    title: "Last Call",
    body: "Three and a half kilometres of pipeline road, a live bounty, and a car cut every forty seconds.",
    flavor: "Marrow's crew run this road. They know where the far turn is.",
    act: 3,
  },
  {
    id: "duel-kade",
    title: "The outrider",
    voice: "BEX",
    body: "Kade was on your inside at the stack. He has been on the Rustline every night since, waiting to see if you'd come.",
    act: 3,
  },
  {
    id: "duel-rhee",
    title: "Number two",
    voice: "HALCYON",
    body: "Rhee does not race you. She measures how long you last. Do not give her the long straight.",
    flavor: "Nobody has passed her twice.",
    act: 3,
  },
  {
    id: "duel-marrow",
    title: "Ash Spire, last lap",
    voice: "BEX",
    body: "Same circuit. Same corner. Same car — his side of it. Whatever happens out there, it happens on air.",
    flavor: "Eighteen months of work is sitting on the grid beside you.",
    act: 3,
  },
  {
    id: "quist-refused",
    title: "Declined",
    voice: "QUIST",
    body: "You didn't take the money. Nobody has ever not taken the money. I'll be honest — I don't have a segment for this.",
    flavor: "The offer is not repeated.",
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
  /** Player reaches P1. */
  took_lead: [
    "You're the one being chased now.",
    "P1. Everything behind you just changed its mind.",
    "Front of the pack. Nowhere to hide up here.",
  ],
  /** Player loses a place to an unnamed car. */
  lost_place: [
    "House car just did that to you. Take it back.",
    "That's a place gone to somebody with no name.",
  ],
  /** Player hull below 30%. */
  player_hurt: [
    "Hull's opening up. Stop taking hits.",
    "Bex is going to see this. Bring something back.",
    "You're running on frame. Pick your fights.",
  ],
  /** Final lap. */
  last_lap: [
    "Last lap. Whatever you were saving, spend it.",
    "One more. This is the one they'll show.",
  ],
} as const;

/* ── rival voices ─────────────────────────────────────────────────────
 *
 * Six situations per name, delivered over the radio DURING the race by
 * missions/runtime.ts. This is where the board stops being a list.
 *
 * Every line is written against that rival's PROFILE rather than their bio, so
 * what you hear matches what you are being made to do: the blockers talk about
 * the road, the hunters talk about you, the pacers barely talk at all. If a
 * profile is ever retuned, its lines want re-reading.
 *
 * Under ten words each. They are read at speed, through a HUD chip, while
 * somebody is trying to put you into a wall.
 */
export type BarkKind =
  /** Opening lap, once. */
  | "open"
  /** They just took a place off you. */
  | "pass"
  /** Their hull is under 35%. */
  | "hurt"
  /** You wrecked them. */
  | "down"
  /** The run resolved in their favour. */
  | "won"
  /** The run resolved in yours. */
  | "lost";

export const RIVAL_BARKS: Record<string, Partial<Record<BarkKind, string>>> = {
  wask: {
    open: "GRIT: Door's shut. Try the handle.",
    pass: "GRIT: Told you. Shut.",
    hurt: "GRIT: Plate's cheap. I've got more.",
    down: "GRIT: Fine. Fine.",
    won: "GRIT: Come back when you can drive.",
    lost: "GRIT: Board's yours to climb. Don't thank me.",
  },
  nim: {
    open: "HALFPIPE: Watch the exit. Not the entry.",
    pass: "HALFPIPE: You looked where I told you not to.",
    hurt: "HALFPIPE: That's fine, that's fine, that's fine.",
    down: "HALFPIPE: My own mine. My OWN mine.",
    won: "HALFPIPE: Bowl's mine. Always was.",
    lost: "HALFPIPE: Fine! You looked at the exit.",
  },
  vance: {
    open: "TALLY: Number forty-one, coming up.",
    pass: "TALLY: Line 'em up, knock 'em down.",
    hurt: "TALLY: Doesn't count. Doesn't count.",
    down: "TALLY: Off by one. I'll fix the tally.",
    won: "TALLY: Forty-one. Say it on air.",
    lost: "TALLY: You're not on the list. Yet.",
  },
  sook: {
    open: "FERRITE: I don't lift. Ask the barrier.",
    pass: "FERRITE: Brakes are for people with plans.",
    hurt: "FERRITE: Panel's gone. Still don't lift.",
    down: "FERRITE: Should've lifted.",
    won: "FERRITE: Chicane ate you. Told you it would.",
    lost: "FERRITE: Fine. You were there on the exit.",
  },
  ait: {
    open: "SPARROW: I'll be where you were.",
    pass: "SPARROW: —",
    hurt: "SPARROW: That wasn't necessary.",
    down: "SPARROW: Nine seasons. Not one mark.",
    won: "SPARROW: No contact. No excuses. Check the sheet.",
    lost: "SPARROW: You were quicker. That is all it was.",
  },
  marsh: {
    open: "KILN: Gap's mine. Come take it.",
    pass: "KILN: There's the gap. There it goes.",
    hurt: "KILN: Still parked here.",
    down: "KILN: Nobody's ever come through there.",
    won: "KILN: West choke. Always the west choke.",
    lost: "KILN: Through my own gap. Huh.",
  },
  novo: {
    open: "GLASSJAW: One mistake each. I'm not making mine.",
    pass: "GLASSJAW: There it is. That was yours.",
    hurt: "GLASSJAW: No no no, not yet—",
    down: "GLASSJAW: Glass. Told you.",
    won: "GLASSJAW: Two corners. That's all I needed.",
    lost: "GLASSJAW: You survived me. Nobody survives me.",
  },
  reyes: {
    open: "CATHODE: You're already in frame.",
    pass: "CATHODE: Lock's been on you since the grid.",
    hurt: "CATHODE: Array's still up. That's what matters.",
    down: "CATHODE: Lost the lock. Lost the rest.",
    won: "CATHODE: Bounty's paid. Everyone got a cut.",
    lost: "CATHODE: Nobody's broken that lock before.",
  },
  ogun: {
    open: "BELLOWS: It's a long road. You'll see.",
    pass: "BELLOWS: No hurry. Never is.",
    hurt: "BELLOWS: Still running. That's the trick.",
    down: "BELLOWS: First one. In eleven years.",
    won: "BELLOWS: The road did it. It always does.",
    lost: "BELLOWS: Long road. You lasted it.",
  },
  vey: {
    open: "HALCYON: Not easy. Fair. There's a difference.",
    pass: "HALCYON: Clean. Note that it was clean.",
    hurt: "HALCYON: You didn't have to do that.",
    down: "HALCYON: So you're his after all.",
    won: "HALCYON: Fair, and you still lost it.",
    lost: "HALCYON: Good. Now you're worth talking to.",
  },
  ptok: {
    open: "SABLE: Business. You understand.",
    pass: "SABLE: I sold your position. Twice.",
    hurt: "SABLE: This is coming out of your cut.",
    down: "SABLE: Costly. For me.",
    won: "SABLE: The House always races too. People forget.",
    lost: "SABLE: Unbought. Expensive word, that.",
  },
  ilo: {
    open: "ORGAN GRINDER: In you go.",
    pass: "ORGAN GRINDER: Processing.",
    hurt: "ORGAN GRINDER: Doesn't hurt. Never has.",
    down: "ORGAN GRINDER: Out again. Rare.",
    won: "ORGAN GRINDER: The Pit keeps what it takes.",
    lost: "ORGAN GRINDER: Unprocessed. Huh.",
  },
  kade: {
    open: "SUMP: You remember the stack. I remember the stack.",
    pass: "SUMP: Same side as last time. Notice?",
    hurt: "SUMP: He'll just send the next one.",
    down: "SUMP: There. Now we're even.",
    won: "SUMP: Twice now. Tell Bex I said hello.",
    lost: "SUMP: It was never Marrow's idea. Ask who sells the tape.",
  },
  rhee: {
    open: "PALLBEARER: Nobody gets past me twice.",
    pass: "PALLBEARER: That's the first time. There is no second.",
    hurt: "PALLBEARER: Good. Now it's a long road for both of us.",
    down: "PALLBEARER: Then go and take it back.",
    won: "PALLBEARER: Told you. Long road.",
    lost: "PALLBEARER: Marrow's expecting you. He always was.",
  },
  marrow: {
    open: "MARROW: It runs better for me.",
    pass: "MARROW: You never could hold this corner.",
    hurt: "MARROW: Careful. It's still my car.",
    down: "MARROW: Eighteen months. Eighteen months.",
    won: "MARROW: Same corner. Same result. Same advert.",
    lost: "MARROW: It was never mine. Take it.",
  },
};

export function rivalBark(rivalId: string, kind: BarkKind): string {
  const line = RIVAL_BARKS[rivalId]?.[kind] ?? "";
  // A single em dash is Sparrow declining to say anything, which is character
  // rather than content. Suppress it here so the HUD never shows a lone dash.
  return line === "SPARROW: —" ? "" : line;
}

/**
 * A line for the road itself, played once when a circuit first unlocks.
 *
 * A new track arriving as nothing but a new button on a grid is the cheapest
 * moment in a progression system. This costs one string each.
 */
export const TRACK_BEATS: Record<string, string> = {
  foundry_pit: "The Foundry Set will run you. That is what the Foundry is for.",
  rustline: "Eighteen metres wide in places. The Rustline eats new numbers.",
  sable_run: "The House owns the Sable Mile. You will be racing on Ptok's road.",
  dead_mile: "Marrow's crew runs the Dead Mile. You are getting close now.",
};

export function pickLine(pool: readonly string[], seed = 0): string {
  if (!pool.length) return "";
  return pool[Math.abs(seed) % pool.length]!;
}

export function briefingFor(trackId: string): string[] {
  return RACE_BRIEFINGS[trackId] ?? RACE_BRIEFINGS.default!;
}
