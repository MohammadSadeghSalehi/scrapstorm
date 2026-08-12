import type { CheckpointGate, SurfaceInfo, SurfaceKind, TrackSample } from "./types";
import { carrierSurfaceAt, setActiveCarriers } from "./world/carrier";
import { sampleDuneField, sampleRockMask } from "./world/terrainHeight";
import {
  getTerrainProfile,
  setActiveTerrainProfile,
} from "./world/terrainProfiles";
import { setActiveTunnels } from "./world/tunnels";

/**
 * The two launch circuits — and deliberately ONLY those.
 *
 * `src/game/types.ts` declares its own structurally identical `TrackId` that
 * `SimState.selectedTrack` is typed with, and this module does not own that
 * file. Widening the union HERE therefore breaks the build in files this module
 * cannot touch: sim.setTrack() assigns a track-module id into a types-module
 * field, and Menus passes a track-module id into a types-module callback (which
 * strictFunctionTypes checks contravariantly). So the narrow name stays narrow
 * and the catalogue gets its own wider one.
 *
 * The one-line fix, when someone owns both files: replace the declaration in
 * types.ts with `export type { AnyTrackId as TrackId } from "./track";` and
 * every `TrackId` below collapses back into one union.
 */
export type CoreTrackId = "ash_spire" | "cinder_bowl";

/**
 * The id type the rest of the game uses. Now the full catalogue: types.ts
 * re-exports AnyTrackId under this name, so the two must agree or every
 * assignment across the module boundary fails.
 */
export type TrackId = AnyTrackId;

/** Every circuit in the catalogue. What new code should be written against. */
export type AnyTrackId =
  | CoreTrackId
  | "rustline"
  | "sable_run"
  | "foundry_pit"
  | "dead_mile";

/**
 * What the circuit is FOR, in one word.
 *
 * Read by the mission catalogue: an elimination brawl wants "arena", a time
 * attack wants "speed". Missions pick tracks by character rather than by id so
 * that adding a circuit does not mean re-authoring the ladder.
 */
export type TrackCharacter =
  | "stadium"
  | "technical"
  | "speed"
  | "arena"
  | "endurance";

export interface TrackDef {
  id: AnyTrackId;
  name: string;
  tagline: string;
  description: string;
  character: TrackCharacter;
  /**
   * Default lap count for a free-play heat. RACE.laps is a single global three,
   * which is a 90s race on the Foundry Pit and a six-minute one on the Dead
   * Mile. Missions override this; nothing else reads it yet (see report).
   */
  laps: number;
}

/** A catalogue entry whose id is one of the two legacy ids. */
export type CoreTrackDef = TrackDef & { id: CoreTrackId };

/**
 * Every circuit. Ordered as a difficulty ramp — the ladder in
 * missions/rivals.ts walks it roughly in this order.
 */
export const TRACK_CATALOG: TrackDef[] = [
  {
    id: "ash_spire",
    name: "Ash Spire Circuit",
    tagline: "Stadium loop · combat arena",
    description: "Wide desert stadium with a jump bank and scrapyard hazard.",
    character: "stadium",
    laps: 3,
  },
  {
    id: "cinder_bowl",
    name: "Cinder Bowl",
    tagline: "Tight kidney · hairpin scrap",
    description: "Narrower technical bowl with a choke hazard and high banked turn.",
    character: "technical",
    laps: 3,
  },
  {
    id: "foundry_pit",
    name: "Foundry Pit",
    tagline: "Short lap · two bowls · chokes",
    description:
      "Half-kilometre brawl loop. Two open bowls joined by 20m chokes and a slag run — nowhere to hide, nowhere to disengage.",
    character: "arena",
    laps: 5,
  },
  {
    id: "rustline",
    name: "Rustline Gauntlet",
    tagline: "Narrow · chicane · conveyor ramp",
    description:
      "The tightest road in the league. Two squeezes, a scrap chicane taken at walking pace, and a collapsed conveyor that launches whatever survives.",
    character: "technical",
    laps: 4,
  },
  {
    id: "sable_run",
    name: "Sable Mile",
    tagline: "Wide sweepers · flat-out crest",
    description:
      "A mile and a half of fourth-gear geometry. Nothing here is tight; everything here is committed.",
    character: "speed",
    laps: 3,
  },
  {
    id: "dead_mile",
    name: "The Dead Mile",
    tagline: "Long haul · climb · far turn",
    description:
      "Out along the pipeline, up six metres of dead grade, around the far tanks and all the way back. Fuel, hull and patience all run out on the same lap.",
    character: "endurance",
    laps: 2,
  },
];

/**
 * The subset the existing garage UI can select.
 *
 * Derived rather than duplicated so the two lists cannot drift. Widening
 * types.ts (see CoreTrackId) makes this alias the whole catalogue.
 */
/**
 * Every circuit, selectable. Was filtered to the two launch tracks because the
 * id union could not express the others; now that it can, filtering would just
 * be four finished circuits nobody can reach.
 */
export const TRACK_DEFS: TrackDef[] = TRACK_CATALOG;

export function getTrackDef(id: AnyTrackId): TrackDef {
  return TRACK_CATALOG.find((d) => d.id === id) ?? TRACK_CATALOG[0]!;
}

export function isTrackId(value: string): value is AnyTrackId {
  return TRACK_CATALOG.some((d) => d.id === value);
}

type Ctrl = {
  x: number;
  z: number;
  y?: number;
  w?: number;
  zone?: TrackSample["zone"];
};

