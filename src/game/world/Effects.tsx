import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { Mine, Particle, Projectile, VehicleState } from "../types";
import { qualityManager } from "./quality";
import { FRAME } from "./framePriority";
import { softCircleTexture, softSmokeTexture } from "./softSprite";
import { hash01, hashString } from "./vfx/rng";
import { loadWeaponGeometry } from "./weaponMeshes";

/**
 * Per-weapon projectile bodies, instanced.
 *
 * Two things changed here and both matter.
 *
 * 1. INSTANCED, POSED EVERY FRAME. The previous version mapped the projectile
 *    array to React elements with `position={[p.x, p.y, p.z]}`, so a shot only
 *    moved when its parent re-rendered — and LiveFx throttles that to one frame
 *    in eight. Every tracer in the game was stepping at ~18Hz regardless of
 *    frame rate. Posing three InstancedMeshes from a useFrame fixes that AND
 *    collapses up to 2N draw calls into exactly 3.
 *
 * 2. THREE DIFFERENT OBJECTS. All three weapons drew the same tapered cylinder
 *    with a different tint, which is the definition of a thin vocabulary. Now
 *    the interceptor fires a thin lance, the bruiser lobs a stubby shell, and
 *    the trickster throws an actual spinning disc — edge-on, rolling about its
 *    line of flight, which is also what makes its ricochets readable.
 *
 * The COLLISION radius still comes from p.radius and is untouched: a
 * projectile's hitbox and its silhouette have no reason to be the same size.
 * (That decoupling is why these are not the ~1m glowing orbs they once were.)
 *
 * COST: 3 draw calls, 16 instances each. Bolt 36 tris, shell 48, disc 48 —
 * 2112 triangles if every slot in every kind were somehow full at once, and
 * realistically under 300.
 */
const PROJ_CAP = 16;

const PROJ_TINT = {
  bolt: [0.42, 1.0, 0.86],
  cannon: [1.0, 0.63, 0.3],
  disc: [0.46, 0.86, 1.0],
} as const;

type ProjKind = keyof typeof PROJ_TINT;
const PROJ_ORDER: readonly ProjKind[] = ["bolt", "cannon", "disc"];

/** See DebrisField: instanceColor needs a real `color` attribute to apply. */
function withWhiteColors(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const count = geo.getAttribute("position").count;
  geo.setAttribute(
    "color",
    new THREE.BufferAttribute(new Float32Array(count * 3).fill(1), 3),
  );
  return geo;
}

