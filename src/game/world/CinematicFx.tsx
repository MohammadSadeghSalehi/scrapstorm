/**
 * Lightweight cinematic speed streaks + boost glow for the player car.
 */
import { useMemo, useRef, type MutableRefObject } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { VehicleState } from "../types";
import { FRAME } from "./framePriority";
import { qualityManager } from "./quality";

type Bag = { player: VehicleState | null };

export function CinematicFx({
  bag,
  player: playerProp = null,
}: {
  bag?: MutableRefObject<Bag>;
  player?: VehicleState | null;
}) {
  const group = useRef<THREE.Group>(null);
  const streaks = useMemo(() => {
    const n = qualityManager.get().tier === "low" ? 0 : 12;
    return Array.from({ length: n }, (_, i) => ({
      mesh: null as THREE.Mesh | null,
      phase: Math.random() * Math.PI * 2,
      lat: (i / n - 0.5) * 2.4,
      len: 1.2 + Math.random() * 2.5,
      speed: 18 + Math.random() * 40,
    }));
  }, []);

  const mats = useMemo(() => {
    const streak = new THREE.MeshBasicMaterial({
      color: "#fff7ed",
      transparent: true,
      opacity: 0,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
    });
    const glow = new THREE.MeshBasicMaterial({
      color: "#5eead4",
      transparent: true,
      opacity: 0,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
    });
    return { streak, glow };
  }, []);

  const glowRef = useRef<THREE.Mesh>(null);

  useFrame((_, dt) => {
    const player = bag?.current.player ?? playerProp;
    if (!player || !group.current) {
      if (group.current) group.current.visible = false;
      return;
    }
    const maxSp = 84;
    const sn = Math.min(1, Math.abs(player.speed) / maxSp);
    const boost = player.boostTimer > 0;
    const drift = player.driftMeter > 0.15;
    const show = sn > 0.55 || boost;

    group.current.position.set(player.x, player.y + 0.4, player.z);
    group.current.rotation.y = player.yaw;
    group.current.visible = show;

    const targetOp = show
      ? (boost ? 0.55 : 0.18) + sn * 0.35 + (drift ? 0.1 : 0)
      : 0;
    mats.streak.opacity += (targetOp - mats.streak.opacity) * Math.min(1, 8 * dt);
    mats.glow.color.set(player.color || "#5eead4");
    mats.glow.opacity +=
      ((boost ? 0.45 : sn > 0.7 ? 0.12 : 0) - mats.glow.opacity) *
      Math.min(1, 10 * dt);

    if (glowRef.current) {
      const s = boost ? 2.4 + sn : 1.2 + sn * 0.6;
      glowRef.current.scale.setScalar(s);
    }

    for (const s of streaks) {
      if (!s.mesh) continue;
      s.phase += dt * s.speed * (0.4 + sn);
      const z = -((s.phase % 12) - 2);
      s.mesh.position.set(s.lat * (1 + sn * 0.4), Math.sin(s.phase) * 0.15, z);
      s.mesh.scale.set(0.04 + sn * 0.04, 0.04, s.len * (0.6 + sn));
    }
  }, FRAME.LATE);

  if (qualityManager.get().tier === "low") return null;

  return (
    <group ref={group} visible={false}>
      <mesh ref={glowRef} position={[0, 0.2, 0.8]}>
        <sphereGeometry args={[0.9, 12, 12]} />
        <primitive object={mats.glow} attach="material" />
      </mesh>
      {streaks.map((s, i) => (
        <mesh
          key={i}
          ref={(m) => {
            s.mesh = m;
          }}
          position={[s.lat, 0, -2]}
        >
          <boxGeometry args={[1, 1, 1]} />
          <primitive object={mats.streak} attach="material" />
        </mesh>
      ))}
    </group>
  );
}
