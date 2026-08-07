/**
 * The six places.
 *
 * Read the `intent` line on each one first — every number under it is serving
 * that sentence, and a change that does not serve it is a change to the wrong
 * circuit. The set is deliberately spread across the day (dawn, noon, late
 * afternoon, dusk, and two that have no sky worth speaking of) because time of
 * day is the cheapest and most legible way to make two places feel unrelated:
 * it moves the sun, the shadows, the sky, the haze colour and the grade all at
 * once, and every one of those is a value swap.
 *
 * Two things that are NOT obvious and will bite anyone editing this file:
 *
 * 1. THE SUN CANNOT BE BEHIND THE MOUNTAINS. `sun.dir` and `skyline.far.peak`
 *    are coupled — the ridgeline subtends an angle from the camera, and if that
 *    angle exceeds the sun's elevation the disc is simply never visible. There
 *    is a helper, `farRangeCeiling`, that computes the limit, and the presets
 *    below sit under it. Ash Spire's hand-tuned 190 is what the formula returns
 *    for its 18.6-degree sun, which is how the formula was checked.
 *    A circuit with `sun.disc.visible: false` has no such limit and can have a
 *    skyline as tall as it likes — that is why the two enclosed circuits are
 *    also the two with no visible sun. It is not a coincidence, it is the
 *    trade.
 *
 * 2. `light.dir` IS NOT `sun.dir`. The disc has to sit above the ridge to be
 *    seen; the key light's elevation sets shadow LENGTH and has to keep those
 *    shadows inside a 55m shadow cascade. Tying them together gives you either
 *    an invisible sun or shadows that run off the edge of the shadow map. Their
 *    azimuths agree, which is the part anyone actually perceives.
 */
import {
  BLEACHED_NOON,
  DESERT_DUSK,
  EMBER_DUSK,
  FIRST_LIGHT,
  RUST_HAZE,
  SLAG_FURNACE,
} from "../GradeEffect";
import type { AnyTrackId } from "../../track";
import type { EnvironmentDef } from "./types";

/**
 * ── Ash Spire — late afternoon, high desert ───────────────────────────
 *
 * The reference. Every value here is a transcription of the literal it
 * replaced, NOT a new design: this circuit is the one the whole look was tuned
 * against, it is what the screenshots and the QA baselines show, and the point
 * of this exercise is that the other five stop looking like it — not that it
 * changes. If a diff ever makes Ash Spire look different, the diff is wrong.
 */
const ASH_SPIRE: EnvironmentDef = {
  id: "ash_spire",
  intent:
    "Late afternoon in open desert. Warm, dusty, wide. The baseline every other circuit is measured against.",
  sky: {
    // Decomposed from the six hand-written bands the dome used to hardcode; the
    // y values are exactly where those `if` branches switched.
    stops: [
      { y: 1.0, color: "#1a3a68" },
      { y: 0.45, color: "#4a78a8" },
      { y: 0.12, color: "#8aa8c4" },
      { y: 0.0, color: "#e0a068" },
      { y: -0.08, color: "#f5d4a0" },
      { y: -0.48, color: "#3a2818" },
    ],
    washDir: [0.7, -0.3],
    washBias: 0.2,
    washColor: "#ffe8c4",
    washStrength: 0.4,
    background: "#4a6a90",
  },
  sun: {
    dir: [666, 276, -476],
    disc: {
      visible: true,
      core: "#fff8ec",
      coreRadius: 24,
      glow: "#ffe8c0",
      glowScale: 145,
      glowOpacity: 0.85,
      flare: "#ffb060",
      flareScale: 265,
      flareOpacity: 0.28,
    },
  },
  light: {
    dir: [55, 70, -25],
    color: "#ffe8c8",
    intensity: 3.0,
    ambient: { color: "#f4e4c8", intensity: 0.62 },
    hemisphere: { sky: "#ffc898", ground: "#2a1810", intensity: 1.1 },
    fill: { dir: [-40, 22, 40], color: "#88b8e8", intensity: 0.65 },
    rim: { dir: [20, 12, 30], color: "#ffd0a0", intensity: 0.3 },
    envIntensity: 1.0,
    headlights: {
      enabled: false,
      color: "#fff2d8",
      intensity: 1.2,
      distance: 40,
      angleDeg: 34,
    },
  },
  fog: { color: "#c8b090", near: 120, far: 720, farLow: 480 },
  terrain: {
    pack: "sand",
    uvPerMetre: 1 / 7,
    hollow: "#8a6040",
    low: "#c49458",
    mid: "#e8bc78",
    high: "#f8e8c0",
    face: "#5a4a3c",
    faceStrength: 2.4,
    faceOnFlats: false,
    base: "#f5dcac",
    roughness: 0.82,
    metalness: 0.02,
    envMapIntensity: 1.05,
    normalScale: 1.5,
    emissive: "#7a5430",
    emissiveIntensity: 0.0,
  },
  skyline: {
    mid: {
      seed: 7,
      peak: 42,
      baseY: 4,
      featureSize: 190,
      sharpness: 0.72,
      relax: 0.32,
      octaves: 6,
      rockLow: "#6b4f38",
      rockHigh: "#a4855f",
      haze: "#cfb089",
      hazeMax: 0.62,
      bandHeight: 7.5,
      tileM: 46,
    },
    far: {
      seed: 23,
      peak: 190,
      baseY: 0,
      featureSize: 340,
      sharpness: 0.6,
      relax: 0.32,
      octaves: 6,
      rockLow: "#6a5a52",
      rockHigh: "#a89380",
      haze: "#e3c49c",
      hazeMax: 0.82,
      bandHeight: 7.5,
      tileM: 78,
    },
    detailPack: "rock",
    detailGain: [2.05, 2.0, 1.95],
  },
  atmosphere: {
    haze: { color: "#f0d0a0", opacityScale: 1, countScale: 1 },
    ground: { color: "#d8a868", opacityScale: 1, countScale: 1 },
    motes: {
      color: "#e8c898",
      opacityScale: 1,
      sizeScale: 1,
      countScale: 1,
      motion: "drift",
      additive: false,
    },
    clouds: {
      color: "#f0e8dc",
      opacityScale: 1,
      countScale: 1,
      height: 150,
      spanX: 210,
      spanY: 58,
    },
  },
  scatter: {
    rock: {
      color: "#97815f",
      lo: [0.66, 0.62, 0.58],
      hi: [1.06, 0.99, 0.88],
      density: 1,
    },
    scrub: {
      color: "#c2a870",
      lo: [0.72, 0.78, 0.56],
      hi: [1.05, 0.97, 0.72],
      density: 1,
    },
    // No ramp: the drift layer has never carried per-instance colour, and
    // adding one would allocate an instanced colour attribute for nothing.
    drift: { color: "#9d8a70", density: 1 },
    rockPack: "rock",
    driftPack: "rust",
  },
  surfaces: {
    road: "#5a564e",
    apron: "#8a7355",
    yard: "#5a4834",
    sand: "#c8a47a",
    vergeDrift: "#d8b585",
    stripe: "#f0d878",
    roadRoughness: 0.72,
    roadEnvMapIntensity: 0.9,
    wetness: 0,
  },
  post: { grade: DESERT_DUSK, bloomBias: 0, vignetteBias: 0 },
};