export function ProjectilesView({ projectiles }: { projectiles: Projectile[] }) {
  const refs = useRef<(THREE.InstancedMesh | null)[]>([]);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);
  const t = useRef(0);

  /*
   * Placeholder bodies. These are what draws until the authored meshes resolve,
   * and what keeps drawing if they never do — a projectile that fails to render
   * is a weapon the player cannot see coming, so the fallback is not optional.
   */
  const geos = useMemo(
    () => [
      // Bolt: a thin lance, tapered to a point, long axis on +Z.
      withWhiteColors(
        new THREE.CylinderGeometry(0.055, 0.016, 1.5, 6).rotateX(Math.PI / 2),
      ),
      // Shell: short, fat, blunt-nosed. Reads as mass rather than as light.
      withWhiteColors(
        new THREE.CylinderGeometry(0.1, 0.14, 0.72, 8).rotateX(Math.PI / 2),
      ),
      // Disc: a saw blade flying edge-on, axis along +Z so it rolls about its
      // own line of flight.
      withWhiteColors(
        new THREE.CylinderGeometry(0.4, 0.4, 0.06, 12).rotateX(Math.PI / 2),
      ),
    ],
    [],
  );

  /*
   * Authored bodies, swapped in when they load.
   *
   * Kept as STATE rather than resolved before first render so a slow or missing
   * asset delays nothing: combat starts on the primitives and upgrades in place.
   * Only the shell and disc have authored equivalents — the bolt is an energy
   * weapon and its lance reads better than any physical object would.
   *
   * These went from unusable to usable purely through the asset pipeline: the
   * rocket was 95,770 triangles as generated and floored at 11,652 through
   * simplification alone, which is far too heavy for something that spawns in
   * volleys. Spatial welding first brought it to 1,038 and the saw blade to 838,
   * which is the same order as the cylinders they replace.
   */
  const [authored, setAuthored] = useState<(THREE.BufferGeometry | null)[]>([
    null,
    null,
    null,
  ]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [shell, disc] = await Promise.all([
        loadWeaponGeometry("rocket"),
        loadWeaponGeometry("saw"),
      ]);
      if (!alive) return;
      if (shell || disc) setAuthored([null, shell, disc]);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const active = useMemo(
    () => geos.map((g, i) => authored[i] ?? g),
    [geos, authored],
  );

  useEffect(() => {
    // Only the primitives are ours to dispose. The authored geometry is shared
    // and cached in weaponMeshes, and disposing it here would break the next
    // race that mounts this view.
    const owned = geos;
    return () => {
      for (const g of owned) g.dispose();
    };
  }, [geos]);

  useFrame((_, dt) => {
    t.current += dt;
    const counts = [0, 0, 0];

    for (const p of projectiles) {
      const k = p.kind === "cannon" ? 1 : p.kind === "disc" ? 2 : 0;
      const mesh = refs.current[k];
      if (!mesh) continue;
      const n = counts[k]!;
      if (n >= PROJ_CAP) continue;

      dummy.position.set(p.x, p.y, p.z);
      // lookAt puts local +Z along the velocity, which is the axis every one of
      // the three geometries is authored around.
      dummy.lookAt(p.x + p.vx, p.y + p.vy, p.z + p.vz);
      const seed = hashString(p.id);
      if (k === 2) {
        // Spin rate jittered per disc so a volley does not strobe in unison.
        dummy.rotateZ(t.current * (17 + hash01(seed) * 9) + hash01(seed ^ 0x33) * 6.28);
      } else {
        dummy.rotateZ(hash01(seed) * 6.28);
      }
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      mesh.setMatrixAt(n, dummy.matrix);

      const tint = PROJ_TINT[PROJ_ORDER[k]!];
      // Per-shot brightness jitter: identical tracers stacked in a burst is the
      // clearest tell that they came out of a loop.
      const b = 0.86 + hash01(seed ^ 0x9e37) * 0.3;
      color.setRGB(tint[0] * b, tint[1] * b, tint[2] * b);
      mesh.setColorAt(n, color);
      counts[k] = n + 1;
    }

    dummy.position.set(0, -900, 0);
    dummy.quaternion.identity();
    dummy.scale.setScalar(0.0001);
    dummy.updateMatrix();
    for (let k = 0; k < 3; k++) {
      const mesh = refs.current[k];
      if (!mesh) continue;
      for (let i = counts[k]!; i < PROJ_CAP; i++) mesh.setMatrixAt(i, dummy.matrix);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.visible = counts[k]! > 0;
    }
  }, FRAME.LATE);

  return (
    <group>
      {PROJ_ORDER.map((kind, i) => (
        <instancedMesh
          key={kind}
          ref={(m) => {
            refs.current[i] = m as THREE.InstancedMesh | null;
          }}
          args={[undefined, undefined, PROJ_CAP]}
          frustumCulled={false}
          visible={false}
          renderOrder={3}
        >
          <primitive object={active[i]!} attach="geometry" />
          {/*
            Self-lit, not shaded: a tracer that takes the sun's shading reads as
            a thrown pebble. Tone mapped, though — leaving it unmapped put these
            past the bloom threshold and haloed the whole road.
          */}
          <meshBasicMaterial vertexColors toneMapped={true} />
        </instancedMesh>
      ))}
    </group>
  );
}

