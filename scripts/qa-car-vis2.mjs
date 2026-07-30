import { chromium } from "playwright";
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on("console", (m) => { if (m.type()==='error'||m.type()==='warning') logs.push(m.text()); });
await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(6000);
const info = await page.evaluate(() => ({
  car: window.__carDebug,
  mesh: window.__playerMesh,
  phase: window.__scrapstorm?.getState?.()?.phase,
  classId: window.__scrapstorm?.getState?.()?.vehicles?.[0]?.classId,
  color: window.__scrapstorm?.getState?.()?.vehicles?.[0]?.color,
}));
console.log(JSON.stringify(info, null, 2));
console.log("logs", logs.slice(0,15));
await page.screenshot({ path: "/workspace/screenshots/fix-menu-v2.png" });
// open garage
await page.getByRole("button", { name: /Garage|garage|BUILD|class/i }).first().click().catch(()=>{});
await page.waitForTimeout(2000);
await page.screenshot({ path: "/workspace/screenshots/fix-garage-v2.png" });
await page.evaluate(() => window.__scrapstorm.startRace());
await page.waitForTimeout(5000);
await page.evaluate(() => window.__controlsTest?.setKeys?.(["KeyW"]));
await page.waitForTimeout(2000);
await page.screenshot({ path: "/workspace/screenshots/fix-race-v2.png" });
const race = await page.evaluate(() => ({
  car: window.__carDebug,
  mesh: window.__playerMesh,
  speed: window.__scrapstorm.getState().vehicles.find(v=>v.isPlayer).speed,
  fps: window.__quality?.getFps?.(),
}));
console.log("race", JSON.stringify(race, null, 2));
await browser.close();