/**
 * ── Cinder Bowl — ember dusk ──────────────────────────────────────────
 *
 * The sun is on the deck and the bowl is full of its light. Everything vertical
 * is a silhouette, everything horizontal is on fire, and the sun is behind you
 * from where it is at Ash Spire so the shadows fall the other way across the
 * same kind of ground.
 *
 * A 13-degree sun caps the far range at ~123m (see farRangeCeiling), which
 * sounds like a loss and is not: a low horizon is what LETS a big sun sit on it.
 * The enclosure is bought back with the mid range instead, which is nearer, and
 * with a small featureSize so the foothills read as a crowded rim rather than as
 * a few distant summits.
 */
const CINDER_BOWL: EnvironmentDef = {
  id: "cinder_bowl",
  intent:
    "Sunset in a burnt-out bowl. Silhouettes against a molten horizon, ash underfoot, embers off the clinker.",
  sky: {
    stops: [
      { y: 1.0, color: "#12183a" },
      { y: 0.55, color: "#2a2757" },
      { y: 0.26, color: "#5b3a68" },
      { y: 0.1, color: "#a84a4a" },
      { y: 0.02, color: "#e0703a" },
      // The band the disc sits in. Narrow on purpose: a wide gold band reads as
      // "orange sky", a narrow one reads as "the sun is right there".
      { y: -0.02, color: "#ffb45c" },
      { y: -0.1, color: "#8a4a2c" },
      { y: -0.5, color: "#241410" },
    ],
    washDir: [-0.446, 0.565],
    washBias: 0.16,
    washColor: "#ffd090",
    washStrength: 0.5,
    background: "#2a2757",
  },
  sun: {
    dir: [-519, 193, 658],
    disc: {
      visible: true,
      // Bigger than Ash Spire's. A sun near the horizon is seen through far more
      // atmosphere and genuinely reads larger; matching the high-sun size makes
      // a sunset look like an afternoon that has been colour-graded.
      core: "#fff0d0",
      coreRadius: 30,
      glow: "#ff9a48",
      glowScale: 210,
      glowOpacity: 0.9,
      flare: "#ff5a1e",
      flareScale: 380,
      flareOpacity: 0.34,
    },
  },
  light: {
    // 18 degrees: a 1.5m car throws a 4.6m shadow, which is long enough to read
    // as evening and short enough to stay well inside the 55m cascade.
    dir: [-53, 28, 67],
    color: "#ffb473",
    intensity: 2.5,
    ambient: { color: "#8a7a90", intensity: 0.55 },
    hemisphere: { sky: "#c07a5a", ground: "#1a1220", intensity: 1.0 },
    // The anti-sun sky is the BRIGHT half at dusk and it is violet-blue. Getting
    // this wrong (a dim warm fill) is what makes a sunset look like a fire.
    fill: { dir: [50, 26, -46], color: "#6a7ec8", intensity: 0.75 },
    rim: { dir: [-30, 10, 40], color: "#ff9a5a", intensity: 0.45 },
    envIntensity: 0.75,
    headlights: {
      enabled: false,
      color: "#fff0d0",
      intensity: 1.3,
      distance: 42,
      angleDeg: 34,
    },
  },
  fog: { color: "#a8663c", near: 100, far: 620, farLow: 420 },
  terrain: {
    pack: "sand",
    uvPerMetre: 1 / 6,
    hollow: "#3a2a20",
    low: "#5c4838",
    mid: "#8a6a52",
    high: "#c09272",
    face: "#372c2c",
    faceStrength: 2.0,
    faceOnFlats: false,
    base: "#c9a487",
    roughness: 0.9,
    metalness: 0.03,
    envMapIntensity: 0.85,
    normalScale: 1.6,
    // The bowl has not finished cooling. Kept very low — emissive is not
    // multiplied by vertex colour, so it lifts the whole surface uniformly and
    // anything above ~0.08 stops reading as heat and starts reading as fog.
    emissive: "#401a08",
    emissiveIntensity: 0.05,
  },
  skyline: {
    mid: {
      seed: 41,
      peak: 62,
      baseY: 4,
      featureSize: 130,
      // Sharper and less relaxed than the desert: this is a crater rim of
      // fractured clinker, not weathered sandstone.
      sharpness: 0.9,
      relax: 0.24,
      octaves: 6,
      rockLow: "#2a2028",
      rockHigh: "#6a4a42",
      haze: "#a8582e",
      hazeMax: 0.7,
      bandHeight: 6,
      tileM: 40,
    },
    far: {
      seed: 59,
      // farRangeCeiling for a 13-degree sun with a 30m disc is 118.5. 112 keeps
      // a margin, because the ceiling is computed against the theoretical
      // maximum ridge height and a summit that happens to land on the sun's
      // bearing is exactly the summit that will hide it.
      peak: 112,
      baseY: 0,
      featureSize: 300,
      sharpness: 0.66,
      relax: 0.3,
      octaves: 6,
      rockLow: "#241c28",
      rockHigh: "#5e4448",
      // Haze toward the hot horizon band, not toward grey: at dusk the distance
      // takes the colour of the sky it is standing in front of.
      haze: "#d07a3e",
      hazeMax: 0.9,
      bandHeight: 9,
      tileM: 74,
    },
    detailPack: "rock",
    // Much lower gain than the desert. The vertex colours here are already dark
    // by design; the desert's 2.05 would drag them back to daylight brown and
    // undo the entire silhouette read.
    detailGain: [1.6, 1.5, 1.5],
  },
  atmosphere: {
    haze: { color: "#ff9a58", opacityScale: 1.45, countScale: 1.0 },
    ground: { color: "#c85c28", opacityScale: 1.6, countScale: 1.15 },
    motes: {
      color: "#ffb070",
      opacityScale: 1.6,
      sizeScale: 0.9,
      // Held at parity with the desert. Embers are made of opacity and additive
      // blending, not of sprite count — see COUNT_SCALE_CAP.
      countScale: 1.0,
      motion: "rise",
      additive: true,
    },
    clouds: {
      color: "#ff9a5c",
      opacityScale: 1.5,
      countScale: 1,
      // Low and long: at dusk the interesting cloud is the streak lit from
      // underneath, not the stack lit from the side.
      height: 130,
      spanX: 260,
      spanY: 42,
    },
  },
  scatter: {
    rock: {
      color: "#6a5548",
      lo: [0.5, 0.44, 0.42],
      hi: [0.95, 0.8, 0.66],
      density: 1,
    },
    scrub: {
      color: "#7a6a48",
      lo: [0.5, 0.5, 0.38],
      hi: [0.85, 0.74, 0.5],
      density: 0.4,
    },
    drift: { color: "#a06a48", density: 1.3 },
    rockPack: "rock",
    driftPack: "rust",
  },
  surfaces: {
    road: "#4a453f",
    apron: "#6a5340",
    yard: "#3e3228",
    sand: "#9a7452",
    vergeDrift: "#a07a54",
    stripe: "#ffd090",
    roadRoughness: 0.72,
    roadEnvMapIntensity: 0.9,
    wetness: 0,
  },
  post: { grade: EMBER_DUSK, bloomBias: 0.12, vignetteBias: 0.06 },
};

