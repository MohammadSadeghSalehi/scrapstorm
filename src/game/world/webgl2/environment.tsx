/**
 * HDRI → PMREM environment lighting.
 * Poly Haven CC0: syferfontein / qwantani noon / industrial sunset / kloppenheim.
 */
import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { qualityManager } from "../quality";

function hdriUrl(): string {
  const tier = qualityManager.get().tier;
  if (tier === "high") return "/assets/hdri/qwantani_noon_2k.hdr";
  if (tier === "medium") return "/assets/hdri/syferfontein_1k.hdr";
  return "/assets/hdri/kloppenheim_1k.hdr";
}

export function EnvLighting() {
  const { gl, scene } = useThree();

  useEffect(() => {
    if (!qualityManager.get().hdriEnv) {
      scene.environment = null;
      return;
    }

    let disposed = false;
    let envTex: THREE.Texture | null = null;
    let pmrem: THREE.PMREMGenerator | null = null;

    const loader = new RGBELoader();
    const tryLoad = (path: string, fallback?: string) => {
      loader.load(
        path,
        (texture) => {
          if (disposed) {
            texture.dispose();
            return;
          }
          texture.mapping = THREE.EquirectangularReflectionMapping;
          pmrem = new THREE.PMREMGenerator(gl);
          pmrem.compileEquirectangularShader();
          const rt = pmrem.fromEquirectangular(texture);
          envTex = rt.texture;
          scene.environment = envTex;
          const tier = qualityManager.get().tier;
          scene.environmentIntensity =
            tier === "high" ? 1.1 : tier === "medium" ? 0.85 : 0.6;
          texture.dispose();
        },
        undefined,
        () => {
          if (fallback) tryLoad(fallback);
        },
      );
    };
    tryLoad(hdriUrl(), "/assets/hdri/qwantani_noon_1k.hdr");

    return () => {
      disposed = true;
      if (scene.environment === envTex) scene.environment = null;
      envTex?.dispose();
      pmrem?.dispose();
    };
  }, [gl, scene]);

  return null;
}
