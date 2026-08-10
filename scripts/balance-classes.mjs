/**
 * Class balance arena — measures Interceptor vs Bruiser vs Trickster by racing
 * them against each other in the REAL GameSimulation.
 *
 * A balance claim without numbers is worthless, and this project has shipped
 * "fixes" that measured nothing. So: no assertions about how a class feels,
 * only a table of win rate, mean finishing position and lap pace.
 *
 * ── the experimental design, and why it is this and not simpler ──────
 *
 * The three MEASURED cars are the three bots. They all carry the SAME
 * RivalProfile, so aiSkill hands all three identical grip/power/turn trims and
 * the only difference left between them is the class. The player slot is
 * present as traffic and is never scored — aiSkill returns a flat 1/1/1 for the
 * player, so scoring it would be comparing a class against a different driver.
 *
 * Every configuration runs all six permutations of the three classes across the
 * three bot grid slots, so grid position cancels out exactly rather than
 * approximately. The player's class is rotated across the three as well, so no
 * class is systematically racing behind its own twin.
 *
 * Math.random is replaced with a seeded generator for the whole run. aiInput
 * rolls for boost windows, weapon timing and mistake scheduling; without a seed
 * the same build reports a different table every time and a 3% change is
 * indistinguishable from noise.
 *
 * Scoring is DISTANCE COVERED IN A FIXED WINDOW, not the chequered flag, and
 * that is deliberate. GameSimulation ends the race 2.2s after the PLAYER
 * crosses the line, so racing to the flag scores the three measured cars
 * against a cutoff set by the one car that is not being measured — a class that
 * happens to share the player's pace gets more of a race than one that does
 * not. The lap count is set out of reach so the window, and only the window,
 * decides. Laps still complete inside it, so lap times are real.
 *
 * ── weather ──────────────────────────────────────────────────────────
 *
 * `--weather wet|storm|overcast` runs the same matrix under a condition. The
 * claim a wet condition has to satisfy is NOT that it changes nothing — it is
 * supposed to change the driving — but that it does not change WHO WINS. Rain
 * that quietly hands the race to one class is a balance change wearing a
 * weather costume, and the only way to know which one you shipped is to run
 * this table twice.
 *
 *   node scripts/balance-classes.mjs [--window 150] [--reps 2] [--quick]
 *                                    [--weather wet] [--clean] [--seed N]
 */
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const ai = await jiti.import("../src/game/ai.ts");
const classes = await jiti.import("../src/game/classes.ts");
const track = await jiti.import("../src/game/track.ts");
const simMod = await jiti.import("../src/game/sim.ts");
const weather = await jiti.import("../src/game/world/weather/index.ts");

const argv = process.argv.slice(2);
const argNum = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const QUICK = argv.includes("--quick");
/** Seconds of racing scored. ~2 laps of Ash Spire for a mid-pace field. */
const WINDOW = argNum("--window", 150);
/** Out of reach inside the window, so nobody triggers the flag. */
const LAPS = 30;
/*
 * REPS used to default to 2, i.e. 72 races, and at 72 races THIS HARNESS
 * CANNOT SEE A SIX-POINT BUDGET.
 *
 * Exactly one class wins each race, so under perfect balance the three win
 * counts are multinomial(n, 1/3) and the reported max-minus-min is the range of
 * three such proportions. That statistic is strictly positive and, at n = 72,
 * has a MEDIAN OF 11.1 POINTS (200k-trial Monte Carlo: mean 11.5, p90 19.4,
 * and P(range <= 6) = 19.5%). A perfectly balanced build fails a "spread <= 6"
 * gate four times in five, and a build that happens to draw 4.2 looks tuned.
 * Both numbers have been read off this script as evidence in the past and
 * neither meant anything.
 *
 * The null range shrinks as 1/sqrt(n): 8.2 at 144, 5.7 at 288, 4.1 at 576,
 * 2.9 at 1152, where P(range <= 6) finally reaches 96.8%. So 1152 is the
 * smallest sample at which passing the gate is evidence rather than luck, and
 * that is the default. See the null band printed under the table — read the
 * spread against THAT, never against zero.
 */
const REPS = argNum("--reps", QUICK ? 1 : 32);
const CIRCUITS = QUICK ? ["ash_spire"] : ["ash_spire", "rustline", "cinder_bowl"];
/** Two ends of the aiSkill ladder — balance has to hold across both. */
const PACES = QUICK ? [0.55] : [0.2, 0.9];

const CLASS_IDS = ["interceptor", "bruiser", "trickster"];

