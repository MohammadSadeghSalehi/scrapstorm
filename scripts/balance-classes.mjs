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
 *   node scripts/balance-classes.mjs [--window 150] [--reps 2] [--quick]
 */
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const ai = await jiti.import("../src/game/ai.ts");
const classes = await jiti.import("../src/game/classes.ts");
const track = await jiti.import("../src/game/track.ts");
const simMod = await jiti.import("../src/game/sim.ts");

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
const REPS = argNum("--reps", QUICK ? 1 : 2);
const CIRCUITS = QUICK ? ["ash_spire"] : ["ash_spire", "rustline", "cinder_bowl"];
/** Two ends of the aiSkill ladder — balance has to hold across both. */
const PACES = QUICK ? [0.55] : [0.2, 0.9];

const CLASS_IDS = ["interceptor", "bruiser", "trickster"];

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
 * single number. Measured here, 108 races is worth about +/-8 win-rate points;
 * 324 races (three seeds) is worth about +/-4.
 */
let seed = argNum("--seed", 0x5c8a11) >>> 0;
let races = 0;
const t0 = Date.now();

for (const pace of PACES) {
  for (const c of CLASS_IDS) bucket(perPace, `${pace}|${c}`);
  for (const trackId of CIRCUITS) {
    for (let rep = 0; rep < REPS; rep++) {
      for (const perm of perms) {
        const playerClass = CLASS_IDS[races % CLASS_IDS.length];
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const { scored } = race({ trackId, botClasses: perm, playerClass, pace, seed });
        for (const r of scored) {
          const s = stats.get(r.classId);
          s.n += 1;
          s.rankSum += r.rank;
          if (r.rank === 1) s.wins += 1;
          s.speedSum += r.meanSpeed;
          s.hpSum += r.hp;
          s.distSum += r.laps;
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
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(
  `${races} races · ${CIRCUITS.join("/")} · ${WINDOW}s window · pace ${PACES.join("/")} · ${secs}s\n`,
);
console.log("class        n   win%   mean-pos   laps   mean-speed   best-lap   end-hp%");
for (const c of CLASS_IDS) {
  const s = stats.get(c);
  console.log(
    [
      c.padEnd(12),
      String(s.n).padStart(3),
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
console.log(
  `\nwin-rate spread ${(Math.max(...wr) - Math.min(...wr)).toFixed(1)} pts · ` +
    `mean-position spread ${(Math.max(...pos) - Math.min(...pos)).toFixed(3)}`,
);
void track;
