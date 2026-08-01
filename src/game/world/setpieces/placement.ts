/**
 * Where a structure is allowed to stand.
 *
 * This file exists because the alternative — deriving a position from a track
 * sample and trusting it — is the single most repeated bug in this project, and
 * it is worse for setpieces than for anything that came before it. A rock that
 * overlaps the road is a rock you clip. A 21m furnace stack that overlaps the
 * road is a solid-looking building the car passes through at 40 m/s.
 *
 * Three rules, all of them learned rather than assumed:
 *
 *  1. HEIGHT COMES FROM THE DUNE PROFILE, never from a literal and never from a
 *     track sample's `y`. `sample.y` is the ROAD plane; the desert climbs to
 *     roadY + 1.1 + dune*16 once you are past the berm, which is metres, not
 *     centimetres. `settle()` below evaluates exactly the curve
 *     `getGroundHeight` evaluates — it just reuses a surface query that is
 *     already in hand instead of paying for a second sweep.
 *  2. CLEARANCE IS TESTED AGAINST THE WHOLE LOOP, via `getSurfaceAt`. Every
 *     circuit in the catalogue doubles back on itself; the Dead Mile's legs pass
 *     within ~95m and Foundry Pit's bowls are closer than that. A point 8m off
 *     the centreline at sample 40 can be sitting on the tarmac at sample 210,
 *     and only a query that knows about every sample can tell you so.
 *  3. BIG THINGS ALSO HAVE TO CLEAR EACH OTHER, and the existing scenery. Two
 *     intersecting stacks are not a denser skyline. `getScenery()` is already
 *     placed 30-60m off the road, which is the same band the field families
 *     want, so it is tested against explicitly rather than hoped about.
 */
/*
 * `getTrackSamples()`, never the `TRACK_SAMPLES` binding.
 *
 * `export let` is live under real ESM and NOT live once transpiled to CJS — a
 * tool like jiti snapshots the namespace property at module init. Reading the
 * binding here therefore places every circuit's structures against Ash Spire's
 * sample array whenever this file is exercised headlessly, while
 * `getSurfaceAt` (a function, so always current) tests them against the real
 * one. The result looks like a working placement pass that quietly drops most
 * of a circuit, which is exactly what it did. Same trap as the one documented
 * on getTrackSamples() itself.
 */
import {
  duneProfile,
  getScenery,
  getSurfaceAt,
  getTrackSamples,
} from "../../track";
import { sampleDuneField, sampleRockMask } from "../terrainHeight";
import { APRON_M, mulberry32 } from "../scatter/placement";
import type { ArcWindow, CorridorPlacement, FieldPlacement, Zone } from "./types";

/** Breathing room between the run-off edge and the nearest structure face. */
const MARGIN = 1.2;

/**
 * Extra clearance a field structure keeps from an existing SCENERY landmark.
 *
 * SCENERY kits are 6-10m across at scale 1 and `settleScenery` pushes them to
 * `width/2 + 26 + scale*8`, i.e. into the exact 30-60m band the furnace stacks
 * and cranes want. 14m past the structure's own radius keeps the two sets
 * legible as separate objects.
 */
const SCENERY_CLEARANCE = 14;

/** Rejection-sampled tries per track sample, before the separation pass. */
const CANDIDATES_PER_SAMPLE = 3;

export type Anchor = {
  x: number;
  y: number;
  z: number;
  /** Road yaw at the governing sample. */
  yaw: number;
  /** Unit vector from the anchor toward the racing line, in XZ. */
  tx: number;
  tz: number;
  /** -1 / +1 in the EDGE_MARKERS convention, for corridor anchors. */
  side: number;
  index: number;
  /** Independent 0..1 variates for scale and yaw jitter. Stable per anchor. */
  a: number;
  b: number;
};

/** Ground height, from a surface query the caller already paid for. */
function settle(x: number, z: number, surf: ReturnType<typeof getSurfaceAt>) {
  return duneProfile(
    surf.sample.y,
    sampleDuneField(x, z),
    sampleRockMask(x, z),
    surf.dist,
    surf.half,
  );
}

/** Right-of-centreline unit vector, matching the EDGE_MARKERS convention. */
function rightOf(yaw: number): [number, number] {
  return [Math.cos(yaw), -Math.sin(yaw)];
}

function zoneAllowed(zone: Zone, zones?: Zone[]): boolean {
  return !zones || zones.length === 0 || zones.includes(zone);
}

/** Fraction-of-lap window, wrapping when `from > to`. */
function arcAllowed(i: number, n: number, arc?: ArcWindow): boolean {
  if (!arc) return true;
  const t = i / Math.max(1, n);
  const [from, to] = arc;
  return from <= to ? t >= from && t < to : t >= from || t < to;
}

