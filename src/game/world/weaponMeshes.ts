/**
 * Authored weapon geometry, normalised for instancing.
 *
 * The generated meshes cannot be dropped straight into an InstancedMesh. Four
 * things have to be true first and none of them are true as authored:
 *
 *  - DECODABLE. Every one of these .glb files declares EXT_meshopt_compression
 *    in `extensionsRequired`. A bare `new GLTFLoader()` rejects all five with
 *    "setMeshoptDecoder must be called before loading compressed files" — it
 *    calls onError, this module caches null, and every caller silently keeps
 *    its placeholder. That is why none of the authored weapon art had ever
 *    appeared on screen: not the rocket, not the saw, not the mine, and not the
 *    turret or launcher, which meant WeaponMounts rendered literally nothing.
 *    Use the shared factory in gltfLoaders.ts, which wires meshopt/Draco/KTX2.
 *  - ONE geometry. An InstancedMesh draws a single BufferGeometry, so a
 *    multi-primitive glTF has to be merged or the instancing collapses back
 *    into a draw call per part.
 *  - VERTEX COLOURED. The instanced projectile material draws with
 *    `vertexColors`, and a geometry with no `color` attribute reads the WebGL
 *    default generic attribute — (0,0,0) — so the mesh renders solid black
 *    rather than not at all. A merged glTF has no colour channel, so one is
 *    written here; a consumer that does not use vertexColors simply ignores it.
 *  - ORIENTED AND SIZED IN METRES. Every projectile body in Effects.tsx is
 *    authored around +Z because `dummy.lookAt` puts local +Z along the
 *    velocity, and a projectile's collision radius is fixed by gameplay, so the
 *    mesh is scaled to match it rather than the other way round.
 *
 * The geometry is cached and shared. It is never disposed: these outlive any
 * one race, and disposing a geometry an InstancedMesh still references is a
 * far worse failure than holding a few hundred kilobytes.
 */
import * as THREE from "three";
import { createGltfLoader } from "./gltfLoaders";

export type WeaponMeshId = "rocket" | "saw" | "mine" | "turret" | "launcher";

type Spec = {
  url: string;
  /** Target size in metres — see `fit` for which dimension it describes. */
  length: number;
  /**
   * Which local axis is rotated onto +Z, measured with
   * scripts/inspect-mesh-orientation.mjs rather than guessed.
   *
   * For a body this is the axis it flies along. For the saw it is the disc's
   * NORMAL, which is the short axis — a blade whose long axis points down the
   * line of flight is a lance, not a buzzsaw.
   */
  align: "x" | "y" | "z";
  /**
   * Which dimension `length` measures once aligned. "along" = the +Z extent,
   * i.e. how long the body is. "across" = the widest cross-section, which is
   * what a disc's diameter is and what its collision radius describes.
   */
  fit: "along" | "across";
  /**
   * This asset has a nose. Aligning the long axis to +Z is a 50/50 bet on which
   * END leads, and the rocket lost it: measured, the scrap rocket tapers to a
   * 0.065 m tip at one end and flares to 0.191 m of fins at the other, and the
   * naive rotation put the fins forward — every missile in the game was flying
   * backwards. Detected from the geometry rather than hardcoded so a
   * regenerated asset corrects itself instead of silently reversing.
   */
  taper?: boolean;
};

const SPECS: Record<WeaponMeshId, Spec> = {
  // Matches the 0.72m cylinder it replaces, so the collision radius that
  // gameplay already tuned still describes what you can see.
  rocket: {
    url: "/assets/meshes/weapons/SM_MeshGen_ScrapMetalRocket.glb",
    length: 0.8,
    align: "x",
    fit: "along",
    taper: true,
  },
  // Authored 0.888 x 0.797 x 0.483: a disc in XY whose normal is already Z.
  // The disc collider is 0.4m radius, so 0.8 ACROSS matches it exactly.
  saw: {
    url: "/assets/meshes/weapons/SM_MeshGen_RustyIndustrialSawBlade.glb",
    length: 0.8,
    align: "z",
    fit: "across",
  },
  mine: {
    url: "/assets/meshes/weapons/SM_MeshGen_ImprovisedSpikedMine.glb",
    length: 0.55,
    align: "z",
    fit: "along",
  },
  // Authored bbox is very nearly a 2m cube, so `length` is really the whole
  // prop's size. 1.15 puts it in proportion on a 2.6m-wide bruiser roof.
  turret: {
    url: "/assets/meshes/weapons/SM_MeshGen_WastelandHeavyTurret.glb",
    length: 1.15,
    align: "x",
    fit: "along",
  },
  launcher: {
    url: "/assets/meshes/weapons/SM_MeshGen_ImprovisedQuadLauncher.glb",
    length: 1.1,
    align: "x",
    fit: "along",
  },
};

