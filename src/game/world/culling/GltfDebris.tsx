/**
 * Lightweight debris — skip multi-MB helmet/truck loads that stalled boot.
 * Uses simple box/cylinder geo with scrap PBR when available.
 */
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { qualityManager } from "../quality";
import {
  cullConfigForTier,
  cullSpheres,
  type CullSphere,
} from "./cpuTerrainCull";
import { clonePbrPack, isPbrLibraryReady } from "../webgl2/textureLibrary";

type DebrisKind = "crate" | "scrap" | "barrel";

type DebrisItem = {
  x: number;
  z: number;
  y: number;
  s: number;
  rot: number;
  kind: DebrisKind;
};

const DEBRIS_LAYOUT: DebrisItem[] = [
  { x: 18, z: 48, y: 0.45, s: 1.3, rot: 0.3, kind: "crate" },
  { x: 42, z: 62, y: 0.45, s: 1.0, rot: 1.1, kind: "crate" },
  { x: 8, z: 70, y: 0.5, s: 1.4, rot: -0.5, kind: "scrap" },
  { x: 55, z: 40, y: 0.45, s: 1.1, rot: 0.8, kind: "barrel" },
  { x: 25, z: 78, y: 0.5, s: 0.95, rot: 2.1, kind: "barrel" },
  { x: 48, z: 75, y: 0.5, s: 1.2, rot: -1.2, kind: "scrap" },
  { x: -5, z: 50, y: 0.45, s: 1.3, rot: 0.4, kind: "crate" },
  { x: 60, z: 55, y: 0.5, s: 1.0, rot: 1.7, kind: "barrel" },
  { x: 90, z: -10, y: 0.45, s: 1.15, rot: 0.6, kind: "scrap" },
  { x: -40, z: -20, y: 0.45, s: 1.05, rot: -0.9, kind: "crate" },
];

export function GltfDebris() {
  const refs = useRef<(THREE.Object3D | null)[]>([]);
  const spheres = useMemo<CullSphere[]>(
    () =>
      DEBRIS_LAYOUT.map((d) => ({
        x: d.x,
        y: d.y,
        z: d.z,
        r: 1.4 * d.s,
      })),
    [],
  );
  const lastKey = useRef("");

  const mats = useMemo(() => {
    const rust = isPbrLibraryReady() ? clonePbrPack("rust", 1.2, 1.2) : null;
    const metal = isPbrLibraryReady() ? clonePbrPack("metal", 1, 1) : null;
    return {
      crate: new THREE.MeshStandardMaterial({
        color: "#c4b5a0",
        map: rust?.map ?? null,
        roughness: 0.82,
        metalness: 0.15,
      }),
      scrap: new THREE.MeshStandardMaterial({
        color: "#9a9590",
        map: metal?.map ?? null,
        roughness: 0.55,
        metalness: 0.55,
      }),
      barrel: new THREE.MeshStandardMaterial({
        color: "#c2410c",
        roughness: 0.45,
        metalness: 0.4,
        emissive: "#7c2d12",
        emissiveIntensity: 0.12,
      }),
    };
  }, []);

  useFrame(({ camera }) => {
    const tier = qualityManager.get().tier;
    if (tier === "low") {
      for (const r of refs.current) if (r) r.visible = false;
      return;
    }
    const cfg = cullConfigForTier(tier);
    const { visible } = cullSpheres(spheres, camera, cfg);
    const key = visible.join(",");
    if (key === lastKey.current) return;
    lastKey.current = key;
    const vis = new Set(visible);
    for (let i = 0; i < DEBRIS_LAYOUT.length; i++) {
      const r = refs.current[i];
      if (r) r.visible = vis.has(i);
    }
  });

  return (
    <group>
      {DEBRIS_LAYOUT.map((d, i) => (
        <group
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          position={[d.x, d.y, d.z]}
          rotation={[0, d.rot, 0]}
          scale={d.s}
        >
          {d.kind === "barrel" ? (
            <mesh castShadow receiveShadow material={mats.barrel}>
              <cylinderGeometry args={[0.4, 0.42, 0.95, 10]} />
            </mesh>
          ) : d.kind === "crate" ? (
            <mesh castShadow receiveShadow material={mats.crate}>
              <boxGeometry args={[0.95, 0.85, 0.95]} />
            </mesh>
          ) : (
            <mesh castShadow receiveShadow material={mats.scrap}>
              <boxGeometry args={[1.1, 0.4, 0.8]} />
            </mesh>
          )}
        </group>
      ))}
    </group>
  );
}
