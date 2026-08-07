/**
 * The backdrop: sky dome, sun, clouds, mountain ranges, haze and motes.
 *
 * Every colour, count and landform parameter in here comes from
 * `getActiveEnvironment()`. Nothing in this file knows which circuit it is
 * drawing — it draws exactly the same objects in exactly the same order for all
 * six, with different numbers. That is deliberate and it is the performance
 * contract: swapping circuits cannot change the draw call count, the sprite
 * count (beyond the clamped countScale) or the shader set, so no circuit can
 * quietly become the expensive one.
 *
 * The one exception is the sun disc, which an environment may switch off
 * entirely (a smelter at night, a dust storm). That removes two sprites and a
 * sphere — it is strictly cheaper, never more expensive.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { qualityManager } from "./quality";
import { FRAME } from "./framePriority";
import { buildRidgeRange } from "./ridgeRange";
import { clonePbrPack, preloadPbrLibrary } from "./webgl2/textureLibrary";
import { getMaxAnisotropy } from "./webgl2/configure";
import { TRACK_SAMPLES, getGroundHeight } from "../track";
import { mulberry32 } from "./scatter/placement";
import {
  FAR_INNER_R,
  FAR_OUTER_R,
  MID_INNER_R,
  MID_OUTER_R,
  SKY_RADIUS,
  buildSkyRamp,
  getActiveEnvironment,
  getEnvironmentEpoch,
  sampleSkyRamp,
  scaleCount,
  sunDiscPosition,
} from "./environments";
import { getWeather } from "./weather/conditions";
import { RainCurtain } from "./weather/RainCurtain";
import {
  softCircleTexture,
  softCloudTexture,
  softSmokeTexture,
} from "./softSprite";

/** Bounding-box centre of the circuit — where the world-locked mid range sits. */
function circuitCentre() {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of TRACK_SAMPLES) {
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.z < minZ) minZ = s.z;
    if (s.z > maxZ) maxZ = s.z;
  }
  if (!Number.isFinite(minX)) return { cx: 0, cz: 0 };
  return { cx: (minX + maxX) * 0.5, cz: (minZ + maxZ) * 0.5 };
}

type Placed = { x: number; z: number; ground: number };

/**
 * A point beside the racing line, sitting on the real ground.
 *
 * The near atmospherics used to be scattered in a 10-90m disc around the WORLD
 * ORIGIN, which is not where the track is. That was survivable while there was
 * one 317m circuit; with six that range from a 500m brawl loop to a mile and a
 * half of point-to-point, most of the dust ended up somewhere nobody drives.
 * Spreading it over the circuit's BOUNDING BOX instead is no better — a lap is
 * a thin ribbon through that box, so the density along the part you can
 * actually see falls off with the square of the circuit's size, and a long
 * track gets a visibly emptier sky than a short one for no reason anybody could
 * name.
 *
 * Anchoring to track samples makes the density per metre of LAP constant, which
 * is the quantity that matters, on every circuit regardless of shape.
 *
 * `ground` is getGroundHeight, never the sample's `y`. The sample's y is the
 * ROAD plane; off the tarmac the desert climbs above it by metres, and this
 * project has repeatedly shipped objects hanging in the air because those two
 * were confused. Haze that floats a clear metre above a rise is the same bug
 * wearing a softer texture.
 */
function alongTrack(
  rng: () => number,
  nearM: number,
  farM: number,
): Placed {
  const n = TRACK_SAMPLES.length;
  if (n < 2) {
    const x = (rng() - 0.5) * 160;
    const z = (rng() - 0.5) * 160;
    return { x, z, ground: getGroundHeight(x, z) };
  }
  const s = TRACK_SAMPLES[Math.floor(rng() * n) % n]!;
  const side = rng() < 0.5 ? -1 : 1;
  const off = s.width * 0.5 + nearM + rng() * (farM - nearM);
  // Right-of-centreline, matching the EDGE_MARKERS convention.
  const x = s.x + Math.cos(s.yaw) * side * off;
  const z = s.z - Math.sin(s.yaw) * side * off;
  return { x, z, ground: getGroundHeight(x, z) };
}

