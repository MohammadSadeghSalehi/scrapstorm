/**
 * What "a place" is, as data.
 *
 * Six circuits shared one desert because every art decision in the world
 * renderer was a literal: the sky gradient's six colours were `const`s inside
 * Atmosphere, the sun's position was a vector in JSX, the sand ramp was five
 * `new THREE.Color(...)` in HeightmapTerrain. Adding a second look meant either
 * duplicating those files or threading `if (trackId === ...)` through the whole
 * render tree — which is how a render tree stops being editable.
 *
 * So the look is lifted out whole. One `EnvironmentDef` per circuit, one lookup
 * (`getActiveEnvironment()`), and every consumer reads fields off it. Nothing in
 * the render tree knows a track id.
 *
 * DESIGN RULE, and it is the reason this is a flat bag of numbers rather than a
 * set of feature toggles: an environment SWAPS parameters, it does not STACK
 * features. Every field here changes the value of something that was already
 * going to be drawn — a colour, a count multiplier, a noise seed, a material
 * property. Nothing here can make one circuit mount a mesh, a light or a pass
 * that another circuit does not. Frame time on the target GPU is unmeasured and
 * has been seen at 14fps; six environments that each cost "just one more light"
 * is six times the way to lose the frame. Where an environment genuinely wants
 * more of something (a night sky wants more haze), it says so as a MULTIPLIER on
 * the tier-derived count, so the low tier still gets the low tier's budget.
 */
import type { PbrPackId } from "../webgl2/textureLibrary";
import type { GradeOptions } from "../GradeEffect";
import type { AnyTrackId } from "../../track";

/** Hex string, e.g. "#c8b090". Parsed once into a THREE.Color by the consumer. */
export type Hex = string;

export type Vec3 = [number, number, number];

/**
 * One stop of the sky dome's vertical gradient.
 *
 * `y` is the dome's normalised height: +1 straight up, 0 at the horizon,
 * negative below it (the dome is a full sphere, and its lower half is visible
 * past the edge of the terrain).
 *
 * A LIST rather than the six fixed bands this replaces, because band count is
 * itself an art decision. A clear noon sky is two stops and a straight ramp; a
 * dawn is seven, because the interesting part of a dawn is entirely in the four
 * degrees either side of the horizon. Fixed bands force every sky to spend its
 * detail in the same places.
 *
 * Must be sorted DESCENDING by `y`. The first stop is used above its own y and
 * the last below its own, so the ends are clamps, not extrapolations.
 */
export type SkyStop = { y: number; color: Hex };

export type SkyDef = {
  stops: SkyStop[];
  /**
   * Warm wash around the sun's bearing, applied on top of the vertical ramp.
   *
   * This is what stops a gradient dome reading as a gradient: real sky is
   * brighter toward the sun and the falloff is broad. `dir` is the sun's
   * horizontal bearing (x, z, not normalised — its length is the tightness of
   * the wash), `bias` widens it toward a full-sky lift, and the dot is squared
   * before it is applied so the falloff is gentle near the sun and quick away
   * from it.
   */
  washDir: [number, number];
  washBias: number;
  washColor: Hex;
  washStrength: number;
  /**
   * scene.background. Only ever seen through the dome's own back face during
   * the frame or two before the dome geometry exists, but a wrong value there
   * flashes blue on a night circuit.
   */
  background: Hex;
};

export type SunDiscDef = {
  /**
   * Whether the sun is DRAWN.
   *
   * False does not mean night — it means the sun is behind something the sky
   * itself represents (smoke, a dust storm). The directional light still runs;
   * it is just diffuse and gets its colour from what it is shining through.
   *
   * It also decides whether the skyline is allowed to be tall: see
   * `farRangeCeiling` in ./index.ts. A hidden sun cannot be occluded, so a
   * circuit that hides it can have mountains as high as it likes.
   */
  visible: boolean;
  /** Solid inner disc. Radius in metres at the dome's radius (~870). */
  core: Hex;
  coreRadius: number;
  /** Tight additive glow sprite. */
  glow: Hex;
  glowScale: number;
  glowOpacity: number;
  /** Wide additive flare. Skipped on the low tier — one sprite, but a huge one. */
  flare: Hex;
  flareScale: number;
  flareOpacity: number;
};

export type SunDef = {
  /**
   * Direction from the world origin TOWARD the visible sun. Need not be unit
   * length; it is normalised at use.
   */
  dir: Vec3;
  disc: SunDiscDef;
};

