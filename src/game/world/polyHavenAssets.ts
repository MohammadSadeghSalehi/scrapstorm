/**
 * Poly Haven CC0 asset catalog (1k glTF under /public/assets/meshes/polyhaven).
 * https://polyhaven.com/license
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export const PH_MODELS = {
  barrel: "/assets/meshes/polyhaven/Barrel_01/Barrel_01_1k.gltf",
  barrelAlt: "/assets/meshes/polyhaven/barrel_03/barrel_03_1k.gltf",
  crate: "/assets/meshes/polyhaven/plastic_crate_01/plastic_crate_01_1k.gltf",
  box: "/assets/meshes/polyhaven/cardboard_box_01/cardboard_box_01_1k.gltf",
  tyre: "/assets/meshes/polyhaven/old_tyre/old_tyre_1k.gltf",
  rim: "/assets/meshes/polyhaven/rusted_wheel_rim_01/rusted_wheel_rim_01_1k.gltf",
  jerrycan: "/assets/meshes/polyhaven/metal_jerrycan/metal_jerrycan_1k.gltf",
  barrier: "/assets/meshes/polyhaven/concrete_road_barrier/concrete_road_barrier_1k.gltf",
  coveredCar: "/assets/meshes/polyhaven/covered_car/covered_car_1k.gltf",
  trash: "/assets/meshes/polyhaven/metal_trash_can/metal_trash_can_1k.gltf",
  hydrant: "/assets/meshes/polyhaven/fire_hydrant/fire_hydrant_1k.gltf",
  boulder: "/assets/meshes/polyhaven/namaqualand_boulder_02/namaqualand_boulder_02_1k.gltf",
  fence: "/assets/meshes/polyhaven/modular_chainlink_fence/modular_chainlink_fence_1k.gltf",
  pipes: "/assets/meshes/polyhaven/modular_pipes/modular_pipes_1k.gltf",
} as const;

export type PhModelKey = keyof typeof PH_MODELS;

const templateCache = new Map<string, THREE.Group>();
const pending = new Map<string, Promise<THREE.Group>>();
const loader = new GLTFLoader();

function normalizeRoot(root: THREE.Object3D, targetLen: number) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = true;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      const sm = mat as THREE.MeshStandardMaterial;
      if (sm?.isMeshStandardMaterial) {
        sm.envMapIntensity = 1.15;
        sm.needsUpdate = true;
      }
    }
  });
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const len = Math.max(size.x, size.y, size.z, 0.01);
  root.scale.setScalar(targetLen / len);
  root.position.set(0, 0, 0);
  root.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(root);
  root.position.y -= box2.min.y;
}

/** Load a Poly Haven glTF template (cached), return a clone ready to place. */
export function loadPhModel(
  key: PhModelKey,
  targetLen = 1.2,
): Promise<THREE.Group> {
  const ck = `${key}|${targetLen.toFixed(2)}`;
  const tpl = templateCache.get(ck);
  if (tpl) return Promise.resolve(tpl.clone(true) as THREE.Group);

  let p = pending.get(ck);
  if (!p) {
    p = new Promise<THREE.Group>((resolve, reject) => {
      loader.load(
        PH_MODELS[key],
        (gltf) => {
          const root = gltf.scene;
          normalizeRoot(root, targetLen);
          templateCache.set(ck, root);
          pending.delete(ck);
          resolve(root);
        },
        undefined,
        (err) => {
          pending.delete(ck);
          reject(err);
        },
      );
    });
    pending.set(ck, p);
  }
  return p.then((root) => root.clone(true) as THREE.Group);
}

/** Minimal race-props only — no covered cars / boulders on boot. */
export function preloadPhRaceProps(): Promise<void> {
  const jobs: [PhModelKey, number][] = [
    ["barrel", 1.05],
    ["crate", 1.15],
    ["tyre", 0.95],
    ["barrier", 1.6],
  ];
  // Sequential-ish: start all but only essential set
  return Promise.all(
    jobs.map(([k, len]) => loadPhModel(k, len).catch(() => null)),
  ).then(() => undefined);
}

/** AmaraSpatial-10K (CC BY 4.0) — high-detail props for track dressing */
export const AMARA_MESH = {
  jersey:
    "/assets/meshes/amara/Urban_Props_Road_Barriers_SM_MeshGen_StandardConcreteJerseyBarrier.glb",
  waterBarrier:
    "/assets/meshes/amara/Urban_Props_Road_Barriers_SM_MeshGen_PlasticWaterfilledBarrier.glb",
  cone:
    "/assets/meshes/amara/Urban_Props_Traffic_Cones_SM_MeshGen_StandardReflectiveTrafficCone.glb",
} as const;
