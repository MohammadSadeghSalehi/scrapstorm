/**
 * The gate that holds a race at the grid until the world is actually warm.
 *
 * WHY THIS EXISTS
 * ---------------
 * `sim.startCountdown()` sets phase to "countdown" and the clock starts running
 * on the very next rendered frame. But mounting the race world is what BUILDS
 * that world: the terrain heightfield, the road ribbon, the scatter fields, the
 * set-piece colliders, the glTF props and weapons, the HDRI decode, the post
 * chain and every shader program in the frame are all created or resolved after
 * that mount. So "3… 2… 1… GO" was precisely the window all of it landed in —
 * the one part of a race that must not stutter.
 *
 * The fix is not to make that work cheaper. It is to make the countdown wait for
 * it. This module is the single piece of shared state that lets three otherwise
 * unrelated places agree on when "ready" is:
 *
 *   - ScrapstormApp opens the gate and puts the loading screen up,
 *   - GameScene's SimDriver refuses to advance the sim clock while it is held,
 *   - GameScene's WorldWarmup closes it once the scene has stopped changing and
 *     the shaders are compiled.
 *
 * DEPENDENCY-FREE ON PURPOSE. ScrapstormApp is the app shell and is deliberately
 * careful not to pull three.js into the first paint. It imports this module
 * directly, so this file must never grow an import of anything that does.
 *
 * A HELD GATE ALWAYS OPENS. Every phase is on a watchdog. A wedged fetch, a lost
 * WebGL context or a canvas that never mounts costs the player a slower start —
 * never a race that will not begin. A loading screen that waits forever on a
 * failed asset is worse than the hitch it was trying to prevent.
 */

export type RaceGatePhase = "idle" | "assets" | "world" | "open";

export type RaceGateSnapshot = {
  /** The loading screen should be up. */
  readonly active: boolean;
  /** The sim clock must not advance — this is what freezes the countdown. */
  readonly held: boolean;
  readonly phase: RaceGatePhase;
  /** 0..100 across both phases combined. Never goes backwards within a run. */
  readonly pct: number;
  readonly label: string;
  /** Bumped on every open. Late callbacks from an abandoned race compare it. */
  readonly generation: number;
};

/**
 * How the two phases split the bar.
 *
 * Downloading and decoding is by far the longer half on a cold cache, and the
 * warm phase has a hard ceiling of a few seconds, so 72/28 keeps the bar moving
 * at roughly a constant rate instead of parking at 95% for the slow part.
 */
const ASSET_SHARE = 0.72;

/**
 * Watchdogs. Generous, because the dev server hands out 274MB of assets over
 * HTTP/1.1 with a six-connection limit and a cold first race legitimately takes
 * tens of seconds — but finite, because the alternative to a slow start is a
 * game that never starts.
 *
 * Fallback on expiry is identical in both cases: close the gate and let the
 * countdown run. Whatever had not arrived arrives during the race, which is
 * exactly the behaviour this whole module exists to avoid — but only for the
 * assets that actually failed, and only after we have waited a long time for
 * them.
 */
const ASSET_BUDGET_MS = 45_000;
const WORLD_BUDGET_MS = 18_000;

type Listener = (s: RaceGateSnapshot) => void;

const listeners = new Set<Listener>();
let watchdog: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

let state: RaceGateSnapshot = {
  active: false,
  held: false,
  phase: "idle",
  pct: 0,
  label: "",
  generation: 0,
};

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Publish, but only on a real change.
 *
 * The in-scene warm driver calls `setWorldProgress` from `useFrame`, so this
 * runs sixty times a second for the length of the warm phase while the rounded
 * percentage changes maybe a dozen times. Without the identity bail-out every
 * one of those frames allocates a snapshot and re-renders the loading screen
 * mid-warm-up — React work competing with the compile it is waiting for.
 */
function emit(next: Partial<RaceGateSnapshot>) {
  const merged = { ...state, ...next };
  if (
    merged.active === state.active &&
    merged.held === state.held &&
    merged.phase === state.phase &&
    merged.pct === state.pct &&
    merged.label === state.label &&
    merged.generation === state.generation
  ) {
    return;
  }
  state = merged;
  for (const l of listeners) l(state);
}

function armWatchdog(ms: number, reason: string) {
  if (watchdog !== null) clearTimeout(watchdog);
  const gen = generation;
  watchdog = setTimeout(() => {
    watchdog = null;
    if (generation !== gen || !state.held) return;
    console.warn(`[raceGate] ${reason} — releasing the grid anyway`);
    closeRaceGate(reason);
  }, ms);
}

/**
 * Take the grid. The countdown cannot advance until `closeRaceGate` runs.
 *
 * `assets: false` skips straight to the in-scene warm phase — that is the
 * restart path, where everything is already downloaded and decoded and the only
 * cost left is rebuilding and re-compiling the scene graph.
 */
