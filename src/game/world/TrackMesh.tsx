import { useMemo } from "react";
import * as THREE from "three";
// Accessors, not the `export let` bindings — see terrainGeometry.ts.
import { getEdgeMarkers, getTrackEpoch, getTrackSamples } from "../track";
import { createProcMaterial } from "./procmat";
import { qualityManager } from "./quality";
import { HeightmapTerrain } from "./HeightmapTerrain";
import {
  clonePbrPack,
  isPbrLibraryReady,
  preloadPbrLibrary,
  type PbrPackId,
} from "./webgl2/textureLibrary";
import { getTerrainProfile, type TerrainProfile } from "./terrainProfiles";
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
import {
  RoadsideFurniture,
  RoadsideLighting,
  ScatterField,
  VergeDrift,
} from "./scatter";
import { Setpieces } from "./setpieces";
import { CarrierRigs } from "./CarrierRig";
import { TunnelBores } from "./TunnelBores";
import { getActiveEnvironment } from "./environments";
import type { SurfaceDef } from "./environments";

/*
 * ON TEXTURE REPEATS HERE — read before changing one.
 *
 * The ribbon's UVs are normalised, not world-scaled: u runs 0..1 over the whole
 * circuit and v runs 0..1 across the tarmac (see roadSegments.pushQuad). A
 * texture repeat of 0.2 therefore stretched a single tile over ~900m of road,
 * so every high frequency in the normal and roughness maps averaged out to a
 * constant — which is exactly why the road read as one flat grey band with no
 * highlight anywhere. Deriving the repeat from real track metres restores the
 * texel density the packs were authored at, and costs nothing per frame: it is
 * the same number of fetches, just at a different mip level.
 *
 * Now per-circuit (`terrainProfiles.ts`), because tile size is half of what
 * says which material this is: slab concrete is cast in bays several metres
 * across and asphalt aggregate is centimetres, so the same photo at the same
 * tiling reads as the same road however it is tinted.
 */

/** Mirrors `apronW` in culling/roadSegments.ts — the apron strip is 5.5m wide. */
const APRON_WIDTH_M = 5.5;

/**
 * Point a material at a PBR pack, or report that the pack is not resident yet.
 *
 * WHY THE RETURN VALUE MATTERS. `isPbrLibraryReady()` goes true when the four
 * CRITICAL packs land — asphalt, sand, dirt, metal. `concrete`, `gravel`,
 * `rock` and `rust` are DEFERRED and arrive up to a second later. Every call
 * site here used to gate on that predicate and then ask for a deferred pack, so
 * `clonePbrPack` returned null and the surface silently fell back: the gravel
 * apron became dirt, the rock yard became procedural noise. Nothing logged,
 * nothing looked broken, and the two circuits that most needed a distinct
 * ground were exactly the two that never got one.
 *
 * The fix is HeightmapTerrain's, which already hit this: apply what is resident
 * now, then re-apply behind `preloadPbrLibrary()` once the whole library is in.
 */
function applyPack(
  mat: THREE.MeshStandardMaterial,
  id: PbrPackId,
  repeatU: number,
  repeatV: number,
  opts: { aoIntensity?: number; normalOnLow?: boolean } = {},
): boolean {
  const pack = clonePbrPack(id, repeatU, repeatV);
  if (!pack) return false;
  const q = qualityManager.get();
  const aniso = Math.min(getMaxAnisotropy(), q.anisotropy || 8);
  for (const t of [pack.map, pack.normalMap, pack.roughnessMap, pack.aoMap]) {
    if (!t) continue;
    t.anisotropy = aniso;
    t.needsUpdate = true;
  }
  const wantNormal = q.tier !== "low" || opts.normalOnLow === true;
  mat.map = pack.map;
  mat.roughnessMap = pack.roughnessMap;
  mat.normalMap = wantNormal ? pack.normalMap : null;
  mat.aoMap = q.tier !== "low" ? pack.aoMap : null;
  if (mat.aoMap) mat.aoMapIntensity = opts.aoIntensity ?? 1.1;
  mat.needsUpdate = true;
  return true;
}

/**
 * Apply the circuit's pack now if it is loaded, and again when it lands.
 *
 * `epoch` is captured, not read at resolve time: the promise can settle after
 * the player has already changed circuit, and dressing a disposed Ash Spire
 * road with the Foundry's concrete is both wasted work and a way to get one
 * frame of the wrong surface if the material happens to be shared.
 */
