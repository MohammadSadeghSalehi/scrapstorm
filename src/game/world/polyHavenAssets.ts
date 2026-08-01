/**
 * Poly Haven CC0 asset catalog (1k glTF under /public/assets/meshes/polyhaven).
 * https://polyhaven.com/license
 */
import * as THREE from "three";
import { createGltfLoader } from "./gltfLoaders";

/**
 * Candidate URLs per prop, tried in order. The canonical Poly Haven 1k path
 * comes first; later entries are equivalent assets that already ship in
 * `public/assets/meshes` under a different layout. Listing both means the set
 * dressing works before the Poly Haven pack is restored and automatically
 * upgrades to the full-quality asset once it is.
 */
export const PH_MODELS = {
  barrel: [
    "/assets/meshes/polyhaven/Barrel_01/Barrel_01_1k.gltf",
    "/assets/meshes/barrel_ph/Barrel_01.gltf",
  ],
  barrelAlt: [
    "/assets/meshes/polyhaven/barrel_03/barrel_03_1k.gltf",
    "/assets/meshes/barrel_ph/barrel.glb",
  ],
  crate: ["/assets/meshes/polyhaven/plastic_crate_01/plastic_crate_01_1k.gltf"],
  box: ["/assets/meshes/polyhaven/cardboard_box_01/cardboard_box_01_1k.gltf"],
  tyre: [
    "/assets/meshes/polyhaven/old_tyre/old_tyre_1k.gltf",
    "/assets/meshes/kenney/debris-tire.glb",
  ],
  rim: [
    "/assets/meshes/polyhaven/rusted_wheel_rim_01/rusted_wheel_rim_01_1k.gltf",
    "/assets/meshes/kenney/wheel-dark.glb",
  ],
  jerrycan: ["/assets/meshes/polyhaven/metal_jerrycan/metal_jerrycan_1k.gltf"],
  barrier: [
    "/assets/meshes/polyhaven/concrete_road_barrier/concrete_road_barrier_1k.gltf",
  ],
  coveredCar: [
    "/assets/meshes/polyhaven/covered_car/covered_car_1k.gltf",
    "/assets/meshes/cars/covered_car/covered_car.gltf",
  ],
  trash: ["/assets/meshes/polyhaven/metal_trash_can/metal_trash_can_1k.gltf"],
  hydrant: ["/assets/meshes/polyhaven/fire_hydrant/fire_hydrant_1k.gltf"],
  boulder: [
    "/assets/meshes/polyhaven/namaqualand_boulder_02/namaqualand_boulder_02_1k.gltf",
  ],
  fence: [
    "/assets/meshes/polyhaven/modular_chainlink_fence/modular_chainlink_fence_1k.gltf",
  ],
  pipes: ["/assets/meshes/polyhaven/modular_pipes/modular_pipes_1k.gltf"],

  /*
   * Refinery skyline set — the background scenery in CullableScenery. Fetched
   * by `node scripts/fetch-polyhaven.mjs`; slugs verified against the Poly
   * Haven assets API (the intuitive names like shipping_container / water_tower
   * do not exist there).
   *
   * `gantry` and `pipeRig` are multi-part *kits*, not single props — consumers
   * must pick the mesh they want by node name rather than instancing the whole
   * template, or one prop costs a draw call per loose part.
   */
  gantry: ["/assets/meshes/polyhaven/overhead_crane/overhead_crane_1k.gltf"],
  tank: ["/assets/meshes/polyhaven/propane_tank/propane_tank_1k.gltf"],
  pipeRig: [
    "/assets/meshes/polyhaven/modular_industrial_pipes_01/modular_industrial_pipes_01_1k.gltf",
  ],
  rack: ["/assets/meshes/polyhaven/worn_metal_rack/worn_metal_rack_1k.gltf"],
} as const;

export type PhModelKey = keyof typeof PH_MODELS;

const templateCache = new Map<string, THREE.Group>();
const pending = new Map<string, Promise<THREE.Group>>();
/**
 * Keys whose every candidate 404'd. Set dressing asks for the same key across
 * dozens of decor slots and re-runs on every tier change, so without this the
 * misses turn into a request storm (~78 per load with the pack absent).
 */
const unavailable = new Set<PhModelKey>();
const resolvedUrl = new Map<PhModelKey, string>();
const loader = createGltfLoader();

/**
 * One fetch and one glTF parse per KEY, independent of how many sizes are asked
 * for.
 *
 * `templateCache` is keyed by `key|targetLen`, which is correct — the normalise
 * pass bakes the scale into the root — but it meant a key requested at three
 * lengths was downloaded and parsed three times. That is not hypothetical:
 * `buildDecorList` asks for coveredCar at 4.4, 4.6 AND 4.2, and boulder at 2.2,
 * 2.6, 2.8 and 3.0. Six redundant parses of some of the largest assets in the
 * game, on a dev server that serves them over HTTP/1.1 with six connections.
 *
 * The browser's HTTP cache already deduplicated the bytes; what this removes is
 * the parse, the geometry duplication and the second and third texture upload.
 */
const rawTemplates = new Map<PhModelKey, Promise<THREE.Group>>();

function rawTemplate(key: PhModelKey): Promise<THREE.Group> {
  let p = rawTemplates.get(key);
  if (!p) {
    p = loadFirstAvailable(key).catch((err) => {
      // Not remembered as a rejected promise: `unavailable` is what stops the
      // retry storm, and a cached rejection would also deny a later attempt
      // after the pack is restored without a reload.
      rawTemplates.delete(key);
      throw err;
    });
    rawTemplates.set(key, p);
  }
  return p;
}