/*
 * ── authoring a circuit ───────────────────────────────────────────────
 *
 * A zone tag is a gameplay decision, not a label. Each one is read by three
 * unrelated systems:
 *
 *   "arena"   wide combat space. Beacons are placed on it (CulledBeacons), the
 *             road reads lighter (roadSegments.zoneColor) and the audio bus
 *             switches to the stadium reverb. Use it where you WANT the field
 *             to bunch up and trade paint.
 *   "hazard"  getSurfaceAt floors the offroad factor at 0.08 even on tarmac, so
 *             grip is permanently slightly wrong. Beacons + scrapyard reverb.
 *             This is a real speed penalty — a lap's worth of it is a lap you
 *             lose.
 *   "narrow"  no beacons, no colour change, tight/dry reverb. Pair it with a
 *             small `w`: width is what actually makes a section narrow, the tag
 *             only makes it SOUND narrow.
 *   "jump"    applyJumpLift raises the whole contiguous run as one arc. See
 *             JUMP_SHAPE.
 *   "race"    default.
 *
 * Zones flip at the midpoint of a control span (see buildSamples), so a tag on
 * a single control produces a section CENTRED on that control, running half a
 * span either side of it. Two adjacent tags produce half + full + half. That is
 * the only lever on section length, and for "jump" the section length L is the
 * whole design:
 *
 *     max grade    = 8.41 / L          (must stay under check-track-profile's 0.30)
 *     launch speed = 0.317 * L  m/s    (below this the crest is a hump you drive over)
 *
 * So L ≈ 55m is a violent pop off a slow corner, L ≈ 120m is the proven Ash
 * Spire ramp at ~40 m/s, and anything past ~250m stops being a jump at all
 * because nothing in the game goes that fast. Tag one control between short
 * spans for the former, two controls for the latter.
 *
 * Geometry rules, all of them learned the hard way:
 *  - Keep control spans within ~1.4x of their neighbours. Uniform Catmull-Rom
 *    takes its tangent as (P2-P0)/2 with no regard for spacing, so a short span
 *    next to a long one overshoots outward and can cusp.
 *  - Legs that run past each other must stay ~95m+ apart. settleScenery pushes
 *    props to width/2 + 26 + scale*8 (up to ~55m) from the NEAREST sample only,
 *    so two legs closer than that hand each other their scenery; and
 *    nearestTrackIndex can latch onto the wrong leg, which corrupts surface,
 *    zone and race progress at once.
 *  - The first ~35m past sample 0 is the grid (sim.makeVehicle staggers four
 *    cars over samples 2..11 at +-5.4m lateral). Keep it wide and reasonably
 *    straight.
 */

/**
 * Ash Spire Circuit — open desert stadium loop.
 * Wide road, large radii, parallel legs kept far apart.
 */
const ASH_SPIRE: Ctrl[] = [
  { x: 0, z: 0, w: 26, zone: "race" },
  { x: 40, z: -8, w: 26, zone: "race" },
  { x: 95, z: -35, w: 28, zone: "race" },
  { x: 145, z: -20, w: 30, zone: "arena" },
  { x: 175, z: 35, w: 32, zone: "arena" },
  { x: 165, z: 95, w: 28, zone: "arena" },
  { x: 120, z: 145, w: 26, zone: "race" },
  { x: 55, z: 165, w: 26, zone: "race" },
  { x: -20, z: 160, w: 28, zone: "hazard" },
  { x: -85, z: 130, w: 26, zone: "hazard" },
  { x: -130, z: 70, w: 24, zone: "jump" },
  { x: -140, z: 10, w: 24, zone: "jump" },
  { x: -115, z: -45, w: 26, zone: "race" },
  { x: -55, z: -55, w: 26, zone: "race" },
];

/**
 * Cinder Bowl — smaller kidney, tighter radii still corridor-safe.
 */
const CINDER_BOWL: Ctrl[] = [
  { x: -20, z: 10, w: 22, zone: "race" },
  { x: 30, z: 5, w: 22, zone: "race" },
  { x: 85, z: -25, w: 24, zone: "race" },
  { x: 110, z: 20, w: 24, zone: "arena" },
  { x: 100, z: 85, w: 26, zone: "arena", y: 1.2 },
  { x: 55, z: 120, w: 22, zone: "race" },
  { x: -10, z: 130, w: 20, zone: "hazard" },
  { x: -70, z: 100, w: 20, zone: "hazard" },
  { x: -105, z: 50, w: 20, zone: "jump" },
  { x: -100, z: -5, w: 20, zone: "jump" },
  { x: -70, z: -40, w: 22, zone: "race" },
  { x: -35, z: -20, w: 22, zone: "race" },
];

/**
 * Foundry Pit — arena brawl.
 *
 * The shortest lap in the league (~640m) and the only one built around fighting
 * rather than driving. Two 36-40m bowls, which is nearly three times the width
 * of a Rustline squeeze, joined by 20m chokes. The point is the transition: the
 * field spreads out in the bowl, then has to funnel through a gap two cars wide
 * with everyone's weapons up. Nobody gets to disengage — the lap is too short to
 * ever be more than a corner away from the pack.
 *
 * No jump zone. A ramp would launch cars over the very chokes the layout exists
 * to force them through.
 */
const FOUNDRY_PIT: Ctrl[] = [
  { x: 0, z: 0, w: 30, zone: "race" },
  { x: 54, z: -6, w: 28, zone: "race" },
  { x: 106, z: 14, w: 20, zone: "narrow" },
  { x: 146, z: 62, w: 36, zone: "arena" },
  { x: 150, z: 128, w: 40, zone: "arena" },
  { x: 110, z: 178, w: 34, zone: "arena" },
  { x: 52, z: 190, w: 20, zone: "narrow" },
  { x: -4, z: 174, w: 22, zone: "hazard" },
  { x: -46, z: 132, w: 24, zone: "hazard" },
  { x: -62, z: 76, w: 34, zone: "arena" },
  { x: -48, z: 20, w: 32, zone: "arena" },
];