/**
 * Modules on, then modules off, keyed on the anchor's ordinal.
 *
 * A solid ring of containers is a tunnel: it hides the circuit from itself and
 * turns every corner into a blind one. Breaking the run periodically is what
 * makes it read as a yard the road happens to run through.
 */
function inDuty(ordinal: number, runLen?: number, gapLen?: number): boolean {
  const run = runLen ?? 0;
  const gap = gapLen ?? 0;
  if (run <= 0 || gap <= 0) return true;
  return ordinal % (run + gap) < run;
}

/** Pushes outward until the whole loop is clear, or gives up. */
function solveAnchor(
  s: { x: number; z: number; yaw: number; width: number },
  index: number,
  side: number,
  p: CorridorPlacement,
  rng: () => number,
): Anchor | null {
  const [rx, rz] = rightOf(s.yaw);
  let off = s.width * 0.5 + APRON_M + p.offset;
  /*
   * Clearance is SOLVED, not tested, the way `vergePoints` solves it: a dropped
   * module is a hole in a wall, and a hole in a wall reads as broken where a
   * missing rock does not. The nominal offset uses the anchor's OWN half-width
   * while the test uses the half-width of whichever sample turns out to be
   * nearest, and track width runs 18-40m across the catalogue — so where those
   * disagree the wall simply bulges outward until it clears.
   *
   * Eight attempts rather than five: a push can land nearer a DIFFERENT leg of
   * the loop than the one it started from, and each such step only makes
   * progress once. Five ran out on the Dead Mile's return leg and silently
   * dropped most of its distance markers.
   */
  for (let attempt = 0; attempt < 8; attempt++) {
    const x = s.x + rx * side * off;
    const z = s.z + rz * side * off;
    const surf = getSurfaceAt(x, z);
    const need = surf.half + APRON_M + p.radius + MARGIN;
    if (surf.dist >= need) {
      return {
        x,
        z,
        y: settle(x, z, surf),
        yaw: s.yaw,
        // Toward the road is the opposite of the outward normal we walked.
        tx: -rx * side,
        tz: -rz * side,
        side,
        index,
        a: rng(),
        b: rng(),
      };
    }
    off += Math.max(0.5, need - surf.dist + 0.25);
  }
  return null;
}

/**
 * Anchors along the verge, GROUPED BY SIDE and in track order within a group.
 *
 * The grouping is not cosmetic and it is not obvious. Everything downstream of
 * this — `meanSpacing`, `linkedRuns`, and therefore every wall and pipeline —
 * looks at CONSECUTIVE entries and requires them to be neighbours on the same
 * verge. Emitting `[left(i), right(i), left(i+1), right(i+1), ...]` means no two
 * consecutive entries ever share a side, so `meanSpacing` collects no gaps at
 * all and falls back to its default, and `linkedRuns` produces no runs. The
 * result is a wall of twelve modules where eighty were asked for, with no error
 * anywhere. `vergePoints` gets away with interleaving only because its one
 * consumer is outside-only.
 */
export function corridorAnchors(p: CorridorPlacement): Anchor[] {
  const samples = getTrackSamples();
  const n = samples.length;
  const out: Anchor[] = [];
  if (n < 8) return out;

  const stride = Math.max(1, Math.round(p.stride));
  // Fixed seed: corridor anchors must be identical on every reload and every
  // tier, for the same reason the scatter fields must be — tier scaling is a
  // prefix of a stable list, not a reroll.
  const rng = mulberry32(0x5e701ece);

  /** One pass per verge for `both`; a single pass for everything else. */
  const passes: number[] = p.sides === "both" ? [-1, 1] : [0];

  for (const pass of passes) {
    let ordinal = 0;
    for (let k = p.phase ?? 0; k < n; k += stride) {
      const i = k % n;
      const s = samples[i]!;
      if (!zoneAllowed(s.zone, p.zones)) continue;
      if (!arcAllowed(i, n, p.arc)) continue;
      const ord = ordinal++;
      if (!inDuty(ord, p.runLen, p.gapLen)) continue;

      let wanted: number;
      if (pass !== 0) wanted = pass;
      else if (p.sides === "left") wanted = -1;
      else if (p.sides === "right") wanted = 1;
      else if (p.sides === "alternate") wanted = ord % 2 === 0 ? 1 : -1;
      else wanted = curvatureSide(i);

      const anchor = solveAnchor(s, i, wanted, p, rng);
      if (anchor) {
        out.push(anchor);
        continue;
      }
      /*
       * `alternate` is a rhythm, not a contract. Where the preferred verge has
       * no room — the loop doubles back over it — taking the other one keeps
       * the sequence intact; dropping it instead leaves a 200m hole in a run of
       * distance markers, which reads as the markers having stopped.
       *
       * `left`/`right` and the linked families deliberately do NOT fall back:
       * a pipeline that hops the road to get past an obstruction is worse than
       * a pipeline with a gap in it.
       */
      if (p.sides === "alternate") {
        const alt = solveAnchor(s, i, -wanted, p, rng);
        if (alt) out.push(alt);
      }
    }
  }
  return out;
}

