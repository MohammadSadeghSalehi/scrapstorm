/**
 * The visible half of `world/tunnels.ts`.
 *
 * ── one draw call for the structure, on every tier ────────────────────
 *
 * Walls, roof slab and both portal headwalls merge into a single
 * BufferGeometry with one material and vertex colours, the same rule every
 * set-piece family in this project works to. A tunnel made of thirty `<mesh>`
 * elements would be thirty draw calls in the one part of the circuit where the
 * frame is already paying for a light knock-down and a rain cull.
 *
 * The strip lights are a SECOND call and are the only part gated by tier,
 * because they are the only part that is not load-bearing: the walls have
 * colliders and the roof is what makes the bore dark, so dropping either on the
 * low tier would leave something solid and invisible or something dark and
 * open. See the draw-call arithmetic in StartGantry.tsx — the gantry rewrite
 * pays for this.
 *
 * ── geometry is built in WORLD space ──────────────────────────────────
 *
 * No group transform. The bore follows the centreline, so its "local" frame
 * would be a different rotation at every segment anyway, and a mesh at the
 * origin with world-space vertices is one fewer matrix for the culler to chase.
 * Circuits are under 900m across, which is nowhere near float32's limit for
 * centimetre detail.
 *
 * ── why the interior is painted dark rather than lit dark ─────────────
 *
 * There is no GI and one shadow cascade (AGENTS.md §8.3), so an unlit interior
 * is not something the renderer can produce on its own — a wall inside a tunnel
 * receives exactly the same ambient and hemisphere as a wall in the open. Two
 * things together make the bore read: the vertex colours here are near-black on
 * every inward-facing surface, and `TunnelAtmosphere` in GameScene pulls the
 * three scene lights down as the CAMERA goes under. Either alone looks wrong —
 * dark paint under full sun reads as a black object, and dimmed lights with a
 * bright interior reads as sunglasses.
 */
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeOrThrow } from "./scatter/geometry";
import { qualityManager } from "./quality";
import { boreGeometry, lampGeometry } from "./setpieceGeometry";
import { getTunnels } from "./tunnels";

export function TunnelBores({ trackEpoch }: { trackEpoch?: number }) {
  const tier = qualityManager.get().tier;
  const built = useMemo(() => {
    const bores = getTunnels();
    if (!bores.length) return null;
    const structure: THREE.BufferGeometry[] = [];
    const lamps: THREE.BufferGeometry[] = [];
    for (const t of bores) {
      structure.push(boreGeometry(t, tier === "low" ? 2 : 1));
      if (tier !== "low") {
        const l = lampGeometry(t);
        if (l) lamps.push(l);
      }
    }
    return {
      structure: structure.length > 1 ? mergeOrThrow(structure) : structure[0]!,
      lamps: lamps.length ? (lamps.length > 1 ? mergeOrThrow(lamps) : lamps[0]!) : null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackEpoch, tier]);

  const mat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.96,
        metalness: 0.02,
        envMapIntensity: 0.25,
      }),
    [],
  );
  const lampMat = useMemo(
    () => new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    [],
  );

  useEffect(
    () => () => {
      built?.structure.dispose();
      built?.lamps?.dispose();
    },
    [built],
  );
  useEffect(
    () => () => {
      mat.dispose();
      lampMat.dispose();
    },
    [mat, lampMat],
  );

  if (!built) return null;
  return (
    <group>
      <mesh geometry={built.structure} material={mat} receiveShadow castShadow={tier === "high"} />
      {built.lamps ? <mesh geometry={built.lamps} material={lampMat} /> : null}
    </group>
  );
}
