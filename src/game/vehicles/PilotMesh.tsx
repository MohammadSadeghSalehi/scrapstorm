/**
 * Garage pilot showcase — female racer suit + helmet (textured GLB).
 * Only mounted in garage phase (10MB — never preload on menu).
 */
import { useEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PILOT_URL } from "./GltfCar";
import { FRAME } from "../world/framePriority";

export function PilotMesh({
  position = [2.2, 0, 0.4] as [number, number, number],
  scale = 1.05,
  visible = true,
}: {
  position?: [number, number, number];
  scale?: number;
  visible?: boolean;
}) {
  const root = useRef<THREE.Group>(null);
  const [obj, setObj] = useState<THREE.Object3D | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const loader = new GLTFLoader();
    loader.load(
      PILOT_URL,
      (gltf) => {
        if (!alive) return;
        const scene = gltf.scene;
        scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.castShadow = false;
          m.receiveShadow = true;
          m.frustumCulled = true;
          const src = (
            Array.isArray(m.material) ? m.material[0] : m.material
          ) as THREE.MeshStandardMaterial | undefined;
          if (src?.map) {
            src.map.colorSpace = THREE.SRGBColorSpace;
            src.map.anisotropy = 4;
            src.map.needsUpdate = true;
          }
          // Keep Standard — Physical clearcoat is unnecessary for a static pilot
          if (src) {
            src.metalness = Math.min(0.35, src.metalness ?? 0.2);
            src.roughness = Math.max(0.45, src.roughness ?? 0.55);
            src.envMapIntensity = 0.9;
            src.needsUpdate = true;
          }
        });
        scene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(scene);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        scene.position.x -= center.x;
        scene.position.z -= center.z;
        scene.position.y -= box.min.y;
        const h = Math.max(0.01, size.y);
        const s = 1.72 / h;
        scene.scale.setScalar(s);
        scene.rotation.y = Math.PI * 0.85;
        setObj(scene);
      },
      undefined,
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  useFrame((_, dt) => {
    if (!root.current || !visible || !obj) return;
    root.current.rotation.y += dt * 0.12;
  }, FRAME.LATE);

  if (!visible || failed || !obj) return null;
  return (
    <group ref={root} position={position} scale={scale}>
      <primitive object={obj} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <ringGeometry args={[0.35, 0.55, 24]} />
        <meshBasicMaterial
          color="#5eead4"
          transparent
          opacity={0.35}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}
