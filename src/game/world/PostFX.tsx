/**
 * Cinematic post: bloom, vignette, speed chroma, grain.
 */
import { forwardRef, useEffect, useMemo, useRef } from "react";
import {
  EffectComposer,
  Bloom,
  Vignette,
  ChromaticAberration,
  Noise,
  SMAA,
  N8AO,
} from "@react-three/postprocessing";
import type { EffectComposer as EffectComposerImpl } from "postprocessing";
import { BlendFunction } from "postprocessing";
import * as THREE from "three";
import { qualityManager } from "./quality";
import { GradeEffect, type GradeOptions } from "./GradeEffect";
import { MotionBlurEffect } from "./MotionBlurEffect";
import { FrameProfiler } from "./FrameProfiler";
import { getActiveEnvironment } from "./environments";
import { getTrackEpoch } from "../track";

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
const MotionBlur = forwardRef<
  MotionBlurEffect,
  { samples: number; strength: number; swirl: number }
>(function MotionBlur({ samples, strength, swirl }, ref) {
  const effect = useMemo(() => new MotionBlurEffect({ samples }), [samples]);
  effect.setSpeed(strength, swirl);
  return <primitive ref={ref} object={effect} dispose={null} />;
});

export function PostFX({
  boost = false,
  hit = false,
  speedNorm = 0,
  drifting = false,
}: {
  boost?: boolean;
  hit?: boolean;
  speedNorm?: number;
  drifting?: boolean;
}) {
  const q = qualityManager.get();
  const high = q.tier === "high";
  const low = q.tier === "low";
  const sn = Math.min(1, Math.max(0, speedNorm));
  const epoch = getTrackEpoch();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const post = useMemo(() => getActiveEnvironment().post, [epoch]);

  const composer = useRef<EffectComposerImpl>(null);

  const chroma = useMemo(() => {
    const base = boost ? 0.0028 : hit ? 0.0018 : drifting ? 0.0014 : 0.0005;
    const v = base + sn * 0.0014;
    return new THREE.Vector2(v, v * 0.82);
  }, [boost, hit, drifting, sn]);

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
  const blurSwirl = drifting ? 0.22 * ramp : 0;

  /*
   * Bloom and vignette take a per-environment BIAS, not a per-environment
   * value.
   *
   * The speed, boost and hit terms are gameplay feedback and have to behave
   * identically everywhere — a driver learns what a boost looks like once. What
   * differs by circuit is the baseline: a smelter with fire in frame wants more
   * bloom than a dust storm, where nothing blooms because nothing is bright
   * enough to. Adding an offset preserves the gameplay response and moves the
   * floor, which is the only part that is an art decision.
   */
  const bloomIntensity = Math.max(
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
          : 0.6 + sn * 0.2) + post.bloomBias,
  );

  const threshold = low ? 0.7 : high ? (boost ? 0.42 : 0.5) : 0.58;
  const vignette = Math.max(
    0,
    (high
      ? hit
        ? 0.48
        : 0.18 + sn * 0.12
      : hit
        ? 0.38
        : 0.14 + sn * 0.08) + post.vignetteBias,
  );

  return (
    <EffectComposer
      ref={composer}
      multisampling={0}
      enableNormalPass={false}
    >
      {/* Instruments the composer's own passes. Mounted inside so it can take
          the composer instance by ref; contributes no geometry and no pass. */}
      <FrameProfiler composer={composer} />
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
      {!low ? (
        <MotionBlur
          samples={high ? 8 : 5}
          strength={blurStrength}
          swirl={blurSwirl}
        />
      ) : (
        <></>
      )}
      <Bloom
        intensity={bloomIntensity}
        luminanceThreshold={threshold}
        luminanceSmoothing={0.35}
        mipmapBlur
        radius={high ? 1.15 : low ? 0.58 : 0.9}
      />
      <Vignette eskil={false} offset={0.16} darkness={vignette} />
      {!low ? (
        <ChromaticAberration
          blendFunction={BlendFunction.NORMAL}
          offset={chroma}
          radialModulation={boost || sn > 0.65}
          modulationOffset={boost ? 0.4 : 0.18}
        />
      ) : (
        <></>
      )}
      {high || (!low && sn > 0.5) ? (
        <Noise
          premultiply
          blendFunction={BlendFunction.SOFT_LIGHT}
          opacity={0.025 + sn * 0.025 + (hit ? 0.02 : 0)}
        />
      ) : (
        <></>
      )}
      <Grade options={post.grade} />
      <SMAA />
    </EffectComposer>
  );
}
