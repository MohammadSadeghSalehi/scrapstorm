import { useMemo } from "react";
import * as THREE from "three";
import { EDGE_MARKERS, TRACK_SAMPLES, getTrackEpoch } from "../track";
import { createProcMaterial } from "./procmat";
import { qualityManager } from "./quality";
import { HeightmapTerrain } from "./HeightmapTerrain";
import { clonePbrPack, isPbrLibraryReady } from "./webgl2/textureLibrary";
import { attachGpuDetail } from "./shaders/gpuDetail";
import { attachRoadWear } from "./shaders/roadWear";
import { getMaxAnisotropy } from "./webgl2/configure";
import type { TrackSample } from "../types";
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

/**
 * Metres of road covered by one tile of the asphalt / gravel packs.
 *
 * The ribbon's UVs are normalised, not world-scaled: u runs 0..1 over the whole
 * circuit and v runs 0..1 across the tarmac (see roadSegments.pushQuad). A
 * texture repeat of 0.2 therefore stretched a single tile over ~900m of road,
 * so every high frequency in the normal and roughness maps averaged out to a
 * constant — which is exactly why the road read as one flat grey band with no
 * highlight anywhere. Deriving the repeat from real track metres restores the
 * texel density the packs were authored at, and costs nothing per frame: it is
 * the same number of fetches, just at a different mip level.
 */
const ROAD_TILE_M = 5.5;
const APRON_TILE_M = 3.5;

/** Mirrors `apronW` in culling/roadSegments.ts — the apron strip is 5.5m wide. */
const APRON_WIDTH_M = 5.5;

/** Circuit length and mean tarmac width, in metres, for texture repeats. */
function trackMetrics(samples: TrackSample[]): { length: number; width: number } {
  const n = samples.length;
  let length = 0;
  let width = 0;
  for (let i = 0; i < n; i++) {
    const a = samples[i]!;
    const b = samples[(i + 1) % n]!;
    length += Math.hypot(b.x - a.x, b.z - a.z);
    width += a.width;
  }
  return {
    length: Math.max(1, length),
    width: Math.max(1, width / Math.max(1, n)),
  };
}

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
  // Poles must stand OUTSIDE the tarmac. At width*0.42 against a half-width of
  // width*0.5 they were planted ~2m inside the road edge — a solid column in
  // the driving line that you had to swerve around.
  const half = width * 0.5 + 1.6;
  const bannerW = Math.min(7.5, width * 0.42);
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
    const track = trackMetrics(TRACK_SAMPLES);
    const roadRepeatU = track.length / ROAD_TILE_M;
    const roadRepeatV = track.width / ROAD_TILE_M;
    let road: THREE.MeshStandardMaterial;
    const asp = isPbrLibraryReady()
      ? clonePbrPack("asphalt", roadRepeatU, roadRepeatV)
      : null;
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
        // Dry tarmac still has a specular lobe. At 0.82 the road was matte at
        // every sun angle; the roughness map now supplies the variation on top
        // of this, and attachRoadWear pulls the wheel grooves far lower still.
        roughness: 0.72,
        metalness: 0.06,
        vertexColors: true,
        // The normal map was effectively unused while the pack was stretched
        // over the whole circuit. At real tiling it carries the aggregate, so
        // hold it just under 1 or the surface boils at speed.
        normalScale: new THREE.Vector2(0.9, 0.9),
        envMapIntensity: 0.9,
      });
      // Attach wear before the LoD detail. onBeforeCompile chains call prev
      // first, so gpuDetail's injection ends up *above* the wear block in the
      // final shader — the lane targets therefore clamp the LoD noise instead
      // of the noise smearing the ruts back to a uniform roughness.
      attachRoadWear(road);
      if (qualityManager.get().gpuDetail > 0.15) {
        attachGpuDetail(road, {
          kind: "asphalt",
          detailScale: 14,
          quality: qualityManager.get(),
        });
      }
    } else {
      road = createProcMaterial("asphalt", {
        repeat: [roadRepeatU, roadRepeatV],
        color: "#4a4844",
        normalScale: 0.55,
        ao: true,
        gpuDetail: true,
        detailScale: 14,
      });
      road.roughness = 0.72;
      road.vertexColors = true;
      attachRoadWear(road);
    }

    let apron: THREE.MeshStandardMaterial;
    {
      // Same normalised-UV story as the road: the apron's v spans its 5.5m
      // width, so its repeat has to be derived from metres too or the gravel
      // is one smeared tile the length of the circuit.
      const apronRepeatU = track.length / APRON_TILE_M;
      const apronRepeatV = APRON_WIDTH_M / APRON_TILE_M;
      const grav = isPbrLibraryReady()
        ? clonePbrPack("gravel", apronRepeatU, apronRepeatV)
        : null;
      const dirt = isPbrLibraryReady()
        ? clonePbrPack("dirt", apronRepeatU, apronRepeatV)
        : null;
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
          repeat: [apronRepeatU, apronRepeatV],
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
