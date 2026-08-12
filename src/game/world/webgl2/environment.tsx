/**
 * HDRI → PMREM environment lighting.
 * Poly Haven CC0: syferfontein / qwantani noon / industrial sunset / kloppenheim.
 */
import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { qualityManager } from "../quality";
import { getActiveEnvironment } from "../environments";

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

/**
 * Decoded HDRI, keyed by url, shared between the loading phase and EnvLighting.
 *
 * A DataTexture and not a PMREM render target on purpose: PMREM needs a
 * WebGLRenderer and the loader runs before any renderer exists, but the DECODE
 * is the expensive half and it needs nothing. Parsing a 2k .hdr is several
 * megabytes of RGBE unpacked into floats on the main thread.
 */
const decoded = new Map<string, Promise<THREE.DataTexture | null>>();

function decodeHdri(url: string): Promise<THREE.DataTexture | null> {
  const hit = decoded.get(url);
  if (hit) return hit;
  const p = new Promise<THREE.DataTexture | null>((resolve) => {
    new RGBELoader().load(
      url,
      (tex) => resolve(tex as THREE.DataTexture),
      undefined,
      () => resolve(null),
    );
  });
  decoded.set(url, p);
  return p;
}

/**
 * Decode the tier's HDRI ahead of the race, not just download it.
 *
 * THIS USED TO BE A `fetch` AND NOTHING ELSE, and that is why the world was
 * still arriving on the countdown. Warming the HTTP cache means the bytes are
 * local; it does not mean the environment is ready. EnvLighting mounts with the
 * scene, and only THEN parses the RGBE into a float texture and runs a PMREM
 * pass over it — so the two most expensive parts of "the world is lit" happened
 * after the loading screen had already been taken down, which is exactly the
 * "still loading on the countdown" report.
 *
 * The decode now happens here, inside the load phase, where there is a screen
 * over it. PMREM still belongs to EnvLighting because it needs the renderer,
 * but it is much the cheaper half once the texture is already unpacked.
 */
export function prefetchHdri(): Promise<void> {
  if (!qualityManager.get().hdriEnv) return Promise.resolve();
  return decodeHdri(hdriUrl())
    .then((t) => {
      // The fallback the mount path uses, warmed too — a tier whose primary
      // HDRI 404s would otherwise do its whole decode on the grid.
      if (!t) return decodeHdri("/assets/hdri/qwantani_noon_1k.hdr").then(() => undefined);
      return undefined;
    })
    .catch(() => undefined);
}

export function EnvLighting() {
  const { gl, scene } = useThree();

  useEffect(() => {
    if (!qualityManager.get().hdriEnv) {
      const grad = makeGradientEnv(gl);
      scene.environment = grad;
      /*
       * Scaled by the circuit's envIntensity — the single most load-bearing
       * line in the environment work. The image-based light is a DAYLIGHT sky,
       * and at full strength it re-lights a furnace-lit night pit as an
       * afternoon: every key-light, fog and grade change is overpowered by an
       * ambient term that never changed. A night circuit sets this near zero
       * and gets its light from its own rig instead.
       */
      scene.environmentIntensity =
        0.55 * getActiveEnvironment().light.envIntensity;
      return () => {
        if (scene.environment === grad) scene.environment = null;
        grad.dispose();
      };
    }

    let disposed = false;
    let envTex: THREE.Texture | null = null;
    let pmrem: THREE.PMREMGenerator | null = null;

    /*
     * Goes through the same `decodeHdri` cache the loading phase filled, so on
     * the normal route this resolves on the microtask queue with the texture
     * already unpacked and only the PMREM pass left to pay for. The cache is
     * keyed by url and never evicted: an HDRI is per-tier, not per-race, and
     * re-decoding it on every restart was a second of main thread each time.
     *
     * It still awaits rather than requiring the cache to be warm, because this
     * is not the only door into a race — the QA hook and a direct phase
     * mutation both mount the scene with nothing preloaded.
     */
    const apply = (texture: THREE.DataTexture) => {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      pmrem = new THREE.PMREMGenerator(gl);
      pmrem.compileEquirectangularShader();
      const rt = pmrem.fromEquirectangular(texture);
      envTex = rt.texture;
      scene.environment = envTex;
      const tier = qualityManager.get().tier;
      // Same reasoning as the gradient path above.
      scene.environmentIntensity =
        (tier === "high" ? 1.1 : tier === "medium" ? 0.85 : 0.6) *
        getActiveEnvironment().light.envIntensity;
      // NOT disposed: the decoded texture is shared with the cache and with any
      // later mount. PMREM has already copied what it needs into `rt`.
    };

    void decodeHdri(hdriUrl())
      .then((t) => t ?? decodeHdri("/assets/hdri/qwantani_noon_1k.hdr"))
      .then((t) => {
        if (disposed || !t) return;
        apply(t);
      });

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
