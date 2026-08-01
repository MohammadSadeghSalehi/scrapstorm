/**
 * Visible, pooled world props posed from sim.state.props every frame, plus the
 * instanced debris field their destruction leaves behind.
 * Starts with lightweight primitives; swaps PH meshes when ready.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { GameSimulation } from "../sim";
import type { PhysProp } from "../worldProps";
import { FRAME } from "./framePriority";
import { qualityManager } from "./quality";
import { clonePbrPack, isPbrLibraryReady } from "./webgl2/textureLibrary";
import { loadPhModel, type PhModelKey } from "./polyHavenAssets";
import {
  DEBRIS_FADE,
  DEBRIS_MAX,
  DEBRIS_SHAPE_COUNT,
  debrisActiveCount,
  debrisPool,
} from "./debris";

// Smaller pools — 68 full PH clones was a mid-race hitch
const POOL = { barrel: 14, crate: 12, scrap: 10 } as const;

type PropVisualKind = "barrel" | "crate" | "scrap";

/**
 * How each material deforms as `dent` climbs to 1.
 *
 * `dent` used to drive a single uniform 12% shrink, which is invisible in
 * motion — a prop you had clipped twice looked box-fresh right up until it
 * disappeared. Non-uniform crush plus a lean gives damage a silhouette.
 */
const CRUSH: Record<PropVisualKind, { squash: number; bulge: number; lean: number }> = {
  // Sheet steel folds: it gets shorter and fatter, and ends up off its base.
  barrel: { squash: 0.3, bulge: 0.16, lean: 0.32 },
  // Panels stave in rather than bulge, and a broken crate slumps.
  crate: { squash: 0.22, bulge: 0.09, lean: 0.24 },
  // Already a heap — it just spreads and settles.
  scrap: { squash: 0.13, bulge: 0.17, lean: 0.09 },
};

/** Colour damaged paint/timber tends toward — burnt, not just dark. */
const SCORCH = new THREE.Color("#2f2724");
/** Heat bleed on a barrel that is one hit from rupturing. */
const EMBER = new THREE.Color("#b4380a");

function makeFallbackMats() {
  const scrapP = isPbrLibraryReady() ? clonePbrPack("scrap_panel", 1.1, 1.1) : null;
  const metalP = isPbrLibraryReady() ? clonePbrPack("metal", 1, 1) : null;
  return {
    crate: new THREE.MeshStandardMaterial({
      color: "#d6c7b0",
      map: scrapP?.map ?? null,
      normalMap: scrapP?.normalMap ?? null,
      roughness: 0.78,
      metalness: 0.22,
      envMapIntensity: 0.95,
    }),
    scrap: new THREE.MeshStandardMaterial({
      color: "#a8a29e",
      map: metalP?.map ?? null,
      normalMap: metalP?.normalMap ?? null,
      roughness: 0.62,
      metalness: 0.55,
      envMapIntensity: 1.0,
    }),
    barrel: new THREE.MeshStandardMaterial({
      color: "#ea580c",
      roughness: 0.45,
      metalness: 0.4,
      emissive: "#9a3412",
      emissiveIntensity: 0.2,
      envMapIntensity: 1.0,
    }),
  };
}

/**
 * Prop bodies, centred on the group origin.
 *
 * These meshes used to be lifted inside the group — barrel +0.48, crate +0.42,
 * scrap +0.25 — on the assumption that the group sits on the GROUND. It does
 * not: the group is placed at `p.y`, which the physics rests at the prop's
 * centre height. So the offset was applied twice and every prop on the track
 * floated by half its own body: 0.485m for a barrel, 0.415m for a crate.
 *
 * Centring them here makes `p.y` mean one thing, and PROP_REST_OFFSET the only
 * place that decides how high that is.
 */
function makePrimitive(kind: PropVisualKind, mats: ReturnType<typeof makeFallbackMats>) {
  const g = new THREE.Group();
  if (kind === "barrel") {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.4, 0.95, 10), mats.barrel);
    m.castShadow = true;
    g.add(m);
  } else if (kind === "crate") {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.85, 0.95), mats.crate);
    m.castShadow = true;
    g.add(m);
  } else {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.45, 0.85), mats.scrap);
    m.castShadow = true;
    g.add(m);
  }
  return g;
}

