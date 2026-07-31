/**
 * Static Poly Haven scrapyard set-dressing around the circuit.
 * Distance-culled; does not participate in physics.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  TRACK_SAMPLES,
  SCENERY,
  getGroundHeight,
  getSurfaceAt,
} from "../track";
import { loadPhModel, type PhModelKey } from "./polyHavenAssets";
import { FRAME } from "./framePriority";
import { qualityManager } from "./quality";

type DecorItem = {
  key: PhModelKey;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  targetLen: number;
};

/** Exported so placement can be asserted against the ground query, not eyeballed. */
export function buildDecorList(tier: string): DecorItem[] {
  const items: DecorItem[] = [];
  const n = TRACK_SAMPLES.length;
  if (n < 8) return items;
  const stride = tier === "low" ? 14 : tier === "medium" ? 10 : 7;

  for (let i = 0; i < n; i += stride) {
    const s = TRACK_SAMPLES[i];
    const rx = Math.cos(s.yaw);
    const rz = -Math.sin(s.yaw);
    const side = i % 2 === 0 ? 1 : -1;
    const off = s.width * 0.5 + 6 + (i % 5) * 1.8;
    const pick = i % 7;
    const base = {
      x: s.x + rx * side * off,
      y: s.y,
      z: s.z + rz * side * off,
      yaw: s.yaw + side * 0.35,
      scale: 1,
    };
    if (pick === 0)
      items.push({ ...base, key: "coveredCar", targetLen: 4.4, scale: 1 });
    else if (pick === 1)
      items.push({ ...base, key: "barrier", targetLen: 1.8, scale: 1 });
    else if (pick === 2)
      items.push({
        ...base,
        key: "boulder",
        targetLen: 2.2 + (i % 3) * 0.4,
        scale: 1,
      });
    else if (pick === 3)
      items.push({ ...base, key: "trash", targetLen: 1.15, scale: 1 });
    else if (pick === 4)
      items.push({ ...base, key: "hydrant", targetLen: 0.95, scale: 1 });
    else if (pick === 5)
      items.push({ ...base, key: "tyre", targetLen: 1.0, scale: 1.1 });
    else items.push({ ...base, key: "rim", targetLen: 0.9, scale: 1 });
  }

  // Landmark pile near start
  const s0 = TRACK_SAMPLES[0];
  if (s0) {
    items.push(
      {
        key: "coveredCar",
        x: s0.x + 18,
        y: s0.y,
        z: s0.z + 22,
        yaw: 0.6,
        scale: 1,
        targetLen: 4.6,
      },
      {
        key: "coveredCar",
        x: s0.x + 24,
        y: s0.y,
        z: s0.z + 18,
        yaw: -0.4,
        scale: 1,
        targetLen: 4.2,
      },
      {
        key: "pipes",
        x: s0.x + 32,
        y: s0.y,
        z: s0.z + 28,
        yaw: 0.2,
        scale: 1,
        targetLen: 6,
      },
      {
        key: "fence",
        x: s0.x - 8,
        y: s0.y,
        z: s0.z + 30,
        yaw: 1.2,
        scale: 1,
        targetLen: 4,
      },
    );
  }

  // Extra from SCENERY anchors
  for (let i = 0; i < SCENERY.length; i += 3) {
    const sc = SCENERY[i];
    items.push({
      key: i % 2 === 0 ? "boulder" : "barrier",
      x: sc.x,
      y: 0,
      z: sc.z,
      yaw: sc.rot,
      scale: sc.scale * 0.85,
      targetLen: i % 2 === 0 ? 2.8 : 1.7,
    });
  }

  if (tier === "low") return settleDecor(items.slice(0, 28));
  if (tier === "medium") return settleDecor(items.slice(0, 48));
  return settleDecor(items.slice(0, 72));
}

