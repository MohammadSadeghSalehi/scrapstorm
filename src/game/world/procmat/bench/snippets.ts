/**
 * Benchmark code snippets for procedural noise + WASM SIMD hash lattice.
 *
 * Usage (Node):
 *   npx tsx scripts/bench-noise.mjs
 */
export type BenchResult = {
  label: string;
  ms: number;
  samples?: number;
  msPerMSample?: number;
};

export function bench(label: string, fn: () => void, iters = 7): BenchResult {
  fn();
  let best = Infinity;
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return { label, ms: best };
}

export function withThroughput(r: BenchResult, samples: number): BenchResult {
  return {
    ...r,
    samples,
    msPerMSample: samples > 0 ? r.ms / (samples / 1e6) : undefined,
  };
}

export function formatBenchRow(r: BenchResult): string {
  const ms = r.ms.toFixed(3).padStart(8);
  if (r.samples != null && r.samples > 0) {
    const mps = (r.samples / 1e6 / (r.ms / 1000)).toFixed(1).padStart(7);
    return `${r.label.padEnd(40)} ${ms} ms  ${mps} Msamples/s`;
  }
  return `${r.label.padEnd(40)} ${ms} ms`;
}

export function printBenchTable(rows: BenchResult[]): void {
  for (const r of rows) console.log("  " + formatBenchRow(r));
}

export function hashLatticeJS(ix: number, iy: number, seed = 0): number {
  let n =
    Math.imul(ix | 0, 374761393) +
    Math.imul(iy | 0, 668265263) +
    Math.imul(seed | 0, 1442695041);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n = (n ^ (n >>> 16)) >>> 0;
  return n / 4294967296;
}

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

export function valueNoiseHashJS(x: number, y: number, seed = 0): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const a = hashLatticeJS(x0, y0, seed);
  const b = hashLatticeJS(x0 + 1, y0, seed);
  const c = hashLatticeJS(x0, y0 + 1, seed);
  const d = hashLatticeJS(x0 + 1, y0 + 1, seed);
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}

export function fbm3HashJS(x: number, y: number, seed = 0): number {
  return (
    (0.5 * valueNoiseHashJS(x, y, seed) +
      0.25 * valueNoiseHashJS(x * 2, y * 2, seed + 1) +
      0.125 * valueNoiseHashJS(x * 4, y * 4, seed + 2)) /
    0.875
  );
}

export function snippetA_scalarValueNoise(
  width = 256,
  height = 256,
): BenchResult {
  const { xs, ys, out, n } = makeGrid(width, height);
  const r = bench("A  JS hash valueNoise", () => {
    for (let i = 0; i < n; i++) out[i] = valueNoiseHashJS(xs[i], ys[i], 1);
  });
  return withThroughput(r, n);
}

export function snippetA2_scalarFbm3(width = 256, height = 256): BenchResult {
  const { xs, ys, out, n } = makeGrid(width, height);
  const r = bench("A2 JS hash fbm3", () => {
    for (let i = 0; i < n; i++) out[i] = fbm3HashJS(xs[i], ys[i], 2);
  });
  return withThroughput(r, n);
}

export type WasmNoiseModule = {
  memory: WebAssembly.Memory;
  fill_value_noise: (
    out: number,
    xs: number,
    ys: number,
    count: number,
    seed: number,
  ) => void;
  fill_fbm3: (
    out: number,
    xs: number,
    ys: number,
    count: number,
    seed: number,
  ) => void;
  value_noise4_ptr: (
    out: number,
    xp: number,
    yp: number,
    seed: number,
  ) => void;
  hash4_ptr: (out: number, ixp: number, iyp: number, seed: number) => void;
};

export function wasmSimdSupported(): boolean {
  try {
    return WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10,
        1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
      ]),
    );
  } catch {
    return false;
  }
}

export async function loadWasmNoise(
  wasmBytes: BufferSource,
): Promise<WasmNoiseModule> {
  const { instance } = await WebAssembly.instantiate(wasmBytes);
  return instance.exports as unknown as WasmNoiseModule;
}

