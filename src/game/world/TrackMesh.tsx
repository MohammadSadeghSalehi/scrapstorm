import { useMemo } from "react";
import * as THREE from "three";
import { EDGE_MARKERS, TRACK_SAMPLES, getTrackEpoch } from "../track";
import { createProcMaterial } from "./procmat";
import { qualityManager } from "./quality";
import { HeightmapTerrain } from "./HeightmapTerrain";
import { clonePbrPack, isPbrLibraryReady } from "./webgl2/textureLibrary";
import { attachGpuDetail } from "./shaders/gpuDetail";
import { getMaxAnisotropy } from "./webgl2/configure";
import {
  CullableSandTiles,
  CullableScenery,
  CulledEdgePosts,
  CulledBeacons,
  GltfDebris,
  buildTrackRibbon,
  type RoadSegment,
  type RoadBuildResult,
} from "./culling";

function makeYardMaterial(): THREE.MeshStandardMaterial {
  const q = qualityManager.get();
  const aniso = Math.min(getMaxAnisotropy(), q.anisotropy || 8);
  if (isPbrLibraryReady()) {
    const rock = clonePbrPack("rock", 0.035, 0.035);
    if (rock) {
      for (const t of [rock.map, rock.normalMap, rock.roughnessMap, rock.aoMap]) {
        if (t) {
          t.anisotropy = aniso;
          t.needsUpdate = true;
        }
      }
      const mat = new THREE.MeshStandardMaterial({
        map: rock.map,
        roughnessMap: rock.roughnessMap,
        normalMap: q.tier !== "low" ? rock.normalMap : null,
        aoMap: q.tier !== "low" ? rock.aoMap : null,
        aoMapIntensity: 1.05,
        color: "#5a4834",
        roughness: 0.92,
        metalness: 0.02,
        normalScale: new THREE.Vector2(0.95, 0.95),
        envMapIntensity: 0.45,
      });
      if (q.gpuDetail > 0.2) {
        attachGpuDetail(mat, { kind: "dirt", detailScale: 9, quality: q });
      }
      return mat;
    }
  }
  return createProcMaterial("dirt", {
    repeat: [0.04, 0.04],
    color: "#3d3226",
    normalScale: 0.45,
    ao: false,
    gpuDetail: true,
    detailScale: 9,
  });
}

/**
 * Compact start gantry — poles + small overhead board only.
 * NO wide ground planes (they filled the chase FOV as a white/red wall).
 */
function StartGantry({
  x,
  y,
  z,
  yaw,
  width,
}: {
  x: number;
  y: number;
  z: number;
  yaw: number;
  width: number;
}) {
  const half = Math.min(width * 0.42, 11);
  const bannerW = 5.5;
  return (
    <group position={[x, y + 0.02, z]} rotation={[0, yaw, 0]}>
      <mesh position={[-half, 4.3, 0]} castShadow>
        <boxGeometry args={[0.28, 8.6, 0.28]} />
        <meshStandardMaterial color="#292524" metalness={0.55} roughness={0.5} />
      </mesh>
      <mesh position={[half, 4.3, 0]} castShadow>
        <boxGeometry args={[0.28, 8.6, 0.28]} />
        <meshStandardMaterial color="#292524" metalness={0.55} roughness={0.5} />
      </mesh>
      <mesh position={[0, 8.5, 0]} castShadow>
        <boxGeometry args={[half * 2 + 0.4, 0.28, 0.28]} />
        <meshStandardMaterial color="#1c1917" metalness={0.45} roughness={0.55} />
      </mesh>
      {/*
        Board sits above the chase camera (which rides ~7.8 world units up), so
        you drive *under* the gantry instead of into it. At the old 5.55 it was
        below the camera and filled the frame for the whole opening straight.
        No emissive either: a white emissive slab feeding bloom was blowing out
        to a solid glowing wall.
      */}
      <mesh position={[0, 8.95, 0.35]}>
        <boxGeometry args={[bannerW, 1.1, 0.08]} />
        <meshStandardMaterial color="#e7e5e4" roughness={0.7} metalness={0.05} />
      </mesh>
      <mesh position={[0, 8.25, 0.38]}>
        <boxGeometry args={[bannerW, 0.28, 0.06]} />
        <meshStandardMaterial color="#dc2626" roughness={0.55} metalness={0.1} />
      </mesh>
      {/* Road paint — thin boxes on the asphalt, not full-width planes */}
      <mesh position={[0, 0.04, 1.4]} receiveShadow>
        <boxGeometry args={[Math.min(width * 0.55, 12), 0.04, 0.55]} />
        <meshStandardMaterial color="#fafaf9" roughness={0.85} metalness={0.02} />
      </mesh>
      <mesh position={[0, 0.04, 2.15]} receiveShadow>
        <boxGeometry args={[Math.min(width * 0.55, 12), 0.04, 0.28]} />
        <meshStandardMaterial
          color="#dc2626"
          emissive="#991b1b"
          emissiveIntensity={0.2}
          roughness={0.8}
          metalness={0.05}
        />
      </mesh>
    </group>
  );
}

