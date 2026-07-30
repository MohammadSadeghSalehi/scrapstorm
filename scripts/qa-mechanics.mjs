import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (e) => errors.push("PAGE: " + String(e)));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push("CON: " + msg.text());
});

await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: "/workspace/screenshots/mechanics-menu.png" });

await page.getByRole("button", { name: /Enter the scrapyard/i }).click();
await page.waitForTimeout(600);
await page.screenshot({ path: "/workspace/screenshots/mechanics-garage.png" });

await page.getByRole("button", { name: /Enter race/i }).click();

// Headless RAF is ~0.4x — wait until racing (up to ~12s wall)
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(400);
  const phase = await page.evaluate(() => window.__scrapstorm?.getState?.()?.phase);
  if (phase === "racing") break;
}
await page.screenshot({ path: "/workspace/screenshots/mechanics-race.png" });

const mid = await page.evaluate(() => {
  const s = window.__scrapstorm.getState();
  const p = s.vehicles.find((v) => v.isPlayer);
  return {
    phase: s.phase,
    speed: p?.speed,
    yaw: p?.yaw,
    driftMeter: p?.driftMeter,
    weapon: p?.weaponCharge,
    surface: p?.surface,
    pos: p?.position,
    raceTime: s.raceTime,
  };
});
console.log("mid race", JSON.stringify(mid, null, 2));

// Wait for some speed under auto-accel
for (let i = 0; i < 25; i++) {
  await page.waitForTimeout(300);
  const sp = await page.evaluate(() => window.__controlsTest?.getSpeed?.() ?? 0);
  if (sp > 12) break;
}

// Controls self-test: A = left (+yaw)
const y0 = await page.evaluate(() => {
  window.__controlsTest.setSteer(0);
  return window.__controlsTest.getYaw();
});
await page.waitForTimeout(80);
await page.evaluate(() => window.__controlsTest.setSteer(1));
await page.waitForTimeout(800);
const yA = await page.evaluate(() => window.__controlsTest.getYaw());
await page.evaluate(() => window.__controlsTest.setSteer(-1));
await page.waitForTimeout(800);
const yD = await page.evaluate(() => window.__controlsTest.getYaw());
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const dA = wrap(yA - y0);
const dD = wrap(yD - yA);
const speed = await page.evaluate(() => window.__controlsTest.getSpeed());
console.log("steer", { y0, yA, yD, dA, dD, speed });
if (speed > 5) {
  if (dA <= 0.04) {
    console.error("FAIL A did not turn left (+yaw)", dA);
    process.exit(1);
  }
  if (dD >= -0.04) {
    console.error("FAIL D did not turn right (-yaw)", dD);
    process.exit(1);
  }
  console.log("CONTROLS OK");
} else {
  console.error("FAIL speed too low for steer test", speed);
  process.exit(1);
}

// Drift hold via Shift+A
await page.evaluate(() => window.__controlsTest.setSteer(1));
await page.keyboard.down("ShiftLeft");
await page.keyboard.down("KeyA");
await page.waitForTimeout(2000);
const during = await page.evaluate(() => {
  const p = window.__scrapstorm.getState().vehicles.find((v) => v.isPlayer);
  return {
    speed: +p.speed.toFixed(1),
    meter: +p.driftMeter.toFixed(2),
    boost: +p.boostTimer.toFixed(2),
    weapon: +p.weaponCharge.toFixed(2),
  };
});
await page.keyboard.up("ShiftLeft");
await page.keyboard.up("KeyA");
await page.evaluate(() => window.__controlsTest.setSteer(0));
await page.waitForTimeout(200);
const after = await page.evaluate(() => {
  const p = window.__scrapstorm.getState().vehicles.find((v) => v.isPlayer);
  return {
    speed: +p.speed.toFixed(1),
    meter: +p.driftMeter.toFixed(2),
    boost: +p.boostTimer.toFixed(2),
  };
});
console.log("drift play", { during, after });
await page.screenshot({ path: "/workspace/screenshots/mechanics-drift.png" });

// Mobile
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
await page.screenshot({ path: "/workspace/screenshots/mechanics-mobile.png" });

// Pause
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
const paused = await page.evaluate(() => window.__scrapstorm.getState().phase);
console.log("pause phase", paused);
await page.screenshot({ path: "/workspace/screenshots/mechanics-pause.png" });

console.log("ERRORS", errors);
if (errors.length) process.exit(1);
if (mid.phase !== "racing") {
  console.error("FAIL not racing", mid.phase);
  process.exit(1);
}
console.log("QA OK");
await browser.close();
