/**
 * Visible weapon hardware on every car on the grid.
 *
 * A combat racer where the guns are invisible until they fire reads as a racer
 * with a particle effect bolted on. Every class now carries the ordnance it
 * actually uses, so the silhouette says what the car does before it does it:
 *
 *   bruiser     heavy turret OR quad launcher (by body), plus two rockets
 *   interceptor two rockets on deck rails — the pair its ultimate fires
 *   trickster   two spiked mines racked on the tail — the ones it drops
 *
 * Instanced across the grid rather than parented into each car's glTF: the
 * meshes are shared, the cars are not, and parenting would mean one draw call
 * per car for a 5k-triangle prop. Four draws total covers the whole field.
 *
 * Deliberately NOT animated to aim. A turret that tracks needs a rig, an aim
 * solution and a rest pose, and a turret that tracks BADLY is far worse than
 * one that is welded forward — it reads as broken rather than as decorative.
 * Firing direction is the car's nose, which is what the cannon already uses.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS COMPONENT USED TO DRAW NOTHING AT ALL
 * ---------------------------------------------------------------------------
 * Two independent reasons, both now fixed:
 *
 *  1. `loadWeaponGeometry` used a bare GLTFLoader and every weapon .glb
 *     requires EXT_meshopt_compression, so both meshes resolved to null and the
 *     `if (!geo.turret && !geo.launcher) return null` guard returned null
 *     forever. See weaponMeshes.ts.
 *  2. The mount offsets were hand-guessed at y ≈ 1.0 m. Measured against the
 *     real post-pipeline bodies (see MOUNTS below) a bruiser roof is at 2.8 to
 *     3.1 m, so even a loaded turret would have been buried a third of the way
 *     down inside the bodywork.
 *
 * COST: 4 InstancedMeshes, so 4 draw calls, and none of them draws while its
 * count is zero. Worst case if a hand-authored roster fielded four of the same
 * class: turret 5,426 x 4 + launcher 5,454 x 4 + rocket 1,038 x 8 + mine 1,238
 * x 8 = 61,728 triangles. A normal grid (player + three bots, at most two of
 * any class) is ~15,000. Low tier drops the two 5k props entirely and gives the
 * bruiser rockets instead, which costs 2,076 triangles for the whole field.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { VehicleClassId, VehicleState } from "../types";
import { FRAME } from "./framePriority";
import { qualityManager } from "./quality";
import { loadWeaponGeometry, weaponMeshSize } from "./weaponMeshes";

/** Grid is 4; the heavy props can never exceed one per car. */
const HEAVY_CAP = 4;
/** Two light props per car. */
const LIGHT_CAP = 8;

/**
 * Measured roof height, in metres above the wheel contact patch, at the two
 * footprints hardware is mounted on.
 *
 * Produced by replaying GltfCar's exact pipeline headlessly — centre the raw
 * scene in XZ, align the long axis to Z, put the taller half at +Z, scale to
 * TARGET_LEN, shift min.y to 0 — then taking the 98th-percentile vertex height
 * inside a 0.7 m column. The percentile matters: these are reconstructed
 * meshes with stray shells, and a plain max reports an aerial as the roof.
 *
 * The spread is the whole reason a single constant could never work — the
 * trickster's two bodies are a metre apart, and the bruiser's roof is more than
 * twice the height of the trickster hatchback's.
 */
type RoofProfile = { deck: number; tail: number };
const ROOF: Record<string, RoofProfile> = {
  // interceptor
  WastelandCustomCar: { deck: 1.35, tail: 1.29 },
  WastelandBattleCar: { deck: 1.43, tail: 1.4 },
  // trickster
  CustomWidebodyHatchback: { deck: 1.21, tail: 1.16 },
  ArmoredBattleCar: { deck: 2.18, tail: 2.25 },
  // bruiser
  DesertCombatVehicle: { deck: 2.98, tail: 2.89 },
  ArmoredTankTruck: { deck: 3.11, tail: 2.6 },
};

/** Conservative floor if a body is added to GltfCar and not measured here. */
const ROOF_FALLBACK: Record<VehicleClassId, RoofProfile> = {
  interceptor: { deck: 1.35, tail: 1.29 },
  trickster: { deck: 1.21, tail: 1.16 },
  bruiser: { deck: 2.78, tail: 2.6 },
};

