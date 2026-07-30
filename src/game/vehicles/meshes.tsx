import { useMemo, useRef, type MutableRefObject, type ReactNode } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { VehicleState } from "../types";
import { VEHICLE_CLASSES } from "../classes";
import { TIRE_RADIUS, tireTempColor } from "../tires";
import { cloneMaps, getRecipeMaps } from "../world/procmat";
import {
  clonePbrPack,
  isPbrLibraryReady,
  type PbrPackId,
} from "../world/webgl2/textureLibrary";
import { qualityManager } from "../world/quality";
import { attachGpuDetail, type GpuDetailHandles } from "../world/shaders/gpuDetail";
import { getMaxAnisotropy } from "../world/webgl2/configure";
import { meshLodForDistance, type MeshLodBand } from "../world/naniteLod";
import { FRAME } from "../world/framePriority";

function vehicleMaps(
  id: PbrPackId | "metal" | "rust",
  rx: number,
  ry: number,
) {
  if (isPbrLibraryReady()) {
    const p = clonePbrPack(id as PbrPackId, rx, ry);
    if (p) {
      const a = Math.min(getMaxAnisotropy(), qualityManager.get().anisotropy || 4);
      for (const t of [p.map, p.normalMap, p.roughnessMap, p.metalnessMap, p.aoMap]) {
        if (t) {
          t.anisotropy = a;
          t.needsUpdate = true;
        }
      }
      return {
        map: p.map,
        roughnessMap: p.roughnessMap,
        metalnessMap: p.metalnessMap,
        normalMap: p.normalMap,
        aoMap: p.aoMap,
      };
    }
  }
  const fallback = id === "scrap_panel" || id === "rust" ? "rust" : "metal";
  return {
    ...cloneMaps(getRecipeMaps(fallback), rx, ry),
    aoMap: null as THREE.Texture | null,
  };
}

/**
 * Vehicle mesh that ALWAYS reads pose from the live sim object each frame.
 * Never trusts a stale React prop snapshot for position/yaw — that was the
 * "camera moves, car frozen" bug when setPhase replaced vehicle objects.
 */