function ensureWasmBytes(memory: WebAssembly.Memory, need: number): void {
  const pages = Math.ceil(need / 65536);
  const have = memory.buffer.byteLength / 65536;
  if (pages > have) memory.grow(pages - have);
}

export function snippetB_wasmValueNoise(
  mod: WasmNoiseModule,
  width = 256,
  height = 256,
): BenchResult {
  const n = width * height;
  if (n % 4 !== 0) throw new Error("count must be multiple of 4");
  const XS = 0;
  const YS = n * 4;
  const OUT = n * 8;
  ensureWasmBytes(mod.memory, n * 12 + 64);
  const xs = new Float32Array(mod.memory.buffer, XS, n);
  const ys = new Float32Array(mod.memory.buffer, YS, n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      xs[i] = x * 0.07;
      ys[i] = y * 0.07;
    }
  }
  const r = bench("B  WASM SIMD fill_value_noise", () => {
    mod.fill_value_noise(OUT, XS, YS, n, 1);
  });
  return withThroughput(r, n);
}

export function snippetB2_wasmFbm3(
  mod: WasmNoiseModule,
  width = 256,
  height = 256,
): BenchResult {
  const n = width * height;
  const XS = 0;
  const YS = n * 4;
  const OUT = n * 8;
  ensureWasmBytes(mod.memory, n * 12 + 64);
  const xs = new Float32Array(mod.memory.buffer, XS, n);
  const ys = new Float32Array(mod.memory.buffer, YS, n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      xs[i] = x * 0.07;
      ys[i] = y * 0.07;
    }
  }
  const r = bench("B2 WASM SIMD fill_fbm3", () => {
    mod.fill_fbm3(OUT, XS, YS, n, 2);
  });
  return withThroughput(r, n);
}

export async function snippetC_recipeBakes(): Promise<BenchResult[]> {
  const { getRecipeBakeSpec } = await import("../recipes");
  const { measureSampleBakeMs } = await import("../bake");
  const ids = ["asphalt", "dirt", "sand", "metal", "rust"] as const;
  const rows: BenchResult[] = [];
  for (const id of ids) {
    const spec = getRecipeBakeSpec(id);
    measureSampleBakeMs(spec.size, spec.sample, {
      normalStrength: spec.normalStrength,
    });
    const ms = measureSampleBakeMs(spec.size, spec.sample, {
      normalStrength: spec.normalStrength,
    });
    rows.push(
      withThroughput(
        { label: `C  recipe bake ${id} ${spec.size}²`, ms },
        spec.size * spec.size,
      ),
    );
  }
  return rows;
}

export function snippetD_microOps(evals = 1_000_000): BenchResult[] {
  const rows: BenchResult[] = [];
  rows.push(
    withThroughput(
      bench("D  hashLatticeJS ×N", () => {
        let s = 0;
        for (let i = 0; i < evals; i++) s += hashLatticeJS(i, i * 3, 1);
        if (s === Infinity) throw 0;
      }),
      evals,
    ),
  );
  rows.push(
    withThroughput(
      bench("D  valueNoiseHashJS ×N", () => {
        let s = 0;
        for (let i = 0; i < evals; i++)
          s += valueNoiseHashJS(i * 0.01, i * 0.007, 1);
        if (s === Infinity) throw 0;
      }),
      evals,
    ),
  );
  rows.push(
    withThroughput(
      bench("D  fbm3HashJS ×N", () => {
        let s = 0;
        for (let i = 0; i < evals; i++) s += fbm3HashJS(i * 0.01, i * 0.007, 1);
        if (s === Infinity) throw 0;
      }),
      evals,
    ),
  );
  return rows;
}

export function makeGrid(width: number, height: number, scale = 0.07) {
  const n = width * height;
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const out = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      xs[i] = x * scale;
      ys[i] = y * scale;
    }
  }
  return { xs, ys, out, n, width, height };
}

export function speedup(js: BenchResult, wasm: BenchResult): number {
  return js.ms / Math.max(1e-9, wasm.ms);
}