export function MinesView({ mines }: { mines: Mine[] }) {
  const t = useRef(0);
  useFrame((_, dt) => {
    t.current += dt;
  }, FRAME.LATE);
  return (
    <group>
      {mines.map((m) => {
        const armed = m.armed <= 0;
        const pulse = armed
          ? 0.55 + Math.sin(t.current * 8 + m.x) * 0.45
          : 0;
        return (
          <group key={m.id} position={[m.x, m.y + 0.12, m.z]}>
            <mesh>
              <cylinderGeometry args={[0.5, 0.58, 0.22, 12]} />
              <meshStandardMaterial
                color={armed ? "#fafaf9" : "#3f3f46"}
                emissive={armed ? "#ef4444" : "#000000"}
                emissiveIntensity={armed ? 0.7 + pulse * 0.8 : 0}
                metalness={0.55}
                roughness={0.4}
                toneMapped={false}
              />
            </mesh>
            <mesh position={[0, 0.14, 0]}>
              <sphereGeometry args={[0.16, 8, 8]} />
              <meshStandardMaterial
                color="#ef4444"
                emissive="#ef4444"
                emissiveIntensity={armed ? 1.5 + pulse : 0.2}
                toneMapped={false}
              />
            </mesh>
            {armed && (
              <mesh
                rotation={[-Math.PI / 2, 0, 0]}
                position={[0, 0.02, 0]}
              >
                <ringGeometry args={[m.radius * 0.35, m.radius * 0.95, 24]} />
                <meshBasicMaterial
                  color="#ef4444"
                  transparent
                  opacity={0.1 + pulse * 0.18}
                  depthWrite={false}
                  side={THREE.DoubleSide}
                  toneMapped={false}
                />
              </mesh>
            )}
          </group>
        );
      })}
    </group>
  );
}

/**
 * Dual-path particles: smoke/dust uses normal blending soft puffs;
 * sparks use additive soft circles. Stops the "firefly blob" look.
 */
