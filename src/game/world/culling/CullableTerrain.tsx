/**
 * Cullable terrain pieces — wire into TrackMesh.
 * Visibility driven by TerrainCullDriver buses (mesh.visible, no remount).
 */
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { SCENERY } from "../../track";
import { createProcMaterial } from "../procmat";
import { qualityManager } from "../quality";
import {
  buildGroundTiles,
  type CullSphere,
  type GroundTile,
} from "./cpuTerrainCull";
import {
  duneCullBus,
  groundCullBus,
  sceneryCullBus,
} from "./TerrainCullDriver";

type CullBus = typeof duneCullBus;

/**
 * Keep mesh refs in a stable array; toggle .visible from bus without React re-render.
 */
function useCullVisibility(bus: CullBus, count: number) {
  const refs = useRef<(THREE.Object3D | null)[]>([]);
  const lastKey = useRef("");

  useEffect(() => {
    return bus.subscribe((visible) => {
      // stable signature — skip if unchanged
      const key =
        visible.length === count
          ? "all"
          : visible.length === 0
            ? "none"
            : visible.join(",");
      if (key === lastKey.current) return;
      lastKey.current = key;
      const set = new Set(visible);
      for (let i = 0; i < count; i++) {
        const obj = refs.current[i];
        if (obj) obj.visible = set.has(i);
      }
    });
  }, [bus, count]);

  return refs;
}

/** Chunked sand desert — sphere-culled tiles instead of one giant disc. */
export function CullableSandTiles({
  material,
}: {
  material: THREE.Material;
}) {
  const tier = qualityManager.get().tier;
  const tileSize = tier === "low" ? 80 : tier === "high" ? 48 : 64;

  const tiles = useMemo(
    () =>
      buildGroundTiles({
        centerX: 20,
        centerZ: 40,
        halfExtent: 340,
        tileSize,
        y: -2.8,
      }),
    [tileSize],
  );

  useEffect(() => {
    groundCullBus.setSpheres(tiles.map((t) => t.sphere));
  }, [tiles]);

  const refs = useCullVisibility(groundCullBus, tiles.length);

  return (
    <group>
      {tiles.map((t: GroundTile, i) => (
        <mesh
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          position={[t.x, -2.5, t.z]}
          rotation={[-Math.PI / 2, 0, 0]}
          receiveShadow
          frustumCulled
        >
          <planeGeometry args={[t.half * 2, t.half * 2, 1, 1]} />
          <primitive object={material} attach="material" />
        </mesh>
      ))}
    </group>
  );
}

type DuneDef = { x: number; z: number; r: number; rot: number };

export function CullableDunes({
  material,
  segments,
}: {
  material: THREE.Material;
  segments: number;
}) {
  const dunes = useMemo(() => {
    const tier = qualityManager.get().tier;
    const count = tier === "low" ? 22 : tier === "medium" ? 36 : 48;
    const out: (DuneDef & { h: number; sx: number; sz: number })[] = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + i * 0.37;
      const ring = 55 + (i % 7) * 22 + (i % 3) * 8;
      const r = 9 + (i % 5) * 4.5;
      out.push({
        x: Math.cos(a) * ring + 18 + Math.sin(i * 1.7) * 12,
        z: Math.sin(a) * ring + 38 + Math.cos(i * 1.3) * 10,
        r,
        rot: a + i * 0.2,
        h: 2.2 + (i % 4) * 1.4,
        sx: 1.1 + (i % 3) * 0.35,
        sz: 0.85 + (i % 4) * 0.25,
      });
    }
    return out;
  }, []);

  useEffect(() => {
    duneCullBus.setSpheres(
      dunes.map((d) => ({
        x: d.x,
        y: d.h * 0.4,
        z: d.z,
        r: d.r * 1.6,
      })),
    );
  }, [dunes]);

  const refs = useCullVisibility(duneCullBus, dunes.length);
  const segs = Math.max(8, Math.min(segments, 20));

  return (
    <group>
      {dunes.map((d, i) => (
        <mesh
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          position={[d.x, -0.05, d.z]}
          rotation={[0, d.rot, 0]}
          scale={[d.sx, Math.max(0.12, d.h / Math.max(0.1, d.r)), d.sz]}
          castShadow={i % 3 === 0}
          receiveShadow
          frustumCulled
        >
          {/* Real mound — half-sphere flattened into dune shape */}
          <sphereGeometry
            args={[
              d.r,
              segs,
              Math.max(6, Math.floor(segs / 2)),
              0,
              Math.PI * 2,
              0,
              Math.PI * 0.5,
            ]}
          />
          <primitive object={material} attach="material" />
        </mesh>
      ))}
      {/* Extra near-track berms for readable terrain beside the road */}
      {dunes.slice(0, 10).map((d, i) => (
        <mesh
          key={`berm-${i}`}
          position={[d.x * 0.55 + 10, 0.1, d.z * 0.55 + 15]}
          rotation={[0, d.rot * 0.7, 0]}
          scale={[0.7, 0.28, 1.1]}
          receiveShadow
          frustumCulled
        >
          <sphereGeometry
            args={[d.r * 0.45, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5]}
          />
          <primitive object={material} attach="material" />
        </mesh>
      ))}
    </group>
  );
}

