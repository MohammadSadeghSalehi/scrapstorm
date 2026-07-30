/**
 * Visible, pooled world props posed from sim.state.props every frame.
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

// Smaller pools — 68 full PH clones was a mid-race hitch
const POOL = { barrel: 14, crate: 12, scrap: 10 } as const;

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

function makePrimitive(kind: "barrel" | "crate" | "scrap", mats: ReturnType<typeof makeFallbackMats>) {
  const g = new THREE.Group();
  if (kind === "barrel") {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.4, 0.95, 10), mats.barrel);
    m.castShadow = true;
    m.position.y = 0.48;
    g.add(m);
  } else if (kind === "crate") {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.85, 0.95), mats.crate);
    m.castShadow = true;
    m.position.y = 0.42;
    g.add(m);
  } else {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.45, 0.85), mats.scrap);
    m.castShadow = true;
    m.position.y = 0.25;
    g.add(m);
  }
  return g;
}

type Slot = {
  group: THREE.Group;
  kind: "barrel" | "crate" | "scrap";
  propId: string | null;
  variant: number;
};

function pickPhKey(kind: "barrel" | "crate" | "scrap", variant: number): PhModelKey {
  if (kind === "barrel") return variant % 2 === 0 ? "barrel" : "barrelAlt";
  if (kind === "crate") return variant % 2 === 0 ? "crate" : "box";
  const v = variant % 3;
  if (v === 0) return "tyre";
  if (v === 1) return "jerrycan";
  return "rim";
}

function targetLenFor(kind: "barrel" | "crate" | "scrap", key: PhModelKey): number {
  if (key === "jerrycan") return 0.65;
  if (key === "tyre") return 0.95;
  if (key === "rim") return 0.85;
  if (key === "box") return 1.0;
  if (kind === "crate") return 1.15;
  return 1.05;
}

export function PhysicsPropsView({ sim }: { sim: GameSimulation }) {
  const rootRef = useRef<THREE.Group>(null);
  const slotsRef = useRef<Slot[]>([]);
  const [phReady, setPhReady] = useState(false);
  const [pbrTick, setPbrTick] = useState(0);
  const mats = useMemo(() => makeFallbackMats(), [pbrTick]);
  const playerPos = useRef(new THREE.Vector3());
  const builtKey = useRef("");
  const phTemplates = useRef<Partial<Record<string, THREE.Group>>>({});

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
      const kinds: ("barrel" | "crate" | "scrap")[] = ["barrel", "crate", "scrap"];
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
    while (root.children.length) root.remove(root.children[0]);
    const slots: Slot[] = [];
    const cast = qualityManager.get().tier !== "low";

    const addKind = (kind: "barrel" | "crate" | "scrap", count: number) => {
      for (let i = 0; i < count; i++) {
        const variant = i;
        let mesh: THREE.Object3D | null =
          phTemplates.current[`${kind}:0`]?.clone(true) ?? null;
        const group = new THREE.Group();
        if (mesh) {
          mesh.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.isMesh) {
              m.castShadow = cast;
              m.receiveShadow = true;
            }
          });
          group.add(mesh);
        } else {
          group.add(makePrimitive(kind, mats));
        }
        group.visible = false;
        root.add(group);
        slots.push({ group, kind, propId: null, variant });
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
    for (const s of slotsRef.current) byKind[s.kind].push(s);

    const px = playerPos.current.x;
    const pz = playerPos.current.z;

    const live = props
      .filter((p) => !p.dead && p.dynamic)
      .map((p) => {
        const dx = p.x - px;
        const dz = p.z - pz;
        return { p, d2: dx * dx + dz * dz };
      })
      .filter((x) => x.d2 < maxD2)
      .sort((a, b) => a.d2 - b.d2);

    for (const { p } of live) {
      if (p.kind === "barrier") continue;
      const kind = p.kind as "barrel" | "crate" | "scrap";
      const pool = byKind[kind];
      if (!pool?.length) continue;
      const slot = pool.find((s) => s.propId === null);
      if (!slot) continue;
      slot.propId = p.id;
      const g = slot.group;
      g.visible = true;
      g.position.set(p.x, p.y, p.z);
      g.rotation.y = p.yaw;
      g.rotation.z = p.spin * 0.15;
      g.rotation.x = Math.min(0.6, Math.abs(p.vx) + Math.abs(p.vz)) * 0.02;
      const dent = 1 - p.dent * 0.12;
      g.scale.setScalar(p.scale * dent);
    }
  }, FRAME.LATE);

  return <group ref={rootRef} />;
}

declare global {
  interface Window {
    /** Which physics-prop templates resolved to real meshes (QA). */
    __propsDebug?: { templates: string[] };
  }
}
