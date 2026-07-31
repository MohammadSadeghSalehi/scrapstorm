/**
 * Cinematic post: bloom, vignette, speed chroma, grain.
 */
import { forwardRef, useMemo } from "react";
import {
  EffectComposer,
  Bloom,
  Vignette,
  ChromaticAberration,
  Noise,
  SMAA,
  N8AO,
} from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import * as THREE from "three";
import { qualityManager } from "./quality";
import { GradeEffect } from "./GradeEffect";

/**
 * The grade replaces the HueSaturation + BrightnessContrast pair it supersedes:
 * those
 * could only push global saturation and contrast, which flattens everything
 * equally. The CDL + split-tone gives separate control over shadows and
 * highlights, which is where the look actually comes from.
 *
 * One instance, memoised — rebuilding an Effect recompiles the composer shader.
 */
const Grade = forwardRef<GradeEffect>(function Grade(_props, ref) {
  const effect = useMemo(() => new GradeEffect(), []);
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

  const chroma = useMemo(() => {
    const base = boost ? 0.0028 : hit ? 0.0018 : drifting ? 0.0014 : 0.0005;
    const v = base + sn * 0.0014;
    return new THREE.Vector2(v, v * 0.82);
  }, [boost, hit, drifting, sn]);

  const bloomIntensity = low
    ? boost
      ? 0.72
      : 0.42 + sn * 0.14
    : high
      ? boost
        ? 1.45
        : 0.82 + sn * 0.28 + (drifting ? 0.15 : 0)
      : boost
        ? 1.05
        : 0.6 + sn * 0.2;

  const threshold = low ? 0.7 : high ? (boost ? 0.42 : 0.5) : 0.58;
  const vignette = high
    ? hit
      ? 0.48
      : 0.18 + sn * 0.12
    : hit
      ? 0.38
      : 0.14 + sn * 0.08;

  return (
    <EffectComposer multisampling={0} enableNormalPass={false}>
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
      <Grade />
      <SMAA />
    </EffectComposer>
  );
}