const argStr = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const WEATHER_ID = argStr("--weather", "dry");
if (!weather.WEATHER[WEATHER_ID]) {
  console.error(`unknown --weather ${WEATHER_ID}`);
  process.exit(2);
}
// Set once, outside the loop: setWeather bumps an epoch that renderer-side
// consumers memoise on, and a per-race toggle would be measuring the switch.
weather.setWeather(WEATHER_ID);

/*
 * ── --grip road=0.8,powerSlip=0.1 ─────────────────────────────────────
 *
 * Ablation. A condition moves seven grip terms at once, so "storm is out of
 * balance" names a costume, not a cause, and the only way to find which term
 * carries it is to put them back one at a time and re-measure.
 *
 * This exists because guessing was tried first and was wrong: slideBiasMul was
 * the obvious suspect on a well-argued physical story — a multiplier takes the
 * most breakaway margin from the Trickster, who has the least — and swapping it
 * for an additive term moved storm 7.4 -> 9.1. A clean single-variable negative,
 * and thirty-five minutes to get an answer that this flag gives in one run per
 * term. See the slideBiasMul note in world/weather/conditions.ts.
 *
 * Mutating the WEATHER table directly is safe here and nowhere else: this is a
 * measurement process that exits, the value is read live through getWeather()
 * on every step, and nothing persists it.
 */
const GRIP_OVERRIDE = argStr("--grip", null);
if (GRIP_OVERRIDE) {
  const grip = weather.WEATHER[WEATHER_ID].grip;
  for (const pair of GRIP_OVERRIDE.split(",")) {
    const [k, v] = pair.split("=");
    if (!(k in grip)) {
      console.error(`unknown grip term ${k} — have ${Object.keys(grip).join(", ")}`);
      process.exit(2);
    }
    if (!Number.isFinite(Number(v))) {
      console.error(`--grip ${k} needs a number, got ${v}`);
      process.exit(2);
    }
    grip[k] = Number(v);
  }
}

/* ── seeded RNG ──────────────────────────────────────────────────── */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const realRandom = Math.random;

function permutations(xs) {
  if (xs.length <= 1) return [xs];
  const out = [];
  for (let i = 0; i < xs.length; i++) {
    const rest = xs.slice(0, i).concat(xs.slice(i + 1));
    for (const p of permutations(rest)) out.push([xs[i], ...p]);
  }
  return out;
}

/**
 * One race. Returns per-bot {classId, rank(1..3), meanSpeed, bestLap, alive}.
 * Rank is over the three bots only, by finish order then by distance covered.
 */
function race({ trackId, botClasses, playerClass, pace, seed }) {
  Math.random = mulberry32(seed);
  const profile = { ...ai.DEFAULT_PROFILE, pace, mistake: 0.35, precision: 0.8 };
  ai.resetAiDirective();
  ai.setAiDirective({
    // --clean holds the field's fire, which separates "this class drives
    // faster" from "this class shoots the others off the road". Both matter,
    // but conflating them makes every balance change untraceable.
    weaponsFree: !argv.includes("--clean"),
    fieldPace: 0,
    profiles: Object.fromEntries(botClasses.map((_, i) => [`bot-${i}`, profile])),
  });
  classes.setFieldRoster(
    botClasses.map((c, i) => ({ name: `B${i}`, classId: c })),
  );

  const g = new simMod.GameSimulation("TESTER", playerClass, trackId);
  g.state.lapCount = LAPS;
  g.setPhase("countdown");
  // setPhase rebuilt the field; lapCount survives, but re-assert it because a
  // future startCountdown that resets it would silently change the race length.
  g.state.lapCount = LAPS;

  const maxSteps = 60 * WINDOW;
  let steps = 0;
  const speedSum = new Map();
  const speedN = new Map();
  while (steps < maxSteps && g.state.phase !== "finished") {

    const player = g.state.vehicles.find((v) => v.isPlayer);
    const pin =
      player && g.state.phase === "racing"
        ? ai.aiInput(player, g.state.vehicles, g.state.time, g.state.lapCount)
        : null;
    g.tick(1 / 60, pin);
    if (g.state.phase === "racing") {
      for (const v of g.state.vehicles) {
        speedSum.set(v.id, (speedSum.get(v.id) ?? 0) + v.speed);
        speedN.set(v.id, (speedN.get(v.id) ?? 0) + 1);
      }
    }
    steps += 1;
  }

  const bots = g.state.vehicles.filter((v) => !v.isPlayer);
  const scored = bots.map((v) => ({
    classId: v.classId,
    key: -v.raceProgress,
    laps: v.raceProgress,
    meanSpeed: (speedSum.get(v.id) ?? 0) / Math.max(1, speedN.get(v.id) ?? 1),
    bestLap: v.lapTimes.length ? Math.min(...v.lapTimes) : Infinity,
    hp: v.health / v.maxHealth,
    finished: v.lapTimes.length > 0,
  }));
  scored.sort((a, b) => a.key - b.key);
  scored.forEach((r, i) => {
    r.rank = i + 1;
  });
  ai.resetAiDirective();
  classes.resetFieldRoster();
  Math.random = realRandom;
  return { scored, raceTime: g.state.raceTime };
}