export function ParticlesView({ particles }: { particles: Particle[] }) {
  const max = qualityManager.get().particleMax;
  const smokeMax = Math.max(24, Math.floor(max * 0.7));
  const sparkMax = Math.max(16, max - smokeMax);
  const smokeRef = useRef<THREE.InstancedMesh>(null);
  const sparkRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);
  const smokeReady = useRef(false);
  const sparkReady = useRef(false);
  const smokeMap = useMemo(() => softSmokeTexture(128), []);
  const sparkMap = useMemo(
    () =>
      // Warm ember, not pure white. A white core at full alpha combined with
      // additive blending and toneMapped:false pushed every spark far past the
      // bloom threshold, so a damaged car sat inside a big white halo.
      softCircleTexture(
        64,
        "rgba(255,236,196,0.95)",
        "rgba(255,186,116,0.4)",
        "rgba(255,140,70,0)",
      ),
    [],
  );

  useFrame(({ camera }) => {
    const smoke = smokeRef.current;
    const spark = sparkRef.current;
    if (!smoke || !spark) return;

    if (!smokeReady.current) {
      const c = new THREE.Color("#ffffff");
      for (let i = 0; i < smokeMax; i++) smoke.setColorAt(i, c);
      if (smoke.instanceColor) smoke.instanceColor.needsUpdate = true;
      smokeReady.current = true;
    }
    if (!sparkReady.current) {
      const c = new THREE.Color("#ffffff");
      for (let i = 0; i < sparkMax; i++) spark.setColorAt(i, c);
      if (spark.instanceColor) spark.instanceColor.needsUpdate = true;
      sparkReady.current = true;
    }

    let si = 0;
    let ki = 0;
    const list = particles;
    const n = list.length;

    for (let i = 0; i < n; i++) {
      const p = list[i]!;
      const kind = p.kind ?? "spark";
      const isSmoke = kind === "smoke" || kind === "dust" || kind === "debris";
      const life = Math.max(0, p.life / Math.max(0.01, p.maxLife));
      dummy.position.set(p.x, p.y, p.z);
      dummy.quaternion.copy(camera.quaternion);

      if (isSmoke && si < smokeMax) {
        const grow = 0.85 + (1 - life) * 1.85;
        const scale = p.size * grow * 2.9;
        dummy.scale.set(scale, scale, scale);
        dummy.updateMatrix();
        smoke.setMatrixAt(si, dummy.matrix);
        color.set(p.color);
        // Soft warm ochre/grey dust — never hard black blobs
        const fade = 0.35 + life * 0.55;
        color.r = Math.min(1, Math.max(color.r, 0.55) * fade);
        color.g = Math.min(1, Math.max(color.g, 0.48) * fade * 0.95);
        color.b = Math.min(1, Math.max(color.b, 0.4) * fade * 0.85);
        smoke.setColorAt(si, color);
        si++;
      } else if (!isSmoke && ki < sparkMax) {
        const scale = p.size * (0.22 + life * 0.55) * 0.55;
        dummy.scale.set(scale, scale, scale);
        dummy.updateMatrix();
        spark.setMatrixAt(ki, dummy.matrix);
        color.set(p.color);
        color.multiplyScalar(0.55 + life * 0.5);
        spark.setColorAt(ki, color);
        ki++;
      }
    }

    // Hide unused slots
    dummy.position.set(0, -90, 0);
    dummy.scale.setScalar(0.001);
    dummy.quaternion.identity();
    dummy.updateMatrix();
    for (let i = si; i < smokeMax; i++) {
      smoke.setMatrixAt(i, dummy.matrix);
    }
    for (let i = ki; i < sparkMax; i++) {
      spark.setMatrixAt(i, dummy.matrix);
    }
    smoke.instanceMatrix.needsUpdate = true;
    spark.instanceMatrix.needsUpdate = true;
    if (smoke.instanceColor) smoke.instanceColor.needsUpdate = true;
    if (spark.instanceColor) spark.instanceColor.needsUpdate = true;
  }, FRAME.LATE);

  return (
    <group>
      <instancedMesh
        ref={smokeRef}
        args={[undefined, undefined, smokeMax]}
        frustumCulled={false}
        renderOrder={2}
      >
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial
          map={smokeMap}
          transparent
          opacity={0.34}
          depthWrite={false}
          vertexColors
          blending={THREE.NormalBlending}
          side={THREE.DoubleSide}
          alphaTest={0.02}
        />
      </instancedMesh>
      <instancedMesh
        ref={sparkRef}
        args={[undefined, undefined, sparkMax]}
        frustumCulled={false}
        renderOrder={4}
      >
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial
          map={sparkMap}
          transparent
          opacity={0.4}
          depthWrite={false}
          vertexColors
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          alphaTest={0.05}
        />
      </instancedMesh>
    </group>
  );
}

