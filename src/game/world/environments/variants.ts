/**
 * The same six places at a different hour, and in different weather.
 *
 * ── why this is a transform and not twelve more presets ───────────────
 *
 * The obvious implementation is to author `ASH_SPIRE_NIGHT` next to
 * `ASH_SPIRE`. Six circuits times three hours is eighteen 150-line preset
 * blocks, and the moment anyone retunes a circuit's terrain ramp they have to
 * remember to retune it three times. That is not a content multiplier, it is a
 * maintenance multiplier — and it fails in the direction that is hardest to
 * notice, because the stale variant still renders.
 *
 * So an hour is a TRANSFORM over an EnvironmentDef. It replaces the things that
 * genuinely belong to the hour — the sky, the sun's position and colour, the
 * light rig, the fog, the grade — and it TINTS the things that belong to the
 * place: the terrain ramp, the scatter, the surfaces, the ridge rock. Ash Spire
 * at night is still Ash Spire's landform, Ash Spire's road, Ash Spire's rock
 * palette, seen under a different sky. That is what makes it read as the same
 * circuit at a different event rather than as a different circuit.
 *
 * ── the trap this file exists to avoid ────────────────────────────────
 *
 * `farRangeCeiling()` couples the sun's elevation to how tall the skyline may
 * be. Lower the sun for a sunset and every circuit's far range is suddenly
 * taller than the sun is high, which does not throw — it silently swallows the
 * disc, and the frame quietly loses its brightest object. So the transform
 * CLAMPS the ranges to the ceiling its own sun implies, and `validateVariants()`
 * asserts the clamp never has to remove more than 40% of a range: a variant
 * whose sun is so low that it flattens the horizon is a badly authored variant,
 * not something to silently accept.
 *
 * That is also why the sunset draws its disc at 14 degrees while its KEY LIGHT
 * sits at 8. The disc's elevation is a skyline budget; the key light's elevation
 * is shadow length. Cinder Bowl already makes this trade explicitly at 13
 * degrees — see the note at the top of presets.ts — and this is the same trade
 * applied to all six.
 */
import * as THREE from "three";
import type {
  AtmosphereDef,
  EnvironmentDef,
  Hex,
  ScatterLayerDef,
  SkyDef,
  SkyStop,
  Vec3,
} from "./types";
import type { WeatherDef } from "../weather/conditions";
import { WEATHER, getWeatherId } from "../weather/conditions";
import type { GradeOptions } from "../GradeEffect";

/* ── colour maths, deliberately not THREE.Color ───────────────────────── */

/*
 * Hex in, hex out, no allocation of a Color per stop.
 *
 * This module is imported by index.ts, which is imported by physics-adjacent
 * headless checks through the weather module. Keeping it to plain arithmetic
 * means the variant table can be validated without a renderer, and means the
 * transform runs once per circuit-condition pair rather than per frame.
 */
