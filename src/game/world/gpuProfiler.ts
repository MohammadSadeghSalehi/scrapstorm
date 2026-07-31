/**
 * GPU timing via EXT_disjoint_timer_query_webgl2.
 *
 * Why this exists: every performance claim made about this project so far has
 * been inference from draw counts, and draw counts have been actively
 * misleading. A frame reported at 14fps measured 214 draws and 697k triangles —
 * numbers that rule out geometry entirely and say nothing about where the time
 * actually went. Guessing produced a 102 -> 14fps regression that took a full
 * revert to unwind. This replaces the guessing.
 *
 * ONE QUERY AT A TIME. WebGL2 allows a single active TIME_ELAPSED query per
 * context and they cannot nest, so per-pass numbers cannot all be collected in
 * the same frame. Instead one registered section is measured per frame,
 * round-robin, and results are smoothed. At 60fps a six-section rotation still
 * refreshes every section ten times a second, which is far faster than anyone
 * can read them.
 *
 * ASYNCHRONOUS BY NATURE. A timer result is not available in the frame that
 * issued it — reading it back immediately would stall the pipeline and destroy
 * the very thing being measured. Queries are polled on later frames, which is
 * why there is an in-flight ring rather than a single query object.
 */
import type * as THREE from "three";

/** Enough to cover the read-back latency without unbounded growth. */
const MAX_INFLIGHT = 12;
/** Smoothing on the reported value. Fast enough to react, slow enough to read. */
const EMA_ALPHA = 0.15;

type Slot = { label: string; query: WebGLQuery };

/*
 * TIME_ELAPSED_EXT is defined by the extension, not by the core context, so it
 * is absent from the WebGL2RenderingContext typings. The value is fixed by the
 * spec.
 */
const TIME_ELAPSED_EXT = 0x88bf;

class GpuProfiler {
  private gl2: WebGL2RenderingContext | null = null;
  private ext: { GPU_DISJOINT_EXT: number } | null = null;
  private pool: WebGLQuery[] = [];
  private inflight: Slot[] = [];
  private active: Slot | null = null;
  private order: string[] = [];
  private cursor = 0;
  private ema = new Map<string, number>();
  private cpu = new Map<string, number>();
  private cpuMark = new Map<string, number>();

  supported = false;
  enabled = false;
  /*
   * Self-diagnosis. An empty result table has three very different causes —
   * extension missing, results still in flight, or every batch being discarded
   * as disjoint — and they are indistinguishable from a blank panel. Two bugs
   * today were silent failures that looked like working code, so this reports
   * whether it is actually collecting rather than leaving it to be inferred.
   */
  completed = 0;
  discarded = 0;

  init(renderer: THREE.WebGLRenderer): boolean {
    const ctx = renderer.getContext();
    // WebGL1 has a different, less useful extension; not worth supporting.
    if (typeof WebGL2RenderingContext === "undefined") return false;
    if (!(ctx instanceof WebGL2RenderingContext)) return false;
    this.gl2 = ctx;
    this.ext = ctx.getExtension("EXT_disjoint_timer_query_webgl2");
    this.supported = !!this.ext;
    return this.supported;
  }

  /**
   * Declare a section. Registration order is the rotation order, so sections
   * registered later are still sampled — just later in the cycle.
   */
  register(label: string) {
    if (!this.order.includes(label)) this.order.push(label);
  }

  /** True when `label` is this frame's turn in the rotation. */
  private isTurn(label: string): boolean {
    if (!this.order.length) return false;
    return this.order[this.cursor % this.order.length] === label;
  }

  /** Advance the rotation. Call once per frame, after all sections have run. */
  tick() {
    if (!this.enabled) return;
    this.cursor++;
    this.poll();
  }

  begin(label: string) {
    if (!this.enabled) return;
    this.cpuMark.set(label, performance.now());
    const gl = this.gl2;
    // A second begin while one is active is a GL error, not a no-op — bail
    // rather than corrupt the in-flight query.
    if (!gl || !this.supported || this.active || !this.isTurn(label)) return;
    const query = this.pool.pop() ?? gl.createQuery();
    if (!query) return;
    gl.beginQuery(TIME_ELAPSED_EXT, query);
    this.active = { label, query };
  }

