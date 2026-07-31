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
