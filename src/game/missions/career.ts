/**
 * Career progression — the reason to run the next one.
 *
 * Three currencies, each doing a different job:
 *
 *   MARKERS  gate the board. Earned by events, takedowns and duels, never
 *            spent. This is the milestone counter that decides which rival will
 *            take your call, and it is why a player who only ever races is
 *            slower to climb than one who also fights.
 *   SCRAP    is spent, and lives in meta.ts because the garage already owns it.
 *            Career only ever reports what it owes; see `scrapPending`.
 *   HEAT     persists across races. It goes up when you win and take people
 *            apart, and it does not come back down on its own — losing is what
 *            cools it. Heat is pushed into the AI as a floor under every
 *            mission's own setting, so a player deep in the board finds even a
 *            low-stakes event has the field looking at them.
 *
 * Heat is the pursuit. There is no police car to spawn, so the escalation is
 * expressed as the field's willingness to stop racing and come for you, which
 * is the same feeling arriving through a different door.
 */
import type { AnyTrackId } from "../track";
import { DUEL_MISSIONS, RIVALS_BY_RANK, rivalById } from "./rivals";
import { EVENT_MISSIONS, MISSIONS_BY_ID } from "./catalog";
import type { MissionDef, MissionRunSummary, RivalDef } from "./types";

const CAREER_KEY = "scrapstorm-career-v1";

export interface CareerState {
  version: 1;
  markers: number;
  /** 1..5, persistent. 1 is an ordinary night, 5 is a manhunt. */
  heat: number;
  defeated: string[];
  completed: string[];
  best: Record<string, { time: number; place: number; takedowns: number }>;
  seenBeats: string[];
  takedowns: number;
  /** Scrap earned but not yet handed to meta.ts. The shell drains this. */
  scrapPending: number;
  titles: string[];
}

export const DEFAULT_CAREER: CareerState = {
  version: 1,
  markers: 0,
  heat: 1,
  defeated: [],
  completed: [],
  best: {},
  seenBeats: [],
  takedowns: 0,
  scrapPending: 0,
  titles: [],
};

/**
 * Markers needed before a circuit appears.
 *
 * The ladder tours all six deliberately: the first four rivals are on the two
 * launch circuits, and each new track arrives with a rival who lives there, so
 * a new road always shows up attached to a reason to learn it.
 */
export const TRACK_UNLOCKS: Record<AnyTrackId, number> = {
  ash_spire: 0,
  cinder_bowl: 0,
  foundry_pit: 6,
  rustline: 14,
  sable_run: 20,
  dead_mile: 58,
};

export const ALL_MISSIONS: MissionDef[] = [...EVENT_MISSIONS, ...DUEL_MISSIONS];

export function missionById(id: string): MissionDef | undefined {
  return MISSIONS_BY_ID[id] ?? DUEL_MISSIONS.find((m) => m.id === id);
}

function clampCareer(raw: Partial<CareerState> | null): CareerState {
  if (!raw) return { ...DEFAULT_CAREER, defeated: [], completed: [], best: {}, seenBeats: [], titles: [] };
  const known = new Set(ALL_MISSIONS.map((m) => m.id));
  const rivals = new Set(RIVALS_BY_RANK.map((r) => r.id));
  return {
    version: 1,
    markers: Math.max(0, Math.floor(raw.markers ?? 0)),
    heat: Math.min(5, Math.max(1, raw.heat ?? 1)),
    defeated: (raw.defeated ?? []).filter((id) => rivals.has(id)),
    completed: (raw.completed ?? []).filter((id) => known.has(id)),
    best: raw.best ?? {},
    seenBeats: raw.seenBeats ?? [],
    takedowns: Math.max(0, Math.floor(raw.takedowns ?? 0)),
    scrapPending: Math.max(0, Math.floor(raw.scrapPending ?? 0)),
    titles: raw.titles ?? [],
  };
}

export function loadCareer(): CareerState {
  if (typeof window === "undefined") return clampCareer(null);
  try {
    const raw = localStorage.getItem(CAREER_KEY);
    return clampCareer(raw ? (JSON.parse(raw) as Partial<CareerState>) : null);
  } catch {
    return clampCareer(null);
  }
}