/**
 * Rustline Gauntlet — tight technical.
 *
 * 18-24m road, corner radii around 45-70m against Ash Spire's 90-120, and a
 * three-point scrap chicane at the top of the loop that has to be taken at
 * something like walking pace. Top speed is almost irrelevant here; the whole
 * lap is brake, rotate, get back on the throttle.
 *
 * The scrap slalom at the top is three ~60° direction changes on ~59m spans,
 * with the apexes only 16m off the base line. That looks gentle written down —
 * the control polygon implies a 55m radius — and it is not: at a REVERSAL the
 * Catmull-Rom tangent (P2-P0)/2 points along the base line while the chords
 * either side point 30° off it, so the spline has to absorb the whole direction
 * change inside the control and the delivered radius is ~18m, a third of the
 * polygon's. Straight-line intuition about control points does not survive a
 * zigzag; measure it.
 *
 * 18m at w=22 leaves a 6m inner edge, still wider than Cinder Bowl's shipped
 * 14m at w=24. Do not add amplitude — halving it only bought 1m of radius, so
 * the lever here is very short and entirely in the wrong direction.
 *
 * The conveyor ramp is a single tagged control, but its two spans are stretched
 * to ~69m against the loop's ~55m so that L lands near 69 rather than near 47.
 * That reads low against Ash Spire's 40 m/s threshold, and it should: a ramp
 * wants to launch at the speed its circuit is actually driven at. At 47m it was
 * a 21m crest — nearly 4g at 28 m/s and considerably worse for anyone arriving
 * quicker — which on an 20m road is not a jump, it is a disqualification. At
 * 69m it is ~2g, which is the shipped Ash Spire feel.
 */
const RUSTLINE: Ctrl[] = [
  { x: 0, z: 0, w: 24, zone: "race" },
  { x: 58, z: 2, w: 24, zone: "race" },
  { x: 116, z: 16, w: 22, zone: "race" },
  { x: 166, z: 52, w: 20, zone: "narrow" },
  { x: 182, z: 108, w: 18, zone: "narrow" },
  { x: 166, z: 164, w: 20, zone: "narrow" },
  { x: 121, z: 183, w: 22, zone: "hazard" },
  { x: 69, z: 154, w: 22, zone: "hazard" },
  { x: 21, z: 188, w: 22, zone: "hazard" },
  { x: -46, z: 174, w: 20, zone: "jump" },
  { x: -88, z: 118, w: 22, zone: "race" },
  { x: -92, z: 58, w: 22, zone: "race" },
  { x: -66, z: 6, w: 24, zone: "race" },
];

/**
 * Sable Mile — high-speed sweeper.
 *
 * ~1.45km of nothing tighter than a 200m radius, on 26-34m road. Spans are
 * 100-130m, twice Rustline's, which is what actually makes it fast: the sample
 * curvature that the AI reads as "corner" and the physics reads as bank never
 * gets steep enough to make lifting worthwhile.
 *
 * The crest sits on the back straight rather than the pit straight, so the grid
 * is not airborne eight seconds after the flag. One tagged control between two
 * ~119m spans gives L ≈ 119m and a ~38 m/s launch — reachable everywhere on
 * this circuit, which is the point.
 *
 * The far side climbs 3.5m and comes back down. On a track with no corners to
 * speak of, elevation is the only thing left to hide the exit of a turn behind.
 */
const SABLE_RUN: Ctrl[] = [
  { x: 0, z: 0, w: 32, zone: "race" },
  { x: 128, z: -12, w: 32, zone: "race" },
  { x: 258, z: -6, w: 30, zone: "race" },
  { x: 366, z: 58, w: 28, zone: "race", y: 1.4 },
  { x: 418, z: 164, w: 28, zone: "race", y: 3.2 },
  { x: 398, z: 278, w: 30, zone: "arena", y: 3.5 },
  { x: 308, z: 358, w: 34, zone: "arena", y: 2.4 },
  { x: 188, z: 382, w: 32, zone: "race", y: 1.2 },
  { x: 72, z: 356, w: 30, zone: "jump" },
  { x: -32, z: 296, w: 28, zone: "hazard" },
  { x: -98, z: 198, w: 26, zone: "hazard" },
  { x: -86, z: 88, w: 30, zone: "race" },
];

/**
 * The Dead Mile — endurance.
 *
 * ~1.7km, the length of the other five put together minus one. Structurally it
 * is still a loop, because lap counting, checkpoint sectors and race progress
 * all assume the circuit closes — but it is authored to be DRIVEN as a
 * point-to-point: a 500m outbound run along the pipeline, a six-metre climb, a
 * far turn around the tanks, and a completely different road home. The outbound
 * and return legs are ~340m apart and share no scenery, so at no point does it
 * read as a lap of anything.
 *
 * The one cost, and it is a real one: HeightmapTerrain sizes its plane to the
 * track's bounding box but keeps a fixed 256x256 grid, so this circuit's 884m
 * span is 3.45m per quad against Ash Spire's 2.25m. The dunes are softer here.
 * That is the trade for scale; going much bigger is not free.
 *
 * Elevation is real rather than decorative: y climbs to 5.8m at the far turn, so
 * the run home is downhill and the hazard section at the bottom of it arrives
 * faster than anyone wants. The ramp at the top of the climb sits on a brow the
 * base profile is already making convex, which tightens the crest slightly
 * beyond what the lift alone would give.
 */
const DEAD_MILE: Ctrl[] = [
  { x: 0, z: 0, w: 28, zone: "race" },
  { x: 114, z: -8, w: 28, zone: "race" },
  { x: 230, z: -4, w: 26, zone: "race", y: 1.2 },
  { x: 342, z: 26, w: 26, zone: "race", y: 2.6 },
  { x: 438, z: 92, w: 24, zone: "jump", y: 4.2 },
  { x: 494, z: 190, w: 24, zone: "race", y: 5.4 },
  { x: 498, z: 300, w: 28, zone: "arena", y: 5.8 },
  { x: 446, z: 384, w: 32, zone: "arena", y: 5.0 },
  { x: 350, z: 420, w: 28, zone: "race", y: 4.0 },
  { x: 236, z: 414, w: 26, zone: "race", y: 3.0 },
  { x: 124, z: 392, w: 24, zone: "hazard", y: 2.0 },
  { x: 16, z: 356, w: 24, zone: "hazard", y: 1.0 },
  { x: -70, z: 288, w: 26, zone: "race", y: 0.4 },
  { x: -118, z: 194, w: 28, zone: "race" },
  { x: -110, z: 96, w: 28, zone: "race" },
  { x: -64, z: 40, w: 28, zone: "race" },
];

