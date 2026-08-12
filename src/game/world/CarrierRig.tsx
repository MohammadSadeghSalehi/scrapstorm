/**
 * The visible half of `world/carrier.ts`.
 *
 * ── the deck is drawn FROM the physics curve, not beside it ───────────
 *
 * Every plate of the ramp takes its height from `carrierDeckProfile`, the same
 * function `getGroundHeight` evaluates. That is the whole discipline of this
 * file: the class of bug this project keeps hitting is two copies of one curve
 * drifting apart (the terrain mesh and the ground query were several metres
 * apart in the open desert for exactly that reason), and a ramp is the worst
 * possible place for it — a deck drawn 30cm above where the car is lifted looks
 * like the car is sunk into the trailer, and a deck drawn below it looks like
 * the car is hovering.
 *
 * ── the sides are deliberately a kerb and not a wall ──────────────────
 *
 * A car ON the deck passes straight over the trailer's flank colliders (that is
 * what `yTop` is for), so nothing stops you driving off the side. Drawing a
 * chest-high guard rail along the deck would promise a barrier that does not
 * exist, which is the same complaint that got the set-piece colliders written in
 * the first place, only inverted. So the deck edge is a 22cm kerb: enough to
 * read as a trailer, honest about what it will do for you.
 *
 * ── one draw call ─────────────────────────────────────────────────────
 *
 * Deck, chassis, bogies and tractor unit merge into a single vertex-coloured
 * geometry. ~40 boxes and cylinders, no texture, no second material.
 */
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { getCarriers } from "./carrier";
import { mergeOrThrow } from "./scatter/geometry";
import { carrierGeometry } from "./setpieceGeometry";

export function CarrierRigs({ trackEpoch }: { trackEpoch?: number }) {
  const geo = useMemo(() => {
    const rigs = getCarriers();
    if (!rigs.length) return null;
    const parts = rigs.map((r) => carrierGeometry(r));
    return parts.length > 1 ? mergeOrThrow(parts) : parts[0]!;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackEpoch]);

  const mat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.82,
        metalness: 0.35,
        envMapIntensity: 0.8,
      }),
    [],
  );

  useEffect(() => () => geo?.dispose(), [geo]);
  useEffect(() => () => mat.dispose(), [mat]);

  if (!geo) return null;
  return <mesh geometry={geo} material={mat} castShadow receiveShadow />;
}
