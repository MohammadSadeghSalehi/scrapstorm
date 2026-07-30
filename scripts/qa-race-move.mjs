import { chromium } from "playwright";
const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(2000);
await page.evaluate(() => window.__scrapstorm?.startRace());
// wait for racing
for (let i = 0; i < 80; i++) {
  const p = await page.evaluate(() => window.__scrapstorm?.getState()?.phase);
  if (p === "racing") break;
  await page.waitForTimeout(100);
}
const result = await page.evaluate(async () => {
  const ct = window.__controlsTest;
  const ss = window.__scrapstorm;
  ct.setKeys(["KeyW"]);
  const start = ss.getState().vehicles.find((v) => v.isPlayer);
  const s0 = { x: start.x, z: start.z, speed: start.speed };
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
  const end = ss.getState().vehicles.find((v) => v.isPlayer);
  const mesh = window.__playerMesh;
  const err = mesh ? Math.hypot(end.x - mesh.x, end.z - mesh.z) : -1;
  return {
    s0,
    s1: { x: end.x, z: end.z, speed: end.speed, uiAccel: end.uiAccel },
    dist: Math.hypot(end.x - s0.x, end.z - s0.z),
    meshErr: err,
    fps: window.__quality?.getFps?.(),
    packs: window.__webgl2Caps,
  };
});
await page.screenshot({ path: "/workspace/screenshots/perf-racing-drive.png" });
console.log(JSON.stringify({ result, errors }, null, 2));
await browser.close();
