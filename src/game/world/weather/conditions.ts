/**
 * Weather as a CONDITION, not an overlay.
 *
 * ── why this file has no `three` import, and must not grow one ────────
 *
 * It lives under `world/` because that is where the look lives, but physics.ts
 * and tires.ts import it and those two run inside `GameSimulation`, which
 * mission-smoke.mjs constructs headlessly. Pulling `three` into this module
 * pulls it into the sim graph and breaks 743 checks in one line. Same rule that
 * makes setpieceColliders.ts import scatter *placement* rather than the package
 * index. The renderer half of weather is in ./RainCurtain.tsx and nothing in the
 * sim may import it.
 *
 * ── what a condition is allowed to be ─────────────────────────────────
 *
 * Same contract as EnvironmentDef: a condition SWAPS parameters, it never
 * mounts a system. The one exception is the rain curtain, which is a single
 * draw call and is paid for by the sun disc it turns off (a mesh and two
 * sprites) — see RAIN_BUDGET below. That is a net saving, and it is stated as a
 * number rather than assumed, because "weather" is exactly the kind of feature
 * that arrives as three extra passes nobody costed.
 *
 * ── the grip model ────────────────────────────────────────────────────
 *
 * Peak longitudinal/lateral μ for a road tyre on hot-mix asphalt is about
 * 1.0–1.1 dry. Add a water film and two separate things happen, and conflating
 * them is why naive wet handling feels like driving on ice rather than in rain:
 *
 * 1. PEAK μ FALLS, to roughly 0.75–0.85 of dry for a damp-to-wet surface and
 *    0.65–0.72 once there is standing water. That is `grip.road`.
 * 2. THE BREAKAWAY GETS SHARPER. A wet tyre's slip curve has a narrower, less
 *    forgiving peak — the shoulder between "gripping" and "gone" that gives a
 *    dry tyre its progressive feel is largely a property of rubber deforming
 *    into the road texture, and a water film removes the texture. Lowering peak
 *    μ alone does not model this: it makes the car slower in corners but no
 *    twitchier at the limit.
 *
 * `slideBiasMul` is what carries (2). VehicleClassDef separates `grip` from
 * `slideBias` precisely so "corners fast" and "does not snap sideways" can move
 * independently — see the DRIFT block in balance.ts — and a wet surface is the
 * textbook case for moving the second one on its own.
 *
 * `powerSlip` is the third leg: the friction circle. Total tyre force is
 * bounded by μ·N regardless of direction, so longitudinal demand from the
 * throttle steals from the lateral budget. Dry, there is enough μ that a
 * mid-corner throttle application is nowhere near the boundary; wet, the same
 * pedal puts a rear tyre over it. That is what "snap oversteer under power"
 * physically IS, and it has to be throttle-dependent or it is just less grip
 * with a different name.
 *
 * ── standing water is a PLACE, not a level ────────────────────────────
 *
 * `apronExtra` is the worst-surface term. Aprons are dished, unsealed and drain
 * badly, so that is where the water actually stands, and running wide off the
 * racing line in the rain should cost more than running wide in the dry — which
 * is a real driving decision the dry game does not have.
 *
 * `looseMul` goes the other WAY, above 1, and that is not a mistake. Damp sand
 * and dirt PACK: a wetted loose surface carries more shear than a dry dusty one,
 * which is why rally stages are quicker after rain and slower once they turn to
 * mud. The mud shows up as `rollDragAdd`, not as lost grip.
 */

/** Four conditions. Two of them are look-only; only rain touches the physics. */
export type WeatherId = "dry" | "overcast" | "wet" | "storm";

