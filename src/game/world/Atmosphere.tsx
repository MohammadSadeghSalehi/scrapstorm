/**
 * Desert atmosphere: gradient sky dome, soft dust sheets, sun bloom, clouds, mesas.
 */
import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { qualityManager } from "./quality";
import { FRAME } from "./framePriority";
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
    const R = 420;
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
      const r = 180 + (i % 5) * 28;
      return {
        x: Math.cos(a) * r,
        y: 38 + (i % 4) * 7,
        z: Math.sin(a) * r,
        sx: 50 + (i % 4) * 18,
        sy: 14 + (i % 3) * 5,
        op: 0.2 + (i % 3) * 0.07,
      };
    });
  }, [q.tier]);

  const ridges = useMemo(() => {
    const n = q.tier === "low" ? 10 : 16;
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2 + 0.1;
      const r = 160 + (i % 5) * 28;
      return {
        x: Math.cos(a) * r,
        z: Math.sin(a) * r,
        s: 32 + (i % 4) * 14,
        h: 10 + (i % 5) * 5,
        rot: a + Math.PI / 2,
        c: i % 2 === 0 ? "#4a3828" : "#5a4430",
      };
    });
  }, [q.tier]);

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
  }, FRAME.LATE);

  return (
    <group>
      <mesh geometry={skyGeo} frustumCulled={false}>
        <meshBasicMaterial
          vertexColors
          side={THREE.BackSide}
          depthWrite={false}
          fog={false}
          toneMapped={false}
        />
      </mesh>

      <group position={[140, 58, -100]}>
        <mesh>
          <sphereGeometry args={[5, 16, 12]} />
          <meshBasicMaterial color="#fff8ec" fog={false} toneMapped={false} />
        </mesh>
        <sprite scale={[30, 30, 1]}>
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
          <sprite scale={[55, 55, 1]}>
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

      {ridges.map((r, i) => (
        <mesh
          key={`rd${i}`}
          position={[r.x, r.h * 0.35, r.z]}
          rotation={[0, r.rot, 0]}
          scale={[r.s, r.h, r.s * 0.55]}
        >
          <coneGeometry args={[1, 1, q.tier === "low" ? 4 : 5]} />
          <meshStandardMaterial
            color={r.c}
            roughness={0.95}
            metalness={0}
            flatShading
          />
        </mesh>
      ))}

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
