/**
 * Highway lighting — columns, the distribution line strung between them, and
 * the light they throw once the hour is dark enough to need it.
 *
 * Three InstancedMeshes, three draw calls, and only two of them ever exist at
 * once on a bright circuit.
 *
 * ── how a lamp lights the road without being a light ──────────────────
 *
 * It does not. Nothing in this file illuminates anything: no point light, no
 * spot light, no shadow. What it does is DRAW the light — an additive cone under
 * each lantern whose vertex colours peak just above the ground — and at racing
 * speed under a 0.14-intensity moon that is the part the eye reads.
 *
 * The alternative was costed and rejected twice over. A point light per column
 * is a hundred lights in the scene's uniform block and a hundred per-pixel
 * evaluations on a tier measured at 25fps. A small POOLED set near the camera is
 * worse than it sounds, because the pool size is compiled into every material in
 * the scene: growing or shrinking the pool with the quality tier would recompile
 * the whole world mid-race, on exactly the machines whose frame rate triggered
 * the tier change. This project already reverted CSM for the same shape of
 * problem (151 -> 81 fps, a directional light per cascade).
 *
 * So the honest statement is: the road does not get brighter near a lamp, it
 * gets a painted pool of light on it. See `lampGlowGeometry` for why that pool
 * is a buried cone and not a disc lying on the ground.
 *
 * ── when the lamps are on ─────────────────────────────────────────────
 *
 * `env.light.headlights.enabled`, and nothing else. That flag is already the
 * game's single answer to "is it dark enough that lights matter" — it is true at
 * night, at sunset, and in rain at any hour, and `validateVariants` treats a
 * night without it as a bug. Deriving the street lighting from the same signal
 * means the cars' lights and the road's lights can never disagree, and it costs
 * nothing to keep in step with a new hour or a new weather condition.
 *
 * ── the tier rule, and why the columns break it ───────────────────────
 *
 * The glow and the wires are switched OFF at the low tier by a draw RANGE of
 * zero, which with ScatterLayer's `visible` gate costs that tier nothing at all:
 * the meshes are never traversed.
 *
 * The columns are not, and cannot be. They are the one thing here with a
 * collider, and a collider that is not tiered plus a renderer that is tiered is
 * an invisible wall — the failure BOARD_DENSITY's note in RoadsideFurniture is
 * about. Range is the one form of thinning that is safe for a solid object,
 * because anything close enough to hit is close enough to draw; DENSITY is not,
 * because it hides a prefix of the list wherever it happens to be. So the low
 * tier gains exactly one draw call and whatever falls inside LAMP_RANGE.low.
 * Setting that to 0 is the one-line change that takes it to zero, at the cost of
 * eight-metre columns you drive through.
 */
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import {
  catenaryWireGeometry,
  lampGlowGeometry,
  lampPostGeometry,
  LAMP_WIRE_TIE,
} from "./geometry";
import {
  packLayer,
  type ScatterItem,
  type ScatterLayerData,
  type TierScale,
} from "./layerData";
import { isLampDown, roadsideDamageVersion } from "./roadsideDamage";
import { roadsideLayout, type LampSite } from "./roadsideLayout";
import { ScatterLayer } from "./ScatterLayer";
import { getActiveEnvironment, getEnvironmentEpoch } from "../environments";
import { reportDensity, triCount } from "./stats";

/**
 * Never thinned by density, for the reason in the header. `low` is a draw range
 * of 0.30 — about 70m at the limits below, which is far enough ahead to see the
 * next column arrive and near enough that the tier draws four or five of them.
 */
const LAMP_DENSITY: TierScale = { low: 1, medium: 1, high: 1 };
const LAMP_RANGE: TierScale = { low: 0.3, medium: 0.72, high: 1 };

/**
 * Wires and glow are pure decoration — no collider, nothing to disagree with —
 * so the low tier switches them off outright. A range of 0 rejects every
 * instance, the layer's count goes to zero, and ScatterLayer marks the mesh
 * invisible, which takes it out of `projectObject` entirely.
 *
 * Density stays at 1 on both for the guard rail's reason: a run of lamps with
 * the wire missing between two of them does not read as a lower quality
 * setting, it reads as a bug.
 */
const WIRE_DENSITY: TierScale = { low: 1, medium: 1, high: 1 };
const WIRE_RANGE: TierScale = { low: 0, medium: 0.7, high: 1 };
const GLOW_DENSITY: TierScale = { low: 1, medium: 1, high: 1 };
const GLOW_RANGE: TierScale = { low: 0, medium: 0.78, high: 1 };

