/**
 * Per-circuit environments — public API.
 *
 * Everything in the world renderer that used to be a colour literal now comes
 * from here. One lookup, `getActiveEnvironment()`; no consumer anywhere knows a
 * track id, which is the property that keeps this maintainable when a seventh
 * circuit lands.
 *
 * This file also owns the geometry constants the skyline is built against
 * (radii, amplitude), because two separate things need them and they must
 * agree: Atmosphere builds the ranges, and the ceiling maths below decides how
 * tall a range is allowed to be before it eats the sun.
 */
import * as THREE from "three";
import { getActiveTrackId, isTrackId } from "../../track";
import type { AnyTrackId } from "../../track";
import { DEFAULT_ENVIRONMENT, ENVIRONMENTS } from "./presets";
import type { EnvironmentDef, RidgeDef, SkyStop, Vec3 } from "./types";

export * from "./types";
export { ENVIRONMENTS, DEFAULT_ENVIRONMENT } from "./presets";

/* ── lookup ───────────────────────────────────────────────────────── */

export function getEnvironment(id: string): EnvironmentDef {
  if (!isTrackId(id)) return DEFAULT_ENVIRONMENT;
  return ENVIRONMENTS[id as AnyTrackId] ?? DEFAULT_ENVIRONMENT;
}

/**
 * The environment for whatever circuit is loaded.
 *
 * Deliberately a FUNCTION, not an exported binding that gets reassigned on a
 * track change. `export let` is a live binding under real ESM but jiti
 * transpiles to CJS and snapshots the namespace property at module init, so a
 * headless check that called setActiveTrack and then read the binding would get
 * the previous circuit's value while reporting the new circuit's id — the exact
 * failure that made a track-profile check silently pass twice on the same
 * track. Same reason `getTrackSamples()` exists in track.ts.
 */
export function getActiveEnvironment(): EnvironmentDef {
  return ENVIRONMENTS[getActiveTrackId()] ?? DEFAULT_ENVIRONMENT;
}

/* ── skyline geometry, shared with Atmosphere ─────────────────────── */

/** Radius of the sky dome. Everything "at infinity" lives just inside it. */
export const SKY_RADIUS = 870;

/** Mid range: world-locked foothills. Starts inside the sand plane, so buried. */
export const MID_INNER_R = 300;
export const MID_OUTER_R = 660;
/** Far range: camera-anchored, standing in for tens of kilometres. */
export const FAR_INNER_R = 600;
export const FAR_OUTER_R = 840;

/**
 * Largest amplitude multiplier `buildRidgeRange` applies. The ring's amplitude
 * grows outward as `0.55 + 0.75 * t`, so the outermost row can reach 1.3x the
 * nominal peak — which is the number the ceiling maths has to be safe against,
 * not the nominal peak itself.
 */
export const RIDGE_MAX_AMP = 1.3;

/**
 * Worst-case sight line from a car to the mid range's tallest row.
 *
 * The mid range is world-locked and the circuit is inside it, so the distance
 * varies with where you are on the lap. This takes the shortest of them: the
 * outer row (660) seen from the far side of a circuit whose half-diagonal is
 * about 170m.
 */
const MID_SIGHT_DISTANCE = MID_OUTER_R - 170;

const DEG = Math.PI / 180;

/**
 * Angular margin between the sun's lower limb and the ridgeline, in degrees.
 *
 * 0.6 is not arbitrary — it is the value at which this formula returns 190.7
 * for Ash Spire's 18.6-degree sun, which is the peak that circuit's far range
 * was hand-tuned to over several attempts. Reproducing a hand-tuned number is
 * the only evidence available that the derivation is right, since there is no
 * way to measure this without rendering.
 */
const SUN_CLEARANCE_DEG = 0.6;

export function sunElevationDeg(env: EnvironmentDef): number {
  const [x, y, z] = env.sun.dir;
  const len = Math.hypot(x, y, z) || 1;
  return Math.asin(Math.min(1, Math.max(-1, y / len))) / DEG;
}