  end(label: string) {
    if (!this.enabled) return;
    const t0 = this.cpuMark.get(label);
    if (t0 !== undefined) {
      const dt = performance.now() - t0;
      this.cpu.set(label, (this.cpu.get(label) ?? dt) * (1 - EMA_ALPHA) + dt * EMA_ALPHA);
    }
    const gl = this.gl2;
    if (!gl || !this.active || this.active.label !== label) return;
    gl.endQuery(TIME_ELAPSED_EXT);
    if (this.inflight.length < MAX_INFLIGHT) this.inflight.push(this.active);
    else this.pool.push(this.active.query);
    this.active = null;
  }

  private poll() {
    const gl = this.gl2;
    const ext = this.ext;
    if (!gl || !ext) return;
    /*
     * A disjoint means the GPU was interrupted (context switch, power state
     * change) and EVERY outstanding timer is garbage — not just the one that
     * happened to span it. Reading the flag clears it, so this must happen
     * once per poll, and the correct response is to throw the whole batch
     * away. Keeping the values produces occasional wild spikes that look
     * exactly like a real stall and send you chasing nothing.
     */
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      for (const s of this.inflight) this.pool.push(s.query);
      this.discarded += this.inflight.length;
      this.inflight.length = 0;
      return;
    }
    for (let i = this.inflight.length - 1; i >= 0; i--) {
      const s = this.inflight[i]!;
      if (!gl.getQueryParameter(s.query, gl.QUERY_RESULT_AVAILABLE)) continue;
      const ns = gl.getQueryParameter(s.query, gl.QUERY_RESULT) as number;
      const ms = ns / 1e6;
      const prev = this.ema.get(s.label);
      this.ema.set(s.label, prev === undefined ? ms : prev * (1 - EMA_ALPHA) + ms * EMA_ALPHA);
      this.inflight.splice(i, 1);
      this.pool.push(s.query);
      this.completed++;
    }
  }

  /** GPU milliseconds per section, smoothed. */
  gpuTimes(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.ema) out[k] = Math.round(v * 100) / 100;
    return out;
  }

  /** Main-thread milliseconds per section, smoothed. Always available. */
  cpuTimes(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.cpu) out[k] = Math.round(v * 100) / 100;
    return out;
  }

  /** Is it collecting, and if not, why not. */
  health(): { completed: number; discarded: number; inflight: number } {
    return {
      completed: this.completed,
      discarded: this.discarded,
      inflight: this.inflight.length,
    };
  }

  dispose() {
    const gl = this.gl2;
    if (gl) {
      for (const s of this.inflight) gl.deleteQuery(s.query);
      for (const q of this.pool) gl.deleteQuery(q);
    }
    this.inflight.length = 0;
    this.pool.length = 0;
    this.active = null;
    this.ema.clear();
    this.cpu.clear();
    this.completed = 0;
    this.discarded = 0;
  }
}

export const gpuProfiler = new GpuProfiler();

/**
 * Long-task watcher.
 *
 * The reading that started this was 14fps at 73ms average but 226ms PEAK. A
 * 226ms frame is not something a GPU does — that is the main thread blocking,
 * and no amount of GPU timing will find it. PerformanceObserver reports these
 * directly, including how long and (sometimes) which container caused them.
 */
type LongTask = { at: number; ms: number };
const longTasks: LongTask[] = [];
let observer: PerformanceObserver | null = null;

export function startLongTaskWatch() {
  if (observer || typeof PerformanceObserver === "undefined") return;
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTasks.push({ at: Math.round(e.startTime), ms: Math.round(e.duration) });
        // Keep the tail; the interesting ones are the recent ones.
        if (longTasks.length > 40) longTasks.shift();
      }
    });
    // Not supported everywhere, and unsupported entryTypes throw rather than
    // being ignored.
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    observer = null;
  }
}

export function stopLongTaskWatch() {
  observer?.disconnect();
  observer = null;
}

export function longTaskReport(): { count: number; worstMs: number; recent: LongTask[] } {
  let worst = 0;
  for (const t of longTasks) if (t.ms > worst) worst = t.ms;
  return { count: longTasks.length, worstMs: worst, recent: longTasks.slice(-8) };
}

export type ProfileSnap = {
  supported: boolean;
  enabled: boolean;
  gpu: Record<string, number>;
  cpu: Record<string, number>;
  longTasks: { count: number; worstMs: number; recent: LongTask[] };
  health: { completed: number; discarded: number; inflight: number };
};

declare global {
  interface Window {
    /**
     * Live profile, installed by FrameProfiler while the scene is mounted.
     * A getter, not a snapshot — nothing is computed unless something reads it.
     */
    __gpuProfile?: ProfileSnap;
  }
}
