#!/usr/bin/env node
/**
 * Headless DSP probe for src/game/audio.
 *
 *   node scripts/probe-audio.mjs
 *
 * Web Audio cannot be exercised in review — the mixer either sounds right or it
 * does not, and "does not" is usually a scheduling mistake that is inaudible
 * until the exact frame it matters. This stubs the Web Audio node graph, drives
 * the real modules, and asserts the things that are cheap to get wrong:
 *
 *   - Per-frame node allocation. This project is main-thread bound with 226 ms
 *     frame spikes; a bed that quietly builds a filter per frame would be a
 *     regression nobody would hear until it was shipped.
 *   - `exponentialRampToValueAtTime(0, …)`. Real Web Audio throws RangeError on
 *     a zero or negative target, and ramping *from* an exact zero produces no
 *     ramp at all. Both are silent in a stub and fatal in a browser, so the stub
 *     enforces them.
 *   - Distance behaviour of explosions: arrival delay, air absorption, and that
 *     the sub bypasses the absorption filter (attenuating 30 Hz with 8 kHz is
 *     the classic mistake that makes a distant blast sound like a cough).
 *   - Per-event variation, so repeated kills are not the same event.
 *   - Turbo spool lag and blow-off gating.
 *
 * Sources are transpiled with the repo's own TypeScript — no new dependencies,
 * and no dev server or renderer (software GL has frozen this machine before).
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = mkdtempSync(join(tmpdir(), "scrapstorm-audio-"));

const MODULES = [
  "noise.ts",
  "reverb.ts",
  "engineModel.ts",
  "tyreModel.ts",
  "brakeModel.ts",
  "spatial.ts",
  "explosion.ts",
  "impactModel.ts",
  "weaponModel.ts",
  "crowd.ts",
  "music.ts",
  "voBudget.ts",
  "cues.ts",
];

function build() {
  // Audio modules only. tsc still type-checks import-type edges into the
  // renderer graph (track.ts → world → meshopt), which reports TS2305 under
  // --moduleResolution node. --noEmitOnError false still emits the audio
  // CommonJS files this probe loads. execFileSync used to treat tsc's exit 2
  // as fatal even when emit succeeded, which is why CI never got past here.
  const r = spawnSync(
    process.execPath,
    [
      join(ROOT, "node_modules/typescript/bin/tsc"),
      ...MODULES.map((m) => join(ROOT, "src/game/audio", m)),
      "--outDir",
      OUT,
      "--module",
      "commonjs",
      "--moduleResolution",
      "node",
      "--target",
      "es2020",
      "--skipLibCheck",
      "--noEmitOnError",
      "false",
    ],
    { encoding: "utf8", cwd: ROOT },
  );
  if (r.status !== 0) {
    const msg = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    if (msg) console.log("tsc (non-fatal, audio emit still used):\n" + msg.split("\n").slice(0, 8).join("\n"));
  }
}

/* --------------------------------------------------------------------------
 * Web Audio stub
 * ------------------------------------------------------------------------ */

let created = 0;
/** AudioParam writes since the last reset; the per-frame cost probe reads it. */
let paramWrites = 0;
const violations = [];

/** Counts creations of every node type; the allocation assertions read this. */
function bump() {
  created += 1;
}

class Param {
  constructor(owner, name, value = 0) {
    this.owner = owner;
    this.name = name;
    this.value = value;
    /** [kind, time, value] triples, in call order. */
    this.events = [];
    this._last = value;
  }
  _note(kind, time, value) {
    paramWrites += 1;
    this.events.push([kind, time, value]);
    this._last = value;
    this.value = value;
  }
  setValueAtTime(v, t) {
    this._note("set", t, v);
    return this;
  }
  linearRampToValueAtTime(v, t) {
    this._note("lin", t, v);
    return this;
  }
  exponentialRampToValueAtTime(v, t) {
    // The two rules real Web Audio enforces and a stub would otherwise hide.
    if (!(v > 0)) {
      violations.push(
        `${this.owner}.${this.name}: exponentialRampToValueAtTime(${v}) — must be > 0`,
      );
    }
    if (this._last === 0) {
      violations.push(
        `${this.owner}.${this.name}: exponential ramp starting from exactly 0`,
      );
    }
    this._note("exp", t, v);
    return this;
  }
  setTargetAtTime(v, t, tau) {
    if (!(tau > 0)) {
      violations.push(`${this.owner}.${this.name}: setTargetAtTime tau=${tau}`);
    }
    this._note("target", t, v);
    return this;
  }
  setValueCurveAtTime(curve, t, dur) {
    // Not used anywhere by design — it throws NotSupportedError when it overlaps
    // other automation, which pooled voices do every time one is stolen.
    violations.push(`${this.owner}.${this.name}: setValueCurveAtTime used`);
    this._note("curve", t, dur);
    return this;
  }
  cancelScheduledValues(t) {
    this.events.push(["cancel", t, 0]);
    return this;
  }
}

class Node {
  constructor(ctx, kind) {
    bump();
    this.ctx = ctx;
    this.kind = kind;
    this.outs = [];
    this.started = null;
    this.stopped = null;
  }
  connect(d) {
    this.outs.push(d);
    return d;
  }
  disconnect() {
    this.outs.length = 0;
  }
  start(t = 0) {
    this.started = t;
  }
  stop(t = 0) {
    this.stopped = t;
  }
  /** Walk the connection graph looking for a node kind downstream. */
  reaches(pred, depth = 0) {
    if (depth > 24) return false;
    for (const o of this.outs) {
      if (!o || !o.kind) continue;
      if (pred(o)) return true;
      if (o.reaches && o.reaches(pred, depth + 1)) return true;
    }
    return false;
  }
}