export function ModularVehicleMesh({
  vehicle: vehicleProp,
  vehicleId,
  sim,
  ghost = false,
  forceHero = false,
}: {
  vehicle: VehicleState;
  vehicleId?: string;
  /** When set, re-resolve vehicle from sim each frame (avoids stale refs after race start) */
  sim?: { state: { vehicles: VehicleState[] } };
  ghost?: boolean;
  forceHero?: boolean;
}) {
  const group = useRef<THREE.Group>(null);
  const bodyGroup = useRef<THREE.Group>(null);
  const dentFrontRef = useRef<THREE.Group>(null);
  const dentRearRef = useRef<THREE.Group>(null);
  const dentLeftRef = useRef<THREE.Group>(null);
  const dentRightRef = useRef<THREE.Group>(null);
  const wheelSpinRefs = useRef<THREE.Object3D[]>([]);
  const wheelHubRefs = useRef<THREE.Group[]>([]);
  const detailHandle = useRef<GpuDetailHandles | null>(null);
  const lodRef = useRef<MeshLodBand>(0);
  const live = useRef<VehicleState>(vehicleProp);
  const idRef = useRef(vehicleId ?? vehicleProp.id);
  idRef.current = vehicleId ?? vehicleProp.id;
  const lastDmgMat = useRef(-1);
  const { camera } = useThree();

  const initial = vehicleProp;
  const def = VEHICLE_CLASSES[initial.classId];
  const color = initial.color || def.color;
  const q = qualityManager.get();
  const pbrKey = isPbrLibraryReady() ? "pbr" : "proc";
  const classId = initial.classId;

  const materials = useMemo(() => {
    const opacity = ghost ? 0.35 : 1;
    // Body: carpaint PBR; damage shell: scrap_panel; trim: carbon
    const paintPack = vehicleMaps("carpaint", 1.6, 1.6);
    const scrapPack = vehicleMaps("scrap_panel", 1.8, 1.8);
    const carbonPack = vehicleMaps("carbon", 2.2, 2.2);
    const metalPack = vehicleMaps("metal", 1.4, 1.4);
    const useN = q.vehicleNormals;
    const anchor = new THREE.Vector3(initial.x, initial.y, initial.z);

    const body = new THREE.MeshStandardMaterial({
      color,
      map: paintPack.map,
      roughnessMap: paintPack.roughnessMap,
      metalnessMap: paintPack.metalnessMap ?? null,
      normalMap: useN ? paintPack.normalMap : null,
      normalScale: new THREE.Vector2(0.55, 0.55),
      aoMap: paintPack.aoMap ?? null,
      aoMapIntensity: 0.85,
      roughness: 0.32,
      metalness: 0.72,
      transparent: ghost,
      opacity,
      emissive: color,
      emissiveIntensity: 0.08,
      envMapIntensity: 1.15,
    });
    if (q.gpuDetail > 0.25 && !ghost) {
      detailHandle.current = attachGpuDetail(body, {
        kind: "metal",
        detailScale: 22,
        quality: q,
        anchor,
      });
    } else {
      detailHandle.current = null;
    }

    const dark = new THREE.MeshStandardMaterial({
      color: "#1c1917",
      map: carbonPack.map,
      roughnessMap: carbonPack.roughnessMap,
      metalnessMap: carbonPack.metalnessMap ?? null,
      normalMap: useN ? carbonPack.normalMap : null,
      normalScale: new THREE.Vector2(0.5, 0.5),
      roughness: 0.48,
      metalness: 0.78,
      transparent: ghost,
      opacity,
      envMapIntensity: 0.75,
    });
    const tire = new THREE.MeshStandardMaterial({
      color: "#141210",
      roughness: 0.92,
      metalness: 0.08,
      transparent: ghost,
      opacity,
    });
    const glow = new THREE.MeshStandardMaterial({
      color: def.accent,
      emissive: def.accent,
      emissiveIntensity: ghost ? 0.25 : 1.15,
      roughness: 0.22,
      metalness: 0.25,
      transparent: ghost,
      opacity,
      toneMapped: false,
    });
    const glass = new THREE.MeshStandardMaterial({
      color: "#0c1220",
      roughness: 0.08,
      metalness: 0.9,
      transparent: true,
      opacity: ghost ? 0.2 : 0.72,
      envMapIntensity: 1.1,
    });
    const scorched = new THREE.MeshStandardMaterial({
      color: "#3f3a36",
      map: scrapPack.map,
      roughnessMap: scrapPack.roughnessMap,
      metalnessMap: scrapPack.metalnessMap ?? null,
      normalMap: useN ? scrapPack.normalMap : null,
      normalScale: new THREE.Vector2(0.85, 0.85),
      aoMap: scrapPack.aoMap ?? null,
      aoMapIntensity: 1,
      roughness: 0.92,
      metalness: 0.22,
      transparent: ghost,
      opacity,
      envMapIntensity: 0.5,
    });
    const ember = new THREE.MeshStandardMaterial({
      color: "#ea580c",
      emissive: "#c2410c",
      emissiveIntensity: 1.2,
      roughness: 0.45,
      metalness: 0.2,
      transparent: ghost,
      opacity,
      toneMapped: false,
    });
    const chrome = new THREE.MeshStandardMaterial({
      color: "#d6d3d1",
      map: carbonPack.map ?? metalPack.map,
      roughnessMap: carbonPack.roughnessMap ?? metalPack.roughnessMap,
      metalnessMap: carbonPack.metalnessMap ?? metalPack.metalnessMap ?? null,
      normalMap: useN ? (carbonPack.normalMap ?? metalPack.normalMap) : null,
      normalScale: new THREE.Vector2(0.6, 0.6),
      roughness: 0.18,
      metalness: 0.92,
      transparent: ghost,
      opacity,
      envMapIntensity: 1.4,
    });
    const dentMat = new THREE.MeshStandardMaterial({
      color: "#44403c",
      map: scrapPack.map,
      roughnessMap: scrapPack.roughnessMap,
      normalMap: useN ? scrapPack.normalMap : null,
      normalScale: new THREE.Vector2(1.1, 1.1),
      roughness: 0.88,
      metalness: 0.35,
      transparent: true,
      opacity: 0,
      envMapIntensity: 0.4,
    });
    return { body, dark, tire, glow, glass, scorched, ember, chrome, dentMat };
  }, [color, def.accent, ghost, q.vehicleNormals, q.gpuDetail, q.tier, pbrKey, classId]);

  // POSE band: after SIM so mesh never trails a catch-up window
  useFrame((_, dt) => {
    if (sim) {
      const id = idRef.current;
      const v = sim.state.vehicles.find((x) => x.id === id);
      if (v) live.current = v;
      else if (!ghost) {
        if (group.current) group.current.visible = false;
        return;
      }
    } else {
      live.current = vehicleProp;
    }

    const vehicle = live.current;
    const g = group.current;
    if (!g) return;
    g.visible = true;
    g.position.set(vehicle.x, vehicle.y, vehicle.z);
    g.rotation.order = "YXZ";
    g.rotation.y = vehicle.yaw;

    if (detailHandle.current?.anchor) {
      detailHandle.current.anchor.set(vehicle.x, vehicle.y, vehicle.z);
    }

    if (vehicle.isPlayer && typeof window !== "undefined") {
      (window as unknown as { __playerMesh?: { x: number; y: number; z: number; yaw: number } }).__playerMesh =
        { x: vehicle.x, y: vehicle.y, z: vehicle.z, yaw: vehicle.yaw };
    }

    const dx = camera.position.x - vehicle.x;
    const dy = camera.position.y - vehicle.y;
    const dz = camera.position.z - vehicle.z;
    const dist = Math.hypot(dx, dy, dz);
    lodRef.current = meshLodForDistance(dist, forceHero || vehicle.isPlayer || ghost);

    const dmg = vehicle.damageVisual;
    const df = vehicle.dentFront;
    const dl = vehicle.dentLeft;
    const dr = vehicle.dentRight;
    const drr = vehicle.dentRear;
    const bank = THREE.MathUtils.clamp(
      -vehicle.lateral * 0.04 - vehicle.speed * 0.001 + vehicle.bodyRoll,
      -0.4,
      0.4,
    );
    const list =
      vehicle.wreckTimer > 0
        ? Math.sin(vehicle.wreckTimer * 14) * 0.35
        : dmg * 0.08 * Math.sin(vehicle.x * 0.3);
    g.rotation.z = THREE.MathUtils.lerp(g.rotation.z, bank + list, 1 - Math.exp(-8 * dt));
    g.rotation.x = THREE.MathUtils.lerp(
      g.rotation.x,
      -vehicle.speed * 0.0012 +
        vehicle.bodyPitch +
        (vehicle.wreckTimer > 0 ? 0.25 : dmg * 0.04) +
        df * 0.06 -
        drr * 0.04,
      1 - Math.exp(-6 * dt),
    );

    if (bodyGroup.current) {
      const stretch = 1 + Math.min(0.06, Math.abs(vehicle.speed) * 0.0007);
      const squash = 1 / Math.sqrt(stretch);
      // Directional crumple: squash into impact zones
      const sx = squash * (1 - dl * 0.14 - dr * 0.14) * (1 + dmg * 0.02);
      const sy = squash * (1 - dmg * 0.06 - (df + drr) * 0.04);
      const sz = stretch * (1 - df * 0.16 - drr * 0.12);
      bodyGroup.current.scale.set(sx, sy, sz);
      bodyGroup.current.position.x = (dr - dl) * 0.14;
      bodyGroup.current.position.z = df * 0.12 - drr * 0.1;
      bodyGroup.current.position.y = -(df + drr) * 0.03;
    }

    if (bodyGroup.current && vehicle.impactFlash > 0) {
      const j = vehicle.impactFlash * 0.35;
      bodyGroup.current.position.x += (Math.random() - 0.5) * j;
      bodyGroup.current.position.y += (Math.random() - 0.5) * j * 0.5;
      bodyGroup.current.position.z += (Math.random() - 0.5) * j;
    }

    // Visible dent plates grow with zone damage
    applyDentPlate(dentFrontRef.current, materials.dentMat, df, 0, 0.55, 1.55);
    applyDentPlate(dentRearRef.current, materials.dentMat, drr, 0, 0.5, -1.55);
    applyDentPlate(dentLeftRef.current, materials.dentMat, dl, -0.95, 0.55, 0.1);
    applyDentPlate(dentRightRef.current, materials.dentMat, dr, 0.95, 0.55, 0.1);

    const radius = TIRE_RADIUS[vehicle.classId];
    const tires = vehicle.tires ?? [];
    const positions = wheelPositions(vehicle.classId);

    for (let i = 0; i < positions.length; i++) {
      const hub = wheelHubRefs.current[i];
      const spinMesh = wheelSpinRefs.current[i];
      if (!hub) continue;
      const rest = positions[i];
      const t = tires[i];
      const compress = t?.compress ?? 0.12;
      const lat = t?.lat ?? 0;
      const long = t?.long ?? 0;
      const slip = t?.slip ?? 0;

      const sinkY = compress * radius * 0.55;
      hub.position.set(rest[0], rest[1] - sinkY, rest[2]);

      const isFront = i < 2;
      hub.rotation.y = isFront ? vehicle.steerAngle * 0.55 : 0;

      const sy = Math.max(0.55, 1 - compress * 0.42);
      const sx = 1 + compress * 0.28 + Math.abs(lat) * 0.22;
      const sz = 1 + Math.abs(long) * 0.18 - compress * 0.06 + slip * 0.04;
      hub.scale.set(sx, sy, sz);
      hub.rotation.z = THREE.MathUtils.clamp(lat * 0.12, -0.18, 0.18);
      hub.rotation.x = THREE.MathUtils.clamp(-long * 0.08, -0.12, 0.12);

      if (spinMesh) {
        const spinRate = t?.spin ?? vehicle.speed / radius;
        spinMesh.rotation.x -= spinRate * dt;
      }
    }

    const body = materials.body;
    body.emissiveIntensity = 0.08 + vehicle.impactFlash * 1.4 + dmg * 0.2;
    body.roughness = 0.32 + dmg * 0.42 + (df + dl + dr + drr) * 0.05;
    body.metalness = 0.72 - dmg * 0.38;
    body.envMapIntensity = 1.15 - dmg * 0.45;
    // Blend toward scrap look by darkening + desat when dented
    const dmgBucket = Math.floor(dmg * 8);
    if (dmgBucket !== lastDmgMat.current) {
      lastDmgMat.current = dmgBucket;
      if (dmg > 0.35 && materials.scorched.map && body.map) {
        // Keep paint map; raise roughness via scorched influence on color
        const c = new THREE.Color(vehicle.color || color);
        c.lerp(new THREE.Color("#57534e"), Math.min(0.65, dmg * 0.7));
        body.color.copy(c);
        body.emissive.copy(c);
      }
    }
    if (vehicle.color && dmg <= 0.35 && body.color.getStyle() !== vehicle.color) {
      body.color.set(vehicle.color);
      body.emissive.set(vehicle.color);
    }
    materials.dentMat.opacity = Math.min(0.92, Math.max(df, dl, dr, drr) * 0.95);
    if (vehicle.boostTimer > 0) {
      materials.glow.emissiveIntensity = 1.6 + Math.sin(performance.now() * 0.02) * 0.4;
    }
  }, FRAME.POSE);

  const castShadow =
    !ghost && (initial.isPlayer || qualityManager.get().allVehicleShadows);

  const Body =
    classId === "bruiser"
      ? BruiserBody
      : classId === "trickster"
        ? TricksterBody
        : InterceptorBody;

  return (
    <group ref={group} name={`vehicle-${idRef.current}`}>
      <group ref={bodyGroup}>
        <Body materials={materials} castShadow={castShadow} lodRef={lodRef} />
        {/* Directional crumple plates */}
        <group ref={dentFrontRef} visible={false}>
          <mesh>
            <boxGeometry args={[1.15, 0.32, 0.22]} />
            <primitive object={materials.dentMat} attach="material" />
          </mesh>
        </group>
        <group ref={dentRearRef} visible={false}>
          <mesh>
            <boxGeometry args={[1.1, 0.28, 0.2]} />
            <primitive object={materials.dentMat} attach="material" />
          </mesh>
        </group>
        <group ref={dentLeftRef} visible={false}>
          <mesh>
            <boxGeometry args={[0.18, 0.4, 1.6]} />
            <primitive object={materials.dentMat} attach="material" />
          </mesh>
        </group>
        <group ref={dentRightRef} visible={false}>
          <mesh>
            <boxGeometry args={[0.18, 0.4, 1.6]} />
            <primitive object={materials.dentMat} attach="material" />
          </mesh>
        </group>
        <Wheels
          classId={classId}
          materials={materials}
          hubRefs={wheelHubRefs}
          spinRefs={wheelSpinRefs}
          castShadow={castShadow}
          vehicleRef={live}
        />
      </group>
    </group>
  );
}