/** Half the drawn disc's angular size, from the dome radius. */
export function sunDiscHalfAngleDeg(env: EnvironmentDef): number {
  return Math.atan(env.sun.disc.coreRadius / SKY_RADIUS) / DEG;
}

function clearanceDeg(env: EnvironmentDef): number {
  return (
    sunElevationDeg(env) - sunDiscHalfAngleDeg(env) - SUN_CLEARANCE_DEG
  );
}

/**
 * Tallest far-range peak that still leaves the sun's disc clear.
 *
 * The sun is the anchor the whole lighting, bloom and grade are built around,
 * and a skyline that swallows it is not a stylistic choice, it is a bug that
 * looks like a stylistic choice — the frame just quietly loses its brightest
 * object and every highlight stops making sense.
 *
 * Infinite when the disc is not drawn: nothing can occlude a sun that does not
 * exist, which is exactly why the two enclosed circuits (Foundry Pit,
 * Rustline) are also the two that hide it.
 */
export function farRangeCeiling(env: EnvironmentDef): number {
  if (!env.sun.disc.visible) return Infinity;
  const clear = clearanceDeg(env);
  if (clear <= 0) return 0;
  return (Math.tan(clear * DEG) * FAR_OUTER_R) / RIDGE_MAX_AMP;
}

/** Same, for the world-locked foothills. Accounts for their `baseY` lift. */
export function midRangeCeiling(env: EnvironmentDef): number {
  if (!env.sun.disc.visible) return Infinity;
  const clear = clearanceDeg(env);
  if (clear <= 0) return 0;
  return Math.max(
    0,
    (Math.tan(clear * DEG) * MID_SIGHT_DISTANCE - env.skyline.mid.baseY) /
      RIDGE_MAX_AMP,
  );
}

/* ── derived placements ───────────────────────────────────────────── */

/**
 * Where to draw the sun disc: along `sun.dir`, just inside the dome.
 *
 * 0.985 rather than 1.0 because the disc is a solid sphere and the dome is
 * drawn with BackSide — coincident, the two z-fight across the brightest object
 * in the frame.
 */
export function sunDiscPosition(env: EnvironmentDef): Vec3 {
  const [x, y, z] = env.sun.dir;
  const len = Math.hypot(x, y, z) || 1;
  const r = SKY_RADIUS * 0.985;
  return [(x / len) * r, (y / len) * r, (z / len) * r];
}

/* ── budget ───────────────────────────────────────────────────────── */

/**
 * Ceiling on any `countScale`, by quality tier.
 *
 * Every backdrop sprite is its OWN object and its own draw call — they are not
 * instanced — so a countScale is a draw-call multiplier, not just a fill-rate
 * one. That is why the presets lean on `opacityScale` and `sizeScale`, which
 * are genuinely free, and treat `countScale` as a scarce resource.
 *
 * THE LOW TIER IS CAPPED AT 1.0, which is the important part: an environment
 * may spend a little more of a high-end machine's budget to say something a
 * colour cannot (mist lying in the hollows at dawn; more smoke in a smelter),
 * but the tier that is already struggling never draws a single sprite more than
 * the desert did. A per-circuit performance regression that only appears on
 * weak hardware is the hardest kind to attribute, so it is designed out rather
 * than measured for.
 */
export const COUNT_SCALE_CAP: Record<"low" | "medium" | "high", number> = {
  low: 1.0,
  medium: 1.35,
  high: 2.6,
};

/** The loosest cap, for validation. */
export const COUNT_SCALE_MAX = COUNT_SCALE_CAP.high;

/** Apply a preset's count multiplier to a tier-derived base count. */
export function scaleCount(
  base: number,
  scale: number,
  tier: "low" | "medium" | "high",
): number {
  return Math.max(0, Math.round(base * Math.min(scale, COUNT_SCALE_CAP[tier])));
}