export function LockLine({
  self,
  target,
}: {
  self: VehicleState | undefined;
  target: VehicleState | undefined;
}) {
  const positions = useMemo(() => new Float32Array(6), []);
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setDrawRange(0, 2);
    return g;
  }, [positions]);
  const ringRef = useRef<THREE.Mesh>(null);

  useFrame(() => {
    const attr = geom.getAttribute("position") as THREE.BufferAttribute;
    if (!self || !target) {
      geom.setDrawRange(0, 0);
      if (ringRef.current) ringRef.current.visible = false;
      return;
    }
    attr.setXYZ(0, self.x, self.y + 0.8, self.z);
    attr.setXYZ(1, target.x, target.y + 0.8, target.z);
    attr.needsUpdate = true;
    geom.setDrawRange(0, 2);
    if (ringRef.current) {
      ringRef.current.visible = true;
      ringRef.current.position.set(target.x, target.y + 0.05, target.z);
      ringRef.current.rotation.z = performance.now() * 0.002;
    }
  }, FRAME.LATE);

  if (!self || !target) return null;

  return (
    <group>
      <line>
        <primitive object={geom} attach="geometry" />
        <lineBasicMaterial
          color="#5eead4"
          transparent
          opacity={0.55}
          depthWrite={false}
          toneMapped={false}
        />
      </line>
      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.1, 1.35, 28]} />
        <meshBasicMaterial
          color="#5eead4"
          transparent
          opacity={0.45}
          depthWrite={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

export function Nameplates({ vehicles }: { vehicles: VehicleState[] }) {
  return null;
}

export function NearMissPulse({ player }: { player: VehicleState | undefined }) {
  if (!player || (player.nearMissBoost ?? 0) <= 0) return null;
  const t = player.nearMissBoost;
  return (
    <mesh position={[player.x, player.y + 0.1, player.z]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[1.4, 2.2 + t * 1.5, 28]} />
      <meshBasicMaterial
        color="#fde68a"
        transparent
        opacity={0.15 + t * 0.25}
        depthWrite={false}
        side={THREE.DoubleSide}
        toneMapped={false}
      />
    </mesh>
  );
}

export function SkidMarks({ vehicles }: { vehicles: VehicleState[] }) {
  // Lightweight continuous skid strips while drifting / braking hard
  const max = qualityManager.get().skidMax;
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color("#1c1917"), []);
  const marks = useRef<
    { x: number; z: number; yaw: number; life: number; w: number }[]
  >([]);
  const ready = useRef(false);

  useFrame((_, dt) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    if (!ready.current) {
      for (let i = 0; i < max; i++) mesh.setColorAt(i, color);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      ready.current = true;
    }
    for (const v of vehicles) {
      if (!v.alive || v.wreckTimer > 0) continue;
      const slip = Math.abs(v.lateral) / Math.max(8, Math.abs(v.speed) + 2);
      const want =
        (v.driftMeter > 0.12 && Math.abs(v.speed) > 12) ||
        (v.offroadAmount < 0.25 && slip > 0.35 && Math.abs(v.speed) > 18);
      if (!want) continue;
      if (marks.current.length > max - 2) marks.current.shift();
      const fx = -Math.sin(v.yaw);
      const fz = -Math.cos(v.yaw);
      const rx = Math.cos(v.yaw);
      const rz = -Math.sin(v.yaw);
      for (const side of [-1, 1] as const) {
        marks.current.push({
          x: v.x - fx * 0.9 + rx * side * 0.8,
          z: v.z - fz * 0.9 + rz * side * 0.8,
          yaw: v.yaw,
          life: 4.5,
          w: 0.12 + slip * 0.1,
        });
      }
    }
    for (const m of marks.current) m.life -= dt;
    marks.current = marks.current.filter((m) => m.life > 0).slice(-max);

    for (let i = 0; i < max; i++) {
      const m = marks.current[i];
      if (!m) {
        dummy.position.set(0, -50, 0);
        dummy.scale.setScalar(0.001);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        continue;
      }
      dummy.position.set(m.x, 0.03, m.z);
      dummy.rotation.set(0, m.yaw, 0);
      dummy.scale.set(m.w, 1, 0.55);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      const a = Math.min(1, m.life / 4.5);
      color.setRGB(0.08 * a, 0.07 * a, 0.06 * a);
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, FRAME.LATE);

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, max]}
      frustumCulled={false}
      renderOrder={1}
    >
      <boxGeometry args={[1, 0.02, 1]} />
      <meshBasicMaterial
        transparent
        opacity={0.55}
        depthWrite={false}
        vertexColors
        toneMapped={false}
      />
    </instancedMesh>
  );
}

