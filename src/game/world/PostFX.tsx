/**
 * Cinematic post: bloom, vignette, speed chroma, grain.
 *
 * NOTHING HERE RE-RENDERS DURING A RACE, and that is the whole design.
 *
 * @react-three/postprocessing rebuilds the entire pass list in a layout effect
 * whose dependency array contains `children` — a fresh React element on every
 * render of this component. So every prop change here used to remove and
 * reconstruct all six passes, allocating new EffectPass objects and materials
 * and re-running setSize on each. Measured with the profiler's pass-wrap
 * counter: 696 pass instrumentations in a 24-second race, i.e. the full chain
 * rebuilt about five times a second, driven by nothing more than the car
 * changing speed.
 *
 * Everything that varies with the car is a UNIFORM, so it is written straight
 * onto the effect instances once per frame from `PostFxDriver` instead of being
 * routed through React. The only things still allowed to re-render this
 * component are the quality tier and the circuit, which genuinely do need a new
 * chain. The visual formulas below are unchanged.
 */
import { forwardRef, useMemo, useRef, type RefObject } from "react";
import { EffectComposer, SMAA, N8AO } from "@react-three/postprocessing";
import { useFrame } from "@react-three/fiber";
import type { EffectComposer as EffectComposerImpl } from "postprocessing";
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  NoiseEffect,
  VignetteEffect,
} from "postprocessing";
import * as THREE from "three";
import { qualityManager } from "./quality";
import { GradeEffect, type GradeOptions } from "./GradeEffect";
import { MotionBlurEffect } from "./MotionBlurEffect";
import { FrameProfiler } from "./FrameProfiler";
import { getActiveEnvironment } from "./environments";
import { getTrackEpoch } from "../track";

/** What the race feeds the post chain, mutated in place — never a new object. */
export type PostFxInputs = {
  boost: boolean;
  hit: boolean;
  speedNorm: number;
  drifting: boolean;
};

/**
 * Runs before the profiler's frame bracket (0.5) and before the composer (1),
 * so the uniforms are current for this frame's render and the driver's own cost
 * is not attributed to the render.
 */
const DRIVE_PRIORITY = 0.25;

/**
 * The grade replaces the HueSaturation + BrightnessContrast pair it supersedes:
 * those
 * could only push global saturation and contrast, which flattens everything
 * equally. The CDL + split-tone gives separate control over shadows and
 * highlights, which is where the look actually comes from.
 *
 * One instance, memoised on the PRESET — rebuilding an Effect recompiles the
 * composer shader, so this must not be keyed on anything that changes per
 * frame. It is keyed on the grade object identity, which is a module-level
 * singleton per circuit, so it rebuilds exactly once per track change and never
 * during a race.
 */
const Grade = forwardRef<GradeEffect, { options: Required<GradeOptions> }>(
  function Grade({ options }, ref) {
    const effect = useMemo(() => new GradeEffect(options), [options]);
    return <primitive ref={ref} object={effect} dispose={null} />;
  },
);

/**
 * Kept mounted at every non-low tier even when the strength is zero: adding or
 * removing an effect rebuilds the EffectPass and its shader, and crossing the
 * speed threshold is something the player does constantly. The zero case is
 * handled inside the shader by a uniform branch instead, which is free.
 */
const MotionBlur = forwardRef<MotionBlurEffect, { samples: number }>(
  function MotionBlur({ samples }, ref) {
    const effect = useMemo(() => new MotionBlurEffect({ samples }), [samples]);
    return <primitive ref={ref} object={effect} dispose={null} />;
  },
);

type Effects = {
  bloom: BloomEffect;
  vignette: VignetteEffect;
  chroma: ChromaticAberrationEffect;
  noise: NoiseEffect;
};

/**
 * Writes the speed-reactive values onto the live effects.
 *
 * Every formula in here was previously computed in the component body and
 * passed as a prop. They are identical; only the delivery changed.
 */