function catmullRom(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

function ctrlAt(ctrls: Ctrl[], i: number): Ctrl {
  const n = ctrls.length;
  return ctrls[((i % n) + n) % n]!;
}

/**
 * Metres between adjacent samples, targeted per span.
 *
 * This used to be a flat 20 subdivisions per control span, which is only a
 * constant density if every span is the same length. It is not: Sable Mile runs
 * 130m spans and the Rustline chicane runs 40m, so a fixed count would have put
 * 6.5m between samples on one and 2m on the other. Sample spacing is not an
 * internal detail — it is the resolution of the road ribbon in roadSegments,
 * the spacing of the starting grid (sim staggers cars three SAMPLES apart), and
 * the accuracy of buildCheckpointsFrom, which places gates by index and
 * silently assumes index is proportional to distance.
 *
 * 3.1m reproduces Ash Spire's existing density almost exactly, so the two
 * launch circuits are unchanged in all but the last decimal.
 */
const TARGET_SAMPLE_SPACING = 3.1;

/** Dense Catmull-Rom resampling with arc-length, yaw, bank. */
function buildSamples(ctrls: Ctrl[]): TrackSample[] {
  const n = ctrls.length;
  const raw: {
    x: number;
    y: number;
    z: number;
    w: number;
    zone: TrackSample["zone"];
  }[] = [];

  for (let i = 0; i < n; i++) {
    const c0 = ctrlAt(ctrls, i - 1);
    const c1 = ctrlAt(ctrls, i);
    const c2 = ctrlAt(ctrls, i + 1);
    const c3 = ctrlAt(ctrls, i + 2);
    // Chord underestimates the spline slightly on a curve; a few percent of
    // extra density on the tight stuff is the harmless direction to be wrong in.
    const chord = Math.hypot(c2.x - c1.x, c2.z - c1.z);
    const segsPer = Math.max(
      8,
      Math.min(44, Math.round(chord / TARGET_SAMPLE_SPACING)),
    );
    for (let s = 0; s < segsPer; s++) {
      const t = s / segsPer;
      const x = catmullRom(c0.x, c1.x, c2.x, c3.x, t);
      const z = catmullRom(c0.z, c1.z, c2.z, c3.z, t);
      const y0 = c0.y ?? 0;
      const y1 = c1.y ?? 0;
      const y2 = c2.y ?? 0;
      const y3 = c3.y ?? 0;
      const y = catmullRom(y0, y1, y2, y3, t);
      const zone = t < 0.5 ? (c1.zone ?? "race") : (c2.zone ?? "race");
      // Lift is applied below, once the whole section is known — it cannot be
      // computed here because it depends on arc length across a run of
      // samples that this loop has not finished producing.
      const w = (c1.w ?? 26) * (1 - t) + (c2.w ?? 26) * t;
      raw.push({ x, y, z, w, zone });
    }
  }

  applyJumpLift(raw);

  // Arc-length + yaw + bank
  const samples: TrackSample[] = [];
  let sAcc = 0;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]!;
    const b = raw[(i + 1) % raw.length]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const yaw = Math.atan2(-dx, -dz);
    // Bank from curvature (cross product of consecutive tangents)
    const c = raw[(i + raw.length - 1) % raw.length]!;
    const t0x = a.x - c.x;
    const t0z = a.z - c.z;
    const t1x = b.x - a.x;
    const t1z = b.z - a.z;
    const cross = t0x * t1z - t0z * t1x;
    const bank = Math.max(-1, Math.min(1, cross * 0.012));
    samples.push({
      x: a.x,
      y: a.y,
      z: a.z,
      yaw,
      width: a.w,
      zone: a.zone,
      s: sAcc,
      ...(Math.abs(bank) > 0.02 ? { bank } : {}),
    } as TrackSample & { bank?: number });
    sAcc += Math.hypot(dx, dz);
  }
  // Normalize s so last wraps to total length
  for (const sm of samples) {
    // s stays absolute arc length; TRACK_LENGTH is total
  }
  void sAcc;
  return samples;
}

/** Peak height of a jump ramp, in metres above the surrounding road. */
const JUMP_LIFT = 1.8;
/**
 * Crest sharpness. sin(u*PI) ** JUMP_SHAPE.
 *
 * A plain sine spread over the whole section is smooth but does not JUMP.
 * Launch needs the crest radius R to satisfy v^2/R > g, and R grows with
 * L^2/A: stretching the same 1.8m over a ~120m section instead of a ~60m
 * control span pushed R to 913m, i.e. 95 m/s to get airborne when the cars top
 * out near 84. The zone became a hump you drive over.
 *
 * Raising A is the wrong lever — it would take a 10m ramp. Curvature at the
 * crest scales linearly with this exponent instead, so it buys the launch back
 * without touching the height or the section length, and it makes the profile
 * MORE continuous at the boundaries rather than less: the first derivative of
 * sin^k is zero at both ends for any k > 1, where a plain sine's is not.
 *
 * The shape it produces — long shallow run-up into a defined crest — is also
 * closer to a real ramp than a pure sine hump.
 */
const JUMP_SHAPE = 5.5;

