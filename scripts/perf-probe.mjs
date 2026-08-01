#!/usr/bin/env node
/**
 * Frame-cost probe — boots a race, turns the in-game profiler on, samples a few
 * hundred frames and prints where the time actually goes.
 *
 * Why this exists: every performance decision in this project so far has been
 * inference from draw counts, and draw counts have been actively misleading
 * (a 14fps frame measured 214 draws / 697k tris, which rules out geometry).
 * `src/game/world/gpuProfiler.ts` was built to end that and had never once been
 * read, because collection was gated on a debug panel a headless run cannot
 * open. `window.__perf` is the headless switch; this drives it.
 *
 *   node scripts/perf-probe.mjs                       # medium, 400 frames
 *   node scripts/perf-probe.mjs --tier high --label after
 *   node scripts/perf-probe.mjs --headed              # REAL GPU timer queries
 *
 * WHAT TRANSFERS FROM A HEADLESS RUN. Headless Chromium has no GPU: WebGL goes
 * through SwiftShader and every fragment is rasterised on the CPU. So GPU-side
 * conclusions do NOT transfer — a pass that is 40% of a SwiftShader frame may
 * be 2% on a real card. What does transfer is everything that is main-thread
 * JavaScript: per-useFrame callback cost, allocation rate, long tasks, draw
 * counts, and the SHAPE of the frame (how much of it is game logic vs
 * submission). Those are measured the same way on either backend.
 *
 * The per-callback numbers come from wrapping React-three-fiber's own
 * subscriber refs rather than from editing 45 useFrame call sites. The wrap
 * redefines `current` as a getter/setter on the SAME ref object — replacing the
 * ref would break r3f's unsubscribe, which matches on ref identity and would
 * silently leak every subscriber that unmounted during a run.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

/*
 * Constrain this process before Playwright launches anything.
 *
 * A previous parallel sweep froze this machine. Windows children inherit
 * affinity and priority class at creation, so pinning node here pins every
 * Chromium process it spawns — and doing it synchronously at startup closes
 * the window where the browser could launch unconstrained.
 */
if (process.platform === "win32" && !process.env.PERF_NO_PIN) {
  try {
    execSync(
      `powershell -NoProfile -Command "$p=Get-Process -Id ${process.pid}; $p.ProcessorAffinity=0x3F; $p.PriorityClass='Idle'"`,
      { stdio: "ignore" },
    );
  } catch {
    console.log("  ! could not pin affinity/priority — continuing unpinned");
  }
}

const { chromium } = await import("playwright");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--"))
    return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.split("=").slice(1).join("=") : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const URL = arg("url", process.env.PERF_URL || "http://127.0.0.1:8081/");
const TIER = arg("tier", "medium");
const FRAMES = Number(arg("frames", "400"));
const LABEL = arg("label", TIER);
const HEADED = has("headed");
const W = Number(arg("width", "1280"));
const H = Number(arg("height", "720"));
/*
 * devicePixelRatio, emulated. This is the only way to see what `dprMax` costs:
 * a Playwright page reports DPR 1, so min(devicePixelRatio, dprMax) is 1 and the
 * setting has literally no effect in an unmodified run. The panel this game is
 * played on is 2560x1600, where DPR is not 1 and dprMax is live.
 */
const DPR = Number(arg("dpr", "1"));
/*
 * Which physical GPU the browser picks.
 *
 * Chromium chose the Intel iGPU on a machine that also has an RTX 5080, and the
 * canvas asking for powerPreference:"high-performance" did not change that —
 * the adapter is chosen once, per GPU process, before any page runs.
 */
const FORCE_GPU = has("force-gpu");
const TIMEOUT_MS = Number(arg("timeout", "240")) * 1000;
const OUT = "screenshots";
mkdirSync(OUT, { recursive: true });

/* Hard watchdog. A hung page must not leave a pinned Chromium behind. */
const watchdog = setTimeout(() => {
  console.log(`\n!! watchdog fired after ${TIMEOUT_MS / 1000}s — killing run`);
  process.exit(2);
}, TIMEOUT_MS);
watchdog.unref?.();

const errors = [];
const launchArgs = {
  headless: !HEADED,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--ignore-gpu-blocklist",
    ...(HEADED
      ? ["--enable-gpu"]
      : ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"]),
    ...(FORCE_GPU ? ["--force_high_performance_gpu"] : []),
  ],
};