/**
 * ── Foundry Pit — furnace night ───────────────────────────────────────
 *
 * Night inside a working smelter. There is no sky: what looks like one is the
 * underside of the smoke, lit orange from below by the furnace line, and the
 * gradient is therefore INVERTED — darkest at the zenith, hottest at the
 * horizon. That inversion is the whole image.
 *
 * THE TRAP: this is an elimination arena. The obvious way to build a night is
 * to take light away, and it produces a circuit where four cars are four
 * silhouettes and nobody can tell who they are fighting. So the light rig here
 * is NOT dim — the ambient is higher than Ash Spire's. The darkness is done by
 * the sky, the terrain palette and the grade, all of which are free, while the
 * light that has to land on a car stays where gameplay needs it.
 *
 * The single most load-bearing number is `envIntensity: 0.45`. EnvLighting's
 * HDRI is a daylight sky; at full strength it re-lights the entire scene as
 * daytime and there is no night left to grade.
 */
const FOUNDRY_PIT: EnvironmentDef = {
  id: "foundry_pit",
  intent:
    "Night in a working smelter. The sky is the underside of the smoke; the ground is cooling slag. Dark to look at, never dark to fight in.",
  sky: {
    stops: [
      { y: 1.0, color: "#05070c" },
      { y: 0.4, color: "#0b0e16" },
      { y: 0.16, color: "#1a1416" },
      { y: 0.06, color: "#3a2018" },
      { y: 0.01, color: "#7a3410" },
      // The furnace line itself, at and just below the horizon.
      { y: -0.03, color: "#c8541a" },
      { y: -0.12, color: "#5a2410" },
      { y: -0.5, color: "#0e0906" },
    ],
    washDir: [0.24, 0.76],
    washBias: 0.1,
    washColor: "#ff7a28",
    washStrength: 0.55,
    background: "#0b0e16",
  },
  sun: {
    dir: [258, 52, 817],
    disc: {
      // No disc: the furnaces are the light source and they are behind the
      // smoke. This is also what frees the skyline to be as tall as a pit
      // needs — nothing can occlude a sun that is not drawn. It is one sprite
      // pair fewer, so it is cheaper than a visible sun, not more expensive.
      visible: false,
      core: "#ff8a30",
      coreRadius: 18,
      glow: "#ff6a1e",
      glowScale: 260,
      glowOpacity: 0.5,
      flare: "#d03c0e",
      flareScale: 420,
      flareOpacity: 0.2,
    },
  },
  light: {
    dir: [25, 34, 80],
    color: "#ff9040",
    intensity: 2.2,
    // Higher than the desert's, on purpose. See the note above the def.
    ambient: { color: "#6a4a3a", intensity: 0.72 },
    hemisphere: { sky: "#a04a1e", ground: "#0e0c10", intensity: 1.15 },
    // Cold mercury-vapour worklights on the far gantry. The only non-fire light
    // in the circuit, and it is what keeps the frame from being monochrome
    // orange — a single hue everywhere reads as a broken renderer.
    fill: { dir: [-46, 26, -40], color: "#3a5a88", intensity: 0.42 },
    rim: { dir: [-24, 14, 30], color: "#ffb060", intensity: 0.5 },
    envIntensity: 0.45,
    headlights: {
      enabled: true,
      color: "#fff6e6",
      intensity: 3.4,
      distance: 55,
      angleDeg: 36,
    },
  },
  fog: { color: "#2a1a14", near: 60, far: 420, farLow: 300 },
  terrain: {
    // Rock, not sand: slag is broken and angular and the sand pack's wind
    // ripples are unmistakably wind ripples at any tiling.
    pack: "rock",
    uvPerMetre: 1 / 5,
    hollow: "#100c0c",
    low: "#221c1c",
    mid: "#3a2f2c",
    high: "#58483e",
    // Oxide orange on the broken faces — the one place the ground has colour.
    face: "#6a3418",
    faceStrength: 1.6,
    faceOnFlats: false,
    base: "#b09a86",
    roughness: 0.95,
    metalness: 0.05,
    envMapIntensity: 0.5,
    normalScale: 1.7,
    emissive: "#6a2008",
    emissiveIntensity: 0.16,
  },
  skyline: {
    mid: {
      seed: 88,
      peak: 66,
      baseY: 4,
      featureSize: 105,
      // Spoil is TIPPED, not eroded. High relax and few octaves give smooth
      // conical heaps; the desert's crags and strata would say "mountain",
      // which is the opposite of what a slag heap is.
      sharpness: 0.55,
      relax: 0.55,
      octaves: 4,
      rockLow: "#141013",
      rockHigh: "#46342c",
      haze: "#6a2c14",
      hazeMax: 0.55,
      // No bedding planes in spoil. Strata here would be the single clearest
      // tell that this is the desert range wearing a different colour.
      bandHeight: 0,
      tileM: 34,
    },
    far: {
      seed: 104,
      // Free to be this tall only because the disc is hidden. 265m of spoil is
      // what makes a pit a pit.
      peak: 265,
      baseY: 0,
      featureSize: 260,
      sharpness: 0.5,
      relax: 0.5,
      octaves: 5,
      rockLow: "#0e0c10",
      rockHigh: "#33262a",
      haze: "#7a3416",
      hazeMax: 0.86,
      bandHeight: 0,
      tileM: 70,
    },
    detailPack: "rock",
    detailGain: [1.25, 1.15, 1.1],
  },
  atmosphere: {
    haze: { color: "#c8541a", opacityScale: 2.2, countScale: 1.15 },
    ground: { color: "#a03a12", opacityScale: 2.2, countScale: 1.25 },
    motes: {
      color: "#ff8a2c",
      opacityScale: 2.4,
      sizeScale: 0.65,
      countScale: 1.15,
      motion: "rise",
      additive: true,
    },
    clouds: {
      color: "#4a2418",
      opacityScale: 2.4,
      countScale: 1.1,
      // Not clouds — smoke banks standing on the horizon, tall and close to it.
      // The cloud sprites live at ~720m radius, so anything "overhead" is
      // impossible here; a low, tall bank is what that geometry can actually
      // deliver and it happens to be exactly right for a smelter.
      height: 105,
      spanX: 300,
      spanY: 90,
    },
  },
  scatter: {
    rock: {
      color: "#4a3c34",
      lo: [0.4, 0.36, 0.34],
      hi: [0.86, 0.72, 0.6],
      density: 1.1,
    },
    // Nothing grows in a slag pit. Zero, not 0.05: a handful of surviving
    // desert tufts reads as a bug, not as sparse vegetation.
    scrub: { color: "#000000", density: 0 },
    drift: { color: "#8a6a4a", density: 1.6 },
    rockPack: "rock",
    driftPack: "scrap_panel",
  },
  surfaces: {
    road: "#3e3a36",
    apron: "#4a3e34",
    yard: "#2e2622",
    sand: "#4a3c32",
    vergeDrift: "#5a4436",
    stripe: "#ffc060",
    roadRoughness: 0.72,
    roadEnvMapIntensity: 0.9,
    wetness: 0,
  },
  post: { grade: SLAG_FURNACE, bloomBias: 0.2, vignetteBias: 0.12 },
};