function applyDentPlate(
  plate: THREE.Group | null,
  mat: THREE.MeshStandardMaterial,
  amount: number,
  x: number,
  y: number,
  z: number,
) {
  if (!plate) return;
  if (amount < 0.04) {
    plate.visible = false;
    return;
  }
  plate.visible = true;
  plate.position.set(x, y - amount * 0.08, z + (z > 0 ? -amount * 0.12 : amount * 0.1));
  const crush = 1 - amount * 0.45;
  plate.scale.set(
    Math.abs(x) > 0.5 ? crush : 1 + amount * 0.15,
    crush,
    Math.abs(z) > 0.5 ? crush : 1 + amount * 0.1,
  );
  plate.rotation.x = (z > 0 ? 1 : z < 0 ? -1 : 0) * amount * 0.35;
  plate.rotation.z = (x > 0 ? -1 : x < 0 ? 1 : 0) * amount * 0.4;
  void mat;
}

function wheelPositions(classId: string): [number, number, number][] {
  if (classId === "bruiser") {
    return [
      [-1.05, 0.38, 1.15],
      [1.05, 0.38, 1.15],
      [-1.1, 0.4, -1.15],
      [1.1, 0.4, -1.15],
    ];
  }
  if (classId === "trickster") {
    return [
      [-0.9, 0.32, 1.0],
      [0.9, 0.32, 1.0],
      [-0.95, 0.34, -1.05],
      [0.95, 0.34, -1.05],
    ];
  }
  return [
    [-0.95, 0.34, 1.1],
    [0.95, 0.34, 1.1],
    [-1.0, 0.36, -1.1],
    [1.0, 0.36, -1.1],
  ];
}