export function openRaceGate(opts: { assets: boolean }): number {
  generation += 1;
  const phase: RaceGatePhase = opts.assets ? "assets" : "world";
  emit({
    active: true,
    held: true,
    phase,
    pct: 0,
    label: opts.assets ? "Loading assets" : "Building world",
    generation,
  });
  armWatchdog(
    opts.assets ? ASSET_BUDGET_MS + WORLD_BUDGET_MS : WORLD_BUDGET_MS,
    opts.assets ? "asset load exceeded its budget" : "world warm-up stalled",
  );
  return generation;
}

/** Asset-phase progress, 0..1. Ignored once the world phase has begun. */
export function setAssetProgress(frac: number, label: string) {
  if (!state.held || state.phase !== "assets") return;
  const pct = clampPct(frac * ASSET_SHARE * 100);
  emit({ pct, label });
}

/**
 * Everything fetchable has been fetched; the scene is about to mount.
 *
 * Re-arms the watchdog so a slow download does not spend the warm phase's
 * budget, and vice versa.
 */
export function beginWorldWarm() {
  if (!state.held) return;
  emit({ phase: "world", label: "Building world" });
  armWatchdog(WORLD_BUDGET_MS, "world warm-up stalled");
}

/** World-phase progress, 0..1. */
export function setWorldProgress(frac: number, label: string) {
  if (!state.held || state.phase !== "world") return;
  const pct = clampPct((ASSET_SHARE + frac * (1 - ASSET_SHARE)) * 100);
  emit({ pct, label });
}

/** Green light. Idempotent — the watchdog and the scene both race to call it. */
export function closeRaceGate(reason: string) {
  if (watchdog !== null) {
    clearTimeout(watchdog);
    watchdog = null;
  }
  if (!state.active && !state.held) return;
  void reason;
  emit({ active: false, held: false, phase: "open", pct: 100, label: "Ready" });
}

/** Read by SimDriver every frame. Hot path — keep it a plain field read. */
export function isSimHeld(): boolean {
  return state.held;
}

export function getRaceGate(): RaceGateSnapshot {
  return state;
}

export function subscribeRaceGate(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function clampPct(v: number): number {
  const n = Math.round(Math.max(0, Math.min(100, v)));
  // Monotonic within a run: three independent producers write this bar and a
  // number that jumps backwards reads as a stall, not as detail.
  return n < state.pct && state.phase !== "idle" ? state.pct : n;
}

/* ── warm-task registry ─────────────────────────────────────────────── */

/**
 * Preload entry points contributed by modules the loader does not import.
 *
 * Several things that must be resident before the lights go green live in files
 * the load path has no business importing directly — audio banks, mission
 * assets, anything a future feature adds. Rather than growing
 * `prepareRaceAssets` a dependency on each of them, those modules register a
 * task here at import time and the loader awaits whatever happens to be
 * registered.
 *
 * A task that throws or times out is skipped, never fatal: the contract is
 * "hold the grid a bit longer for me if you can", not "block the race on me".
 */
export type RaceWarmTask = {
  readonly id: string;
  readonly label: string;
  /** Rough share of the warm budget, relative to other tasks. Default 1. */
  readonly weight?: number;
  readonly run: () => Promise<unknown>;
};

const warmTasks = new Map<string, RaceWarmTask>();

export function registerRaceWarmTask(task: RaceWarmTask): () => void {
  warmTasks.set(task.id, task);
  return () => {
    warmTasks.delete(task.id);
  };
}

export function listRaceWarmTasks(): RaceWarmTask[] {
  return [...warmTasks.values()];
}

/* ── helpers ────────────────────────────────────────────────────────── */

/**
 * Resolve `p`, or give up after `ms`.
 *
 * Deliberately resolves rather than rejects on expiry, and deliberately does not
 * cancel the underlying work: a texture pack that is merely slow keeps
 * downloading and lands mid-race, which is worse than waiting but far better
 * than a race that never starts. Every await in the load path goes through this.
 */
export function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn(`[raceGate] "${label}" exceeded ${ms}ms — continuing without it`);
      resolve(null);
    }, ms);
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        console.warn(`[raceGate] "${label}" failed`, e);
        resolve(null);
      },
    );
  });
}

/**
 * Hand the main thread back to the browser.
 *
 * `setTimeout(0)` rather than rAF: the loading screen only needs to paint, and
 * rAF would pin every yield to a frame boundary — at ~90 slices that is 1.5s of
 * pure waiting on a 144Hz display and considerably worse on a backgrounded tab,
 * where rAF stops firing entirely and the build would never finish.
 */
export function yieldToBrowser(): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, 0));
}

/** Shared clock for the sliced builders, so they all slice the same way. */
export const SLICE_MS = 8;

export { now as gateNow };