/**
 * Raise each jump section as one arc over its OWN arc length.
 *
 * The lift used to be sin(t * PI) * 1.8 where `t` is the parameter within a
 * single Catmull-Rom control span, gated on the per-sample `zone`. Two things
 * were wrong with that:
 *
 *  - `zone` flips at t = 0.5, so on the span where the jump run ended, samples
 *    just before the midpoint carried sin(0.5*PI) * 1.8 = the FULL 1.8m and
 *    samples just after carried none. That is a 1.8m vertical step between
 *    adjacent samples — a wall across the road, which the road and apron
 *    ribbons in roadSegments.ts inherit and any road decal then disagrees with.
 *  - The ramp was a property of a control SPAN, not of the jump section. A
 *    section covering three or more control points would have got one hump per
 *    interior span instead of a single ramp, and samples labelled "jump" on the
 *    approach span got no lift at all — so `zone === "jump"` and "is actually
 *    raised" disagreed. Gameplay and audio both key off `zone`.
 *
 * Keying on arc length across the contiguous run fixes both: sin is zero at
 * both ends of the section by construction, so it meets the flat road on either
 * side exactly, and the whole labelled section is the ramp.
 *
 * Runs wrap the array, because the circuit is a loop and a jump section is free
 * to straddle the seam.
 */
function applyJumpLift(
  raw: { x: number; y: number; z: number; w: number; zone: TrackSample["zone"] }[],
): void {
  const n = raw.length;
  if (n < 3) return;

  const seg: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = raw[i]!;
    const b = raw[(i + 1) % n]!;
    seg[i] = Math.hypot(b.x - a.x, b.z - a.z);
  }

  const isJump = (i: number) => raw[i]!.zone === "jump";

  // Start scanning at a sample that begins a run, so a run straddling index 0
  // is walked as one piece rather than as two truncated halves.
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (isJump(i) && !isJump((i - 1 + n) % n)) {
      start = i;
      break;
    }
  }
  // No boundary at all means either no jump zone or the entire loop is one,
  // and a lift with no flat road to return to is meaningless either way.
  if (start < 0) return;

  let i = 0;
  while (i < n) {
    const head = (start + i) % n;
    if (!isJump(head)) {
      i++;
      continue;
    }
    let len = 1;
    while (len < n && isJump((start + i + len) % n)) len++;

    // Arc length from the first sample of the run to the last.
    let total = 0;
    for (let k = 0; k < len - 1; k++) total += seg[(start + i + k) % n]!;

    if (total > 1e-3) {
      let acc = 0;
      for (let k = 0; k < len; k++) {
        const idx = (start + i + k) % n;
        const u = acc / total;
        raw[idx]!.y += Math.sin(u * Math.PI) ** JUMP_SHAPE * JUMP_LIFT;
        acc += seg[idx]!;
      }
    }
    i += len;
  }
}

function buildCheckpointsFrom(samples: TrackSample[], count = 14): CheckpointGate[] {
  const n = samples.length;
  const gates: CheckpointGate[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor((i / count) * n) % n;
    const s = samples[idx]!;
    const nx = -Math.sin(s.yaw); // along-track normal (forward)
    const nz = -Math.cos(s.yaw);
    gates.push({
      index: i,
      x: s.x,
      z: s.z,
      nx,
      nz,
      halfWidth: s.width * 0.62,
    });
  }
  return gates;
}

function buildEdgeMarkersFrom(
  samples: TrackSample[],
): { x: number; y: number; z: number; side: number }[] {
  const markers: { x: number; y: number; z: number; side: number }[] = [];
  const step = Math.max(1, Math.floor(samples.length / 94));
  for (let i = 0; i < samples.length; i += step) {
    const s = samples[i]!;
    const rx = Math.cos(s.yaw);
    const rz = -Math.sin(s.yaw);
    const half = s.width * 0.5;
    for (const side of [-1, 1] as const) {
      markers.push({
        x: s.x + rx * side * half,
        y: s.y,
        z: s.z + rz * side * half,
        side,
      });
    }
  }
  return markers;
}

type SceneryItem = {
  x: number;
  z: number;
  /** Ground height at (x, z) — filled in by settleScenery, never guessed. */
  y: number;
  kind: "tower" | "pile" | "pipe" | "crane";
  scale: number;
  rot: number;
};

function buildSceneryFrom(samples: TrackSample[]): SceneryItem[] {
  const items: SceneryItem[] = [];
  const kinds: SceneryItem["kind"][] = ["tower", "pile", "pipe", "crane"];
  // Sparser and set further back. These are 6-8m untextured boxes; at 14m from
  // the road edge they loomed over the racing line and read as slabs dumped
  // beside the track rather than as a distant refinery skyline.
  const step = Math.max(6, Math.floor(samples.length / 16));
  for (let i = 3; i < samples.length; i += step) {
    const s = samples[i]!;
    const rx = Math.cos(s.yaw);
    const rz = -Math.sin(s.yaw);
    const side = i % 2 === 0 ? 1 : -1;
    const off = s.width * 0.5 + 34 + (i % 5) * 6;
    items.push({
      x: s.x + rx * side * off,
      z: s.z + rz * side * off,
      y: 0,
      kind: kinds[i % kinds.length]!,
      scale: 0.9 + (i % 4) * 0.18,
      rot: (i * 0.37) % (Math.PI * 2),
    });
  }
  // Landmark anchors near start (shared with worldProps / decor)
  const s0 = samples[0];
  if (s0) {
    items.push(
      { x: s0.x + 40, z: s0.z + 60, y: 0, kind: "tower", scale: 1.4, rot: 0.3 },
      { x: s0.x + 20, z: s0.z + 50, y: 0, kind: "crane", scale: 1.2, rot: 1.1 },
      { x: s0.x + 55, z: s0.z + 40, y: 0, kind: "pile", scale: 1.6, rot: 0.5 },
      { x: s0.x - 10, z: s0.z + 70, y: 0, kind: "pipe", scale: 1.1, rot: 0.8 },
      { x: s0.x + 70, z: s0.z - 20, y: 0, kind: "crane", scale: 1.3, rot: 2.1 },
      { x: s0.x - 40, z: s0.z + 30, y: 0, kind: "tower", scale: 1.15, rot: 0.9 },
    );
  }
  return settleScenery(items, samples);
}

/*
 * Push every scenery item clear of the tarmac.
 *
 * The ring placement above derives its position from a track sample, so it is
 * clear of THAT sample by construction - but a circuit doubles back, and the
 * landmark anchors are raw world offsets from the start point that consult the
 * track not at all. Either can land on a part of the loop they never looked at.
 * That is how a crane ended up straddling the road with nothing to hit: the
 * scenery collider is a ground-level circle, so a gantry overhead has no
 * collision by design and the only real fix is not to put it there.
 *
 * Brute force over samples - a few hundred points against ~22 items, once per
 * track build.
 */
