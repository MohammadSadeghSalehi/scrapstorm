/**
 * Turn a circuit's `SetpieceDef` into packed instance layers.
 *
 * No renderer, no canvas, no texture library — the same discipline
 * scatter/fields.ts works to, and for the same reason: every placement bug this
 * project has had was only visible by driving the circuit, and a plain data
 * path is what makes them assertable instead. `buildSetpieceLayers()` runs
 * headlessly under jiti.
 */
import * as THREE from "three";
import { getActiveTrackId } from "../../track";
import { linkedRuns, meanSpacing } from "../scatter/placement";
import { packLayer, type ScatterItem, type ScatterLayerData } from "../scatter/layerData";
import { reportDensity, triCount } from "../scatter/stats";
import { SETPIECE_GEOMETRY, boundsOf } from "./geometry";
import { corridorAnchors, fieldAnchors, type Anchor } from "./placement";
import { DEFAULT_SETPIECES, SETPIECES } from "./presets";
import type {
  SetpieceDef,
  SetpieceFamily,
  SetpieceMaterial,
  SetpiecePlacement,
} from "./types";

/**
 * Deliberately a FUNCTION, not an exported binding reassigned on a track change.
 * `export let` is a live binding under real ESM but jiti transpiles to CJS and
 * snapshots the namespace property at module init — the same trap documented on
 * `getTrackSamples()` and `getActiveEnvironment()`.
 */
export function getActiveSetpieces(): SetpieceDef {
  return SETPIECES[getActiveTrackId()] ?? DEFAULT_SETPIECES;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function makeMaterial(def: SetpieceMaterial): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: def.color,
    // Every structure geometry carries per-part tinting and baked contact
    // darkening in its vertex colours; without this the whole family draws in
    // one flat tone and the silhouette is all you get.
    vertexColors: true,
    roughness: def.roughness,
    metalness: def.metalness,
    envMapIntensity: def.envMapIntensity ?? 0.8,
  });
  // Set rather than passed in the constructor: three warns on a parameter whose
  // value is `undefined`, and most families have no emissive at all.
  if (def.emissive) {
    mat.emissive = new THREE.Color(def.emissive);
    mat.emissiveIntensity = def.emissiveIntensity ?? 1;
  }
  return mat;
}

const Q = new THREE.Quaternion();
const QP = new THREE.Quaternion();
const P = new THREE.Vector3();
const S = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

/**
 * Instances for a family placed AT its anchors, one per anchor.
 *
 * Yaw takes local +Z onto the anchor's toward-the-road vector, which is the
 * convention every unlinked geometry in ./geometry.ts is authored against. A
 * field family may opt out (`faceRoad: false`) and take a free yaw instead —
 * a rock that squares up to the road is a building.
 */
function pointInstances(
  anchors: Anchor[],
  placement: SetpiecePlacement,
  radius: number,
  midY: number,
  limit: number,
): ScatterItem[] {
  const [lo, hi] = placement.scale;
  const jitter =
    placement.mode === "corridor" ? (placement.yawJitter ?? 0) : 0;
  const free = placement.mode === "field" && !placement.faceRoad;

  return anchors.map((an) => {
    const s = lerp(lo, hi, an.a);
    const yaw = free
      ? an.a * Math.PI * 2
      : Math.atan2(an.tx, an.tz) + (an.b - 0.5) * jitter;
    Q.setFromAxisAngle(Y_AXIS, yaw);
    P.set(an.x, an.y, an.z);
    S.setScalar(s);
    return {
      matrix: new THREE.Matrix4().compose(P, Q, S),
      x: an.x,
      y: an.y + midY * s,
      z: an.z,
      r: radius * s,
      // Jittered per instance so a family does not pop in along one clean arc
      // as the camera turns.
      limit: limit * (0.86 + an.b * 0.28),
    };
  });
}

/**
 * Instances for a LINKED family: one module per gap between consecutive
 * same-side anchors, aimed at the next anchor and stretched to close the gap.
 *
 * Local +X is scaled to fit; Y and Z take the family's own scale range, so
 * `scale` on a linked placement means "how tall and thick", not "how long".
 * Pitching about local Z takes up the height difference between anchors — the
 * ground rolls under a wall exactly as much as it rolls under a guard rail, and
 * without this the run hovers at one end of every module.
 */
