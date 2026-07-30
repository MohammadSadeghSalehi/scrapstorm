import { chromium } from "playwright";
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e}`));
await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(5000);
// check network for car glb
const carStatus = await page.evaluate(async () => {
  const urls = [
    "/assets/meshes/cars/car_concept.glb",
    "/assets/meshes/cars/toy_car.glb",
    "/assets/meshes/truck/CesiumMilkTruck.glb",
  ];
  const out = {};
  for (const u of urls) {
    try {
      const r = await fetch(u);
      out[u] = { status: r.status, len: r.headers.get("content-length"), type: r.headers.get("content-type") };
    } catch (e) {
      out[u] = { err: String(e) };
    }
  }
  // scene graph
  const canvas = document.querySelector("canvas");
  return { out, hasCanvas: !!canvas, mesh: window.__playerMesh, phase: window.__scrapstorm?.getState?.()?.phase };
});
console.log(JSON.stringify(carStatus, null, 2));
console.log("LOGS:", logs.filter(l => /car|gltf|meshopt|error|fail|warn/i.test(l)).slice(0, 30));
await page.screenshot({ path: "/workspace/screenshots/fix-garage-detail.png" });
// go garage
await page.evaluate(() => {
  // click garage if button
});
// force start and check vehicle mesh children via three - hard
// elevate player y for visibility test
await page.evaluate(() => {
  const st = window.__scrapstorm.getState();
  const p = st.vehicles.find(v => v.isPlayer);
  if (p) { p.y = 2; p.x = 12; p.z = -18; }
});
await page.waitForTimeout(1000);
await page.screenshot({ path: "/workspace/screenshots/fix-elevated.png" });
await browser.close();
