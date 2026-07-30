/**
 * Per-frame: adaptive quality + WebGL2 reconfigure + GPU shader uniforms.
 */
import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { qualityManager, type QualitySettings } from "../quality";
import { applyQualityToGpuDetails, updateGpuDetailFrame } from "./gpuDetail";
import { configureWebGL2Renderer } from "../webgl2/configure";
import { FRAME } from "../framePriority";

function applyGlQuality(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  q: QualitySettings,
) {
  configureWebGL2Renderer(gl, q);

  scene.traverse((obj) => {
    if ((obj as THREE.DirectionalLight).isDirectionalLight) {
      const light = obj as THREE.DirectionalLight;
      if (!light.castShadow) return;
      light.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      light.shadow.bias = -0.00025;
      light.shadow.normalBias = 0.035;
      const map = light.shadow.map as THREE.WebGLRenderTarget | null;
      if (map) {
        map.dispose();
        (light.shadow as { map: THREE.WebGLRenderTarget | null }).map = null;
      }
      light.shadow.needsUpdate = true;
    }
  });

  applyQualityToGpuDetails(q);
}

export function GpuDetailDriver() {
  const { gl, scene, camera } = useThree();
  const applied = useRef<string>("");

  useEffect(() => {
    const q = qualityManager.get();
    applyGlQuality(gl, scene, q);
    applied.current = q.tier;
    return qualityManager.subscribe((next) => {
      if (next.tier === applied.current) {
        applyQualityToGpuDetails(next);
        return;
      }
      applied.current = next.tier;
      applyGlQuality(gl, scene, next);
    });
  }, [gl, scene]);

  useFrame((state) => {
    // No sampleFrame here — GameScene's sim loop already samples once per
    // frame. Sampling in both drove the tier counters at 2x, so the drop
    // trigger fired after 6 real frames instead of 12 and the tier thrashed.
    updateGpuDetailFrame(camera.position, state.clock.elapsedTime);
  }, FRAME.LATE);

  return null;
}