/**
 * ── Rustline — brown-out ──────────────────────────────────────────────
 *
 * A dust storm has been sitting on the scrapyard all day. There is no sky and
 * no distance: the world ends 200 metres out and what you can see of it is
 * other people's wreckage.
 *
 * This is the claustrophobic circuit, and the lever that does the work is FOG,
 * not geometry — 260m of fog range against Ash Spire's 720. Everything else
 * (a nearly flat sky gradient, a skyline hazed to 97%, a hidden sun) exists to
 * stop the eye finding a horizon to measure against.
 *
 * The lighting is the counter-intuitive part: in a brown-out the key light
 * COLLAPSES and the ambient goes up, because the entire sky becomes one large
 * dim source. A dim ambient with a strong sun would give hard shadows in a dust
 * storm, which is not a thing.
 */
const RUSTLINE: EnvironmentDef = {
  id: "rustline",
  intent:
    "A scrapyard in a dust storm. No sky, no horizon, no distance — just the next 200 metres of other people's wreckage.",
  sky: {
    // Six stops spanning barely a quarter of a hue. A near-flat sky is the
    // point: with no gradient there is no up, and with no up there is no scale.
    stops: [
      { y: 1.0, color: "#7a5a34" },
      { y: 0.45, color: "#8a6738" },
      { y: 0.15, color: "#9c7840" },
      { y: 0.02, color: "#ab8749" },
      { y: -0.08, color: "#a07c44" },
      { y: -0.5, color: "#4a3620" },
    ],
    washDir: [0.6, 0.37],
    // Wide and weak — the sun's position is a smear, not a place.
    washBias: 0.3,
    washColor: "#d8b070",
    washStrength: 0.3,
    background: "#8a6738",
  },
  sun: {
    dir: [606, 481, 378],
    disc: {
      visible: false,
      core: "#e8c890",
      coreRadius: 22,
      glow: "#d8a860",
      glowScale: 300,
      glowOpacity: 0.35,
      flare: "#b08040",
      flareScale: 460,
      flareOpacity: 0.15,
    },
  },
  light: {
    dir: [63, 50, 40],
    color: "#d8a060",
    // Less than half Ash Spire's. The sun is up there somewhere; almost none of
    // it is arriving in a straight line.
    intensity: 1.6,
    ambient: { color: "#b08a58", intensity: 1.05 },
    hemisphere: { sky: "#c89a5c", ground: "#4a3620", intensity: 1.35 },
    // No cool bounce anywhere — everything in the air is the same dust, so
    // every direction returns the same brown.
    fill: { dir: [-50, 30, -40], color: "#a08858", intensity: 0.5 },
    rim: { dir: [30, 16, 34], color: "#e0b070", intensity: 0.25 },
    envIntensity: 0.7,
    headlights: {
      enabled: true,
      color: "#ffe4b8",
      intensity: 2.2,
      distance: 34,
      angleDeg: 40,
    },
  },
  fog: { color: "#a4834a", near: 40, far: 260, farLow: 190 },
  terrain: {
    pack: "dirt",
    uvPerMetre: 1 / 5.5,
    hollow: "#4e3c28",
    low: "#6e5638",
    mid: "#8a6c46",
    high: "#a88a5e",
    face: "#7a5236",
    faceStrength: 1.4,
    faceOnFlats: false,
    base: "#d8bc90",
    roughness: 0.96,
    metalness: 0.03,
    envMapIntensity: 0.55,
    // Cracked hardpan lives entirely in its normal map — there is no colour
    // variation in dried mud worth speaking of, so the relief has to carry it.
    normalScale: 1.9,
    emissive: "#000000",
    emissiveIntensity: 0,
  },
  skyline: {
    mid: {
      seed: 131,
      peak: 78,
      baseY: 4,
      featureSize: 115,
      sharpness: 0.8,
      relax: 0.3,
      octaves: 5,
      rockLow: "#5a4028",
      rockHigh: "#8a6a44",
      haze: "#a4834a",
      // Nearly gone into the dust. A shape you can only just resolve is more
      // oppressive than one you can read.
      hazeMax: 0.92,
      // Scrap tips, not bedrock.
      bandHeight: 0,
      tileM: 30,
    },
    far: {
      seed: 167,
      peak: 300,
      baseY: 0,
      featureSize: 240,
      sharpness: 0.72,
      relax: 0.28,
      octaves: 5,
      rockLow: "#6a5030",
      rockHigh: "#94764c",
      haze: "#a4834a",
      hazeMax: 0.97,
      bandHeight: 0,
      tileM: 64,
    },
    // Rust rather than rock — these are tips of scrap, and the pack's flaked
    // metal reads correctly even at 64m per tile.
    detailPack: "rust",
    detailGain: [1.7, 1.6, 1.5],
  },
  atmosphere: {
    // The dust is made of OPACITY, not of sprite count. Doubling the sheets
    // doubles the draw calls; doubling their alpha costs a uniform, and a dust
    // storm is a question of how much you cannot see through, not of how many
    // separate things you cannot see through.
    haze: { color: "#c8a46a", opacityScale: 2.8, countScale: 1.2 },
    ground: { color: "#b8965e", opacityScale: 2.7, countScale: 1.25 },
    motes: {
      color: "#d8bc90",
      opacityScale: 2.5,
      // Big and slow. Small motes read as sparkle; large soft ones read as
      // airborne grit passing close to the camera.
      sizeScale: 1.5,
      countScale: 1.1,
      motion: "drift",
      additive: false,
    },
    clouds: {
      color: "#9c7c48",
      opacityScale: 1.2,
      countScale: 0.5,
      height: 190,
      spanX: 300,
      spanY: 90,
    },
  },
  scatter: {
    rock: {
      color: "#7a6244",
      lo: [0.55, 0.48, 0.4],
      hi: [1.0, 0.88, 0.68],
      density: 0.8,
    },
    scrub: {
      color: "#8a7a4c",
      lo: [0.5, 0.52, 0.36],
      hi: [0.9, 0.82, 0.5],
      density: 0.3,
    },
    // The yard is made of this. The heaviest drift density in the set, and it
    // is affordable because the rock and scrub layers are paying for it.
    drift: { color: "#b06a3e", density: 2.2 },
    rockPack: "rock",
    driftPack: "rust",
  },
  surfaces: {
    road: "#4e4840",
    apron: "#7a6244",
    yard: "#4a3a26",
    sand: "#96784c",
    vergeDrift: "#a8845a",
    stripe: "#e8c878",
    roadRoughness: 0.72,
    roadEnvMapIntensity: 0.9,
    wetness: 0,
  },
  post: { grade: RUST_HAZE, bloomBias: -0.14, vignetteBias: 0.1 },
};

