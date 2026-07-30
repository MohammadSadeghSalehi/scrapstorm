/**
 * WebGPU investigation for Scrapstorm shaders.
 *
 *   npx tsx scripts/explore-webgpu.mjs
 *
 * Probes:
 *   - Three r185 WebGPU / TSL module surface
 *   - Playwright Chromium navigator.gpu (usually absent headless)
 *   - TSL node material graph construction (no GPU required)
 *   - Strategy comparison vs current onBeforeCompile path
 */
import { chromium } from "playwright";
import {
  WEBGPU_SHADER_FINDINGS,
  detectWebGpuSync,
} from "../src/game/world/shaders/webgpu.ts";

console.log("=== WebGPU shader investigation ===\n");

// ── Module surface ──────────────────────────────────────────────────────────
const three = await import("three");
const webgpu = await import("three/webgpu");
const tsl = await import("three/tsl");
const WebGPUCap = (await import("three/examples/jsm/capabilities/WebGPU.js")).default;

console.log("Three REVISION:", three.REVISION);
console.log("WebGPU.isAvailable (node):", WebGPUCap.isAvailable?.() ?? "n/a");
console.log("WebGPURenderer:", typeof webgpu.WebGPURenderer);
console.log("MeshStandardNodeMaterial:", typeof webgpu.MeshStandardNodeMaterial);

const noiseKeys = Object.keys(tsl).filter((k) =>
  /noise|hash|fbm|fractal|worley|cell/i.test(k),
);
console.log("TSL noise-related exports:", noiseKeys.length);
console.log("  ", noiseKeys.slice(0, 16).join(", "), "…");

// ── TSL graph smoke (CPU construct only) ────────────────────────────────────
const { createTslDetailMaterial } = await import(
  "../src/game/world/shaders/tslSurface.ts"
);
const { qualityManager } = await import("../src/game/world/quality.ts");
const handle = createTslDetailMaterial({
  kind: "asphalt",
  quality: qualityManager.get(),
  detailScale: 14,
});
console.log("\nTSL asphalt material constructed:", !!handle.material.colorNode);
console.log("  uniforms:", Object.keys(handle.uniforms).join(", "));

// ── Browser probe ───────────────────────────────────────────────────────────
console.log("\n--- Playwright Chromium WebGPU ---");
let browserInfo = { hasNavigatorGpu: false, error: null, computeOk: null };
try {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan,UseSkiaRenderer",
    ],
  });
  const page = await browser.newPage();
  browserInfo = await page.evaluate(async () => {
    const out = {
      hasNavigatorGpu: !!(navigator.gpu),
      error: null,
      computeOk: null,
      features: [],
    };
    if (!navigator.gpu) {
      out.error = "navigator.gpu missing (typical for headless CI)";
      return out;
    }
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        out.error = "no adapter";
        return out;
      }
      out.features = [...adapter.features];
      const device = await adapter.requestDevice();
      out.computeOk = true;
      device.destroy();
    } catch (e) {
      out.error = String(e);
    }
    return out;
  });
  await browser.close();
} catch (e) {
  browserInfo.error = String(e);
}
console.log(JSON.stringify(browserInfo, null, 2));

// ── Sync detect helper ──────────────────────────────────────────────────────
console.log("\n--- detectWebGpuSync (node) ---");
console.log(detectWebGpuSync());

// ── Findings ────────────────────────────────────────────────────────────────
console.log("\n=== Strategy comparison ===\n");
console.log("CURRENT:", JSON.stringify(WEBGPU_SHADER_FINDINGS.current, null, 2));
console.log("\nWEBGPU+TSL:", JSON.stringify(WEBGPU_SHADER_FINDINGS.webgpuTsl, null, 2));
console.log("\nDECISION:", JSON.stringify(WEBGPU_SHADER_FINDINGS.decision, null, 2));

console.log(`
=== Migration sketch (when ready) ===

// GameCanvas gl factory (R3F):
// const renderer = new WebGPURenderer({ antialias, powerPreference: "high-performance" });
// await renderer.init();
// return renderer;

// Or force WebGL backend for TSL without real WebGPU:
// new WebGPURenderer({ forceWebGL: true })

// Replace createProcMaterial GPU inject with:
// createTslDetailMaterial({ kind: "asphalt", quality }) + assign baked maps

=== Wire-in criteria ===
  Trial:  desktop Chrome share high + want compute bake or cleaner nodes
  Adopt:  dual-path proven (WebGPU + WebGL fallback) and all materials on TSL
  Skip:   ship-now polish — current onBeforeCompile path is correct for reach
`);

console.log("EXPLORE_WEBGPU_OK", {
  threeRevision: three.REVISION,
  tslNoiseExports: noiseKeys.length,
  tslMaterialOk: !!handle.material.colorNode,
  browserGpu: browserInfo.hasNavigatorGpu,
  recommendation: WEBGPU_SHADER_FINDINGS.decision.now,
});
