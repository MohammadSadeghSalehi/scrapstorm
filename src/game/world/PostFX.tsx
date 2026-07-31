/**
 * Cinematic post: bloom, vignette, speed chroma, grain.
 */
import { useMemo } from "react";
import {
  EffectComposer,
  Bloom,
  Vignette,
  ChromaticAberration,
  Noise,
  SMAA,
  HueSaturation,
  BrightnessContrast,
  N8AO,
} from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import * as THREE from "three";
import { qualityManager } from "./quality";

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
          quality={high ? "high" : "performance"}
          // Full-res only on high, where there is budget for it; the
          // depth-aware upsample keeps half-res acceptable below that.
          halfRes={!high}
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
      <HueSaturation saturation={high ? 0.12 : 0.08} hue={0} />
      <BrightnessContrast brightness={0} contrast={high ? 0.14 : 0.1} />
      <SMAA />
    </EffectComposer>
  );
}
