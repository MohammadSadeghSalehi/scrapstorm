/**
 * Sim → audio hand-off for positional one-shots.
 *
 * combat.ts runs inside the fixed-step sim. That loop can advance several times
 * per rendered frame and is also exercised by the headless QA scripts, so it
 * must not reach for an AudioContext directly — it writes plain numbers here and
 * the R3F audio driver drains them once per frame.
 *
 * The ring is preallocated and its slots are mutated in place. The sim is the
 * hottest JS in the build; emitting a fresh object per shot would put a steady
 * allocation stream in front of the render loop for no benefit.
 */

export type AudioCueKind =
  | "fire-bolt"
  | "fire-cannon"
  | "fire-disc"
  | "hit-bolt"
  | "hit-cannon"
  | "hit-disc"
  | "shell-land"
  | "mine-blast"
  | "mine-drop"
  | "defense"
  | "ult";

export interface AudioCue {
  kind: AudioCueKind;
  x: number;
  y: number;
  z: number;
  /** Loudness / size multiplier, roughly 0.3..2. */
  intensity: number;
  /** Source is the local player: played dry through the existing SFX path. */
  self: boolean;
}

/**
 * A wreck in a pack can produce a dozen cues in one sim step. 48 is well past
 * that; anything beyond it is a pile-up the mix could not resolve anyway.
 */
const CAP = 48;

const ring: AudioCue[] = new Array(CAP);
for (let i = 0; i < CAP; i++) {
  ring[i] = { kind: "hit-bolt", x: 0, y: 0, z: 0, intensity: 1, self: false };
}

let write = 0;
let count = 0;

export function emitAudioCue(
  kind: AudioCueKind,
  x: number,
  y: number,
  z: number,
  intensity: number,
  self: boolean,
) {
  const c = ring[write]!;
  c.kind = kind;
  c.x = x;
  c.y = y;
  c.z = z;
  c.intensity = intensity;
  c.self = self;
  write = (write + 1) % CAP;
  // Overflow drops the *oldest* cue rather than the newest: in a pile-up the
  // most recent hits are the ones still on screen.
  if (count < CAP) count += 1;
}

/**
 * Drain in emission order. `fn` receives the live ring slot — it is rewritten
 * by the next sim step, so consumers must read it, not retain it.
 */
export function drainAudioCues(fn: (cue: AudioCue) => void) {
  const n = count;
  if (n === 0) return;
  let i = (write - n + CAP) % CAP;
  count = 0;
  for (let k = 0; k < n; k++) {
    fn(ring[i]!);
    i = (i + 1) % CAP;
  }
}

/** Drop anything queued — used when a heat restarts so stale shots stay silent. */
export function clearAudioCues() {
  count = 0;
}
