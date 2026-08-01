/**
 * Filmic colour grade — the game's visual identity in one pass.
 *
 * The frame was technically correct but had no *look*: neutral greys, uncrushed
 * blacks, no tonal separation between sun and shade. Racing games of the
 * NFS: Most Wanted era got their signature almost entirely from grading —
 * crushed cool shadows, warm sun-bleached highlights, heavy contrast — not from
 * more geometry.
 *
 * Implemented as ASC CDL (slope / offset / power) plus split-toning rather than
 * a 3D LUT: no texture asset to author or ship, every parameter is readable and
 * tunable in code, and it merges into the existing effect chain as a single
 * extra fragment function rather than another full-screen pass.
 *
 * Runs after tone mapping on an LDR frame, which is why the maths is in plain
 * gamma space and the shadow/highlight split uses luma rather than scene
 * luminance.
 */
import { Effect } from "postprocessing";
import * as THREE from "three";

const fragment = /* glsl */ `
uniform vec3 uSlope;      // gain, multiplies (per channel)
uniform vec3 uOffset;     // lift, adds (per channel)
uniform vec3 uPower;      // gamma, exponent (per channel)
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
uniform float uSaturation;
uniform float uContrast;
uniform float uSplit;     // how hard shadows/highlights pull toward their tint
uniform float uVibrance;  // saturates muted colours only, protects skin/hot hues

// Rec.709 luma — matches how the eye weights the channels, so saturation and
// contrast moves do not shift perceived brightness.
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;

  // ASC CDL. pow() on a negative base is undefined, hence the max().
  c = pow(max(c * uSlope + uOffset, vec3(0.0)), uPower);

  // Split-tone: cool the shadows, warm the highlights. This is the single
  // biggest contributor to the look — it stops the desert reading as one flat
  // orange wash by separating lit from unlit.
  float l = luma(c);
  vec3 shadow = uShadowTint * (1.0 - smoothstep(0.0, 0.5, l));
  vec3 high = uHighTint * smoothstep(0.35, 1.0, l);
  c = mix(c, c * (1.0 + shadow + high), uSplit);

  // Contrast around mid-grey rather than 0, so it does not crush to black.
  c = (c - 0.5) * uContrast + 0.5;

  // Vibrance before saturation: lifts the muted mid-tones (dust, asphalt)
  // without oversaturating what is already vivid (brake lights, weapon FX).
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  c = mix(vec3(luma(c)), c, 1.0 + uVibrance * (1.0 - (mx - mn)));

  c = mix(vec3(luma(c)), c, uSaturation);

  outputColor = vec4(clamp(c, 0.0, 1.0), inputColor.a);
}
`;

export type GradeOptions = {
  slope?: THREE.Vector3;
  offset?: THREE.Vector3;
  power?: THREE.Vector3;
  shadowTint?: THREE.Vector3;
  highTint?: THREE.Vector3;
  saturation?: number;
  contrast?: number;
  split?: number;
  vibrance?: number;
};

/**
 * Desert-dusk preset. Slightly lifted blue in shadow, gain pulled toward amber,
 * a touch of extra contrast. Tuned to read on the sand without turning the
 * asphalt muddy.
 */
export const DESERT_DUSK: Required<GradeOptions> = {
  slope: new THREE.Vector3(1.06, 1.0, 0.94),
  offset: new THREE.Vector3(-0.012, -0.008, 0.004),
  power: new THREE.Vector3(1.02, 1.0, 1.06),
  shadowTint: new THREE.Vector3(-0.05, -0.01, 0.10),
  highTint: new THREE.Vector3(0.09, 0.04, -0.05),
  saturation: 1.12,
  contrast: 1.1,
  split: 0.85,
  vibrance: 0.22,
};

/*
 * ── the other five ────────────────────────────────────────────────────
 *
 * One grade per circuit, because grading is where a time of day actually
 * lands. A dawn sky dome and a dawn sun over a neutral grade still reads as
 * "orange afternoon with a blue dome"; it is the split-tone that decides
 * whether the shadows belong to the sky or to the sun, and that is the single
 * cue the eye uses to date a photograph.
 *
 * These cost nothing relative to each other. It is the same shader with
 * different uniforms — swapping a preset does not add a pass, and does not even
 * recompile, because the branchless CDL maths runs identically on every value.
 *
 * A note on `offset`, since it is the one that is easy to get backwards:
 * NEGATIVE crushes the blacks (clear air, hard sun, deep shadow) and POSITIVE
 * lifts them (anything you are looking THROUGH — dust, smoke, mist). Lifted
 * blacks are what a veil physically does, so a dust storm with crushed blacks
 * looks like a brown photograph rather than like weather.
 */

/**
 * Cinder Bowl — the sun is on the deck. Hard split: everything the light
 * touches goes molten, everything it misses falls into the blue of the sky
 * behind it. Contrast is up because a low sun is a low sun, not a dimmer.
 */
export const EMBER_DUSK: Required<GradeOptions> = {
  slope: new THREE.Vector3(1.10, 0.98, 0.90),
  offset: new THREE.Vector3(-0.018, -0.014, 0.006),
  power: new THREE.Vector3(1.0, 1.04, 1.12),
  shadowTint: new THREE.Vector3(-0.06, -0.02, 0.14),
  highTint: new THREE.Vector3(0.14, 0.05, -0.09),
  saturation: 1.18,
  contrast: 1.16,
  split: 0.95,
  vibrance: 0.24,
};

