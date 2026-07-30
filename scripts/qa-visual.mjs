#!/usr/bin/env node
/**
 * Visual QA sweep — boots the game, walks menu -> garage -> race across every
 * quality tier, and writes canvas PNGs + telemetry JSON into ./screenshots/.
 *
 *   npx playwright install chromium     # once
 *   node scripts/qa-visual.mjs                 # headless (software GL)
 *   node scripts/qa-visual.mjs --headed        # real GPU, truer colours
 *
 * Canvas is captured via toDataURL (page.screenshot can hang on font load),
 * which is why GameScene keeps preserveDrawingBuffer:true.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const URL = process.env.QA_URL || "http://127.0.0.1:8080/";
const HEADED = process.argv.includes("--headed");
const OUT = "screenshots";
mkdirSync(OUT, { recursive: true });

const errors = [];
const browser = await chromium.launch({
  headless: !HEADED,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e?.message || e)));

const shot = async (name) => {
  const b64 = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    return c ? c.toDataURL("image/png") : null;
  });
  if (!b64) return console.log(`  ! no canvas for ${name}`);
  const data = b64.replace(/^data:image\/png;base64,/, "");
  const buf = Buffer.from(data, "base64");
  writeFileSync(`${OUT}/${name}.png`, buf);
  // A near-empty canvas means the effect chain broke and rendered black.
  console.log(`  + ${name}.png (${(buf.length / 1024).toFixed(0)}KB)`);
  return buf.length;
};
const probe = () => page.evaluate(() => {
  const q = window.__quality?.get?.() ?? {};
  return {
    tier: q.tier, fps: Math.round(window.__quality?.getFps?.() ?? 0),
    shadowMapSize: q.shadowMapSize, softShadows: q.softShadows, hdriEnv: q.hdriEnv,
    phase: window.__scrapstorm?.getState?.()?.phase,
    car: window.__carDebug?.url?.split("/").pop(),
    cull: window.__terrainCull?.visible,
  };
});

const report = { url: URL, headed: HEADED, tiers: {}, errors: [] };
console.log(`Booting ${URL} (${HEADED ? "headed/GPU" : "headless"})...`);
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(4000);          // shell paints, then engine dynamic-imports
await shot("00-menu");

for (const tier of ["low", "medium", "high"]) {
  console.log(`\n== tier: ${tier} ==`);
  await page.evaluate((t) => window.__quality?.setTier?.(t), tier);
  await page.waitForTimeout(1500);

  // Garage / showcase — checks hero paint + HDRI reflections
  await page.evaluate(() => window.__scrapstorm?.getState?.() && (window.__scrapstorm.getState().phase = "garage"));
  await page.waitForTimeout(2500);
  await shot(`${tier}-1-garage`);

  // Race
  await page.evaluate(() => window.__scrapstorm?.startRace?.());
  await page.waitForTimeout(1200);
  await page.evaluate(() => { const s = window.__scrapstorm?.getState?.(); if (s) { s.phase = "racing"; s.countdown = 0; } });
  await page.keyboard.down("w");
  await page.waitForTimeout(4000);        // build speed so post/bloom/streaks engage
  await shot(`${tier}-2-race`);
  const mid = await probe();
  await page.waitForTimeout(3000);
  await page.keyboard.up("w");
  const end = await probe();
  report.tiers[tier] = { mid, end };
  console.log(`  fps=${end.fps} shadows=${end.shadowMapSize}${end.softShadows ? "/soft" : ""} hdri=${end.hdriEnv} car=${end.car}`);

  // back to menu for the next pass
  await page.evaluate(() => { const s = window.__scrapstorm?.getState?.(); if (s) s.phase = "menu"; });
  await page.waitForTimeout(800);
}

report.errors = errors;
writeFileSync(`${OUT}/qa-report.json`, JSON.stringify(report, null, 2));
console.log(`\n=== ERRORS (${errors.length}) ===`);
for (const e of errors.slice(0, 20)) console.log("  " + e);
console.log(`\nWrote ${OUT}/qa-report.json + PNGs`);
await browser.close();
