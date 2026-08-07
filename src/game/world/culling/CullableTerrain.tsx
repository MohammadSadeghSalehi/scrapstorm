/**
 * Cullable terrain pieces — wire into TrackMesh.
 * Visibility driven by TerrainCullDriver buses (mesh.visible, no remount).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { SCENERY, getGroundHeight, getScenery, getTrackEpoch } from "../../track";
import { terrainPatch } from "../terrainGeometry";
import { createProcMaterial } from "../procmat";
import {
  loadPhModel,
  SCENERY_TEMPLATE_LEN,
  type PhModelKey,
} from "../polyHavenAssets";
import { qualityManager } from "../quality";
import {
  buildGroundTiles,
  type CullSphere,
  type GroundTile,
} from "./cpuTerrainCull";
import {
  duneCullBus,
  groundCullBus,
  sceneryCullBus,
} from "./TerrainCullDriver";

type CullBus = typeof duneCullBus;

/**
 * Keep mesh refs in a stable array; toggle .visible from bus without React re-render.
 */
function useCullVisibility(bus: CullBus, count: number, epoch = 0) {
  const refs = useRef<(THREE.Object3D | null)[]>([]);
  const lastKey = useRef("");

  useEffect(() => {
    // `epoch` bumps when the set of subscribed objects is swapped out (scenery
    // falling back to primitives). Without it the signature guard below would
    // still hold the previous key and leave freshly mounted meshes at their
    // default `visible = true` until the camera happened to move.
    lastKey.current = "";
    return bus.subscribe((visible) => {
      // stable signature — skip if unchanged
      const key =
        visible.length === count
          ? "all"
          : visible.length === 0
            ? "none"
            : visible.join(",");
      if (key === lastKey.current) return;
      lastKey.current = key;
      const set = new Set(visible);
      for (let i = 0; i < count; i++) {
        const obj = refs.current[i];
        if (obj) obj.visible = set.has(i);
      }
    });
  }, [bus, count, epoch]);

  return refs;
}