/*
 * The installed playwright wants a chromium revision that is not on this
 * machine (it pins 1228; 1148 and 1234 are present). Rather than download one —
 * no new dependencies — fall back to whatever browser is actually here. The
 * headless-shell build has no GPU path at all, so a --headed run must use the
 * full chrome build or the system Chrome.
 */
async function launch() {
  try {
    return await chromium.launch(launchArgs);
  } catch (e) {
    console.log(`  ! default chromium unavailable (${String(e.message).split("\n")[0]})`);
  }
  const { existsSync, readdirSync } = await import("node:fs");
  const root = `${process.env.LOCALAPPDATA || process.env.HOME}/ms-playwright`;
  const want = HEADED ? "chromium-" : "chromium_headless_shell-";
  const dirs = existsSync(root)
    ? readdirSync(root)
        .filter((d) => d.startsWith(want))
        .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    : [];
  for (const d of dirs) {
    const exe = HEADED
      ? `${root}/${d}/chrome-win64/chrome.exe`
      : `${root}/${d}/chrome-headless-shell-win64/chrome-headless-shell.exe`;
    if (!existsSync(exe)) continue;
    console.log(`  using ${d}`);
    try {
      return await chromium.launch({ ...launchArgs, executablePath: exe });
    } catch {
      /* try the next revision */
    }
  }
  console.log("  falling back to system Chrome");
  return await chromium.launch({ ...launchArgs, channel: "chrome" });
}
const browser = await launch();
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: DPR,
});
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e?.message || e).slice(0, 200)));

console.log(
  `perf-probe  url=${URL}  tier=${TIER}  frames=${FRAMES}  ${W}x${H}@${DPR}x  ${HEADED ? "HEADED/real GPU" : "headless/SwiftShader"}${FORCE_GPU ? "  force-gpu" : ""}`,
);

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page
  .waitForFunction(() => !!window.__scrapstorm, null, { timeout: 60000 })
  .catch(() => console.log("  ! __scrapstorm never appeared — engine did not boot"));

/*
 * One tier per run: switching mid-run rebuilds render targets and materials.
 *
 * __quality is installed by a GameScene effect, not at boot, and the setter is
 * optional-chained — calling it early silently no-ops and leaves the adaptive
 * scaler in charge, which on SwiftShader walks the tier straight down to low
 * within a couple of seconds. The first run of this probe measured "medium" and
 * was actually reporting low.
 */
await page
  .waitForFunction(() => !!window.__quality, null, { timeout: 30000 })
  .catch(() => console.log("  ! window.__quality never appeared — tier cannot be pinned"));
await page.evaluate((t) => {
  window.__quality?.setTier?.(t);
  window.__quality?.setAuto?.(false);
}, TIER);
await page.waitForTimeout(800);

await page.evaluate(() => window.__scrapstorm?.startRace?.());
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const s = window.__scrapstorm?.getState?.();
  if (s) {
    s.phase = "racing";
    s.countdown = 0;
  }
});
/* Re-assert: startRace remounts the world and the scaler gets another look. */
await page.evaluate((t) => {
  window.__quality?.setTier?.(t);
  window.__quality?.setAuto?.(false);
}, TIER);

/*
 * Wait for the world to actually be rendering before sampling anything.
 *
 * This cost an afternoon to find. `public/assets` is 274MB of meshes and
 * textures served by vite dev over HTTP/1.1, so ~60 asset requests queue behind
 * a 6-connection-per-origin limit for minutes. PostFX is a dynamic import, and
 * its module request sits in that same queue — so the EffectComposer does not
 * mount for a long time after the race starts. And because r3f skips its own
 * render whenever any useFrame declares priority > 0 (this scene has 30 of
 * them), no composer means the renderer draws literally nothing: info.render.
 * frame stayed at 42 across twelve seconds of "racing" while the DOM HUD
 * happily counted laps. Sampling then measures an empty frame loop.
 */
/* info.render.frame is monotonic and set by three itself, so "is it advancing"
   is unambiguous in a way that draw counts (reset per frame here) are not. */
await page.evaluate(() => {
  let store = null;
  const push = (o) => {
    const r = o?.__r3f && (o.__r3f.root || o.__r3f.store);
    if (r?.getState && !store) store = r;
  };
  push(window.__scene);
  window.__scene?.traverse?.(push);
  window.__perfGl = () => {
    const st = store?.getState?.();
    return { frame: st?.gl?.info?.render?.frame ?? -1, prio: st?.internal?.priority ?? -1 };
  };
});