function settleScenery(
  items: SceneryItem[],
  samples: TrackSample[],
): SceneryItem[] {
  if (!samples.length) return items;
  return items.map((it) => {
    let best = Infinity;
    let bs: TrackSample = samples[0]!;
    for (const s of samples) {
      const dx = it.x - s.x;
      const dz = it.z - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) {
        best = d2;
        bs = s;
      }
    }
    // Footprint grows with scale; these kits run 6-10m across at scale 1.
    const need = bs.width * 0.5 + 26 + it.scale * 8;
    let d = Math.sqrt(best);
    let { x, z } = it;
    if (d < need) {
      // Push out along the away-from-centreline direction. Degenerate case
      // (item sitting exactly on a sample) falls back to the sample's normal.
      let nx = it.x - bs.x;
      let nz = it.z - bs.z;
      if (d < 1e-3) {
        nx = Math.cos(bs.yaw);
        nz = -Math.sin(bs.yaw);
      } else {
        nx /= d;
        nz /= d;
      }
      x = bs.x + nx * need;
      z = bs.z + nz * need;
      d = need;
    }
    const y = duneProfile(
      bs.y,
      sampleDuneField(x, z),
      sampleRockMask(x, z),
      d,
      bs.width * 0.5,
    );
    return { ...it, x, z, y };
  });
}

/* ── mutable active track state ───────────────────────────────────── */

let activeId: AnyTrackId = "ash_spire";
let trackEpoch = 1;

/**
 * Control lists only — nothing here is built until it is asked for.
 *
 * Six circuits is six arrays of a dozen literals. The samples, checkpoints,
 * edge markers and scenery for a track are derived in rebuild() and only ever
 * for the ACTIVE one, so the catalogue growing costs the running race nothing.
 * Resist the urge to memoise the built packs: the cost of a rebuild is a few
 * hundred spline evaluations, and holding six of everything alive would cost
 * more in resident memory than it ever saves on a track change.
 */
const CTRLS: Record<AnyTrackId, Ctrl[]> = {
  ash_spire: ASH_SPIRE,
  cinder_bowl: CINDER_BOWL,
  foundry_pit: FOUNDRY_PIT,
  rustline: RUSTLINE,
  sable_run: SABLE_RUN,
  dead_mile: DEAD_MILE,
};

function ctrlsFor(id: AnyTrackId): Ctrl[] {
  return CTRLS[id] ?? ASH_SPIRE;
}

/**
 * Bounding-box centre of a sample list, and the furthest sample from it.
 *
 * The radial landforms (a crater rim, a pit wall) have to be placed relative to
 * the racing surface, not at a world constant: the six circuits' centres are
 * 300m apart and their reach differs by a factor of three, so a rim radius that
 * encloses Cinder Bowl would sit inside the Dead Mile's back straight.
 */
function circuitAnchor(samples: TrackSample[]) {
  if (!samples.length) return { cx: 18, cz: 54, extent: 168 };
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of samples) {
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.z < minZ) minZ = s.z;
    if (s.z > maxZ) maxZ = s.z;
  }
  const cx = (minX + maxX) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  let extent = 0;
  for (const s of samples) {
    const d = Math.hypot(s.x - cx, s.z - cz);
    if (d > extent) extent = d;
  }
  return { cx, cz, extent };
}

function rebuild(id: AnyTrackId) {
  const ctrls = ctrlsFor(id);
  const samples = buildSamples(ctrls);
  /*
   * Point the height field at this circuit BEFORE anything settles onto it.
   *
   * `buildSceneryFrom` -> `settleScenery` evaluates duneProfile inside this
   * same call, so a profile pushed after it would place 23 pieces of scenery on
   * the previous circuit's landform and leave them buried in, or hovering over,
   * the new one.
   */
  setActiveTerrainProfile(id, circuitAnchor(samples));
  /*
   * Set pieces that own a piece of the GROUND, resolved in the same place and
   * for the same reason as the terrain profile: `getGroundHeight` consults the
   * carrier deck, and `settleScenery` runs later in this very call. A carrier
   * pushed after it would be a ramp the ground query knows about and the world
   * placement does not.
   *
   * (Scenery cannot land on a deck anyway — settleScenery pushes every item to
   * at least half + 26m from the centreline and the deck lives inside 12m — but
   * the ordering is the contract, not the current margin.)
   */
  setActiveCarriers(id, samples);
  setActiveTunnels(id, samples);
  const length = samples[samples.length - 1]?.s
    ? samples[samples.length - 1]!.s +
      Math.hypot(
        samples[0]!.x - samples[samples.length - 1]!.x,
        samples[0]!.z - samples[samples.length - 1]!.z,
      )
    : 1;
  // Fix last sample s to total loop length conceptually via TRACK_LENGTH
  return {
    samples,
    length,
    checkpoints: buildCheckpointsFrom(samples, 14),
    edges: buildEdgeMarkersFrom(samples),
    scenery: buildSceneryFrom(samples),
  };
}

let pack = rebuild("ash_spire");

export let TRACK_SAMPLES: TrackSample[] = pack.samples;
export let TRACK_LENGTH = pack.length;
export let CHECKPOINTS: CheckpointGate[] = pack.checkpoints;
export let EDGE_MARKERS = pack.edges;
export let SCENERY: SceneryItem[] = pack.scenery;
syncSceneryHeights();

/**
 * Re-derive scenery `y` from the real ground query, once the track is live.
 *
 * settleScenery has to approximate: it runs inside rebuild(), before
 * TRACK_SAMPLES and activeId are assigned, so getSurfaceAt is not usable yet
 * and it falls back to nearest-SAMPLE distance. getSurfaceAt measures exact
 * point-to-segment, and on the berm roll-off those disagree by up to ~0.4m —
 * enough to leave a crane visibly hovering. Cheap to redo (23 items), and it
 * guarantees scenery sits on exactly the surface physics reports rather than on
 * a second, slightly different copy of the height curve.
 */
