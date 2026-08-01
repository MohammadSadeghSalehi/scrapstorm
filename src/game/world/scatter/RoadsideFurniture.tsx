/**
 * Roadside continuity — Armco on the corner outsides, sponsor hoardings on the
 * straights.
 *
 * The verge was wooden marker posts and nothing else, which is the main reason
 * the road reads as a ribbon dropped onto sand rather than as a built circuit:
 * there was no man-made object between the tarmac edge and the refinery
 * skyline 34m away.
 *
 * Two InstancedMeshes, two draw calls.
 *
 * ── this used to be scenery, and that was the bug ────────────────────
 *
 * The original note here said "None of this has a collider — scenery does not
 * participate in physics", and reasoned that placing it behind the gravel
 * run-off made that acceptable. It did not: the rail is the most obviously
 * SOLID object on the circuit, so driving through it read as the world being
 * broken rather than as the rail being decoration. Both layers are now capsules
 * in the sim's static-collider grid, and both break.
 *
 * WHERE they stand is no longer decided here — see roadsideLayout.ts. This file
 * owns what they look like, and nothing else. The two must agree instance for
 * instance, by INDEX, because that index is how the sim says which module is
 * lying in pieces.
 */
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { getTrackEpoch } from "../../track";
import { boardGeometry, railModuleGeometry } from "./geometry";
import {
  packLayer,
  type ScatterItem,
  type ScatterLayerData,
  type TierScale,
} from "./layerData";
import { isBoardDown, isRailDown, roadsideDamageVersion } from "./roadsideDamage";
import { roadsideLayout } from "./roadsideLayout";
import { ScatterLayer } from "./ScatterLayer";
import { reportDensity, triCount } from "./stats";

/** Sponsor liveries. Multiplied onto the panel's white vertex colour; the
 *  frame and logo bar are dark in vertex colour and stay dark under any tint. */
const LIVERY = [
  "#c8452c",
  "#1f6f9c",
  "#d9a417",
  "#2f7d52",
  "#8a3fa0",
  "#b8b3aa",
  "#c96a1e",
].map((h) => new THREE.Color(h));

/**
 * Rail is never thinned by tier — a guard rail with every third module missing
 * looks broken in a way that an emptier desert does not. Range carries the
 * saving instead.
 */
const RAIL_DENSITY: TierScale = { low: 1, medium: 1, high: 1 };
const RAIL_RANGE: TierScale = { low: 0.45, medium: 0.75, high: 1 };
/**
 * Boards are no longer thinned either, and for a harder reason than the rail's.
 *
 * Density is a prefix of the instance list; colliders are not tiered at all.
 * At the old low-tier 0.5 the back half of the hoardings would have been solid
 * and invisible — a quality setting that spawns invisible walls. 26 extra
 * five-box instances at the bottom tier is the cheaper of the two problems.
 */
const BOARD_DENSITY: TierScale = { low: 1, medium: 1, high: 1 };
const BOARD_RANGE: TierScale = { low: 0.5, medium: 0.8, high: 1 };

/** Shared damage views. Index-keyed, matching roadsideLayout()'s two lists. */
const RAIL_DAMAGE = { isDown: isRailDown, version: roadsideDamageVersion };
const BOARD_DAMAGE = { isDown: isBoardDown, version: roadsideDamageVersion };

function buildRail(): { data: ScatterLayerData; dispose: () => void } | null {
  const { rail, spacing } = roadsideLayout();
  if (!rail.length) return null;

  const geo = railModuleGeometry(spacing);

  const q = new THREE.Quaternion();
  const qPitch = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const yAxis = new THREE.Vector3(0, 1, 0);

  const items: ScatterItem[] = rail.map((m) => {
    const hx = m.bx - m.ax;
    const hz = m.bz - m.az;
    const dy = m.by - m.ay;

    // Heading takes the beam's local +X onto the direction of the next post;
    // pitch (about local Z, applied first) takes up the height difference so
    // the rail follows the ground instead of hovering at one end.
    q.setFromAxisAngle(yAxis, Math.atan2(-hz, hx));
    qPitch.setFromAxisAngle(
      zAxis,
      Math.asin(Math.max(-1, Math.min(1, dy / m.len))),
    );
    q.multiply(qPitch);
    pos.set(m.ax, m.ay, m.az);
    // Only X stretches; a 10-20% variation on a 0.14m post is invisible, and
    // it is the price of one geometry instead of a post mesh plus a beam mesh.
    scl.set((m.len * 1.04) / spacing, 1, 1);

    return {
      matrix: new THREE.Matrix4().compose(pos, q, scl),
      x: (m.ax + m.bx) * 0.5,
      y: m.ay + 0.7,
      z: (m.az + m.bz) * 0.5,
      r: m.len * 0.6 + 0.8,
      limit: 260,
    };
  });

  const mat = new THREE.MeshStandardMaterial({
    color: "#9d9a94",
    vertexColors: true,
    // Galvanised steel: bright, fairly rough, and metallic enough to pick up
    // the sky gradient along the beam, which is what makes a rail read as a
    // continuous line rather than a grey stripe.
    metalness: 0.62,
    roughness: 0.44,
    envMapIntensity: 1.1,
  });

  reportDensity("rail", 1, items.length, items.length * triCount(geo));
  return {
    data: packLayer({
      geometry: geo,
      material: mat,
      items,
      damage: RAIL_DAMAGE,
    }),
    dispose: () => {
      geo.dispose();
      mat.dispose();
    },
  };
}

function buildBoards(): { data: ScatterLayerData; dispose: () => void } | null {
  const { boards } = roadsideLayout();
  if (!boards.length) return null;

  const geo = boardGeometry();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const yAxis = new THREE.Vector3(0, 1, 0);

  const items: ScatterItem[] = boards.map((b, i) => {
    q.setFromAxisAngle(yAxis, b.yaw);
    pos.set(b.x, b.y, b.z);
    return {
      matrix: new THREE.Matrix4().compose(pos, q, one),
      x: b.x,
      y: b.y + 2.2,
      z: b.z,
      r: 3.4,
      limit: 320,
      color: LIVERY[(i * 3 + b.index) % LIVERY.length]!,
    };
  });

  const mat = new THREE.MeshStandardMaterial({
    color: "#e8e4dc",
    vertexColors: true,
    roughness: 0.68,
    metalness: 0.06,
    envMapIntensity: 0.8,
  });

  reportDensity("boards", 1, items.length, items.length * triCount(geo));
  return {
    data: packLayer({
      geometry: geo,
      material: mat,
      items,
      damage: BOARD_DAMAGE,
    }),
    dispose: () => {
      geo.dispose();
      mat.dispose();
    },
  };
}

export function RoadsideFurniture() {
  const epoch = getTrackEpoch();
  const built = useMemo(() => {
    const rail = buildRail();
    const boards = buildBoards();
    return {
      rail,
      boards,
      dispose: () => {
        rail?.dispose();
        boards?.dispose();
      },
    };
    // Placement is derived from TRACK_SAMPLES, which is swapped wholesale on a
    // track change; the epoch is the only signal that happened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch]);

  useEffect(() => built.dispose, [built]);

  return (
    <group>
      {built.rail && (
        <ScatterLayer
          data={built.rail.data}
          density={RAIL_DENSITY}
          range={RAIL_RANGE}
          phase={0}
        />
      )}
      {built.boards && (
        <ScatterLayer
          data={built.boards.data}
          density={BOARD_DENSITY}
          range={BOARD_RANGE}
          phase={1}
        />
      )}
    </group>
  );
}
