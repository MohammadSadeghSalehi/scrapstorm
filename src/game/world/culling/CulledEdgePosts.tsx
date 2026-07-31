/**
 * Edge posts — InstancedMesh with per-frame CPU cull + instance count rebuild.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { createProcMaterial } from "../procmat";
import { qualityManager } from "../quality";
import {
  cullConfigForTier,
  buildSphereGrid,
  queryGridRadius,
  type CullStats,
} from "./cpuTerrainCull";
import {
  createInstanceStream,
  fitInstanceBounds,
  rebuildInstanceCount,
  type InstanceStream,
} from "./instanceStream";
import { anyEdgeDown, edgeKey, isEdgeDown } from "../edgeDamage";

export type EdgeMarker = { x: number; y: number; z: number; side: number };

const empty: CullStats = {
  tested: 0,
  frustumPass: 0,
  distancePass: 0,
  visible: 0,
  ms: 0,
};

const edgeCullState = {
  white: empty,
  red: empty,
};

export function getLastEdgePostCullStats() {
  const total = edgeCullState.white.tested + edgeCullState.red.tested;
  if (total === 0) return null;
  return {
    white: edgeCullState.white,
    red: edgeCullState.red,
    total,
    visible: edgeCullState.white.visible + edgeCullState.red.visible,
  };
}

export function CulledEdgePosts({ markers }: { markers: EdgeMarker[] }) {
  const tier = qualityManager.get().tier;
  const packs = useMemo(() => {
    const geo = new THREE.BoxGeometry(0.28, 1.7, 0.28);
    const matA = createProcMaterial("metal", {
      repeat: [0.5, 1.2],
      color: "#fafaf9",
      normalScale: 0.55,
      ao: false,
      gpuDetail: tier === "high",
      detailScale: 18,
    });
    matA.emissive = new THREE.Color("#a8a29e");
    matA.emissiveIntensity = 0.12;
    const matB = createProcMaterial("metal", {
      repeat: [0.5, 1.2],
      color: "#dc2626",
      normalScale: 0.55,
      ao: false,
      gpuDetail: tier === "high",
      detailScale: 18,
    });
    matB.emissive = new THREE.Color("#7f1d1d");
    matB.emissiveIntensity = 0.18;

    const whiteMats: THREE.Matrix4[] = [];
    const redMats: THREE.Matrix4[] = [];
    const whiteSpheres: { x: number; y: number; z: number; r: number }[] = [];
    const redSpheres: { x: number; y: number; z: number; r: number }[] = [];
    // Marker keys parallel to each stream, so a destroyed barrier can be
    // matched back to the post instance that represents it.
    const whiteKeys: string[] = [];
    const redKeys: string[] = [];
    const dummy = new THREE.Object3D();
    const step = tier === "low" ? 2 : 1;

    markers.forEach((m, i) => {
      if (i % step !== 0) return;
      dummy.position.set(m.x, m.y + 0.85, m.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      const sphere = { x: m.x, y: m.y + 0.85, z: m.z, r: 1.4 };
      if (Math.floor(i / 2) % 2 === 0) {
        whiteMats.push(dummy.matrix.clone());
        whiteSpheres.push(sphere);
        whiteKeys.push(edgeKey(m.x, m.z));
      } else {
        redMats.push(dummy.matrix.clone());
        redSpheres.push(sphere);
        redKeys.push(edgeKey(m.x, m.z));
      }
    });

    return {
      geo,
      matA,
      matB,
      white: createInstanceStream(whiteMats, whiteSpheres),
      red: createInstanceStream(redMats, redSpheres),
      whiteKeys,
      redKeys,
      whiteGrid: buildSphereGrid(whiteSpheres, 40),
      redGrid: buildSphereGrid(redSpheres, 40),
    };
  }, [markers, tier]);

  return (
    <group>
      <CulledInstanceLayer
        stream={packs.white}
        keys={packs.whiteKeys}
        grid={packs.whiteGrid}
        geometry={packs.geo}
        material={packs.matA}
        color="white"
      />
      <CulledInstanceLayer
        stream={packs.red}
        keys={packs.redKeys}
        grid={packs.redGrid}
        geometry={packs.geo}
        material={packs.matB}
        color="red"
      />
    </group>
  );
}

function CulledInstanceLayer({
  stream,
  keys,
  grid,
  geometry,
  material,
  color,
}: {
  stream: InstanceStream;
  keys?: string[];
  grid: ReturnType<typeof buildSphereGrid>;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  color: "white" | "red";
}) {
  const meshRef = useRef<THREE.InstancedMesh | null>(null);
  const cfgRef = useRef(cullConfigForTier(qualityManager.get().tier));
  const frame = useRef(0);

  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(
      geometry,
      material,
      Math.max(1, stream.matrices.length),
    );
    stream.matrices.forEach((mat, i) => m.setMatrixAt(i, mat));
    m.instanceMatrix.needsUpdate = true;
    m.count = stream.matrices.length;
    m.castShadow = qualityManager.get().tier !== "low";
    m.receiveShadow = true;
    fitInstanceBounds(m, stream.spheres);
    return m;
  }, [stream, geometry, material]);

  useEffect(() => {
    meshRef.current = mesh;
    return () => {
      meshRef.current = null;
    };
  }, [mesh]);

  useFrame(({ camera }) => {
    const m = meshRef.current;
    if (!m || stream.matrices.length === 0) return;
    frame.current++;
    if (frame.current % 45 === 0) {
      cfgRef.current = cullConfigForTier(qualityManager.get().tier);
    }

    let candidates = queryGridRadius(
      grid,
      camera.position.x,
      camera.position.z,
      cfgRef.current.maxDistance + 20,
    );
    // Drop posts that have been smashed. Guarded on anyEdgeDown so an intact
    // grid pays nothing for this — the common case by far.
    if (anyEdgeDown() && keys) {
      candidates = candidates.filter((i) => !isEdgeDown(keys[i]!));
      if (candidates.length === 0) {
        m.count = 0;
        m.instanceMatrix.needsUpdate = true;
        edgeCullState[color] = empty;
        return;
      }
    }
    const stats = rebuildInstanceCount(
      m,
      stream,
      camera,
      cfgRef.current,
      candidates.length > 0 ? candidates : undefined,
    );
    edgeCullState[color] = stats;
  });

  return <primitive object={mesh} />;
}
