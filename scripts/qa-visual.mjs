#!/usr/bin/env node
/**
 * Visual QA sweep — boots the game, walks menu -> garage -> race, and writes
 * canvas PNGs + telemetry JSON into ./screenshots/.
 *
 *   npx playwright install chromium          # once
 *   node scripts/qa-visual.mjs               # one tier (medium), 1280x720
 *   node scripts/qa-visual.mjs --tiers low,medium,high
 *   node scripts/qa-visual.mjs --headed      # real GPU, truer colours
 *
 * Headless Chromium has no GPU: WebGL falls back to SwiftShader and every
 * frame is rasterised on the CPU. The full three-tier sweep can saturate the
 * machine, so the default is a single tier at a modest viewport — pass
 * --tiers to opt into more.
 *
 * Frames are captured with page.screenshot() clipped to the game canvas.
 * canvas.toDataURL() is unreliable here: under SwiftShader the readback
 * returns an empty buffer even with preserveDrawingBuffer, which silently
 * yields blank PNGs that look like a successful run.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const URL = process.env.QA_URL || "http://127.0.0.1:8080/";
const HEADED = process.argv.includes("--headed");
const tiersArg = process.argv.find((a) => a.startsWith("--tiers"));
const TIERS = tiersArg
  ? (tiersArg.split("=")[1] ?? process.argv[process.argv.indexOf(tiersArg) + 1] ?? "medium")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
  : ["medium"];
const OUT = "screenshots";
mkdirSync(OUT, { recursive: true });

const errors = [];
const failedUrls = new Map(); // url -> count, so a 404 storm is legible
// Chrome >=120 refuses to hand out a software WebGL context unless
// --enable-unsafe-swiftshader is set. Without it getContext() succeeds but
// getContextAttributes() returns null, so three.js draws nothing and
// EffectComposer.setRenderer throws "Cannot read properties of null (reading
// 'alpha')" — which reads like a game bug but is purely a harness one.
const browser = await chromium.launch({
  headless: !HEADED,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--ignore-gpu-blocklist",
    ...(HEADED
      ? ["--enable-gpu"]
      : ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"]),
  ],
});
// Smaller viewport = quadratically less software rasterisation. Pin it down
// (QA_W/QA_H) when sharing the machine with another GPU/CPU-heavy app.
const page = await browser.newPage({
  viewport: {
    width: Number(process.env.QA_W) || 1280,
    height: Number(process.env.QA_H) || 720,
  },
});
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e?.message || e)));
page.on("response", (r) => {
  if (r.status() >= 400) {
    const u = new global.URL(r.url()).pathname;
    failedUrls.set(u, (failedUrls.get(u) ?? 0) + 1);
  }
});

/** Mean/variance of a downscaled draw — catches an all-black or blank frame. */
const pixelStats = () =>
  page.evaluate(() => {
    const c = document.querySelector("canvas.game-canvas") ?? document.querySelector("canvas");
    if (!c) return null;
    const s = document.createElement("canvas");
    s.width = 32;
    s.height = 18;
    const ctx = s.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(c, 0, 0, 32, 18);
    const d = ctx.getImageData(0, 0, 32, 18).data;
    let sum = 0;
    const lum = [];
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      lum.push(l);
      sum += l;
    }
    const mean = sum / lum.length;
    const varc = lum.reduce((a, l) => a + (l - mean) ** 2, 0) / lum.length;
    return { mean: +mean.toFixed(1), stdev: +Math.sqrt(varc).toFixed(1), w: c.width, h: c.height };
  });

const shot = async (name) => {
  const el = await page.$("canvas.game-canvas");
  const target = el ?? (await page.$("canvas"));
  if (!target) {
    console.log(`  ! no canvas for ${name}`);
    return null;
  }
  const buf = await target.screenshot({ timeout: 15000 }).catch((e) => {
    console.log(`  ! screenshot failed for ${name}: ${e.message}`);
    return null;
  });
  if (!buf) return null;
  writeFileSync(`${OUT}/${name}.png`, buf);
  const px = await pixelStats();
  // stdev ~0 means a flat frame: the scene never rendered.
  const flat = px && px.stdev < 1.5;
  console.log(
    `  + ${name}.png (${(buf.length / 1024).toFixed(0)}KB) ${px ? `${px.w}x${px.h} mean=${px.mean} stdev=${px.stdev}` : ""}${flat ? "  <-- FLAT/BLANK" : ""}`,
  );
  return { bytes: buf.length, ...px, flat: !!flat };
};