export function CullableScenery() {
  const items = useMemo(() => SCENERY, []);
  const mats = useMemo(() => {
    const rust = createProcMaterial("rust", {
      color: "#a16207",
      repeat: [1, 1],
      gpuDetail: false,
    });
    const metal = createProcMaterial("metal", {
      color: "#78716c",
      repeat: [0.8, 0.8],
      gpuDetail: qualityManager.get().tier === "high",
    });
    const dark = new THREE.MeshStandardMaterial({
      color: "#292524",
      roughness: 0.85,
      metalness: 0.35,
    });
    return { rust, metal, dark };
  }, []);

  useEffect(() => {
    sceneryCullBus.setSpheres(
      items.map((s) => {
        const r =
          s.kind === "crane"
            ? 12 * s.scale
            : s.kind === "tower"
              ? 6 * s.scale
              : s.kind === "pile"
                ? 4 * s.scale
                : 5 * s.scale;
        return { x: s.x, y: 3, z: s.z, r };
      }),
    );
  }, [items]);

  const refs = useCullVisibility(sceneryCullBus, items.length);
  const cast = qualityManager.get().allVehicleShadows;
  const low = qualityManager.get().tier === "low";

  return (
    <group>
      {items.map((s, i) => {
        if (low && i % 2 === 1) return null;
        const y = 0;
        const body =
          s.kind === "tower" ? (
            <>
              <mesh position={[0, 4, 0]} castShadow={cast} receiveShadow>
                <boxGeometry args={[2.2, 8, 2.2]} />
                <primitive object={mats.metal} attach="material" />
              </mesh>
              <mesh position={[0, 8.4, 0]} castShadow={cast}>
                <boxGeometry args={[3.2, 0.5, 3.2]} />
                <primitive object={mats.rust} attach="material" />
              </mesh>
            </>
          ) : s.kind === "crane" ? (
            <>
              <mesh position={[0, 3, 0]} castShadow={cast}>
                <boxGeometry args={[1.4, 6, 1.4]} />
                <primitive object={mats.metal} attach="material" />
              </mesh>
              <mesh position={[3, 6.2, 0]} castShadow={cast}>
                <boxGeometry args={[7, 0.45, 0.7]} />
                <primitive object={mats.rust} attach="material" />
              </mesh>
              <mesh position={[6.2, 4.5, 0]} castShadow={cast}>
                <boxGeometry args={[0.25, 3.2, 0.25]} />
                <primitive object={mats.dark} attach="material" />
              </mesh>
            </>
          ) : s.kind === "pile" ? (
            <>
              <mesh position={[0, 0.8, 0]} castShadow={cast} receiveShadow>
                <boxGeometry args={[3.5, 1.6, 2.4]} />
                <primitive object={mats.rust} attach="material" />
              </mesh>
              <mesh position={[0.6, 1.9, 0.2]} rotation={[0.2, 0.4, 0.1]} castShadow={cast}>
                <boxGeometry args={[2.2, 0.7, 1.4]} />
                <primitive object={mats.metal} attach="material" />
              </mesh>
            </>
          ) : (
            <>
              <mesh
                position={[0, 1.2, 0]}
                rotation={[0, 0, Math.PI / 2]}
                castShadow={cast}
                receiveShadow
              >
                <cylinderGeometry args={[0.55, 0.55, 5.5, low ? 6 : 10]} />
                <primitive object={mats.metal} attach="material" />
              </mesh>
              <mesh position={[-2.4, 0.9, 0]} castShadow={cast}>
                <cylinderGeometry args={[0.7, 0.85, 1.6, low ? 6 : 8]} />
                <primitive object={mats.rust} attach="material" />
              </mesh>
            </>
          );

        return (
          <group
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            position={[s.x, y, s.z]}
            rotation={[0, s.rot, 0]}
            scale={s.scale}
          >
            {body}
          </group>
        );
      })}
    </group>
  );
}