/* ── sky ramp ─────────────────────────────────────────────────────── */

export type SkyRamp = { y: number; color: THREE.Color }[];

/** Parse the hex stops once, at geometry-build time. */
export function buildSkyRamp(stops: SkyStop[]): SkyRamp {
  return stops.map((s) => ({ y: s.y, color: new THREE.Color(s.color) }));
}

/**
 * Colour of the dome at normalised height `y`, written into `out`.
 *
 * The ends CLAMP rather than extrapolate: the dome is a full sphere and its
 * poles sit outside any sane authored range, so extrapolating a gradient there
 * produces a black or blown-out cap exactly where the eye goes when you look
 * straight up.
 */
export function sampleSkyRamp(
  ramp: SkyRamp,
  y: number,
  out: THREE.Color,
): THREE.Color {
  const n = ramp.length;
  if (n === 0) return out.setRGB(0, 0, 0);
  if (y >= ramp[0]!.y) return out.copy(ramp[0]!.color);
  for (let i = 0; i < n - 1; i++) {
    const hi = ramp[i]!;
    const lo = ramp[i + 1]!;
    if (y >= lo.y) {
      const span = Math.max(1e-6, hi.y - lo.y);
      return out.copy(lo.color).lerp(hi.color, (y - lo.y) / span);
    }
  }
  return out.copy(ramp[n - 1]!.color);
}

/* ── verification ─────────────────────────────────────────────────── */

/**
 * Static checks over every preset, with no renderer.
 *
 * Every rule here corresponds to a mistake that is invisible in code review and
 * expensive to find by driving: a sky whose stops are out of order silently
 * collapses to a flat colour, a range that is one metre over the ceiling
 * silently eats the sun, a countScale of 4 silently costs the low tier its
 * frame budget. Runs headlessly through jiti, the same way
 * scripts/check-track-profile.mjs runs the track curve.
 */
export function validateEnvironments(): string[] {
  const problems: string[] = [];
  for (const [key, env] of Object.entries(ENVIRONMENTS)) {
    const at = (msg: string) => problems.push(`${key}: ${msg}`);
    if (env.id !== key) at(`id is "${env.id}" but it is keyed as "${key}"`);

    const stops = env.sky.stops;
    if (stops.length < 2) at("sky needs at least two stops");
    for (let i = 1; i < stops.length; i++) {
      if (stops[i]!.y >= stops[i - 1]!.y) {
        at(`sky stops must descend in y (index ${i})`);
      }
    }

    const farCap = farRangeCeiling(env);
    if (env.skyline.far.peak > farCap) {
      at(
        `far range peak ${env.skyline.far.peak} exceeds the ${farCap.toFixed(
          0,
        )}m ceiling for a ${sunElevationDeg(env).toFixed(1)}-degree sun`,
      );
    }
    const midCap = midRangeCeiling(env);
    if (env.skyline.mid.peak > midCap) {
      at(
        `mid range peak ${env.skyline.mid.peak} exceeds the ${midCap.toFixed(
          0,
        )}m ceiling`,
      );
    }

    const a = env.atmosphere;
    for (const [name, scale] of [
      ["haze", a.haze.countScale],
      ["ground", a.ground.countScale],
      ["motes", a.motes.countScale],
      ["clouds", a.clouds.countScale],
    ] as const) {
      if (scale > COUNT_SCALE_MAX) {
        at(`${name} countScale ${scale} is above COUNT_SCALE_MAX`);
      }
    }

    for (const [name, ridge] of [
      ["mid", env.skyline.mid],
      ["far", env.skyline.far],
    ] as [string, RidgeDef][]) {
      if (ridge.octaves < 1 || ridge.octaves > 8) {
        at(`${name} range octaves ${ridge.octaves} out of range 1..8`);
      }
      if (ridge.relax < 0 || ridge.relax > 1) {
        at(`${name} range relax ${ridge.relax} out of range 0..1`);
      }
    }
  }
  return problems;
}