function PostFxDriver({
  inputs,
  effects,
  blur,
  bloomBias,
  vignetteBias,
  high,
  low,
}: {
  inputs: RefObject<PostFxInputs>;
  effects: Effects;
  blur: RefObject<MotionBlurEffect | null>;
  bloomBias: number;
  vignetteBias: number;
  high: boolean;
  low: boolean;
}) {
  useFrame(() => {
    const i = inputs.current;
    if (!i) return;
    const { boost, hit, drifting } = i;
    const sn = i.speedNorm < 0 ? 0 : i.speedNorm > 1 ? 1 : i.speedNorm;

    // Blur arrives at the same speed SpeedStreaks do (~28 of the 84 m/s that
    // normalises to 1), so the two speed cues read as one. Quadratic keeps the
    // mid range calm and loads the effect into the top of the band, which is
    // where the streaks and the FOV push are already doing their work.
    const ramp = Math.max(0, (sn - 0.34) / 0.66);
    // Offsets are in UV at the frame edge; the shader scales them further by
    // distance from centre, so the corners get roughly 1.4x these numbers.
    const blurStrength =
      ramp * ramp * (high ? 0.045 : 0.032) +
      (boost ? (high ? 0.018 : 0.013) * (0.35 + 0.65 * ramp) : 0) +
      (hit ? 0.012 * (0.3 + 0.7 * ramp) : 0);
    blur.current?.setSpeed(blurStrength, drifting ? 0.22 * ramp : 0);

    /*
     * Bloom and vignette take a per-environment BIAS, not a per-environment
     * value.
     *
     * The speed, boost and hit terms are gameplay feedback and have to behave
     * identically everywhere — a driver learns what a boost looks like once.
     * What differs by circuit is the baseline: a smelter with fire in frame
     * wants more bloom than a dust storm, where nothing blooms because nothing
     * is bright enough to. Adding an offset preserves the gameplay response and
     * moves the floor, which is the only part that is an art decision.
     */
    const { bloom, vignette, chroma, noise } = effects;
    {
      bloom.intensity = Math.max(
        0,
        (low
          ? boost
            ? 0.72
            : 0.42 + sn * 0.14
          : high
            ? boost
              ? 1.45
              : 0.82 + sn * 0.28 + (drifting ? 0.15 : 0)
            : boost
              ? 1.05
              : 0.6 + sn * 0.2) + bloomBias,
      );
      bloom.luminanceMaterial.threshold = low
        ? 0.7
        : high
          ? boost
            ? 0.42
            : 0.5
          : 0.58;
    }

    vignette.darkness = Math.max(
        0,
        (high
          ? hit
            ? 0.48
            : 0.18 + sn * 0.12
          : hit
            ? 0.38
            : 0.14 + sn * 0.08) + vignetteBias,
      );

    {
      const base = boost ? 0.0028 : hit ? 0.0018 : drifting ? 0.0014 : 0.0005;
      const v = base + sn * 0.0014;
      chroma.offset.set(v, v * 0.82);
      /*
       * modulationOffset is a uniform and free to write. `radialModulation` is
       * NOT — it is a shader define, so assigning it recompiles the effect and
       * rebuilds the pass. It used to be `boost || sn > 0.65`, which flips
       * several times a lap.
       */
      chroma.modulationOffset = boost ? 0.4 : 0.18;
    }

    /* Grain fades in with speed instead of being mounted and unmounted at
       sn > 0.5, which rebuilt the whole chain twice per corner. */
    noise.blendMode.opacity.value =
        (high || sn > 0.5 ? 0.025 + sn * 0.025 : 0) + (hit ? 0.02 : 0);
  }, DRIVE_PRIORITY);
  return null;
}