export type WeatherGrip = {
  /** Multiplier on peak grip while on sealed tarmac. */
  road: number;
  /** Further multiplier on the apron, where the water stands. */
  apronExtra: number;
  /** Multiplier on loose surfaces. Above 1 on purpose — damp grit packs. */
  looseMul: number;
  /** Multiplier on VehicleClassDef.slideBias — the breakaway, not the peak. */
  slideBiasMul: number;
  /** Fraction of lateral grip a full-throttle longitudinal demand eats. */
  powerSlip: number;
  /** Multiplier on HANDLING.brakeForceMul. Braking distance scales as 1/this. */
  brakeMul: number;
  /** Added to the surface's rolling-resistance rate. Water displacement, mud. */
  rollDragAdd: number;
  /**
   * Wet-road cooling, as a rate ADDED to the tyre's cooling constant — never a
   * multiplier on it.
   *
   * This started as a multiplier on `COMPOUND.cool` and it broke class balance
   * outright: 3.7 points of win-rate spread dry became 10.6 wet and 16.2 in a
   * storm, with the Interceptor losing 5 points and the Trickster gaining 6.
   * The mechanism was that a multiplier scales each class's OWN cooling rate, so
   * the Interceptor (cool 1.2, the thinnest thermal mass at 0.72, and the
   * harshest coldPenalty at 0.22) was punished about 1.6x as hard as the Bruiser
   * (cool 0.75, mass 1.35) for a property of the ROAD.
   *
   * Which is also why it was wrong physically. Convective cooling scales with
   * the tyre's airflow and construction, and `compound.cool` is that number.
   * Evaporative cooling off a wet contact patch scales with the water film and
   * the patch area — it is set by the surface, and it is very nearly the same for
   * any tyre on it. An additive rate says that; a multiplier says "a tyre that
   * cools well in air also cools well in water", which is not the mechanism.
   *
   * The measured result of the change is in the report: 3.7 / 4.4 / 5.6 points
   * across dry / wet / storm, all inside the ~6-point budget.
   */
  tireCoolAdd: number;
};

export type WeatherRainDef = {
  /**
   * Points in the camera-anchored rain column, on the HIGH tier. Medium takes
   * 40% of this, low takes none. See RAIN_BUDGET.
   */
  drops: number;
  /** Column half-extent (m) around the camera, and its height. */
  radius: number;
  height: number;
  /** Fall speed (m/s) and the horizontal lean the wind gives it. */
  fallSpeed: number;
  windX: number;
  windZ: number;
  /** Streak size in metres at unit distance, and its opacity. */
  streakLength: number;
  streakWidth: number;
  opacity: number;
  color: string;
  /** Mean seconds between lightning strikes. 0 = none. */
  lightningPeriod: number;
};

export type WeatherLookDef = {
  /**
   * How much of the sky's own colour design is replaced by flat overcast.
   * 1 would erase the hour entirely, which is wrong — a wet sunset is still a
   * sunset seen through cloud.
   */
  overcast: number;
  /** Flat cloud-deck colour the sky ramp is pulled toward. */
  cloudColor: string;
  /** Hide the sun disc above this overcast level. */
  hideDiscAbove: number;
  /**
   * Key light multiplier, and the ambient multiplier that pays for it.
   *
   * The ambient goes UP. A cloud deck is a diffuser the size of the sky: it
   * removes the key and replaces it with a very large soft source, so total
   * illuminance falls far less than the directional component does. Scaling
   * everything down together is the standard mistake and it makes an overcast
   * afternoon read as dusk.
   */
  keyMul: number;
  ambientMul: number;
  hemiMul: number;
  fillMul: number;
  /** Fog pulls in and greys out. Rain is a volume scatterer at short range. */
  fogNearMul: number;
  fogFarMul: number;
  fogTint: string;
  fogTintAmount: number;
  /** Multiplies every albedo — road, terrain, scatter, ridges. */
  albedoTint: [number, number, number];
  /**
   * Wet-surface material response, for the sealed surfaces only.
   *
   * A dry road and a wet road differ almost entirely in ROUGHNESS and
   * REFLECTION, not in hue. Water fills the surface pores, so light that used to
   * scatter back out diffusely is instead refracted in and absorbed (albedo
   * drops, which is `roadDarken`) while the smooth film reflects specularly
   * (roughness drops, envMapIntensity rises). Tinting a wet road blue is the
   * naive version and it looks like a decal.
   */
  roadDarken: number;
  roadRoughness: number;
  roadEnvMapIntensity: number;
  /** Grade deltas, applied on top of the hour's own grade. */
  saturationMul: number;
  contrastMul: number;
  /** Positive lifts blacks. Rain scatters into the shadows exactly as dust does. */
  blackLift: number;
  bloomBias: number;
  vignetteBias: number;
  /** Atmosphere sprite multipliers. */
  cloudCountMul: number;
  cloudOpacityMul: number;
  hazeOpacityMul: number;
  groundOpacityMul: number;
};