/**
 * Lantern colours.
 *
 * Four low-pressure sodium and one mercury-white, which is the ratio you get on
 * any road that has been maintained a few units at a time over thirty years. A
 * perfectly uniform run of lamps is the tell that they were placed by a loop.
 */
const LANTERN = ["#ffb45a", "#ffc78a", "#ffa347", "#dfe6ff", "#ffbe6e"].map(
  (h) => new THREE.Color(h),
);

/** Yaw a lamp-local offset into world space. */
function tieOf(l: LampSite): [number, number, number] {
  const c = Math.cos(l.yaw);
  const s = Math.sin(l.yaw);
  const [tx, ty, tz] = LAMP_WIRE_TIE;
  return [l.x + tx * c + tz * s, l.y + ty, l.z - tx * s + tz * c];
}

type Built = { data: ScatterLayerData; dispose: () => void } | null;

/** Shared damage view for the columns. Index-keyed to `roadsideLayout().lamps`. */
const LAMP_DAMAGE = { isDown: isLampDown, version: roadsideDamageVersion };

function buildPosts(lamps: LampSite[]): Built {
  if (!lamps.length) return null;
  const geo = lampPostGeometry();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const yAxis = new THREE.Vector3(0, 1, 0);

  const items: ScatterItem[] = lamps.map((l) => {
    q.setFromAxisAngle(yAxis, l.yaw);
    pos.set(l.x, l.y, l.z);
    return {
      matrix: new THREE.Matrix4().compose(pos, q, one),
      x: l.x,
      // The module's bounding box is centred 4.16m up and 0.92m toward the road;
      // the radius below absorbs that lateral offset so the cull sphere does not
      // have to be rebuilt per yaw.
      y: l.y + 4.2,
      z: l.z,
      r: 6.2,
      limit: 230,
    };
  });

  const mat = new THREE.MeshStandardMaterial({
    color: "#8d8b86",
    vertexColors: true,
    // Galvanised steel that has been in a desert for a while: metallic enough
    // to take the sky gradient down one side of the column, which is most of
    // what separates a lamp post from a grey line against a grey ridge.
    metalness: 0.55,
    roughness: 0.52,
    envMapIntensity: 1.0,
  });

  reportDensity("lampPost", 1, items.length, items.length * triCount(geo));
  return {
    data: packLayer({ geometry: geo, material: mat, items, damage: LAMP_DAMAGE }),
    dispose: () => {
      geo.dispose();
      mat.dispose();
    },
  };
}

function buildWires(lamps: LampSite[], spans: { a: number; b: number }[], span: number): Built {
  if (!spans.length) return null;
  const geo = catenaryWireGeometry(span);

  const q = new THREE.Quaternion();
  const qPitch = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const zAxis = new THREE.Vector3(0, 0, 1);

  const items: ScatterItem[] = spans.map((w) => {
    const [ax, ay, az] = tieOf(lamps[w.a]!);
    const [bx, by, bz] = tieOf(lamps[w.b]!);
    const hx = bx - ax;
    const hz = bz - az;
    const dy = by - ay;
    const flat = Math.hypot(hx, hz);
    const len = Math.hypot(flat, dy);

    // Same composition as a rail module: heading takes local +X onto the next
    // tie, then pitch about local Z takes up the height difference.
    q.setFromAxisAngle(yAxis, Math.atan2(-hz, hx));
    qPitch.setFromAxisAngle(zAxis, Math.asin(Math.max(-1, Math.min(1, dy / (len || 1)))));
    q.multiply(qPitch);
    pos.set(ax, ay, az);
    scl.set(len / span, 1, 1);

    return {
      matrix: new THREE.Matrix4().compose(pos, q, scl),
      x: (ax + bx) * 0.5,
      // Below the midpoint of the two ties: the span hangs, so its lowest point
      // is what the cull sphere has to reach, not its chord.
      y: (ay + by) * 0.5 - 0.7,
      z: (az + bz) * 0.5,
      r: len * 0.55 + 2.4,
      limit: 190,
    };
  });

  const mat = new THREE.MeshStandardMaterial({
    color: "#2a2825",
    vertexColors: true,
    metalness: 0.4,
    roughness: 0.86,
    envMapIntensity: 0.6,
    // Each conductor is a cross of two flat ribbons; without this the wire
    // disappears from half the angles you can look at it from.
    side: THREE.DoubleSide,
  });

  reportDensity("catenary", 1, items.length, items.length * triCount(geo));
  return {
    data: packLayer({
      geometry: geo,
      material: mat,
      items,
      /*
       * A span dies with EITHER of its columns.
       *
       * This is the reason `WireSpan` holds two indices rather than two
       * endpoints: a wire left hanging in the air from a post that is lying in
       * the road is the most obvious kind of broken there is, and a span that
       * carried its own copy of the coordinates would have no way to know.
       */
      damage: {
        isDown: (i: number) => {
          const w = spans[i];
          return w !== undefined && (isLampDown(w.a) || isLampDown(w.b));
        },
        version: roadsideDamageVersion,
      },
    }),
    dispose: () => {
      geo.dispose();
      mat.dispose();
    },
  };
}

