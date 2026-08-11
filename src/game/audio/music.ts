/**
 * Music state machine.
 *
 * The tracks themselves are original arena rock rendered by scripts/gen-music.mjs
 * (see public/assets/SOURCES.md for the exact prompts). This file owns *when*
 * each one plays and *how* it gets there; AudioEngine owns the nodes.
 *
 * Why a state machine rather than `playMusic` calls scattered through the frame
 * loop: the driver previously asked for `final_lap` on every frame of the last
 * lap and for `race_intensity` on every frame of the race. That worked only
 * because `playMusic` early-returns when the id already matches — meaning the
 * transition logic was an accident of a guard, and any state that needed to be
 * re-entered (a restart into the same track) silently did nothing.
 *
 * Transitions are specified, not uniform. A hard-cut crossfade is right when the
 * lights go green and wrong when a heat ends, and using one fade time everywhere
 * is the difference between a soundtrack and a playlist:
 *
 *   - `duckFirst` pulls the outgoing track down *before* the new one starts, so
 *     the two never overlap at full level. Used where the change is a narrative
 *     beat (results, final lap) and a smear would blur it.
 *   - `stinger` fires a transition hit over the seam. The oldest trick in game
 *     audio and still the only reliable way to make an unaligned crossfade
 *     between two tracks at different tempos sound deliberate: the ear tracks
 *     the transient and stops listening for the beat underneath it.
 */

import type { MusicId } from "./SampleBank";

export type MusicState =
  | "silent"
  | "menu"
  | "garage"
  | "grid"
  | "race"
  | "final"
  | "victory"
  | "defeat";

export const MUSIC_STATE_TRACK: Record<MusicState, MusicId | null> = {
  silent: null,
  menu: "menu_anthem",
  garage: "garage_vibe",
  // The grid is the build-up, so it gets the lower-energy race bed; the lights
  // going out is what promotes it to the full arrangement.
  grid: "race_heat",
  race: "race_intensity",
  final: "final_lap",
  victory: "victory",
  defeat: "defeat",
};

export interface MusicTransition {
  /** Fade-in length for the incoming track. */
  fade: number;
  /** Pull the outgoing track down over this long before starting the new one. */
  duckFirst: number;
  /** 0 = no stinger. Level of the transition hit fired over the seam. */
  stinger: number;
}

const DEFAULT_TRANSITION: MusicTransition = {
  fade: 0.9,
  duckFirst: 0,
  stinger: 0,
};

/** Keyed by the state being entered. */
export const MUSIC_TRANSITIONS: Partial<Record<MusicState, MusicTransition>> = {
  // Leaving the menu should feel like a door closing, not a dissolve.
  garage: { fade: 0.7, duckFirst: 0.25, stinger: 0.35 },
  grid: { fade: 0.5, duckFirst: 0.3, stinger: 0.5 },
  // Lights out: the fastest transition in the game. Anything slower and the
  // music arrives after the player has already accelerated.
  race: { fade: 0.35, duckFirst: 0, stinger: 0.7 },
  // Final lap is a promotion, not a scene change — it should arrive under the
  // driving rather than announce itself, so no stinger and a long blend.
  final: { fade: 1.6, duckFirst: 0, stinger: 0 },
  victory: { fade: 0.5, duckFirst: 0.45, stinger: 0.85 },
  defeat: { fade: 1.1, duckFirst: 0.5, stinger: 0.3 },
  menu: { fade: 1.2, duckFirst: 0.3, stinger: 0 },
  silent: { fade: 0.4, duckFirst: 0.4, stinger: 0 },
};

export function transitionFor(state: MusicState): MusicTransition {
  return MUSIC_TRANSITIONS[state] ?? DEFAULT_TRANSITION;
}

export interface MusicContext {
  phase: string;
  /** Player's current lap, 0-based. */
  lap: number;
  lapCount: number;
  finished: boolean;
  won: boolean;
  /**
   * What the race IS, and what it looks like out of the window.
   *
   * Both optional and both default to the plain race beds, so free play and
   * every existing caller are unchanged. They exist because five finished
   * tracks were shipped and never played: the score had a duel theme, a hunt
   * theme, a night bed and a rain bed sitting in public/assets/audio/music with
   * nothing in the code that could ever ask for them.
   *
   * Priority, when more than one applies: the MISSION KIND wins over the
   * CONDITION. A duel in the rain is a duel — the thing the player is doing
   * outranks the weather it is being done in — and stacking them is not
   * possible with one bed anyway.
   */
  missionKind?: string | null;
  /** "night" | "sunset" | ... — only night currently has its own bed. */
  timeOfDay?: string | null;
  /** Weather id. Rain and storm share the wet bed. */
  weather?: string | null;
}

/**
 * Which TRACK a state actually plays, once the race is taken into account.
 *
 * MUSIC_STATE_TRACK is the default map and stays the answer for everything that
 * is not on a circuit — menu, garage, victory, defeat. This layer only ever
 * re-points the three driving beds (grid, race, final), because those are the
 * ones where a duel, a manhunt, a night or a downpour should not sound like a
 * Tuesday afternoon heat.
 *
 * Kept separate from `musicStateFor` rather than folded into it because the two
 * answer different questions and one of them is already load-bearing: the state
 * decides transitions, ducking and the stinger (see MUSIC_TRANSITIONS), and a
 * duel is dramaturgically still "the race" — same fade, same stinger, same
 * promotion to `final` on the last lap. Only the audio differs. Adding
 * `duel`/`hunt`/`night`/`rain` as STATES would have meant restating every one of
 * those transition rules four times over and getting one of them wrong.
 */
export function trackFor(state: MusicState, c?: MusicContext): MusicId | null {
  const base = MUSIC_STATE_TRACK[state];
  if (!c) return base;
  if (state !== "grid" && state !== "race" && state !== "final") return base;

  // Mission kind first — what you are doing outranks the weather you do it in.
  if (c.missionKind === "duel") return "duel";
  if (c.missionKind === "hunt" || c.missionKind === "survival") return "hunt";

  // Then the condition. Rain and storm share a bed; overcast is not weather
  // enough to earn one and stays on the standard track.
  if (c.weather === "wet" || c.weather === "storm") return "rain_race";
  if (c.timeOfDay === "night") return "night_race";

  return base;
}

/**
 * Single place that decides what should be playing. Pure, so the headless probe
 * can assert the whole state table without an AudioContext — including the
 * ordering hazard that the finished phase must beat the final-lap rule, which is
 * otherwise reachable (a player finishes *on* the final lap).
 */
export function musicStateFor(c: MusicContext): MusicState {
  if (c.phase === "finished") return c.won ? "victory" : "defeat";
  if (c.phase === "menu") return "menu";
  if (c.phase === "garage") return "garage";
  if (c.phase === "countdown") return "grid";
  if (c.phase === "racing" || c.phase === "paused") {
    // `lap` is 0-based, so the final lap is index lapCount-1.
    return c.lap >= c.lapCount - 1 ? "final" : "race";
  }
  return "silent";
}