function applyPackWhenReady(
  mat: THREE.MeshStandardMaterial,
  id: PbrPackId,
  repeatU: number,
  repeatV: number,
  epoch: number,
  opts: { aoIntensity?: number; normalOnLow?: boolean } = {},
): boolean {
  if (applyPack(mat, id, repeatU, repeatV, opts)) return true;
  void preloadPbrLibrary().then(() => {
    if (getTrackEpoch() !== epoch) return;
    applyPack(mat, id, repeatU, repeatV, opts);
  });
  return false;
}

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

/**
 * Hazard-zone yard fill.
 *
 * Tinted per environment for the same reason as everything else here: the
 * surfaces immediately beside the road are the largest continuous areas in the
 * frame after the sky, and leaving them desert-tan under a night sky is the
 * single most obvious way for a re-lit circuit to still read as the desert.
 */
function makeYardMaterial(
  surfaces: SurfaceDef,
  prof: TerrainProfile,
  epoch: number,
): THREE.MeshStandardMaterial {
  const q = qualityManager.get();
  const mat = new THREE.MeshStandardMaterial({
    color: surfaces.yard,
    roughness: 0.92,
    metalness: 0.02,
    normalScale: new THREE.Vector2(0.95, 0.95),
    envMapIntensity: 0.45,
  });
  const r = prof.yardRepeat;
  if (
    !applyPackWhenReady(mat, prof.yardPack, r, r, epoch, { aoIntensity: 1.05 })
  ) {
    /*
     * A procedural stand-in for the frame or two before the pack lands. It is
     * NOT the final look and must not be left as one: `dirt` is a critical pack
     * so the recipe is always available, whereas the yard's real pack (rock on
     * the dune circuits, rust in the scrapyards) is deferred.
     */
    const tmp = createProcMaterial("dirt", {
      repeat: [r, r],
      color: surfaces.yard,
      normalScale: 0.45,
      ao: false,
      gpuDetail: false,
    });
    mat.map = tmp.map;
    mat.normalMap = tmp.normalMap;
    mat.roughnessMap = tmp.roughnessMap;
  }
  if (q.gpuDetail > 0.2) {
    attachGpuDetail(mat, { kind: "dirt", detailScale: 9, quality: q });
  }
  return mat;
}