export function TrackMesh({ trackEpoch }: { trackEpoch?: number }) {
  const tier = qualityManager.get().tier;
  const pbrKey = isPbrLibraryReady() ? "pbr" : "proc";
  const epoch = trackEpoch ?? getTrackEpoch();

  const ribbon = useMemo(() => {
    const result = buildTrackRibbon(TRACK_SAMPLES.slice());
    if (typeof window !== "undefined") {
      window.__roadRibbon = {
        mode: result.mode,
        segments: result.mode === "segmented" ? result.segments.length : undefined,
        roadTris: result.roadTris,
      };
    }
    return result;
  }, [epoch]);

  const mats = useMemo(() => {
    const aniso = Math.min(getMaxAnisotropy(), qualityManager.get().anisotropy || 8);
    let road: THREE.MeshStandardMaterial;
    const asp = isPbrLibraryReady() ? clonePbrPack("asphalt", 0.2, 0.2) : null;
    if (asp) {
      for (const t of [asp.map, asp.normalMap, asp.roughnessMap, asp.aoMap]) {
        if (t) {
          t.anisotropy = aniso;
          t.needsUpdate = true;
        }
      }
      road = new THREE.MeshStandardMaterial({
        map: asp.map,
        normalMap: asp.normalMap,
        roughnessMap: asp.roughnessMap,
        aoMap: asp.aoMap,
        aoMapIntensity: 1.15,
        color: "#5a564e",
        roughness: 0.82,
        metalness: 0.08,
        vertexColors: true,
        envMapIntensity: 0.9,
      });
      if (qualityManager.get().gpuDetail > 0.15) {
        attachGpuDetail(road, {
          kind: "asphalt",
          detailScale: 14,
          quality: qualityManager.get(),
        });
      }
    } else {
      road = createProcMaterial("asphalt", {
        repeat: [0.2, 0.2],
        color: "#4a4844",
        normalScale: 0.55,
        ao: true,
        gpuDetail: true,
        detailScale: 14,
      });
      road.vertexColors = true;
    }

    let apron: THREE.MeshStandardMaterial;
    {
      const grav = isPbrLibraryReady() ? clonePbrPack("gravel", 0.14, 0.14) : null;
      const dirt = isPbrLibraryReady() ? clonePbrPack("dirt", 0.11, 0.11) : null;
      const pack = grav ?? dirt;
      if (pack) {
        for (const t of [pack.map, pack.normalMap, pack.roughnessMap, pack.aoMap]) {
          if (t) {
            t.anisotropy = aniso;
            t.needsUpdate = true;
          }
        }
        apron = new THREE.MeshStandardMaterial({
          map: pack.map,
          normalMap: pack.normalMap,
          roughnessMap: pack.roughnessMap,
          aoMap: pack.aoMap,
          color: "#8a7355",
          roughness: 0.9,
          metalness: 0.04,
          vertexColors: true,
          envMapIntensity: 0.55,
        });
      } else {
        apron = createProcMaterial("dirt", {
          repeat: [0.12, 0.12],
          color: "#6b5a45",
          normalScale: 0.5,
          ao: true,
          gpuDetail: true,
          detailScale: 10,
        });
        apron.vertexColors = true;
      }
    }

    let sand: THREE.MeshStandardMaterial;
    const sandP = isPbrLibraryReady() ? clonePbrPack("sand", 0.025, 0.025) : null;
    if (sandP) {
      for (const t of [sandP.map, sandP.normalMap, sandP.roughnessMap, sandP.aoMap]) {
        if (t) {
          t.anisotropy = aniso;
          t.needsUpdate = true;
        }
      }
      sand = new THREE.MeshStandardMaterial({
        map: sandP.map,
        normalMap: sandP.normalMap,
        roughnessMap: sandP.roughnessMap,
        aoMap: sandP.aoMap,
        aoMapIntensity: 1.0,
        color: "#c8a47a",
        roughness: 0.95,
        metalness: 0.02,
        envMapIntensity: 0.45,
        normalScale: new THREE.Vector2(1.4, 1.4),
      });
    } else {
      sand = createProcMaterial("sand", {
        repeat: [0.018, 0.018],
        normalScale: 0.8,
        ao: true,
        gpuDetail: true,
        detailScale: 12,
        color: "#c4a06a",
      });
    }

    return {
      road,
      apron,
      sand,
      yard: makeYardMaterial(),
      stripe: new THREE.MeshBasicMaterial({ color: "#f0d878", toneMapped: false }),
    };
  }, [tier, pbrKey]);

  const markers = useMemo(() => EDGE_MARKERS.slice(), [epoch]);
  const s0 = TRACK_SAMPLES[0] ?? { x: 0, y: 0, z: 0, yaw: 0, width: 26 };
  const startYaw = s0.yaw ?? 0;

  return (
    <group key={`track-${epoch}`}>
      <CullableSandTiles material={mats.sand} />
      <HeightmapTerrain />

      <RoadRibbon ribbon={ribbon} roadMat={mats.road} apronMat={mats.apron} />

      <mesh geometry={ribbon.stripes}>
        <primitive object={mats.stripe} attach="material" />
      </mesh>
      <lineSegments geometry={ribbon.edgeLines}>
        <lineBasicMaterial color="#f5f5f4" transparent opacity={0.62} />
      </lineSegments>

      <StartGantry
        x={s0.x}
        y={s0.y}
        z={s0.z}
        yaw={startYaw}
        width={s0.width ?? 26}
      />

      <CulledEdgePosts markers={markers} />
      <CulledBeacons />
      <CullableScenery />
      <GltfDebris />
    </group>
  );
}

function RoadRibbon({
  ribbon,
  roadMat,
  apronMat,
}: {
  ribbon: RoadBuildResult;
  roadMat: THREE.MeshStandardMaterial;
  apronMat: THREE.MeshStandardMaterial;
}) {
  if (ribbon.mode === "mono") {
    return (
      <group>
        <mesh geometry={ribbon.road} receiveShadow>
          <primitive object={roadMat} attach="material" />
        </mesh>
        <mesh geometry={ribbon.apron} receiveShadow>
          <primitive object={apronMat} attach="material" />
        </mesh>
      </group>
    );
  }
  return (
    <group>
      {ribbon.segments.map((seg: RoadSegment) => (
        <group key={seg.id}>
          <mesh geometry={seg.road} receiveShadow>
            <primitive object={roadMat} attach="material" />
          </mesh>
          <mesh geometry={seg.apron} receiveShadow>
            <primitive object={apronMat} attach="material" />
          </mesh>
        </group>
      ))}
    </group>
  );
}
