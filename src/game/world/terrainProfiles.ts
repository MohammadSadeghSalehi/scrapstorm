/**
 * What the GROUND of a circuit is, as data.
 *
 * `environments/` already gives every circuit its own sky, light, palette and
 * skyline. What it does not give it is a different PLACE to stand: all six
 * shared one domain-warped dune generator, one road ribbon and one set of
 * surface packs, recoloured. Six deserts wearing six lighting rigs.
 *
 * So this table carries the two things a palette cannot fake:
 *
 *  1. LANDFORM — which generator produces the height field at all. A crater rim
 *     is not a dune field with a different amplitude; a playa is not a dune
 *     field with a low one. The redistribution curve is the landform, and
 *     amplitude only scales whatever shape it already had.
 *
 *  2. SURFACE — which tiled PBR pack the tarmac, apron and yard wear, and at
 *     what texel density. Poured concrete slabs are not asphalt aggregate at a
 *     different tint, and the tile size is half of what says so.
 *
 * WHY IT IS NOT A FIELD ON `EnvironmentDef`. It should be, and that is the
 * intended endpoint — see the report. It is here because `environments/` was
 * being edited concurrently by another pass, and a table keyed by the same
 * track ids merges into `EnvironmentDef` mechanically later, whereas a
 * half-merged `EnvironmentDef` does not.
 *
 * WHY THIS MODULE IMPORTS NOTHING AT RUNTIME. `track.ts` imports
 * `world/terrainHeight.ts`, and terrainHeight needs the active landform. If
 * this module reached back for `getActiveTrackId()` the cycle would be
 * track -> terrainHeight -> terrainProfiles -> track, which real ESM tolerates
 * and jiti's CJS transpile does not reliably (see AGENTS.md §4). So the flow is
 * strictly one-way: `track.ts` PUSHES the active id and the circuit's anchor in
 * here as part of its rebuild, and everything downstream pulls.
 */
import type { PbrPackId } from "./webgl2/textureLibrary";
import type { AnyTrackId } from "../track";

/**
 * Which generator in `terrainHeight.ts` produces the field.
 *
 * Deliberately a closed union rather than a function reference: the height
 * curve has to be identical between the visible mesh and physics, and a
 * callable stored in a table is a callable somebody can swap for one circuit
 * and one consumer. An id can only ever select the same branch everywhere.
 */
export type LandformId =
  | "dunes"
  | "crater"
  | "benches"
  | "mesa"
  | "playa"
  | "corrugation";

/**
 * Where the circuit is, so a radial landform has something to be radial about.
 *
 * Pushed in by `track.ts` from the sample bounding box. A crater whose rim is
 * placed at a world constant is a crater in the wrong place on five of six
 * circuits; `extent` (the furthest sample from the centre) is what lets the rim
 * be expressed as "outside the racing surface" rather than as a metre count
 * that happens to work on one layout.
 */
export type TerrainAnchor = { cx: number; cz: number; extent: number };

