/**
 * Scrapstorm League lore — short, punchy, demo-friendly.
 * Ash Spire Circuit: outlaw televised heats over a reclaimed desert refinery.
 */

export type StoryBeat = {
  id: string;
  title: string;
  body: string;
  flavor?: string;
};

export const WORLD = {
  league: "Scrapstorm League",
  circuit: "Ash Spire Circuit",
  era: "Year 47 After the Last Pipeline",
  tagline: "Drift. Draft. Dent the legend.",
} as const;

export const LORE: StoryBeat[] = [
  {
    id: "cold-open",
    title: "Ash Spire is live",
    body: "Three heats. No reverse. Sponsors want wreckage, the crowd wants a name.",
    flavor: "Tonight's purse: scrap, paint, and bragging rights.",
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

export const RACE_BRIEFINGS: Record<string, string[]> = {
  ash_spire: [
    "Ash Spire: reclaimed refinery loop. Apron is mean, sand is meaner.",
    "First corner is a meat grinder — don't overcook the entry.",
    "Draft the leader, then break their line with a ram.",
  ],
  default: [
    "Heat is live. Make them remember your paint.",
    "Drift charges turbo. Turbo wins corners.",
    "Weapons free after green.",
  ],
};

export const EVENT_LINES = {
  lap: [
    "Sector clean — keep the rubber hot.",
    "Lap banked. Don't gift the pack a slipstream.",
    "Clock's watching. Push the line.",
  ],
  hit: [
    "Paint traded.",
    "They felt that.",
    "Chassis complains. Keep going.",
  ],
  boost: [
    "Turbo lit.",
    "Overdrive — hold the wheel.",
    "Purple meter. Eat the straight.",
  ],
  finish_win: [
    "P1. The Spire chants your name.",
    "Heat sealed. Scrap is yours.",
  ],
  finish_loss: [
    "Survived the heat. Next time: higher.",
    "Metal still attached. Come back hungrier.",
  ],
} as const;

export function pickLine(pool: readonly string[], seed = 0): string {
  if (!pool.length) return "";
  const i = Math.abs(seed) % pool.length;
  return pool[i];
}

export function briefingFor(trackId: string): string[] {
  return RACE_BRIEFINGS[trackId] ?? RACE_BRIEFINGS.default;
}
