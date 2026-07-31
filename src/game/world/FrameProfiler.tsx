/**
 * Wires the GPU profiler to the actual render pipeline.
 *
 * The interesting question this answers is not "how many milliseconds" but
 * "which side" — a frame that is 70ms because the GPU is saturated and a frame
 * that is 70ms because the main thread is blocked look identical from the
 * outside and have nothing in common as problems. Reporting GPU and CPU time
 * for the same bracket makes that immediately obvious: if GPU ms is small and
 * CPU ms is large, no amount of shader or resolution work will help.
 */
import { useEffect, useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { EffectComposer, Pass } from "postprocessing";
import {
  gpuProfiler,
  startLongTaskWatch,
  stopLongTaskWatch,
} from "./gpuProfiler";
import { longTaskReport } from "./gpuProfiler";

/**
 * R3F stops rendering automatically once any useFrame subscription declares a
 * priority above 0, and @react-three/postprocessing's EffectComposer claims
 * priority 1 and drives the render itself. So a subscription just under 1 runs
 * immediately before the composer, and one just above it runs immediately
 * after — which brackets the entire GPU submission for the frame without
 * touching the render path.
 */
const BEFORE_RENDER = 0.5;
const AFTER_RENDER = 1.5;

type Patched = Pass & { __profiled?: boolean };

export function FrameProfiler({
  composer,
}: {
  composer: RefObject<EffectComposer | null>;
}) {
  const gl = useThree((s) => s.gl);
  const ready = useRef(false);

  useEffect(() => {
    gpuProfiler.init(gl);
    gpuProfiler.register("frame");
    startLongTaskWatch();
    ready.current = true;

    /*
     * Expose on window rather than through React state.
     *
     * The overlay reads this every few hundred ms; routing it through state
     * would re-render the HUD at that rate, and a profiler that costs frame
     * time to display is self-defeating. Getters mean nothing is computed
     * unless something actually asks.
     */
    Object.defineProperty(window, "__gpuProfile", {
      configurable: true,
      get: () => ({
        supported: gpuProfiler.supported,
        enabled: gpuProfiler.enabled,
        gpu: gpuProfiler.gpuTimes(),
        cpu: gpuProfiler.cpuTimes(),
        longTasks: longTaskReport(),
        health: gpuProfiler.health(),
      }),
    });

    return () => {
      stopLongTaskWatch();
      gpuProfiler.dispose();
      ready.current = false;
      delete (window as unknown as Record<string, unknown>).__gpuProfile;
    };
  }, [gl]);

  /*
   * Patch each pass's render method so a pass reports its own time.
   *
   * Done by wrapping rather than by timing from outside because the composer
   * decides internally which passes run, in what order, and whether any are
   * skipped this frame. Timing from outside would attribute a skipped pass's
   * zero to whatever ran next. The patch is idempotent — the composer rebuilds
   * its pass list whenever an effect is added or removed, and this effect
   * re-runs then.
   */
  useEffect(() => {
    const c = composer.current;
    if (!c) return;
    const passes = (c as unknown as { passes: Patched[] }).passes;
    if (!passes) return;
    const undo: Array<() => void> = [];
    for (const pass of passes) {
      if (pass.__profiled) continue;
      const label = pass.name || pass.constructor.name;
      gpuProfiler.register(label);
      const original = pass.render.bind(pass);
      const wrapped: Pass["render"] = (...args) => {
        gpuProfiler.begin(label);
        try {
          return original(...args);
        } finally {
          gpuProfiler.end(label);
        }
      };
      pass.render = wrapped;
      pass.__profiled = true;
      undo.push(() => {
        pass.render = original;
        pass.__profiled = false;
      });
    }
    return () => {
      for (const fn of undo) fn();
    };
  });

  useFrame(() => {
    if (ready.current) gpuProfiler.begin("frame");
  }, BEFORE_RENDER);

  useFrame(() => {
    if (!ready.current) return;
    gpuProfiler.end("frame");
    gpuProfiler.tick();
  }, AFTER_RENDER);

  return null;
}