/**
 * Foundry Pit — night in a working smelter. Crushed and desaturated (soot eats
 * colour), with the only warmth in the top of the range where the furnace light
 * is, and a green-teal cast in the shadows from the mercury-vapour worklights.
 *
 * `vibrance` is pushed HIGH deliberately, and it is doing safety work rather
 * than art: this is a combat arena, and vibrance lifts exactly the muted
 * mid-tones a dark car body sits in without touching the already-saturated
 * brake lights and weapon FX. Turn it down and the field becomes four
 * silhouettes you cannot tell apart.
 */
export const SLAG_FURNACE: Required<GradeOptions> = {
  slope: new THREE.Vector3(1.02, 0.94, 0.88),
  offset: new THREE.Vector3(-0.030, -0.028, -0.018),
  power: new THREE.Vector3(1.06, 1.10, 1.14),
  shadowTint: new THREE.Vector3(-0.04, 0.02, 0.09),
  highTint: new THREE.Vector3(0.16, 0.06, -0.10),
  saturation: 0.94,
  contrast: 1.22,
  split: 1.0,
  vibrance: 0.30,
};

/**
 * Rustline — a dust storm that has been sitting on the yard all day.
 *
 * The counter-intuitive one. Every instinct says "dusty = more contrast, more
 * orange", and that produces a sepia filter. What airborne dust actually does is
 * scatter light INTO the shadows: blacks lift, contrast collapses, saturation
 * drops because everything is being seen through the same brown veil. Low
 * contrast is the effect, not a failure to apply one.
 */
export const RUST_HAZE: Required<GradeOptions> = {
  slope: new THREE.Vector3(1.04, 0.98, 0.88),
  offset: new THREE.Vector3(0.030, 0.022, 0.010),
  power: new THREE.Vector3(0.96, 0.98, 1.04),
  shadowTint: new THREE.Vector3(0.06, 0.03, -0.02),
  highTint: new THREE.Vector3(0.05, 0.02, -0.04),
  saturation: 0.86,
  contrast: 0.94,
  split: 0.70,
  vibrance: 0.18,
};

/**
 * Sable Mile — noon on a basalt playa. The hardest grade in the set: crushed
 * blacks, near-neutral highlights, and the coolest shadow tint here, because at
 * noon a shadow is lit by nothing except a very blue sky. Saturation is pulled
 * slightly BELOW 1 — overhead sun bleaches, it does not enrich.
 */
export const BLEACHED_NOON: Required<GradeOptions> = {
  slope: new THREE.Vector3(1.0, 1.0, 1.02),
  offset: new THREE.Vector3(-0.022, -0.020, -0.012),
  power: new THREE.Vector3(1.02, 1.02, 0.98),
  shadowTint: new THREE.Vector3(-0.08, -0.03, 0.16),
  highTint: new THREE.Vector3(0.03, 0.03, 0.01),
  saturation: 0.98,
  contrast: 1.26,
  split: 0.90,
  vibrance: 0.12,
};

/**
 * The Dead Mile — twenty minutes after sunrise. Maximum split: this is the one
 * time of day when the shadows and the highlights genuinely come from two
 * different light sources of similar strength (cold sky, warm low sun), so the
 * tints pull hard in opposite directions. Blacks are lifted a little because
 * there is still mist in the air.
 */
export const FIRST_LIGHT: Required<GradeOptions> = {
  slope: new THREE.Vector3(1.02, 1.0, 1.06),
  offset: new THREE.Vector3(0.012, 0.012, 0.022),
  power: new THREE.Vector3(1.04, 1.02, 0.98),
  shadowTint: new THREE.Vector3(-0.03, 0.01, 0.18),
  highTint: new THREE.Vector3(0.15, 0.07, -0.06),
  saturation: 1.06,
  contrast: 1.04,
  split: 1.0,
  vibrance: 0.26,
};

export const GRADE_PRESETS = {
  DESERT_DUSK,
  EMBER_DUSK,
  SLAG_FURNACE,
  RUST_HAZE,
  BLEACHED_NOON,
  FIRST_LIGHT,
} as const;

export type GradePresetId = keyof typeof GRADE_PRESETS;

export class GradeEffect extends Effect {
  constructor(opts: GradeOptions = {}) {
    const o = { ...DESERT_DUSK, ...opts };
    /*
     * The vectors are CLONED into the uniforms.
     *
     * Presets are module-level singletons now that there is one per circuit, so
     * handing a preset's Vector3 straight to a uniform would let a live tweak
     * through `set()` — or anything that ever decides to lerp between grades on
     * a track change — write through into the preset itself and permanently
     * corrupt it for every later race.
     */
    super("GradeEffect", fragment, {
      uniforms: new Map<string, THREE.Uniform>([
        ["uSlope", new THREE.Uniform(o.slope.clone())],
        ["uOffset", new THREE.Uniform(o.offset.clone())],
        ["uPower", new THREE.Uniform(o.power.clone())],
        ["uShadowTint", new THREE.Uniform(o.shadowTint.clone())],
        ["uHighTint", new THREE.Uniform(o.highTint.clone())],
        ["uSaturation", new THREE.Uniform(o.saturation)],
        ["uContrast", new THREE.Uniform(o.contrast)],
        ["uSplit", new THREE.Uniform(o.split)],
        ["uVibrance", new THREE.Uniform(o.vibrance)],
      ]),
    });
  }

  /** Live-tunable from the console for grading without a rebuild. */
  set(name: keyof GradeOptions, value: number | THREE.Vector3): void {
    const u = this.uniforms.get(
      `u${name.charAt(0).toUpperCase()}${name.slice(1)}`,
    );
    if (u) u.value = value;
  }
}
