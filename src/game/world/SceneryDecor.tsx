/**
 * Static Poly Haven scrapyard set-dressing around the circuit.
 * Distance-culled; does not participate in physics.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { TRACK_SAMPLES, SCENERY } from "../track";
import { loadPhModel, type PhModelKey } from "./polyHavenAssets";
import { FRAME } from "./framePriority";
import { qualityManager } from "./quality";

type DecorItem = {
  key: PhModelKey;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  targetLen: number;
};

function buildDecorList(tier: string): DecorItem[] {
  const items: DecorItem[] = [];
  const n = TRACK_SAMPLES.length;
  if (n < 8) return items;
  const stride = tier === "low" ? 14 : tier === "medium" ? 10 : 7;

  for (let i = 0; i < n; i += stride) {
    const s = TRACK_SAMPLES[i];
    const rx = Math.cos(s.yaw);
    const rz = -Math.sin(s.yaw);
    const side = i % 2 === 0 ? 1 : -1;
    const off = s.width * 0.5 + 6 + (i % 5) * 1.8;
    const pick = i % 7;
    const base = {
      x: s.x + rx * side * off,
      y: s.y,
      z: s.z + rz * side * off,
      yaw: s.yaw + side * 0.35,
      scale: 1,
    };
    if (pick === 0)
      items.push({ ...base, key: "coveredCar", targetLen: 4.4, scale: 1 });
    else if (pick === 1)
      items.push({ ...base, key: "barrier", targetLen: 1.8, scale: 1 });
    else if (pick === 2)
      items.push({
        ...base,
        key: "boulder",
        targetLen: 2.2 + (i % 3) * 0.4,
        scale: 1,
      });
    else if (pick === 3)
      items.push({ ...base, key: "trash", targetLen: 1.15, scale: 1 });
    else if (pick === 4)
      items.push({ ...base, key: "hydrant", targetLen: 0.95, scale: 1 });
    else if (pick === 5)
      items.push({ ...base, key: "tyre", targetLen: 1.0, scale: 1.1 });
    else items.push({ ...base, key: "rim", targetLen: 0.9, scale: 1 });
  }

  // Landmark pile near start
  const s0 = TRACK_SAMPLES[0];
  if (s0) {
    items.push(
      {
        key: "coveredCar",
        x: s0.x + 18,
        y: s0.y,
        z: s0.z + 22,
        yaw: 0.6,
        scale: 1,
        targetLen: 4.6,
      },
      {
        key: "coveredCar",
        x: s0.x + 24,
        y: s0.y,
        z: s0.z + 18,
        yaw: -0.4,
        scale: 1,
        targetLen: 4.2,
      },
      {
        key: "pipes",
        x: s0.x + 32,
        y: s0.y,
        z: s0.z + 28,
        yaw: 0.2,
        scale: 1,
        targetLen: 6,
      },
      {
        key: "fence",
        x: s0.x - 8,
        y: s0.y,
        z: s0.z + 30,
        yaw: 1.2,
        scale: 1,
        targetLen: 4,
      },
    );
  }

  // Extra from SCENERY anchors
  for (let i = 0; i < SCENERY.length; i += 3) {
    const sc = SCENERY[i];
    items.push({
      key: i % 2 === 0 ? "boulder" : "barrier",
      x: sc.x,
      y: 0,
      z: sc.z,
      yaw: sc.rot,
      scale: sc.scale * 0.85,
      targetLen: i % 2 === 0 ? 2.8 : 1.7,
    });
  }

  if (tier === "low") return items.slice(0, 28);
  if (tier === "medium") return items.slice(0, 48);
  return items.slice(0, 72);
}

export function SceneryDecor() {
  const group = useRef<THREE.Group>(null);
  const [ready, setReady] = useState(0);
  const nodes = useRef<THREE.Object3D[]>([]);
  const { camera } = useThree();
  const tier = qualityManager.get().tier;
  const list = useMemo(() => buildDecorList(tier), [tier]);

  useEffect(() => {
    let alive = true;
    nodes.current = [];
    const g = group.current;
    if (!g) return;
    while (g.children.length) g.remove(g.children[0]);

    // Place concurrently, not in a sequential await chain. Every distinct
    // (key,targetLen) template is deduped inside loadPhModel, so this issues
    // ~20 glTF fetches rather than serialising ~70 round-trips behind each
    // other — the difference between a multi-second stall on race start and
    // props popping in as they arrive.
    void (async () => {
      await Promise.all(
        list.map(async (item) => {
          try {
            const mesh = await loadPhModel(item.key, item.targetLen);
            if (!alive || !group.current) return;
            mesh.position.set(item.x, item.y, item.z);
            mesh.rotation.y = item.yaw;
            mesh.scale.multiplyScalar(item.scale);
            group.current.add(mesh);
            nodes.current.push(mesh);
          } catch {
            /* key unavailable — loadPhModel caches the miss */
          }
        }),
      );
      if (alive) setReady((n) => n + 1);
    })();

    return () => {
      alive = false;
    };
  }, [list]);

  useFrame(() => {
    const maxD = tier === "low" ? 70 : tier === "medium" ? 110 : 150;
    const maxD2 = maxD * maxD;
    const cx = camera.position.x;
    const cz = camera.position.z;
    for (const n of nodes.current) {
      const dx = n.position.x - cx;
      const dz = n.position.z - cz;
      n.visible = dx * dx + dz * dz < maxD2;
    }
  }, FRAME.LATE);

  void ready;
  return <group ref={group} />;
}
