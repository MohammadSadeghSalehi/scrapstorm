/**
 * Hazard / arena beacons — instanced + per-frame CPU cull.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { TRACK_SAMPLES } from "../../track";
import { hazardMap } from "../procmat";
import { qualityManager } from "../quality";
import {
  buildSphereGrid,
  cullConfigForTier,
  queryGridRadius,
  type CullStats,
} from "./cpuTerrainCull";
import {
  createInstanceStream,
  fitInstanceBounds,
  rebuildInstanceCount,
} from "./instanceStream";

const beaconState: { stats: CullStats | null } = { stats: null };

export function getLastBeaconCullStats() {
  return beaconState.stats;
}

export function CulledBeacons() {
  const tier = qualityManager.get().tier;
  const hazard = useMemo(() => hazardMap(), []);
  const pack = useMemo(() => {
    if (tier === "low") return null;
    /*
     * Hazard-zone markers, moved to the verge.
     *
     * These were spheres sitting at `s.y + 2.4` on the track CENTRELINE —
     * glowing amber orbs floating at head height directly over the racing
     * line. Reported repeatedly as "yellow balls in the middle of the road",
     * and rightly: nothing in a desert circuit floats.
     *
     * They still mark the same samples, but as lamps on the verge, one per
     * side, low enough to read as track furniture. The signal is preserved;
     * the orb is not.
     */
    const pts: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < TRACK_SAMPLES.length; i += 12) {
      const s = TRACK_SAMPLES[i];
      if (s.zone !== "hazard" && s.zone !== "arena") continue;
      const rx = Math.cos(s.yaw);
      const rz = -Math.sin(s.yaw);
      const off = s.width * 0.5 + 1.1;
      for (const side of [-1, 1] as const) {
        pts.push({
          x: s.x + rx * side * off,
          y: s.y + 0.75,
          z: s.z + rz * side * off,
        });
      }
    }
    const geo = new THREE.SphereGeometry(0.22, 8, 6);
    const mat = new THREE.MeshStandardMaterial({
      map: hazard,
      emissive: "#f59e0b",
      // Tone-mapped now: an untonemapped emissive bypasses ACES entirely and
      // blows straight through the bloom threshold, which is what made these
      // read as hot glowing balls rather than lit markers.
      emissiveIntensity: 0.7,
      roughness: 0.4,
      metalness: 0.2,
    });
    const matrices: THREE.Matrix4[] = [];
    const spheres: { x: number; y: number; z: number; r: number }[] = [];
    const dummy = new THREE.Object3D();
    for (const p of pts) {
      dummy.position.set(p.x, p.y, p.z);
      dummy.updateMatrix();
      matrices.push(dummy.matrix.clone());
      spheres.push({ x: p.x, y: p.y, z: p.z, r: 1.2 });
    }
    return {
      geo,
      mat,
      stream: createInstanceStream(matrices, spheres),
      grid: buildSphereGrid(spheres, 48),
    };
  }, [hazard, tier]);

  const meshRef = useRef<THREE.InstancedMesh | null>(null);
  const cfgRef = useRef(cullConfigForTier(tier));

  const mesh = useMemo(() => {
    if (!pack || pack.stream.matrices.length === 0) return null;
    const m = new THREE.InstancedMesh(
      pack.geo,
      pack.mat,
      Math.max(1, pack.stream.matrices.length),
    );
    pack.stream.matrices.forEach((mat, i) => m.setMatrixAt(i, mat));
    m.instanceMatrix.needsUpdate = true;
    m.count = pack.stream.matrices.length;
    m.castShadow = false;
    fitInstanceBounds(m, pack.stream.spheres);
    return m;
  }, [pack]);

  useEffect(() => {
    meshRef.current = mesh;
    return () => {
      meshRef.current = null;
    };
  }, [mesh]);

  useFrame(({ camera }) => {
    const m = meshRef.current;
    if (!m || !pack || pack.stream.matrices.length === 0) return;
    cfgRef.current = cullConfigForTier(qualityManager.get().tier);
    const candidates = queryGridRadius(
      pack.grid,
      camera.position.x,
      camera.position.z,
      cfgRef.current.maxDistance + 10,
    );
    beaconState.stats = rebuildInstanceCount(
      m,
      pack.stream,
      camera,
      cfgRef.current,
      candidates.length ? candidates : undefined,
    );
  });

  if (!mesh) return null;
  return <primitive object={mesh} />;
}
