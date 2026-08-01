/**
 * Visible weapon hardware on the cars that use it.
 *
 * A combat racer where the guns are invisible until they fire reads as a racer
 * with a particle effect bolted on. The bruiser carries a cannon and a rocket
 * rack; both now exist as objects on the roof, so the silhouette says what the
 * car does before it does it — and so a rival you can see coming is a rival you
 * can read.
 *
 * Instanced across the grid rather than parented into each car's glTF: the
 * meshes are shared, the cars are not, and parenting would mean one draw call
 * per car for a 5k-triangle prop. Two draws total covers the whole field.
 *
 * Deliberately NOT animated to aim. A turret that tracks needs a rig, an aim
 * solution and a rest pose, and a turret that tracks BADLY is far worse than
 * one that is welded forward — it reads as broken rather than as decorative.
 * Firing direction is the car's nose, which is what the cannon already uses.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { VehicleState } from "../types";
import { FRAME } from "./framePriority";
import { qualityManager } from "./quality";
import { loadWeaponGeometry } from "./weaponMeshes";

/** Grid is 4; a couple spare costs nothing and avoids a hard cap bug. */
const CAP = 8;

type Mount = {
  /** Local offset from the car's origin, in metres: right, up, forward. */
  off: [number, number, number];
  scale: number;
};

/*
 * Offsets are in CAR space and deliberately conservative. The generated bodies
 * differ in roof height by nearly a metre, and a mount tuned to one of them
 * floats or sinks on the others; sitting slightly low reads as recessed, which
 * is fine, while sitting high reads as broken.
 */
const TURRET: Mount = { off: [0, 1.02, -0.15], scale: 1 };
const LAUNCHER: Mount = { off: [0, 0.98, -0.95], scale: 1 };

export function WeaponMounts({ vehicles }: { vehicles: VehicleState[] }) {
  const turretRef = useRef<THREE.InstancedMesh>(null);
  const launcherRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const [geo, setGeo] = useState<{
    turret: THREE.BufferGeometry | null;
    launcher: THREE.BufferGeometry | null;
  }>({ turret: null, launcher: null });

  useEffect(() => {
    let alive = true;
    void Promise.all([
      loadWeaponGeometry("turret"),
      loadWeaponGeometry("launcher"),
    ]).then(([turret, launcher]) => {
      if (alive) setGeo({ turret, launcher });
    });
    return () => {
      alive = false;
    };
  }, []);

  useFrame(() => {
    const t = turretRef.current;
    const l = launcherRef.current;
    if (!t && !l) return;
    let n = 0;
    for (const v of vehicles) {
      // Hardware belongs to the class, not to every car — the interceptor is
      // stripped for weight and the trickster carries side pods, neither of
      // which is a roof gun.
      if (v.classId !== "bruiser" || !v.alive || n >= CAP) continue;
      const c = Math.cos(v.yaw);
      const sn = Math.sin(v.yaw);
      const place = (mesh: THREE.InstancedMesh | null, m: Mount) => {
        if (!mesh) return;
        // Car space -> world. Forward is (-sin, -cos), right is (cos, -sin);
        // the same basis every other placement in this project uses.
        const [rx, uy, fz] = m.off;
        dummy.position.set(
          v.x + c * rx + -sn * fz,
          v.y + uy,
          v.z + -sn * rx + -c * fz,
        );
        dummy.rotation.set(0, v.yaw, 0);
        dummy.scale.setScalar(m.scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(n, dummy.matrix);
      };
      place(t, TURRET);
      place(l, LAUNCHER);
      n++;
    }
    // Park the unused slots rather than leaving last frame's matrix: an
    // instance count that shrinks mid-race would otherwise leave a turret
    // hanging where a wrecked car used to be.
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    for (const mesh of [t, l]) {
      if (!mesh) continue;
      for (let i = n; i < CAP; i++) mesh.setMatrixAt(i, dummy.matrix);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.visible = n > 0;
    }
  }, FRAME.POSE);

  if (!geo.turret && !geo.launcher) return null;
  const cast = qualityManager.get().allVehicleShadows;

  return (
    <group>
      {geo.turret && (
        <instancedMesh
          ref={turretRef}
          args={[undefined, undefined, CAP]}
          frustumCulled={false}
          castShadow={cast}
        >
          <primitive object={geo.turret} attach="geometry" />
          <meshStandardMaterial color="#8a7f74" roughness={0.85} metalness={0.35} />
        </instancedMesh>
      )}
      {geo.launcher && (
        <instancedMesh
          ref={launcherRef}
          args={[undefined, undefined, CAP]}
          frustumCulled={false}
          castShadow={cast}
        >
          <primitive object={geo.launcher} attach="geometry" />
          <meshStandardMaterial color="#7d7168" roughness={0.88} metalness={0.3} />
        </instancedMesh>
      )}
    </group>
  );
}
