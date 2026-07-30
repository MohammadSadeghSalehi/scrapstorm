import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox","--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto("http://127.0.0.1:8080/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2000);
await page.evaluate(() => {
  window.__quality?.setTier?.("medium");
  window.__scrapstorm?.startRace?.();
});
await page.waitForTimeout(1000);
await page.evaluate(() => {
  const s = window.__scrapstorm?.getState?.();
  if (s) { s.phase = "racing"; s.countdown = 0; }
});
await page.keyboard.down("w");
// wait for car debug
for (let i = 0; i < 20; i++) {
  const ok = await page.evaluate(() => window.__carDebug?.merged === true);
  if (ok) break;
  await page.waitForTimeout(200);
}
await page.waitForTimeout(1500);
const info = await page.evaluate(() => ({
  car: window.__carDebug,
  sus: window.__suspension,
  mesh: window.__playerMesh,
  phase: window.__scrapstorm?.getState?.()?.phase,
}));
console.log(JSON.stringify(info, null, 2));
// capture via canvas toDataURL to avoid font hang
const b64 = await page.evaluate(() => {
  const c = document.querySelector("canvas");
  if (!c) return null;
  return c.toDataURL("image/png");
});
if (b64) {
  const fs = await import("fs");
  const data = b64.replace(/^data:image\/png;base64,/, "");
  fs.writeFileSync("/workspace/screenshots/all3-race-canvas.png", Buffer.from(data, "base64"));
  console.log("canvas shot written", data.length);
} else {
  console.log("no canvas");
}
await page.keyboard.up("w");
await browser.close();