export function PostFX({ inputs }: { inputs: RefObject<PostFxInputs> }) {
  const q = qualityManager.get();
  const high = q.tier === "high";
  const low = q.tier === "low";
  const epoch = getTrackEpoch();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const post = useMemo(() => getActiveEnvironment().post, [epoch]);

  const composer = useRef<EffectComposerImpl>(null);

  /*
   * Effects are constructed here and mounted with <primitive>, NOT via the
   * @react-three/postprocessing wrapper components.
   *
   * The wrappers memoise their constructor args on `JSON.stringify(props)`.
   * Under React 19 `ref` is an ordinary prop, so attaching one puts a live
   * effect instance into that stringify — and BloomEffect owns a mipmap blur
   * pass which owns a Scene which owns children which point back at their
   * parent. It throws "Converting circular structure to JSON" and takes the
   * whole canvas down. Constructing them directly is also what the Grade and
   * MotionBlur effects below already do.
   */
  const effects = useMemo(() => {
    const bloom = new BloomEffect({
      intensity: 0.6,
      luminanceThreshold: 0.58,
      luminanceSmoothing: 0.35,
      mipmapBlur: true,
      radius: high ? 1.15 : low ? 0.58 : 0.9,
    });
    const vignette = new VignetteEffect({ offset: 0.16, darkness: 0.16 });
    /*
     * radialModulation is fixed on. It was `boost || sn > 0.65`, and it is a
     * shader DEFINE, so every flip recompiled the effect and rebuilt the pass
     * mid-race. Always-on is also the better look — a clean centre with
     * fringing that grows toward the edges, rather than colour separation
     * across the whole frame at walking pace.
     */
    const chroma = new ChromaticAberrationEffect({
      blendFunction: BlendFunction.NORMAL,
      offset: new THREE.Vector2(0.0005, 0.00041),
      radialModulation: true,
      modulationOffset: 0.18,
    });
    const noise = new NoiseEffect({
      premultiply: true,
      blendFunction: BlendFunction.SOFT_LIGHT,
    });
    noise.blendMode.opacity.value = 0;
    return { bloom, vignette, chroma, noise };
  }, [high, low]);

  const blur = useRef<MotionBlurEffect>(null);

  /*
   * The children element is memoised, and that is load-bearing.
   *
   * EffectComposer is a React.memo whose layout effect rebuilds every pass when
   * its `children` prop changes identity. This component does not own the
   * reason it re-renders — the HUD re-renders GameCanvas at roughly 5Hz, which
   * re-renders the whole world tree down to here. Measured with the profiler's
   * composerRenders counter, that was rebuilding all six passes ~5 times a
   * second for the whole race. Holding the element identity stable makes the
   * memo bail out and the chain survive, no matter how often the tree above
   * re-renders.
   */
  const children = useMemo(
    () => (
      <>
        {/* Instruments the composer's own passes. Mounted inside so it can take
            the composer instance by ref; contributes no geometry and no pass. */}
        <FrameProfiler composer={composer} />
        <PostFxDriver
          inputs={inputs}
          effects={effects}
          blur={blur}
          bloomBias={post.bloomBias}
          vignetteBias={post.vignetteBias}
          high={high}
          low={low}
        />
        {/*
        AO first: it darkens creases and contact points, and everything after
        (bloom, grade) should see that darkening rather than blooming light
        that ought to be occluded. This is the main cue that grounds props and
        vehicles on the terrain instead of leaving them floating.
        Half-res on medium keeps it roughly free; high pays for full res.
      */}
      {!low ? (
        <N8AO
          aoRadius={high ? 2.2 : 1.8}
          distanceFalloff={1.0}
          intensity={high ? 2.0 : 1.5}
          quality={high ? "medium" : "performance"}
          // Half-res on every tier. Full-res on high was measured as part of a
          // change that took 151fps -> 81fps; the depth-aware upsample makes
          // the difference hard to see and the cost easy to feel.
          halfRes
          depthAwareUpsampling
          color="#1c1207"
        />
      ) : (
        <></>
      )}
      {/*
        Must stay the first Effect in the chain — it samples the pass input
        buffer, which only equals the running colour for the first effect of an
        EffectPass (see MotionBlurEffect). Being first also puts blur ahead of
        bloom, matching the order every engine uses: bloom is read from the
        sharp frame so highlights keep their punch instead of being smeared
        twice. It merges into the same pass as Bloom and Vignette, so it adds
        taps to a shader that already runs rather than another full-screen pass.
        Low tier never gets here (GameScene does not mount PostFX at all).
      */}
        {!low ? <MotionBlur ref={blur} samples={high ? 8 : 5} /> : <></>}
        <primitive object={effects.bloom} dispose={null} />
        <primitive object={effects.vignette} dispose={null} />
        {/*
          ChromaticAberrationEffect declares EffectAttribute.CONVOLUTION
          unconditionally, so it can never merge with its neighbours and always
          costs its own full-screen pass. Measured at 0.40ms GPU on the Intel
          iGPU and 0.01ms on the RTX 5080 — cheap enough to keep, but it is why
          the chain is three EffectPasses rather than one.
        */}
        {!low ? <primitive object={effects.chroma} dispose={null} /> : <></>}
        {/* Always mounted, opacity driven to zero below the speed threshold:
            mounting and unmounting an effect rebuilds the EffectPass. */}
        {!low ? <primitive object={effects.noise} dispose={null} /> : <></>}
        <Grade options={post.grade} />
        <SMAA />
      </>
    ),
    [effects, post, high, low, inputs],
  );

  return (
    <EffectComposer ref={composer} multisampling={0} enableNormalPass={false}>
      {children}
    </EffectComposer>
  );
}