type Mats = {
  body: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  tire: THREE.MeshStandardMaterial;
  glow: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  scorched: THREE.MeshStandardMaterial;
  ember: THREE.MeshStandardMaterial;
  chrome: THREE.MeshStandardMaterial;
  dentMat: THREE.MeshStandardMaterial;
};

type BodyProps = {
  materials: Mats;
  castShadow: boolean;
  lodRef: MutableRefObject<MeshLodBand>;
};

function LodParts({
  lodRef,
  mid,
  hero,
}: {
  lodRef: MutableRefObject<MeshLodBand>;
  mid?: ReactNode;
  hero?: ReactNode;
}) {
  const midG = useRef<THREE.Group>(null);
  const heroG = useRef<THREE.Group>(null);
  useFrame(() => {
    const b = lodRef.current;
    if (midG.current) midG.current.visible = b <= 1;
    if (heroG.current) heroG.current.visible = b === 0;
  }, FRAME.LATE);
  return (
    <>
      {mid ? <group ref={midG}>{mid}</group> : null}
      {hero ? <group ref={heroG}>{hero}</group> : null}
    </>
  );
}

/** Chase skiff — sharp nose, twin thrusters, canopy spine */
function InterceptorBody({ materials: m, castShadow, lodRef }: BodyProps) {
  return (
    <group>
      <mesh position={[0, 0.52, 0.05]} castShadow={castShadow} receiveShadow>
        <boxGeometry args={[1.55, 0.48, 3.15]} />
        <primitive object={m.body} attach="material" />
      </mesh>
      <mesh position={[0, 0.48, 1.55]} castShadow={castShadow}>
        <boxGeometry args={[1.2, 0.38, 0.85]} />
        <primitive object={m.body} attach="material" />
      </mesh>
      <mesh position={[0, 0.42, 2.05]} castShadow={castShadow}>
        <boxGeometry args={[0.75, 0.22, 0.45]} />
        <primitive object={m.dark} attach="material" />
      </mesh>
      <mesh position={[0, 0.92, -0.05]} castShadow={castShadow}>
        <boxGeometry args={[1.15, 0.38, 1.45]} />
        <primitive object={m.glass} attach="material" />
      </mesh>
      <mesh position={[-0.45, 0.42, -1.72]}>
        <boxGeometry args={[0.38, 0.28, 0.32]} />
        <primitive object={m.glow} attach="material" />
      </mesh>
      <mesh position={[0.45, 0.42, -1.72]}>
        <boxGeometry args={[0.38, 0.28, 0.32]} />
        <primitive object={m.glow} attach="material" />
      </mesh>

      <LodParts
        lodRef={lodRef}
        mid={
          <>
            <mesh position={[0, 0.78, -1.35]} castShadow={castShadow}>
              <boxGeometry args={[1.35, 0.12, 0.55]} />
              <primitive object={m.dark} attach="material" />
            </mesh>
            <mesh position={[-0.85, 0.55, 0.3]} rotation={[0, 0, 0.18]} castShadow={castShadow}>
              <boxGeometry args={[0.35, 0.1, 1.8]} />
              <primitive object={m.chrome} attach="material" />
            </mesh>
            <mesh position={[0.85, 0.55, 0.3]} rotation={[0, 0, -0.18]} castShadow={castShadow}>
              <boxGeometry args={[0.35, 0.1, 1.8]} />
              <primitive object={m.chrome} attach="material" />
            </mesh>
            <mesh position={[0, 0.62, 1.9]}>
              <boxGeometry args={[0.55, 0.08, 0.12]} />
              <primitive object={m.chrome} attach="material" />
            </mesh>
          </>
        }
        hero={
          <>
            <mesh position={[0, 1.15, -0.55]} castShadow={castShadow}>
              <boxGeometry args={[0.08, 0.35, 0.08]} />
              <primitive object={m.chrome} attach="material" />
            </mesh>
            <mesh position={[0, 1.35, -0.55]}>
              <sphereGeometry args={[0.07, 8, 6]} />
              <primitive object={m.glow} attach="material" />
            </mesh>
            <mesh position={[-0.55, 0.55, 1.75]}>
              <boxGeometry args={[0.22, 0.14, 0.12]} />
              <primitive object={m.chrome} attach="material" />
            </mesh>
            <mesh position={[0.55, 0.55, 1.75]}>
              <boxGeometry args={[0.22, 0.14, 0.12]} />
              <primitive object={m.chrome} attach="material" />
            </mesh>
            <mesh position={[0, 0.28, 0.4]} castShadow={castShadow}>
              <boxGeometry args={[0.35, 0.12, 1.6]} />
              <primitive object={m.scorched} attach="material" />
            </mesh>
            <mesh position={[-0.95, 0.48, -0.2]} castShadow={castShadow}>
              <boxGeometry args={[0.28, 0.28, 0.7]} />
              <primitive object={m.dark} attach="material" />
            </mesh>
            <mesh position={[0.95, 0.48, -0.2]} castShadow={castShadow}>
              <boxGeometry args={[0.28, 0.28, 0.7]} />
              <primitive object={m.dark} attach="material" />
            </mesh>
            <mesh position={[-0.55, 0.95, -0.05]} castShadow={castShadow}>
              <boxGeometry args={[0.06, 0.32, 1.4]} />
              <primitive object={m.chrome} attach="material" />
            </mesh>
            <mesh position={[0.55, 0.95, -0.05]} castShadow={castShadow}>
              <boxGeometry args={[0.06, 0.32, 1.4]} />
              <primitive object={m.chrome} attach="material" />
            </mesh>
            <mesh position={[-0.55, 0.55, -1.55]} rotation={[0.15, 0, 0.25]} castShadow={castShadow}>
              <boxGeometry args={[0.08, 0.35, 0.4]} />
              <primitive object={m.dark} attach="material" />
            </mesh>
            <mesh position={[0.55, 0.55, -1.55]} rotation={[0.15, 0, -0.25]} castShadow={castShadow}>
              <boxGeometry args={[0.08, 0.35, 0.4]} />
              <primitive object={m.dark} attach="material" />
            </mesh>
            <mesh position={[-0.45, 0.42, -1.95]} rotation={[Math.PI / 2, 0, 0]}>
              <torusGeometry args={[0.16, 0.035, 6, 12]} />
              <primitive object={m.ember} attach="material" />
            </mesh>
            <mesh position={[0.45, 0.42, -1.95]} rotation={[Math.PI / 2, 0, 0]}>
              <torusGeometry args={[0.16, 0.035, 6, 12]} />
              <primitive object={m.ember} attach="material" />
            </mesh>
          </>
        }
      />
    </group>
  );
}