export function saveCareer(state: CareerState): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CAREER_KEY, JSON.stringify(state));
  } catch {
    /* quota / private mode */
  }
}

export function resetCareer(): CareerState {
  const fresh = clampCareer(null);
  saveCareer(fresh);
  return fresh;
}

/* ── board queries ────────────────────────────────────────────────────── */

export function trackUnlocked(career: CareerState, id: AnyTrackId): boolean {
  return career.markers >= (TRACK_UNLOCKS[id] ?? 0);
}

export function unlockedTracks(career: CareerState): AnyTrackId[] {
  return (Object.keys(TRACK_UNLOCKS) as AnyTrackId[]).filter((id) =>
    trackUnlocked(career, id),
  );
}

export function eventAvailable(career: CareerState, m: MissionDef): boolean {
  const need = m.requiresMarkers ?? TRACK_UNLOCKS[m.trackId] ?? 0;
  return career.markers >= need && trackUnlocked(career, m.trackId);
}

export function availableEvents(career: CareerState): MissionDef[] {
  return EVENT_MISSIONS.filter((m) => eventAvailable(career, m));
}

export type RivalStatus = "defeated" | "available" | "locked";

export interface BoardEntry {
  rival: RivalDef;
  status: RivalStatus;
  /** Which qualifying events are still outstanding. */
  missing: string[];
  markersShort: number;
}

/**
 * The board, top to bottom.
 *
 * A rival is available when their marker threshold is met AND their qualifying
 * events are cleared AND every lower-ranked rival is beaten. That last clause is
 * what makes it a ladder rather than a menu — Most Wanted's board was never
 * something you could skip up.
 */
export function board(career: CareerState): BoardEntry[] {
  let lowerCleared = true;
  const rows: BoardEntry[] = [];
  for (const rival of RIVALS_BY_RANK) {
    const defeated = career.defeated.includes(rival.id);
    const missing = rival.unlock.events.filter((id) => !career.completed.includes(id));
    const markersShort = Math.max(0, rival.unlock.markers - career.markers);
    const available = lowerCleared && !defeated && missing.length === 0 && markersShort === 0;
    rows.push({
      rival,
      status: defeated ? "defeated" : available ? "available" : "locked",
      missing,
      markersShort,
    });
    if (!defeated) lowerCleared = false;
  }
  return rows;
}

/** The rival the player is currently climbing towards, if any. */
export function nextRival(career: CareerState): RivalDef | null {
  for (const r of RIVALS_BY_RANK) {
    if (!career.defeated.includes(r.id)) return r;
  }
  return null;
}

export function canChallenge(career: CareerState, rivalId: string): boolean {
  return board(career).some((b) => b.rival.id === rivalId && b.status === "available");
}

/** Board position, 16 = unranked. */
export function currentRank(career: CareerState): number {
  const beaten = RIVALS_BY_RANK.filter((r) => career.defeated.includes(r.id));
  if (!beaten.length) return 16;
  return Math.min(...beaten.map((r) => r.rank));
}

/* ── heat ─────────────────────────────────────────────────────────────── */

/** 0..1 for the AI directive. */
export function heatNormalised(career: CareerState): number {
  return (Math.min(5, Math.max(1, career.heat)) - 1) / 4;
}

/**
 * The heat a mission actually runs at.
 *
 * Career heat is a FLOOR, not a replacement: a mission authored as a quiet time
 * attack should still be quieter than a manhunt, but at rank 3 nothing is
 * genuinely quiet any more. The 0.75 keeps the floor below the ceiling so the
 * authored value still means something at the top of the board.
 */
export function effectiveHeat(career: CareerState, mission: MissionDef): number {
  return Math.min(1, Math.max(mission.modifiers.heat, heatNormalised(career) * 0.75));
}

/* ── results ──────────────────────────────────────────────────────────── */

export interface CareerAward {
  scrap: number;
  markers: number;
  /** Rival newly defeated. */
  rivalDefeated: RivalDef | null;
  /** Tracks that just became reachable. */
  tracksUnlocked: AnyTrackId[];
  /** Story beat ids to play, in order. */
  beats: string[];
  heatBefore: number;
  heatAfter: number;
  firstClear: boolean;
}