export function VehicleFX({ vehicles }: { vehicles: VehicleState[] }) {
  const t = useRef(0);
  useFrame((_, dt) => {
    t.current += dt;
  }, FRAME.LATE);
  return (
    <group>
      {vehicles.map((v) => {
        if (!v.alive) return null;
        const showBoost = v.boostTimer > 0.05;
        const showShield = v.defenseActive > 0 && v.classId === "interceptor";
        if (!showBoost && !showShield) return null;
        const fx = -Math.sin(v.yaw);
        const fz = -Math.cos(v.yaw);
        return (
          <group key={v.id}>
            {showBoost && (
              <mesh
                position={[v.x - fx * 1.5, v.y + 0.4, v.z - fz * 1.5]}
              >
                <sphereGeometry args={[0.4, 8, 8]} />
                <meshBasicMaterial
                  color="#22d3ee"
                  transparent
                  opacity={0.5 + Math.sin(t.current * 20) * 0.15}
                  depthWrite={false}
                  toneMapped={false}
                  blending={THREE.AdditiveBlending}
                />
              </mesh>
            )}
            {showShield && (
              <mesh position={[v.x, v.y + 0.6, v.z]}>
                <sphereGeometry args={[1.6, 12, 10]} />
                <meshBasicMaterial
                  color="#38bdf8"
                  transparent
                  opacity={0.12}
                  depthWrite={false}
                  wireframe
                  toneMapped={false}
                />
              </mesh>
            )}
          </group>
        );
      })}
    </group>
  );
}

export function SpeedStreaks({
  player,
}: {
  player: VehicleState | undefined;
}) {
  if (!player || Math.abs(player.speed) < 28) return null;
  const fx = -Math.sin(player.yaw);
  const fz = -Math.cos(player.yaw);
  const rx = Math.cos(player.yaw);
  const rz = -Math.sin(player.yaw);
  const sn = Math.min(1, (Math.abs(player.speed) - 26) / 60);
  const n = Math.min(10, 3 + Math.floor(sn * 8));
  const boost = player.boostTimer > 0;
  return (
    <group>
      {Array.from({ length: n }, (_, i) => {
        const side = i % 2 === 0 ? 1 : -1;
        const along = 1.2 + i * 0.75 + sn * 1.4;
        const lat = side * (0.5 + (i % 3) * 0.28 + sn * 0.25);
        return (
          <mesh
            key={i}
            position={[
              player.x + fx * along + rx * lat,
              player.y + 0.4 + (i % 4) * 0.1,
              player.z + fz * along + rz * lat,
            ]}
            rotation={[0, player.yaw, 0]}
          >
            <boxGeometry args={[0.025, 0.025, 1.1 + sn * 1.8 + i * 0.1]} />
            <meshBasicMaterial
              color={boost ? "#67e8f9" : "#fff7ed"}
              transparent
              opacity={0.12 + sn * 0.32}
              depthWrite={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
        );
      })}
      {boost && (
        <mesh
          position={[player.x - fx * 1.6, player.y + 0.35, player.z - fz * 1.6]}
        >
          <sphereGeometry args={[0.55 + sn * 0.25, 10, 10]} />
          <meshBasicMaterial
            color="#22d3ee"
            transparent
            opacity={0.32}
            depthWrite={false}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      )}
    </group>
  );
}

export function DraftWake({
  player,
  vehicles,
}: {
  player: VehicleState | undefined;
  vehicles: VehicleState[];
}) {
  if (!player) return null;
  const ahead = vehicles.find((v) => {
    if (v.isPlayer || !v.alive) return false;
    const dx = v.x - player.x;
    const dz = v.z - player.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 12 || dist < 2) return false;
    const fx = -Math.sin(player.yaw);
    const fz = -Math.cos(player.yaw);
    const dot = (dx * fx + dz * fz) / dist;
    return dot > 0.7;
  });
  if (!ahead) return null;
  return (
    <mesh position={[ahead.x, ahead.y + 0.3, ahead.z]}>
      <torusGeometry args={[1.2, 0.06, 6, 20]} />
      <meshBasicMaterial
        color="#5eead4"
        transparent
        opacity={0.35}
        depthWrite={false}
        toneMapped={false}
        blending={THREE.AdditiveBlending}
      />
    </mesh>
  );
}