function syncSceneryHeights() {
  if (!TRACK_SAMPLES.length) return;
  for (const s of SCENERY) s.y = getGroundHeight(s.x, s.z);
}

export function getTrackEpoch() {
  return trackEpoch;
}

export function setActiveTrack(id: AnyTrackId) {
  if (id === activeId && TRACK_SAMPLES.length > 0) return;
  activeId = id;
  pack = rebuild(id);
  TRACK_SAMPLES = pack.samples;
  TRACK_LENGTH = pack.length;
  CHECKPOINTS = pack.checkpoints;
  EDGE_MARKERS = pack.edges;
  SCENERY = pack.scenery;
  syncSceneryHeights();
  trackEpoch += 1;
}

/**
 * Live accessors for the mutable track exports.
 *
 * `export let TRACK_SAMPLES` is a live binding under real ESM, but that
 * guarantee does NOT survive transpilation to CJS: a tool like jiti snapshots
 * the namespace property at module init, so a consumer that calls
 * setActiveTrack and then reads TRACK_SAMPLES gets the OLD array while
 * getActiveTrackId() correctly reports the new id. A verification script built
 * on that read cinder_bowl and silently reported ash_spire twice — identical
 * sample count, identical worst step, identical index — which is exactly the
 * kind of quiet agreement that looks like a passing test.
 */
export function getTrackSamples(): TrackSample[] {
  return TRACK_SAMPLES;
}

export function getEdgeMarkers() {
  return EDGE_MARKERS;
}

export function getCheckpoints(): CheckpointGate[] {
  return CHECKPOINTS;
}

/**
 * Centreline length of the ACTIVE circuit, in metres.
 *
 * Missions state pace targets as metres per second and resolve them against
 * this at arm time rather than storing lap times. A lap time is not portable
 * data: 32s is a strong lap on Cinder Bowl and an abandoned one on the Dead
 * Mile, so a hardcoded target silently becomes a different difficulty on every
 * circuit it is copied to.
 */
export function getTrackLength(): number {
  return TRACK_LENGTH;
}

export function getScenery(): SceneryItem[] {
  return SCENERY;
}

export function getActiveTrackId(): AnyTrackId {
  return activeId;
}

/* ── queries ──────────────────────────────────────────────────────── */