const bootDeadline = Date.now() + Number(arg("boot", "240")) * 1000;
let booted = false;
let lastNote = 0;
let prevFrame = -1;
while (Date.now() < bootDeadline) {
  const s = await page.evaluate(() => ({
    perf: !!window.__perf,
    ...(window.__perfGl?.() ?? {}),
    resources: performance.getEntriesByType("resource").length,
  }));
  if (s.perf && s.frame > prevFrame && prevFrame >= 0) {
    booted = true;
    break;
  }
  prevFrame = s.frame;
  if (Date.now() - lastNote > 15000) {
    lastNote = Date.now();
    console.log(
      `  waiting for a live render… composer=${s.perf} renderFrame=${s.frame} r3fPriority=${s.prio} resourcesLoaded=${s.resources}`,
    );
  }
  await page.waitForTimeout(2000);
}
if (!booted)
  console.log(
    "  !! never reached a rendering frame — measurements below describe an EMPTY frame loop",
  );

await page.keyboard.down("w");
/*
 * Settle before sampling. ShaderWarmup compiles at +600ms and +4000ms,
 * AdaptiveResolution needs two 45-frame windows to reach its steady scale, and
 * the first seconds of a race are dominated by one-time work that would
 * otherwise be averaged into the steady-state numbers. Raise --warmup to ask
 * the separate question "does the spike RECUR", which is the one that decides
 * whether a stall is worth chasing.
 */
const WARMUP = Number(arg("warmup", "5")) * 1000;

/*
 * Keep the car moving. Holding W alone parks it against the first wall it finds
 * — the 45s warmup run reported speed=0, i.e. it measured a stationary scene
 * with no speed streaks, no motion blur ramp and no dust. Alternating steering
 * keeps it in motion without needing a driving AI.
 */
async function driveFor(ms) {
  const end = Date.now() + ms;
  let left = true;
  while (Date.now() < end) {
    const slice = Math.min(700, end - Date.now());
    await page.keyboard.down(left ? "a" : "d");
    await page.waitForTimeout(Math.max(1, slice * 0.45));
    await page.keyboard.up(left ? "a" : "d");
    await page.waitForTimeout(Math.max(1, slice * 0.55));
    left = !left;
  }
}
await driveFor(WARMUP);