/** A cloned material plus the pristine values damage shading interpolates from. */
type SlotMat = {
  mat: THREE.MeshStandardMaterial;
  baseColor: THREE.Color;
  baseEmissive: THREE.Color;
  baseEmissiveIntensity: number;
  baseRoughness: number;
};

type Slot = {
  group: THREE.Group;
  kind: PropVisualKind;
  propId: string | null;
  variant: number;
  mats: SlotMat[];
  /** Last dent this slot's materials were shaded for; -1 forces a refresh. */
  lastDent: number;
  /** Survives the per-frame propId reset, so a slot swap re-shades. */
  boundId: string | null;
  /** Stable 0..1 per prop — picks the lean direction so it does not jitter. */
  hash: number;
};

/**
 * Give every slot its own material instances.
 *
 * `Object3D.clone(true)` shares material references with the template, so
 * scorching one damaged barrel would scorch every barrel on the track at once.
 * Textures are still shared (clone() copies references), so the cost is a
 * handful of uniform blocks, not VRAM.
 */
function isolateMaterials(root: THREE.Object3D, castShadow: boolean): SlotMat[] {
  const out: SlotMat[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = castShadow;
    m.receiveShadow = true;
    const src = Array.isArray(m.material) ? m.material : [m.material];
    const cloned = src.map((mat) => {
      const c = mat.clone() as THREE.MeshStandardMaterial;
      if (c.isMeshStandardMaterial) {
        out.push({
          mat: c,
          baseColor: c.color.clone(),
          baseEmissive: c.emissive.clone(),
          baseEmissiveIntensity: c.emissiveIntensity,
          baseRoughness: c.roughness,
        });
      }
      return c;
    });
    m.material = Array.isArray(m.material) ? cloned : cloned[0]!;
  });
  return out;
}

/** FNV-1a over the prop id → stable 0..1. */
function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 4096) / 4096;
}

function pickPhKey(kind: PropVisualKind, variant: number): PhModelKey {
  if (kind === "barrel") return variant % 2 === 0 ? "barrel" : "barrelAlt";
  if (kind === "crate") return variant % 2 === 0 ? "crate" : "box";
  const v = variant % 3;
  if (v === 0) return "tyre";
  if (v === 1) return "jerrycan";
  return "rim";
}