function BruiserBody({ materials: m, castShadow, lodRef }: BodyProps) {
  return (
    <group>
      <mesh position={[0, 0.72, 0]} castShadow={castShadow} receiveShadow>
        <boxGeometry args={[2.2, 0.9, 3.55]} />
        <primitive object={m.body} attach="material" />
      </mesh>
      <mesh position={[0, 1.22, -0.15]} castShadow={castShadow}>
        <boxGeometry args={[1.75, 0.42, 1.55]} />
        <primitive object={m.dark} attach="material" />
      </mesh>
      <mesh position={[0, 0.58, 1.9]} castShadow={castShadow}>
        <boxGeometry args={[2.1, 0.55, 0.75]} />
        <primitive object={m.scorched} attach="material" />
      </mesh>
      <mesh position={[0, 0.45, -1.9]}>
        <boxGeometry args={[1.55, 0.28, 0.28]} />
        <primitive object={m.glow} attach="material" />
      </mesh>

      <LodParts
        lodRef={lodRef}
        mid={
          <>
            <mesh position={[-1.15, 0.85, 0.2]} castShadow={castShadow}>
              <boxGeometry args={[0.2, 0.7, 2.4]} />
              <primitive object={m.scorched} attach="material" />
            </mesh>
            <mesh position={[1.15, 0.85, 0.2]} castShadow={castShadow}>
              <boxGeometry args={[0.2, 0.7, 2.4]} />
              <primitive object={m.scorched} attach="material" />
            </mesh>
            <mesh position={[0, 1.0, 1.55]}>
              <boxGeometry args={[0.9, 0.28, 0.35]} />
              <primitive object={m.ember} attach="material" />
            </mesh>
            <mesh position={[0, 1.45, -0.9]} castShadow={castShadow}>
              <boxGeometry args={[1.2, 0.15, 0.5]} />
              <primitive object={m.chrome} attach="material" />
            </mesh>
          </>
        }
        hero={
          <>
            <mesh position={[-0.55, 1.55, -1.1]} castShadow={castShadow}>
              <cylinderGeometry args={[0.12, 0.14, 0.7, 8]} />
              <primitive object={m.scorched} attach="material" />
            </mesh>
            <mesh position={[0.55, 1.55, -1.1]} castShadow={castShadow}>
              <cylinderGeometry args={[0.12, 0.14, 0.7, 8]} />
              <primitive object={m.scorched} attach="material" />
            </mesh>
            <mesh position={[-0.55, 1.95, -1.1]}>
              <sphereGeometry args={[0.1, 6, 6]} />
              <primitive object={m.ember} attach="material" />
            </mesh>
            <mesh position={[0.55, 1.95, -1.1]}>
              <sphereGeometry args={[0.1, 6, 6]} />
              <primitive object={m.ember} attach="material" />
            </mesh>
            {[-0.7, -0.35, 0, 0.35, 0.7].map((x) => (
              <mesh key={x} position={[x, 0.45, 2.25]} castShadow={castShadow}>
                <boxGeometry args={[0.18, 0.35, 0.22]} />
                <primitive object={m.chrome} attach="material" />
              </mesh>
            ))}
            <mesh position={[-0.75, 1.35, 0.1]} castShadow={castShadow}>
              <boxGeometry args={[0.08, 0.55, 1.8]} />
              <primitive object={m.chrome} attach="material" />
            </mesh>
            <mesh position={[0.75, 1.35, 0.1]} castShadow={castShadow}>
              <boxGeometry args={[0.08, 0.55, 1.8]} />
              <primitive object={m.chrome} attach="material" />
            </mesh>
            <mesh position={[0, 1.55, 0.9]} castShadow={castShadow}>
              <boxGeometry args={[1.55, 0.08, 0.08]} />
              <primitive object={m.chrome} attach="material" />
            </mesh>
            <mesh position={[-1.25, 0.65, -0.6]} rotation={[0, 0, Math.PI / 2]} castShadow={castShadow}>
              <cylinderGeometry args={[0.22, 0.22, 0.55, 8]} />
              <primitive object={m.dark} attach="material" />
            </mesh>
            <mesh position={[1.25, 0.65, -0.6]} rotation={[0, 0, Math.PI / 2]} castShadow={castShadow}>
              <cylinderGeometry args={[0.22, 0.22, 0.55, 8]} />
              <primitive object={m.dark} attach="material" />
            </mesh>
            <mesh position={[0, 0.85, 2.15]} castShadow={castShadow}>
              <boxGeometry args={[0.45, 0.25, 0.25]} />
              <primitive object={m.dark} attach="material" />
            </mesh>
            <mesh position={[-0.7, 0.75, 2.2]}>
              <boxGeometry args={[0.2, 0.14, 0.1]} />
              <primitive object={m.glow} attach="material" />
            </mesh>
            <mesh position={[0.7, 0.75, 2.2]}>
              <boxGeometry args={[0.2, 0.14, 0.1]} />
              <primitive object={m.glow} attach="material" />
            </mesh>
            <mesh position={[0, 0.35, -1.7]} castShadow={castShadow}>
              <boxGeometry args={[2.0, 0.2, 0.45]} />
              <primitive object={m.scorched} attach="material" />
            </mesh>
          </>
        }
      />
    </group>
  );
}