/**
 * Everything GameScene's light rig needs.
 *
 * Nothing in this module mounts a light — GameScene owns the rig and this file
 * does not own GameScene. These are the values it should be reading. Until that
 * wiring lands the rig stays on Ash Spire's numbers, which is why `ash_spire`'s
 * entry here is a transcription of the current literals rather than a fresh
 * design: the reference circuit must not change appearance.
 */
export type LightDef = {
  /**
   * Key light. `dir` is the position offset the shadow-following sun is placed
   * at, in metres — its LENGTH matters only insofar as it must clear the shadow
   * camera's near plane, its direction is the whole point.
   *
   * Deliberately allowed to differ from `sun.dir`. The disc has to sit above the
   * ridgeline to be visible at all, while the key light's elevation controls
   * shadow length and has to keep those shadows inside a 55m cascade. Tying them
   * together sounds tidy and produces either an invisible sun or shadows that
   * run off the end of the shadow map. The AZIMUTHS are kept in agreement so
   * shadows still point away from the visible sun, which is the part anyone
   * notices.
   */
  dir: Vec3;
  color: Hex;
  intensity: number;
  ambient: { color: Hex; intensity: number };
  hemisphere: { sky: Hex; ground: Hex; intensity: number };
  /** Cool bounce from the anti-sun side. */
  fill: { dir: Vec3; color: Hex; intensity: number };
  /** Warm kicker. Non-low tiers only, in the existing rig. */
  rim: { dir: Vec3; color: Hex; intensity: number };
  /** Multiplier on scene.environmentIntensity (EnvLighting's HDRI). */
  envIntensity: number;
};

export type FogDef = {
  color: Hex;
  near: number;
  /** Far plane of the fog at the non-low tiers. */
  far: number;
  /** Far plane at the low tier, where the draw distance is shorter anyway. */
  farLow: number;
};

export type TerrainDef = {
  /** Which tiled PBR pack the ground wears. */
  pack: PbrPackId;
  /** Texture tiles per metre. Lower = larger, coarser grain. */
  uvPerMetre: number;
  /**
   * Elevation ramp for the vertex colours: deepest hollows, low ground, mid,
   * crests. Elevation is normalised across the whole terrain patch, so these are
   * relative to the circuit's own relief, not to sea level.
   */
  hollow: Hex;
  low: Hex;
  mid: Hex;
  high: Hex;
  /**
   * The colour that appears where the ground is a different MATERIAL rather than
   * a different height — bare rock on a scoured face, or alkali crust on a flat.
   */
  face: Hex;
  faceStrength: number;
  /**
   * Which way round that is.
   *
   * The default (false) is the desert rule: sand settles on flats, wind strips
   * the steep faces back to rock, so `face` goes on slopes. A salt pan inverts
   * it — the crust forms in the flats where the water stood and the slopes are
   * the dark material underneath. Getting this backwards is not subtle: it makes
   * a playa look like a dune field.
   */
  faceOnFlats: boolean;
  /** Material base colour, multiplied over map and vertex colour. */
  base: Hex;
  roughness: number;
  metalness: number;
  envMapIntensity: number;
  normalScale: number;
  /**
   * Ground that is itself hot.
   *
   * Emissive is NOT multiplied by vertex colour in three.js, so this lifts the
   * whole surface uniformly — which is right for "the slag is cooling" and wrong
   * for anything that wants glowing veins. Keep it low; it reads as the ground
   * refusing to go fully black rather than as light.
   */
  emissive: Hex;
  emissiveIntensity: number;
};

/**
 * Landform parameters for one ridge ring. See ridgeRange.ts for the maths.
 *
 * The same generator produces weathered desert foothills, jagged slag heaps and
 * a low distant playa rim — it is entirely a question of seed, feature size,
 * how hard the mesh is relaxed and how many octaves survive. That is why these
 * are exposed rather than a choice between three canned shapes.
 */
export type RidgeDef = {
  seed: number;
  peak: number;
  baseY: number;
  featureSize: number;
  sharpness: number;
  /** Mesh smoothing pass strength. High = rounded spoil heaps, low = crags. */
  relax: number;
  /** Noise octaves. Fewer = broader, simpler landforms. */
  octaves: number;
  rockLow: Hex;
  rockHigh: Hex;
  haze: Hex;
  hazeMax: number;
  /**
   * Sedimentary band thickness in metres. 0 turns strata off entirely — right
   * for anything that is spoil rather than bedrock, where there are no beds.
   */
  bandHeight: number;
  tileM: number;
};