const cache = new Map<WeaponMeshId, THREE.BufferGeometry | null>();
const sizes = new Map<WeaponMeshId, THREE.Vector3>();
const pending = new Map<WeaponMeshId, Promise<THREE.BufferGeometry | null>>();

/**
 * Post-normalisation bounding size in metres, or null until the mesh loads.
 *
 * Exists so mount placement is MEASURED rather than hand-tuned: a prop sits on
 * a roof at `roofHeight + size.y * 0.5`, because loadWeaponGeometry centres
 * every asset on its own bounding box. The previous mounts were guessed
 * constants and buried the hardware inside the bodywork.
 */
export function weaponMeshSize(id: WeaponMeshId): THREE.Vector3 | null {
  return sizes.get(id) ?? null;
}

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
 * True when the +Z end of an already-aligned body is the FATTER one, i.e. the
 * asset is pointing backwards.
 *
 * Compares the widest cross-section in the outer 18% at each end. Extremities
 * rather than a centroid walk because a body's silhouette is what reads as a
 * nose, and 18% is wide enough to survive the sparse, unevenly sampled shells
 * these reconstructed meshes are made of.
 */
function pointsBackward(geo: THREE.BufferGeometry): boolean {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const lo = bb.min.z;
  const span = bb.max.z - lo;
  if (span < 1e-4) return false;
  const cut = span * 0.18;
  let rNeg = 0;
  let rPos = 0;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    if (z <= lo + cut) rNeg = Math.max(rNeg, r);
    else if (z >= lo + span - cut) rPos = Math.max(rPos, r);
  }
  return rPos > rNeg;
}

/**
 * White per-vertex colour so a `vertexColors` material multiplies by 1 instead
 * of by the missing-attribute default of (0,0,0). See the header: this is the
 * difference between an authored body rendering and rendering solid black.
 */
function addWhiteColors(geo: THREE.BufferGeometry): void {
  if (geo.getAttribute("color")) return;
  const count = geo.getAttribute("position").count;
  geo.setAttribute(
    "color",
    new THREE.BufferAttribute(new Float32Array(count * 3).fill(1), 3),
  );
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
    createGltfLoader().load(
      spec.url,
      (gltf) => {
        const geo = mergeToSingle(gltf.scene);
        if (!geo) {
          console.warn(`[weaponMeshes] ${id}: no mesh data in ${spec.url}`);
          cache.set(id, null);
          resolve(null);
          return;
        }
        // Rotate the chosen axis onto +Z, which is the axis lookAt aligns to
        // the velocity.
        if (spec.align === "x") geo.rotateY(Math.PI / 2);
        else if (spec.align === "y") geo.rotateX(-Math.PI / 2);

        geo.computeBoundingBox();
        const bb = geo.boundingBox!;
        const c = bb.getCenter(new THREE.Vector3());
        // Centre on the origin: an instance is positioned at the projectile's
        // centre, and an off-centre body would orbit it as the instance turns.
        // Also has to happen BEFORE the taper test, which measures radius about
        // the local axis.
        geo.translate(-c.x, -c.y, -c.z);
        // rotateY(PI) maps (x,y,z) -> (-x,y,-z), so a body already centred on
        // the origin stays centred and the size below is unaffected.
        if (spec.taper && pointsBackward(geo)) geo.rotateY(Math.PI);
        const size = bb.getSize(new THREE.Vector3());
        const ref =
          spec.fit === "along"
            ? Math.max(size.z, 1e-4)
            : Math.max(size.x, size.y, 1e-4);
        const s = spec.length / ref;
        geo.scale(s, s, s);
        // Normals were dropped by the spatial weld so they could be rebuilt from
        // the fused topology rather than averaged across shells that used to be
        // separate.
        geo.computeVertexNormals();
        addWhiteColors(geo);
        geo.computeBoundingSphere();
        geo.computeBoundingBox();
        sizes.set(id, geo.boundingBox!.getSize(new THREE.Vector3()));
        cache.set(id, geo);
        resolve(geo);
      },
      undefined,
      (err) => {
        // Loud, because the silent version of this failure is exactly what let
        // an entire weapon art set go missing for three rounds of "fixes": the
        // callers all have a placeholder, so nothing downstream ever complains.
        console.warn(`[weaponMeshes] ${id} failed to load ${spec.url}`, err);
        cache.set(id, null);
        resolve(null);
      },
    );
  });
  pending.set(id, p);
  return p;
}
