/**
 * Seeded variation for one-shot effects.
 *
 * Every spawner in this subsystem seeds this once from the event and then draws
 * every jitter from it. That is the whole quality bar for the VFX work: the
 * problem was never particle COUNT, it was that the fourth barrel exploded with
 * pixel-identical timing, colour and spread to the first. Seeding from the
 * event position plus a monotonic event counter guarantees two things a bare
 * Math.random() spray cannot:
 *
 *   - two events are reliably different, because their seeds differ;
 *   - one event is internally coherent — a burst's flash temperature, soot
 *     darkness, ring frequency and spark spread all come off the same seed, so
 *     a "cold sooty" explosion reads cold in every one of its parts instead of
 *     each part rolling independently and averaging back to the mean.
 *
 * The state is module-level on purpose. An Rng object per event would allocate
 * on every spark, and this whole file exists so that a five-barrel chain
 * reaction produces zero garbage. Spawners are synchronous and never interleave
 * (no awaits, no callbacks), so a single shared cursor is safe.
 */

let state = 1;

/** xorshift32. Cheap, decent low-bit behaviour, no allocation. */
export function rnd(): number {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  // >>> 0 first: the shifts above operate on a signed 32-bit view.
  return (state >>> 0) / 4294967296;
}

export function rngSeed(seed: number): void {
  // xorshift is a fixed point at 0 — a seed of 0 would emit 0 forever, which
  // is exactly the "every burst identical" bug this module exists to prevent.
  state = (seed | 0) >>> 0 || 0x9e3779b9;
  // Discard a couple of draws: adjacent integer seeds otherwise produce
  // visibly correlated first values, and the first value is usually the one
  // driving the most visible parameter (size or colour temperature).
  rnd();
  rnd();
}

/** Uniform in [a, b). */
export function rndIn(a: number, b: number): number {
  return a + (b - a) * rnd();
}

/** Uniform in [-1, 1). */
export function rndSym(): number {
  return rnd() * 2 - 1;
}

export function rndInt(n: number): number {
  return (rnd() * n) | 0;
}

/**
 * Roughly bell-shaped in [-1, 1]. Two draws, not twelve: this is used for
 * spread angles and size jitter where "mostly average, occasionally extreme"
 * is the goal, and the exact distribution does not matter.
 */
export function rndBell(): number {
  return (rnd() + rnd() - 1);
}

/** True with probability p. */
export function rndChance(p: number): boolean {
  return rnd() < p;
}

let eventCounter = 0;

/**
 * A seed for a world-space event.
 *
 * Position alone is not enough — shooting the same wall twice is a genuinely
 * repeated event and should still look different the second time — so a
 * monotonic counter is mixed in. Position is still in there so that two
 * simultaneous events in the same frame (a chain reaction) diverge rather than
 * sharing the counter's neighbourhood.
 */
export function vfxSeed(x: number, y: number, z: number): number {
  eventCounter = (eventCounter + 1) | 0;
  let h = 0x2545f491;
  h = Math.imul(h ^ ((x * 73.1) | 0), 0x85ebca6b);
  h = Math.imul(h ^ ((y * 131.7) | 0), 0xc2b2ae35);
  h = Math.imul(h ^ ((z * 57.3) | 0), 0x27d4eb2f);
  h = Math.imul(h ^ eventCounter, 0x165667b1);
  return (h ^ (h >>> 15)) >>> 0;
}

/** Stable seed from a string id (projectile/vehicle), no counter mixed in. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Deterministic 0..1 from an integer — for per-vertex grain, not sequences. */
export function hash01(n: number): number {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

export function resetVfxRng(): void {
  eventCounter = 0;
  state = 1;
}
