/**
 * Roadside continuity — Armco on the corner outsides, written signage
 * everywhere a driver would read it.
 *
 * The verge was wooden marker posts and nothing else, which is the main reason
 * the road reads as a ribbon dropped onto sand rather than as a built circuit:
 * there was no man-made object between the tarmac edge and the refinery
 * skyline 34m away.
 *
 * THREE InstancedMeshes — rail, hoardings, plates — and therefore at most three
 * draw calls, two of them at the low tier where the plates are switched off
 * entirely. That count did not change when the signs learned to say things: the
 * sixteen plate faces and six hoarding faces all come out of ONE shared atlas,
 * selected per instance by a rect in an instanced attribute, so more signage
 * costs instances and never draws. `scripts/check-setpiece-footprints.mjs`
 * prints the per-tier budget from the real layout and fails if the low tier ever
 * exceeds two.
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
import { boardGeometry, railModuleGeometry, signGeometry } from "./geometry";
import { getActiveEnvironment, getEnvironmentEpoch } from "../environments";
import { getActiveTrackId } from "../../track";
import {
  packLayer,
  type ScatterItem,
  type ScatterLayerData,
} from "./layerData";
import { isBoardDown, isRailDown, roadsideDamageVersion } from "./roadsideDamage";
import { roadsideLayout } from "./roadsideLayout";
import {
  BOARD_DENSITY,
  BOARD_RANGE,
  RAIL_DENSITY,
  RAIL_RANGE,
  SIGN_DENSITY,
  SIGN_RANGE,
} from "./roadsideTiers";
import { ScatterLayer } from "./ScatterLayer";
import {
  ATLAS_SIZE,
  boardFaceRect,
  drawSignAtlas,
  patchSignVertexShader,
  signCopy,
  signFaceRect,
} from "./signFaces";
import { reportDensity, triCount } from "./stats";

/**
 * The signage atlas, as one canvas texture shared by both families.
 *
 * A texture is not a draw call, so the two materials that need it — the plates'
 * retroreflective one and the hoardings' painted one — can share a single
 * 1024x1024 upload rather than carrying an atlas each. That is 5.6MB with
 * mipmaps for every written sign outside the gantry.
 *
 * Mipmaps are ON despite this being an atlas, and the cross-cell bleed that
 * implies is deliberate: the alternative is aliased lettering at the range these
 * are actually read from, and the cells are 256px wide against a plate that is
 * under forty pixels on screen by the time a coarse enough mip is selected for
 * a neighbour to contribute.
 */
function buildSignageTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const cv = document.createElement("canvas");
  cv.width = ATLAS_SIZE;
  cv.height = ATLAS_SIZE;
  const g = cv.getContext("2d");
  if (!g) return null;
  drawSignAtlas(g, signCopy(getActiveTrackId()));
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/**
 * Attach the per-instance atlas lookup to a material.
 *
 * `patchSignVertexShader` THROWS when three's `<uv_vertex>` chunk is not where
 * it expects, and this is the one place that throw can reach a player. That is
 * the correct trade: the alternative failure is every sign on the circuit
 * wearing the same picture, which is indistinguishable from a deliberate art
 * choice and is precisely the class of bug §4 of AGENTS.md exists for. The gate
 * runs the same function against `THREE.ShaderLib.standard` — the very string
 * the renderer hands it — so a chunk rename fails headlessly first.
 *
 * No `customProgramCacheKey` is needed: three's default already hashes
 * `onBeforeCompile.toString()`, so a patched material cannot be handed an
 * unpatched program compiled for some other MeshStandardMaterial with the same
 * parameters.
 */
function withSignUv<T extends THREE.Material>(m: T): T {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = patchSignVertexShader(shader.vertexShader);
  };
  return m;
}

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

