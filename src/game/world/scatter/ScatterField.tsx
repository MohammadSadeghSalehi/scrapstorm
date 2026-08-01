/**
 * Desert scatter — rocks, dry scrub and wind-drifted scrap.
 *
 * Three InstancedMeshes, three draw calls, ~3,600 instances at the high tier.
 * Density and draw distance both scale by quality tier, but THE FIELD ITSELF IS
 * BUILT ONCE and is tier-independent: dropping a tier draws a shorter prefix of
 * the same shuffled list. Rebuilding placement on a tier change would put a
 * multi-millisecond stall in the middle of a race, which is precisely the
 * failure mode §0 of the punch list is chasing.
 *
 * Nothing here casts a shadow. Thousands of shadow-map instances is not a trade
 * worth making against a 16.7ms budget that is currently unmeasured, so contact
 * darkening is baked into the vertex colours (see geometry.ts) and every
 * instance is partly buried instead. If the shadow pass ever has headroom, the
 * rock layer is the one to promote — largest, closest, most missed.
 *
 * Placement and sizing live in fields.ts, which has no renderer dependency and
 * can therefore be run and asserted headlessly.
 */
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { getTrackEpoch } from "../../track";
import { qualityManager } from "../quality";
import { getActiveEnvironment } from "../environments";
import { clonePbrPack, isPbrLibraryReady } from "../webgl2/textureLibrary";
import { getMaxAnisotropy } from "../webgl2/configure";
import { registerRockColliders } from "../../setpieceColliders";
import { buildScatterFields } from "./fields";
import { packLayer, type ScatterLayerData, type TierScale } from "./layerData";
import { ScatterLayer } from "./ScatterLayer";
import { reportDensity, triCount } from "./stats";

function makeMaterials() {
  const q = qualityManager.get();
  const aniso = Math.min(getMaxAnisotropy(), q.anisotropy || 4);
  const ready = isPbrLibraryReady();
  const env = getActiveEnvironment().scatter;

  // Cloned packs share their Source with the already-resident originals, so
  // this is a new sampler configuration rather than a second upload — which is
  // also why letting the environment pick a different pack per circuit costs
  // nothing beyond the one upload that pack already pays for elsewhere.
  const rockPack = ready ? clonePbrPack(env.rockPack, 1, 1) : null;
  const driftPack = ready ? clonePbrPack(env.driftPack, 1.4, 1.4) : null;
  for (const t of [rockPack?.map, rockPack?.normalMap, driftPack?.map]) {
    if (t) {
      t.anisotropy = aniso;
      t.needsUpdate = true;
    }
  }

  const rock = new THREE.MeshStandardMaterial({
    map: rockPack?.map ?? null,
    // Normal map on the high tier only: these are 20-triangle rocks covering a
    // few dozen pixels each across a couple of thousand instances, and the
    // extra fetch is the wrong place to spend fill rate below that tier.
    normalMap: q.tier === "high" ? (rockPack?.normalMap ?? null) : null,
    color: env.rock.color,
    vertexColors: true,
    roughness: 0.95,
    metalness: 0.02,
    envMapIntensity: 0.7,
  });

  const scrub = new THREE.MeshStandardMaterial({
    color: env.scrub.color,
    vertexColors: true,
    roughness: 0.97,
    metalness: 0,
    envMapIntensity: 0.5,
    // Blades are single triangles; without this a tuft vanishes from half the
    // angles you can look at it from.
    side: THREE.DoubleSide,
  });

  const drift = new THREE.MeshStandardMaterial({
    map: driftPack?.map ?? null,
    color: env.drift.color,
    vertexColors: true,
    roughness: 0.74,
    metalness: 0.28,
    envMapIntensity: 0.75,
    side: THREE.DoubleSide,
  });

  return { rock, scrub, drift };
}

/** Tier fractions, applied as a prefix of each shuffled field. */
const ROCK_DENSITY: TierScale = { low: 0.24, medium: 0.55, high: 1 };
const SCRUB_DENSITY: TierScale = { low: 0.16, medium: 0.44, high: 1 };
const DRIFT_DENSITY: TierScale = { low: 0.15, medium: 0.42, high: 1 };
/** Draw-distance multipliers. The cheapest triangle is the one not submitted. */
const NEAR_RANGE: TierScale = { low: 0.5, medium: 0.74, high: 1 };
const WIDE_RANGE: TierScale = { low: 0.55, medium: 0.8, high: 1 };

function buildLayers(): { layers: ScatterLayerData[]; dispose: () => void } {
  const mats = makeMaterials();
  const fields = buildScatterFields();
  /*
   * Hand the boulders to the collision layer.
   *
   * Done from here rather than derived in setpieceColliders because that module
   * is deliberately renderer-free — importing three there would pull the
   * renderer into the sim graph that mission-smoke drives headlessly. Passing
   * the instances that were actually drawn also means the solid thing and the
   * visible thing cannot drift apart, which re-deriving from a shared seed
   * eventually would.
   *
   * Reported as ghosts: a car-sized outcrop you drive straight through. Gravel
   * stays decoration — see ROCK_MIN_RADIUS.
   */
  registerRockColliders(fields.rock);
  const layers = [
    packLayer({
      geometry: fields.geometries.rock,
      material: mats.rock,
      items: fields.rock,
    }),
    packLayer({
      geometry: fields.geometries.scrub,
      material: mats.scrub,
      items: fields.scrub,
    }),
    packLayer({
      geometry: fields.geometries.drift,
      material: mats.drift,
      items: fields.drift,
    }),
  ];
  return {
    layers,
    dispose: () => {
      for (const g of Object.values(fields.geometries)) g.dispose();
      for (const m of Object.values(mats)) m.dispose();
    },
  };
}

export function ScatterField() {
  const epoch = getTrackEpoch();
  // Rebuilt only when the circuit itself changes. Deliberately NOT keyed on
  // tier — see the note at the top of the file.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const built = useMemo(() => buildLayers(), [epoch]);

  useEffect(() => {
    const names = ["rock", "scrub", "scrapDrift"];
    for (let i = 0; i < built.layers.length; i++) {
      const l = built.layers[i]!;
      reportDensity(names[i]!, 1, l.total, l.total * triCount(l.geometry));
    }
    return built.dispose;
  }, [built]);

  /*
   * An empty layer is not mounted at all.
   *
   * An environment can set a layer's density to 0 — nothing grows in a slag pit
   * — and an InstancedMesh with a count of zero is still an object in the
   * graph, still traversed, still culled, still a draw call's worth of state
   * setup for nothing.
   */
  const layers: [ScatterLayerData, TierScale, TierScale][] = [
    [built.layers[0]!, ROCK_DENSITY, WIDE_RANGE],
    [built.layers[1]!, SCRUB_DENSITY, NEAR_RANGE],
    [built.layers[2]!, DRIFT_DENSITY, NEAR_RANGE],
  ];

  return (
    <group>
      {layers.map(([data, density, range], i) =>
        data.total > 0 ? (
          <ScatterLayer
            key={i}
            data={data}
            density={density}
            range={range}
            phase={i}
          />
        ) : null,
      )}
    </group>
  );
}