const install = await page.evaluate(() => {
  /* --- reach react-three-fiber's root store ------------------------------ */
  const scene = window.__scene;
  const roots = [];
  const push = (o) => {
    const r = o && o.__r3f && (o.__r3f.root || o.__r3f.store);
    if (r && typeof r.getState === "function" && !roots.includes(r)) roots.push(r);
  };
  push(scene);
  scene?.traverse?.(push);
  if (!roots.length) return { ok: false, why: "no r3f root reachable from __scene" };
  const store = roots[0];
  const internal = store.getState().internal;
  if (!internal?.subscribers) return { ok: false, why: "store has no internal.subscribers" };

  /* --- per-subscriber timing --------------------------------------------- */
  const MARK = Symbol.for("perfProbeWrapped");
  const stats = new Map(); // label -> { calls, ms, prio }
  const wrapped = new WeakMap(); // original fn -> timing wrapper
  const undo = [];

  const fnLabel = (fn) =>
    String(fn)
      .slice(String(fn).indexOf("{") + 1)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 88);

  const patch = () => {
    for (const s of store.getState().internal.subscribers) {
      const ref = s.ref;
      if (!ref || ref[MARK]) continue;
      const box = { v: ref.current };
      const label = `p${s.priority} ${fnLabel(ref.current ?? (() => {}))}`;
      stats.set(label, stats.get(label) ?? { calls: 0, ms: 0, max: 0, slow: 0, prio: s.priority });
      const rec = stats.get(label);
      Object.defineProperty(ref, MARK, { value: true, configurable: true });
      Object.defineProperty(ref, "current", {
        configurable: true,
        get() {
          const fn = box.v;
          if (typeof fn !== "function") return fn;
          let w = wrapped.get(fn);
          if (!w) {
            w = function (...args) {
              const t0 = performance.now();
              try {
                return fn.apply(this, args);
              } finally {
                /* Mean hides spikes: a callback averaging 8ms that occasionally
                   costs 140 is a completely different problem from one that
                   costs 8 every frame, and only the second is fixed by making
                   it cheaper. */
                const dt = performance.now() - t0;
                rec.ms += dt;
                rec.calls++;
                if (dt > rec.max) rec.max = dt;
                if (dt > 16.7) rec.slow++;
              }
            };
            wrapped.set(fn, w);
          }
          return w;
        },
        set(v) {
          box.v = v;
        },
      });
      undo.push(() => {
        delete ref[MARK];
        Object.defineProperty(ref, "current", {
          value: box.v,
          writable: true,
          configurable: true,
        });
      });
    }
  };
  patch();
  /* r3f rebuilds the subscriber array on every mount/unmount; re-sweep. */
  const repatch = setInterval(patch, 500);

  /* --- r3f loop span ------------------------------------------------------
   * Bracket the whole subscriber loop by injecting two subscribers of our own
   * at the extreme priorities. Everything between them is r3f; frame period
   * minus that is React commits, GC and compositing — the part no in-engine
   * profiler can see, and the part the numbers so far say is dominant.
   * internal.priority is deliberately NOT incremented: it is already above zero
   * (30 subscribers), so leaving it alone keeps the render path identical.
   */
  const loopSpan = { ms: 0, max: 0, n: 0 };
  let loopT0 = 0;
  const inject = (fn, priority) => {
    const entry = { ref: { current: fn }, priority, store };
    const list = store.getState().internal.subscribers;
    list.push(entry);
    list.sort((a, b) => a.priority - b.priority);
    undo.push(() => {
      const l = store.getState().internal.subscribers;
      const i = l.indexOf(entry);
      if (i >= 0) l.splice(i, 1);
    });
  };
  inject(() => {
    loopT0 = performance.now();
  }, -1e6);
  inject(() => {
    const d = performance.now() - loopT0;
    loopSpan.ms += d;
    loopSpan.n++;
    if (d > loopSpan.max) loopSpan.max = d;
  }, 1e6);

  /* --- frame timing ------------------------------------------------------- */
  const dts = [];
  let last = performance.now();
  let raf = 0;
  /* Allocation rate, sampled rather than differenced end-to-end: a run that
     allocates 100MB and collects 110 shows a NEGATIVE net delta, which reads as
     "no allocation" when it is the opposite. Summing only the rises measures
     what was actually handed to the collector. */
  const heapSeries = [];
  const sampleHeap = () => heapSeries.push(performance.memory?.usedJSHeapSize ?? 0);
  const heapTimer = setInterval(sampleHeap, 200);
  sampleHeap();
  const loop = () => {
    const now = performance.now();
    dts.push(now - last);
    last = now;
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  const heap0 = performance.memory?.usedJSHeapSize ?? 0;
  const t0 = performance.now();

  window.__perfProbe = {
    frames: () => dts.length,
    stop() {
      cancelAnimationFrame(raf);
      clearInterval(repatch);
      clearInterval(heapTimer);
      sampleHeap();
      for (const f of undo) f();
      const elapsed = performance.now() - t0;
      const heap1 = performance.memory?.usedJSHeapSize ?? 0;
      let allocated = 0;
      let collections = 0;
      for (let i = 1; i < heapSeries.length; i++) {
        const d = heapSeries[i] - heapSeries[i - 1];
        if (d > 0) allocated += d;
        else if (d < -1048576) collections++;
      }
      /* Drop the first few frames: instrumentation itself warms up. */
      const d = dts.slice(3).sort((a, b) => a - b);
      const pick = (q) => d[Math.min(d.length - 1, Math.floor(d.length * q))] ?? 0;
      const sum = d.reduce((a, b) => a + b, 0);
      const cb = [...stats.entries()]
        .filter(([, v]) => v.calls > 0)
        .map(([label, v]) => ({
          label,
          prio: v.prio,
          calls: v.calls,
          totalMs: +v.ms.toFixed(1),
          msPerFrame: +(v.ms / Math.max(1, dts.length)).toFixed(3),
          maxMs: +v.max.toFixed(1),
          slowCalls: v.slow,
        }))
        .sort((a, b) => b.totalMs - a.totalMs);
      const cbTotal = cb.reduce((a, b) => a + b.totalMs, 0);
      return {
        frames: d.length,
        elapsedMs: +elapsed.toFixed(0),
        fps: +(1000 / (sum / Math.max(1, d.length))).toFixed(1),
        frameMs: {
          mean: +(sum / Math.max(1, d.length)).toFixed(2),
          p50: +pick(0.5).toFixed(2),
          p95: +pick(0.95).toFixed(2),
          p99: +pick(0.99).toFixed(2),
          max: +(d[d.length - 1] ?? 0).toFixed(2),
        },
        callbacks: cb,
        callbackMsPerFrame: +(cbTotal / Math.max(1, dts.length)).toFixed(2),
        r3fLoopMsPerFrame: +(loopSpan.ms / Math.max(1, loopSpan.n)).toFixed(2),
        r3fLoopMaxMs: +loopSpan.max.toFixed(1),
        allocMbPerSec: +(allocated / 1048576 / (elapsed / 1000)).toFixed(1),
        gcDrops: collections,
        heapMb: +((heap1 - heap0) / 1048576).toFixed(1),
      };
    },
  };
  return { ok: true, subscribers: internal.subscribers.length };
});