function buildBoards(
  tex: THREE.Texture | null,
): { data: ScatterLayerData; dispose: () => void } | null {
  const { boards } = roadsideLayout();
  if (!boards.length) return null;

  const geo = boardGeometry();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const yAxis = new THREE.Vector3(0, 1, 0);

  const items: ScatterItem[] = boards.map((b) => {
    q.setFromAxisAngle(yAxis, b.yaw);
    pos.set(b.x, b.y, b.z);
    return {
      matrix: new THREE.Matrix4().compose(pos, q, one),
      x: b.x,
      y: b.y + 2.2,
      z: b.z,
      r: 3.4,
      limit: 320,
      uv: boardFaceRect(b.face),
    };
  });

  /*
   * Near-white and PAINTED, not retroreflective — the opposite of the plates
   * below, and on purpose. A hoarding is a billboard someone stuck up; it has
   * no sheeting on it and it should not brighten as the hour darkens. Keeping
   * the base colour a literal rather than `surfaces.stripe` is what makes the
   * two families read as two different objects at night.
   */
  const mat = withSignUv(
    new THREE.MeshStandardMaterial({
      color: "#e8e4dc",
      map: tex,
      vertexColors: true,
      roughness: 0.68,
      metalness: 0.06,
      envMapIntensity: 0.8,
    }),
  );

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

function buildSigns(
  tex: THREE.Texture | null,
): { data: ScatterLayerData; dispose: () => void } | null {
  const { signs } = roadsideLayout();
  if (!signs.length) return null;

  const geo = signGeometry();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const yAxis = new THREE.Vector3(0, 1, 0);

  const items: ScatterItem[] = signs.map((s) => {
    q.setFromAxisAngle(yAxis, s.yaw);
    pos.set(s.x, s.y, s.z);
    return {
      matrix: new THREE.Matrix4().compose(pos, q, one),
      x: s.x,
      y: s.y + 1.7,
      z: s.z,
      r: 2.4,
      limit: 210,
      uv: signFaceRect(s.face),
    };
  });

  const mat = withSignUv(
    new THREE.MeshStandardMaterial({
      /*
       * The signs wear `surfaces.stripe`, and that is the whole retroreflective
       * trick.
       *
       * Lane paint is the one colour in the environment authored to get
       * BRIGHTER relative to everything else as the hour darkens (`stripeLift`
       * in variants.ts, +0.34 at night). Sign faces behave the same way in real
       * life and for the same reason — they are retroreflective sheeting, not
       * white paint — so taking that colour rather than a literal gives them the
       * behaviour for free, on every hour and every weather condition, without
       * this file knowing what an hour is.
       *
       * With ARTWORK on the plate this stops being an approximation and starts
       * being the real thing. three multiplies material colour x vertex colour x
       * map, so the bleached SHEETING in the atlas takes the whole lift while
       * the charcoal legend printed on it multiplies down to nothing and stays
       * dark — which is exactly what retroreflective sheeting does in
       * headlights, and what the old uniform plate could only fake by getting
       * brighter all over. The post is at vertex colour 0.28 and samples the
       * cell's white band, so it still takes only a quarter of the lift.
       *
       * An `emissive` would not work here at all — three does not multiply
       * emissive by vertex colour, so the post would glow as hard as the plate.
       */
      color: getActiveEnvironment().surfaces.stripe,
      map: tex,
      vertexColors: true,
      roughness: 0.55,
      metalness: 0.08,
      envMapIntensity: 0.9,
    }),
  );

  reportDensity("signs", 1, items.length, items.length * triCount(geo));
  return {
    data: packLayer({ geometry: geo, material: mat, items }),
    dispose: () => {
      geo.dispose();
      mat.dispose();
    },
  };
}

export function RoadsideFurniture() {
  /*
   * Environment epoch rather than track epoch.
   *
   * Placement is derived from TRACK_SAMPLES, which is swapped wholesale on a
   * track change — but the sign material reads `surfaces.stripe`, and that
   * moves with the HOUR and the WEATHER, neither of which bumps the track
   * epoch. Keyed on the track alone, a rematch on the same circuit at night
   * would keep the daytime sign colour and nothing would say so.
   *
   * The expensive half of a rebuild is the verge solve, and that is cached
   * inside `roadsideLayout()` on the track epoch, so the extra rebuilds cost a
   * few hundred matrix compositions between races.
   */
  const epoch = getEnvironmentEpoch();
  /*
   * The atlas is keyed on the TRACK, not on the environment epoch.
   *
   * Which words are painted on the signs is a property of the circuit; the
   * environment epoch also moves with the hour and the weather, and repainting
   * twenty-two cells of a 1024x1024 canvas because it started raining is a
   * hitch nobody asked for. The rebuild below still runs on the epoch — it has
   * to, for `surfaces.stripe` — and simply reuses this texture.
   */
  const trackId = getActiveTrackId();
  const tex = useMemo(() => buildSignageTexture(), [trackId]);
  useEffect(() => () => tex?.dispose(), [tex]);

  const built = useMemo(() => {
    const rail = buildRail();
    const boards = buildBoards(tex);
    const signs = buildSigns(tex);
    return {
      rail,
      boards,
      signs,
      dispose: () => {
        rail?.dispose();
        boards?.dispose();
        signs?.dispose();
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch, tex]);

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
      {built.signs && (
        <ScatterLayer
          data={built.signs.data}
          density={SIGN_DENSITY}
          range={SIGN_RANGE}
          phase={2}
        />
      )}
    </group>
  );
}