const probe = () =>
  page.evaluate(() => {
    const q = window.__quality?.get?.() ?? {};
    return {
      tier: q.tier,
      fps: Math.round(window.__quality?.getFps?.() ?? 0),
      shadowMapSize: q.shadowMapSize,
      softShadows: q.softShadows,
      hdriEnv: q.hdriEnv,
      phase: window.__scrapstorm?.getState?.()?.phase,
      car: window.__carDebug?.url?.split("/").pop(),
    };
  });

/** Confirm a real WebGL2 context exists before trusting any frame. */
const glInfo = () =>
  page.evaluate(() => {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") ?? c.getContext("webgl");
    if (!gl) return { ok: false, why: "no webgl context" };
    const attrs = gl.getContextAttributes();
    if (!attrs) return { ok: false, why: "getContextAttributes() null (software GL blocked)" };
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      ok: true,
      webgl2: !!c.getContext("webgl2"),
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown",
    };
  });

const report = { url: URL, headed: HEADED, gl: null, tiers: {}, frames: {}, errors: [], failedRequests: {} };
console.log(`Booting ${URL} (${HEADED ? "headed/GPU" : "headless"}) tiers=${TIERS.join(",")}`);
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
report.gl = await glInfo();
console.log(`  gl: ${report.gl.ok ? `${report.gl.renderer} (webgl2=${report.gl.webgl2})` : `UNAVAILABLE — ${report.gl.why}`}`);
if (!report.gl.ok) console.log("  !! every frame will be blank; captures below are meaningless");
await page.waitForFunction(() => !!window.__scrapstorm, null, { timeout: 60000 }).catch(() => {
  console.log("  ! __scrapstorm never appeared — engine did not boot");
});
await page.waitForTimeout(1500);
report.frames["00-menu"] = await shot("00-menu");

for (const tier of TIERS) {
  console.log(`\n== tier: ${tier} ==`);
  await page.evaluate((t) => window.__quality?.setTier?.(t), tier);
  await page.waitForTimeout(1200);

  // Garage / showcase — hero paint + HDRI reflections
  await page.evaluate(() => window.__scrapstorm?.getState?.() && (window.__scrapstorm.getState().phase = "garage"));
  await page.waitForTimeout(2000);
  report.frames[`${tier}-1-garage`] = await shot(`${tier}-1-garage`);

  // Race
  await page.evaluate(() => window.__scrapstorm?.startRace?.());
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const s = window.__scrapstorm?.getState?.();
    if (s) {
      s.phase = "racing";
      s.countdown = 0;
    }
  });
  await page.keyboard.down("w");
  await page.waitForTimeout(2500); // build speed so post/bloom engage
  report.frames[`${tier}-2-race`] = await shot(`${tier}-2-race`);
  const mid = await probe();
  await page.waitForTimeout(1500);
  await page.keyboard.up("w");
  const end = await probe();
  report.tiers[tier] = { mid, end };
  console.log(
    `  fps=${end.fps} shadows=${end.shadowMapSize}${end.softShadows ? "/soft" : ""} hdri=${end.hdriEnv} car=${end.car}`,
  );

  await page.evaluate(() => {
    const s = window.__scrapstorm?.getState?.();
    if (s) s.phase = "menu";
  });
  await page.waitForTimeout(600);
}

report.errors = [...new Set(errors)];
report.failedRequests = Object.fromEntries([...failedUrls.entries()].sort((a, b) => b[1] - a[1]));
writeFileSync(`${OUT}/qa-report.json`, JSON.stringify(report, null, 2));

const flatFrames = Object.entries(report.frames).filter(([, f]) => f?.flat);
console.log(`\n=== FAILED REQUESTS (${failedUrls.size} distinct) ===`);
for (const [u, n] of [...failedUrls.entries()].slice(0, 15)) console.log(`  ${n}x  ${u}`);
console.log(`\n=== CONSOLE ERRORS (${report.errors.length} distinct) ===`);
for (const e of report.errors.slice(0, 10)) console.log("  " + e.slice(0, 160));
if (flatFrames.length) console.log(`\n!! ${flatFrames.length} BLANK frame(s): ${flatFrames.map(([n]) => n).join(", ")}`);
console.log(`\nWrote ${OUT}/qa-report.json + PNGs`);
await browser.close();
