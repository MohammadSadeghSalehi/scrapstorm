/**
 * Desert atmosphere: gradient sky dome, soft dust sheets, sun bloom, clouds, mesas.
 */
import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { qualityManager } from "./quality";
import { FRAME } from "./framePriority";
import { buildRidgeRange } from "./ridgeRange";
import { TRACK_SAMPLES } from "../track";
import {
  softCircleTexture,
  softCloudTexture,
  softSmokeTexture,
} from "./softSprite";

export function Atmosphere() {
  const { scene } = useThree();
  const q = qualityManager.get();
  const skySeg = Math.max(24, Math.min(48, q.skySegments + 4));
  const bgColor = useMemo(() => new THREE.Color("#4a6a90"), []);

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
     * 420 put the dome closer than the camera's far plane by a wide margin, but
     * also closer than the mesas that were supposed to sit in front of it: the
     * far ring reached ~780 from the track centre, so the "distant" skyline was
     * drawing OUTSIDE its own sky. And because the dome is world-locked at the
     * origin while the circuit spans 317m, the horizon visibly swung as you
     * drove — the sky behaved like a nearby object.
     *
     * The whole backdrop is now camera-anchored (see backdrop below), so the
     * dome only has to clear the far range at 840 and stay inside the 900m far
     * plane.
     */
    const R = 870;
    const geo = new THREE.SphereGeometry(
      R,
      skySeg,
      Math.max(16, Math.floor((skySeg * 2) / 3)),
    );
    const cols = new Float32Array(geo.attributes.position.count * 3);
    const pos = geo.attributes.position;
    const zenith = new THREE.Color("#1a3a68");
    const upper = new THREE.Color("#4a78a8");
    const mid = new THREE.Color("#8aa8c4");
    const warm = new THREE.Color("#e0a068");
    const horizon = new THREE.Color("#f5d4a0");
    const ground = new THREE.Color("#3a2818");
    const sunWash = new THREE.Color("#ffe8c4");
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / R;
      const nx = pos.getX(i) / R;
      const nz = pos.getZ(i) / R;
      const sunDot = Math.max(0, nx * 0.7 + 0.2 - nz * 0.3);
      if (y > 0.45) tmp.copy(upper).lerp(zenith, (y - 0.45) / 0.55);
      else if (y > 0.12) tmp.copy(mid).lerp(upper, (y - 0.12) / 0.33);
      else if (y > 0.0) tmp.copy(warm).lerp(mid, y / 0.12);
      else if (y > -0.08) tmp.copy(horizon).lerp(warm, (y + 0.08) / 0.08);
      else tmp.copy(horizon).lerp(ground, Math.min(1, (-0.08 - y) / 0.4));
      tmp.lerp(sunWash, sunDot * sunDot * 0.4);
      cols[i * 3] = tmp.r;
      cols[i * 3 + 1] = tmp.g;
      cols[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    return geo;
  }, [skySeg]);

  const dustMotes = useMemo(() => {
    const n = q.tier === "low" ? 12 : q.tier === "medium" ? 22 : 36;
    return Array.from({ length: n }, () => {
      const a = Math.random() * Math.PI * 2;
      const r = 10 + Math.random() * 70;
      return {
        x: Math.cos(a) * r,
        y: 0.8 + Math.random() * 7,
        z: Math.sin(a) * r,
        s: 2.5 + Math.random() * 5,
        op: 0.08 + Math.random() * 0.1,
        phase: Math.random() * Math.PI * 2,
        drift: 0.15 + Math.random() * 0.3,
      };
    });
  }, [q.tier]);

  const hazeSheets = useMemo(() => {
    const n = q.tier === "low" ? 6 : 12;
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2 + i * 0.4;
      const r = 30 + (i % 6) * 18;
      return {
        x: Math.cos(a) * r,
        y: 1.0 + (i % 4) * 0.8,
        z: Math.sin(a) * r,
        s: 28 + (i % 4) * 10,
        op: 0.06 + (i % 3) * 0.02,
      };
    });
  }, [q.tier]);

  const groundHaze = useMemo(() => {
    const n = q.tier === "low" ? 4 : 8;
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return {
        x: Math.cos(a) * (20 + i * 8),
        z: Math.sin(a) * (20 + i * 8),
        s: 50 + i * 14,
        op: 0.05 + (i % 3) * 0.015,
      };
    });
  }, [q.tier]);

  const clouds = useMemo(() => {
    const n = q.tier === "low" ? 5 : 10;
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2 + 0.5;
      // Pushed out past the far range (840) and scaled to match, so clouds sit
      // beyond the mountains instead of in front of them. At r = 180 they were
      // nearer than the skyline they were meant to sit behind.
      const r = 720 + (i % 5) * 60;
      return {
        x: Math.cos(a) * r,
        y: 150 + (i % 4) * 34,
        z: Math.sin(a) * r,
        sx: 210 + (i % 4) * 76,
        sy: 58 + (i % 3) * 21,
        op: 0.2 + (i % 3) * 0.07,
      };
    });
  }, [q.tier]);

  /**
   * Two ranges, and they are deliberately not the same KIND of object.
   *
   * The mid range is world-locked: it sits at a real place in the world, so it
   * parallaxes as you drive and you can tell you are moving relative to it.
   * The far range is anchored to the camera, which means zero parallax — and
   * that is correct, because it is standing in for something tens of
   * kilometres away, where parallax across a 317m circuit would be
   * imperceptible anyway. Anchoring it also keeps it inside the 900m far plane
   * no matter where on the circuit the player is; a world-locked far range
   * would be clipped from the far side of the track, which is what was
   * happening to the old outer mesa ring.
   *
   * That split is what actually sells depth: one layer moves, one does not.
   */
  const midRange = useMemo(() => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const s of TRACK_SAMPLES) {
      if (s.x < minX) minX = s.x;
      if (s.x > maxX) maxX = s.x;
      if (s.z < minZ) minZ = s.z;
      if (s.z > maxZ) maxZ = s.z;
    }
    const hasTrack = Number.isFinite(minX);
    return {
      cx: hasTrack ? (minX + maxX) * 0.5 : 0,
      cz: hasTrack ? (minZ + maxZ) * 0.5 : 0,
      geo: buildRidgeRange({
        seed: 7,
        // Starts inside the sand plane (halfExtent 340) so the base is buried
        // and no rim shows where range meets desert.
        innerR: 300,
        outerR: 660,
        /*
         * Denser than the far range because it is genuinely near: at 176x16
         * the quads were ~20m across, and from a camera that can sit 132m from
         * the inner edge that is 8 degrees per quad. That is what made the
         * first attempt read as faceted slabs rather than hills.
         */
        segsA: q.tier === "low" ? 144 : q.tier === "high" ? 256 : 200,
        segsR: q.tier === "low" ? 16 : q.tier === "high" ? 32 : 24,
        /*
         * FOOTHILLS, not mountains. At 78 this rose 30 degrees off a camera
         * beside it — a wall running along the track, not a horizon. The far
         * range does the mountain work at 14 degrees; this layer's job is to
         * fill the gap between the desert and that range, and to hide the seam
         * where the heightmap terrain stops at ~288 and the flat sand plane
         * takes over.
         */
        peak: 42,
        // Ground out there measures 4.5-10.6m; 4 keeps the skirt under it.
        baseY: 4,
        featureSize: 190,
        // Lifted out of near-black: at #4a3628 under this grade the band read
        // as a dark mass rather than as sunlit desert rock.
        rockLow: "#6b4f38",
        rockHigh: "#a4855f",
        haze: "#cfb089",
        hazeFrom: 300,
        hazeTo: 660,
        hazeMax: 0.62,
      }),
    };
  }, [q.tier]);

  const farRange = useMemo(
    () =>
      buildRidgeRange({
        seed: 23,
        innerR: 600,
        outerR: 840,
        segsA: q.tier === "low" ? 128 : q.tier === "high" ? 224 : 176,
        segsR: q.tier === "low" ? 8 : q.tier === "high" ? 14 : 11,
        /*
         * Tall enough to clear the mid range from any point on the circuit — a
         * far range that peeks between near summits reads as a second row of
         * hills, not as mountains beyond them. Capped by the SUN, though: it
         * sits at 18.6 degrees elevation with a 1.6-degree disc, so its lower
         * limb is at 17.0. At peak 250 the ridgeline reached 18.1 degrees and
         * swallowed it. 190 tops out near 14.3, which leaves the disc clear.
         * The sun is the anchor the whole lighting and bloom are built around;
         * it does not get to be hidden by set dressing.
         */
        peak: 190,
        baseY: 0,
        featureSize: 340,
        rockLow: "#6a5a52",
        rockHigh: "#a89380",
        // Fades most of the way to the sky's horizon band (#f5d4a0 / #e0a068).
        haze: "#e3c49c",
        hazeFrom: 600,
        hazeTo: 840,
        hazeMax: 0.82,
      }),
    [q.tier],
  );

  const backdrop = useRef<THREE.Group>(null);
  const moteGroup = useRef<THREE.Group>(null);
  const hazeGroup = useRef<THREE.Group>(null);
  const cloudGroup = useRef<THREE.Group>(null);

  useFrame((state) => {
    // Reuse Color — never allocate per frame
    scene.background = bgColor;
    const t = state.clock.elapsedTime;
    if (moteGroup.current) {
      for (let i = 0; i < moteGroup.current.children.length; i++) {
        const s = moteGroup.current.children[i] as THREE.Sprite;
        const d = dustMotes[i];
        if (!d || !s) continue;
        s.position.y = d.y + Math.sin(t * d.drift + d.phase) * 0.5;
        s.position.x = d.x + Math.cos(t * d.drift * 0.35 + d.phase) * 1.1;
        s.position.z = d.z + Math.sin(t * d.drift * 0.3 + d.phase) * 1.1;
        (s.material as THREE.SpriteMaterial).opacity =
          d.op * (0.75 + 0.25 * Math.sin(t * 0.7 + d.phase));
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

  return (
    <group>
      {/* Everything that is meant to be at infinity: sky, sun, clouds, far
          range. World-locked, these slid relative to the player across a 317m
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
            overdraw it. */}
        <mesh geometry={farRange} frustumCulled={false}>
          {/* Lambert, not Standard: this covers the full width of the horizon
              band, and distant hazed rock has no specular response worth
              paying a PBR fragment for. */}
          <meshLambertMaterial vertexColors fog={false} />
        </mesh>
        {/* Same DIRECTION as before (so it still lines up with SunLight and
            the shadows), pushed out to just inside the dome. At 179m it was
            nearer than the mountains it is supposed to be setting behind. */}
        <group position={[666, 276, -476]}>
          <mesh>
            <sphereGeometry args={[24, 16, 12]} />
            <meshBasicMaterial color="#fff8ec" fog={false} toneMapped={false} />
          </mesh>
          <sprite scale={[145, 145, 1]}>
            <spriteMaterial
              map={sunTex}
              color="#ffe8c0"
              transparent
              opacity={0.85}
              depthWrite={false}
              fog={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
            />
          </sprite>
          {q.tier !== "low" && (
            <sprite scale={[265, 265, 1]}>
              <spriteMaterial
                map={sunTex}
                color="#ffb060"
                transparent
                opacity={0.28}
                depthWrite={false}
                fog={false}
                toneMapped={false}
                blending={THREE.AdditiveBlending}
              />
            </sprite>
          )}
        </group>

        <group ref={cloudGroup}>
          {clouds.map((c, i) => (
            <sprite key={`cl${i}`} position={[c.x, c.y, c.z]} scale={[c.sx, c.sy, 1]}>
              <spriteMaterial
                map={cloudTex}
                color="#f0e8dc"
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
        <mesh geometry={midRange.geo} frustumCulled={false}>
          <meshLambertMaterial vertexColors fog={false} />
        </mesh>
      </group>


      <group ref={hazeGroup}>
        {hazeSheets.map((h, i) => (
          <sprite key={`hz${i}`} position={[h.x, h.y, h.z]} scale={[h.s, h.s * 0.45, 1]}>
            <spriteMaterial
              map={hazeTex}
              color="#f0d0a0"
              transparent
              opacity={h.op}
              depthWrite={false}
              toneMapped={false}
            />
          </sprite>
        ))}
      </group>

      {groundHaze.map((h, i) => (
        <sprite
          key={`gh${i}`}
          position={[h.x, 0.6, h.z]}
          scale={[h.s, h.s * 0.28, 1]}
          rotation={[0, 0, 0]}
        >
          <spriteMaterial
            map={hazeTex}
            color="#d8a868"
            transparent
            opacity={h.op}
            depthWrite={false}
            toneMapped={false}
          />
        </sprite>
      ))}

      <group ref={moteGroup}>
        {dustMotes.map((d, i) => (
          <sprite key={`dm${i}`} position={[d.x, d.y, d.z]} scale={[d.s, d.s, 1]}>
            <spriteMaterial
              map={dustTex}
              color="#e8c898"
              transparent
              opacity={d.op}
              depthWrite={false}
              toneMapped={false}
            />
          </sprite>
        ))}
      </group>
    </group>
  );
}
