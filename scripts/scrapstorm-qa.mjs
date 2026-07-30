import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (e) => errors.push("PAGE: " + String(e)));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push("CON: " + msg.text());
  if (msg.type() === "warning") console.log("WARN:", msg.text());
});

await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(2000);

const info = await page.evaluate(() => {
  const canvas = document.querySelector("canvas");
  const gl = canvas?.getContext?.("webgl2") || canvas?.getContext?.("webgl");
  return {
    canvas: !!canvas,
    w: canvas?.width,
    h: canvas?.height,
    cw: canvas?.clientWidth,
    ch: canvas?.clientHeight,
    scrapstorm: !!window.__scrapstorm,
    controls: !!window.__controlsTest,
    state: window.__scrapstorm?.getState?.()?.phase,
    player: window.__scrapstorm?.getState?.()?.vehicles?.[0],
  };
});
console.log("info", JSON.stringify(info, null, 2));
await page.screenshot({ path: "/workspace/screenshots/01-menu.png" });

await page.getByRole("button", { name: /Enter the scrapyard|Race Ash Spire/i }).click();
await page.waitForTimeout(800);
await page.screenshot({ path: "/workspace/screenshots/02-garage.png" });

await page.getByRole("button", { name: /Enter race/i }).click();
// Headless RAF is slower — wait until racing
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(400);
  const phase = await page.evaluate(() => window.__scrapstorm?.getState?.()?.phase);
  if (phase === "racing") break;
}
await page.screenshot({ path: "/workspace/screenshots/04-racing.png" });

const mid = await page.evaluate(() => {
  const s = window.__scrapstorm.getState();
  const p = s.vehicles[0];
  return { phase: s.phase, lap: p.lap, speed: p.speed, x: p.x, z: p.z, y: p.y, yaw: p.yaw };
});
console.log("mid", mid);

// controls
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(250);
  const sp = await page.evaluate(() => window.__controlsTest?.getSpeed?.() ?? 0);
  if (sp > 12) break;
}
const y0 = await page.evaluate(() => {
  window.__controlsTest.setSteer(0);
  return window.__controlsTest.getYaw();
});
await page.waitForTimeout(100);
await page.evaluate(() => window.__controlsTest.setSteer(1));
await page.waitForTimeout(500);
const yA = await page.evaluate(() => window.__controlsTest.getYaw());
await page.evaluate(() => window.__controlsTest.setSteer(-1));
await page.waitForTimeout(500);
const yD = await page.evaluate(() => window.__controlsTest.getYaw());
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
console.log("steer", {
  y0,
  yA,
  yD,
  dA: wrap(yA - y0),
  dD: wrap(yD - yA),
  speed: await page.evaluate(() => window.__controlsTest.getSpeed()),
});

await page.evaluate(() => window.__controlsTest.setSteer(0));
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
await page.screenshot({ path: "/workspace/screenshots/05-mobile.png" });

console.log("ERRORS", errors);
await browser.close();