/**
 * ── Sable Mile — hard noon, black flats ───────────────────────────────
 *
 * Noon on a basalt playa. The sun is almost overhead so there is nowhere to
 * hide in a shadow, the horizon is a straight line a very long way away, and
 * the ground is black grit under white alkali crust.
 *
 * This is the only circuit where the terrain rule is INVERTED
 * (`faceOnFlats: true`). Everywhere else, sand settles on flats and wind strips
 * the steep faces back to rock. On a playa the crust forms in the flats where
 * the water stood and the dark material shows on anything with a slope. Getting
 * that backwards does not look "slightly off": it makes a salt pan look like a
 * dune field with a colour problem.
 *
 * Aerial perspective goes BLUE here, not tan. Clear air scatters blue, and that
 * blue on the far range is the single strongest cue that says "forty
 * kilometres" — which is the whole reason to run a mile-and-a-half circuit in
 * the open.
 */
const SABLE_RUN: EnvironmentDef = {
  id: "sable_run",
  intent:
    "Noon on a black basalt playa. Overhead sun, no shadows to hide in, and a horizon so far away the far range has gone blue.",
  sky: {
    stops: [
      { y: 1.0, color: "#1a54a8" },
      { y: 0.5, color: "#3d7cc4" },
      { y: 0.2, color: "#78a8d4" },
      { y: 0.05, color: "#b8cfdc" },
      { y: -0.02, color: "#e6e2d2" },
      { y: -0.1, color: "#cfc4ac" },
      { y: -0.5, color: "#4a4438" },
    ],
    washDir: [0.15, -0.74],
    washBias: 0.12,
    washColor: "#ffffff",
    // Weakest wash in the set. At noon the sky's brightness gradient is
    // vertical, not radial around the sun.
    washStrength: 0.22,
    background: "#3d7cc4",
  },
  sun: {
    dir: [64, 797, -316],
    disc: {
      visible: true,
      core: "#ffffff",
      // Small and vicious. A high sun subtends the same angle as a low one but
      // reads smaller because there is no atmospheric bloom around it.
      coreRadius: 16,
      glow: "#fff6e0",
      glowScale: 95,
      glowOpacity: 0.8,
      flare: "#ffe8b0",
      flareScale: 190,
      flareOpacity: 0.18,
    },
  },
  light: {
    // 66 degrees. A 1.5m car throws a 0.67m shadow — a car sitting in its own
    // puddle, which is exactly what noon looks like and is deeply unlike every
    // other circuit here.
    dir: [8, 87, -38],
    color: "#fff4e2",
    intensity: 3.4,
    // Low and blue. At noon a shadow is lit by nothing but the sky, and that
    // sky is the most saturated blue in the set.
    ambient: { color: "#d8e4f0", intensity: 0.5 },
    hemisphere: { sky: "#a8d0f0", ground: "#3a3428", intensity: 1.0 },
    fill: { dir: [-40, 30, 46], color: "#8ab0e0", intensity: 0.5 },
    rim: { dir: [30, 20, 26], color: "#ffe8c0", intensity: 0.22 },
    envIntensity: 1.25,
    headlights: {
      enabled: false,
      color: "#fff4e0",
      intensity: 1.0,
      distance: 38,
      angleDeg: 34,
    },
  },
  // 860, just inside the 900m camera far plane. Clear air is what makes a plain
  // feel enormous; pulling fog in here would undo the whole circuit.
  fog: { color: "#cfc8b4", near: 220, far: 860, farLow: 620 },
  terrain: {
    pack: "gravel",
    uvPerMetre: 1 / 4.5,
    // Dark basalt by elevation...
    hollow: "#1e1c1c",
    low: "#2e2c2a",
    mid: "#46423c",
    high: "#5c564c",
    /*
     * ...and pale alkali crust wherever it is FLAT. See the note above the def.
     *
     * 0.55, not 1. The strength multiplies a rock-mask term that already floors
     * at 0.55, so anything near 1 saturates the blend across the entire plain
     * and the basalt underneath never shows at all — a uniformly white playa,
     * which is both duller and less legible than a mottled one. At 0.55 the
     * crust covers roughly 30-80% depending on the mask, so the dark ground
     * reads through it and the plain has texture at a distance where the
     * heightfield alone has none.
     */
    face: "#ddd8c6",
    faceStrength: 0.55,
    faceOnFlats: true,
    base: "#cfcabc",
    roughness: 0.88,
    metalness: 0.02,
    envMapIntensity: 1.15,
    normalScale: 1.3,
    emissive: "#000000",
    emissiveIntensity: 0,
  },
  skyline: {
    mid: {
      seed: 205,
      // Almost nothing. The mid range's job everywhere else is to fill the gap
      // between desert and mountains; here its job is to get out of the way, so
      // that the only thing between the car and the far range is distance.
      peak: 22,
      baseY: 4,
      featureSize: 260,
      sharpness: 0.45,
      relax: 0.4,
      octaves: 5,
      rockLow: "#5a5a58",
      rockHigh: "#9a9488",
      haze: "#c8c8bc",
      hazeMax: 0.7,
      bandHeight: 12,
      tileM: 52,
    },
    far: {
      seed: 233,
      peak: 128,
      baseY: 0,
      // Huge feature size, few octaves: simple massifs with long clean
      // ridgelines. Detail at this distance is only aliasing anyway, and the
      // simplicity is what makes them read as very large and very far.
      featureSize: 460,
      sharpness: 0.5,
      relax: 0.35,
      octaves: 5,
      rockLow: "#6a7080",
      rockHigh: "#a0a8b4",
      haze: "#cdd6dc",
      hazeMax: 0.9,
      bandHeight: 16,
      tileM: 90,
    },
    detailPack: "rock",
    detailGain: [2.2, 2.2, 2.2],
  },
  atmosphere: {
    // Everything here is turned DOWN. The absence of atmosphere is the effect —
    // it is also the cheapest environment in the set by a wide margin, which is
    // useful cover for the fact that it has the longest fog range.
    haze: { color: "#dfe4e0", opacityScale: 0.45, countScale: 0.5 },
    ground: { color: "#e8e4d4", opacityScale: 0.35, countScale: 0.4 },
    motes: {
      color: "#f0ece0",
      opacityScale: 0.5,
      sizeScale: 0.8,
      countScale: 0.5,
      motion: "drift",
      additive: false,
    },
    clouds: {
      color: "#ffffff",
      opacityScale: 0.9,
      countScale: 0.6,
      // Small, high and hard-edged — noon cumulus, not the long soft streaks
      // that belong to the ends of the day.
      height: 230,
      spanX: 140,
      spanY: 34,
    },
  },
  scatter: {
    rock: {
      color: "#6a6a62",
      lo: [0.42, 0.42, 0.42],
      hi: [0.98, 0.96, 0.9],
      // Emptiness is the subject. Also the cheapest scatter bill in the set.
      density: 0.55,
    },
    scrub: {
      color: "#b0a878",
      lo: [0.6, 0.62, 0.5],
      hi: [1.0, 0.95, 0.7],
      density: 0.35,
    },
    drift: { color: "#a8a49a", density: 0.5 },
    rockPack: "rock",
    driftPack: "scrap_panel",
  },
  surfaces: {
    road: "#6a675e",
    apron: "#9a968a",
    yard: "#55524a",
    sand: "#b8b4a4",
    vergeDrift: "#c8c4b2",
    stripe: "#ffffff",
    roadRoughness: 0.72,
    roadEnvMapIntensity: 0.9,
    wetness: 0,
  },
  post: { grade: BLEACHED_NOON, bloomBias: 0.05, vignetteBias: -0.04 },
};