export function Atmosphere() {
  const { scene } = useThree();
  const q = qualityManager.get();
  /*
   * Read the environment ONCE per circuit-and-condition, not per frame and not
   * per render.
   *
   * `getEnvironmentEpoch()`, not `getTrackEpoch()`. WorldContent is keyed by
   * track id and does remount, but the epoch is the signal that actually means
   * "the samples and the circuit changed", and it is what every other
   * track-derived memo in this project keys on. It is not sufficient any more:
   * a mission can run the SAME circuit at a different hour or in the rain, and
   * the track epoch does not move for either. The environment epoch folds the
   * variant and weather serials in, so a sky change without a circuit change
   * still rebuilds the dome. Without it the symptom is silent — the rain falls
   * out of the dry sky.
   */
  const epoch = getEnvironmentEpoch();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const env = useMemo(() => getActiveEnvironment(), [epoch]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const centre = useMemo(() => circuitCentre(), [epoch]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rain = useMemo(() => getWeather().rain, [epoch]);

  const skySeg = Math.max(24, Math.min(48, q.skySegments + 4));
  const bgColor = useMemo(
    () => new THREE.Color(env.sky.background),
    [env],
  );

  const dustTex = useMemo(() => softSmokeTexture(128), []);
  const hazeTex = useMemo(
    () =>
      softCircleTexture(
        96,
        "rgba(255,236,200,0.7)",
        "rgba(255,200,140,0.28)",
        "rgba(255,150,90,0)",
      ),
    [],
  );
  const cloudTex = useMemo(() => softCloudTexture(192), []);
  const sunTex = useMemo(
    () =>
      softCircleTexture(
        96,
        "rgba(255,252,245,1)",
        "rgba(255,225,180,0.45)",
        "rgba(255,160,80,0)",
      ),
    [],
  );

  const skyGeo = useMemo(() => {
    /*
     * SKY_RADIUS put the dome closer than the camera's far plane by a wide
     * margin, but also far enough out to clear the far range at 840 — the
     * "distant" skyline used to draw OUTSIDE its own sky. And because the dome
     * is world-locked at the origin while a circuit spans hundreds of metres,
     * the horizon visibly swung as you drove: the sky behaved like a nearby
     * object. The whole backdrop is camera-anchored now (see `backdrop` below).
     */
    const R = SKY_RADIUS;
    const geo = new THREE.SphereGeometry(
      R,
      skySeg,
      Math.max(16, Math.floor((skySeg * 2) / 3)),
    );
    const cols = new Float32Array(geo.attributes.position.count * 3);
    const pos = geo.attributes.position;

    /*
     * The gradient is a LIST of stops now rather than six hardcoded bands.
     *
     * Band count is itself an art decision: a clear noon sky is a long smooth
     * ramp, while a dawn spends seven of its nine stops inside four degrees of
     * the horizon, because that is where everything interesting about a dawn
     * happens. Fixed bands force every sky to put its detail in the same
     * places, which is most of the reason six circuits looked like one.
     */
    const ramp = buildSkyRamp(env.sky.stops);
    const wash = new THREE.Color(env.sky.washColor);
    const [wx, wz] = env.sky.washDir;
    const wBias = env.sky.washBias;
    const wStrength = env.sky.washStrength;
    const tmp = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / R;
      const nx = pos.getX(i) / R;
      const nz = pos.getZ(i) / R;
      sampleSkyRamp(ramp, y, tmp);
      // Broad brightening toward the sun's bearing. Squared so the falloff is
      // gentle near the sun and quick away from it — a linear dot reads as a
      // painted-on gradient rather than as scattering.
      const sunDot = Math.max(0, nx * wx + wBias + nz * wz);
      tmp.lerp(wash, sunDot * sunDot * wStrength);
      cols[i * 3] = tmp.r;
      cols[i * 3 + 1] = tmp.g;
      cols[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    return geo;
  }, [skySeg, env]);

  const dustMotes = useMemo(() => {
    const base = q.tier === "low" ? 12 : q.tier === "medium" ? 22 : 36;
    const n = scaleCount(base, env.atmosphere.motes.countScale, q.tier);
    // Deterministic. Math.random() here meant the motes were different on every
    // reload, which is the one thing that makes a "did that change?" comparison
    // between two builds impossible to make.
    const rng = mulberry32(0x0dc5 ^ (epoch * 2654435761));
    const sz = env.atmosphere.motes.sizeScale;
    const op = env.atmosphere.motes.opacityScale;
    return Array.from({ length: n }, () => {
      const p = alongTrack(rng, 4, 60);
      return {
        x: p.x,
        // Airborne, so this is a height ABOVE the ground rather than a world y.
        y: p.ground + 0.8 + rng() * 7,
        z: p.z,
        s: (2.5 + rng() * 5) * sz,
        op: (0.08 + rng() * 0.1) * op,
        phase: rng() * Math.PI * 2,
        drift: 0.15 + rng() * 0.3,
      };
    });
     
  }, [q.tier, env, epoch]);

  const hazeSheets = useMemo(() => {
    const base = q.tier === "low" ? 6 : 12;
    const n = scaleCount(base, env.atmosphere.haze.countScale, q.tier);
    const op = env.atmosphere.haze.opacityScale;
    const rng = mulberry32(0x4a17 ^ (epoch * 2246822519));
    return Array.from({ length: n }, (_, i) => {
      const p = alongTrack(rng, 20, 130);
      return {
        x: p.x,
        y: p.ground + 1.0 + (i % 4) * 0.8,
        z: p.z,
        s: 28 + (i % 4) * 10,
        op: (0.06 + (i % 3) * 0.02) * op,
      };
    });
     
  }, [q.tier, env, epoch]);

  const groundHaze = useMemo(() => {
    const base = q.tier === "low" ? 4 : 8;
    const n = scaleCount(base, env.atmosphere.ground.countScale, q.tier);
    const op = env.atmosphere.ground.opacityScale;
    const rng = mulberry32(0x91b3 ^ (epoch * 3266489917));
    return Array.from({ length: n }, (_, i) => {
      const p = alongTrack(rng, 25, 180);
      return {
        x: p.x,
        // Just off the deck. These are 50-134m wide sheets spanning terrain that
        // rolls by several metres across their own footprint, so no single
        // height is right for the whole sprite — but the ANCHOR still has to be
        // the ground under it, or on a circuit that climbs six metres the mist
        // ends up buried at one end and floating at the other.
        y: p.ground + 0.6,
        z: p.z,
        s: 50 + (i % 6) * 14,
        op: (0.05 + (i % 3) * 0.015) * op,
      };
    });
     
  }, [q.tier, env, epoch]);

  const clouds = useMemo(() => {
    const base = q.tier === "low" ? 5 : 10;
    const n = scaleCount(base, env.atmosphere.clouds.countScale, q.tier);
    const c = env.atmosphere.clouds;
    return Array.from({ length: n }, (_, i) => {
      const a = (i / Math.max(1, n)) * Math.PI * 2 + 0.5;
      // Pushed out past the far range (840) and scaled to match, so clouds sit
      // beyond the mountains instead of in front of them.
      const r = 720 + (i % 5) * 60;
      return {
        x: Math.cos(a) * r,
        y: c.height + (i % 4) * 34,
        z: Math.sin(a) * r,
        sx: c.spanX + (i % 4) * (c.spanX * 0.36),
        sy: c.spanY + (i % 3) * (c.spanY * 0.36),
        op: (0.2 + (i % 3) * 0.07) * c.opacityScale,
      };
    });
  }, [q.tier, env]);

  /**
   * Two ranges, and they are deliberately not the same KIND of object.
   *
   * The mid range is world-locked: it sits at a real place in the world, so it
   * parallaxes as you drive and you can tell you are moving relative to it.
   * The far range is anchored to the camera, which means zero parallax — and
   * that is correct, because it is standing in for something tens of
   * kilometres away, where parallax across a few hundred metres would be
   * imperceptible anyway. Anchoring it also keeps it inside the 900m far plane
   * no matter where on the circuit the player is; a world-locked far range
   * would be clipped from the far side of the track.
   *
   * That split is what actually sells depth: one layer moves, one does not.
   *
   * Both take their entire landform from the environment. The same generator
   * produces Ash Spire's weathered desert foothills, the Foundry's tipped spoil
   * heaps and Sable's simple distant massifs — it is seed, feature size, octave
   * count, relaxation and whether strata exist at all.
   */
  const midRange = useMemo(() => {
    const r = env.skyline.mid;
    return {
      cx: centre.cx,
      cz: centre.cz,
      geo: buildRidgeRange({
        seed: r.seed,
        // Starts inside the sand plane so the base is buried and no rim shows
        // where the range meets the ground.
        innerR: MID_INNER_R,
        outerR: MID_OUTER_R,
        /*
         * Denser than the far range because it is genuinely near: at 176x16 the
         * quads were ~20m across, and from a camera that can sit 130m from the
         * inner edge that is 8 degrees per quad — faceted slabs rather than
         * hills.
         */
        segsA: q.tier === "low" ? 144 : q.tier === "high" ? 256 : 200,
        segsR: q.tier === "low" ? 16 : q.tier === "high" ? 32 : 24,
        peak: r.peak,
        baseY: r.baseY,
        featureSize: r.featureSize,
        rockLow: r.rockLow,
        rockHigh: r.rockHigh,
        haze: r.haze,
        hazeFrom: MID_INNER_R,
        hazeTo: MID_OUTER_R,
        hazeMax: r.hazeMax,
        sharpness: r.sharpness,
        relax: r.relax,
        octaves: r.octaves,
        bandHeight: r.bandHeight,
        tileM: r.tileM,
      }),
    };
  }, [q.tier, env, centre]);

  const farRange = useMemo(() => {
    const r = env.skyline.far;
    return buildRidgeRange({
      seed: r.seed,
      innerR: FAR_INNER_R,
      outerR: FAR_OUTER_R,
      segsA: q.tier === "low" ? 128 : q.tier === "high" ? 224 : 176,
      segsR: q.tier === "low" ? 8 : q.tier === "high" ? 14 : 11,
      /*
       * `peak` is capped by the SUN, not by taste — see farRangeCeiling in
       * ./environments. A range that swallows the disc does not read as a
       * stylistic choice, it reads as the frame losing its brightest object for
       * no reason. Circuits that want a genuinely enclosing skyline pay for it
       * by hiding the disc behind smoke or dust instead.
       */
      peak: r.peak,
      baseY: r.baseY,
      featureSize: r.featureSize,
      rockLow: r.rockLow,
      rockHigh: r.rockHigh,
      haze: r.haze,
      hazeFrom: FAR_INNER_R,
      hazeTo: FAR_OUTER_R,
      hazeMax: r.hazeMax,
      sharpness: r.sharpness,
      relax: r.relax,
      octaves: r.octaves,
      bandHeight: r.bandHeight,
      tileM: r.tileM,
    });
  }, [q.tier, env]);

  /**
   * Detail map for the ranges.
   *
   * Vertex colours alone gave a smooth clay look — they can only vary as fast
   * as the vertices, and the quads out here are tens of metres across. A tiled
   * albedo adds the sub-quad break-up that makes a slope read as a material.
   * Which material is an environment decision: rock for bedrock, flaked rust
   * for a range that is actually a tip of scrap.
   *
   * Albedo only — no normal map. At 600-840m a normal map contributes almost
   * nothing but costs a fetch and a TBN per fragment across the entire horizon
   * band, and frame time is the current constraint.
   */
  const rangeMat = useMemo(
    () => new THREE.MeshLambertMaterial({ vertexColors: true, fog: false }),
    [],
  );

  /*
   * Attach the detail map when the library is ACTUALLY ready.
   *
   * The first version of this read isPbrLibraryReady() inside a useMemo. That
   * memo runs once, on mount, and Atmosphere mounts before the PBR library has
   * finished loading — so it took the untextured branch and never looked again.
   * It failed silently and looked plausible: the ranges still rendered, just
   * flat. Caught only because the QA texture count went DOWN when adding a
   * texture should have pushed it up.
   *
   * Awaiting the preload promise removes the race entirely, and it is the
   * promise rather than isPbrLibraryReady() for a second reason now: that
   * predicate goes true once the four CRITICAL packs land, and `rust` — which
   * Rustline's skyline wears — is not one of them.
   */
  useEffect(() => {
    let alive = true;
    void preloadPbrLibrary().then(() => {
      if (!alive) return;
      const pack = clonePbrPack(env.skyline.detailPack, 1, 1);
      if (!pack) return;
      pack.map.anisotropy = Math.min(getMaxAnisotropy(), q.anisotropy || 8);
      pack.map.needsUpdate = true;
      rangeMat.map = pack.map;
      /*
       * Gain above 1 is deliberate. three multiplies map x color x vertexColor,
       * and these albedos are dark, so without the lift the vertex colours —
       * which carry the entire haze and stratification design — would be
       * crushed toward black. THREE.Color is not clamped, so this is just gain.
       *
       * The dark circuits use a LOWER gain, not none: dropping it to 1 does not
       * make the range dark, it makes the range's colour design disappear.
       */
      const [gr, gg, gb] = env.skyline.detailGain;
      rangeMat.color.setRGB(gr, gg, gb);
      rangeMat.needsUpdate = true;
    });
    return () => {
      alive = false;
    };
  }, [rangeMat, q.anisotropy, env]);

  useEffect(() => () => rangeMat.dispose(), [rangeMat]);

  const backdrop = useRef<THREE.Group>(null);
  const moteGroup = useRef<THREE.Group>(null);
  const hazeGroup = useRef<THREE.Group>(null);
  const cloudGroup = useRef<THREE.Group>(null);

  const moteMotion = env.atmosphere.motes.motion;

  useFrame((state) => {
    // Reuse Color — never allocate per frame
    scene.background = bgColor;
    const t = state.clock.elapsedTime;
    if (moteGroup.current) {
      for (let i = 0; i < moteGroup.current.children.length; i++) {
        const s = moteGroup.current.children[i] as THREE.Sprite;
        const d = dustMotes[i];
        if (!d || !s) continue;
        /*
         * Three behaviours out of one loop and one branch — a parameter swap,
         * not three particle systems. Dust hangs and sways, embers rise and
         * burn out, cold dawn air settles. The vertical loop is derived from
         * the same phase and drift the sway uses, so nothing extra is stored
         * per mote.
         */
        const loop = (t * d.drift * 0.42 + d.phase * 0.16) % 1;
        let fade: number;
        if (moteMotion === "rise") {
          s.position.y = d.y + loop * 9;
          // Burn out on the way up. An ember that reaches the top of its travel
          // at full opacity and then teleports back down is the most obvious
          // possible particle artefact.
          fade = 1 - loop;
        } else if (moteMotion === "fall") {
          s.position.y = d.y + (1 - loop) * 7;
          // Fade in AND out, because settling motes have no natural spawn edge
          // the way rising ones do.
          fade = Math.sin(loop * Math.PI);
        } else {
          s.position.y = d.y + Math.sin(t * d.drift + d.phase) * 0.5;
          fade = 0.75 + 0.25 * Math.sin(t * 0.7 + d.phase);
        }
        s.position.x = d.x + Math.cos(t * d.drift * 0.35 + d.phase) * 1.1;
        s.position.z = d.z + Math.sin(t * d.drift * 0.3 + d.phase) * 1.1;
        (s.material as THREE.SpriteMaterial).opacity = d.op * fade;
      }
    }
    if (hazeGroup.current) hazeGroup.current.rotation.y = t * 0.0035;
    if (cloudGroup.current) cloudGroup.current.rotation.y = t * 0.0015;
    /*
     * Track the camera in XZ only. Y is left alone so the horizon stays put
     * relative to the world as the camera rises and falls — following Y as
     * well would drag the whole sky up and down with every bump.
     */
    if (backdrop.current) {
      backdrop.current.position.x = state.camera.position.x;
      backdrop.current.position.z = state.camera.position.z;
    }
  }, FRAME.LATE);

  const disc = env.sun.disc;
  const sunPos = useMemo(() => sunDiscPosition(env), [env]);

  return (
    <group>
      {/* Everything that is meant to be at infinity: sky, sun, clouds, far
          range. World-locked, these slid relative to the player across the
          circuit, which is exactly what makes a backdrop read as a nearby prop
          rather than as distance. */}
      <group ref={backdrop}>
        <mesh geometry={skyGeo} frustumCulled={false}>
          <meshBasicMaterial
            vertexColors
            side={THREE.BackSide}
            depthWrite={false}
            fog={false}
            toneMapped={false}
          />
        </mesh>

        {/* No renderOrder override — three.js sorts opaque front-to-back, and
            forcing the farthest object first would make everything else
            overdraw it. Lambert, not Standard: this covers the full width of
            the horizon band, and distant hazed rock has no specular response
            worth paying a PBR fragment for. */}
        <mesh
          geometry={farRange}
          material={rangeMat}
          frustumCulled={false}
        />

        {/* An environment can switch the disc off entirely — a smelter at night
            or a dust storm has no visible sun, only a direction the light comes
            from. That is a removal of two sprites and a sphere, so the darkest
            circuits are also the cheapest ones here. */}
        {disc.visible && (
          <group position={sunPos}>
            <mesh>
              <sphereGeometry args={[disc.coreRadius, 16, 12]} />
              <meshBasicMaterial color={disc.core} fog={false} toneMapped={false} />
            </mesh>
            <sprite scale={[disc.glowScale, disc.glowScale, 1]}>
              <spriteMaterial
                map={sunTex}
                color={disc.glow}
                transparent
                opacity={disc.glowOpacity}
                depthWrite={false}
                fog={false}
                toneMapped={false}
                blending={THREE.AdditiveBlending}
              />
            </sprite>
            {q.tier !== "low" && (
              <sprite scale={[disc.flareScale, disc.flareScale, 1]}>
                <spriteMaterial
                  map={sunTex}
                  color={disc.flare}
                  transparent
                  opacity={disc.flareOpacity}
                  depthWrite={false}
                  fog={false}
                  toneMapped={false}
                  blending={THREE.AdditiveBlending}
                />
              </sprite>
            )}
          </group>
        )}

        <group ref={cloudGroup}>
          {clouds.map((c, i) => (
            <sprite key={`cl${i}`} position={[c.x, c.y, c.z]} scale={[c.sx, c.sy, 1]}>
              <spriteMaterial
                map={cloudTex}
                color={env.atmosphere.clouds.color}
                transparent
                opacity={c.op}
                depthWrite={false}
                fog={false}
                toneMapped={false}
              />
            </sprite>
          ))}
        </group>
      </group>

      <group position={[midRange.cx, 0, midRange.cz]}>
        <mesh
          geometry={midRange.geo}
          material={rangeMat}
          frustumCulled={false}
        />
      </group>

      <group ref={hazeGroup}>
        {hazeSheets.map((h, i) => (
          <sprite key={`hz${i}`} position={[h.x, h.y, h.z]} scale={[h.s, h.s * 0.45, 1]}>
            <spriteMaterial
              map={hazeTex}
              color={env.atmosphere.haze.color}
              transparent
              opacity={h.op}
              depthWrite={false}
              toneMapped={false}
            />
          </sprite>
        ))}
      </group>

      {/*
        depthWrite off: these are a volumetric approximation, not objects, and
        must never occlude anything they happen to intersect.
      */}
      {groundHaze.map((h, i) => (
        <sprite
          key={`gh${i}`}
          position={[h.x, h.y, h.z]}
          scale={[h.s, h.s * 0.28, 1]}
          rotation={[0, 0, 0]}
        >
          <spriteMaterial
            map={hazeTex}
            color={env.atmosphere.ground.color}
            transparent
            opacity={h.op}
            depthWrite={false}
            toneMapped={false}
          />
        </sprite>
      ))}

      {/*
        The rain, and the only object weather adds to the tree.

        It is mounted HERE rather than from GameScene because Atmosphere is
        already the file that owns everything between the camera and the
        horizon, and because it lets the curtain be paid for out of the same
        budget: rain hides the sun disc above, which removes a sphere and two
        additive sprites, and this adds one draw call. The low tier gets `rain`
        with a drop scale of zero and renders nothing at all — see RAIN_BUDGET.
      */}
      <RainCurtain rain={rain} />

      <group ref={moteGroup}>
        {dustMotes.map((d, i) => (
          <sprite key={`dm${i}`} position={[d.x, d.y, d.z]} scale={[d.s, d.s, 1]}>
            <spriteMaterial
              map={dustTex}
              color={env.atmosphere.motes.color}
              transparent
              opacity={d.op}
              depthWrite={false}
              toneMapped={false}
              blending={
                env.atmosphere.motes.additive
                  ? THREE.AdditiveBlending
                  : THREE.NormalBlending
              }
            />
          </sprite>
        ))}
      </group>
    </group>
  );
}
