/**
 * Procedural ground: one heightfield, six palettes.
 *
 * The SHAPE of the ground is the circuit's (dunes, rock mask, the carved road
 * corridor) and does not vary by environment — physics drives on it and the
 * height curve is shared with `duneProfile`. What varies is what it is MADE OF:
 * the elevation ramp, which material tiles over it, how rough and how reflective
 * it is, and whether the exposed-material colour belongs on the slopes or on the
 * flats. All of that comes from `getActiveEnvironment().terrain`.
 *
 * The heightfield itself is built by `terrainGeometry.ts` and cached there; this
 * component only dresses it. See that module for why the split exists — the
 * short version is that baking 148k vertices of fBm is three quarters of a
 * second of blocking work, and it used to happen on the word "three".
 */
import { useMemo } from "react";
import * as THREE from "three";
import { getTrackEpoch } from "../track";
import { qualityManager } from "./quality";
import { attachGpuDetail } from "./shaders/gpuDetail";
import { getMaxAnisotropy } from "./webgl2/configure";
import { clonePbrPack, preloadPbrLibrary } from "./webgl2/textureLibrary";
import { getActiveEnvironment } from "./environments";
import { buildTerrainSync, makeTerrainGeometry } from "./terrainGeometry";

export {
  buildTrackField,
  meshHeight,
  type TrackField,
} from "./terrainGeometry";

/**
 * Sampling resolution of the height field, by tier.
 *
 * This was 36/48/64 across a ~600-800m span — 10-16m per quad, two to four
 * times the length of a car. Every octave of sampleDuneField above the very
 * largest was aliased away, which is why the desert read as a handful of
 * enormous flat facets. At 256 the quads are ~2.5m, so the meso and ripple
 * octaves actually survive into the silhouette.
 *
 * Exported because the load screen has to bake the SAME field the mesh will ask
 * for. A mismatch here does not fail loudly — it just silently misses the cache
 * and pays the full build during the countdown, which is the exact bug this
 * whole path exists to remove.
 */
export function terrainSegmentsFor(tier: "low" | "medium" | "high"): number {
  return tier === "low" ? 128 : tier === "medium" ? 256 : 384;
}