/* ── run the matrix ──────────────────────────────────────────────── */
const stats = new Map();
for (const c of CLASS_IDS) {
  stats.set(c, {
    n: 0, wins: 0, rankSum: 0, speedSum: 0, lapSum: 0, lapN: 0,
    hpSum: 0, distSum: 0,
  });
}
const perPace = new Map();
/** Per-circuit, because "wins somewhere the others do not" is the whole claim. */
const perTrack = new Map();
function bucket(map, key) {
  let b = map.get(key);
  if (!b) {
    b = { n: 0, wins: 0, rankSum: 0, distSum: 0 };
    map.set(key, b);
  }
  return b;
}

const perms = permutations(CLASS_IDS);
/*
 * The seed base is a flag because a race is CHAOTIC: a 2% change to one class's
 * grip re-rolls every collision downstream of the first corner, so two builds
 * that differ by nothing important still produce different tables. Run the same
 * build under three seed bases to see how wide that is before believing any
 * single number.
 */
let seed = argNum("--seed", 0x5c8a11) >>> 0;

/*
 * The whole matrix is enumerated BEFORE anything runs, and every race carries
 * its own seed.
 *
 * That is what makes a shard equal to a slice: the seed stream is advanced by
 * plan index rather than by execution order, so `--shard 2/6` runs exactly the
 * races the single-process run would have run at those indices, with the same
 * seeds, and the pooled table is identical to the serial one. Sharding a
 * measurement that reseeded as it went would quietly produce a different
 * experiment per job count.
 */
const plan = [];
for (const pace of PACES) {
  for (const trackId of CIRCUITS) {
    for (let rep = 0; rep < REPS; rep++) {
      for (const perm of perms) {
        const idx = plan.length;
        seed = (seed * 1664525 + 1013904223) >>> 0;
        plan.push({
          idx,
          pace,
          trackId,
          botClasses: perm,
          playerClass: CLASS_IDS[idx % CLASS_IDS.length],
          seed,
        });
      }
    }
  }
}

const SHARD = argStr("--shard", null);
const t0 = Date.now();

if (SHARD) {
  const [si, sn] = SHARD.split("/").map(Number);
  const out = [];
  for (const job of plan) {
    if (job.idx % sn !== si) continue;
    const { scored } = race(job);
    out.push({ idx: job.idx, scored: scored.map(({ key, ...r }) => r) });
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

/**
 * Race results by plan index, filled either inline or by child shards.
 *
 * Children are `node <this file> --shard i/N <same flags>` rather than worker
 * threads because every shard needs its OWN module graph: `setActiveTrack`,
 * `setAiDirective`, `setFieldRoster` and `setWeather` are all process-global
 * module state, and two workers sharing one graph would race on the circuit.
 */
const results = new Array(plan.length);
const JOBS = Math.max(1, Math.min(argNum("--jobs", 4), plan.length));
if (JOBS > 1) {
  const { execFile } = await import("node:child_process");
  const self = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const passthrough = argv.filter((a, i) => {
    if (a === "--jobs" || argv[i - 1] === "--jobs") return false;
    return true;
  });
  await Promise.all(
    Array.from({ length: JOBS }, (_, i) =>
      new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          [self, "--shard", `${i}/${JOBS}`, ...passthrough],
          // A full run is a few MB of JSON; the 1MB default would truncate it
          // into a parse error that reads like a sim crash.
          { maxBuffer: 256 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (err) return reject(new Error(`shard ${i}: ${err.message}\n${stderr}`));
            for (const r of JSON.parse(stdout)) results[r.idx] = r.scored;
            resolve();
          },
        );
      }),
    ),
  );
} else {
  for (const job of plan) {
    const { scored } = race(job);
    results[job.idx] = scored;
  }
}