export type WeatherDef = {
  id: WeatherId;
  label: string;
  /** One line of intent. Everything below serves it. */
  intent: string;
  /** 0 dry, 1 standing water. Drives spray and the wet-surface look strength. */
  wetness: number;
  grip: WeatherGrip;
  look: WeatherLookDef;
  rain: WeatherRainDef | null;
};

const DRY_GRIP: WeatherGrip = {
  road: 1,
  apronExtra: 1,
  looseMul: 1,
  slideBiasMul: 1,
  powerSlip: 0,
  brakeMul: 1,
  rollDragAdd: 0,
  tireCoolAdd: 0,
};

const NO_LOOK: WeatherLookDef = {
  overcast: 0,
  cloudColor: "#9aa4ad",
  hideDiscAbove: 0.6,
  keyMul: 1,
  ambientMul: 1,
  hemiMul: 1,
  fillMul: 1,
  fogNearMul: 1,
  fogFarMul: 1,
  fogTint: "#9aa4ad",
  fogTintAmount: 0,
  albedoTint: [1, 1, 1],
  roadDarken: 1,
  roadRoughness: 0.72,
  roadEnvMapIntensity: 0.9,
  saturationMul: 1,
  contrastMul: 1,
  blackLift: 0,
  bloomBias: 0,
  vignetteBias: 0,
  cloudCountMul: 1,
  cloudOpacityMul: 1,
  hazeOpacityMul: 1,
  groundOpacityMul: 1,
};