/**
 * Drop decor onto the ground and off the tarmac.
 *
 * Every branch above set `y` to the ROAD plane (`s.y`) or to a literal 0, but
 * these sit 6m+ from the edge where the berm has already begun to climb, so
 * they were floating or sunk depending on which way the dune went. Nothing here
 * participates in physics, which makes a piece that intersects the road worse
 * than ugly: you drive straight through it. Pushing it clear is the fix — a
 * collider on set dressing would just be an invisible wall in a different spot.
 */
function settleDecor(items: DecorItem[]): DecorItem[] {
  return items.map((it) => {
    let { x, z } = it;
    // Half the kit's longest dimension, plus the shoulder the car uses.
    const pad = 3.5 + it.targetLen * 0.5;
    const surf = getSurfaceAt(x, z);
    const need = surf.half + pad;
    if (surf.dist < need) {
      const s = surf.sample;
      let nx = x - s.x;
      let nz = z - s.z;
      const d = Math.hypot(nx, nz);
      if (d < 1e-3) {
        nx = Math.cos(s.yaw);
        nz = -Math.sin(s.yaw);
      } else {
        nx /= d;
        nz /= d;
      }
      x = s.x + nx * need;
      z = s.z + nz * need;
    }
    return { ...it, x, z, y: getGroundHeight(x, z) };
  });
}

/** One InstancedMesh plus the per-instance data needed to distance-cull it. */
type Batch = {
  mesh: THREE.InstancedMesh;
  base: THREE.Matrix4[];
  cx: Float32Array;
  cz: Float32Array;
};

