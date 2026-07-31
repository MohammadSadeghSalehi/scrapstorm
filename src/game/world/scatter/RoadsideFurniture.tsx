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
 * Placement is BEHIND the gravel run-off, at half + 5.5 + offset, not on the
 * verge proper. None of this has a collider — scenery does not participate in
 * physics — so anything inside the run-off is something the player clips
 * through at the exact moment they are already having a bad time. Behind it,
 * the rail is furniture the way a real circuit's is: past the point you are
 * meant to be able to reach.
 */
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { getTrackEpoch } from "../../track";
import { boardGeometry, railModuleGeometry } from "./geometry";
import {
  curvatureThreshold,
  meanSpacing,
  vergePoints,
  type VergePoint,
} from "./placement";
import {
  packLayer,
  type ScatterItem,
  type ScatterLayerData,
  type TierScale,
} from "./layerData";
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
const BOARD_DENSITY: TierScale = { low: 0.5, medium: 1, high: 1 };
const BOARD_RANGE: TierScale = { low: 0.5, medium: 0.8, high: 1 };

/**
 * Split verge anchors into runs of consecutive same-side points.
 *
 * `vergePoints` walks the circuit in order but drops anchors that fail the
 * curvature filter or the whole-loop clearance test, so consecutive entries are
 * not necessarily neighbours. Joining across a drop would throw a 200m beam
 * across the infield.
 */
function railRuns(points: VergePoint[], maxGap: number): VergePoint[][] {
  const runs: VergePoint[][] = [];
  let cur: VergePoint[] = [];
  for (const p of points) {
    const last = cur[cur.length - 1];
    const joins =
      last !== undefined &&
      last.side === p.side &&
      Math.hypot(p.x - last.x, p.z - last.z) <= maxGap;
    if (!joins) {
      if (cur.length > 1) runs.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length > 1) runs.push(cur);
  return runs;
}

function buildRail(): { data: ScatterLayerData; dispose: () => void } | null {
  // Top ~40% of the circuit by curvature. Rail belongs where a car leaves the
  // road, which is the outside of a bend, and nowhere else.
  const minCurve = curvatureThreshold(0.4);
  const points = vergePoints({
    stride: 1,
    offset: 1,
    radius: 0.35,
    minCurve,
    outsideOnly: true,
  });
  if (points.length < 4) return null;

  const spacing = meanSpacing(points);
  const runs = railRuns(points, spacing * 2.4);
  const geo = railModuleGeometry(spacing);

  const q = new THREE.Quaternion();
  const qPitch = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const yAxis = new THREE.Vector3(0, 1, 0);

  const items: ScatterItem[] = [];
  for (const run of runs) {
    for (let i = 0; i < run.length - 1; i++) {
      const a = run[i]!;
      const b = run[i + 1]!;
      const hx = b.x - a.x;
      const hz = b.z - a.z;
      const flat = Math.hypot(hx, hz);
      if (flat < 0.4) continue;
      const dy = b.y - a.y;
      const len = Math.hypot(flat, dy);

      // Heading takes the beam's local +X onto the direction of the next post;
      // pitch (about local Z, applied first) takes up the height difference so
      // the rail follows the ground instead of hovering at one end.
      q.setFromAxisAngle(yAxis, Math.atan2(-hz, hx));
      qPitch.setFromAxisAngle(zAxis, Math.asin(Math.max(-1, Math.min(1, dy / len))));
      q.multiply(qPitch);
      pos.set(a.x, a.y, a.z);
      // Only X stretches; a 10-20% variation on a 0.14m post is invisible, and
      // it is the price of one geometry instead of a post mesh plus a beam mesh.
      scl.set((len * 1.04) / spacing, 1, 1);

      const midX = (a.x + b.x) * 0.5;
      const midZ = (a.z + b.z) * 0.5;
      items.push({
        matrix: new THREE.Matrix4().compose(pos, q, scl),
        x: midX,
        y: a.y + 0.7,
        z: midZ,
        r: len * 0.6 + 0.8,
        limit: 260,
      });
    }
  }
  if (!items.length) {
    geo.dispose();
    return null;
  }

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
    data: packLayer({ geometry: geo, material: mat, items }),
    dispose: () => {
      geo.dispose();
      mat.dispose();
    },
  };
}

function buildBoards(): { data: ScatterLayerData; dispose: () => void } | null {
  // Flattest ~45% of the circuit: a hoarding wants to be read at speed on
  // approach, which only works down a straight.
  const maxCurve = curvatureThreshold(0.55);
  const points = vergePoints({
    stride: 7,
    offset: 5.5,
    radius: 3,
    maxCurve,
    phase: 3,
    reach: 4,
  });
  if (!points.length) return null;

  const geo = boardGeometry();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const yAxis = new THREE.Vector3(0, 1, 0);

  const items: ScatterItem[] = points.map((p, i) => {
    // Panel normal is local +Z; turn it to face the racing line. Sign flips
    // with the verge, or half the boards would advertise to the desert.
    q.setFromAxisAngle(yAxis, p.yaw - p.side * Math.PI * 0.5);
    pos.set(p.x, p.y, p.z);
    return {
      matrix: new THREE.Matrix4().compose(pos, q, one),
      x: p.x,
      y: p.y + 2.2,
      z: p.z,
      r: 3.4,
      limit: 320,
      color: LIVERY[(i * 3 + p.index) % LIVERY.length]!,
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
    data: packLayer({ geometry: geo, material: mat, items }),
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
