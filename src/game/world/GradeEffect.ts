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

export class GradeEffect extends Effect {
  constructor(opts: GradeOptions = {}) {
    const o = { ...DESERT_DUSK, ...opts };
    super("GradeEffect", fragment, {
      uniforms: new Map<string, THREE.Uniform>([
        ["uSlope", new THREE.Uniform(o.slope)],
        ["uOffset", new THREE.Uniform(o.offset)],
        ["uPower", new THREE.Uniform(o.power)],
        ["uShadowTint", new THREE.Uniform(o.shadowTint)],
        ["uHighTint", new THREE.Uniform(o.highTint)],
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