export type TerrainProfile = {
  landform: LandformId;

  /* ── height curve, metres. Consumed by `duneProfile` in track.ts ──────── */
  /**
   * Constant lift applied everywhere past the apron. Keep it >= 0: the flat
   * sand underlay sits at y = -2.8 and shows through anything that dips below
   * the road plane.
   */
  base: number;
  /** Berm roll-off, from the edge of the shoulder to half + 22. */
  bermDune: number;
  bermRock: number;
  /** Mid band, half + 22 out to half + 70. */
  midDune: number;
  midRock: number;
  /** Open ground past half + 70. This is the number that sets the silhouette. */
  farDune: number;
  farRock: number;

  /* ── the independent rock/crust mask ──────────────────────────────────── */
  /**
   * Noise frequency and exponent of `sampleRockMask`. Low frequency reads as
   * broad mineral staining, high as patchy debris; the exponent decides how
   * much of the map the mask covers at all.
   */
  rockFreq: number;
  rockPower: number;

  /* ── outward taper ────────────────────────────────────────────────────── */
  /**
   * Radii (metres from the anchor) between which the landform relaxes to
   * `edgeLevel`.
   *
   * This is not art polish, it is a clearance requirement. The world-locked
   * mountain ring starts at MID_INNER_R = 300m from the same centre and its
   * inner rows are only buried 40m below their base, so a 30m crater rim left
   * running out to the edge of a 440m half-span terrain plane would collide
   * with the range rather than sit inside it. Tapering also removes the hard
   * step where the heightfield ends and the flat sand tiles take over.
   *
   * `Infinity` disables it — correct for the dune field, which is what the ring
   * was tuned against in the first place.
   */
  fadeFrom: number;
  fadeTo: number;
  /** Field value the taper lands on, 0..1. Multiply by farDune for metres. */
  edgeLevel: number;

  /* ── surfaces ─────────────────────────────────────────────────────────── */
  /**
   * Packs for the three built surfaces around the circuit. Colour still comes
   * from `EnvironmentDef.surfaces` — this chooses the MATERIAL, that tints it.
   */
  roadPack: PbrPackId;
  apronPack: PbrPackId;
  yardPack: PbrPackId;
  /** Metres of world per texture tile. Slab concrete is coarse, grit is fine. */
  roadTileM: number;
  apronTileM: number;
  /** Yard tiling is authored as a UV repeat, not a metre count — see TrackMesh. */
  yardRepeat: number;
  /**
   * Road material response. Sand-scoured asphalt is not fresh asphalt at a
   * different tint: it has lost its specular lobe and most of its aggregate
   * relief, and both of those are numbers.
   */
  roadRoughness: number;
  roadMetalness: number;
  roadNormalScale: number;
};

/* Shared defaults, so a profile states only what makes it that circuit. */
const DESERT_ROCK = { rockFreq: 0.018, rockPower: 1.6 };

/**
 * Six grounds.
 *
 * ash_spire is the REFERENCE and its numbers are a transcription of the
 * literals that used to live inside `duneProfile`, `sampleDuneField` and
 * `TrackMesh` — bit-for-bit, including the fade being off. The reference
 * circuit must not change appearance when a table is introduced underneath it,
 * or there is no way to tell a regression from the intended redesign of the
 * other five.
 */