export function nearestTrackIndex(
  x: number,
  z: number,
  hintYaw?: number,
): number {
  const samples = TRACK_SAMPLES;
  const n = samples.length;
  if (n === 0) return 0;
  let best = 0;
  let bestD = Infinity;
  // Coarse then refine
  const step = Math.max(1, Math.floor(n / 48));
  for (let i = 0; i < n; i += step) {
    const s = samples[i]!;
    let d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
    if (hintYaw !== undefined) {
      const dy = Math.atan2(
        Math.sin(s.yaw - hintYaw),
        Math.cos(s.yaw - hintYaw),
      );
      d += dy * dy * 18;
    }
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  // Local refine
  for (let k = -step; k <= step; k++) {
    const i = ((best + k) % n + n) % n;
    const s = samples[i]!;
    let d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
    if (hintYaw !== undefined) {
      const dy = Math.atan2(
        Math.sin(s.yaw - hintYaw),
        Math.cos(s.yaw - hintYaw),
      );
      d += dy * dy * 18;
    }
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Race standings progress = whole laps + [0..1) around the circuit.
 * Sequential checkpoint is the authority; arc-length refines within sector.
 */
export function trackProgress(
  x: number,
  z: number,
  lap: number,
  checkpoint: number,
  hintYaw?: number,
): number {
  const n = Math.max(1, CHECKPOINTS.length);
  const sectorFloor = checkpoint === 0 ? (n - 1) / n : checkpoint / n;
  const sectorCeil = checkpoint === 0 ? 1 : Math.min(1, (checkpoint + 1) / n);
  const idx = nearestTrackIndex(x, z, hintYaw);
  const sample = TRACK_SAMPLES[idx];
  const arc = sample ? sample.s / Math.max(1e-6, TRACK_LENGTH) : sectorFloor;

  let within: number;
  if (arc + 0.2 < sectorFloor) {
    within = sectorFloor;
  } else if (arc > sectorCeil + 0.25 && checkpoint !== 0) {
    within = sectorCeil - 1e-4;
  } else {
    const lo = sectorFloor;
    const hi = sectorCeil - 1e-4;
    within = Math.max(lo, Math.min(hi, arc));
  }
  return lap + within;
}

export function sampleAtProgress(progress: number): TrackSample {
  const frac = ((progress % 1) + 1) % 1;
  const targetS = frac * TRACK_LENGTH;
  const samples = TRACK_SAMPLES;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const d = Math.abs(samples[i]!.s - targetS);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return samples[best] ?? samples[0]!;
}

export function getSurfaceAt(
  x: number,
  z: number,
  hintYaw?: number,
): SurfaceInfo {
  const idx = nearestTrackIndex(x, z, hintYaw);
  const sample = TRACK_SAMPLES[idx] ?? {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    width: 26,
    zone: "race" as const,
    s: 0,
  };
  // Refine against the two adjacent centreline segments rather than trusting
  // the distance to the nearest sample point. Midway between two samples the
  // point distance reads as half their spacing even when you are dead centre
  // on the road, which pushed the apron/dune blend inward and disagreed with
  // the visual mesh (see buildTrackField in HeightmapTerrain).
  const n = TRACK_SAMPLES.length;
  let dist = Math.hypot(x - sample.x, z - sample.z);
  if (n > 1) {
    for (let k = -1; k <= 0; k++) {
      const a = TRACK_SAMPLES[(idx + k + n) % n]!;
      const b = TRACK_SAMPLES[(idx + k + 1 + n) % n]!;
      const sx = b.x - a.x;
      const sz = b.z - a.z;
      const len2 = sx * sx + sz * sz;
      if (len2 < 1e-6) continue;
      const t = Math.min(1, Math.max(0, ((x - a.x) * sx + (z - a.z) * sz) / len2));
      const d = Math.hypot(x - (a.x + sx * t), z - (a.z + sz * t));
      if (d < dist) dist = d;
    }
  }
  const half = sample.width * 0.5;

  let kind: SurfaceKind = "asphalt";
  let factor = 0;
  if (dist <= half) {
    kind = "asphalt";
    factor = 0;
  } else if (dist <= half + 5.5) {
    kind = "apron";
    factor = (dist - half) / 5.5;
  } else if (dist <= half + 22) {
    kind = "sand";
    factor = 0.35 + ((dist - half - 5.5) / 16.5) * 0.5;
  } else {
    kind = "deep";
    factor = 0.85 + Math.min(0.15, (dist - half - 22) * 0.01);
  }

  if (sample.zone === "hazard" && kind === "asphalt") {
    factor = Math.max(factor, 0.08);
  }

  const roughness =
    kind === "asphalt"
      ? 0.08
      : kind === "apron"
        ? 0.35
        : kind === "sand"
          ? 0.7
          : 0.95;

  return { kind, factor, roughness, dist, half, sample };
}

/**
 * Physics ground height — road corridor flat, dunes rise off-track.
 * Amplitude boosted for AAA desert silhouette (cars stay on flat asphalt).
 */
export function getGroundHeight(x: number, z: number): number {
  const surf = getSurfaceAt(x, z);
  const ground = duneProfile(
    surf.sample.y,
    sampleDuneField(x, z),
    sampleRockMask(x, z),
    surf.dist,
    surf.half,
  );
  /*
   * Drivable structure is part of the GROUND, not a collider.
   *
   * `integratePos` lifts a car by exactly one mechanism: the value this function
   * returns. A ramp expressed as a capsule would be something you scrape along —
   * `deflectOffStatic` has no vertical axis and cannot be given one without
   * becoming the impulse solver this project already removed twice. Expressed
   * here it costs an axis-aligned box reject per query and the suspension,
   * airborne test and landing all work with no further plumbing.
   *
   * `max`, not a replacement: the deck is above the desert or it is not there
   * (`carrierSurfaceAt` returns -Infinity outside its footprint), and a deck
   * that could ever LOWER the ground would be a hole in the world.
   */
  const deck = carrierSurfaceAt(x, z);
  return deck > ground ? deck : ground;
}

/**
 * The desert height profile, as a pure function of (road height, dune noise,
 * distance from centreline, half-width).
 *
 * Split out of getGroundHeight so that anything PLACING geometry can land on
 * exactly the surface physics will report, without needing the active track
 * state — AND so that the terrain MESH is built from the same numbers. It was
 * not: HeightmapTerrain carried its own copy of this curve, and the two had
 * already drifted (dune 16 vs 16.5, and a rock-mask term worth up to 3.5m that
 * only the visible side had). The ground you saw and the ground you drove on
 * were different surfaces by several metres in the open desert. Scenery, decor and props all used to sit at the road plane (`s.y`) or
 * at a literal `0`, neither of which is where the ground is once you are more
 * than a couple of metres off the tarmac — which is the whole reason crates and
 * pipes were hanging in mid-air. Any placement code that duplicated this curve
 * instead of calling it would drift out of sync the moment one copy changed, so
 * there is deliberately only one.
 */
export function duneProfile(
  roadY: number,
  dune: number,
  rock: number,
  dist: number,
  half: number,
): number {
  /*
   * The amplitudes are per-circuit, the BANDS are not.
   *
   * A crater rim and a playa need wildly different metres of relief, but the
   * three distance bands — dead-flat corridor, berm roll-off, open ground — are
   * a gameplay contract, not art: they are what guarantees a car never clips
   * terrain at the edge of the tarmac and what every placement site assumes
   * when it settles an object. So the shape of the curve is fixed here and only
   * its scale comes from the table. Ash Spire's entries are the literals this
   * function used to carry, so its ground is unchanged.
   */
  const p = getTerrainProfile();

  // Asphalt + tight shoulder: dead flat so cars never clip dunes
  const roadPad = half + 2.5;
  if (dist <= roadPad) {
    return roadY;
  }

  const apron = half + 22;
  const deep = half + 70;

  if (dist < apron) {
    // Soft roll-off berm
    const t = (dist - roadPad) / Math.max(0.01, apron - roadPad);
    const s = t * t * (3 - 2 * t);
    return roadY + (dune * p.bermDune + rock * p.bermRock) * s;
  }

  if (dist < deep) {
    const t = (dist - apron) / Math.max(0.01, deep - apron);
    const s = t * t * (3 - 2 * t);
    /*
     * `hNear` tracks `base` rather than staying at the literal 1.0 it used to
     * be. On a circuit whose open ground sits LOWER than one metre — the playa
     * does, deliberately — a fixed 1.0 makes the mid band start above where it
     * ends, so the ground dips as it leaves the verge and then climbs back.
     * Clamped rather than substituted so Ash Spire (base 1.1) still gets 1.0.
     */
    const hNear = Math.min(1.0, p.base);
    const hFar = p.base + dune * p.midDune + rock * p.midRock;
    return roadY + hNear + (hFar - hNear) * s;
  }

  // Open ground — the full landform, and the circuit's silhouette.
  return roadY + p.base + dune * p.farDune + rock * p.farRock;
}

export function isOnTrack(
  x: number,
  z: number,
  hintYaw?: number,
): {
  on: boolean;
  half: number;
  dist: number;
  sample: TrackSample;
} {
  const surf = getSurfaceAt(x, z, hintYaw);
  return {
    on: surf.kind === "asphalt" || surf.factor < 0.2,
    half: surf.half,
    dist: surf.dist,
    sample: surf.sample,
  };
}
