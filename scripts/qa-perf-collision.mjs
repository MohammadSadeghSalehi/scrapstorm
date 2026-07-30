import { chromium } from "playwright";
import fs from "fs";

const BASE = "http://127.0.0.1:8080/";
const OUT = "/workspace/screenshots";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});

await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/perf-menu.png`, fullPage: false });

// enter garage then race
await page.evaluate(() => {
  const btns = [...document.querySelectorAll("button")];
  const g = btns.find((b) => /garage|customize|bay/i.test(b.textContent || ""));
  if (g) g.click();
});
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/perf-garage.png`, fullPage: false });

await page.evaluate(() => {
  if (window.__scrapstorm) window.__scrapstorm.startRace();
  else {
    const btns = [...document.querySelectorAll("button")];
    const r = btns.find((b) => /race|start|deploy|launch/i.test(b.textContent || ""));
    if (r) r.click();
  }
});
await page.waitForTimeout(4500); // past countdown

const move = await page.evaluate(async () => {
  const ct = window.__controlsTest;
  const ss = window.__scrapstorm;
  if (!ct || !ss) return { err: "no hooks" };
  ct.setKeys(["KeyW"]);
  const samples = [];
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    const st = ss.getState();
    const p = st.vehicles.find((v) => v.isPlayer);
    const mesh = window.__playerMesh;
    samples.push({
      sx: p?.x ?? 0,
      sz: p?.z ?? 0,
      mx: mesh?.x ?? null,
      mz: mesh?.z ?? null,
      speed: p?.speed ?? 0,
      phase: st.phase,
    });
  }
  // force ram: move bots on top of player
  const st = ss.getState();
  const player = st.vehicles.find((v) => v.isPlayer);
  for (const v of st.vehicles) {
    if (v.isPlayer) continue;
    v.x = player.x + 0.8;
    v.z = player.z + 0.5;
    v.speed = 35;
    v.yaw = player.yaw + 0.4;
  }
  // step by waiting
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
  const after = ss.getState();
  const p2 = after.vehicles.find((v) => v.isPlayer);
  const dents = after.vehicles.map((v) => ({
    id: v.id,
    df: v.dentFront,
    dl: v.dentLeft,
    dr: v.dentRight,
    drr: v.dentRear,
    dmg: v.damageVisual,
    health: v.health,
  }));
  const fps = window.__quality?.getFps?.() ?? null;
  const packs = after; // noop
  return {
    samples: samples.slice(-5),
    first: samples[0],
    last: samples[samples.length - 1],
    meshErr: samples
      .filter((s) => s.mx != null)
      .map((s) => Math.hypot(s.sx - s.mx, s.sz - s.mz)),
    dents,
    playerHealth: p2?.health,
    playerDmg: p2?.damageVisual,
    playerDents: {
      f: p2?.dentFront,
      l: p2?.dentLeft,
      r: p2?.dentRight,
      rr: p2?.dentRear,
    },
    fps,
    phase: after.phase,
    gear: Math.abs(p2?.speed ?? 0),
    uiAccel: p2?.uiAccel,
  };
});

await page.screenshot({ path: `${OUT}/perf-race-collision.png`, fullPage: false });

// mobile
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/perf-mobile.png`, fullPage: false });

console.log(JSON.stringify({ move, errors: errors.slice(0, 20) }, null, 2));
await browser.close();