export const WEATHER: Record<WeatherId, WeatherDef> = {
  dry: {
    id: "dry",
    label: "Clear",
    intent: "Whatever the circuit was authored as. The identity, untouched.",
    wetness: 0,
    grip: DRY_GRIP,
    look: NO_LOOK,
    rain: null,
  },

  /**
   * Cloud without rain.
   *
   * Physically identical to dry — a cloud deck does not change μ — and that is
   * the point of having it as its own condition rather than as "wet at 30%".
   * It is the cheapest variant in the set: no rain curtain, no spray, no grip
   * change, and it still makes a circuit look like a different day. Use it when
   * a mission wants a mood rather than a handling problem.
   */
  overcast: {
    id: "overcast",
    label: "Overcast",
    intent:
      "A lid on the sky. Flat, shadowless, colour-drained — the same place on a day nobody would photograph.",
    wetness: 0,
    grip: DRY_GRIP,
    look: {
      ...NO_LOOK,
      overcast: 0.62,
      cloudColor: "#98a2ac",
      keyMul: 0.44,
      ambientMul: 1.5,
      hemiMul: 1.2,
      fillMul: 1.25,
      fogNearMul: 0.8,
      fogFarMul: 0.72,
      fogTint: "#9aa4ad",
      fogTintAmount: 0.55,
      albedoTint: [0.9, 0.91, 0.94],
      saturationMul: 0.82,
      contrastMul: 0.9,
      blackLift: 0.014,
      bloomBias: -0.05,
      vignetteBias: 0.03,
      cloudCountMul: 1.5,
      cloudOpacityMul: 1.8,
      hazeOpacityMul: 1.25,
      groundOpacityMul: 1.1,
    },
    rain: null,
  },

  /**
   * Steady rain on a sealed surface.
   *
   * 0.80 peak μ is the middle of the measured band for a wetted but draining
   * asphalt. It is deliberately NOT low enough to make the car undriveable: the
   * interesting part of wet racing is that the limit moved and is now harder to
   * find, not that there is no limit.
   */
  wet: {
    id: "wet",
    label: "Rain",
    intent:
      "Steady rain on hot-mix. The line is still there; the margin around it is not.",
    wetness: 0.7,
    grip: {
      road: 0.8,
      apronExtra: 0.88,
      looseMul: 1.05,
      slideBiasMul: 0.92,
      powerSlip: 0.1,
      brakeMul: 0.8,
      rollDragAdd: 0.004,
      tireCoolAdd: 0.09,
    },
    look: {
      ...NO_LOOK,
      overcast: 0.78,
      cloudColor: "#7e8892",
      keyMul: 0.34,
      ambientMul: 1.62,
      hemiMul: 1.28,
      fillMul: 1.3,
      fogNearMul: 0.66,
      fogFarMul: 0.55,
      fogTint: "#8c959e",
      fogTintAmount: 0.7,
      albedoTint: [0.82, 0.85, 0.9],
      roadDarken: 0.62,
      // Wet asphalt is not "shiny asphalt", it is a thin dielectric film over a
      // rough substrate. 0.28 is the film; the substrate's roughness map still
      // modulates it, which is what keeps the ruts and patches visible.
      roadRoughness: 0.28,
      roadEnvMapIntensity: 1.9,
      saturationMul: 0.8,
      contrastMul: 0.88,
      blackLift: 0.022,
      bloomBias: -0.02,
      vignetteBias: 0.05,
      cloudCountMul: 1.7,
      cloudOpacityMul: 2.1,
      hazeOpacityMul: 1.5,
      groundOpacityMul: 1.35,
    },
    rain: {
      drops: 4000,
      radius: 26,
      height: 30,
      fallSpeed: 17,
      windX: 2.2,
      windZ: -1.1,
      streakLength: 0.85,
      streakWidth: 0.035,
      opacity: 0.3,
      color: "#c8d4de",
      lightningPeriod: 0,
    },
  },

  /**
   * The same rain with standing water and no drainage left.
   *
   * 0.70 is the aquaplaning shoulder rather than past it. A real aquaplane is a
   * discontinuity — grip goes to near zero and comes back when the speed drops —
   * and a discontinuity in a racing game reads as a bug in the physics, not as
   * weather. This is the continuous approximation of being close to it.
   */
  storm: {
    id: "storm",
    label: "Storm",
    intent:
      "Standing water and a sky that has gone out. Every input is a negotiation.",
    wetness: 1,
    grip: {
      road: 0.7,
      apronExtra: 0.8,
      looseMul: 1.08,
      slideBiasMul: 0.86,
      powerSlip: 0.16,
      brakeMul: 0.7,
      rollDragAdd: 0.008,
      tireCoolAdd: 0.14,
    },
    look: {
      ...NO_LOOK,
      overcast: 0.9,
      cloudColor: "#5f6870",
      keyMul: 0.24,
      ambientMul: 1.55,
      hemiMul: 1.3,
      fillMul: 1.28,
      fogNearMul: 0.5,
      fogFarMul: 0.4,
      fogTint: "#6d757d",
      fogTintAmount: 0.82,
      albedoTint: [0.72, 0.76, 0.82],
      roadDarken: 0.52,
      roadRoughness: 0.2,
      roadEnvMapIntensity: 2.3,
      saturationMul: 0.7,
      contrastMul: 0.84,
      blackLift: 0.03,
      bloomBias: 0.02,
      vignetteBias: 0.1,
      cloudCountMul: 1.9,
      cloudOpacityMul: 2.4,
      hazeOpacityMul: 1.8,
      groundOpacityMul: 1.6,
    },
    rain: {
      drops: 6000,
      radius: 28,
      height: 32,
      fallSpeed: 22,
      windX: 4.6,
      windZ: -2.4,
      streakLength: 1.25,
      streakWidth: 0.045,
      opacity: 0.38,
      color: "#bcc8d4",
      lightningPeriod: 11,
    },
  },
};