export function HeightmapTerrain() {
  const tier = qualityManager.get().tier;
  const epoch = getTrackEpoch();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const env = useMemo(() => getActiveEnvironment(), [epoch]);
  const segs = terrainSegmentsFor(tier);

  const { geometry, material } = useMemo(() => {
    const t = env.terrain;
    /*
     * Normally a cache hit: `prepareRaceAssets` bakes this field behind the
     * loading screen before the world is allowed to mount. The synchronous
     * fallback is only reached when something jumps the queue — a QA hook, a
     * tier change mid-session — and then it behaves exactly as it always did.
     */
    const build = buildTerrainSync(segs, env, epoch);
    const geo = makeTerrainGeometry(build);

    // Prefer solid+vertexColor first; maps enhance when loaded
    const q = qualityManager.get();
    const mat = new THREE.MeshStandardMaterial({
      color: t.base,
      vertexColors: true,
      // Dry sand is not a mirror, but at 0.88 the dunes had no terminator
      // sheen at all — they lit like flat paper. 0.82 is enough for the crests
      // to catch the low sun without turning the desert glossy; slag and
      // hardpan sit higher still.
      roughness: t.roughness,
      metalness: t.metalness,
      envMapIntensity: t.envMapIntensity,
      // Set here, not only in the map callback, so the value is correct no
      // matter which map resolves first.
      normalScale: new THREE.Vector2(t.normalScale, t.normalScale),
      /*
       * Ground that is itself hot (cooling slag, a bowl that has not finished
       * burning). Emissive is NOT multiplied by vertex colour in three.js, so
       * this lifts the entire surface uniformly — it reads as the ground
       * refusing to go fully black rather than as glowing veins, and anything
       * above ~0.2 stops reading as heat and starts reading as fog.
       */
      emissive: new THREE.Color(t.emissive),
      emissiveIntensity: t.emissiveIntensity,
    });

    /**
     * Second, finer detail layer — near the camera only.
     *
     * One 7m sand tile is unmistakably *one tile* from inside a car: the same
     * ripple repeats every couple of car lengths and the ground reads as flat
     * wallpaper. attachGpuDetail lays non-repeating fBm over albedo, roughness
     * and (band 3 only) the normal, at roughly half the wavelength of the
     * photo tile, which breaks the seam exactly where it is visible.
     *
     * It is cheap because it is distance-banded: full detail inside lodNear
     * (20m on high), reduced to a single value-noise tap by lodMid, and
     * skipped entirely past lodFar — so the 700m dune field beyond the near
     * band pays only a compare. Low tier runs gpuDetail at 0 and is skipped.
     */
    /*
     * DISABLED pending a measurement on real hardware.
     *
     * This was the one item in the surface pass with a real per-fragment cost
     * (estimated 1-3%), and the terrain plane covers most of the frame. It went
     * in as part of a batch that measured 102fps -> 14fps on a laptop 5080, and
     * an estimate made without profiling is not evidence. Re-enable only with a
     * before/after fps number on the target machine.
     */
    const TERRAIN_DETAIL = false;
    if (TERRAIN_DETAIL && q.gpuDetail > 0.15) {
      attachGpuDetail(mat, { kind: "sand", detailScale: 16, quality: q });
    }

    /*
     * Maps come from the shared PBR library, not from a private TextureLoader.
     *
     * This used to fetch /assets/textures/sand/* directly, which meant the
     * terrain uploaded a SECOND copy of a pack the library already had resident
     * — and, more to the point, it hardcoded which pack. It also cannot survive
     * an environment choosing `rock` or `dirt`, because those packs ship their
     * normal map as nor.jpg while sand ships nor_gl.jpg; the direct URL would
     * 404 on exactly the circuits that most needed a different ground.
     *
     * Awaiting the preload promise rather than testing isPbrLibraryReady() is
     * load-bearing: that predicate goes true once the four CRITICAL packs land,
     * and `rock` and `gravel` are not among them. Testing it would silently
     * leave the Foundry and the Mile untextured — the failure mode that already
     * caught the ridge material out once.
     *
     * Still a `.then` and not an await at the call site even though the loading
     * screen now holds the grid until the library is resident: the library is
     * warm by the time this mounts, so the promise resolves on the microtask
     * queue and the swap lands before the first frame is drawn. Keeping it
     * asynchronous is what lets the mesh mount at all on the paths that skip the
     * loading screen.
     *
     * Tiling comes entirely from the baked world-space UVs above, so the clone
     * keeps a 1:1 repeat.
     */
    void preloadPbrLibrary().then(() => {
      const pack = clonePbrPack(t.pack, 1, 1);
      if (!pack) return;
      // The UVs run to hundreds of metres, so grazing-angle sampling is the
      // whole game here — this is the one place anisotropy actually buys
      // sharpness on the terrain. Read the cap now rather than at build time:
      // the renderer may not have been configured when the mesh was built, and
      // getMaxAnisotropy() still reports its conservative default then.
      const aniso = Math.min(
        getMaxAnisotropy(),
        qualityManager.get().anisotropy || 8,
      );
      for (const tex of [pack.map, pack.normalMap, pack.roughnessMap, pack.aoMap]) {
        if (!tex) continue;
        tex.anisotropy = aniso;
        tex.needsUpdate = true;
      }
      mat.map = pack.map;
      mat.normalMap = pack.normalMap;
      mat.roughnessMap = pack.roughnessMap;
      if (pack.aoMap) {
        mat.aoMap = pack.aoMap;
        mat.aoMapIntensity = 1.1;
      }
      mat.needsUpdate = true;
    });

    return { geometry: geo, material: mat };
  }, [segs, env, epoch]);

  return (
    <mesh geometry={geometry} material={material} receiveShadow frustumCulled={false} />
  );
}
