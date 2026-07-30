/**
 * Optional graphics debug panel — quality tier, FPS, cull stats, WASM/WebGPU.
 * Toggle with backtick ` or window.__graphicsDebug = true
 */
import { useEffect, useState } from "react";
import { qualityManager, type QualityTier } from "@/game/world/quality";
import { getWasmNoiseStatus } from "@/game/world/procmat/wasmRuntime";
import { listLoadedPacks } from "@/game/world/webgl2/textureLibrary";

type CullSnap = {
  ground?: { stats: { visible: number; tested: number } };
  dunes?: { stats: { visible: number; tested: number } };
  scenery?: { stats: { visible: number; tested: number } };
  edges?: { visible: number; total: number };
  beacons?: { visible: number; tested: number };
};

export function GraphicsDebug({ phase }: { phase: string }) {
  const [open, setOpen] = useState(false);
  const [snap, setSnap] = useState({
    tier: qualityManager.get().tier as QualityTier,
    fps: 0,
    cull: null as CullSnap | null,
    wasm: "idle",
    webgpu: "?",
    packs: 0,
    webgl2: false,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Backquote" && !e.repeat) {
        setOpen((v) => !v);
      }
      if (e.code === "Digit1" && e.altKey) qualityManager.setTier("low", { auto: false });
      if (e.code === "Digit2" && e.altKey) qualityManager.setTier("medium", { auto: false });
      if (e.code === "Digit3" && e.altKey) qualityManager.setTier("high", { auto: false });
      if (e.code === "Digit0" && e.altKey) qualityManager.setAuto(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => {
      const cull = window.__terrainCull as CullSnap | undefined;
      setSnap({
        tier: qualityManager.get().tier,
        fps: Math.round(qualityManager.getFpsEma()),
        cull: cull ?? null,
        wasm: getWasmNoiseStatus(),
        webgpu: window.__webgpuProbe?.status ?? "?",
        packs: listLoadedPacks().length,
        webgl2: !!window.__webgl2Caps?.isWebGL2,
      });
    }, 250);
    return () => clearInterval(id);
  }, [open]);

  if (!open || phase === "menu") return null;

  const c = snap.cull;
  const line = (label: string, v: string) => (
    <div className="flex justify-between gap-3">
      <span className="text-stone-500">{label}</span>
      <span className="font-mono text-stone-200">{v}</span>
    </div>
  );

  return (
    <div className="pointer-events-auto absolute bottom-3 left-3 z-30 max-w-[240px] rounded-md border border-stone-700/80 bg-stone-950/85 px-2.5 py-2 text-[10px] leading-relaxed text-stone-300 shadow-lg backdrop-blur-sm">
      <div className="mb-1 flex items-center justify-between font-semibold tracking-wide text-amber-400/90">
        <span>GFX DEBUG</span>
        <span className="font-mono text-stone-400">{snap.fps} fps</span>
      </div>
      {line("tier", `${snap.tier} ${qualityManager.isAuto() ? "(auto)" : ""}`)}
      {line("webgl2", snap.webgl2 ? "yes" : "no")}
      {line("webgpu", snap.webgpu)}
      {line("wasm", snap.wasm)}
      {line("pbr packs", String(snap.packs))}
      {c?.ground &&
        line("ground", `${c.ground.stats.visible}/${c.ground.stats.tested}`)}
      {c?.dunes && line("dunes", `${c.dunes.stats.visible}/${c.dunes.stats.tested}`)}
      {c?.scenery &&
        line("scenery", `${c.scenery.stats.visible}/${c.scenery.stats.tested}`)}
      {c?.edges && line("edges", `${c.edges.visible}/${c.edges.total}`)}
      {c?.beacons &&
        line("beacons", `${c.beacons.visible}/${c.beacons.tested}`)}
      <div className="mt-1.5 border-t border-stone-800 pt-1 text-[9px] text-stone-600">
        ` toggle · Alt+1/2/3 tier · Alt+0 auto
      </div>
    </div>
  );
}
