/**
 * One instanced scatter layer with per-instance CPU culling.
 *
 * The culling contract matches CullableScenery's: visible instances are PACKED
 * TO THE FRONT of the buffer and `mesh.count` is trimmed. The tempting
 * alternative — collapsing hidden instances to a zero-scale matrix — still runs
 * the vertex shader for every hidden instance, which at two thousand instances
 * is most of the cost of having them.
 *
 * Everything else here exists to keep the per-frame cost of that packing near
 * zero:
 *
 * - Transforms live in one flat Float32Array, not an array of Matrix4 objects.
 * - The rebuild is throttled and phase-offset per layer, so no single frame
 *   repacks every field. At 200km/h the camera moves under 3m between
 *   rebuilds, against cull radii of 90-300m.
 * - Only the packed prefix is uploaded (`addUpdateRange`), so a frame with 400
 *   visible rocks uploads 400 matrices rather than the full 1600.
 * - A camera that has not meaningfully moved or turned skips the rebuild.
 *
 * Quality tier is read here, per rebuild, rather than captured at render time.
 * Nothing in the world tree re-renders when `qualityManager` changes tier (only
 * GpuDetailDriver subscribes), so a tier captured in props would go stale the
 * moment the adaptive scaler moved — and rebuilding the field on tier change is
 * exactly the kind of mid-race hitch §0 of the punch list is about.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import {
  extractFrustumPlanes,
  sphereInFrustum,
} from "../culling/cpuTerrainCull";
import { FRAME } from "../framePriority";
import { qualityManager } from "../quality";
import type { ScatterLayerData, TierScale } from "./layerData";

/** Frames between repacks. Phase-offset per layer by the caller. */
const REBUILD_EVERY = 3;
/** Frustum slack, in metres, covering camera motion between repacks. */
const FRUSTUM_PAD = 10;

export function ScatterLayer({
  data,
  density,
  range,
  phase = 0,
}: {
  data: ScatterLayerData;
  /**
   * Fraction of the field this tier draws. Always applied as a PREFIX of the
   * shuffled list, so a tier drop thins the desert uniformly instead of
   * rearranging it — the field itself is built once, tier-independently.
   */
  density: TierScale;
  /** Multiplier on every instance's draw distance. */
  range: TierScale;
  phase?: number;
}) {
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(
      data.geometry,
      data.material,
      Math.max(1, data.total),
    );
    m.castShadow = data.castShadow;
    m.receiveShadow = data.receiveShadow;
    // Instances span the whole circuit, so three's per-object frustum test can
    // only ever answer "yes"; the useFrame below is the real cull.
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (data.colors) {
      const attr = new THREE.InstancedBufferAttribute(
        new Float32Array(data.total * 3),
        3,
      );
      attr.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = attr;
    }
    // Nothing is drawn until the first cull runs, so a layer never flashes at
    // full density on the frame it mounts.
    m.count = 0;
    return m;
  }, [data]);

  useEffect(() => {
    return () => {
      // Disposes the instance buffers only. Geometry and material are owned by
      // the field component's memo and outlive any single mesh.
      mesh.dispose();
    };
  }, [mesh]);

  const frame = useRef(0);
  const lastActive = useRef(-1);
  const lastRange = useRef(-1);
  const lastDamage = useRef(-1);
  const lastCam = useRef(new THREE.Vector3(1e9, 1e9, 1e9));
  const lastDir = useRef(new THREE.Vector3(0, 0, 0));
  const dir = useRef(new THREE.Vector3());

  useFrame(({ camera }) => {
    if (data.total === 0) return;
    frame.current++;
    if ((frame.current + phase) % REBUILD_EVERY !== 0) return;

    const tier = qualityManager.get().tier;
    const n = Math.min(data.total, Math.round(data.total * density[tier]));
    const rangeScale = range[tier];
    const range2 = rangeScale * rangeScale;

    camera.getWorldDirection(dir.current);
    // A casualty has to defeat the settled check on its own. A rail smashed
    // while the car is stationary against it moves the camera by less than the
    // 0.6m² threshold, so without this the module you just destroyed stays on
    // screen until you drive away from it.
    const damageV = data.damage ? data.damage.version() : 0;
    const settled =
      n === lastActive.current &&
      rangeScale === lastRange.current &&
      damageV === lastDamage.current &&
      camera.position.distanceToSquared(lastCam.current) < 0.6 &&
      dir.current.dot(lastDir.current) > 0.9995;
    if (settled) return;

    lastActive.current = n;
    lastRange.current = rangeScale;
    lastDamage.current = damageV;
    lastCam.current.copy(camera.position);
    lastDir.current.copy(dir.current);

    if (n === 0) {
      mesh.count = 0;
      return;
    }

    const planes = extractFrustumPlanes(camera);
    const camX = camera.position.x;
    const camY = camera.position.y;
    const camZ = camera.position.z;
    const src = data.matrices;
    const dst = mesh.instanceMatrix.array as Float32Array;
    const srcC = data.colors;
    const dstC = (mesh.instanceColor?.array as Float32Array | undefined) ?? null;
    const sphere = { x: 0, y: 0, z: 0, r: 0 };
    // Only consulted when the layer has a damage view at all, and the registry
    // itself short-circuits on an empty set, so an undamaged circuit pays one
    // null check per instance per repack.
    const damage = data.damage;

    let k = 0;
    for (let i = 0; i < n; i++) {
      if (damage && damage.isDown(i)) continue;
      const dx = data.cx[i]! - camX;
      const dy = data.cy[i]! - camY;
      const dz = data.cz[i]! - camZ;
      if (dx * dx + dy * dy + dz * dz > data.lim2[i]! * range2) continue;
      sphere.x = data.cx[i]!;
      sphere.y = data.cy[i]!;
      sphere.z = data.cz[i]!;
      sphere.r = data.cr[i]!;
      if (!sphereInFrustum(sphere, planes, FRUSTUM_PAD)) continue;

      const so = i * 16;
      const dof = k * 16;
      for (let q = 0; q < 16; q++) dst[dof + q] = src[so + q]!;
      if (srcC && dstC) {
        dstC[k * 3] = srcC[i * 3]!;
        dstC[k * 3 + 1] = srcC[i * 3 + 1]!;
        dstC[k * 3 + 2] = srcC[i * 3 + 2]!;
      }
      k++;
    }

    mesh.count = k;
    if (k > 0) {
      // Upload the packed prefix only. Without this every repack pushes the
      // full buffer, which for the scrub field is ~140KB a go for a few hundred
      // visible tufts.
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, k * 16);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) {
        mesh.instanceColor.clearUpdateRanges();
        mesh.instanceColor.addUpdateRange(0, k * 3);
        mesh.instanceColor.needsUpdate = true;
      }
    }
  }, FRAME.LATE);

  return <primitive object={mesh} />;
}