/*
 * MIRROR OF GltfCar.MODEL_VARIANTS / variantFor.
 *
 * WeaponMounts is handed VehicleState, which knows the class but not which of
 * the class's two bodies the car was built from — and GltfCar keeps both the
 * table and the hash private. Duplicating them is the smaller evil: the
 * alternative is either exporting internals from a file this pass does not own,
 * or walking the scene graph every frame looking for userData.customUrl.
 *
 * If GltfCar's list ever changes, the worst case here is a mount measured
 * against the wrong body — never a crash — because an unknown key falls back to
 * the class's shortest measured roof.
 */
const VARIANT_KEYS: Record<VehicleClassId, readonly string[]> = {
  interceptor: ["WastelandCustomCar", "WastelandBattleCar"],
  trickster: ["CustomWidebodyHatchback", "ArmoredBattleCar"],
  bruiser: ["DesertCombatVehicle", "ArmoredTankTruck"],
};

function variantKey(classId: VehicleClassId, vehicleId: string): string {
  const list = VARIANT_KEYS[classId];
  if (!vehicleId || list.length < 2) return list[0]!;
  let h = 2166136261;
  for (let i = 0; i < vehicleId.length; i++) {
    h ^= vehicleId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return list[(h >>> 0) % list.length]!;
}

function roofOf(v: VehicleState): RoofProfile {
  return ROOF[variantKey(v.classId, v.id)] ?? ROOF_FALLBACK[v.classId];
}

/**
 * The same suspension sink GltfCar applies when it poses the body.
 *
 * Without it the hardware floats up to 12 cm clear of a compressed car over
 * every kerb and landing, which is the one artefact that unmistakably reads as
 * "prop that is not attached to the vehicle".
 */
function rideSinkOf(v: VehicleState): number {
  const t = v.tires;
  if (!t || t.length < 4) return 0;
  const avg = (t[0]!.compress + t[1]!.compress + t[2]!.compress + t[3]!.compress) / 4;
  return Math.min(0.12, avg * 0.35);
}

/** One prop on one car. Offsets are metres: right, up-from-roof, rearward. */
type Slot = {
  right: number;
  /** Which measured footprint this prop stands on. */
  on: keyof RoofProfile;
  /** Metres behind the car's centre. */
  back: number;
  /** Extra lift past `roof + halfHeight`. Negative recesses the prop. */
  lift: number;
  /** Nose along the car's forward direction rather than its tail. */
  faceForward?: boolean;
};

type Shape = "turret" | "launcher" | "rocket" | "mine";

/**
 * Which props a car carries. The bruiser's two bodies take DIFFERENT heavy
 * props on purpose: one prop per car keeps the triangle cost of the heaviest
 * class to a single 5k mesh, and it means both authored assets are on the grid
 * whenever the field has two bruisers instead of one being dead weight.
 */
function loadoutOf(v: VehicleState, heavyAllowed: boolean): Partial<Record<Shape, Slot[]>> {
  const key = variantKey(v.classId, v.id);
  /*
   * ONLY THE LAUNCHER. No decorative rockets or mines bolted to the bodywork.
   *
   * Loose rounds were racked on the deck and the tail so every class carried
   * visible ordnance. That is the wrong idea: a rocket is a thing that exists
   * in flight, and welding a copy of it to the car makes the projectile read as
   * scenery that happened to come loose rather than as something you fired. It
   * also meant the SAME mesh was on screen twice during a shot, which is the
   * fastest way to make a weapon feel fake.
   *
   * What stays is the hardware a weapon is fired FROM — a turret and a launcher
   * are permanent fixtures and belong on the silhouette. The round itself is
   * spawned by combat.ts and lives only while it is flying.
   */
  if (v.classId !== "bruiser" || !heavyAllowed) return {};
  return key === "ArmoredTankTruck"
    ? { turret: [{ right: 0, on: "deck", back: 0.5, lift: -0.18 }] }
    : { launcher: [{ right: 0, on: "deck", back: 0.5, lift: -0.12 }] };
}

const SHAPES: readonly Shape[] = ["turret", "launcher", "rocket", "mine"];
const CAP: Record<Shape, number> = {
  turret: HEAVY_CAP,
  launcher: HEAVY_CAP,
  rocket: LIGHT_CAP,
  mine: LIGHT_CAP,
};

export function WeaponMounts({ vehicles }: { vehicles: VehicleState[] }) {
  const refs = useRef<Partial<Record<Shape, THREE.InstancedMesh | null>>>({});
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const [geo, setGeo] = useState<Partial<Record<Shape, THREE.BufferGeometry>>>({});
  /** Half-heights, filled once the geometry resolves. See weaponMeshSize. */
  const half = useRef<Record<Shape, number>>({
    turret: 0.5,
    launcher: 0.45,
    rocket: 0.14,
    mine: 0.3,
  });

  useEffect(() => {
    let alive = true;
    void Promise.all(SHAPES.map((s) => loadWeaponGeometry(s))).then((list) => {
      if (!alive) return;
      const next: Partial<Record<Shape, THREE.BufferGeometry>> = {};
      SHAPES.forEach((s, i) => {
        const g = list[i];
        if (!g) return;
        next[s] = g;
        const size = weaponMeshSize(s);
        if (size) half.current[s] = size.y * 0.5;
      });
      setGeo(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  useFrame(() => {
    // The heavy props are the only real cost here, so they are what the tier
    // gate removes — the bruiser keeps its rockets either way rather than
    // becoming the one class on a low-tier grid with nothing on it.
    const heavyAllowed = qualityManager.get().tier !== "low";
    const counts: Record<Shape, number> = { turret: 0, launcher: 0, rocket: 0, mine: 0 };

    for (const v of vehicles) {
      if (!v.alive || v.wreckTimer > 0) continue;
      const roof = roofOf(v);
      const sink = rideSinkOf(v);
      const c = Math.cos(v.yaw);
      const sn = Math.sin(v.yaw);
      const loadout = loadoutOf(v, heavyAllowed);

      for (const shape of SHAPES) {
        const slots = loadout[shape];
        const mesh = refs.current[shape];
        if (!slots || !mesh) continue;
        for (const slot of slots) {
          const n = counts[shape];
          if (n >= CAP[shape]) continue;
          /*
           * Car space -> world. Forward is (-sin, -cos) and right is
           * (cos, -sin) — the same basis every other placement in this project
           * uses — and `back` walks against forward, so it adds +(sin, cos).
           */
          dummy.position.set(
            v.x + c * slot.right + sn * slot.back,
            v.y - sink + roof[slot.on] + half.current[shape] + slot.lift,
            v.z + -sn * slot.right + c * slot.back,
          );
          // A body's authored nose is +Z, and rotationY(yaw) sends +Z to the
          // car's REAR, so anything that should point where the car is going
          // needs the half turn.
          dummy.rotation.set(0, slot.faceForward ? v.yaw + Math.PI : v.yaw, 0);
          dummy.scale.setScalar(1);
          dummy.updateMatrix();
          mesh.setMatrixAt(n, dummy.matrix);
          counts[shape] = n + 1;
        }
      }
    }

    // Park the unused slots rather than leaving last frame's matrix: an
    // instance count that shrinks mid-race would otherwise leave a turret
    // hanging where a wrecked car used to be.
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    for (const shape of SHAPES) {
      const mesh = refs.current[shape];
      if (!mesh) continue;
      for (let i = counts[shape]; i < CAP[shape]; i++) mesh.setMatrixAt(i, dummy.matrix);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.visible = counts[shape] > 0;
    }
  }, FRAME.POSE);

  const cast = qualityManager.get().allVehicleShadows;

  return (
    <group>
      {SHAPES.map((shape) => {
        const g = geo[shape];
        if (!g) return null;
        return (
          <instancedMesh
            key={shape}
            ref={(m) => {
              refs.current[shape] = m as THREE.InstancedMesh | null;
            }}
            args={[undefined, undefined, CAP[shape]]}
            frustumCulled={false}
            visible={false}
            castShadow={cast}
          >
            <primitive object={g} attach="geometry" />
            <meshStandardMaterial
              color={shape === "mine" ? "#6f6a64" : "#8a7f74"}
              roughness={0.86}
              metalness={0.34}
            />
          </instancedMesh>
        );
      })}
    </group>
  );
}