if (!install.ok) {
  console.log(`  !! instrumentation failed: ${install.why}`);
} else {
  console.log(`  instrumented ${install.subscribers} useFrame subscribers`);
}

/*
 * Enable the profiler and clear its averages. The EMAs carry loading-screen
 * frames that are 10-100x steady state and would dominate a 0.15-alpha average
 * for hundreds of frames.
 */
const profOn = await page.evaluate(() => {
  if (!window.__perf) return false;
  window.__perf.setEnabled(true);
  window.__perf.reset();
  return true;
});
if (!profOn) console.log("  ! window.__perf missing — PostFX/FrameProfiler not mounted?");

const sampleDeadline = Date.now() + (TIMEOUT_MS - 60000);
while (Date.now() < sampleDeadline) {
  const n = await page.evaluate(() => window.__perfProbe?.frames?.() ?? 1e9);
  if (n >= FRAMES) break;
  await driveFor(1000);
}

const out = await page.evaluate(() => {
  const p = window.__perfProbe?.stop?.() ?? null;
  const prof = window.__gpuProfile ?? null;
  const gl = window.__renderDebug;
  const q = window.__quality?.get?.();
  const canvas = document.querySelector("canvas.game-canvas") ?? document.querySelector("canvas");
  return {
    probe: p,
    profile: prof,
    render: gl
      ? {
          drawCalls: gl.drawCalls,
          triangles: gl.triangles,
          programs: gl.programs,
          textures: gl.textures,
        }
      : null,
    quality: q ? { tier: q.tier, dprMax: q.dprMax, shadowMapSize: q.shadowMapSize } : null,
    resScale: window.__resScale ?? null,
    drawingBuffer: canvas ? [canvas.width, canvas.height] : null,
    dpr: window.devicePixelRatio,
    phase: window.__scrapstorm?.getState?.()?.phase,
    speed: Math.round(window.__scrapstorm?.getState?.()?.vehicles?.find((v) => v.isPlayer)?.speed ?? 0),
    renderer: window.__webgl2Caps?.renderer ?? "unknown",
  };
});
await page.evaluate(() => window.__perf?.setEnabled(false));
await page.keyboard.up("w");

/*
 * Prove something was actually drawn.
 *
 * A blank frame is the fastest frame there is, and this project has a live way
 * to produce one: r3f skips its own render whenever any useFrame declares a
 * priority above 0, so if the EffectComposer is not mounted nothing renders at
 * all. Measuring that and reporting the fps would be worse than not measuring.
 * Capture through CDP rather than canvas.toDataURL(), which returns an empty
 * buffer under SwiftShader without preserveDrawingBuffer.
 */
const shot = await (async () => {
  const el = (await page.$("canvas.game-canvas")) ?? (await page.$("canvas"));
  const box = await el?.boundingBox();
  if (!box) return null;
  const cdp = await page.context().newCDPSession(page);
  const r = await cdp
    .send("Page.captureScreenshot", {
      format: "png",
      clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
    })
    .catch(() => null);
  if (!r) return null;
  const buf = Buffer.from(r.data, "base64");
  writeFileSync(`${OUT}/perf-${LABEL}.png`, buf);
  /* Spread of the compressed payload: a uniform frame compresses to a
     near-constant byte stream, a real scene never does. */
  let off = 8;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
    if (type === "IEND") break;
    off += 12 + len;
  }
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const step = Math.max(1, Math.floor(raw.length / 20000));
  let sum = 0;
  let n = 0;
  for (let i = 0; i < raw.length; i += step) {
    sum += raw[i];
    n++;
  }
  const mean = sum / Math.max(1, n);
  let v = 0;
  for (let i = 0; i < raw.length; i += step) v += (raw[i] - mean) ** 2;
  const stdev = Math.sqrt(v / Math.max(1, n));
  return { kb: Math.round(buf.length / 1024), stdev: +stdev.toFixed(1), flat: stdev < 8 };
})();

const p = out.probe;
const pr = out.profile;
const pad = (s, n) => String(s).padEnd(n);
const num = (v, n = 8) => String(v).padStart(n);