/** Signed curvature at a sample; the outside of the bend is the far side of it. */
function curvatureSide(i: number): number {
  const samples = getTrackSamples();
  const n = samples.length;
  const reach = 3;
  const p = samples[i]!;
  const a = samples[(i - reach + n * 2) % n]!;
  const b = samples[(i + reach) % n]!;
  const cross =
    (p.x - a.x) * (b.z - p.z) - (p.z - a.z) * (b.x - p.x);
  return cross > 0 ? -1 : 1;
}

/**
 * Big structures scattered in a band, separated from each other.
 *
 * Candidates are rejection-sampled per track sample and then SHUFFLED before
 * the separation pass, which is what spreads the survivors around the whole
 * circuit: greedily accepting from a track-ordered list fills the first third
 * of the lap and leaves the rest empty.
 *
 * Candidates that fail are dropped, never nudged. A nudge is how a structure
 * ends up on a different leg of the same loop — the failure this file exists to
 * prevent — and at these counts losing candidates costs nothing.
 */
export function fieldAnchors(p: FieldPlacement): Anchor[] {
  const samples = getTrackSamples();
  const n = samples.length;
  if (n < 8) return [];

  const rng = mulberry32(p.seed);
  const span = p.far - p.near;
  const cand: Anchor[] = [];

  for (let i = 0; i < n; i++) {
    const s = samples[i]!;
    if (!zoneAllowed(s.zone, p.zones)) continue;
    if (!arcAllowed(i, n, p.arc)) continue;
    const b = samples[(i + 1) % n]!;
    const [rx, rz] = rightOf(s.yaw);

    // Several candidates per sample, because the separation pass below throws
    // most of them away: one per sample left a pool too thin to reach the
    // authored count once a 60m minimum spacing had been applied.
    for (let k = 0; k < CANDIDATES_PER_SAMPLE; k++) {
      const t = rng();
      const side = rng() < 0.5 ? -1 : 1;
      const off = s.width * 0.5 + APRON_M + p.near + rng() * span;
      const x = s.x + (b.x - s.x) * t + rx * side * off + (rng() - 0.5) * 14;
      const z = s.z + (b.z - s.z) * t + rz * side * off + (rng() - 0.5) * 14;

      const surf = getSurfaceAt(x, z);
      const va = rng();
      const vb = rng();
      if (surf.dist < surf.half + APRON_M + p.radius + MARGIN) continue;
      // The band is measured from the run-off edge, so a candidate flung past a
      // different leg of the loop can pass the clearance test while being 300m
      // from anything. Re-checking the realised distance keeps the family in
      // the band it was authored for — and, just as importantly, inside the
      // heightmap patch (see the note in ./presets.ts).
      const realised = surf.dist - (surf.half + APRON_M);
      if (realised < p.near || realised > p.far + 10) continue;

      const dx = surf.sample.x - x;
      const dz = surf.sample.z - z;
      const dl = Math.hypot(dx, dz) || 1;
      cand.push({
        x,
        z,
        y: settle(x, z, surf),
        yaw: surf.sample.yaw,
        tx: dx / dl,
        tz: dz / dl,
        side,
        index: i,
        a: va,
        b: vb,
      });
    }
  }

  for (let i = cand.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = cand[i]!;
    cand[i] = cand[j]!;
    cand[j] = tmp;
  }

  const scenery = getScenery();
  const keep: Anchor[] = [];
  const sep2 = p.separation * p.separation;
  const scenerySep = p.radius + SCENERY_CLEARANCE;
  const scenerySep2 = scenerySep * scenerySep;

  outer: for (const c of cand) {
    if (keep.length >= p.count) break;
    for (const k of keep) {
      const dx = c.x - k.x;
      const dz = c.z - k.z;
      if (dx * dx + dz * dz < sep2) continue outer;
    }
    for (const sc of scenery) {
      const dx = c.x - sc.x;
      const dz = c.z - sc.z;
      if (dx * dx + dz * dz < scenerySep2) continue outer;
    }
    keep.push(c);
  }
  return keep;
}

/**
 * Worst road overlap across a set of anchors, in metres.
 *
 * Positive means every anchor's footprint clears the drivable surface by at
 * least that much; negative is a structure the player drives through. Exists so
 * the placement can be ASSERTED headlessly rather than eyeballed from a
 * screenshot — the same reason scatter/fields.ts has no renderer dependency.
 */
export function worstClearance(anchors: Anchor[], radius: number): number {
  let worst = Infinity;
  for (const an of anchors) {
    const surf = getSurfaceAt(an.x, an.z);
    const slack = surf.dist - (surf.half + APRON_M + radius);
    if (slack < worst) worst = slack;
  }
  return worst;
}