function buildGlow(lamps: LampSite[], strength: number): Built {
  if (!lamps.length) return null;
  const geo = lampGlowGeometry();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const yAxis = new THREE.Vector3(0, 1, 0);

  const items: ScatterItem[] = lamps.map((l, i) => {
    q.setFromAxisAngle(yAxis, l.yaw);
    pos.set(l.x, l.y, l.z);
    return {
      matrix: new THREE.Matrix4().compose(pos, q, one),
      x: l.x,
      y: l.y + 3.9,
      z: l.z,
      // The cone is 6.4m across and offset 2.42m toward the road; this covers
      // both without needing the yaw.
      r: 12.6,
      // Shorter than the columns on purpose. A pool of light resolves to a
      // smudge well before the post it belongs to stops being a silhouette, and
      // this is the layer that costs fill rate rather than triangles.
      limit: 165,
      color: LANTERN[i % LANTERN.length]!,
    };
  });

  const mat = new THREE.MeshBasicMaterial({
    // Basic, not Standard: this IS light. Shading it would be asking how the
    // moon falls on a beam of lamplight.
    color: new THREE.Color(strength, strength, strength),
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    // Must not occlude. It must still be OCCLUDED, though — depth testing is
    // what buries the bottom of the cone in the ground on a slope, and turning
    // it off would draw the pool on top of the terrain it is supposed to be on.
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  reportDensity("lampGlow", 1, items.length, items.length * triCount(geo));
  return {
    data: packLayer({ geometry: geo, material: mat, items, damage: LAMP_DAMAGE }),
    dispose: () => {
      geo.dispose();
      mat.dispose();
    },
  };
}

export function RoadsideLighting() {
  /*
   * Environment epoch, not track epoch.
   *
   * A mission can put the same circuit under a different hour or a different
   * weather condition without changing the track, and `getTrackEpoch()` does not
   * move when it does. Keyed on that, the lamps would stay dark through a night
   * race that was reached by a rematch. The placement solve itself is cached
   * inside `roadsideLayout()` on the track epoch, so the extra rebuilds here
   * cost a few hundred matrix compositions and not the verge solve.
   */
  const epoch = getEnvironmentEpoch();
  const built = useMemo(() => {
    const { lamps, wires, wireSpacing } = roadsideLayout();
    const hl = getActiveEnvironment().light.headlights;
    // Night is 4.2, sunset 1.4, rain at a bright hour 1.2-2.0. Normalising
    // against the darkest hour makes a sunset lamp a hint rather than a beacon,
    // which is what a lamp that has just come on actually looks like.
    const strength = hl.enabled
      ? Math.min(1, Math.max(0.25, hl.intensity / 4.2))
      : 0;

    const posts = buildPosts(lamps);
    const wire = buildWires(lamps, wires, wireSpacing);
    const glow = hl.enabled ? buildGlow(lamps, strength) : null;
    return {
      posts,
      wire,
      glow,
      dispose: () => {
        posts?.dispose();
        wire?.dispose();
        glow?.dispose();
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch]);

  useEffect(() => built.dispose, [built]);

  return (
    <group>
      {built.posts && (
        <ScatterLayer
          data={built.posts.data}
          density={LAMP_DENSITY}
          range={LAMP_RANGE}
          phase={2}
        />
      )}
      {built.wire && (
        <ScatterLayer
          data={built.wire.data}
          density={WIRE_DENSITY}
          range={WIRE_RANGE}
          phase={0}
        />
      )}
      {built.glow && (
        <ScatterLayer
          data={built.glow.data}
          density={GLOW_DENSITY}
          range={GLOW_RANGE}
          phase={1}
        />
      )}
    </group>
  );
}