export const TERRAIN_PROFILES: Record<AnyTrackId, TerrainProfile> = {
  /**
   * ASH SPIRE — open wind-built dune sea.
   *
   * Barchan crests, soft valleys, and rock only where the wind has stripped a
   * face. The one circuit where the ground is genuinely nothing but sand.
   */
  ash_spire: {
    landform: "dunes",
    base: 1.1,
    bermDune: 1.2,
    bermRock: 0.35,
    midDune: 14,
    midRock: 3,
    farDune: 16,
    farRock: 3.5,
    ...DESERT_ROCK,
    fadeFrom: Infinity,
    fadeTo: Infinity,
    edgeLevel: 0,
    roadPack: "asphalt",
    apronPack: "gravel",
    yardPack: "rock",
    roadTileM: 5.5,
    apronTileM: 3.5,
    yardRepeat: 0.035,
    roadRoughness: 0.72,
    roadMetalness: 0.06,
    roadNormalScale: 0.9,
  },

  /**
   * CINDER BOWL — a volcanic ash crater, raced on its floor.
   *
   * The whole circuit sits inside a rim. The floor is near flat because settled
   * ash IS near flat: what relief it has is centimetre-scale ripple, and the
   * drama is entirely in the wall standing 30m up all the way round. Rock is
   * rare (high exponent) — there is no bedrock showing through, only ash.
   *
   * Surface: asphalt scoured by the ash it sits in, so a low normal scale and a
   * roughness near matte, with an ash apron rather than gravel.
   */
  cinder_bowl: {
    landform: "crater",
    base: 0.7,
    // Almost nothing beside the tarmac: an ash floor does not berm.
    bermDune: 0.8,
    bermRock: 0.2,
    midDune: 24,
    midRock: 1.6,
    farDune: 30,
    farRock: 2,
    rockFreq: 0.026,
    rockPower: 2.4,
    fadeFrom: 255,
    fadeTo: 335,
    edgeLevel: 0.3,
    roadPack: "asphalt",
    apronPack: "sand",
    yardPack: "dirt",
    roadTileM: 5.5,
    apronTileM: 4.2,
    yardRepeat: 0.045,
    // Ash kills the specular lobe and fills the aggregate.
    roadRoughness: 0.86,
    roadMetalness: 0.03,
    roadNormalScale: 0.55,
  },

  /**
   * FOUNDRY PIT — an enclosed working pit, terraced in slag.
   *
   * Benches, not hills. Spoil is POURED, so it arrives in lifts with a lip at
   * every level and no erosion at any scale between them; the field is
   * quantised for exactly that reason and the octave count is low. Past the
   * working floor the ground climbs into the pit wall and the sky gets small,
   * which is the point of the circuit.
   *
   * Surface: poured concrete haul slab with slag aggregate on the shoulders,
   * and a scrap-steel yard fill.
   */
  foundry_pit: {
    landform: "benches",
    base: 0.8,
    bermDune: 1,
    bermRock: 0.2,
    midDune: 18,
    midRock: 1,
    farDune: 22,
    farRock: 1.2,
    // Fine and widespread: slag debris, not geological outcrop.
    rockFreq: 0.042,
    rockPower: 1.1,
    fadeFrom: 275,
    fadeTo: 355,
    edgeLevel: 0.4,
    roadPack: "concrete",
    apronPack: "gravel",
    yardPack: "rust",
    // Slab concrete is cast in bays, so its tile is far larger than asphalt's.
    roadTileM: 8,
    apronTileM: 3,
    yardRepeat: 0.05,
    roadRoughness: 0.78,
    roadMetalness: 0.04,
    roadNormalScale: 0.7,
  },

  /**
   * RUSTLINE — mesa and wash, with the circuit threaded through the gaps.
   *
   * Caprock plateaus with near-vertical sides standing over braided dry
   * channels. The redistribution is a NARROW smoothstep rather than a power
   * curve: what makes a mesa a mesa is that there is no intermediate ground
   * between the flat top and the wash floor, and any smooth curve puts some
   * there.
   *
   * Surface: asphalt broken back to its base course, with a dirt shoulder and a
   * scrap yard.
   */
  rustline: {
    landform: "mesa",
    base: 1,
    // Capped at Ash Spire's numbers, not raised to match the mesas.
    // `duneProfile` steps from the berm's endpoint to `hNear` at half+22, and
    // that step is bounded by these two: the reference circuit's worst case is
    // ~0.55m and nothing here should be allowed to be worse than the reference.
    bermDune: 1.2,
    bermRock: 0.35,
    midDune: 20,
    midRock: 3.2,
    farDune: 26,
    farRock: 4,
    rockFreq: 0.022,
    rockPower: 1.3,
    fadeFrom: 265,
    fadeTo: 350,
    edgeLevel: 0.34,
    roadPack: "asphalt",
    apronPack: "dirt",
    yardPack: "rust",
    roadTileM: 4.5,
    apronTileM: 3.2,
    yardRepeat: 0.05,
    roadRoughness: 0.8,
    roadMetalness: 0.05,
    roadNormalScale: 1.15,
  },

  /**
   * SABLE MILE — a basalt playa. Dead flat, and that is the whole design.
   *
   * The only way to make a pan read as a pan is to actually make it flat: a
   * dune field at 10% amplitude still has dunes in it, just small ones, and the
   * eye reads scale from shape before it reads it from size. So the pan itself
   * is a couple of metres of relief across half a kilometre, and every metre of
   * height in the circuit is spent on a handful of isolated inselbergs that
   * exist to give a flat-out lap something to measure itself against.
   *
   * `faceOnFlats` in the environment already inverts the crust rule for this
   * circuit — the two belong together and will merge.
   *
   * Surface: poured concrete slab (this is a speed circuit, and slab is what
   * you build one on) over a hardpan shoulder.
   */
  sable_run: {
    landform: "playa",
    base: 0.4,
    // A pan has no verge. This is the flattest run-off in the game on purpose.
    bermDune: 0.5,
    bermRock: 0.1,
    midDune: 26,
    midRock: 0.6,
    farDune: 34,
    farRock: 0.8,
    // Very low frequency, low exponent: broad alkali staining over the whole
    // pan rather than discrete outcrops.
    rockFreq: 0.007,
    rockPower: 0.85,
    fadeFrom: 345,
    fadeTo: 430,
    edgeLevel: 0.05,
    roadPack: "concrete",
    apronPack: "dirt",
    yardPack: "rock",
    roadTileM: 7,
    apronTileM: 4,
    yardRepeat: 0.03,
    // Slab is smoother than asphalt and holds a wet-looking sheen at low sun.
    roadRoughness: 0.62,
    roadMetalness: 0.05,
    roadNormalScale: 0.6,
  },

  /**
   * THE DEAD MILE — a pipeline haul road across corrugated ground.
   *
   * Long parallel ridge-and-swale running at a fixed bearing. The landform is
   * ANISOTROPIC, and that is the entire read: fBm has no preferred direction at
   * any amplitude, so no amount of tuning it produces ground that a road was
   * obviously cut across rather than laid over. Amplitude stays modest — this
   * is the longest lap in the game and 30m walls either side would make an
   * endurance circuit claustrophobic.
   *
   * Surface: patched haul asphalt on a coarse gravel shoulder.
   */
  dead_mile: {
    landform: "corrugation",
    base: 1.2,
    // The verge rolls with the ground, which is what sells the haul road —
    // but no harder than Ash Spire's, to keep the half+22 step bounded by the
    // reference circuit's. See the note on rustline.
    bermDune: 1.2,
    bermRock: 0.35,
    midDune: 13,
    midRock: 2.2,
    farDune: 15,
    farRock: 2.5,
    rockFreq: 0.014,
    rockPower: 1.8,
    // Furthest out of the six: this circuit is 320m in radius on its own.
    fadeFrom: 420,
    fadeTo: 560,
    edgeLevel: 0.5,
    roadPack: "asphalt",
    apronPack: "gravel",
    yardPack: "dirt",
    roadTileM: 6.5,
    apronTileM: 2.8,
    yardRepeat: 0.04,
    roadRoughness: 0.75,
    roadMetalness: 0.06,
    roadNormalScale: 1,
  },
};

