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
import { clonePbrPack, isPbrLibraryReady } from "../webgl2/textureLibrary";
import { getMaxAnisotropy } from "../webgl2/configure";
import { buildScatterFields } from "./fields";
import { packLayer, type ScatterLayerData, type TierScale } from "./layerData";
import { ScatterLayer } from "./ScatterLayer";
import { reportDensity, triCount } from "./stats";

function makeMaterials() {
  const q = qualityManager.get();
  const aniso = Math.min(getMaxAnisotropy(), q.anisotropy || 4);
  const ready = isPbrLibraryReady();

  // Cloned packs share their Source with the already-resident originals, so
  // this is a new sampler configuration rather than a second upload.
  const rockPack = ready ? clonePbrPack("rock", 1, 1) : null;
  const rustPack = ready ? clonePbrPack("rust", 1.4, 1.4) : null;
  for (const t of [rockPack?.map, rockPack?.normalMap, rustPack?.map]) {
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
    color: "#97815f",
    vertexColors: true,
    roughness: 0.95,
    metalness: 0.02,
    envMapIntensity: 0.7,
  });

  const scrub = new THREE.MeshStandardMaterial({
    color: "#c2a870",
    vertexColors: true,
    roughness: 0.97,
    metalness: 0,
    envMapIntensity: 0.5,
    // Blades are single triangles; without this a tuft vanishes from half the
    // angles you can look at it from.
    side: THREE.DoubleSide,
  });

  const drift = new THREE.MeshStandardMaterial({
    map: rustPack?.map ?? null,
    color: "#9d8a70",
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

  return (
    <group>
      <ScatterLayer
        data={built.layers[0]!}
        density={ROCK_DENSITY}
        range={WIDE_RANGE}
        phase={0}
      />
      <ScatterLayer
        data={built.layers[1]!}
        density={SCRUB_DENSITY}
        range={NEAR_RANGE}
        phase={1}
      />
      <ScatterLayer
        data={built.layers[2]!}
        density={DRIFT_DENSITY}
        range={NEAR_RANGE}
        phase={2}
      />
    </group>
  );
}