function linkedInstances(
  anchors: Anchor[],
  placement: Extract<SetpiecePlacement, { mode: "corridor" }>,
  span: number,
  radius: number,
  midY: number,
  limit: number,
): ScatterItem[] {
  const [lo, hi] = placement.scale;
  const items: ScatterItem[] = [];
  // 2.4x the median spacing: wide enough to bridge a single dropped anchor,
  // narrow enough that a deliberate `gapLen` break is never bridged.
  for (const run of linkedRuns(anchors, span * 2.4)) {
    for (let i = 0; i < run.length - 1; i++) {
      const a = run[i]!;
      const b = run[i + 1]!;
      const hx = b.x - a.x;
      const hz = b.z - a.z;
      const flat = Math.hypot(hx, hz);
      if (flat < 0.4) continue;
      const dy = b.y - a.y;
      const len = Math.hypot(flat, dy);
      const sec = lerp(lo, hi, a.a);

      Q.setFromAxisAngle(Y_AXIS, Math.atan2(-hz, hx));
      QP.setFromAxisAngle(
        Z_AXIS,
        Math.asin(Math.max(-1, Math.min(1, dy / len))),
      );
      Q.multiply(QP);
      P.set(a.x, a.y, a.z);
      // 1.02 overlaps neighbours very slightly. A wall built to exact length
      // shows a hairline of desert at every joint once the run curves.
      S.set((len * 1.02) / span, sec, sec);

      items.push({
        matrix: new THREE.Matrix4().compose(P, Q, S),
        x: (a.x + b.x) * 0.5,
        y: a.y + midY * sec,
        z: (a.z + b.z) * 0.5,
        r: len * 0.6 + radius * sec,
        limit: limit * (0.86 + a.b * 0.28),
      });
    }
  }
  return items;
}

export type SetpieceLayer = {
  id: string;
  data: ScatterLayerData;
  family: SetpieceFamily;
};

export type BuiltSetpieces = {
  layers: SetpieceLayer[];
  dispose: () => void;
};

/**
 * Build every family of the active circuit.
 *
 * Families are walked in order so a `follows` reference can only ever point
 * backwards, which is what makes the dependency a straight line rather than a
 * graph that needs resolving.
 */
export function buildSetpieceLayers(): BuiltSetpieces {
  const def = getActiveSetpieces();
  const layers: SetpieceLayer[] = [];
  const owned: { dispose(): void }[] = [];
  /** Resolved anchors + the placement they came from, for `follows`. */
  const resolved = new Map<string, { anchors: Anchor[]; placement: SetpiecePlacement }>();

  for (const family of def.families) {
    let anchors: Anchor[];
    let placement: SetpiecePlacement;

    if (family.follows) {
      const src = resolved.get(family.follows);
      // A dangling reference means a preset typo. Skipping is the right
      // failure: a missing tap hole is a cosmetic loss, and throwing here would
      // take the whole circuit's world down with it.
      if (!src) continue;
      anchors = src.anchors;
      placement = src.placement;
    } else {
      if (!family.placement) continue;
      placement = family.placement;
      anchors =
        placement.mode === "corridor"
          ? corridorAnchors(placement)
          : fieldAnchors(placement);
    }
    if (!anchors.length) continue;

    const linked = placement.mode === "corridor" && placement.link;
    // Linked geometry is authored spanning [0, span]; the span has to be the
    // circuit's own median anchor spacing or every module is stretched or
    // squashed by the same constant amount for the whole lap.
    const span = linked ? Math.max(2, meanSpacing(anchors)) : 1;
    const geometry = SETPIECE_GEOMETRY[family.shape](span);
    const { radius, midY } = boundsOf(geometry);

    const items = linked
      ? linkedInstances(
          anchors,
          placement as Extract<SetpiecePlacement, { mode: "corridor" }>,
          span,
          radius,
          midY,
          family.limit,
        )
      : pointInstances(anchors, placement, radius, midY, family.limit);

    if (!items.length) {
      geometry.dispose();
      continue;
    }

    const material = makeMaterial(family.material);
    owned.push(geometry, material);
    if (!family.follows) resolved.set(family.id, { anchors, placement });

    reportDensity(
      `setpiece:${family.id}`,
      1,
      items.length,
      items.length * triCount(geometry),
    );

    layers.push({
      id: family.id,
      family,
      data: packLayer({
        geometry,
        material,
        items,
        castShadow: family.castShadow ?? false,
        receiveShadow: true,
      }),
    });
  }

  return {
    layers,
    dispose: () => {
      for (const o of owned) o.dispose();
    },
  };
}