function targetLenFor(kind: PropVisualKind, key: PhModelKey): number {
  if (key === "jerrycan") return 0.65;
  if (key === "tyre") return 0.95;
  if (key === "rim") return 0.85;
  if (key === "box") return 1.0;
  if (kind === "crate") return 1.15;
  return 1.05;
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export function PhysicsPropsView({ sim }: { sim: GameSimulation }) {
  const rootRef = useRef<THREE.Group>(null);
  const slotsRef = useRef<Slot[]>([]);
  const [phReady, setPhReady] = useState(false);
  const [pbrTick, setPbrTick] = useState(0);
  const mats = useMemo(() => makeFallbackMats(), [pbrTick]);
  const playerPos = useRef(new THREE.Vector3());
  const builtKey = useRef("");
  const phTemplates = useRef<Partial<Record<string, THREE.Group>>>({});
  /** Reused each frame — the old filter/map/sort chain allocated ~3 arrays and
   *  one wrapper object per visible prop, every frame, at 150fps. */
  const visible = useRef<{ p: PhysProp; d2: number }[]>([]);

  useEffect(() => {
    let alive = true;
    const t = window.setInterval(() => {
      if (isPbrLibraryReady()) {
        setPbrTick((n) => n + 1);
        window.clearInterval(t);
      }
    }, 200);

    // Only one template per kind — not 12 parallel GLTF loads
    void (async () => {
      const kinds: PropVisualKind[] = ["barrel", "crate", "scrap"];
      for (const kind of kinds) {
        if (!alive) return;
        const key = pickPhKey(kind, 0);
        try {
          const g = await loadPhModel(key, targetLenFor(kind, key));
          phTemplates.current[`${kind}:0`] = g;
        } catch (e) {
          // Silently falling back to primitives is why the track was lined
          // with untextured boxes and cylinders without any visible error.
          console.warn(`[props] no mesh for ${kind} (${key}) — using primitive`, e);
        }
      }
      if (typeof window !== "undefined") {
        window.__propsDebug = {
          templates: Object.keys(phTemplates.current).filter(
            (k) => !!phTemplates.current[k],
          ),
        };
      }
      if (alive) setPhReady(true);
    })();

    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const key = `${phReady}|${pbrTick}|${qualityManager.get().tier}`;
    if (builtKey.current === key && slotsRef.current.length) return;
    builtKey.current = key;
    // Per-slot material clones are ours to free — a rebuild on every tier
    // change would otherwise leak one uniform block per prop per rebuild.
    for (const s of slotsRef.current) for (const sm of s.mats) sm.mat.dispose();
    while (root.children.length) root.remove(root.children[0]);
    const slots: Slot[] = [];
    const cast = qualityManager.get().tier !== "low";

    const addKind = (kind: PropVisualKind, count: number) => {
      for (let i = 0; i < count; i++) {
        const variant = i;
        const mesh: THREE.Object3D | null =
          phTemplates.current[`${kind}:0`]?.clone(true) ?? null;
        const group = new THREE.Group();
        const child = mesh ?? makePrimitive(kind, mats);
        const slotMats = isolateMaterials(child, cast);
        group.add(child);
        group.visible = false;
        root.add(group);
        slots.push({
          group,
          kind,
          propId: null,
          variant,
          mats: slotMats,
          lastDent: -1,
          boundId: null,
          hash: 0,
        });
      }
    };
    addKind("barrel", POOL.barrel);
    addKind("crate", POOL.crate);
    addKind("scrap", POOL.scrap);
    slotsRef.current = slots;
  }, [phReady, pbrTick, mats]);

  useFrame(() => {
    const props = sim.state.props as PhysProp[];
    const player = sim.state.vehicles.find((v) => v.isPlayer);
    if (player) playerPos.current.set(player.x, player.y, player.z);

    const tier = qualityManager.get().tier;
    const maxDist = tier === "low" ? 60 : tier === "medium" ? 95 : 120;
    const maxD2 = maxDist * maxDist;

    for (const s of slotsRef.current) {
      s.propId = null;
      s.group.visible = false;
    }

    const byKind: Record<string, Slot[]> = { barrel: [], crate: [], scrap: [] };
    for (const s of slotsRef.current) byKind[s.kind]!.push(s);

    const px = playerPos.current.x;
    const pz = playerPos.current.z;

    const list = visible.current;
    let n = 0;
    for (const p of props) {
      if (p.dead || !p.dynamic || p.kind === "barrier") continue;
      const dx = p.x - px;
      const dz = p.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= maxD2) continue;
      const e = list[n];
      if (e) {
        e.p = p;
        e.d2 = d2;
      } else {
        list[n] = { p, d2 };
      }
      n++;
    }
    // Insertion sort: the order barely changes frame to frame, so this is
    // effectively linear and costs no allocation, unlike Array.sort on a
    // freshly-built array.
    for (let i = 1; i < n; i++) {
      const cur = list[i]!;
      let j = i - 1;
      while (j >= 0 && list[j]!.d2 > cur.d2) {
        list[j + 1] = list[j]!;
        j--;
      }
      list[j + 1] = cur;
    }

    for (let i = 0; i < n; i++) {
      const p = list[i]!.p;
      const kind = p.kind as PropVisualKind;
      const pool = byKind[kind];
      if (!pool?.length) continue;
      const slot = pool.find((s) => s.propId === null);
      if (!slot) continue;
      slot.propId = p.id;
      if (slot.boundId !== p.id) {
        slot.boundId = p.id;
        slot.hash = hashId(p.id);
        slot.lastDent = -1;
      }

      const g = slot.group;
      g.visible = true;
      g.position.set(p.x, p.y, p.z);

      const dent = p.dent;
      const c = CRUSH[kind];
      // Airborne props used to only yaw, so a barrel punted 3m into the air
      // slid through the sky bolt upright. Deriving the tumble phase from yaw
      // (which p.spin already integrates) keeps it coherent with the spin and
      // needs no per-slot state, so a pool slot swap cannot pop the pose.
      // Ground-relative, from the prop itself. An absolute constant here meant
      // a prop sitting on a raised section read as permanently airborne and
      // tumbled while stationary.
      const restY = p.restY ?? p.y;
      const air = clamp01((p.y - restY) / 1.1) * 0.85;
      const leanA = slot.hash * Math.PI * 2;

      g.rotation.y = p.yaw;
      g.rotation.x =
        Math.sin(p.yaw * 1.7) * air +
        Math.min(0.6, Math.abs(p.vx) + Math.abs(p.vz)) * 0.02 +
        Math.cos(leanA) * dent * c.lean;
      g.rotation.z =
        p.spin * 0.15 + Math.cos(p.yaw * 1.3) * air + Math.sin(leanA) * dent * c.lean;
      g.scale.set(
        p.scale * (1 + dent * c.bulge),
        p.scale * (1 - dent * c.squash),
        p.scale * (1 + dent * c.bulge),
      );

      // Material writes are the expensive half of this, and dent only moves on
      // impact — re-shade on a real change, not every frame.
      if (Math.abs(dent - slot.lastDent) > 0.02) {
        slot.lastDent = dent;
        for (const sm of slot.mats) {
          sm.mat.color.copy(sm.baseColor).lerp(SCORCH, dent * 0.62);
          sm.mat.roughness = Math.min(1, sm.baseRoughness + dent * 0.32);
          if (kind === "barrel") {
            // A primed barrel ruptures early (see BARREL_RUPTURE_SPEED), so it
            // has to *look* primed — this is the tell that it is worth aiming
            // at. Quadratic so it only really shows in the last third.
            sm.mat.emissive.copy(sm.baseEmissive).lerp(EMBER, dent);
            sm.mat.emissiveIntensity = sm.baseEmissiveIntensity + dent * dent * 0.95;
          }
        }
      }
    }
  }, FRAME.LATE);

  return (
    <>
      <group ref={rootRef} />
      <DebrisField sim={sim} />
    </>
  );
}