/* ── active selection ──────────────────────────────────────────────────── */

let activeProfile: TerrainProfile = TERRAIN_PROFILES.ash_spire;
/** Ash Spire's own bounding-box centre and reach, as the pre-push default. */
let activeAnchor: TerrainAnchor = { cx: 18, cz: 54, extent: 168 };

/**
 * Point the height field at a circuit. Called by `track.ts` inside `rebuild()`,
 * BEFORE anything that settles onto the ground runs.
 *
 * Ordering is load-bearing rather than tidy: `buildSceneryFrom` -> `settleScenery`
 * evaluates `duneProfile` during the same rebuild, so a profile pushed after it
 * would place 23 pieces of scenery on the previous circuit's ground and leave
 * them hanging over the new one.
 */
export function setActiveTerrainProfile(
  id: AnyTrackId,
  anchor: TerrainAnchor,
): void {
  activeProfile = TERRAIN_PROFILES[id] ?? TERRAIN_PROFILES.ash_spire;
  // A degenerate extent would put a crater rim on the start line.
  activeAnchor = {
    cx: anchor.cx,
    cz: anchor.cz,
    extent: Math.max(40, anchor.extent),
  };
}

/**
 * A getter, not an exported binding.
 *
 * `export let activeProfile` would be a live binding under real ESM and a
 * snapshot under jiti's CJS transpile, which is the trap that has already cost
 * this project five debugging sessions — and it would fail in the quietest
 * possible way here, by baking a mesh from one circuit's landform while physics
 * used another's.
 */
export function getTerrainProfile(): TerrainProfile {
  return activeProfile;
}

export function getTerrainAnchor(): TerrainAnchor {
  return activeAnchor;
}
