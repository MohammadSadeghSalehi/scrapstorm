/**
 * Authored weapon geometry, normalised for instancing.
 *
 * The generated meshes cannot be dropped straight into an InstancedMesh. Three
 * things have to be true first and none of them are true as authored:
 *
 *  - ONE geometry. An InstancedMesh draws a single BufferGeometry, so a
 *    multi-primitive glTF has to be merged or the instancing collapses back
 *    into a draw call per part.
 *  - ORIENTED. Every projectile body in Effects.tsx is authored around +Z
 *    because `dummy.lookAt` puts local +Z along the velocity. The generated
 *    assets point along their own longest axis, which is X for the rocket and
 *    the saw.
 *  - SIZED IN METRES. A projectile's collision radius is fixed by gameplay; the
 *    mesh has to be scaled to match it, not the other way round.
 *
 * The geometry is cached and shared. It is never disposed: these outlive any
 * one race, and disposing a geometry an InstancedMesh still references is a
 * far worse failure than holding a few hundred kilobytes.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export type WeaponMeshId = "rocket" | "saw" | "mine" | "turret" | "launcher";

type Spec = {
  url: string;
  /** Target length along the flight axis, in metres. */
  length: number;
  /**
   * Which local axis the asset's longest dimension runs along, measured with
   * scripts/inspect-mesh-orientation.mjs rather than guessed.
   */
  longAxis: "x" | "y" | "z";
};

const SPECS: Record<WeaponMeshId, Spec> = {
  // Matches the 0.72m cylinder it replaces, so the collision radius that
  // gameplay already tuned still describes what you can see.
  rocket: { url: "/assets/meshes/weapons/SM_MeshGen_ScrapMetalRocket.glb", length: 0.8, longAxis: "x" },
  // The disc collider is 0.4m radius; 0.8 across matches it exactly.
  saw: { url: "/assets/meshes/weapons/SM_MeshGen_RustyIndustrialSawBlade.glb", length: 0.8, longAxis: "x" },
  mine: { url: "/assets/meshes/weapons/SM_MeshGen_ImprovisedSpikedMine.glb", length: 0.55, longAxis: "z" },
  turret: { url: "/assets/meshes/weapons/SM_MeshGen_WastelandHeavyTurret.glb", length: 1.6, longAxis: "x" },
  launcher: { url: "/assets/meshes/weapons/SM_MeshGen_ImprovisedQuadLauncher.glb", length: 1.1, longAxis: "x" },
};

const cache = new Map<WeaponMeshId, THREE.BufferGeometry | null>();
const pending = new Map<WeaponMeshId, Promise<THREE.BufferGeometry | null>>();

function mergeToSingle(root: THREE.Object3D): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    const g = m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    // Instanced draws share one attribute set; anything a sibling primitive
    // lacks would read as garbage, so keep only what every part is guaranteed
    // to have and let normals be recomputed below.
    for (const name of Object.keys(g.attributes)) {
      if (name !== "position" && name !== "uv") g.deleteAttribute(name);
    }
    parts.push(g);
  });
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0]!;

  // Concatenate by hand rather than pulling in BufferGeometryUtils: every part
  // is already indexed and position/uv only, so this is a few lines and avoids
  // a dependency that would come with a chunk of unrelated code.
  let vTotal = 0;
  let iTotal = 0;
  for (const g of parts) {
    vTotal += g.attributes.position.count;
    iTotal += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vTotal * 3);
  const uv = new Float32Array(vTotal * 2);
  const idx = new Uint32Array(iTotal);
  let vAt = 0;
  let iAt = 0;
  for (const g of parts) {
    const p = g.attributes.position as THREE.BufferAttribute;
    const u = g.attributes.uv as THREE.BufferAttribute | undefined;
    for (let i = 0; i < p.count; i++) {
      pos[(vAt + i) * 3] = p.getX(i);
      pos[(vAt + i) * 3 + 1] = p.getY(i);
      pos[(vAt + i) * 3 + 2] = p.getZ(i);
      uv[(vAt + i) * 2] = u ? u.getX(i) : 0;
      uv[(vAt + i) * 2 + 1] = u ? u.getY(i) : 0;
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx[iAt + i] = g.index.getX(i) + vAt;
      iAt += g.index.count;
    } else {
      for (let i = 0; i < p.count; i++) idx[iAt + i] = vAt + i;
      iAt += p.count;
    }
    vAt += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/**
 * Load, merge, orient to +Z, centre and scale to the gameplay size.
 *
 * Resolves to null on any failure. Callers keep their primitive fallback, so a
 * missing asset costs fidelity and nothing else — a projectile that fails to
 * draw is a weapon the player cannot see coming.
 */
export function loadWeaponGeometry(
  id: WeaponMeshId,
): Promise<THREE.BufferGeometry | null> {
  if (cache.has(id)) return Promise.resolve(cache.get(id)!);
  const hit = pending.get(id);
  if (hit) return hit;

  const spec = SPECS[id];
  const p = new Promise<THREE.BufferGeometry | null>((resolve) => {
    new GLTFLoader().load(
      spec.url,
      (gltf) => {
        const geo = mergeToSingle(gltf.scene);
        if (!geo) {
          cache.set(id, null);
          resolve(null);
          return;
        }
        // Rotate the asset's long axis onto +Z, which is the axis lookAt aligns
        // to the velocity.
        if (spec.longAxis === "x") geo.rotateY(Math.PI / 2);
        else if (spec.longAxis === "y") geo.rotateX(-Math.PI / 2);

        geo.computeBoundingBox();
        const bb = geo.boundingBox!;
        const c = bb.getCenter(new THREE.Vector3());
        // Centre on the origin: an instance is positioned at the projectile's
        // centre, and an off-centre body would orbit it as the instance turns.
        geo.translate(-c.x, -c.y, -c.z);
        const size = bb.getSize(new THREE.Vector3());
        const along = Math.max(size.z, 1e-4);
        geo.scale(spec.length / along, spec.length / along, spec.length / along);
        // Normals were dropped by the spatial weld so they could be rebuilt from
        // the fused topology rather than averaged across shells that used to be
        // separate.
        geo.computeVertexNormals();
        geo.computeBoundingSphere();
        cache.set(id, geo);
        resolve(geo);
      },
      undefined,
      () => {
        cache.set(id, null);
        resolve(null);
      },
    );
  });
  pending.set(id, p);
  return p;
}