export function TrackMesh({ trackEpoch }: { trackEpoch?: number }) {
  const tier = qualityManager.get().tier;
  const pbrKey = isPbrLibraryReady() ? "pbr" : "proc";
  const epoch = trackEpoch ?? getTrackEpoch();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const surfaces = useMemo(() => getActiveEnvironment().surfaces, [epoch]);

  const ribbon = useMemo(() => {
    const result = buildTrackRibbon(getTrackSamples().slice());
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
    const track = trackMetrics(getTrackSamples());
    /*
     * Which MATERIAL each surface is, per circuit. Colour still comes from the
     * environment — that is the split: `surfaces` tints, `prof` decides what is
     * being tinted. A slag haul road and a sand-scoured desert road are not the
     * same photo at two exposures, and the tile size, roughness and normal
     * strength are what say so.
     */
    const prof = getTerrainProfile();

    const roadRepeatU = track.length / prof.roadTileM;
    const roadRepeatV = track.width / prof.roadTileM;

    const road = new THREE.MeshStandardMaterial({
      color: surfaces.road,
      // Dry tarmac still has a specular lobe. At 0.82 the road was matte at
      // every sun angle; the roughness map supplies the variation on top of
      // this and attachRoadWear pulls the wheel grooves far lower still. The
      // value is per-circuit now: ash-scoured asphalt has lost its lobe and
      // poured slab never had asphalt's in the first place.
      roughness: prof.roadRoughness,
      metalness: prof.roadMetalness,
      vertexColors: true,
      // At real tiling the normal map carries the aggregate, so hold it near 1
      // or the surface boils at speed. Broken asphalt goes above it; ash-filled
      // asphalt and smooth slab go well below.
      normalScale: new THREE.Vector2(prof.roadNormalScale, prof.roadNormalScale),
      envMapIntensity: 0.9,
    });
    /*
     * The road keeps its normal map even on the low tier. It is the surface
     * that fills the frame and the one the wear shader writes against; dropping
     * it there was never the low tier's saving, the terrain and scatter were.
     */
    const roadReady = applyPackWhenReady(
      road,
      prof.roadPack,
      roadRepeatU,
      roadRepeatV,
      epoch,
      { aoIntensity: 1.15, normalOnLow: true },
    );
    if (!roadReady) {
      // Asphalt is a CRITICAL pack and a procedural recipe, so there is always
      // something to stand in with while a concrete road is still in flight.
      if (!applyPack(road, "asphalt", roadRepeatU, roadRepeatV, {
        aoIntensity: 1.15,
        normalOnLow: true,
      })) {
        const tmp = createProcMaterial("asphalt", {
          repeat: [roadRepeatU, roadRepeatV],
          color: surfaces.road,
          normalScale: 0.55,
          ao: true,
          gpuDetail: false,
        });
        road.map = tmp.map;
        road.normalMap = tmp.normalMap;
        road.roughnessMap = tmp.roughnessMap;
      }
    }
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

    let apron: THREE.MeshStandardMaterial;
    {
      // Same normalised-UV story as the road: the apron's v spans its 5.5m
      // width, so its repeat has to be derived from metres too or the gravel
      // is one smeared tile the length of the circuit.
      const apronRepeatU = track.length / prof.apronTileM;
      const apronRepeatV = APRON_WIDTH_M / prof.apronTileM;
      apron = new THREE.MeshStandardMaterial({
        color: surfaces.apron,
        roughness: 0.9,
        metalness: 0.04,
        vertexColors: true,
        envMapIntensity: 0.55,
      });
      if (
        !applyPackWhenReady(apron, prof.apronPack, apronRepeatU, apronRepeatV, epoch)
      ) {
        const tmp = createProcMaterial("dirt", {
          repeat: [apronRepeatU, apronRepeatV],
          color: surfaces.apron,
          normalScale: 0.5,
          ao: true,
          gpuDetail: false,
        });
        apron.map = tmp.map;
        apron.normalMap = tmp.normalMap;
        apron.roughnessMap = tmp.roughnessMap;
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
        color: surfaces.sand,
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
        color: surfaces.sand,
      });
    }

    return {
      road,
      apron,
      sand,
      yard: makeYardMaterial(surfaces, prof, epoch),
      // toneMapped stays false: lane paint is a reference white and should not
      // be pulled around by the exposure curve. It is still tinted per
      // environment — paint under a sodium furnace is not paint at noon.
      stripe: new THREE.MeshBasicMaterial({
        color: surfaces.stripe,
        toneMapped: false,
      }),
    };
  }, [tier, pbrKey, surfaces, epoch]);

  const markers = useMemo(() => getEdgeMarkers().slice(), [epoch]);

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

      {/*
        Set pieces that own a piece of the ground or the sky above it. Two draw
        calls at the low tier and three above it, on the circuits that have
        them: a merged tunnel bore (+1 more for its strip lights above low), and
        a merged car carrier. Both take their geometry from the same modules the
        physics reads — `world/tunnels.ts` and `world/carrier.ts` — so the wall
        you hit and the deck you climb cannot be a different shape from the ones
        you can see.

        The start gantry moved to GameScene: its light tree needs the countdown,
        and TrackMesh is deliberately not handed the sim.
      */}
      <TunnelBores trackEpoch={epoch} />
      <CarrierRigs trackEpoch={epoch} />

      <CulledEdgePosts markers={markers} />
      <CulledBeacons />
      <CullableScenery />
      <GltfDebris />

      {/*
        World density (punch list §1.2). Ten draw calls between them at the high
        tier: four instanced desert fields (rock, scrub, scrap drift, cactus),
        guard rail, sponsor hoardings, chevron boards, lamp columns, the
        catenary between them, the lamps' additive glow, and the sand drift that
        ties the tarmac edge into the sand. Mounted last so the blended drift
        sorts after the opaque road it sits on.

        The low tier draws exactly one of the new ones — the lamp columns, which
        are the only new family with a collider and therefore the only one that
        cannot be thinned away without leaving something solid and invisible.
        See RoadsideLighting for the argument.
      */}
      <ScatterField />
      <RoadsideFurniture />
      <RoadsideLighting />

      {/*
        Per-circuit built structure — the thing that makes a circuit a place
        rather than a palette. 0-4 additional draw calls depending on the
        circuit (Ash Spire is deliberately zero; see setpieces/presets.ts),
        instanced and culled per instance by the same machinery above.
      */}
      <Setpieces />

      <VergeDrift />
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