/**
 * Rain draw-call and vertex budget, by tier — and what pays for it.
 *
 * The curtain is ONE THREE.Points with a GPU-side fall (position is derived
 * from a time uniform in the vertex shader), so it is one draw call, zero
 * triangles, zero per-frame attribute upload, and its cost is fill rate on a
 * few thousand small alpha-blended sprites.
 *
 * The LOW TIER GETS NO GEOMETRY AT ALL. It gets the sky, fog, grade and albedo
 * swap, plus the existing dust motes retasked to "fall" with a cold colour —
 * which is a parameter change to a loop that was already running, inside a count
 * that was already tier-budgeted. A tier that has been measured at 25fps does
 * not get a new alpha-blended layer, whatever the weather says.
 *
 * NET, on medium and high, this is CHEAPER than dry: rain hides the sun disc,
 * which removes a 16x12 sphere and two large additive sprites — three draw
 * calls — and adds one. The one place weather is allowed to cost more is the
 * cloud sprite count, and that goes through `scaleCount`, so COUNT_SCALE_CAP
 * still holds the low tier at the desert's budget.
 */
export const RAIN_BUDGET: Record<
  "low" | "medium" | "high",
  { dropScale: number; drawCalls: number; triangles: number }
> = {
  low: { dropScale: 0, drawCalls: 0, triangles: 0 },
  medium: { dropScale: 0.4, drawCalls: 1, triangles: 0 },
  high: { dropScale: 1, drawCalls: 1, triangles: 0 },
};

/* ── active condition ─────────────────────────────────────────────────── */

/*
 * A function, never an exported binding.
 *
 * `export let activeWeather` would be a live binding under real ESM and a
 * SNAPSHOT under jiti's CJS transpile, so every headless check would read the
 * value the module was initialised with while `setWeather` reported success.
 * That trap has been hit five times in this codebase — see AGENTS.md §4 — and
 * it is exactly the shape of bug that makes a wet-physics measurement quietly
 * measure dry physics.
 */
let activeId: WeatherId = "dry";
let epoch = 0;

export function setWeather(id: WeatherId): void {
  if (activeId === id) return;
  activeId = id;
  epoch++;
}

export function getWeatherId(): WeatherId {
  return activeId;
}

export function getWeather(): WeatherDef {
  return WEATHER[activeId] ?? WEATHER.dry;
}

/**
 * Bumped on every condition change.
 *
 * Consumers memoise on the TRACK epoch, which only moves when the circuit does.
 * A mission that changes the weather without changing the circuit would
 * otherwise keep the previous sky. Combine the two — see
 * `getEnvironmentEpoch()` in ../environments.
 */
export function getWeatherEpoch(): number {
  return epoch;
}

export function isRaining(): boolean {
  return getWeather().rain !== null;
}

/** 0..1. The single number the spray, the wet look and the audio layer want. */
export function getWetness(): number {
  return getWeather().wetness;
}

/* ── the physics query ────────────────────────────────────────────────── */

/**
 * Grip multiplier for the surface a wheel is actually on, this step.
 *
 * Split out rather than inlined into physics.ts so the numbers and their
 * reasoning stay in one file, and so a headless probe can call it directly
 * instead of inferring it from a lap time.
 */
export function weatherGripMul(kind: string): number {
  const g = getWeather().grip;
  if (kind === "asphalt") return g.road;
  if (kind === "apron") return g.road * g.apronExtra;
  // Sand and everything looser. Damp grit packs; the cost shows up as drag.
  return g.road * g.looseMul;
}

/**
 * Lateral grip lost to longitudinal demand, as a multiplier.
 *
 * `demand` is 0..1 of the available longitudinal force being asked for. The
 * friction circle is a circle, so the honest form is sqrt(1 - d^2); this uses a
 * linear approximation because the interesting region is d < 0.6 where the two
 * differ by under 8%, and because a sqrt here would make the wet car lose grip
 * suddenly rather than progressively at exactly the moment progression matters.
 */
export function weatherPowerSlipMul(demand: number): number {
  const p = getWeather().grip.powerSlip;
  if (p <= 0) return 1;
  const d = demand < 0 ? 0 : demand > 1 ? 1 : demand;
  return 1 - p * d;
}
