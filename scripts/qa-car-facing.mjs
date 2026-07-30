#!/usr/bin/env node
/**
 * Close-up of the player car from the chase camera, for calibrating
 * CUSTOM_ORIENT in src/game/vehicles/GltfCar.tsx.
 *
 *   node scripts/qa-car-facing.mjs [interceptor|trickster|bruiser]
 *
 * The chase camera sits behind the car, so a correctly oriented vehicle shows
 * its REAR. Seeing a windscreen/grille/headlights means that class is 180 out.
 * Writes screenshots/facing-<class>.png cropped tight around the car.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const CLASS = process.argv[2] || "interceptor";
// No ?capture: frames come from the compositor (page.screenshot), which does
// not need preserveDrawingBuffer.
const URL = process.env.QA_URL || "http://127.0.0.1:8081/";
const OUT = "screenshots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--enable-unsafe-swiftshader",
    "--use-gl=angle",
    "--use-angle=swiftshader",
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => !!window.__scrapstorm, null, { timeout: 60000 });
await page.waitForTimeout(1500);

// Select the class through the sim so worldEpoch/sceneKey stay in sync —
// poking state.selectedClass directly remounts the scene mid-boot and leaves
// the canvas black.
await page.evaluate((c) => {
  const s = window.__scrapstorm?.getState?.();
  if (s && s.selectedClass !== c && window.__scrapstorm?.setPhase) {
    s.selectedClass = c;
    window.__scrapstorm.setPhase("garage");
  }
}, CLASS);
await page.waitForTimeout(1200);
await page.evaluate(() => window.__scrapstorm?.startRace?.());
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const s = window.__scrapstorm?.getState?.();
  if (s) {
    s.phase = "racing";
    s.countdown = 0;
  }
});
// Roll forward a little so the chase camera settles behind the car.
await page.keyboard.down("w");
await page.waitForTimeout(2600);
await page.keyboard.up("w");
await page.waitForTimeout(400);

const dbg = await page.evaluate(() => ({
  car: window.__carDebug?.url?.split("/").pop(),
  yaw: window.__carDebug?.yaw,
  orient: window.__carDebug?.orient,
  textured: window.__carDebug?.textured,
  size: window.__carDebug?.size,
}));
console.log(`class=${CLASS}`, JSON.stringify(dbg));

// Distinguish "never renders" from "still warming up": if the world only
// needs more time (HDRI/PBR packs, terrain bake), the later frame is lit.
for (const extra of [0, 4000, 6000]) {
  if (extra) await page.waitForTimeout(extra);
  const f = await page.screenshot({ timeout: 20000 });
  writeFileSync(`${OUT}/facing-${CLASS}-t${extra}.png`, f);
  const fps = await page.evaluate(() => Math.round(window.__quality?.getFps?.() ?? 0));
  console.log(`  t+${extra}ms: ${(f.length / 1024).toFixed(0)}KB fps=${fps}`);
}

// Full frame first — the crop is meaningless if the scene did not render.
const full = await page.screenshot({ timeout: 20000 });
writeFileSync(`${OUT}/facing-${CLASS}-full.png`, full);
console.log(`wrote ${OUT}/facing-${CLASS}-full.png (${(full.length / 1024).toFixed(0)}KB)`);

// Chase cam keeps the car just below centre; crop tight so it fills the frame.
const clip = { x: 440, y: 330, width: 420, height: 320 };
const buf = await page.screenshot({ clip, timeout: 20000 });
writeFileSync(`${OUT}/facing-${CLASS}.png`, buf);
console.log(`wrote ${OUT}/facing-${CLASS}.png (${(buf.length / 1024).toFixed(0)}KB)`);
await browser.close();
