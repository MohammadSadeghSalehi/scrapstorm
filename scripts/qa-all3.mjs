import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:8080/";
const shot = process.argv[3] || "/workspace/screenshots/all3-verify.png";

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message || e)));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push("console:" + msg.text().slice(0, 180));
});

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2500);

await page.evaluate(() => {
  window.__quality?.setTier?.("medium");
  window.__scrapstorm?.startRace?.();
});
await page.waitForTimeout(800);

// Force racing phase + inject input via controls if available
await page.evaluate(() => {
  const s = window.__scrapstorm?.getState?.();
  if (s) {
    s.phase = "racing";
    s.countdown = 0;
  }
});

await page.keyboard.down("w");
await page.waitForTimeout(500);
await page.keyboard.down("Shift");

const samples = [];
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(400);
  const st = await page.evaluate(() => {
    const s = window.__scrapstorm?.getState?.();
    const p = s?.player;
    return {
      phase: s?.phase,
      speed: p?.speed,
      pitch: p?.bodyPitch,
      roll: p?.bodyRoll,
      tires: p?.tires?.map((t) => ({
        c: Number(t.compress?.toFixed?.(3)),
        cv: Number(t.compressVel?.toFixed?.(3)),
      })),
      sus: window.__suspension,
      car: window.__carDebug
        ? {
            merged: window.__carDebug.merged,
            drawCalls: window.__carDebug.drawCalls,
            size: window.__carDebug.size,
          }
        : null,
      q: window.__quality?.get?.()?.tier,
      meshSpd: window.__playerMesh?.speed,
    };
  });
  samples.push(st);
  console.log("t", i, "spd", st.speed?.toFixed?.(1), "phase", st.phase, "q", st.q, "avgC", st.sus?.avg, "rear", st.sus?.rear, "front", st.sus?.front);
}

await page.keyboard.down("a");
await page.waitForTimeout(600);
const turn = await page.evaluate(() => window.__suspension);
console.log("turn sus", JSON.stringify(turn));
await page.keyboard.up("a");
await page.keyboard.up("Shift");
await page.keyboard.up("w");

try {
  await page.screenshot({ path: shot, timeout: 8000, animations: "disabled" });
  console.log("shot ok");
} catch (e) {
  console.log("shot fail", e.message);
}

const last = samples[samples.length - 1];
console.log("LAST", JSON.stringify(last, null, 2));
console.log("errors", errors.slice(0, 8));

// Pass criteria
const carOk = last?.car?.merged === true && last?.car?.drawCalls <= 8;
const size = last?.car?.size || [];
const aspect = Math.max(size[0], size[2]) / Math.max(1e-3, Math.min(size[0], size[2]));
const propOk = aspect > 1.3;
const moved = samples.some((s) => (s.speed ?? 0) > 5);
const susMoved = samples.some(
  (s) =>
    Math.abs((s.sus?.rear ?? 0.14) - (s.sus?.front ?? 0.14)) > 0.02 ||
    Math.abs((s.sus?.avg ?? 0.14) - 0.14) > 0.03,
);
console.log(JSON.stringify({ carOk, propOk, aspect, moved, susMoved, q: last?.q }));

await browser.close();
process.exit(carOk && propOk ? 0 : 2);