function TricksterBody({ materials: m, castShadow, lodRef }: BodyProps) {
  return (
    <group>
      <mesh position={[0, 0.45, 0.05]} castShadow={castShadow} receiveShadow>
        <boxGeometry args={[1.5, 0.38, 2.9]} />
        <primitive object={m.body} attach="material" />
      </mesh>
      <mesh position={[0, 0.78, -0.05]} castShadow={castShadow}>
        <boxGeometry args={[1.15, 0.32, 1.25]} />
        <primitive object={m.glass} attach="material" />
      </mesh>
      <mesh position={[-0.95, 0.52, 0.15]} rotation={[0, 0, 0.42]} castShadow={castShadow}>
        <boxGeometry args={[0.65, 0.1, 1.55]} />
        <primitive object={m.dark} attach="material" />
      </mesh>
      <mesh position={[0.95, 0.52, 0.15]} rotation={[0, 0, -0.42]} castShadow={castShadow}>
        <boxGeometry args={[0.65, 0.1, 1.55]} />
        <primitive object={m.dark} attach="material" />
      </mesh>
      <mesh position={[0, 0.32, -1.5]}>
        <boxGeometry args={[1.0, 0.14, 0.22]} />
        <primitive object={m.glow} attach="material" />
      </mesh>

      <LodParts
        lodRef={lodRef}
        mid={
          <>
            <mesh position={[0, 0.95, -1.35]} castShadow={castShadow}>
              <boxGeometry args={[1.6, 0.08, 0.35]} />
              <primitive object={m.dark} attach="material" />
            </mesh>
            <mesh position={[-0.75, 0.75, -1.35]} castShadow={castShadow}>
              <boxGeometry args={[0.08, 0.35, 0.08]} />
              <primitive object={m.chrome} attach="material" />
            </mesh>
            <mesh position={[0.75, 0.75, -1.35]} castShadow={castShadow}>
              <boxGeometry args={[0.08, 0.35, 0.08]} />
              <primitive object={m.chrome} attach="material" />
            </mesh>
            <mesh position={[0, 0.42, 1.45]} castShadow={castShadow}>
              <boxGeometry args={[1.1, 0.18, 0.4]} />
              <primitive object={m.body} attach="material" />
            </mesh>
          </>
        }
        hero={
          <>
            <mesh position={[-0.7, 0.42, 1.35]} rotation={[0, 0.2, 0.15]} castShadow={castShadow}>
              <boxGeometry args={[0.55, 0.05, 0.28]} />
              <primitive object={m.chrome} attach="material" />
            </mesh>
            <mesh position={[0.7, 0.42, 1.35]} rotation={[0, -0.2, -0.15]} castShadow={castShadow}>
              <boxGeometry args={[0.55, 0.05, 0.28]} />
              <primitive object={m.chrome} attach="material" />
            </mesh>
            <mesh position={[-0.85, 0.95, -1.35]} castShadow={castShadow}>
              <boxGeometry args={[0.06, 0.4, 0.3]} />
              <primitive object={m.dark} attach="material" />
            </mesh>
            <mesh position={[0.85, 0.95, -1.35]} castShadow={castShadow}>
              <boxGeometry args={[0.06, 0.4, 0.3]} />
              <primitive object={m.dark} attach="material" />
            </mesh>
            <mesh position={[-0.85, 0.38, -1.15]} castShadow={castShadow}>
              <boxGeometry args={[0.25, 0.2, 0.45]} />
              <primitive object={m.glow} attach="material" />
            </mesh>
            <mesh position={[0.85, 0.38, -1.15]} castShadow={castShadow}>
              <boxGeometry args={[0.25, 0.2, 0.45]} />
              <primitive object={m.glow} attach="material" />
            </mesh>
            {[-0.25, 0, 0.25].map((x) => (
              <mesh key={x} position={[x, 0.68, 0.55]} castShadow={castShadow}>
                <boxGeometry args={[0.12, 0.04, 0.35]} />
                <primitive object={m.dark} attach="material" />
              </mesh>
            ))}
            <mesh position={[-0.75, 0.85, 0.35]} castShadow={castShadow}>
              <boxGeometry args={[0.22, 0.06, 0.08]} />
              <primitive object={m.chrome} attach="material" />
            </mesh>
            <mesh position={[0.75, 0.85, 0.35]} castShadow={castShadow}>
              <boxGeometry args={[0.22, 0.06, 0.08]} />
              <primitive object={m.chrome} attach="material" />
            </mesh>
            <mesh position={[0, 0.22, -0.8]} castShadow={castShadow}>
              <boxGeometry args={[1.2, 0.08, 1.0]} />
              <primitive object={m.scorched} attach="material" />
            </mesh>
            <mesh position={[0, 0.28, 1.7]} castShadow={castShadow}>
              <boxGeometry args={[1.35, 0.05, 0.2]} />
              <primitive object={m.chrome} attach="material" />
            </mesh>
            <mesh position={[0, 1.0, -0.2]}>
              <boxGeometry args={[0.12, 0.06, 0.8]} />
              <primitive object={m.glow} attach="material" />
            </mesh>
          </>
        }
      />
    </group>
  );
}