class StubContext {
  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.destination = new Node(this, "destination");
    this.listener = {};
    for (const n of [
      "positionX",
      "positionY",
      "positionZ",
      "forwardX",
      "forwardY",
      "forwardZ",
      "upX",
      "upY",
      "upZ",
    ]) {
      this.listener[n] = new Param("listener", n);
    }
  }
  createGain() {
    const n = new Node(this, "gain");
    n.gain = new Param("gain", "gain", 1);
    return n;
  }
  createBiquadFilter() {
    const n = new Node(this, "biquad");
    n.type = "lowpass";
    n.frequency = new Param("biquad", "frequency", 350);
    n.Q = new Param("biquad", "Q", 1);
    n.gain = new Param("biquad", "gain", 0);
    n.detune = new Param("biquad", "detune", 0);
    return n;
  }
  createOscillator() {
    const n = new Node(this, "osc");
    n.type = "sine";
    n.frequency = new Param("osc", "frequency", 440);
    n.detune = new Param("osc", "detune", 0);
    return n;
  }
  createConstantSource() {
    const n = new Node(this, "constant");
    n.offset = new Param("constant", "offset", 1);
    return n;
  }
  createBufferSource() {
    const n = new Node(this, "bufferSource");
    n.buffer = null;
    n.loop = false;
    n.playbackRate = new Param("bufferSource", "playbackRate", 1);
    n.onended = null;
    return n;
  }
  createPanner() {
    const n = new Node(this, "panner");
    n.panningModel = "equalpower";
    n.distanceModel = "inverse";
    n.refDistance = 1;
    n.maxDistance = 10000;
    n.rolloffFactor = 1;
    n.positionX = new Param("panner", "positionX");
    n.positionY = new Param("panner", "positionY");
    n.positionZ = new Param("panner", "positionZ");
    n.setPosition = () => {};
    return n;
  }
  createWaveShaper() {
    const n = new Node(this, "shaper");
    n.curve = null;
    n.oversample = "none";
    return n;
  }
  createDelay() {
    const n = new Node(this, "delay");
    n.delayTime = new Param("delay", "delayTime", 0);
    return n;
  }
  createConvolver() {
    const n = new Node(this, "convolver");
    n.buffer = null;
    n.normalize = true;
    return n;
  }
  createDynamicsCompressor() {
    const n = new Node(this, "comp");
    for (const k of ["threshold", "knee", "ratio", "attack", "release"]) {
      n[k] = new Param("comp", k, 0);
    }
    return n;
  }
  createBuffer(ch, len, sr) {
    bump();
    const data = [];
    for (let i = 0; i < ch; i++) data.push(new Float32Array(len));
    return {
      numberOfChannels: ch,
      length: len,
      sampleRate: sr,
      duration: len / sr,
      getChannelData: (i) => data[i],
    };
  }
}