/**
 * Fold a finished run into the career.
 *
 * Pure: returns a new state. The caller decides when to persist, which matters
 * because the shell also has to hand the scrap to meta.ts and both should land
 * together or not at all.
 */
export function applyMissionResult(
  career: CareerState,
  def: MissionDef,
  summary: MissionRunSummary,
): { career: CareerState; award: CareerAward } {
  const next: CareerState = {
    ...career,
    defeated: [...career.defeated],
    completed: [...career.completed],
    best: { ...career.best },
    seenBeats: [...career.seenBeats],
    titles: [...career.titles],
  };
  const award: CareerAward = {
    scrap: 0,
    markers: 0,
    rivalDefeated: null,
    tracksUnlocked: [],
    beats: [],
    heatBefore: career.heat,
    heatAfter: career.heat,
    firstClear: false,
  };

  next.takedowns += summary.takedowns;

  const prevBest = career.best[def.id];
  if (
    !prevBest ||
    summary.place < prevBest.place ||
    (summary.place === prevBest.place && summary.raceTime < prevBest.time)
  ) {
    next.best[def.id] = {
      time: summary.raceTime,
      place: summary.place,
      takedowns: summary.takedowns,
    };
  }

  if (summary.outcome !== "complete") {
    // Losing is the only thing that cools the league down. It is also the only
    // pressure valve in the system — without it a bad run at heat 5 is
    // unwinnable and stays unwinnable.
    next.heat = Math.max(1, career.heat - 0.5);
    award.heatAfter = next.heat;
    // Takedowns still pay. A failed run that cost three rivals a car was not
    // nothing, and being paid for the fight is what keeps a retry appealing.
    award.markers = summary.takedowns;
    award.scrap = Math.round(summary.takedowns * 25);
    next.markers += award.markers;
    next.scrapPending += award.scrap;
    return { career: next, award };
  }

  award.firstClear = !career.completed.includes(def.id);
  if (award.firstClear) next.completed.push(def.id);

  const heatMul = 1 + (career.heat - 1) * 0.12;
  award.markers =
    def.reward.markers * (award.firstClear ? 1 : 0) +
    summary.bonusMet * 2 +
    summary.takedowns;
  award.scrap = Math.round(
    (def.reward.scrap * (award.firstClear ? 1 : 0.35) +
      (award.firstClear ? (def.reward.firstClearBonus ?? 0) : 0) +
      summary.takedowns * 30) *
      heatMul,
  );

  const markersBefore = next.markers;
  next.markers += award.markers;
  next.scrapPending += award.scrap;

  if (def.rivalId && !next.defeated.includes(def.rivalId)) {
    const rival = rivalById(def.rivalId);
    if (rival) {
      next.defeated.push(rival.id);
      next.titles.push(rival.reward.title);
      award.rivalDefeated = rival;
      // Taking a rank is the loudest thing you can do. The board notices.
      next.heat = Math.min(5, next.heat + 1);
    }
  } else {
    next.heat = Math.min(5, next.heat + 0.15 * Math.max(1, summary.takedowns));
  }
  award.heatAfter = next.heat;

  for (const [id, need] of Object.entries(TRACK_UNLOCKS) as [AnyTrackId, number][]) {
    if (markersBefore < need && next.markers >= need) award.tracksUnlocked.push(id);
  }

  for (const beat of [def.beatAfter, award.rivalDefeated?.beatAfter]) {
    if (beat && !next.seenBeats.includes(beat)) {
      next.seenBeats.push(beat);
      award.beats.push(beat);
    }
  }

  return { career: next, award };
}

/** Beat to show on the grid, if it has not been seen. */
export function pendingIntroBeat(
  career: CareerState,
  def: MissionDef,
): string | null {
  if (def.beatBefore && !career.seenBeats.includes(def.beatBefore)) {
    return def.beatBefore;
  }
  return null;
}

export function markBeatSeen(career: CareerState, beatId: string): CareerState {
  if (career.seenBeats.includes(beatId)) return career;
  return { ...career, seenBeats: [...career.seenBeats, beatId] };
}

/** Hand the owed scrap to the caller so it can be paid into meta.ts. */
export function drainScrap(career: CareerState): {
  career: CareerState;
  scrap: number;
} {
  return { career: { ...career, scrapPending: 0 }, scrap: career.scrapPending };
}