function Wheels({
  classId,
  materials: m,
  hubRefs,
  spinRefs,
  castShadow,
  vehicleRef,
}: {
  classId: string;
  materials: Mats;
  hubRefs: MutableRefObject<THREE.Group[]>;
  spinRefs: MutableRefObject<THREE.Object3D[]>;
  castShadow: boolean;
  vehicleRef: MutableRefObject<VehicleState>;
}) {
  const positions = wheelPositions(classId);
  const radius = TIRE_RADIUS[classId as keyof typeof TIRE_RADIUS] ?? 0.38;
  const width = classId === "bruiser" ? 0.38 : 0.28;
  const segs = qualityManager.get().tier === "low" ? 8 : 12;
  const tireMats = useRef<THREE.MeshStandardMaterial[]>([]);

  useFrame(() => {
    const vehicle = vehicleRef.current;
    for (let i = 0; i < positions.length; i++) {
      const mat = tireMats.current[i];
      if (!mat) continue;
      const temp = vehicle.tires?.[i]?.temp ?? 80;
      const tc = tireTempColor(temp);
      mat.color.setRGB(tc.r, tc.g, tc.b);
      mat.emissive.setRGB(tc.r, tc.g * 0.4, tc.b * 0.2);
      mat.emissiveIntensity = tc.emissive;
    }
  }, FRAME.LATE);

  return (
    <group>
      {positions.map((p, i) => (
        <group
          key={i}
          ref={(el) => {
            if (el) hubRefs.current[i] = el;
          }}
          position={p}
        >
          <mesh
            ref={(el) => {
              if (el) spinRefs.current[i] = el;
            }}
            rotation={[0, 0, Math.PI / 2]}
            castShadow={castShadow}
          >
            <cylinderGeometry args={[radius, radius, width, segs]} />
            <meshStandardMaterial
              ref={(mat) => {
                if (mat) tireMats.current[i] = mat;
              }}
              color="#1a1512"
              roughness={0.92}
              metalness={0.08}
            />
          </mesh>
          <mesh rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[radius * 0.45, radius * 0.45, width * 1.05, 8]} />
            <primitive object={m.chrome} attach="material" />
          </mesh>
          <mesh rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[radius * 0.12, radius * 0.12, width * 1.1, 6]} />
            <primitive object={m.dark} attach="material" />
          </mesh>
        </group>
      ))}
    </group>
  );
}