export function SceneryDecor() {
  const group = useRef<THREE.Group>(null);
  const [ready, setReady] = useState(0);
  const batches = useRef<Batch[]>([]);
  const shown = useRef<Uint8Array[]>([]);
  const tick = useRef(0);
  const { camera } = useThree();
  const tier = qualityManager.get().tier;
  const list = useMemo(() => buildDecorList(tier), [tier]);

  useEffect(() => {
    let alive = true;
    batches.current = [];
    shown.current = [];
    const g = group.current;
    if (!g) return;
    while (g.children.length) g.remove(g.children[0]);

    void (async () => {
      // Bucket by template, then draw each bucket as a single InstancedMesh.
      // Previously every decor slot was an independent cloned Group, so ~70
      // props meant ~70+ draw calls and ~70 clones; now it is one call per
      // distinct prop geometry (~15-20 total).
      const buckets = new Map<
        string,
        { key: PhModelKey; targetLen: number; items: DecorItem[] }
      >();
      for (const it of list) {
        const k = `${it.key}|${it.targetLen.toFixed(2)}`;
        let b = buckets.get(k);
        if (!b) {
          b = { key: it.key, targetLen: it.targetLen, items: [] };
          buckets.set(k, b);
        }
        b.items.push(it);
      }

      const groups = [...buckets.values()];
      // Concurrent, not a sequential await chain: loadPhModel dedupes per
      // template, so this is ~20 fetches in flight instead of ~70 back to back.
      const tpls = await Promise.all(
        groups.map((gr) => loadPhModel(gr.key, gr.targetLen).catch(() => null)),
      );
      if (!alive || !group.current) return;

      const itemM = new THREE.Matrix4();
      const quat = new THREE.Quaternion();
      const pos = new THREE.Vector3();
      const scl = new THREE.Vector3();
      const inst = new THREE.Matrix4();

      for (let gi = 0; gi < groups.length; gi++) {
        const tpl = tpls[gi];
        if (!tpl) continue;
        const items = groups[gi].items;
        tpl.updateMatrixWorld(true);

        // A Poly Haven template can hold several meshes; each becomes its own
        // batch, carrying the mesh's transform within the template.
        const parts: {
          geo: THREE.BufferGeometry;
          mat: THREE.Material;
          rel: THREE.Matrix4;
          cast: boolean;
          receive: boolean;
        }[] = [];
        tpl.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh || !m.geometry) return;
          const mat = Array.isArray(m.material) ? m.material[0] : m.material;
          if (!mat) return;
          parts.push({
            geo: m.geometry,
            mat,
            rel: m.matrixWorld.clone(),
            cast: m.castShadow,
            receive: m.receiveShadow,
          });
        });

        // Cap parts per template.
        //
        // One InstancedMesh is created per mesh INSIDE the template, which is
        // fine for a single-mesh prop and pathological for a kit: the `pipes`
        // key resolves to modular_pipes, a 106-mesh set, so one decorative prop
        // near the start line was costing ~106 draw calls — every pipe scaled
        // down to a few centimetres and individually invisible. `fence` is the
        // same shape of asset.
        //
        // Keep the largest parts by bounding-box volume: at decor scale the
        // silhouette comes from the big pieces, and the small ones are below a
        // pixel anyway.
        const MAX_PARTS = 6;
        if (parts.length > MAX_PARTS) {
          const bb = new THREE.Box3();
          const sz = new THREE.Vector3();
          parts.sort((a, b) => {
            const va = bb.setFromBufferAttribute(
              a.geo.attributes.position as THREE.BufferAttribute,
            ).getSize(sz).x * sz.y * sz.z;
            const vb = bb.setFromBufferAttribute(
              b.geo.attributes.position as THREE.BufferAttribute,
            ).getSize(sz).x * sz.y * sz.z;
            return vb - va;
          });
          parts.length = MAX_PARTS;
        }

        for (const part of parts) {
          const im = new THREE.InstancedMesh(part.geo, part.mat, items.length);
          im.castShadow = part.cast;
          im.receiveShadow = part.receive;
          im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          im.frustumCulled = false; // instances span the track; cull per-instance
          const base: THREE.Matrix4[] = [];
          const cxs = new Float32Array(items.length);
          const czs = new Float32Array(items.length);
          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.yaw);
            pos.set(it.x, it.y, it.z);
            scl.setScalar(it.scale);
            itemM.compose(pos, quat, scl);
            inst.multiplyMatrices(itemM, part.rel);
            base.push(inst.clone());
            im.setMatrixAt(i, inst);
            cxs[i] = it.x;
            czs[i] = it.z;
          }
          im.instanceMatrix.needsUpdate = true;
          group.current.add(im);
          batches.current.push({ mesh: im, base, cx: cxs, cz: czs });
          shown.current.push(new Uint8Array(items.length).fill(1));
        }
      }
      if (alive) setReady((n) => n + 1);
    })();

    return () => {
      alive = false;
      for (const b of batches.current) b.mesh.dispose();
      batches.current = [];
      shown.current = [];
    };
  }, [list]);

  useFrame(() => {
    /*
     * Per-instance distance culling. Throttled — the visible set barely changes
     * frame to frame at race speeds.
     *
     * Visible instances are PACKED TO THE FRONT and `count` is trimmed. This
     * previously wrote a zero-scale matrix into the hidden slots instead, which
     * looks equivalent and is not: a degenerate instance is still dispatched
     * and still runs the vertex shader for every vertex of a Poly Haven prop,
     * so a covered car 400m away cost the same transform work as one alongside
     * the player. Same fix as CullableScenery's.
     */
    if (tick.current++ % 8 !== 0) return;
    const maxD = tier === "low" ? 70 : tier === "medium" ? 110 : 150;
    const maxD2 = maxD * maxD;
    const camX = camera.position.x;
    const camZ = camera.position.z;
    for (let bi = 0; bi < batches.current.length; bi++) {
      const b = batches.current[bi];
      const vis = shown.current[bi];
      let dirty = false;
      for (let i = 0; i < b.base.length; i++) {
        const dx = b.cx[i] - camX;
        const dz = b.cz[i] - camZ;
        const on = dx * dx + dz * dz < maxD2 ? 1 : 0;
        if (on === vis[i]) continue;
        vis[i] = on;
        dirty = true;
      }
      if (!dirty) continue;
      let w = 0;
      for (let i = 0; i < b.base.length; i++) {
        if (vis[i]) b.mesh.setMatrixAt(w++, b.base[i]);
      }
      b.mesh.count = w;
      b.mesh.instanceMatrix.needsUpdate = true;
    }
  }, FRAME.LATE);

  void ready;
  return <group ref={group} />;
}