/**
 * ── The Dead Mile — first light ───────────────────────────────────────
 *
 * Twenty minutes after sunrise on the pipeline road. Cold blue everywhere the
 * sun has not reached, one rose-gold rake across everything it has, and mist
 * still lying in the hollows.
 *
 * The circuit's subject is its LENGTH, so the environment is built to make
 * distance legible: a broad, low, unhurried skyline (the largest featureSize of
 * any mid range here) rather than a crowded one, a fog colour that is cold
 * instead of warm, and rose haze on the far range — which is the truest thing
 * about a dawn, because the tops of distant hills catch the sun several minutes
 * before the ground you are standing on does.
 *
 * The ground mist is this circuit's one genuine extra: 2.2x the ground-haze
 * sprite count, which is +8 sprites at the high tier and +4 at low. It is the
 * only place in the set where a preset asks for meaningfully more than the
 * baseline, and it is bought back by the mote count being below 1.
 */
const DEAD_MILE: EnvironmentDef = {
  id: "dead_mile",
  intent:
    "Twenty minutes after sunrise on a long pipeline road. Cold sky, one warm rake of light, mist in the hollows, and a very long way to go.",
  sky: {
    stops: [
      { y: 1.0, color: "#14264e" },
      { y: 0.52, color: "#2a4a76" },
      { y: 0.26, color: "#4e7a9c" },
      // The teal band. It exists for about fifteen minutes a day and it is the
      // single most recognisable thing about a dawn sky; leaving it out gives a
      // sunset with the colours reversed.
      { y: 0.11, color: "#8aa8b4" },
      { y: 0.035, color: "#d8a48c" },
      { y: 0.005, color: "#ffb884" },
      { y: -0.03, color: "#ffd8a0" },
      { y: -0.12, color: "#9a7460" },
      { y: -0.5, color: "#2a2430" },
    ],
    washDir: [-0.66, -0.24],
    washBias: 0.14,
    washColor: "#ffd2a0",
    washStrength: 0.48,
    background: "#2a4a76",
  },
  sun: {
    dir: [-794, 164, -287],
    disc: {
      visible: true,
      core: "#fff2e0",
      coreRadius: 28,
      glow: "#ffc088",
      glowScale: 175,
      glowOpacity: 0.9,
      flare: "#ff8a5c",
      flareScale: 300,
      flareOpacity: 0.26,
    },
  },
  light: {
    // 15 degrees: a 1.5m car throws a 5.6m shadow. The longest in the set, and
    // still comfortably inside the cascade.
    dir: [-86, 25, -31],
    color: "#ffc493",
    intensity: 2.1,
    // Cold and strong. Before the sun has any height, the sky is doing most of
    // the lighting, and it is blue. A warm ambient here collapses the whole
    // circuit back into "another orange desert".
    ambient: { color: "#8ea6c4", intensity: 0.66 },
    hemisphere: { sky: "#a8c0dc", ground: "#2a2a38", intensity: 1.2 },
    fill: { dir: [70, 34, 26], color: "#7e9ad0", intensity: 0.8 },
    rim: { dir: [-40, 12, -20], color: "#ffb87a", intensity: 0.35 },
    envIntensity: 0.85,
    headlights: {
      enabled: false,
      color: "#fff2d8",
      intensity: 1.2,
      distance: 40,
      angleDeg: 34,
    },
  },
  // Cold fog. Fog colour is the fastest single value in this file for saying
  // what time it is — a warm fog on a cold sky reads as a rendering fault.
  fog: { color: "#b4b0c0", near: 90, far: 640, farLow: 440 },
  terrain: {
    pack: "sand",
    uvPerMetre: 1 / 7.5,
    // The ramp does the dawn: hollows are still in the blue of the sky, crests
    // have the sun on them. Elevation is standing in for "has the light reached
    // it yet", which at fifteen degrees of sun elevation is very nearly true.
    hollow: "#4a4a60",
    low: "#7a7284",
    mid: "#a89a94",
    high: "#d8c2a0",
    face: "#55525c",
    faceStrength: 2.0,
    faceOnFlats: false,
    base: "#e4dcd0",
    roughness: 0.86,
    metalness: 0.02,
    envMapIntensity: 1.0,
    normalScale: 1.5,
    emissive: "#000000",
    emissiveIntensity: 0,
  },
  skyline: {
    mid: {
      seed: 311,
      peak: 48,
      baseY: 4,
      // The broadest landforms in the set. Big slow shapes are how you see that
      // something is far away without being told.
      featureSize: 240,
      sharpness: 0.6,
      relax: 0.36,
      octaves: 6,
      rockLow: "#4a4658",
      rockHigh: "#8e7c78",
      haze: "#b0a8bc",
      hazeMax: 0.66,
      bandHeight: 9,
      tileM: 50,
    },
    far: {
      seed: 349,
      peak: 96,
      baseY: 0,
      featureSize: 420,
      sharpness: 0.55,
      relax: 0.34,
      octaves: 6,
      rockLow: "#3e3c52",
      rockHigh: "#7c6c76",
      // Rose, while the ground is still blue. This is the dawn.
      haze: "#d8b8ac",
      hazeMax: 0.88,
      bandHeight: 13,
      tileM: 84,
    },
    detailPack: "rock",
    detailGain: [1.85, 1.8, 1.85],
  },
  atmosphere: {
    haze: { color: "#cfd4e0", opacityScale: 1.2, countScale: 1.1 },
    // The mist. This circuit's signature and its only real extra cost.
    ground: { color: "#d8dce8", opacityScale: 2.9, countScale: 1.8 },
    motes: {
      color: "#e8dcd0",
      opacityScale: 1.1,
      sizeScale: 1.2,
      // Below 1, to pay for the mist above.
      countScale: 0.85,
      // Falling, not drifting: this is settling dew and cold air, not wind.
      motion: "fall",
      additive: false,
    },
    clouds: {
      color: "#ffc8a8",
      opacityScale: 1.4,
      countScale: 1.1,
      height: 175,
      spanX: 250,
      spanY: 46,
    },
  },
  scatter: {
    rock: {
      color: "#8a8290",
      lo: [0.5, 0.5, 0.56],
      hi: [1.02, 0.96, 0.9],
      density: 0.9,
    },
    scrub: {
      color: "#9a9068",
      lo: [0.56, 0.58, 0.5],
      hi: [1.0, 0.94, 0.66],
      density: 0.8,
    },
    drift: { color: "#8a8494", density: 0.9 },
    rockPack: "rock",
    driftPack: "rust",
  },
  surfaces: {
    road: "#4e4e58",
    apron: "#7e7a80",
    yard: "#4a4650",
    sand: "#a89e9a",
    vergeDrift: "#b8ac9e",
    stripe: "#ffe8c8",
    roadRoughness: 0.72,
    roadEnvMapIntensity: 0.9,
    wetness: 0,
  },
  post: { grade: FIRST_LIGHT, bloomBias: 0.14, vignetteBias: 0.02 },
};

export const ENVIRONMENTS: Record<AnyTrackId, EnvironmentDef> = {
  ash_spire: ASH_SPIRE,
  cinder_bowl: CINDER_BOWL,
  foundry_pit: FOUNDRY_PIT,
  rustline: RUSTLINE,
  sable_run: SABLE_RUN,
  dead_mile: DEAD_MILE,
};

/** The one every fallback path lands on. */
export const DEFAULT_ENVIRONMENT = ASH_SPIRE;