/** Chunked sand desert — sphere-culled tiles instead of one giant disc. */
export function CullableSandTiles({
  material,
}: {
  material: THREE.Material;
}) {
  const tier = qualityManager.get().tier;
  const epoch = getTrackEpoch();
  const nominalTile = tier === "low" ? 80 : tier === "high" ? 48 : 64;

  const tiles = useMemo(
    () => {
      /*
       * Follow the heightfield rather than carrying a second copy of where it
       * is. This was `(20, 40)` at a 340m half-extent — Ash Spire's patch —
       * while the Dead Mile's patch is centred 250m away and 442m across, so
       * the underlay it is meant to back sat off to one side of it and ran out
       * before the terrain did.
       */
      const patch = terrainPatch();
      const halfExtent = Math.max(340, patch.span * 0.5 + 60);
      /*
       * Tile size scales WITH the extent so the tile COUNT is unchanged. These
       * are per-tile draw calls behind a sphere cull; growing the underlay at a
       * fixed tile size would have quietly doubled them on the long circuits,
       * which is the sort of thing that shows up as a frame-time regression
       * nobody can attribute.
       */
      const tileSize = nominalTile * (halfExtent / 340);
      return buildGroundTiles({
        centerX: patch.cx,
        centerZ: patch.cz,
        halfExtent,
        tileSize,
        y: -2.8,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nominalTile, epoch],
  );

  useEffect(() => {
    groundCullBus.setSpheres(tiles.map((t) => t.sphere));
  }, [tiles]);

  const refs = useCullVisibility(groundCullBus, tiles.length);

  return (
    <group>
      {tiles.map((t: GroundTile, i) => (
        <mesh
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          position={[t.x, -2.5, t.z]}
          rotation={[-Math.PI / 2, 0, 0]}
          receiveShadow
          frustumCulled
        >
          <planeGeometry args={[t.half * 2, t.half * 2, 1, 1]} />
          <primitive object={material} attach="material" />
        </mesh>
      ))}
    </group>
  );
}

type DuneDef = { x: number; z: number; r: number; rot: number };

export function CullableDunes({
  material,
  segments,
}: {
  material: THREE.Material;
  segments: number;
}) {
  const dunes = useMemo(() => {
    const tier = qualityManager.get().tier;
    const count = tier === "low" ? 22 : tier === "medium" ? 36 : 48;
    const out: (DuneDef & { h: number; sx: number; sz: number; gy: number })[] =
      [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + i * 0.37;
      const ring = 55 + (i % 7) * 22 + (i % 3) * 8;
      const r = 9 + (i % 5) * 4.5;
      const dx = Math.cos(a) * ring + 18 + Math.sin(i * 1.7) * 12;
      const dz = Math.sin(a) * ring + 38 + Math.cos(i * 1.3) * 10;
      out.push({
        x: dx,
        z: dz,
        // These mounds predate the heightmap terrain, when the ground was a
        // flat plane at 0 and -0.05 buried the seam. Now the ground moves under
        // them, so a fixed y leaves a hemisphere hanging over a dip or swallowed
        // by a dune.
        gy: getGroundHeight(dx, dz) - 0.05,
        r,
        rot: a + i * 0.2,
        h: 2.2 + (i % 4) * 1.4,
        sx: 1.1 + (i % 3) * 0.35,
        sz: 0.85 + (i % 4) * 0.25,
      });
    }
    return out;
  }, []);

  useEffect(() => {
    duneCullBus.setSpheres(
      dunes.map((d) => ({
        x: d.x,
        y: d.h * 0.4,
        z: d.z,
        r: d.r * 1.6,
      })),
    );
  }, [dunes]);

  const refs = useCullVisibility(duneCullBus, dunes.length);
  const segs = Math.max(8, Math.min(segments, 20));

  return (
    <group>
      {dunes.map((d, i) => (
        <mesh
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          position={[d.x, d.gy, d.z]}
          rotation={[0, d.rot, 0]}
          scale={[d.sx, Math.max(0.12, d.h / Math.max(0.1, d.r)), d.sz]}
          castShadow={i % 3 === 0}
          receiveShadow
          frustumCulled
        >
          {/* Real mound — half-sphere flattened into dune shape */}
          <sphereGeometry
            args={[
              d.r,
              segs,
              Math.max(6, Math.floor(segs / 2)),
              0,
              Math.PI * 2,
              0,
              Math.PI * 0.5,
            ]}
          />
          <primitive object={material} attach="material" />
        </mesh>
      ))}
      {/* Extra near-track berms for readable terrain beside the road */}
      {dunes.slice(0, 10).map((d, i) => (
        <mesh
          key={`berm-${i}`}
          position={[
            d.x * 0.55 + 10,
            getGroundHeight(d.x * 0.55 + 10, d.z * 0.55 + 15) + 0.1,
            d.z * 0.55 + 15,
          ]}
          rotation={[0, d.rot * 0.7, 0]}
          scale={[0.7, 0.28, 1.1]}
          receiveShadow
          frustumCulled
        >
          <sphereGeometry
            args={[d.r * 0.45, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5]}
          />
          <primitive object={material} attach="material" />
        </mesh>
      ))}
    </group>
  );
}

/* ── scenery: reclaimed refinery skyline ──────────────────────────── */

type SceneryKind = (typeof SCENERY)[number]["kind"];
type Tier = "low" | "medium" | "high";
type SkylineKey = keyof typeof SCENERY_TEMPLATE_LEN;

const TIER_RANK: Record<Tier, number> = { low: 0, medium: 1, high: 2 };
const UP = new THREE.Vector3(0, 1, 0);

/**
 * One glTF piece placed in a scenery item's local frame (metres, +Y up).
 *
 * Half of what Poly Haven publishes under an industrial name is a *kit*, not a
 * prop: modular_industrial_pipes_01 is eight loose pipe sections in one file,
 * modular_pipes is 106. Instancing every mesh in such a template would cost a
 * draw call per loose part, so `node` picks the single piece we want and the
 * rest of the file is never uploaded (three.js uploads geometry lazily, on
 * first render).
 */
type ScenerySlot = {
  key: SkylineKey;
  /** Mesh selector, tested against the mesh name and each ancestor up to the
   *  template root. Omit to take every mesh in the template. */
  node?: RegExp;
  /** Keep the template-relative transform so a model assembled from several
   *  meshes (the gantry crane) stays assembled. `len`/`thick` are ignored. */
  assembled?: boolean;
  /** Target height, measured on this piece's own bounding box — which is why
   *  SCENERY_TEMPLATE_LEN can be arbitrary for everything but the crane. */
  len?: number;
  /** Extra girth on the piece's own X/Z, applied before `rot`. Lets one thin
   *  pipe section serve as a 1.3 m flare stack and a 0.8 m trestle leg. */
  thick?: number;
  pos?: [number, number, number];
  /** Euler XYZ. Used to lay pipe sections down into horizontal runs. */
  rot?: [number, number, number];
  /** Cheapest tier that draws this piece — the only LOD lever we have, since
   *  Poly Haven ships no decimated variants. */
  minTier?: Tier;
};

/**
 * What each SCENERY kind is built from. Triangle counts are per scenery item,
 * measured off the 1k glTFs; the whole point of the composition is to spend
 * them on silhouette (tall verticals, a wide gantry) rather than on detail
 * nobody resolves from 34 m away.
 */
const SCENERY_KITS: Record<SceneryKind, ScenerySlot[]> = {
  /* Two storage vessels and a flare stack ≈ 12.1k tris. The stack is one
   * 648-triangle pipe section stretched to 12 m: the tallest thing on the
   * skyline for the price of a cylinder. */
  tower: [
    { key: "tank", len: 8.5 },
    { key: "tank", len: 5.2, pos: [4.6, 0, 1.9], rot: [0, 2.1, 0] },
    { key: "pipeRig", node: /pipe02$/, len: 12, pos: [-3.8, 0, 1.5] },
    {
      key: "pipeRig",
      node: /pipe03$/,
      len: 3.4,
      pos: [2.4, 0, -2.8],
      rot: [0, 1.1, 0],
      minTier: "medium",
    },
  ],

  /* Poly Haven's overhead_crane is a ceiling-mounted gantry with no legs, so
   * two pipe sections stand in as trestles and it reads as free-standing. The
   * beam is 49.6k tris and the (dropped) winch was another 40.3k for a 4.5 m
   * hoist block — four times the triangles per metre of silhouette, so it is
   * not instanced at any tier. Low tier drops the beam too and keeps just the
   * 56-triangle rail girder on its legs, which still reads as a gantry. */
  crane: [
    { key: "gantry", node: /rails$/, assembled: true },
    /*
     * Beam DROPPED.
     *
     * 49.6k triangles and deliberately not instanced at any tier, so every
     * visible crane was a separate 49.6k draw. It also spans ~30m, which put it
     * across the road at the landmark anchors near the start line — visible as
     * a girder hanging over the racing line with nothing to collide against,
     * since the scenery collider is a ground-level circle and the beam is
     * overhead.
     *
     * The 56-triangle rail girder below still reads as a gantry silhouette for
     * ~0.1% of the cost. Restore the beam only if it is instanced AND kept
     * clear of the track.
     */
    { key: "pipeRig", node: /pipe02$/, len: 2.9, thick: 2.6, pos: [-7.5, 0, 1.5] },
    { key: "pipeRig", node: /pipe02$/, len: 2.9, thick: 2.6, pos: [7.5, 0, 1.5] },
  ],

  /* Scrap heap. `barrel` is normalised at 1.05 to match preloadPhRaceProps, so
   * these drums reuse the race-prop template rather than loading a second copy
   * of the same mesh at a different key. */
  pile: [
    { key: "barrel", len: 1.7 },
    { key: "barrel", len: 1.7, pos: [1.3, 0, 0.7], rot: [0, 0.9, 0] },
    { key: "barrel", len: 1.7, pos: [-0.5, 0, 1.5], rot: [0, 2.2, 0] },
    {
      key: "barrel",
      len: 1.6,
      pos: [0.4, 1.55, 0.4],
      rot: [0, 0.5, 0],
      minTier: "medium",
    },
    {
      key: "rack",
      len: 3,
      pos: [-2.2, 0, -0.8],
      rot: [0, 0.4, 0],
      minTier: "medium",
    },
    // Tipped drum: rotated onto its side, then lifted by its own radius so it
    // rests on the sand instead of sinking half-way into it.
    {
      key: "barrel",
      len: 1.7,
      pos: [2.4, 0.54, -1.2],
      rot: [Math.PI / 2, 0, 0],
      minTier: "high",
    },
  ],

  /* Elevated pipe run on trestles. The run is a pipe section rotated -90° about
   * Z, which maps its local +Y length onto world +X; `pos.x` then re-centres
   * the 9 m span on the item origin. */
  pipe: [
    {
      key: "pipeRig",
      node: /pipe02$/,
      len: 9,
      thick: 1.8,
      rot: [0, 0, -Math.PI / 2],
      pos: [-4.5, 2.6, 0],
    },
    { key: "pipeRig", node: /pipe02$/, len: 2.6, thick: 2.8, pos: [-3.6, 0, 0] },
    { key: "pipeRig", node: /pipe02$/, len: 2.6, thick: 2.8, pos: [3.6, 0, 0] },
    {
      key: "pipeRig",
      node: /pipe03$/,
      len: 3.6,
      pos: [4.4, 0, 1.6],
      rot: [0, 0.8, 0],
      minTier: "medium",
    },
    // No valve cluster here on purpose: pipe08 is 5.8k triangles for a 1.4 m
    // fitting that covers a couple of pixels at this distance.
  ],
};

/** Cull sphere per kind, sized to the kit above rather than the old boxes. */
const KIND_SPHERE: Record<SceneryKind, { y: number; r: number }> = {
  tower: { y: 5, r: 8 },
  crane: { y: 4, r: 11 },
  pile: { y: 1.5, r: 4 },
  pipe: { y: 2, r: 6 },
};

/** An InstancedMesh plus what the cull bus needs to rebuild its stream. */
type SceneryBatch = {
  mesh: THREE.InstancedMesh;
  /** Full transform per instance, in creation order. */
  base: THREE.Matrix4[];
  /** SCENERY index each instance belongs to. */
  item: Int32Array;
};

/** True if `re` matches the mesh's name or any ancestor's up to `root`. */
function nodeMatches(
  mesh: THREE.Object3D,
  root: THREE.Object3D,
  re: RegExp,
): boolean {
  let o: THREE.Object3D | null = mesh;
  while (o) {
    if (re.test(o.name)) return true;
    if (o === root) return false;
    o = o.parent;
  }
  return false;
}

/**
 * Transform putting one template mesh into the slot's local frame: centred on
 * X/Z, sitting on y = 0, scaled so its own height is `len`.
 */
function partMatrix(mesh: THREE.Mesh, slot: ScenerySlot): THREE.Matrix4 {
  const rel = mesh.matrixWorld;
  if (slot.assembled) return rel.clone();
  const geo = mesh.geometry;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = geo.boundingBox!.clone().applyMatrix4(rel);
  const k = (slot.len ?? 1) / Math.max(bb.max.y - bb.min.y, 1e-4);
  const t = slot.thick ?? 1;
  return new THREE.Matrix4()
    .makeScale(k * t, k, k * t)
    .multiply(
      new THREE.Matrix4().makeTranslation(
        -(bb.min.x + bb.max.x) * 0.5,
        -bb.min.y,
        -(bb.min.z + bb.max.z) * 0.5,
      ),
    )
    .multiply(rel);
}

function slotMatrix(slot: ScenerySlot): THREE.Matrix4 {
  const [px, py, pz] = slot.pos ?? [0, 0, 0];
  const [rx, ry, rz] = slot.rot ?? [0, 0, 0];
  return new THREE.Matrix4().compose(
    new THREE.Vector3(px, py, pz),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(1, 1, 1),
  );
}

/**
 * Build the instanced skyline for the current tier.
 *
 * Placements are bucketed by (geometry, material) rather than by slot, so a
 * pipe section reused as a flare stack, a trestle leg and a pipe run collapses
 * into a single InstancedMesh — roughly a dozen draw calls for the whole
 * skyline, against the ~55 loose meshes the primitive version drew.
 *
 * Returns the kinds that actually got geometry; anything missing (404, renamed
 * node) is simply absent, and the caller keeps drawing primitives for it.
 */
async function buildSceneryBatches(
  items: typeof SCENERY,
  tier: Tier,
): Promise<{ batches: SceneryBatch[]; kinds: SceneryKind[] }> {
  const rank = TIER_RANK[tier];
  const kinds = Object.keys(SCENERY_KITS) as SceneryKind[];
  const allowed = (s: ScenerySlot) => TIER_RANK[s.minTier ?? "low"] <= rank;

  const needed = new Set<SkylineKey>();
  for (const k of kinds) {
    for (const slot of SCENERY_KITS[k]) if (allowed(slot)) needed.add(slot.key);
  }

  const loaded = new Map<SkylineKey, THREE.Group>();
  await Promise.all(
    [...needed].map(async (key) => {
      try {
        const tpl = await loadPhModel(
          key as PhModelKey,
          SCENERY_TEMPLATE_LEN[key],
        );
        tpl.updateMatrixWorld(true);
        loaded.set(key, tpl);
      } catch {
        /* Missing asset — that slot's kind stays on its primitive. */
      }
    }),
  );

  // Which SCENERY entries each kind owns. Low tier keeps every other item, the
  // same thinning the primitive path has always applied.
  const byKind = new Map<SceneryKind, number[]>();
  for (let i = 0; i < items.length; i++) {
    if (tier === "low" && i % 2 === 1) continue;
    const list = byKind.get(items[i].kind);
    if (list) list.push(i);
    else byKind.set(items[i].kind, [i]);
  }

  type Bucket = {
    geo: THREE.BufferGeometry;
    mat: THREE.Material;
    list: { m: THREE.Matrix4; item: number }[];
  };
  const buckets = new Map<string, Bucket>();
  const covered = new Set<SceneryKind>();

  const itemM = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();

  for (const kind of kinds) {
    const idx = byKind.get(kind);
    if (!idx?.length) continue;
    for (const slot of SCENERY_KITS[kind]) {
      if (!allowed(slot)) continue;
      const tpl = loaded.get(slot.key);
      if (!tpl) continue;

      const picked: THREE.Mesh[] = [];
      tpl.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.geometry) return;
        if (slot.node && !nodeMatches(m, tpl, slot.node)) return;
        picked.push(m);
      });
      // A renamed node upstream must not silently empty the skyline.
      if (!picked.length) continue;

      const local = slotMatrix(slot);
      for (const m of picked) {
        const mat = Array.isArray(m.material) ? m.material[0] : m.material;
        if (!mat) continue;
        const full = new THREE.Matrix4().multiplyMatrices(
          local,
          partMatrix(m, slot),
        );
        const bk = `${m.geometry.uuid}|${mat.uuid}`;
        let b = buckets.get(bk);
        if (!b) {
          b = { geo: m.geometry, mat, list: [] };
          buckets.set(bk, b);
        }
        for (const i of idx) {
          const s = items[i];
          itemM.compose(
            pos.set(s.x, s.y, s.z),
            quat.setFromAxisAngle(UP, s.rot),
            scl.setScalar(s.scale),
          );
          b.list.push({
            m: new THREE.Matrix4().multiplyMatrices(itemM, full),
            item: i,
          });
        }
        covered.add(kind);
      }
    }
  }

  const batches: SceneryBatch[] = [];
  for (const b of buckets.values()) {
    const im = new THREE.InstancedMesh(b.geo, b.mat, b.list.length);
    // Background dressing 34 m+ off the racing line: nothing casts onto it and
    // its own shadows never land anywhere the player looks, so it stays out of
    // both shadow passes. This is strictly fewer casters than the boxes it
    // replaces, which cast whenever allVehicleShadows was on.
    im.castShadow = false;
    im.receiveShadow = false;
    // Instances span the whole circuit, so three's per-object frustum test is
    // useless here — sceneryCullBus drives visibility per instance instead.
    im.frustumCulled = false;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const item = new Int32Array(b.list.length);
    const base: THREE.Matrix4[] = [];
    for (let i = 0; i < b.list.length; i++) {
      im.setMatrixAt(i, b.list[i].m);
      base.push(b.list[i].m);
      item[i] = b.list[i].item;
    }
    im.instanceMatrix.needsUpdate = true;
    batches.push({ mesh: im, base, item });
  }

  return { batches, kinds: [...covered] };
}

