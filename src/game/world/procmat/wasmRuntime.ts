/**
 * Production preload of WASM SIMD hash lattice (optional fast path).
 * Bulk fills win; per-sample JS→WASM is slower — use for grid bake assist.
 */
import { wasmSimdSupported } from "./bench/snippets";

export type WasmNoiseModule = {
  memory: WebAssembly.Memory;
  fill_value_noise: (
    outPtr: number,
    xsPtr: number,
    ysPtr: number,
    n: number,
    seed: number,
  ) => void;
  fill_fbm3: (
    outPtr: number,
    xsPtr: number,
    ysPtr: number,
    n: number,
    seed: number,
  ) => void;
};

let mod: WasmNoiseModule | null = null;
let status: "idle" | "loading" | "ready" | "unsupported" | "error" = "idle";
let loadPromise: Promise<WasmNoiseModule | null> | null = null;

export function getWasmNoiseStatus() {
  return status;
}

export function getWasmNoiseModule() {
  return mod;
}

/**
 * Load wasm binary from public/ or module URL.
 */
export function preloadWasmNoise(): Promise<WasmNoiseModule | null> {
  if (mod) return Promise.resolve(mod);
  if (status === "unsupported") return Promise.resolve(null);
  if (loadPromise) return loadPromise;

  if (typeof WebAssembly === "undefined" || !wasmSimdSupported()) {
    status = "unsupported";
    return Promise.resolve(null);
  }

  status = "loading";
  loadPromise = (async () => {
    try {
      const urls = [
        "/assets/wasm/hash_lattice_simd.wasm",
        "/src/game/world/procmat/wasm/hash_lattice_simd.wasm",
      ];
      let bytes: ArrayBuffer | null = null;
      for (const url of urls) {
        try {
          const res = await fetch(url);
          if (res.ok) {
            bytes = await res.arrayBuffer();
            break;
          }
        } catch {
          /* try next */
        }
      }
      if (!bytes) {
        status = "error";
        return null;
      }
      const { instance } = await WebAssembly.instantiate(bytes, {});
      const exports = instance.exports as unknown as {
        memory: WebAssembly.Memory;
        fill_value_noise: WasmNoiseModule["fill_value_noise"];
        fill_fbm3: WasmNoiseModule["fill_fbm3"];
      };
      mod = {
        memory: exports.memory,
        fill_value_noise: exports.fill_value_noise.bind(exports),
        fill_fbm3: exports.fill_fbm3.bind(exports),
      };
      status = "ready";
      return mod;
    } catch {
      status = "error";
      return null;
    }
  })();

  return loadPromise;
}

/**
 * Fill a Float32Array with fbm3 noise over a UV grid (size×size).
 * Used to accelerate height-field pre-pass when WASM is ready.
 */
export function wasmFillFbmGrid(
  size: number,
  seed: number,
  scale = 1,
): Float32Array | null {
  if (!mod) return null;
  const n = size * size;
  const bytes = n * 4 * 3 + 64;
  const pages = Math.ceil(bytes / 65536) + 1;
  const mem = mod.memory;
  if (mem.buffer.byteLength < pages * 65536) {
    mem.grow(pages - Math.ceil(mem.buffer.byteLength / 65536));
  }
  const base = 0;
  const xsPtr = base;
  const ysPtr = base + n * 4;
  const outPtr = base + n * 8;
  const xs = new Float32Array(mem.buffer, xsPtr, n);
  const ys = new Float32Array(mem.buffer, ysPtr, n);
  const out = new Float32Array(mem.buffer, outPtr, n);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    const v = y * inv * scale;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const i = row + x;
      xs[i] = x * inv * scale;
      ys[i] = v;
    }
  }
  mod.fill_fbm3(outPtr, xsPtr, ysPtr, n, seed);
  return new Float32Array(out);
}