/**
 * Deep clone that also clones MATERIALS.
 *
 * `Object3D.clone(true)` copies the hierarchy but shares geometry and material
 * references. Sharing geometry across size variants is exactly what we want;
 * sharing materials is not, because every consumer of a template used to get a
 * material private to its size variant and some of them tint or damage it in
 * place. Cloning the material preserves that isolation while still sharing the
 * textures, which are the part that costs VRAM.
 */
function cloneWithOwnMaterials(root: THREE.Group): THREE.Group {
  const copy = root.clone(true) as THREE.Group;
  const seen = new Map<THREE.Material, THREE.Material>();
  copy.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.material) return;
    if (Array.isArray(m.material)) {
      m.material = m.material.map((mat) => {
        let c = seen.get(mat);
        if (!c) seen.set(mat, (c = mat.clone()));
        return c;
      });
    } else {
      let c = seen.get(m.material);
      if (!c) seen.set(m.material, (c = m.material.clone()));
      m.material = c;
    }
  });
  return copy;
}

/** First candidate that loads; remembered so later slots skip the misses. */
function loadFirstAvailable(key: PhModelKey): Promise<THREE.Group> {
  const known = resolvedUrl.get(key);
  const urls = known ? [known] : [...PH_MODELS[key]];
  const attempt = (i: number): Promise<THREE.Group> =>
    new Promise<THREE.Group>((resolve, reject) => {
      loader.load(
        urls[i],
        (gltf) => {
          resolvedUrl.set(key, urls[i]);
          resolve(gltf.scene);
        },
        undefined,
        reject,
      );
    }).catch((err) => {
      if (i + 1 < urls.length) return attempt(i + 1);
      unavailable.add(key);
      throw err;
    });
  return attempt(0);
}

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
  if (unavailable.has(key)) {
    return Promise.reject(new Error(`ph model unavailable: ${key}`));
  }
  const ck = `${key}|${targetLen.toFixed(2)}`;
  const tpl = templateCache.get(ck);
  if (tpl) return Promise.resolve(tpl.clone(true) as THREE.Group);

  let p = pending.get(ck);
  if (!p) {
    p = rawTemplate(key)
      .then((raw) => {
        // Normalise a COPY: the raw template is shared by every size variant of
        // this key, and normalizeRoot rescales and re-seats the root in place.
        const root = cloneWithOwnMaterials(raw);
        normalizeRoot(root, targetLen);
        templateCache.set(ck, root);
        pending.delete(ck);
        return root;
      })
      .catch((err) => {
        pending.delete(ck);
        throw err;
      });
    pending.set(ck, p);
  }
  return p.then((root) => root.clone(true) as THREE.Group);
}

/**
 * Normalisation length used for every skyline template, shared with
 * CullableScenery so a template is fetched, normalised and cached exactly once.
 *
 * `templateCache` is keyed by `${key}|${targetLen}`, so asking for the same
 * model at two lengths costs a second fetch, parse and geometry upload. Only
 * `gantry` is placed at its normalised size (it is assembled from several
 * meshes, so the relative transforms have to survive); the rest are rescaled
 * from their own bounding box at placement time, which makes their number here
 * arbitrary — `barrel` deliberately matches preloadPhRaceProps so the drums in
 * a scrap pile reuse the race-prop template instead of loading a second copy.
 */
export const SCENERY_TEMPLATE_LEN = {
  gantry: 18,
  tank: 3,
  pipeRig: 2,
  rack: 2,
  barrel: 1.05,
} as const satisfies Partial<Record<PhModelKey, number>>;

/**
 * Warm every template SceneryDecor and CullableScenery place, so set dressing
 * is resident before the countdown instead of popping in over the opening lap.
 *
 * Deliberately broader than preloadPhRaceProps (which only covers the four
 * race-critical props) and tolerant of misses — an unavailable key should not
 * hold up the grid.
 */
export function preloadSceneryModels(
  extra: readonly (readonly [PhModelKey, number])[] = [],
): Promise<void> {
  const jobs: (readonly [PhModelKey, number])[] = [
    ["coveredCar", 4.4],
    ["barrier", 1.8],
    ["boulder", 2.2],
    ["trash", 1.15],
    ["hydrant", 0.95],
    ["tyre", 1.0],
    ["rim", 0.9],
    ["pipes", 6],
    ["fence", 4],
    ...(Object.entries(SCENERY_TEMPLATE_LEN) as [PhModelKey, number][]),
    /*
     * `extra` is how the loader hands over the sizes SceneryDecor will actually
     * ask for, derived from buildDecorList rather than copied here.
     *
     * The list above was written by hand and had already drifted: decor asks for
     * coveredCar at 4.6 and 4.2 as well as 4.4, barrier at 1.7 as well as 1.8,
     * and boulder at 2.6, 2.8 and 3.0 as well as 2.2. Because the template cache
     * is keyed by size, every one of those was an unwarmed load that landed
     * mid-lap — visibly, as props fading in on the opening straight. Deriving
     * them is what stops that list drifting again the next time the decor
     * placement is tuned.
     */
    ...extra,
  ];
  // De-duplicate: buildDecorList repeats most sizes across dozens of slots, and
  // loadPhModel would coalesce them anyway, but not before allocating a promise
  // and a catch handler per slot.
  const seen = new Set<string>();
  const unique = jobs.filter(([k, len]) => {
    const ck = `${k}|${len.toFixed(2)}`;
    if (seen.has(ck)) return false;
    seen.add(ck);
    return true;
  });
  return Promise.all(
    unique.map(([k, len]) => loadPhModel(k, len).catch(() => null)),
  ).then(() => undefined);
}

/** Keys with no loadable candidate this session (QA + set-dressing density). */
export function unavailablePhKeys(): PhModelKey[] {
  return [...unavailable];
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
