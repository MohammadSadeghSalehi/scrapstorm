/**
 * Optional graphics debug panel — quality tier, FPS, cull stats, WASM/WebGPU.
 * Toggle with backtick ` or window.__graphicsDebug = true
 *
 * FpsMeter is the lightweight always-available counter; its visibility is a
 * persisted user option (F key), separate from this full diagnostic panel.
 */
import { useEffect, useState } from "react";
import { qualityManager, type QualityTier } from "@/game/world/quality";
import { getWasmNoiseStatus } from "@/game/world/procmat/wasmRuntime";
import { listLoadedPacks } from "@/game/world/webgl2/textureLibrary";
import { getWebGL2Caps } from "@/game/world/webgl2/configure";

const FPS_PREF = "scrapstorm.showFps";

/**
 * Small FPS/frame-time readout. Toggle with F; the choice persists.
 *
 * Frame time matters more than FPS when diagnosing: 60fps with occasional
 * 40ms frames reads as smooth on an averaged counter but feels like stutter,
 * so the worst frame over the last second is shown alongside the average.
 */
export function FpsMeter({ phase }: { phase: string }) {
  const [on, setOn] = useState(false);
  const [snap, setSnap] = useState({ fps: 0, ms: 0, worst: 0 });

  useEffect(() => {
    try {
      setOn(localStorage.getItem(FPS_PREF) === "1");
    } catch {
      /* private mode */
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyF" || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      setOn((v) => {
        const next = !v;
        try {
          localStorage.setItem(FPS_PREF, next ? "1" : "0");
        } catch {
          /* private mode */
        }
        return next;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!on) return;
    let raf = 0;
    let last = performance.now();
    let worst = 0;
    let acc = 0;
    let frames = 0;
    const loop = () => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      if (dt < 250) {
        // ignore tab-switch gaps
        worst = Math.max(worst, dt);
        acc += dt;
        frames++;
      }
      if (acc >= 500) {
        setSnap({
          fps: Math.round(1000 / (acc / frames)),
          ms: +(acc / frames).toFixed(1),
          worst: +worst.toFixed(1),
        });
        acc = 0;
        frames = 0;
        worst = 0;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [on]);

  if (!on || phase === "menu") return null;
  const hitch = snap.worst > 33;
  return (
    <div className="pointer-events-none absolute right-3 top-20 z-30 rounded bg-stone-950/70 px-2 py-1 font-mono text-[11px] leading-tight text-stone-200 backdrop-blur-sm">
      <span className={snap.fps < 45 ? "text-amber-400" : "text-emerald-400"}>
        {snap.fps} fps
      </span>
      <span className="ml-2 text-stone-400">{snap.ms}ms</span>
      <span className={`ml-2 ${hitch ? "text-red-400" : "text-stone-500"}`}>
        max {snap.worst}ms
      </span>
    </div>
  );
}

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
    calls: 0,
    tris: 0,
    programs: 0,
  });
  const caps = getWebGL2Caps();
  const gpu = caps?.renderer && caps.renderer !== "unknown" ? caps.renderer : null;

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
        calls: window.__renderDebug?.drawCalls ?? 0,
        tris: window.__renderDebug?.triangles ?? 0,
        programs: window.__renderDebug?.programs ?? 0,
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
      {/* Which physical GPU the browser actually picked. Browsers never use
          CUDA — WebGL goes through ANGLE to D3D11/Vulkan — so this string is
          the way to confirm the discrete card is in use rather than the iGPU. */}
      {gpu && (
        <div className="mt-1 border-t border-stone-800 pt-1">
          <div className="text-stone-500">gpu</div>
          <div className="font-mono break-words text-[9px] text-stone-300">{gpu}</div>
        </div>
      )}
      {line("draw calls", String(snap.calls))}
      {line("triangles", snap.tris > 1000 ? `${(snap.tris / 1000).toFixed(1)}k` : String(snap.tris))}
      {line("programs", String(snap.programs))}
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
        ` panel · F fps · Alt+1/2/3 tier · Alt+0 auto
      </div>
    </div>
  );
}