export function CullableScenery() {
  const sceneryEpoch = getTrackEpoch();
  // getScenery(), and keyed on the epoch: SCENERY is an `export let` whose
  // array identity is REPLACED on every track change, so a useMemo with an
  // empty dep list held the previous circuit's items forever.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => getScenery(), [sceneryEpoch]);
  const mats = useMemo(() => {
    const rust = createProcMaterial("rust", {
      color: "#a16207",
      repeat: [1, 1],
      gpuDetail: false,
    });
    const metal = createProcMaterial("metal", {
      color: "#78716c",
      repeat: [0.8, 0.8],
      gpuDetail: qualityManager.get().tier === "high",
    });
    const dark = new THREE.MeshStandardMaterial({
      color: "#292524",
      roughness: 0.85,
      metalness: 0.35,
    });
    return { rust, metal, dark };
  }, []);

  const tier = qualityManager.get().tier;
  const instRoot = useRef<THREE.Group>(null);
  const batches = useRef<SceneryBatch[]>([]);
  const flags = useRef<Uint8Array>(new Uint8Array(0));
  const lastKey = useRef("");
  /** Kinds currently drawn as glTF; the rest keep their primitive. */
  const [modelled, setModelled] = useState<SceneryKind[]>([]);

  useEffect(() => {
    sceneryCullBus.setSpheres(
      items.map((s) => {
        const k = KIND_SPHERE[s.kind];
        return { x: s.x, y: s.y + k.y * s.scale, z: s.z, r: k.r * s.scale };
      }),
    );
  }, [items]);

  // Build the instanced skyline. Templates are warmed by preloadSceneryModels
  // during the loading screen, so in practice this resolves on the first frame
  // and the primitives below are never seen.
  useEffect(() => {
    let alive = true;
    const root = instRoot.current;
    if (!root) return;

    void (async () => {
      const built = await buildSceneryBatches(items, tier);
      if (!alive || !instRoot.current) {
        for (const b of built.batches) b.mesh.dispose();
        return;
      }
      for (const b of built.batches) instRoot.current.add(b.mesh);
      batches.current = built.batches;
      flags.current = new Uint8Array(items.length);
      lastKey.current = "";
      // Empty when every template 404'd — primitives simply stay up.
      setModelled(built.kinds);
    })();

    return () => {
      alive = false;
      for (const b of batches.current) {
        root.remove(b.mesh);
        // Disposes the instance buffers only; geometry and materials belong to
        // the shared template cache and must outlive this component.
        b.mesh.dispose();
      }
      batches.current = [];
      lastKey.current = "";
    };
  }, [items, tier]);

  // Same sceneryCullBus that drove mesh.visible, applied to instance streams:
  // visible instances are packed to the front and `count` is trimmed. Collapsing
  // hidden instances to a zero matrix (the usual trick) would still run the
  // vertex shader for every one of the crane's 49.6k triangles.
  useEffect(() => {
    return sceneryCullBus.subscribe((visible) => {
      const bs = batches.current;
      if (!bs.length) return;
      const key =
        visible.length === items.length ? "all" : visible.join(",");
      if (key === lastKey.current) return;
      lastKey.current = key;

      const flag = flags.current;
      flag.fill(0);
      for (const i of visible) flag[i] = 1;

      for (const b of bs) {
        let n = 0;
        for (let i = 0; i < b.item.length; i++) {
          if (flag[b.item[i]]) b.mesh.setMatrixAt(n++, b.base[i]);
        }
        b.mesh.count = n;
        b.mesh.instanceMatrix.needsUpdate = true;
      }
    });
  }, [items.length]);

  const covered = useMemo(() => new Set(modelled), [modelled]);
  const refs = useCullVisibility(sceneryCullBus, items.length, covered.size);
  const cast = qualityManager.get().allVehicleShadows;
  const low = tier === "low";

  return (
    <group>
      <group ref={instRoot} />
      {items.map((s, i) => {
        if (low && i % 2 === 1) return null;
        // Fallback only: a kind with real geometry draws no primitive.
        if (covered.has(s.kind)) return null;
        const y = s.y;
        const body =
          s.kind === "tower" ? (
            <>
              <mesh position={[0, 4, 0]} castShadow={cast} receiveShadow>
                <boxGeometry args={[2.2, 8, 2.2]} />
                <primitive object={mats.metal} attach="material" />
              </mesh>
              <mesh position={[0, 8.4, 0]} castShadow={cast}>
                <boxGeometry args={[3.2, 0.5, 3.2]} />
                <primitive object={mats.rust} attach="material" />
              </mesh>
            </>
          ) : s.kind === "crane" ? (
            <>
              <mesh position={[0, 3, 0]} castShadow={cast}>
                <boxGeometry args={[1.4, 6, 1.4]} />
                <primitive object={mats.metal} attach="material" />
              </mesh>
              <mesh position={[3, 6.2, 0]} castShadow={cast}>
                <boxGeometry args={[7, 0.45, 0.7]} />
                <primitive object={mats.rust} attach="material" />
              </mesh>
              <mesh position={[6.2, 4.5, 0]} castShadow={cast}>
                <boxGeometry args={[0.25, 3.2, 0.25]} />
                <primitive object={mats.dark} attach="material" />
              </mesh>
            </>
          ) : s.kind === "pile" ? (
            <>
              <mesh position={[0, 0.8, 0]} castShadow={cast} receiveShadow>
                <boxGeometry args={[3.5, 1.6, 2.4]} />
                <primitive object={mats.rust} attach="material" />
              </mesh>
              <mesh position={[0.6, 1.9, 0.2]} rotation={[0.2, 0.4, 0.1]} castShadow={cast}>
                <boxGeometry args={[2.2, 0.7, 1.4]} />
                <primitive object={mats.metal} attach="material" />
              </mesh>
            </>
          ) : (
            <>
              <mesh
                position={[0, 1.2, 0]}
                rotation={[0, 0, Math.PI / 2]}
                castShadow={cast}
                receiveShadow
              >
                <cylinderGeometry args={[0.55, 0.55, 5.5, low ? 6 : 10]} />
                <primitive object={mats.metal} attach="material" />
              </mesh>
              <mesh position={[-2.4, 0.9, 0]} castShadow={cast}>
                <cylinderGeometry args={[0.7, 0.85, 1.6, low ? 6 : 8]} />
                <primitive object={mats.rust} attach="material" />
              </mesh>
            </>
          );

        return (
          <group
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            position={[s.x, y, s.z]}
            rotation={[0, s.rot, 0]}
            scale={s.scale}
          >
            {body}
          </group>
        );
      })}
    </group>
  );
}