function parse(hex: Hex): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function toHex(r: number, g: number, b: number): Hex {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function mix(a: Hex, b: Hex, t: number): Hex {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  return toHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

/**
 * Multiply an albedo, then pull it toward a light colour.
 *
 * Two operations rather than one because they are two different physical
 * things: the multiply is how much light is falling on the surface, the pull is
 * what COLOUR that light is. A night that only multiplies gives you a dark
 * orange desert, which is wrong — at night the sand is lit by a blue-grey sky
 * and is a blue-grey, not a dim version of its daytime self. Chromatic
 * adaptation is most of what makes a night render read as night rather than as
 * an underexposed day.
 */
function relight(hex: Hex, tint: Vec3, toward: Hex, amount: number): Hex {
  const [r, g, b] = parse(hex);
  const lit = toHex(r * tint[0], g * tint[1], b * tint[2]);
  return amount > 0 ? mix(lit, toward, amount) : lit;
}

/* ── what an hour is ──────────────────────────────────────────────────── */

export type TimeOfDayId = "default" | "sunset" | "night";

export type TimeOfDayDef = {
  id: TimeOfDayId;
  label: string;
  intent: string;
  /** Wholesale replacement — the sky IS the hour. */
  sky: Omit<SkyDef, "washDir"> & { washDirFromSun: boolean };
  /** Elevation the DISC is drawn at, in degrees. Azimuth is kept per circuit. */
  discElevationDeg: number;
  disc: {
    core: Hex;
    coreRadius: number;
    glow: Hex;
    glowScale: number;
    glowOpacity: number;
    flare: Hex;
    flareScale: number;
    flareOpacity: number;
  };
  /** Elevation the KEY LIGHT sits at. Sets shadow length, not visibility. */
  keyElevationDeg: number;
  light: {
    color: Hex;
    intensityMul: number;
    ambient: { color: Hex; intensityMul: number };
    hemisphere: { sky: Hex; ground: Hex; intensityMul: number };
    fill: { color: Hex; intensityMul: number };
    rim: { color: Hex; intensityMul: number };
    envIntensityMul: number;
    /**
     * Headlights.
     *
     * Not mounted here — GameScene owns the car rig. This is the value it reads.
     * At night they stop being decoration: the key light is 0.35 and the fog is
     * at 240m, so the cone in front of the car is most of the information the
     * player has about the next corner.
     */
    headlights: {
      enabled: boolean;
      color: Hex;
      intensity: number;
      /** Metres of throw, and the full cone angle in degrees. */
      distance: number;
      angleDeg: number;
    };
  };
  fog: { tint: Hex; tintAmount: number; nearMul: number; farMul: number };
  /** Multiplies every albedo in the world, before the chromatic pull below. */
  albedoTint: Vec3;
  /** Colour the albedos are pulled toward, and how far. See `relight`. */
  albedoToward: Hex;
  albedoTowardAmount: number;
  /** Ridge haze is the hour's, not the place's — it is airlight. */
  ridgeHaze: Hex;
  ridgeHazeMix: number;
  /** Gain on the skyline detail material. Dark hours want LESS, never none. */
  detailGainMul: number;
  atmosphere: {
    hazeTint: Hex;
    hazeTintAmount: number;
    hazeOpacityMul: number;
    groundOpacityMul: number;
    moteTint: Hex;
    moteTintAmount: number;
    moteOpacityMul: number;
    cloudTint: Hex;
    cloudTintAmount: number;
    cloudOpacityMul: number;
  };
  /** Replaces the circuit's grade outright — grading is where an hour lands. */
  grade: Required<GradeOptions>;
  bloomBias: number;
  vignetteBias: number;
  /**
   * Lane paint is retroreflective. It is the ONE surface that gets brighter
   * relative to everything else as the light goes away, which is why a night
   * road reads as a road at all.
   */
  stripeLift: number;
};

const DEG = Math.PI / 180;

/**
 * ── Sunset ────────────────────────────────────────────────────────────
 *
 * The hour every racing game reaches for, and the one it is easiest to get
 * wrong by making it orange. What actually distinguishes a sunset is not hue,
 * it is that the two light sources have SEPARATED: the sun is a warm, nearly
 * horizontal key and the sky is a cold, very large fill, and they are within an
 * order of magnitude of each other for about twenty minutes. Everything below
 * serves that split — the hard warm/cold `shadowTint`/`highTint` opposition in
 * the grade, the raised fill, the low key elevation that makes shadows long
 * enough to be read as shapes rather than as contact.
 *
 * The key sits at 8 degrees: a 1.4m car casts a 10m shadow, comfortably inside
 * the 55m cascade, and long enough that the whole field trails shadows down the
 * road. Push it to 5 and the shadows leave the cascade and pop.
 */
export const SUNSET: TimeOfDayDef = {
  id: "sunset",
  label: "Sunset",
  intent:
    "Twenty minutes of the sun on the deck. Warm key, cold sky, shadows long enough to drive by.",
  sky: {
    stops: [
      { y: 1.0, color: "#182a4e" },
      { y: 0.55, color: "#2f4a78" },
      { y: 0.26, color: "#6d6f92" },
      { y: 0.1, color: "#c07a62" },
      { y: 0.02, color: "#f0a058" },
      { y: -0.04, color: "#ffd08a" },
      { y: -0.14, color: "#b0602e" },
      { y: -0.5, color: "#2a180e" },
    ],
    washBias: 0.16,
    washColor: "#ffcf96",
    washStrength: 0.58,
    background: "#3b3e63",
    washDirFromSun: true,
  },
  discElevationDeg: 14,
  disc: {
    core: "#fff0cc",
    coreRadius: 34,
    glow: "#ffc07a",
    glowScale: 210,
    glowOpacity: 0.92,
    flare: "#ff8a3c",
    flareScale: 380,
    flareOpacity: 0.34,
  },
  keyElevationDeg: 8,
  light: {
    color: "#ffc487",
    intensityMul: 0.88,
    ambient: { color: "#c8b8d0", intensityMul: 0.82 },
    hemisphere: { sky: "#ffab72", ground: "#241a20", intensityMul: 0.95 },
    fill: { color: "#7a9cd8", intensityMul: 1.45 },
    rim: { color: "#ffb060", intensityMul: 1.6 },
    envIntensityMul: 0.82,
    headlights: {
      enabled: true,
      color: "#fff2d8",
      intensity: 1.4,
      distance: 45,
      angleDeg: 34,
    },
  },
  fog: { tint: "#e0a070", tintAmount: 0.5, nearMul: 0.85, farMul: 0.82 },
  albedoTint: [0.94, 0.84, 0.78],
  albedoToward: "#ff9a52",
  albedoTowardAmount: 0.16,
  ridgeHaze: "#f0a468",
  ridgeHazeMix: 0.6,
  detailGainMul: 0.92,
  atmosphere: {
    hazeTint: "#ffb478",
    hazeTintAmount: 0.6,
    hazeOpacityMul: 1.25,
    groundOpacityMul: 1.2,
    moteTint: "#ffcc96",
    moteTintAmount: 0.5,
    moteOpacityMul: 1.15,
    cloudTint: "#ffb182",
    cloudTintAmount: 0.62,
    cloudOpacityMul: 1.2,
  },
  /*
   * Maximum split-tone in the set, for the same reason FIRST_LIGHT has it:
   * this is one of the two hours when the shadows and the highlights genuinely
   * come from two different sources of comparable strength. Contrast is UP, not
   * down — a low sun is a low sun, not a dimmer.
   */
  grade: {
    slope: new THREE.Vector3(1.12, 0.99, 0.9),
    offset: new THREE.Vector3(-0.014, -0.01, 0.008),
    power: new THREE.Vector3(1.0, 1.04, 1.1),
    shadowTint: new THREE.Vector3(-0.07, -0.02, 0.17),
    highTint: new THREE.Vector3(0.16, 0.06, -0.1),
    saturation: 1.2,
    contrast: 1.14,
    split: 1.0,
    vibrance: 0.26,
  },
  bloomBias: 0.08,
  vignetteBias: 0.04,
  stripeLift: 0.08,
};

/**
 * ── Night ─────────────────────────────────────────────────────────────
 *
 * The one that needs care, and the care is not "make it dark".
 *
 * Two constraints fight here. This is a COMBAT arena — four cars, projectiles,
 * mines, a road edge that wrecks you — and a player who cannot tell the field
 * apart is not experiencing atmosphere, they are experiencing a bug. But a
 * night that is readable everywhere is not a night. The resolution is the same
 * one the Foundry Pit already uses: keep the AMBIENT and HEMISPHERE floor high
 * enough that a car body is never a pure silhouette, take all the drama out of
 * the KEY, and push `vibrance` hard so the muted mid-tones a dark car sits in
 * lift while the already-saturated brake lights and weapon FX do not.
 *
 * The moon is drawn at 42 degrees rather than low, and that is a budget
 * decision as much as an art one: at 42 degrees `farRangeCeiling` is over 500m,
 * so no circuit's skyline has to be clamped, and the moon's key light can sit at
 * 34 degrees where shadows are short and stay well inside the 55m cascade.
 * Shadows are nearly worthless at night anyway — the moon is 400,000x dimmer
 * than the sun and real moonlight shadows are barely visible — so spending the
 * cascade on a low, long, dramatic moon shadow would buy an artefact.
 *
 * Headlights are load-bearing here, not decoration. GameScene has to mount them
 * (see `light.headlights`); without them the fog at 190m and a 0.35 key make the
 * next corner genuinely unreadable.
 */
export const NIGHT: TimeOfDayDef = {
  id: "night",
  label: "Night",
  intent:
    "Moonlight and headlights. Dark enough to matter, legible enough to fight in.",
  sky: {
    stops: [
      { y: 1.0, color: "#050914" },
      { y: 0.5, color: "#0a1226" },
      { y: 0.18, color: "#152238" },
      { y: 0.03, color: "#243348" },
      { y: -0.02, color: "#33404f" },
      { y: -0.16, color: "#1b2028" },
      { y: -0.5, color: "#070809" },
    ],
    washBias: 0.1,
    washColor: "#4a5c7a",
    washStrength: 0.32,
    background: "#0a1020",
    washDirFromSun: true,
  },
  discElevationDeg: 42,
  disc: {
    core: "#eaf0ff",
    coreRadius: 14,
    glow: "#b6c8e8",
    glowScale: 78,
    glowOpacity: 0.55,
    // A moon has no flare worth drawing. Zero opacity, and the low tier skips
    // the sprite entirely, so this is one fewer large alpha-blended quad than
    // any daylight hour.
    flare: "#8ea4c8",
    flareScale: 150,
    flareOpacity: 0.0,
  },
  keyElevationDeg: 34,
  light: {
    color: "#93aede",
    intensityMul: 0.14,
    /*
     * Ambient DOWN by less than the key, and hemisphere barely at all.
     *
     * Scaling the whole rig by the same factor is how a night ends up
     * unplayable. The key falls by 86%; the ambient by 32% and the hemisphere by
     * 22%, because what is actually lighting the scene at night is the sky dome
     * and the ground bounce, not the moon.
     */
    ambient: { color: "#5b6f96", intensityMul: 0.68 },
    hemisphere: { sky: "#3d5480", ground: "#0c1018", intensityMul: 0.78 },
    fill: { color: "#6a86bc", intensityMul: 0.85 },
    rim: { color: "#a8c0f0", intensityMul: 1.15 },
    envIntensityMul: 0.35,
    headlights: {
      enabled: true,
      color: "#fff4e2",
      intensity: 4.2,
      distance: 62,
      angleDeg: 38,
    },
  },
  fog: { tint: "#1a2436", tintAmount: 0.85, nearMul: 0.7, farMul: 0.62 },
  albedoTint: [0.4, 0.44, 0.54],
  albedoToward: "#2c3c58",
  albedoTowardAmount: 0.34,
  ridgeHaze: "#1e2a40",
  ridgeHazeMix: 0.75,
  // Less, never none. Dropping this to 1 does not make the range dark, it makes
  // the range's own colour design disappear — see SkylineDef.detailGain.
  detailGainMul: 0.7,
  atmosphere: {
    hazeTint: "#2a3a56",
    hazeTintAmount: 0.72,
    hazeOpacityMul: 1.1,
    groundOpacityMul: 1.35,
    moteTint: "#8aa0c8",
    moteTintAmount: 0.6,
    moteOpacityMul: 0.85,
    cloudTint: "#1c2740",
    cloudTintAmount: 0.7,
    cloudOpacityMul: 0.9,
  },
  /*
   * Lifted blacks, low saturation, high vibrance.
   *
   * Crushing the blacks is the instinct and it is wrong twice over: it removes
   * the only information in the darkest 30% of a night frame, and real night
   * vision has LESS contrast in the shadows, not more, because it is running out
   * of photons. The vibrance is the safety valve described above.
   */
  grade: {
    slope: new THREE.Vector3(0.9, 0.95, 1.08),
    offset: new THREE.Vector3(0.016, 0.02, 0.03),
    power: new THREE.Vector3(1.08, 1.06, 0.98),
    shadowTint: new THREE.Vector3(-0.05, 0.0, 0.16),
    highTint: new THREE.Vector3(0.06, 0.04, 0.02),
    saturation: 0.82,
    contrast: 1.06,
    split: 0.9,
    vibrance: 0.34,
  },
  bloomBias: 0.14,
  vignetteBias: 0.12,
  stripeLift: 0.34,
};

export const TIMES_OF_DAY: Record<Exclude<TimeOfDayId, "default">, TimeOfDayDef> =
  {
    sunset: SUNSET,
    night: NIGHT,
  };

/* ── the transform ────────────────────────────────────────────────────── */

/** Re-aim a direction vector to a new elevation, keeping its azimuth. */
function atElevation(dir: Vec3, elevationDeg: number): Vec3 {
  const [x, , z] = dir;
  const horiz = Math.hypot(x, z) || 1;
  const len = Math.hypot(x, dir[1], z) || 1;
  const e = elevationDeg * DEG;
  const h = Math.cos(e) * len;
  return [(x / horiz) * h, Math.sin(e) * len, (z / horiz) * h];
}

function tintLayer(
  layer: ScatterLayerDef,
  tint: Vec3,
  toward: Hex,
  amount: number,
): ScatterLayerDef {
  return { ...layer, color: relight(layer.color, tint, toward, amount) };
}

function applyTimeOfDay(base: EnvironmentDef, t: TimeOfDayDef): EnvironmentDef {
  const tint = t.albedoTint;
  const toward = t.albedoToward;
  const amt = t.albedoTowardAmount;
  const lit = (hex: Hex) => relight(hex, tint, toward, amt);

  const sunDir = atElevation(base.sun.dir, t.discElevationDeg);
  const horiz = Math.hypot(sunDir[0], sunDir[2]) || 1;

  const atmo: AtmosphereDef = {
    haze: {
      color: mix(base.atmosphere.haze.color, t.atmosphere.hazeTint, t.atmosphere.hazeTintAmount),
      opacityScale: base.atmosphere.haze.opacityScale * t.atmosphere.hazeOpacityMul,
      countScale: base.atmosphere.haze.countScale,
    },
    ground: {
      color: mix(base.atmosphere.ground.color, t.atmosphere.hazeTint, t.atmosphere.hazeTintAmount),
      opacityScale: base.atmosphere.ground.opacityScale * t.atmosphere.groundOpacityMul,
      countScale: base.atmosphere.ground.countScale,
    },
    motes: {
      ...base.atmosphere.motes,
      color: mix(base.atmosphere.motes.color, t.atmosphere.moteTint, t.atmosphere.moteTintAmount),
      opacityScale: base.atmosphere.motes.opacityScale * t.atmosphere.moteOpacityMul,
    },
    clouds: {
      ...base.atmosphere.clouds,
      color: mix(base.atmosphere.clouds.color, t.atmosphere.cloudTint, t.atmosphere.cloudTintAmount),
      opacityScale: base.atmosphere.clouds.opacityScale * t.atmosphere.cloudOpacityMul,
    },
  };

  const [gr, gg, gb] = base.skyline.detailGain;
  const m = t.detailGainMul;

  return {
    ...base,
    sky: {
      stops: t.sky.stops.map((s) => ({ ...s })),
      // Keep the wash on the circuit's own sun bearing so the brightest part of
      // the dome still agrees with where the disc is drawn.
      washDir: t.sky.washDirFromSun
        ? [sunDir[0] / horiz, sunDir[2] / horiz]
        : base.sky.washDir,
      washBias: t.sky.washBias,
      washColor: t.sky.washColor,
      washStrength: t.sky.washStrength,
      background: t.sky.background,
    },
    sun: {
      dir: sunDir,
      disc: { visible: base.sun.disc.visible, ...t.disc },
    },
    light: {
      dir: atElevation(base.light.dir, t.keyElevationDeg),
      color: t.light.color,
      intensity: base.light.intensity * t.light.intensityMul,
      ambient: {
        color: t.light.ambient.color,
        intensity: base.light.ambient.intensity * t.light.ambient.intensityMul,
      },
      hemisphere: {
        sky: t.light.hemisphere.sky,
        ground: t.light.hemisphere.ground,
        intensity: base.light.hemisphere.intensity * t.light.hemisphere.intensityMul,
      },
      fill: {
        dir: base.light.fill.dir,
        color: t.light.fill.color,
        intensity: base.light.fill.intensity * t.light.fill.intensityMul,
      },
      rim: {
        dir: base.light.rim.dir,
        color: t.light.rim.color,
        intensity: base.light.rim.intensity * t.light.rim.intensityMul,
      },
      envIntensity: base.light.envIntensity * t.light.envIntensityMul,
      headlights: { ...t.light.headlights },
    },
    fog: {
      color: mix(base.fog.color, t.fog.tint, t.fog.tintAmount),
      near: base.fog.near * t.fog.nearMul,
      far: base.fog.far * t.fog.farMul,
      farLow: base.fog.farLow * t.fog.farMul,
    },
    terrain: {
      ...base.terrain,
      hollow: lit(base.terrain.hollow),
      low: lit(base.terrain.low),
      mid: lit(base.terrain.mid),
      high: lit(base.terrain.high),
      face: lit(base.terrain.face),
      base: lit(base.terrain.base),
      envMapIntensity: base.terrain.envMapIntensity * t.light.envIntensityMul,
    },
    skyline: {
      ...base.skyline,
      mid: {
        ...base.skyline.mid,
        rockLow: lit(base.skyline.mid.rockLow),
        rockHigh: lit(base.skyline.mid.rockHigh),
        haze: mix(base.skyline.mid.haze, t.ridgeHaze, t.ridgeHazeMix),
      },
      far: {
        ...base.skyline.far,
        rockLow: lit(base.skyline.far.rockLow),
        rockHigh: lit(base.skyline.far.rockHigh),
        haze: mix(base.skyline.far.haze, t.ridgeHaze, t.ridgeHazeMix),
      },
      detailGain: [gr * m, gg * m, gb * m],
    },
    atmosphere: atmo,
    scatter: {
      ...base.scatter,
      rock: tintLayer(base.scatter.rock, tint, toward, amt),
      scrub: tintLayer(base.scatter.scrub, tint, toward, amt),
      drift: tintLayer(base.scatter.drift, tint, toward, amt),
    },
    surfaces: {
      road: lit(base.surfaces.road),
      apron: lit(base.surfaces.apron),
      yard: lit(base.surfaces.yard),
      sand: lit(base.surfaces.sand),
      vergeDrift: lit(base.surfaces.vergeDrift),
      // Retroreflective paint. Tinted like everything else, then lifted back
      // toward white — the darker the hour, the further back.
      stripe: mix(lit(base.surfaces.stripe), "#fffaf0", t.stripeLift),
      roadRoughness: base.surfaces.roadRoughness,
      roadEnvMapIntensity: base.surfaces.roadEnvMapIntensity,
      wetness: base.surfaces.wetness,
    },
    post: {
      grade: t.grade,
      bloomBias: base.post.bloomBias + t.bloomBias,
      vignetteBias: base.post.vignetteBias + t.vignetteBias,
    },
  };
}

/* ── weather, applied on top of the hour ──────────────────────────────── */

function scaleGrade(
  g: Required<GradeOptions>,
  satMul: number,
  contrastMul: number,
  blackLift: number,
): Required<GradeOptions> {
  /*
   * A NEW Vector3, never a mutation.
   *
   * The grade presets are module-level singletons shared by every circuit that
   * names them, and GradeEffect only clones them at construction. Adding the
   * black lift in place would permanently raise DESERT_DUSK's blacks for every
   * later race on every circuit, and it would do it silently — the first race
   * would look right.
   */
  return {
    ...g,
    offset: new THREE.Vector3(
      g.offset.x + blackLift,
      g.offset.y + blackLift,
      g.offset.z + blackLift * 1.1,
    ),
    saturation: g.saturation * satMul,
    contrast: g.contrast * contrastMul,
  };
}

function applyWeather(env: EnvironmentDef, w: WeatherDef): EnvironmentDef {
  const L = w.look;
  if (L.overcast <= 0) return env;

  const cloud = L.cloudColor;
  const oc = L.overcast;
  const tint = L.albedoTint;
  const lit = (hex: Hex) => relight(hex, tint, cloud, oc * 0.22);

  /*
   * Blend the hour's sky toward the cloud deck rather than replacing it.
   *
   * A wet sunset is still a sunset: the deck is lit from underneath by the same
   * low sun and keeps a warm underside. Replacing the ramp outright gives every
   * wet hour the same grey sky, which throws away the whole point of having
   * hours. The blend is stronger at the TOP of the dome than at the horizon,
   * because that is where the cloud base is actually opaque.
   */
  const stops: SkyStop[] = env.sky.stops.map((s) => {
    const height = Math.max(0, Math.min(1, (s.y + 0.5) / 1.5));
    return { y: s.y, color: mix(s.color, cloud, oc * (0.55 + height * 0.45)) };
  });

  const hideDisc = oc >= L.hideDiscAbove;

  return {
    ...env,
    sky: {
      ...env.sky,
      stops,
      washColor: mix(env.sky.washColor, cloud, oc * 0.7),
      washStrength: env.sky.washStrength * (1 - oc * 0.6),
      background: mix(env.sky.background, cloud, oc * 0.8),
    },
    sun: {
      ...env.sun,
      // A hidden disc also removes the skyline ceiling entirely, which is why
      // the clamp below runs AFTER this rather than before it.
      disc: { ...env.sun.disc, visible: env.sun.disc.visible && !hideDisc },
    },
    light: {
      ...env.light,
      color: mix(env.light.color, cloud, oc * 0.55),
      intensity: env.light.intensity * L.keyMul,
      ambient: {
        color: mix(env.light.ambient.color, cloud, oc * 0.5),
        intensity: env.light.ambient.intensity * L.ambientMul,
      },
      hemisphere: {
        sky: mix(env.light.hemisphere.sky, cloud, oc * 0.75),
        ground: env.light.hemisphere.ground,
        intensity: env.light.hemisphere.intensity * L.hemiMul,
      },
      fill: { ...env.light.fill, intensity: env.light.fill.intensity * L.fillMul },
      rim: { ...env.light.rim, intensity: env.light.rim.intensity * (1 - oc * 0.7) },
      // Rain is a reason to turn the lights on at any hour.
      headlights: env.light.headlights.enabled
        ? env.light.headlights
        : {
            enabled: true,
            color: "#fff6e6",
            intensity: 1.2 + w.wetness * 0.8,
            distance: 42,
            angleDeg: 34,
          },
    },
    fog: {
      color: mix(env.fog.color, L.fogTint, L.fogTintAmount),
      near: env.fog.near * L.fogNearMul,
      far: env.fog.far * L.fogFarMul,
      farLow: env.fog.farLow * L.fogFarMul,
    },
    terrain: {
      ...env.terrain,
      hollow: lit(env.terrain.hollow),
      low: lit(env.terrain.low),
      mid: lit(env.terrain.mid),
      high: lit(env.terrain.high),
      face: lit(env.terrain.face),
      base: lit(env.terrain.base),
      // Wet ground is smoother and more reflective, same as the road, just less
      // of it — sand drains and stays matte, rock sheets over.
      roughness: env.terrain.roughness * (1 - w.wetness * 0.22),
      envMapIntensity: env.terrain.envMapIntensity * (1 + w.wetness * 0.5),
    },
    skyline: {
      ...env.skyline,
      mid: { ...env.skyline.mid, haze: mix(env.skyline.mid.haze, cloud, oc * 0.8) },
      far: { ...env.skyline.far, haze: mix(env.skyline.far.haze, cloud, oc * 0.85) },
    },
    atmosphere: {
      haze: {
        color: mix(env.atmosphere.haze.color, cloud, oc * 0.75),
        opacityScale: env.atmosphere.haze.opacityScale * L.hazeOpacityMul,
        countScale: env.atmosphere.haze.countScale,
      },
      ground: {
        color: mix(env.atmosphere.ground.color, cloud, oc * 0.7),
        opacityScale: env.atmosphere.ground.opacityScale * L.groundOpacityMul,
        countScale: env.atmosphere.ground.countScale,
      },
      motes: {
        ...env.atmosphere.motes,
        color: mix(env.atmosphere.motes.color, "#b6c4d0", oc * 0.8),
        // The low tier's rain. `fall` is one branch in a loop that is already
        // running, so this costs nothing and is the only rain that tier gets.
        motion: w.rain ? "fall" : env.atmosphere.motes.motion,
        additive: w.rain ? false : env.atmosphere.motes.additive,
        opacityScale: env.atmosphere.motes.opacityScale * (w.rain ? 1.3 : 1),
      },
      clouds: {
        ...env.atmosphere.clouds,
        color: mix(env.atmosphere.clouds.color, cloud, oc * 0.85),
        opacityScale: env.atmosphere.clouds.opacityScale * L.cloudOpacityMul,
        // Clamped to COUNT_SCALE_MAX here as well as at use. `scaleCount` would
        // clamp it anyway, but leaving an out-of-range number in the resolved
        // definition means the only place it is visible is a debug print, and
        // an environment that ASKS for four times the sprite budget is worth
        // catching whether or not something downstream saves it.
        countScale: Math.min(2.6, env.atmosphere.clouds.countScale * L.cloudCountMul),
        // The deck comes down. A high cirrus sheet under rain reads as a
        // painted ceiling; the thing overhead in rain is low and close.
        height: env.atmosphere.clouds.height * (1 - oc * 0.42),
        spanX: env.atmosphere.clouds.spanX * (1 + oc * 0.35),
      },
    },
    scatter: {
      ...env.scatter,
      rock: tintLayer(env.scatter.rock, tint, cloud, oc * 0.22),
      scrub: tintLayer(env.scatter.scrub, tint, cloud, oc * 0.22),
      drift: tintLayer(env.scatter.drift, tint, cloud, oc * 0.22),
    },
    surfaces: {
      ...env.surfaces,
      // Hue is barely touched. A wet road is a DARKER, SMOOTHER road, and the
      // reflection does the rest — see WeatherLookDef.roadDarken.
      road: relight(env.surfaces.road, [L.roadDarken, L.roadDarken, L.roadDarken * 1.04], cloud, 0.1),
      apron: relight(env.surfaces.apron, [L.roadDarken, L.roadDarken, L.roadDarken * 1.04], cloud, 0.1),
      yard: lit(env.surfaces.yard),
      sand: lit(env.surfaces.sand),
      vergeDrift: lit(env.surfaces.vergeDrift),
      stripe: env.surfaces.stripe,
      roadRoughness: L.roadRoughness,
      roadEnvMapIntensity: L.roadEnvMapIntensity,
      wetness: w.wetness,
    },
    post: {
      grade: scaleGrade(env.post.grade, L.saturationMul, L.contrastMul, L.blackLift),
      bloomBias: env.post.bloomBias + L.bloomBias,
      vignetteBias: env.post.vignetteBias + L.vignetteBias,
    },
  };
}

/* ── the skyline clamp ────────────────────────────────────────────────── */

/**
 * Hold both ranges under the ceiling this variant's sun implies.
 *
 * Takes the ceiling functions as arguments rather than importing them, because
 * they live in ./index.ts and ./index.ts imports this file. A circular import
 * here resolves to `undefined` at module-init time under jiti and produces a
 * ceiling of NaN, which compares false against everything and silently disables
 * the clamp — the exact failure mode this clamp exists to prevent.
 */
export function clampSkyline(
  env: EnvironmentDef,
  farCeiling: (e: EnvironmentDef) => number,
  midCeiling: (e: EnvironmentDef) => number,
): EnvironmentDef {
  const fc = farCeiling(env);
  const mc = midCeiling(env);
  if (env.skyline.far.peak <= fc && env.skyline.mid.peak <= mc) return env;
  return {
    ...env,
    skyline: {
      ...env.skyline,
      far: { ...env.skyline.far, peak: Math.min(env.skyline.far.peak, fc) },
      mid: { ...env.skyline.mid, peak: Math.min(env.skyline.mid.peak, mc) },
    },
  };
}

/* ── conditions: what hour and what weather this circuit is running ───── */

export type Conditions = { timeOfDay: TimeOfDayId; weather: WeatherDef["id"] };

/**
 * Per-circuit DEFAULTS.
 *
 * All six ship at their authored hour and dry, on purpose. The six presets are
 * the circuits' identities and the QA baselines are shot against them; a
 * variant that arrives by default is a change to a circuit rather than an
 * addition to the game. Sunset, night and rain are things a MISSION asks for.
 *
 * Change one line here to make a circuit permanently wet or nocturnal.
 */
const CIRCUIT_DEFAULTS: Record<string, Conditions> = {
  ash_spire: { timeOfDay: "default", weather: "dry" },
  cinder_bowl: { timeOfDay: "default", weather: "dry" },
  foundry_pit: { timeOfDay: "default", weather: "dry" },
  rustline: { timeOfDay: "default", weather: "dry" },
  sable_run: { timeOfDay: "default", weather: "dry" },
  dead_mile: { timeOfDay: "default", weather: "dry" },
};

export function circuitDefaults(id: string): Conditions {
  return CIRCUIT_DEFAULTS[id] ?? { timeOfDay: "default", weather: "dry" };
}

/*
 * Mission override. Null means "use the circuit's default".
 *
 * A function pair, never an exported binding — jiti snapshots namespace
 * properties, so `export let override` would read as null in every headless
 * check no matter what a mission set. AGENTS.md §4.
 */
let overrideTime: TimeOfDayId | null = null;
let variantEpoch = 0;

/**
 * Set by the mission runtime before `setActiveTrack`. Passing null clears back
 * to the circuit's own default, which is what a career race with no weather
 * field should do.
 */
export function setTimeOfDay(id: TimeOfDayId | null): void {
  if (overrideTime === id) return;
  overrideTime = id;
  variantEpoch++;
}

export function getTimeOfDayOverride(): TimeOfDayId | null {
  return overrideTime;
}

export function getVariantEpoch(): number {
  return variantEpoch;
}

/** Resolved conditions for a circuit: mission override first, then default. */
export function resolveConditions(trackId: string): Conditions {
  const d = circuitDefaults(trackId);
  return {
    timeOfDay: overrideTime ?? d.timeOfDay,
    // The weather module owns its own active id; `setWeather(null)` does not
    // exist, so a mission that wants the circuit default simply sets it back to
    // `dry` — which for all six circuits is the default.
    weather: getWeatherId() !== "dry" ? getWeatherId() : d.weather,
  };
}

/** Apply an hour and a condition to a base preset. Pure; safe to memoise. */
export function applyConditions(
  base: EnvironmentDef,
  c: Conditions,
  farCeiling: (e: EnvironmentDef) => number,
  midCeiling: (e: EnvironmentDef) => number,
): EnvironmentDef {
  let env = base;
  if (c.timeOfDay !== "default") {
    env = applyTimeOfDay(env, TIMES_OF_DAY[c.timeOfDay]);
  }
  const w = WEATHER[c.weather] ?? WEATHER.dry;
  env = applyWeather(env, w);
  // Last, and only once: applyWeather can hide the disc, which lifts the
  // ceiling to Infinity and makes an earlier clamp a pointless amputation.
  return clampSkyline(env, farCeiling, midCeiling);
}
