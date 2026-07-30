import { chromium } from "playwright";
import fs from "fs";
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: "/workspace/screenshots/fix-menu-car.png" });

// wait for car model load
await page.waitForTimeout(3000);
await page.screenshot({ path: "/workspace/screenshots/fix-menu-car2.png" });

await page.evaluate(() => {
  window.__scrapstorm?.startRace?.();
});
await page.waitForTimeout(4500);
// throttle
await page.evaluate(() => {
  window.__controlsTest?.setKeys?.(["KeyW"]);
});
await page.waitForTimeout(2500);
const mid = await page.evaluate(() => {
  const st = window.__scrapstorm?.getState?.();
  const p = st?.vehicles?.find((v) => v.isPlayer);
  const props = st?.props || [];
  const dyn = props.filter((x) => x.dynamic && !x.dead);
  return {
    phase: st?.phase,
    speed: p?.speed,
    x: p?.x,
    z: p?.z,
    mesh: window.__playerMesh,
    propCount: props.length,
    dynamicProps: dyn.length,
    deadProps: props.filter((x) => x.dead).length,
    fps: window.__quality?.getFps?.(),
    tier: window.__quality?.get?.()?.tier,
  };
});
await page.screenshot({ path: "/workspace/screenshots/fix-race-car.png" });

// Drive into props - teleport near a dynamic prop and ram
const ram = await page.evaluate(() => {
  const st = window.__scrapstorm.getState();
  const p = st.vehicles.find((v) => v.isPlayer);
  const prop = st.props.find((x) => x.dynamic && !x.dead && x.kind === "barrel");
  if (!p || !prop) return { ok: false };
  p.x = prop.x - 3;
  p.z = prop.z;
  p.yaw = Math.atan2(-(prop.x - p.x), -(prop.z - p.z));
  p.speed = 40;
  p.lateral = 0;
  const before = { px: prop.x, pz: prop.z, vx: prop.vx, hp: prop.hp };
  return { ok: true, before, propId: prop.id };
});
await page.waitForTimeout(800);
const after = await page.evaluate((id) => {
  const st = window.__scrapstorm.getState();
  const prop = st.props.find((x) => x.id === id);
  const p = st.vehicles.find((v) => v.isPlayer);
  return {
    prop: prop ? { x: prop.x, z: prop.z, vx: prop.vx, vz: prop.vz, hp: prop.hp, dead: prop.dead, dent: prop.dent } : null,
    playerSpeed: p?.speed,
    playerFlash: p?.impactFlash,
  };
}, ram.propId);
await page.screenshot({ path: "/workspace/screenshots/fix-prop-ram.png" });

// barrier hit
const bar = await page.evaluate(() => {
  const st = window.__scrapstorm.getState();
  const p = st.vehicles.find((v) => v.isPlayer);
  const b = st.props.find((x) => x.kind === "barrier" && !x.dead);
  if (!p || !b) return null;
  const hx = p.health;
  p.x = b.x - 1.2;
  p.z = b.z;
  p.speed = 35;
  p.yaw = Math.atan2(-(b.x - p.x), -(b.z - p.z));
  return { hx, bx: b.x, bz: b.z };
});
await page.waitForTimeout(600);
const barAfter = await page.evaluate(() => {
  const st = window.__scrapstorm.getState();
  const p = st.vehicles.find((v) => v.isPlayer);
  return { health: p?.health, speed: p?.speed, flash: p?.impactFlash, x: p?.x, z: p?.z };
});

console.log(JSON.stringify({ mid, ram, after, bar, barAfter, errors: errors.slice(0, 12) }, null, 2));
await browser.close();