console.log(`\n=== ${LABEL} — ${out.renderer} ===`);
console.log(
  `phase=${out.phase} speed=${out.speed} tier=${out.quality?.tier} dprMax=${out.quality?.dprMax} resScale=${out.resScale} buffer=${out.drawingBuffer?.join("x")}`,
);
if (out.quality && out.quality.tier !== TIER)
  console.log(`  !! TIER DRIFTED to ${out.quality.tier} — numbers are NOT for ${TIER}`);
if (shot)
  console.log(
    `frame content: ${shot.kb}KB spread=${shot.stdev}${shot.flat ? "   <-- FLAT/BLANK, NOTHING WAS DRAWN" : ""}`,
  );
if (out.render && out.render.drawCalls === 0)
  console.log("  !! 0 draw calls — the scene is not being rendered at all");
if (p) {
  console.log(
    `\nFRAME  ${p.fps} fps   mean ${p.frameMs.mean}ms  p50 ${p.frameMs.p50}  p95 ${p.frameMs.p95}  p99 ${p.frameMs.p99}  max ${p.frameMs.max}   (${p.frames} frames / ${p.elapsedMs}ms)`,
  );
  const other = p.frameMs.mean - p.r3fLoopMsPerFrame;
  console.log(
    `       r3f loop ${p.r3fLoopMsPerFrame}ms/frame (max ${p.r3fLoopMaxMs})   of which useFrame ${p.callbackMsPerFrame}ms`,
  );
  console.log(
    `       outside r3f ${other.toFixed(2)}ms/frame (${((100 * other) / p.frameMs.mean).toFixed(0)}%) — React commits, GC, compositing, vsync wait`,
  );
  console.log(`       allocation ${p.allocMbPerSec}MB/s, ${p.gcDrops} collections, net ${p.heapMb}MB`);
  console.log(`\nPER-CALLBACK (r3f useFrame subscribers, main thread)`);
  console.log(`  ${pad("ms/f", 8)}${pad("%frame", 8)}${pad("max", 8)}${pad(">16ms", 7)}${pad("calls", 7)}source`);
  for (const c of p.callbacks.slice(0, 18)) {
    if (c.msPerFrame < 0.005) continue;
    console.log(
      `  ${pad(c.msPerFrame.toFixed(3), 8)}${pad(((100 * c.msPerFrame) / p.frameMs.mean).toFixed(1) + "%", 8)}${pad(c.maxMs, 8)}${pad(c.slowCalls, 7)}${pad(c.calls, 7)}${c.label}`,
    );
  }
}
if (pr) {
  console.log(
    `\nGPU PROFILER  supported=${pr.supported} enabled=${pr.enabled}  completed=${pr.health.completed} discarded=${pr.health.discarded} inflight=${pr.health.inflight} passWraps=${pr.health.passWraps} composerRenders=${pr.health.composerRenders}`,
  );
  const keys = new Set([...Object.keys(pr.gpu), ...Object.keys(pr.cpu)]);
  console.log(`  ${pad("pass", 26)}${num("gpu ms")}${num("cpu ms")}`);
  for (const k of [...keys].sort((a, b) => (pr.gpu[b] ?? pr.cpu[b] ?? 0) - (pr.gpu[a] ?? pr.cpu[a] ?? 0)))
    console.log(`  ${pad(k, 26)}${num((pr.gpu[k] ?? 0).toFixed(2))}${num((pr.cpu[k] ?? 0).toFixed(2))}`);
  console.log(
    `  long tasks: ${pr.longTasks.count} worst ${pr.longTasks.worstMs}ms  recent=${pr.longTasks.recent.map((t) => t.ms).join(",")}`,
  );
}
if (out.render)
  console.log(
    `\nDRAW  calls=${out.render.drawCalls} tris=${out.render.triangles} programs=${out.render.programs} textures=${out.render.textures}`,
  );
if (errors.length) {
  console.log(`\nCONSOLE ERRORS (${new Set(errors).size} distinct)`);
  for (const e of [...new Set(errors)].slice(0, 6)) console.log("  " + e);
}

const file = `${OUT}/perf-${LABEL}.json`;
writeFileSync(
  file,
  JSON.stringify({ label: LABEL, url: URL, headed: HEADED, tierRequested: TIER, shot, ...out, errors: [...new Set(errors)] }, null, 2),
);
console.log(`\nWrote ${file}`);
await browser.close();
clearTimeout(watchdog);
process.exit(0);
