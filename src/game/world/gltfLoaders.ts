/**
 * Shared GLTFLoader factory with the full decode stack wired: meshopt + Draco
 * geometry and KTX2/Basis textures.
 *
 * Without these a .glb can only carry raw float positions and PNG/JPEG images,
 * so the GPU receives uncompressed textures and the main thread pays a full
 * image decode per map. KTX2 uploads a GPU-native compressed format directly
 * (roughly 6x less VRAM, no decode), and Draco/meshopt shrink geometry.
 *
 * Assets stay loadable either way — an uncompressed .glb ignores the decoders,
 * so the pipeline can be adopted file by file. Run
 * `node scripts/compress-assets.mjs` to produce the compressed variants.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

/** Transcoder binaries are copied into public/ by scripts/copy-decoders.mjs. */
const DRACO_PATH = "/decoders/draco/";
const KTX2_PATH = "/decoders/basis/";

let draco: DRACOLoader | null = null;
let ktx2: KTX2Loader | null = null;
let ktx2Ready = false;

/**
 * KTX2Loader must probe the renderer for supported compressed formats before
 * it can transcode. Call once from the Canvas `onCreated`.
 */
export function initGltfDecoders(gl: THREE.WebGLRenderer): void {
  if (!ktx2) {
    ktx2 = new KTX2Loader().setTranscoderPath(KTX2_PATH);
  }
  try {
    ktx2.detectSupport(gl);
    ktx2Ready = true;
  } catch {
    ktx2Ready = false;
  }
}

/**
 * The shared KTX2Loader, or null until a renderer has been probed.
 *
 * Exposed for the standalone PBR packs in webgl2/textureLibrary.ts, which are
 * plain .ktx2 files rather than glTF payloads. Handing out this instance rather
 * than letting callers construct their own matters: each KTX2Loader spins up
 * its own pool of transcoder workers and its own copy of the Basis wasm, so a
 * second instance would double that cost for no benefit.
 */
export function getKtx2Loader(): KTX2Loader | null {
  return ktx2Ready ? ktx2 : null;
}

/** GLTFLoader with every decoder this project may need attached. */
export function createGltfLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  try {
    loader.setMeshoptDecoder(MeshoptDecoder);
  } catch {
    /* optional */
  }
  try {
    if (!draco) {
      draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
      draco.setDecoderConfig({ type: "js" });
    }
    loader.setDRACOLoader(draco);
  } catch {
    /* optional */
  }
  try {
    // Only attach once the renderer has been probed; attaching an
    // undetected KTX2Loader throws when it hits a compressed texture.
    if (ktx2 && ktx2Ready) loader.setKTX2Loader(ktx2);
  } catch {
    /* optional */
  }
  return loader;
}

export function disposeGltfDecoders(): void {
  draco?.dispose();
  draco = null;
  ktx2?.dispose();
  ktx2 = null;
  ktx2Ready = false;
}