export type SkylineDef = {
  mid: RidgeDef;
  far: RidgeDef;
  /** Tiled detail map for both ranges. */
  detailPack: PbrPackId;
  /**
   * Gain on the range material's colour.
   *
   * Above 1 on purpose: three multiplies map x color x vertexColor and the rock
   * albedo is dark, so without a lift the vertex colours — which carry the whole
   * haze and stratification design — crush toward black. Dark environments want
   * LESS of it, not none: dropping it to 1 does not make the range dark, it
   * makes the range's own colour design disappear.
   */
  detailGain: Vec3;
};

/** How the floating motes behave. One branch in an existing loop, not a system. */
export type MoteMotion = "drift" | "rise" | "fall";

/**
 * Every `*Scale` below is a MULTIPLIER on the value Ash Spire uses at the
 * current quality tier, never an absolute count.
 *
 * That is the whole reason an environment can ask for "more mist" without
 * becoming the environment that drops the low tier off a cliff: the tier picks
 * the budget, the environment redistributes within it. `countScale` is clamped
 * at use (see COUNT_SCALE_MAX) so no preset can quietly triple the sprite bill.
 */
export type AtmosphereDef = {
  /** Mid-air haze sheets — the layer that separates near from far. */
  haze: { color: Hex; opacityScale: number; countScale: number };
  /** Wide flat sheets lying on the ground. Dawn mist, smoke pooling in a pit. */
  ground: { color: Hex; opacityScale: number; countScale: number };
  motes: {
    color: Hex;
    opacityScale: number;
    sizeScale: number;
    countScale: number;
    motion: MoteMotion;
    /** Embers add, dust does not. Free — it is a material flag. */
    additive: boolean;
  };
  clouds: {
    color: Hex;
    opacityScale: number;
    countScale: number;
    /** Base height above the horizon, metres. Low = a smoke bank, high = cirrus. */
    height: number;
    /** Sprite width / height, metres. */
    spanX: number;
    spanY: number;
  };
};

export type ScatterLayerDef = {
  /** Material base colour. */
  color: Hex;
  /**
   * Per-instance tint ramp, dark end to bright end. Multiplies `color`.
   *
   * Omit BOTH to leave the layer untinted. That is not the same as supplying
   * [1,1,1] twice: `packLayer` only allocates the per-instance colour buffer —
   * and the instanced-colour attribute that comes with it — if any item carries
   * a colour at all.
   */
  lo?: Vec3;
  hi?: Vec3;
  /**
   * Multiplier on the layer's tier density. 0 removes the layer entirely — a
   * slag pit has no desert scrub, and drawing it at 5% is worse than not
   * drawing it, because the handful that survive read as a bug.
   */
  density: number;
};

export type ScatterDef = {
  rock: ScatterLayerDef;
  scrub: ScatterLayerDef;
  drift: ScatterLayerDef;
  /** Pack for the rock layer's albedo, and for the drift layer's. */
  rockPack: PbrPackId;
  driftPack: PbrPackId;
};

/** Tints for the surfaces TrackMesh builds around the road. */
export type SurfaceDef = {
  road: Hex;
  apron: Hex;
  /** Hazard-zone yard fill. */
  yard: Hex;
  /** Flat sand tiles beyond the heightmap patch. */
  sand: Hex;
  /** The drift creeping over the tarmac edge. */
  vergeDrift: Hex;
  /** Lane markings. Bright paint reads differently under a dead sky. */
  stripe: Hex;
};

export type PostDef = {
  grade: Required<GradeOptions>;
  /** Added to the computed bloom intensity. Negative on a hazy, flat sky. */
  bloomBias: number;
  /** Added to the computed vignette darkness. */
  vignetteBias: number;
};

export interface EnvironmentDef {
  id: AnyTrackId;
  /** One line of art direction. The thing every field below is serving. */
  intent: string;
  sky: SkyDef;
  sun: SunDef;
  light: LightDef;
  fog: FogDef;
  terrain: TerrainDef;
  skyline: SkylineDef;
  atmosphere: AtmosphereDef;
  scatter: ScatterDef;
  surfaces: SurfaceDef;
  post: PostDef;
}