/** Shape index → geometry + surface. Order must match DEBRIS_SHAPE. */
const DEBRIS_SHAPES = [
  { key: "chunk", roughness: 0.55, metalness: 0.6 },
  { key: "plank", roughness: 0.88, metalness: 0.04 },
  { key: "slab", roughness: 0.95, metalness: 0.02 },
  { key: "panel", roughness: 0.42, metalness: 0.72 },
] as const;

/**
 * InstancedMesh tints through `instanceColor`, but this build of three only
 * multiplies vColor into the fragment under `USE_COLOR` — i.e. the material
 * needs `vertexColors`, which in turn needs a real `color` attribute or the
 * unbound generic attribute resolves to (0,0,0) and every chunk renders black.
 */
function withWhiteColors(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const count = geo.getAttribute("position").count;
  geo.setAttribute(
    "color",
    new THREE.BufferAttribute(new Float32Array(count * 3).fill(1), 3),
  );
  return geo;
}

/**
 * The chunks a destroyed prop breaks into, drawn as four instanced meshes —
 * one per shape family, so the whole debris field is four draw calls no matter
 * how many pieces are live. Mounted here rather than in GameScene so the sim
 * and its wreckage stay a single unit.
 */
function DebrisField({ sim }: { sim: GameSimulation }) {
  const meshes = useRef<(THREE.InstancedMesh | null)[]>([]);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);

  const geos = useMemo(
    () => [
      // Irregular solid — torn metal, rubble
      withWhiteColors(new THREE.IcosahedronGeometry(0.17, 0)),
      // Long and thin — crate slats
      withWhiteColors(new THREE.BoxGeometry(0.62, 0.1, 0.18)),
      // Heavy and flat — concrete
      withWhiteColors(new THREE.BoxGeometry(0.46, 0.18, 0.4)),
      // Thin sheet — barrel wall, body panel
      withWhiteColors(new THREE.BoxGeometry(0.4, 0.06, 0.32)),
    ],
    [],
  );

  useEffect(() => {
    const owned = geos;
    return () => {
      for (const g of owned) g.dispose();
    };
  }, [geos]);

  useFrame(() => {
    const list = meshes.current;
    if (list.length < DEBRIS_SHAPE_COUNT) return;

    const tier = qualityManager.get().tier;
    const cast = tier !== "low";
    // Hard per-tier draw cap on top of the pool's own DEBRIS_MAX, so a low-end
    // machine in the middle of a chain reaction sheds chunks rather than frames.
    const cap = tier === "low" ? 24 : tier === "medium" ? 56 : DEBRIS_MAX;
    const cull = tier === "low" ? 55 : tier === "medium" ? 85 : 120;
    const cull2 = cull * cull;

    const counts = [0, 0, 0, 0];
    const active = debrisActiveCount();

    if (active > 0) {
      const player = sim.state.vehicles.find((v) => v.isPlayer);
      const px = player?.x ?? 0;
      const pz = player?.z ?? 0;
      const pool = debrisPool();
      let drawn = 0;

      for (let i = 0; i < pool.length && drawn < cap; i++) {
        const d = pool[i]!;
        if (!d.active) continue;
        const dx = d.x - px;
        const dz = d.z - pz;
        // AI cars destroy props on the far side of the lap; nobody needs to
        // pay to pose that wreckage.
        if (dx * dx + dz * dz > cull2) continue;
        const mesh = list[d.shape];
        if (!mesh) continue;

        // Shrink and sink out instead of popping. Sinking as well as shrinking
        // stops the last frames reading as a chunk shrivelling in mid-air.
        const fade = Math.min(1, d.life / DEBRIS_FADE);
        const s = d.scale * (0.4 + 0.6 * fade);
        dummy.position.set(d.x, d.y - (1 - fade) * 0.3 * d.scale, d.z);
        dummy.rotation.set(d.rx, d.ry, d.rz);
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();

        const idx = counts[d.shape]!;
        mesh.setMatrixAt(idx, dummy.matrix);
        color.set(d.colorHex).multiplyScalar(d.tint);
        mesh.setColorAt(idx, color);
        counts[d.shape] = idx + 1;
        drawn++;
      }
    }

    // Park the tail of each pool out of sight rather than resizing `count`:
    // three reallocates nothing either way, and a stale matrix left behind is
    // the classic "one chunk frozen on the track" artefact.
    dummy.position.set(0, -900, 0);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(0.0001);
    dummy.updateMatrix();
    for (let s = 0; s < DEBRIS_SHAPE_COUNT; s++) {
      const mesh = list[s];
      if (!mesh) continue;
      if (mesh.castShadow !== cast) mesh.castShadow = cast;
      for (let i = counts[s]!; i < DEBRIS_MAX; i++) mesh.setMatrixAt(i, dummy.matrix);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }, FRAME.LATE);

  return (
    <group>
      {DEBRIS_SHAPES.map((shape, i) => (
        <instancedMesh
          key={shape.key}
          ref={(m) => {
            meshes.current[i] = m as THREE.InstancedMesh | null;
          }}
          args={[undefined, undefined, DEBRIS_MAX]}
          frustumCulled={false}
          receiveShadow
        >
          <primitive object={geos[i]!} attach="geometry" />
          <meshStandardMaterial
            vertexColors
            roughness={shape.roughness}
            metalness={shape.metalness}
            envMapIntensity={1.05}
          />
        </instancedMesh>
      ))}
    </group>
  );
}

declare global {
  interface Window {
    /** Which physics-prop templates resolved to real meshes (QA). */
    __propsDebug?: { templates: string[] };
  }
}
