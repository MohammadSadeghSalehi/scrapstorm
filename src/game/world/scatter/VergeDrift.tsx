/**
 * Sand drift creeping over the tarmac edge.
 *
 * The road already has wear (shaders/roadWear.ts) and the desert already has
 * dunes; what was missing is the TRANSITION. Tarmac that ends in a dead
 * straight line against sand is the single clearest tell that the road was
 * placed on the terrain rather than built into it.
 *
 * One geometry, one draw call, ~2.2k triangles for the whole circuit. It is a
 * blended decal, so it costs fill rate rather than geometry: two narrow bands
 * hugging each tarmac edge, alpha 0 where they start on the asphalt and near
 * opaque by the time they reach the gravel. `depthWrite` stays off — the drift
 * must never occlude anything, it is paint on a surface that already exists.
 *
 * The geometry — including the reason its heights come from the road mesh's
 * own expressions rather than from `getGroundHeight` — is in driftRibbon.ts.
 */
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { getTrackEpoch } from "../../track";
import { clonePbrPack, isPbrLibraryReady } from "../webgl2/textureLibrary";
import { getMaxAnisotropy } from "../webgl2/configure";
import { qualityManager } from "../quality";
import { buildDriftRibbon } from "./driftRibbon";
import { reportDensity, triCount } from "./stats";

function buildMaterial(): THREE.MeshStandardMaterial {
  const q = qualityManager.get();
  const pack = isPbrLibraryReady() ? clonePbrPack("sand", 1, 1) : null;
  const aniso = Math.min(getMaxAnisotropy(), q.anisotropy || 4);
  for (const t of [pack?.map, pack?.normalMap]) {
    if (t) {
      t.anisotropy = aniso;
      t.needsUpdate = true;
    }
  }
  return new THREE.MeshStandardMaterial({
    map: pack?.map ?? null,
    normalMap: q.tier === "low" ? null : (pack?.normalMap ?? null),
    color: "#d8b585",
    vertexColors: true,
    transparent: true,
    // A decal must not write depth or it starts occluding the cars that drive
    // over it.
    depthWrite: false,
    side: THREE.DoubleSide,
    roughness: 0.95,
    metalness: 0.02,
    envMapIntensity: 0.5,
    normalScale: new THREE.Vector2(1.2, 1.2),
    // The road is banked and this strip approximates that bank analytically;
    // the offset covers the small disagreement without a visible lift.
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
}

export function VergeDrift() {
  const epoch = getTrackEpoch();
  const built = useMemo(() => {
    const geometry = buildDriftRibbon();
    const material = buildMaterial();
    return { geometry, material };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch]);

  useEffect(() => {
    if (built.geometry) {
      reportDensity("vergeDrift", 1, 1, triCount(built.geometry));
    }
    return () => {
      built.geometry?.dispose();
      built.material.dispose();
    };
  }, [built]);

  if (!built.geometry) return null;
  return (
    <mesh
      geometry={built.geometry}
      material={built.material}
      renderOrder={2}
      receiveShadow={false}
      castShadow={false}
    />
  );
}