/* --------------------------------------------------------------------------
 * Assertions
 * ------------------------------------------------------------------------ */

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function main() {
  build();
  const require_ = createRequire(join(OUT, "x.cjs"));
  // tsc derives the output layout from the common root of everything it ends up
  // compiling, and that set includes `../types.ts` — so the audio modules land
  // in a subdirectory whose depth is not worth predicting. Find them instead.
  const emitted = new Map();
  for (const f of readdirSync(OUT, { recursive: true, withFileTypes: true })) {
    if (f.isFile() && f.name.endsWith(".js")) {
      emitted.set(f.name, join(f.parentPath ?? f.path, f.name));
    }
  }
  const load = (n) => {
    const p = emitted.get(n);
    if (!p) throw new Error(`probe: ${n} was not emitted by tsc`);
    return require_(p);
  };
  if (!emitted.get("explosion.js")) {
    throw new Error("probe: tsc did not emit audio modules");
  }

  const { ExplosionRack } = load("explosion.js");
  const { EngineVoice, ENGINE_PROFILES } = load("engineModel.js");
  const { ScrapeBed, DebrisRack } = load("impactModel.js");
  const { WeaponRack } = load("weaponModel.js");
  const { CrowdBed } = load("crowd.js");
  const { SpatialField, OPPONENT_STRIDE } = load("spatial.js");
  const { TyreBed } = load("tyreModel.js");
  const { BrakeBed } = load("brakeModel.js");
  const { musicStateFor } = load("music.js");
  const { VoBudget, VO_TIER, VO_BUDGET } = load("voBudget.js");

  /** Reused tyre-bed input; every field is required, so build it in one place. */
  const tyreIn = (over = {}) => ({
    active: true,
    speed01: 0.8,
    slip: 0.3,
    drifting: false,
    slipAngle: 0,
    load: 0.5,
    brakePressure: 0,
    boost: false,
    offroad: 0,
    roughness: 0.3,
    dt: 1 / 60,
    ...over,
  });
  const brakeIn = (over = {}) => ({
    pressure: 0,
    decel: 0,
    speed01: 0.7,
    lock: 0,
    roughness: 0.1,
    dt: 1 / 60,
    ...over,
  });

  /* --- explosions ------------------------------------------------------- */
  section("explosions");
  {
    const ctx = new StubContext();
    const dest = ctx.createGain();
    const verb = ctx.createGain();
    const rack = new ExplosionRack(ctx, dest, verb, 4);

    // Prime the shared noise buffer first: it is created lazily on first use and
    // cached for the lifetime of the context, so counting it as part of an event
    // would measure a one-time cost as a per-event one.
    rack.fire(0, 0, 0, 0, 1, 0, "vehicle", false);
    created = 0;
    rack.fire(4, 0, 0, 0, 1, 0, "vehicle", false);
    check(
      "one event creates exactly 2 nodes (osc + noise)",
      created === 2,
      `created ${created}`,
    );

    // Arrival delay. Everything in the event must be scheduled at t + d/343.
    const ctx2 = new StubContext();
    const r2 = new ExplosionRack(ctx2, ctx2.createGain(), null, 4);
    const nodes = [];
    const origOsc = ctx2.createOscillator.bind(ctx2);
    ctx2.createOscillator = () => {
      const n = origOsc();
      nodes.push(n);
      return n;
    };
    r2.fire(10, 0, 0, 0, 1, 0, "vehicle", false);
    r2.fire(10, 0, 0, 0, 1, 171.5, "vehicle", false);
    const near = nodes[0].started;
    const far = nodes[1].started;
    check(
      "arrival delay tracks distance (171.5 m ≈ 0.5 s late)",
      Math.abs(far - near - 0.5) < 0.01,
      `near ${near} far ${far}`,
    );
    check("close blast has no delay", Math.abs(near - 10) < 1e-6);

    // Air absorption must fall with distance, and the sub must not go through it.
    // The hook goes in *before* construction: the rack's filters are pooled and
    // built in the constructor, so a later hook records nothing.
    const ctx3 = new StubContext();
    const biquads = [];
    const origBq = ctx3.createBiquadFilter.bind(ctx3);
    ctx3.createBiquadFilter = () => {
      const n = origBq();
      biquads.push(n);
      return n;
    };
    const r3 = new ExplosionRack(ctx3, ctx3.createGain(), null, 2);
    // Each voice's `air` stage is the lowpass sitting at Q 0.4.
    const airs = biquads.filter((b) => b.type === "lowpass" && b.Q.value === 0.4);
    r3.fire(0, 0, 0, 0, 1, 5, "vehicle", false);
    r3.fire(0, 0, 0, 0, 1, 200, "vehicle", false);
    const cut = airs
      .map((a) => a.frequency.events.at(-1)?.[2])
      .filter((v) => typeof v === "number");
    check(
      "air absorption cutoff falls with distance",
      cut.length >= 2 && cut[1] < cut[0] * 0.35,
      `cutoffs ${cut.map((c) => c.toFixed(0)).join(", ")}`,
    );

    const ctx4 = new StubContext();
    const r4 = new ExplosionRack(ctx4, ctx4.createGain(), null, 1);
    let subOsc = null;
    const origOsc4 = ctx4.createOscillator.bind(ctx4);
    ctx4.createOscillator = () => {
      const n = origOsc4();
      subOsc = n;
      return n;
    };
    r4.fire(0, 0, 0, 0, 1, 200, "vehicle", false);
    check(
      "sub thump bypasses the air-absorption lowpass",
      subOsc !== null &&
        !subOsc.reaches((n) => n.kind === "biquad" && n.type === "lowpass" && n.Q.value === 0.4),
    );

    // Variation: ten blasts must not schedule identical sub end frequencies.
    const ctx5 = new StubContext();
    const r5 = new ExplosionRack(ctx5, ctx5.createGain(), null, 6);
    const seen = new Set();
    const origOsc5 = ctx5.createOscillator.bind(ctx5);
    let last = null;
    ctx5.createOscillator = () => {
      last = origOsc5();
      return last;
    };
    for (let i = 0; i < 10; i++) {
      r5.fire(i * 4, 0, 0, 0, 1, 20, "vehicle", false);
      seen.add(JSON.stringify(last.frequency.events));
    }
    check("ten blasts are ten different events", seen.size === 10, `${seen.size}/10 unique`);

    // Energy must not scale loudness linearly, or a chain detonation flattens
    // the limiter.
    const ctx6 = new StubContext();
    const r6 = new ExplosionRack(ctx6, ctx6.createGain(), null, 4);
    const gains = [];
    const origGain6 = ctx6.createGain.bind(ctx6);
    ctx6.createGain = () => {
      const n = origGain6();
      gains.push(n);
      return n;
    };
    const peakFor = (energy) => {
      gains.length = 0;
      const rk = new ExplosionRack(ctx6, ctx6.createGain(), null, 1);
      const before = gains.length;
      rk.fire(0, 0, 0, 0, energy, 0, "vehicle", true);
      void before;
      // subGain is the first gain created after the PannedOut stage's three.
      const sub = gains.find((g) =>
        g.gain.events.some((e) => e[0] === "exp" && e[2] > 0.01),
      );
      return Math.max(...sub.gain.events.filter((e) => e[0] === "exp").map((e) => e[2]));
    };
    const p1 = peakFor(1);
    const p8 = peakFor(8);
    check(
      "blast level is sub-linear in energy (8× energy < 3× level)",
      p8 < p1 * 3 && p8 > p1,
      `${p1.toFixed(4)} → ${p8.toFixed(4)}`,
    );
    void r6;

    // Voice stealing must not leave an event connected.
    const ctx7 = new StubContext();
    const r7 = new ExplosionRack(ctx7, ctx7.createGain(), null, 2);
    for (let i = 0; i < 8; i++) r7.fire(0, 0, 0, 0, 1, 10, "vehicle", false);
    check("oversubscribed rack does not throw", true);

    // A stolen voice must be stopped *on the timeline*, at the moment the new
    // event begins — not disconnected on the spot. The ultimate schedules its
    // detonation 0.82 s ahead and a distant kill up to 0.72 s ahead, so an
    // immediate stop would silence a blast that is still sounding to make room
    // for one that has not started.
    const ctx8 = new StubContext();
    const oscs8 = [];
    const origOsc8 = ctx8.createOscillator.bind(ctx8);
    ctx8.createOscillator = () => {
      const n = origOsc8();
      oscs8.push(n);
      return n;
    };
    const r8 = new ExplosionRack(ctx8, ctx8.createGain(), null, 1);
    r8.fire(0, 0, 0, 0, 1, 0, "vehicle", false);
    r8.fire(0.2, 0, 0, 0, 1, 0, "vehicle", false);
    check(
      "a stolen voice stops when the new event starts, not immediately",
      Math.abs(oscs8[0].stopped - 0.2) < 1e-6,
      `stopped at ${oscs8[0].stopped}`,
    );
  }

  /* --- engine ----------------------------------------------------------- */
  section("engine");
  {
    const ctx = new StubContext();
    const eng = new EngineVoice(ctx, [ctx.createGain()], "bruiser");
    const input = {
      active: true,
      speed01: 0.5,
      throttle: 1,
      brake: false,
      boost: false,
      drifting: false,
      gear: 3,
      gearFrac: 0.5,
      dt: 1 / 60,
    };
    created = 0;
    for (let i = 0; i < 600; i++) eng.update(i / 60, input);
    check(
      "600 frames at full throttle allocate no nodes",
      created === 0,
      `created ${created}`,
    );

    // Classes must differ in firing frequency, not merely in level.
    const fireFor = (id) => {
      const c = new StubContext();
      const cs = [];
      const orig = c.createConstantSource.bind(c);
      c.createConstantSource = () => {
        const n = orig();
        cs.push(n);
        return n;
      };
      const e = new EngineVoice(c, [c.createGain()], id);
      e.update(0, { ...input, gearFrac: 0.9 });
      return cs[0].offset.events.at(-1)[2];
    };
    const fi = fireFor("interceptor");
    const fb = fireFor("bruiser");
    const ft = fireFor("trickster");
    check(
      "each class has its own firing frequency",
      new Set([fi.toFixed(2), fb.toFixed(2), ft.toFixed(2)]).size === 3,
      `${fi.toFixed(1)} / ${fb.toFixed(1)} / ${ft.toFixed(1)} Hz`,
    );
    check(
      "bruiser V8 fires below the interceptor six at the same load",
      fb < fi,
      `${fb.toFixed(1)} vs ${fi.toFixed(1)}`,
    );
    check(
      "half-order lope only exists on the V8",
      ENGINE_PROFILES.bruiser.ratios[0] === 0.5 &&
        ENGINE_PROFILES.interceptor.ratios[0] === 1,
    );

    // Turbo must lag: one frame of throttle cannot produce full whistle.
    const c2 = new StubContext();
    const gains = [];
    const origG = c2.createGain.bind(c2);
    c2.createGain = () => {
      const n = origG();
      gains.push(n);
      return n;
    };
    const e2 = new EngineVoice(c2, [c2.createGain()], "trickster");
    const boosting = { ...input, boost: true, throttle: 1, gearFrac: 0.85 };
    e2.update(0, boosting);
    const turbo = gains.find((g) => g.gain.events.length && g === gains[gains.length - 1]);
    void turbo;
    let firstTurbo = null;
    let steadyTurbo = null;
    // gTurbo is the only gain whose target rises monotonically over ~1 s here;
    // find it by replaying and comparing the same node across time.
    const candidates = gains.filter((g) => g.gain.events.length > 0);
    const at = (g) => g.gain.events.at(-1)[2];
    const firstSnapshot = candidates.map(at);
    for (let i = 1; i < 90; i++) e2.update(i / 60, boosting);
    const laterSnapshot = candidates.map(at);
    let lagFound = false;
    for (let i = 0; i < candidates.length; i++) {
      if (firstSnapshot[i] < laterSnapshot[i] * 0.25 && laterSnapshot[i] > 1e-4) {
        lagFound = true;
        firstTurbo = firstSnapshot[i];
        steadyTurbo = laterSnapshot[i];
      }
    }
    check(
      "turbo spools against inertia rather than snapping on",
      lagFound,
      lagFound ? `${firstTurbo.toExponential(2)} → ${steadyTurbo.toExponential(2)}` : "",
    );

    // Blow-off must need stored pressure; a throttle blip at idle must be silent.
    const countBov = (pre, post) => {
      const c = new StubContext();
      const e3 = new EngineVoice(c, [c.createGain()], "trickster");
      for (let i = 0; i < 120; i++) e3.update(i / 60, { ...input, ...pre });
      const before = created;
      created = 0;
      for (let i = 120; i < 130; i++) e3.update(i / 60, { ...input, ...post });
      const n = created;
      created = before;
      return n;
    };
    const spooled = countBov(
      { throttle: 1, boost: true, gearFrac: 0.9, speed01: 0.9 },
      { throttle: 0, boost: false, gearFrac: 0.9, speed01: 0.9 },
    );
    const idle = countBov(
      { throttle: 0, boost: false, gearFrac: 0, speed01: 0, gear: 1 },
      { throttle: 0, boost: false, gearFrac: 0, speed01: 0, gear: 1 },
    );
    check("blow-off fires when a spooled turbo sees a closed throttle", spooled > 0);
    check("blow-off does not fire at idle", idle === 0, `nodes ${idle}`);

    // --- throttle transient -------------------------------------------------
    // Opening the throttle has to sound different from already being on it.
    // This is the difference between an engine that responds and one that is
    // merely correct at every steady state, and it is invisible to any test
    // that only samples the model at equilibrium.
    const intakeAfter = (frames) => {
      const c = new StubContext();
      const gains = [];
      const og = c.createGain.bind(c);
      c.createGain = () => {
        const n = og();
        gains.push(n);
        return n;
      };
      const e = new EngineVoice(c, [c.createGain()], "interceptor");
      // Settle at part throttle, then stab it.
      for (let i = 0; i < 60; i++) {
        e.update(i / 60, { ...input, throttle: 0.15, gearFrac: 0.4, speed01: 0.4 });
      }
      for (let i = 60; i < 60 + frames; i++) {
        e.update(i / 60, { ...input, throttle: 1, gearFrac: 0.4, speed01: 0.4 });
      }
      return gains.map((g) => g.gain.events.at(-1)?.[2] ?? 0);
    };
    const stab = intakeAfter(1);
    const settled = intakeAfter(90);
    let transient = false;
    for (let i = 0; i < Math.min(stab.length, settled.length); i++) {
      if (settled[i] > 1e-6 && stab[i] > settled[i] * 1.25) transient = true;
    }
    check(
      "opening the throttle overshoots the steady-state mix",
      transient,
      "no layer is louder on the stab than at the same throttle held",
    );

    // …and a feathered application must not produce the transient at all,
    // otherwise it is just a level offset with extra steps.
    const c3 = new StubContext();
    const g3 = [];
    const og3 = c3.createGain.bind(c3);
    c3.createGain = () => {
      const n = og3();
      g3.push(n);
      return n;
    };
    const e4 = new EngineVoice(c3, [c3.createGain()], "interceptor");
    for (let i = 0; i < 60; i++) {
      e4.update(i / 60, { ...input, throttle: 0.15, gearFrac: 0.4, speed01: 0.4 });
    }
    // 0 → 1 over two full seconds: same destination, no event.
    for (let i = 0; i < 120; i++) {
      e4.update((60 + i) / 60, {
        ...input,
        throttle: 0.15 + (i / 120) * 0.85,
        gearFrac: 0.4,
        speed01: 0.4,
      });
    }
    const feathered = g3.map((g) => g.gain.events.at(-1)?.[2] ?? 0);
    let overshotOnFeather = false;
    for (let i = 0; i < Math.min(feathered.length, settled.length); i++) {
      if (settled[i] > 1e-6 && feathered[i] > settled[i] * 1.25) {
        overshotOnFeather = true;
      }
    }
    check(
      "feathering the throttle produces no stab transient",
      !overshotOnFeather,
    );

    // --- shifts -------------------------------------------------------------
    // The bark must land AFTER the ignition cut starts. A bark on the leading
    // edge is a gearbox clunk; the same three nodes 60 ms later are an engine.
    const c4 = new StubContext();
    const srcs = [];
    const obs = c4.createBufferSource.bind(c4);
    c4.createBufferSource = () => {
      const n = obs();
      srcs.push(n);
      return n;
    };
    const e5 = new EngineVoice(c4, [c4.createGain()], "trickster");
    const pulling = { ...input, throttle: 1, gearFrac: 0.85, speed01: 0.8, gear: 2 };
    for (let i = 0; i < 30; i++) e5.update(i / 60, pulling);
    srcs.length = 0;
    const shiftAt = 30 / 60;
    e5.update(shiftAt, { ...pulling, gear: 3 });
    // The bark is the only voice scheduled ahead of the frame it was requested
    // on — the overrun crackle starts immediately. Identifying it by that
    // property rather than by counting sources keeps the test honest when a
    // random crackle happens to land on the same frame.
    const barks = (list, at) => list.filter((s) => s.started > at + 0.02);
    check(
      "an upshift generates an exhaust bark",
      barks(srcs, shiftAt).length === 1,
      `${srcs.length} sources, ${barks(srcs, shiftAt).length} scheduled ahead`,
    );
    check(
      "the bark lands after the cut has started, not on its leading edge",
      barks(srcs, shiftAt).length === 1 &&
        barks(srcs, shiftAt)[0].started - shiftAt < 0.15,
      barks(srcs, shiftAt).length
        ? `started +${(barks(srcs, shiftAt)[0].started - shiftAt).toFixed(3)}s`
        : "",
    );

    // Coasting through a gear boundary is not a shift worth hearing. (The
    // engine IS allowed to crackle here — it is on the overrun — so the test
    // asks specifically for a scheduled-ahead bark.)
    const c5 = new StubContext();
    const srcs5 = [];
    const obs5 = c5.createBufferSource.bind(c5);
    c5.createBufferSource = () => {
      const n = obs5();
      srcs5.push(n);
      return n;
    };
    const e6 = new EngineVoice(c5, [c5.createGain()], "trickster");
    const coasting = { ...input, throttle: 0, gearFrac: 0.5, speed01: 0.5, gear: 2 };
    for (let i = 0; i < 30; i++) e6.update(i / 60, coasting);
    srcs5.length = 0;
    e6.update(0.5, { ...coasting, gear: 3 });
    check("a gear change off the throttle is silent", barks(srcs5, 0.5).length === 0);
  }

  /* --- beds ------------------------------------------------------------- */
  section("continuous beds");
  {
    const ctx = new StubContext();
    const scrape = new ScrapeBed(ctx, [ctx.createGain()]);
    const tyres = new TyreBed(ctx, [ctx.createGain()]);
    const crowd = new CrowdBed(ctx, [ctx.createGain()]);
    const field = new SpatialField(ctx, ctx.createGain(), 12);
    const opp = new Float32Array(3 * OPPONENT_STRIDE);
    for (let s = 0; s < 3; s++) {
      opp[s * OPPONENT_STRIDE] = s * 10;
      opp[s * OPPONENT_STRIDE + 3] = 0.6;
      opp[s * OPPONENT_STRIDE + 4] = 0.8;
      opp[s * OPPONENT_STRIDE + 5] = s;
      opp[s * OPPONENT_STRIDE + 6] = s % 3;
    }
    created = 0;
    for (let i = 0; i < 600; i++) {
      const t = i / 60;
      scrape.update(t, { pressure: 0.6, slide: 0.7, metal: 1, dt: 1 / 60 });
      tyres.update(t, tyreIn());
      crowd.update(t, 1, 0.7, 1 / 60);
      field.updateListener(t, 0, 1, 0, 0, 0, -1, 0, 1, 0);
      field.updateOpponents(t, 1 / 60, opp, 3);
    }
    check(
      "600 frames of scrape + tyre + crowd + spatial allocate no nodes",
      created === 0,
      `created ${created}`,
    );

    // Contact must engage faster than it releases.
    const c2 = new StubContext();
    const gains2 = [];
    const origG = c2.createGain.bind(c2);
    c2.createGain = () => {
      const n = origG();
      gains2.push(n);
      return n;
    };
    const s2 = new ScrapeBed(c2, [c2.createGain()]);
    s2.update(0, { pressure: 1, slide: 0.5, metal: 1, dt: 1 / 60 });
    const lvl = gains2.find((g) =>
      g.gain.events.some((e) => e[0] === "target" && e[2] > 0),
    );
    const afterOneFrame = lvl ? lvl.gain.events.at(-1)[2] : 0;
    for (let i = 1; i < 4; i++) {
      s2.update(i / 60, { pressure: 0, slide: 0.5, metal: 1, dt: 1 / 60 });
    }
    check(
      "scrape attack is faster than its release",
      afterOneFrame > 0,
      `first frame level ${afterOneFrame.toExponential(2)}`,
    );

    // Crowd swell must not be periodic on a short cycle.
    const c3 = new StubContext();
    const g3 = [];
    const oG = c3.createGain.bind(c3);
    c3.createGain = () => {
      const n = oG();
      g3.push(n);
      return n;
    };
    const crowd3 = new CrowdBed(c3, [c3.createGain()]);
    const samples = [];
    for (let i = 0; i < 400; i++) {
      crowd3.update(i / 20, 1, 0.6, 1 / 20);
      const sw = g3.find((g) => g.gain.events.some((e) => e[2] > 0.5 && e[2] < 1.1));
      if (sw) samples.push(sw.gain.events.at(-1)[2]);
    }
    const uniq = new Set(samples.map((v) => v.toFixed(4))).size;
    check(
      "crowd swell has no short period",
      uniq > samples.length * 0.8,
      `${uniq}/${samples.length} distinct`,
    );
  }

  /* --- braking ----------------------------------------------------------- */
  section("braking");
  {
    // Silence must be free. The car is not braking for most of a lap, and a bed
    // that keeps writing "go to zero" 120 times a second is exactly the kind of
    // cost this project cannot afford on the main thread.
    const ctx = new StubContext();
    const bed = new BrakeBed(ctx, [ctx.createGain()]);
    for (let i = 0; i < 120; i++) bed.update(i / 60, brakeIn());
    paramWrites = 0;
    for (let i = 120; i < 240; i++) bed.update(i / 60, brakeIn());
    check(
      "an un-braked brake bed writes no AudioParams at all",
      paramWrites === 0,
      `${paramWrites} writes`,
    );

    // Steady braking must not allocate. The dive is gated on the envelope being
    // low, so it fires once per application and not once per second.
    const ctx2 = new StubContext();
    const b2 = new BrakeBed(ctx2, [ctx2.createGain()]);
    const hard = brakeIn({ pressure: 1, decel: 0.8, speed01: 0.6, lock: 0.2 });
    for (let i = 0; i < 60; i++) b2.update(i / 60, hard); // let the dive fire
    created = 0;
    for (let i = 60; i < 660; i++) b2.update(i / 60, hard);
    check(
      "600 frames of sustained braking allocate no nodes",
      created === 0,
      `created ${created}`,
    );

    // Run a steady braking case and pull the two voices out by walking the
    // graph from their oscillators — squealOsc → bandpass → peaking → gSqueal,
    // and absLfo → absDepth. Indexing into a creation-order array would silently
    // start measuring the wrong node the moment a layer is added.
    const brakeCase = (over) => {
      const c = new StubContext();
      const oscs = [];
      const oo = c.createOscillator.bind(c);
      c.createOscillator = () => {
        const n = oo();
        oscs.push(n);
        return n;
      };
      const b = new BrakeBed(c, [c.createGain()]);
      const inp = brakeIn({ pressure: 1, decel: 0.9, ...over });
      for (let i = 0; i < 240; i++) b.update(i / 60, inp);
      const saw = oscs.find((o) => o.type === "sawtooth");
      const tri = oscs.find((o) => o.type === "triangle");
      const gSqueal = saw.outs[0].outs[0].outs[0];
      const absDepth = tri.outs[0];
      return {
        hz: saw.frequency.events.at(-1)[2],
        squeal: gSqueal.gain.events.at(-1)[2],
        abs: absDepth.gain.events.at(-1)[2],
      };
    };

    // Squeal is a low-speed phenomenon. `level = pressure × speed` is the naive
    // version and it puts the loudest squeal at 90 m/s, which never happens.
    const slow = brakeCase({ speed01: 0.12, lock: 0 });
    const fast = brakeCase({ speed01: 0.95, lock: 0 });
    check(
      "pad squeal is loudest at low speed, not at maximum speed",
      slow.squeal > fast.squeal * 1.5 && slow.squeal > 0,
      `${slow.squeal.toExponential(2)} slow vs ${fast.squeal.toExponential(2)} fast`,
    );

    // Pad frequency must NOT track road speed — it is a rotor mode. A squeal
    // that sweeps with the car is a siren.
    check(
      "pad squeal frequency is a fixed rotor mode, not a speed sweep",
      Math.abs(slow.hz - fast.hz) / slow.hz < 0.05,
      `${slow.hz.toFixed(0)} Hz vs ${fast.hz.toFixed(0)} Hz`,
    );

    // ABS judder has to be driven by lock, and be absent without it.
    const locked = brakeCase({ speed01: 0.5, lock: 1 });
    const gripping = brakeCase({ speed01: 0.5, lock: 0 });
    check(
      "ABS judder engages on lock and is silent without it",
      locked.abs > 1e-4 && gripping.abs === 0,
      `${locked.abs.toExponential(2)} locked vs ${gripping.abs} gripping`,
    );

    // The release is an event of its own. Without it the bed simply stops, and
    // stopping is the one thing a physical object never does.
    const ctx3 = new StubContext();
    const b3 = new BrakeBed(ctx3, [ctx3.createGain()]);
    for (let i = 0; i < 60; i++) {
      b3.update(i / 60, brakeIn({ pressure: 1, decel: 0.8, speed01: 0.5 }));
    }
    created = 0;
    for (let i = 60; i < 70; i++) {
      b3.update(i / 60, brakeIn({ pressure: 0, decel: 0, speed01: 0.5 }));
    }
    check("lifting off the brakes fires a release", created > 0, `${created} nodes`);
  }

  /* --- drift voice -------------------------------------------------------- */
  section("drift");
  {
    // A slide must BUILD, not switch. One frame of full drift may not already
    // be at the steady-state level.
    const ctx = new StubContext();
    const gains = [];
    const og = ctx.createGain.bind(ctx);
    ctx.createGain = () => {
      const n = og();
      gains.push(n);
      return n;
    };
    const bed = new TyreBed(ctx, [ctx.createGain()]);
    const sliding = tyreIn({ drifting: true, slipAngle: 0.9, slip: 0.8, load: 0.8 });
    bed.update(0, sliding);
    const first = bed.getSlide();
    for (let i = 1; i < 60; i++) bed.update(i / 60, sliding);
    const steady = bed.getSlide();
    check(
      "the slide envelope builds rather than switching on",
      first < steady * 0.35 && steady > 0.5,
      `${first.toFixed(3)} → ${steady.toFixed(3)}`,
    );

    // …and RELEASES. Dropping the flag must not take the bed to zero on the
    // frame the key comes up.
    const straight = tyreIn({ drifting: false, slipAngle: 0, slip: 0, load: 0.5 });
    bed.update(1, straight);
    const justAfter = bed.getSlide();
    for (let i = 1; i < 40; i++) bed.update(1 + i / 60, straight);
    const later = bed.getSlide();
    check(
      "the slide releases over a tail instead of cutting",
      justAfter > steady * 0.85 && later < justAfter * 0.6,
      `${justAfter.toFixed(3)} → ${later.toFixed(3)}`,
    );

    // Squeal pitch tracks sliding velocity: the same angle at two speeds is not
    // the same sound.
    const pitchAt = (slipAngle, speed01) => {
      const c = new StubContext();
      const oscs = [];
      const oo = c.createOscillator.bind(c);
      c.createOscillator = () => {
        const n = oo();
        oscs.push(n);
        return n;
      };
      const b = new TyreBed(c, [c.createGain()]);
      const inp = tyreIn({ drifting: true, slipAngle, slip: 0.8, load: 0.8, speed01, roughness: 0.08 });
      for (let i = 0; i < 180; i++) b.update(i / 60, inp);
      return oscs[0].frequency.events.at(-1)[2];
    };
    const small = pitchAt(0.25, 0.6);
    const big = pitchAt(0.95, 0.6);
    const fastBig = pitchAt(0.95, 1);
    check(
      "squeal pitch rises with slip angle",
      big > small * 1.15,
      `${small.toFixed(0)} Hz → ${big.toFixed(0)} Hz`,
    );
    check(
      "the same angle at higher speed is a higher squeal",
      fastBig > big,
      `${big.toFixed(0)} Hz → ${fastBig.toFixed(0)} Hz`,
    );

    // A long slide must not keep allocating; the break-away is an edge, not a
    // state, and its rate limit has to hold.
    const ctx2 = new StubContext();
    const b2 = new TyreBed(ctx2, [ctx2.createGain()]);
    for (let i = 0; i < 120; i++) b2.update(i / 60, sliding);
    created = 0;
    for (let i = 120; i < 720; i++) b2.update(i / 60, sliding);
    check(
      "600 frames of sustained drift allocate no nodes",
      created === 0,
      `created ${created}`,
    );

    // A parked game (menu, garage, results) must not keep writing the bed down
    // once it has already arrived at silence. These phases last minutes.
    const ctx4 = new StubContext();
    const b4 = new TyreBed(ctx4, [ctx4.createGain()]);
    const eng4 = new EngineVoice(ctx4, [ctx4.createGain()], "bruiser");
    const offTyre = tyreIn({ active: false });
    const offEng = {
      active: false,
      speed01: 0,
      throttle: 0,
      brake: false,
      boost: false,
      drifting: false,
      gear: 1,
      gearFrac: 0,
      dt: 1 / 60,
    };
    for (let i = 0; i < 30; i++) {
      b4.update(i / 60, offTyre);
      eng4.update(i / 60, offEng);
    }
    paramWrites = 0;
    for (let i = 30; i < 130; i++) {
      b4.update(i / 60, offTyre);
      eng4.update(i / 60, offEng);
    }
    check(
      "a stopped engine and tyre bed write nothing on the menu",
      paramWrites === 0,
      `${paramWrites} writes over 100 frames`,
    );

    // And straight-line driving must not pay for the drift layers at all.
    const ctx3 = new StubContext();
    const b3 = new TyreBed(ctx3, [ctx3.createGain()]);
    const cruise = tyreIn({ slip: 0, slipAngle: 0, offroad: 0 });
    for (let i = 0; i < 240; i++) b3.update(i / 60, cruise);
    paramWrites = 0;
    for (let i = 240; i < 300; i++) b3.update(i / 60, cruise);
    const perFrame = paramWrites / 60;
    check(
      "cruising does not write the slide layers every frame",
      perFrame < 9,
      `${perFrame.toFixed(1)} writes/frame`,
    );
  }

  /* --- announcer budget --------------------------------------------------- */
  section("announcer budget");
  {
    const b = new VoBudget();
    check(
      "a critical line is never refused on a cold budget",
      b.request(0, VO_TIER.CRITICAL, "green", 0, 0),
    );
    // The floor rises with every line spoken, so flavour loses immediately.
    check(
      "flavour is refused once anything else has spoken",
      !b.request(30, VO_TIER.FLAVOUR, "rival", 0, 0),
    );
    check(
      "a critical line still lands in a busy window",
      b.request(30, VO_TIER.CRITICAL, "final-lap", 0, 0),
    );

    // Window budget: non-critical lines run out; critical ones cannot.
    const b2 = new VoBudget();
    let spoken = 0;
    // Distinct groups (so cooldowns cannot be doing the work) at 7 s apart, all
    // inside one window. Eight chances, four allowed.
    const tries = 8;
    for (let i = 0; i < tries; i++) {
      if (b2.request(i * 7, VO_TIER.NOTABLE, `g${i}`, 0, 0)) spoken += 1;
    }
    check(
      "non-critical lines are capped inside the rolling window",
      spoken <= VO_BUDGET.maxPerWindow && spoken > 0,
      `${spoken} of ${tries} requests inside ${VO_BUDGET.windowSeconds}s`,
    );
    check(
      "the result of the race is not subject to the cap",
      b2.request(160, VO_TIER.CRITICAL, "win", 0, 0),
    );

    // Interruption is a privilege. A MAJOR line outranks a COLOUR one, but a
    // NOTABLE one may not cut it even though it also outranks it.
    const b3 = new VoBudget();
    check(
      "a NOTABLE line does not interrupt a lower-tier line that is sounding",
      !b3.request(100, VO_TIER.NOTABLE, "overtake", 102, VO_TIER.COLOUR),
    );
    const b4 = new VoBudget();
    check(
      "a CRITICAL line does interrupt",
      b4.request(100, VO_TIER.CRITICAL, "final-lap", 102, VO_TIER.COLOUR),
    );
    const b5 = new VoBudget();
    check(
      "nothing interrupts a line of its own tier",
      !b5.request(100, VO_TIER.CRITICAL, "win", 102, VO_TIER.CRITICAL),
    );

    // Pressure raises the floor: the busier the race, the more a line must be
    // worth. Same signal the music intensity reads.
    const b6 = new VoBudget();
    b6.setPressure(1);
    check(
      "a busy race silences colour on its own",
      !b6.request(0, VO_TIER.COLOUR, "lap", 0, 0),
    );
    const b7 = new VoBudget();
    b7.setPressure(0);
    check(
      "the same line lands in a quiet race",
      b7.request(0, VO_TIER.COLOUR, "lap", 0, 0),
    );

    // A line that never became audio must give its slot back, or one missing
    // mp3 silences the announcer for a minute.
    const b8 = new VoBudget();
    b8.request(0, VO_TIER.NOTABLE, "overtake", 0, 0);
    b8.refund(0, "overtake");
    check(
      "a refunded line costs nothing",
      b8.recentCount(0) === 0 && b8.request(0.1, VO_TIER.NOTABLE, "overtake", 0, 0),
    );

    // Group cooldowns are the defence against repetition specifically.
    const b9 = new VoBudget();
    b9.request(0, VO_TIER.MAJOR, "wreck-rival", 0, 0);
    check(
      "the same group cannot repeat inside its cooldown",
      !b9.request(20, VO_TIER.MAJOR, "wreck-rival", 0, 0),
    );

    // A restart must not inherit the previous heat's budget.
    const b10 = new VoBudget();
    for (let i = 0; i < 4; i++) b10.request(i * 8, VO_TIER.NOTABLE, `g${i}`, 0, 0);
    b10.reset();
    check(
      "resetting clears the window so a new heat starts fresh",
      b10.recentCount(40) === 0,
    );

    // The whole point of the exercise: a realistic three-lap heat.
    const b11 = new VoBudget();
    const heat = [
      [0, VO_TIER.MAJOR, "grid-locked"],
      [3, VO_TIER.CRITICAL, "green"],
      [12, VO_TIER.FLAVOUR, "rival"],
      [18, VO_TIER.COLOUR, "hit"],
      [24, VO_TIER.NOTABLE, "overtake"],
      [31, VO_TIER.FLAVOUR, "close-pack"],
      [38, VO_TIER.COLOUR, "lap"],
      [45, VO_TIER.COLOUR, "boost"],
      [52, VO_TIER.FLAVOUR, "rival"],
      [61, VO_TIER.COLOUR, "hit"],
      [70, VO_TIER.MAJOR, "wreck-rival"],
      [78, VO_TIER.COLOUR, "lap"],
      [86, VO_TIER.NOTABLE, "overtaken"],
      [95, VO_TIER.CRITICAL, "final-lap"],
      [104, VO_TIER.FLAVOUR, "rival"],
      [112, VO_TIER.COLOUR, "hit"],
      [120, VO_TIER.CRITICAL, "win"],
    ];
    b11.setPressure(0.45);
    const said = [];
    for (const [t, tier, group] of heat) {
      if (b11.request(t, tier, group, 0, 0)) said.push(group);
    }
    console.log(`  heat speaks: ${said.join(", ")}`);
    check(
      "a two-minute heat speaks a handful of lines, not seventeen",
      said.length <= 8 && said.length >= 4,
      `${said.length} of ${heat.length}`,
    );
    check(
      "everything that must be heard is heard",
      said.includes("green") &&
        said.includes("final-lap") &&
        said.includes("win") &&
        said.includes("wreck-rival"),
      said.join(", "),
    );
    check(
      "no rival chatter survives a busy heat",
      !said.includes("rival") && !said.includes("close-pack"),
      said.join(", "),
    );
  }

  /* --- weapons / debris -------------------------------------------------- */
  section("weapons and debris");
  {
    const ctx = new StubContext();
    const rack = new WeaponRack(ctx, ctx.createGain(), 8);
    created = 0;
    rack.fire(0, "bolt", 0, 0, 0, 1, false);
    check("a shot creates exactly 2 nodes", created === 2, `created ${created}`);

    // Firing faster than the pool can drain must not throw or leak.
    created = 0;
    for (let i = 0; i < 60; i++) rack.fire(i * 0.02, "cannon", 0, 0, 0, 1, false);
    check(
      "60 rapid shots create 2 nodes each and no more",
      created === 120,
      `created ${created}`,
    );

    // The three weapons must be genuinely different, not one sample at three
    // playback rates — which is exactly what the bank-driven version was, since
    // discs were the laser at 0.72×. Compare the *shape* of the scheduled
    // automation (event kinds and relative timings), not the levels, so a
    // difference in loudness alone cannot pass this.
    const shapeOf = (kind) => {
      const c = new StubContext();
      const bq = [];
      const o = c.createBiquadFilter.bind(c);
      c.createBiquadFilter = () => {
        const n = o();
        bq.push(n);
        return n;
      };
      const r = new WeaponRack(c, c.createGain(), 1);
      r.fire(0, kind, 0, 0, 0, 1, false);
      return bq
        .map((b) =>
          b.frequency.events.map((e) => `${e[0]}@${e[1].toFixed(3)}`).join(","),
        )
        .join("|");
    };
    const shapes = new Set(["bolt", "cannon", "disc"].map(shapeOf));
    check(
      "bolt / cannon / disc have distinct envelopes",
      shapes.size === 3,
      `${shapes.size} distinct shapes`,
    );

    const ctx2 = new StubContext();
    const debris = new DebrisRack(ctx2, ctx2.createGain(), 5);
    created = 0;
    debris.crumple(0, 1);
    debris.glass(0, 1);
    debris.whoosh(0, 1);
    check(
      "crumple + glass + whoosh create 1 node each",
      created === 3,
      `created ${created}`,
    );
  }

  /* --- music state machine ---------------------------------------------- */
  section("music state");
  {
    const s = (phase, lap, lapCount, won = false) =>
      musicStateFor({ phase, lap, lapCount, finished: false, won });
    check("menu → menu", s("menu", 0, 3) === "menu");
    check("garage → garage", s("garage", 0, 3) === "garage");
    check("countdown → grid", s("countdown", 0, 3) === "grid");
    check("mid-race → race", s("racing", 1, 3) === "race");
    check("last lap → final", s("racing", 2, 3) === "final");
    check("win → victory", s("finished", 2, 3, true) === "victory");
    check("loss → defeat", s("finished", 2, 3, false) === "defeat");
    check(
      "finished beats the final-lap rule",
      s("finished", 2, 3, true) === "victory",
    );
  }

  /* --- per-frame cost ---------------------------------------------------- */
  section("per-frame cost");
  {
    // Measures the JS half of the frame: our arithmetic plus the AudioParam
    // call overhead against a stub. The real cost adds the browser's native
    // AudioParam marshalling, which is the same order and is what a browser
    // profile would show on top of this. What this number is *for* is catching a
    // regression — the shape of the work, not its absolute microseconds.
    const ctx = new StubContext();
    const bed = ctx.createGain();
    const eng = new EngineVoice(ctx, [bed], "bruiser");
    const tyres = new TyreBed(ctx, [bed]);
    const scrape = new ScrapeBed(ctx, [bed]);
    const brakes = new BrakeBed(ctx, [bed]);
    const crowd = new CrowdBed(ctx, [bed]);
    const field = new SpatialField(ctx, bed, 12);
    const opp = new Float32Array(3 * OPPONENT_STRIDE);
    for (let s = 0; s < 3; s++) {
      opp[s * OPPONENT_STRIDE + 3] = 0.6;
      opp[s * OPPONENT_STRIDE + 4] = 0.8;
      opp[s * OPPONENT_STRIDE + 5] = s;
      opp[s * OPPONENT_STRIDE + 6] = s % 3;
    }
    const engIn = {
      active: true,
      speed01: 0.7,
      throttle: 0.9,
      brake: false,
      boost: false,
      drifting: false,
      gear: 3,
      gearFrac: 0.6,
      dt: 1 / 60,
    };
    const tyres2 = tyreIn({ speed01: 0.7, slip: 0.2, roughness: 0.2 });
    // Contact and brake beds idle, which is the common case — the car is
    // neither scraping nor braking for the overwhelming majority of frames.
    const scrapeIn = { pressure: 0, slide: 0.7, metal: 1, dt: 1 / 60 };
    const brakes2 = brakeIn();

    const frame = (i) => {
      const t = i / 60;
      eng.update(t, engIn);
      tyres.update(t, tyres2);
      scrape.update(t, scrapeIn);
      brakes.update(t, brakes2);
      crowd.update(t, 0, 0.5, 1 / 60);
      field.updateListener(t, i * 0.1, 1, 0, 0, 0, -1, 0, 1, 0);
      field.updateOpponents(t, 1 / 60, opp, 3);
    };
    for (let i = 0; i < 2000; i++) frame(i); // warm

    // Param writes per frame is the number that actually predicts the browser
    // cost, because each one is a JS→native call. Counted over 10 frames so a
    // rate-limited layer (crackle, blow-off) cannot skew a single sample.
    paramWrites = 0;
    for (let i = 0; i < 10; i++) frame(i);
    const writes = paramWrites / 10;
    console.log(`  ${writes.toFixed(1)} AudioParam writes/frame`);
    check(
      "continuous mix stays under 120 AudioParam writes per frame",
      writes < 120,
      `${writes.toFixed(1)} writes`,
    );

    const N = 20000;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) frame(i);
    const us = Number(process.hrtime.bigint() - t0) / 1000 / N;
    console.log(`  cost ${us.toFixed(3)} µs/frame (JS side, ${N} frames)`);
    check(
      "steady-state continuous mix stays well under a 16.6 ms budget",
      us < 200,
      `${us.toFixed(3)} µs`,
    );
  }

  /* --- ramp legality ----------------------------------------------------- */
  section("automation legality");
  check(
    "no illegal exponential ramps or curve automation anywhere above",
    violations.length === 0,
    violations.slice(0, 6).join("; "),
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (violations.length) {
    console.log("\nviolations:");
    for (const v of new Set(violations)) console.log(`  - ${v}`);
  }
  return fail === 0 && violations.length === 0;
}

let ok = false;
try {
  ok = main();
} finally {
  rmSync(OUT, { recursive: true, force: true });
}
process.exitCode = ok ? 0 : 1;
