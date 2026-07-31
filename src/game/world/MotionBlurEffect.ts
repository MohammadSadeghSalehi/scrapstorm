/**
 * Speed motion blur — radial smear driven by speed.
 *
 * A velocity-buffer blur is the accurate answer, but it needs a velocity render
 * target, per-object previous-frame matrices and its own pass — three new costs
 * on top of the taps themselves. For a fixed chase camera on a car that mostly
 * travels along its own forward axis, screen-space velocity is almost entirely
 * radial from the vanishing point, so a single radial smear reproduces what the
 * velocity buffer would produce for everything except other cars crossing the
 * frame. That is the MW05-era trick and it is what the presentation target
 * actually calls for.
 *
 * Cost is kept to "extra taps in a shader that already runs" rather than a new
 * pass: this effect merges into the existing EffectPass, and `uStrength` is a
 * uniform so the whole draw skips the taps entirely below the speed threshold.
 *
 * IMPORTANT: this effect must stay FIRST in its EffectPass. postprocessing
 * merges effects into one shader where `inputColor` is the running colour but
 * `inputBuffer` is always the pass input — the two only agree for the first
 * effect. Placed anywhere else it would blur the pre-pass frame and discard
 * whatever the effects before it produced.
 */
import { Effect } from "postprocessing";
import * as THREE from "three";

const fragment = /* glsl */ `
uniform vec2 uCenter;
uniform float uStrength;  // tap offset at the frame edge, in UV
uniform float uSwirl;     // 0 = pure radial, higher = smear rotates with a drift
uniform float uInner;     // normalised radius where the smear starts

float mbDither(const in vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  // uStrength is a uniform, so this branch resolves the same way for every
  // fragment in the draw and the taps below are never issued while cruising.
  // Blur that costs nothing when it is not visible is the whole point.
  if (uStrength <= 0.0) {
    outputColor = inputColor;
    return;
  }

  vec2 d = uv - uCenter;

  // Aspect-correct the falloff radius only, normalised so r is ~1 at the
  // corners on any aspect ratio. The tap direction stays in raw UV because that
  // is already the screen ray away from the vanishing point.
  vec2 p = d * vec2(aspect, 1.0);
  float r = length(p) / length(vec2(0.5 * aspect, 0.5));

  // The chase camera puts the car around 0.33 up the frame and the road's
  // vanishing point around 0.65, and a one-origin radial blur cannot sit on
  // both. So the middle band is held sharp and only the periphery smears —
  // which is also where real screen-space velocity is highest, so the cheap
  // approximation and the correct answer agree exactly where it shows.
  float amount = uStrength * smoothstep(uInner, 0.9, r);
  if (amount < 1e-4) {
    outputColor = inputColor;
    return;
  }

  // A drift swings the world around the car rather than rushing it past, so the
  // smear turns tangential. Free: it rotates the direction, it adds no taps.
  vec2 dir = mix(d, vec2(-d.y, d.x), uSwirl);

  // Jitter converts the fixed tap spacing into grain instead of hard ghost
  // copies. This is what lets a low tap count read as a continuous smear.
  float j = mbDither(uv);

  // Taps run toward the centre: under forward motion a pixel's history lies
  // nearer the vanishing point, so the streak trails outward.
  // inputColor is already texture2D(inputBuffer, UV) for the first effect in a
  // pass, so the centre tap is reused rather than fetched a second time.
  vec3 acc = inputColor.rgb;
  float total = 1.0;

  for (int i = 1; i <= MB_SAMPLES; ++i) {
    float t = (float(i) + j) / float(MB_SAMPLES);
    // Taper toward the tail so recent history dominates. It reads as a smear
    // rather than a double image, and it hides how sparse the far taps are.
    float w = 1.0 - 0.6 * t;
    acc += texture2D(inputBuffer, uv - dir * (amount * t)).rgb * w;
    total += w;
  }

  outputColor = vec4(acc / total, inputColor.a);
}
`;

export type MotionBlurOptions = {
  /** Taps per pixel, baked in as a macro so the loop unrolls. Tier-scaled. */
  samples?: number;
  /** Origin of the smear, in UV. */
  center?: THREE.Vector2;
  /** Normalised radius (1 = corner) where the smear begins. */
  inner?: number;
};

export class MotionBlurEffect extends Effect {
  private readonly strengthUniform: THREE.Uniform<number>;
  private readonly swirlUniform: THREE.Uniform<number>;

  constructor({
    samples = 8,
    center = new THREE.Vector2(0.5, 0.5),
    inner = 0.3,
  }: MotionBlurOptions = {}) {
    const strengthUniform = new THREE.Uniform(0);
    const swirlUniform = new THREE.Uniform(0);
    const taps = Math.max(2, Math.round(samples)).toFixed(0);
    super("MotionBlurEffect", fragment, {
      defines: new Map([["MB_SAMPLES", taps]]),
      uniforms: new Map<string, THREE.Uniform>([
        ["uCenter", new THREE.Uniform(center)],
        ["uStrength", strengthUniform],
        ["uSwirl", swirlUniform],
        ["uInner", new THREE.Uniform(inner)],
      ]),
    });
    this.strengthUniform = strengthUniform;
    this.swirlUniform = swirlUniform;
  }

  /**
   * Uniform-only update. Changing the tap count means a new instance, because
   * it is a macro and rebuilding an Effect recompiles the whole composer
   * shader — that must not happen while driving.
   */
  setSpeed(strength: number, swirl: number): void {
    this.strengthUniform.value = Math.max(0, strength);
    this.swirlUniform.value = Math.min(1, Math.max(0, swirl));
  }
}
