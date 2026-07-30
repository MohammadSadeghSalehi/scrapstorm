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

/**
 * Tiny equirect sky/horizon/ground ramp used as the low-tier environment.
 *
 * Low tier previously ran with `scene.environment = null`, which leaves every
 * PBR material with nothing to reflect — metals read flat grey and the whole
 * frame looks washed out. A 64x32 float gradient costs one PMREM pass and no
 * network fetch, so weak hardware still gets image-based lighting.
 */
function makeGradientEnv(gl: THREE.WebGLRenderer): THREE.Texture {
  const w = 64;
  const h = 32;
  const data = new Float32Array(w * h * 4);
  const zenith = [0.16, 0.26, 0.46];
  const horizon = [0.92, 0.66, 0.40];
  const ground = [0.30, 0.20, 0.13];
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1); // 0 = up, 1 = down
    let c: number[];
    if (v < 0.5) {
      const t = v / 0.5;
      c = zenith.map((z, i) => z + (horizon[i] - z) * t * t);
    } else {
      const t = (v - 0.5) / 0.5;
      c = horizon.map((hz, i) => hz + (ground[i] - hz) * Math.sqrt(t));
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.needsUpdate = true;
  const pmrem = new THREE.PMREMGenerator(gl);
  const rt = pmrem.fromEquirectangular(tex);
  tex.dispose();
  pmrem.dispose();
  return rt.texture;
}

export function EnvLighting() {
  const { gl, scene } = useThree();

  useEffect(() => {
    if (!qualityManager.get().hdriEnv) {
      const grad = makeGradientEnv(gl);
      scene.environment = grad;
      scene.environmentIntensity = 0.55;
      return () => {
        if (scene.environment === grad) scene.environment = null;
        grad.dispose();
      };
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

declare global {
  interface Window {
    /** Live renderer stats — populated in GameScene's Canvas onCreated. */
    __renderDebug?: {
      readonly exposure: number;
      readonly envIntensity: number;
      readonly hasEnv: boolean;
      readonly drawCalls: number;
      readonly triangles: number;
      readonly programs: number;
      readonly textures: number;
      readonly geometries: number;
      readonly cam: [number, number, number];
    };
  }
}