let races = 0;
for (const pace of PACES) for (const c of CLASS_IDS) bucket(perPace, `${pace}|${c}`);
{
  for (const job of plan) {
    const { pace, trackId } = job;
    for (const r of results[job.idx]) {
      const s = stats.get(r.classId);
      s.n += 1;
      s.rankSum += r.rank;
      if (r.rank === 1) s.wins += 1;
      s.speedSum += r.meanSpeed;
      s.hpSum += r.hp;
      s.distSum += r.laps;
      // JSON has no Infinity, so a shard reports "never set a lap" as null.
      if (Number.isFinite(r.bestLap)) {
        s.lapSum += r.bestLap;
        s.lapN += 1;
      }
      for (const b of [
        perPace.get(`${pace}|${r.classId}`),
        bucket(perTrack, `${trackId}|${r.classId}`),
      ]) {
        b.n += 1;
        b.rankSum += r.rank;
        b.distSum += r.laps;
        if (r.rank === 1) b.wins += 1;
      }
    }
    races += 1;
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(
  `${races} races · ${CIRCUITS.join("/")} · ${WINDOW}s window · pace ${PACES.join("/")} · ` +
    `${weather.getWeatherId()}${GRIP_OVERRIDE ? ` [${GRIP_OVERRIDE}]` : ""}${argv.includes("--clean") ? " · weapons cold" : ""} · ${secs}s\n`,
);
console.log("class        n   win%   mean-pos   laps   mean-speed   best-lap   end-hp%");
for (const c of CLASS_IDS) {
  const s = stats.get(c);
  console.log(
    [
      c.padEnd(12),
      String(s.n).padStart(4),
      ((100 * s.wins) / s.n).toFixed(1).padStart(6),
      (s.rankSum / s.n).toFixed(3).padStart(10),
      (s.distSum / s.n).toFixed(3).padStart(6),
      (s.speedSum / s.n).toFixed(2).padStart(12),
      (s.lapN ? (s.lapSum / s.lapN).toFixed(2) : "—").padStart(10),
      ((100 * s.hpSum) / s.n).toFixed(0).padStart(9),
    ].join(" "),
  );
}

if (PACES.length > 1) {
  console.log("\nby field pace (win% / mean-pos)");
  for (const pace of PACES) {
    const row = CLASS_IDS.map((c) => {
      const p = perPace.get(`${pace}|${c}`);
      return `${c.slice(0, 4)} ${((100 * p.wins) / p.n).toFixed(0)}%/${(p.rankSum / p.n).toFixed(2)}`;
    });
    console.log(`  pace ${pace.toFixed(2)}  ${row.join("   ")}`);
  }
}

if (CIRCUITS.length > 1) {
  console.log("\nby circuit (win% / mean-pos)");
  for (const t of CIRCUITS) {
    const row = CLASS_IDS.map((c) => {
      const b = perTrack.get(`${t}|${c}`);
      return `${c.slice(0, 4)} ${((100 * b.wins) / b.n).toFixed(0)}%/${(b.rankSum / b.n).toFixed(2)}`;
    });
    console.log(`  ${t.padEnd(12)} ${row.join("   ")}`);
  }
}

/* A perfectly balanced three-way is 33.3% / 2.000. Report the spread so a
 * regression is one number to read rather than three to compare. */
const wr = CLASS_IDS.map((c) => (100 * stats.get(c).wins) / stats.get(c).n);
const pos = CLASS_IDS.map((c) => stats.get(c).rankSum / stats.get(c).n);
const spread = Math.max(...wr) - Math.min(...wr);

/*
 * The null band, simulated at THIS sample size, printed next to the result.
 *
 * Without it the spread is unreadable. It is a max-minus-min, so it is strictly
 * positive and its floor is set by the sample, not by the game: at 72 races a
 * flawless three-way still reports a median of 11.1 points. Quoting a spread
 * without the band it came from is how "11.1, a regression from 4.2" gets
 * written down about two draws from the same distribution.
 *
 * 20k trials, and it runs in ~50ms against a matrix that takes minutes.
 */
function nullBand(n, trials = 20000) {
  const rng = mulberry32(0x9e3779b9);
  const out = new Float64Array(trials);
  for (let t = 0; t < trials; t++) {
    const c = [0, 0, 0];
    for (let i = 0; i < n; i++) c[(rng() * 3) | 0] += 1;
    out[t] = (100 * (Math.max(...c) - Math.min(...c))) / n;
  }
  out.sort();
  return { p50: out[trials >> 1], p95: out[Math.floor(trials * 0.95)] };
}
const band = nullBand(races);
console.log(
  `\nwin-rate spread ${spread.toFixed(1)} pts · ` +
    `mean-position spread ${(Math.max(...pos) - Math.min(...pos)).toFixed(3)}`,
);
console.log(
  `perfectly balanced at ${races} races would read ${band.p50.toFixed(1)} pts (median), ` +
    `${band.p95.toFixed(1)} at p95 — ${
      spread <= band.p95
        ? "this result is indistinguishable from balanced"
        : "this result is OUTSIDE the null band: a real class advantage"
    }`,
);
void track;
