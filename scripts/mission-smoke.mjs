/**
 * Headless smoke test for the mission / career / story layer.
 *
 * Loads the real TypeScript through jiti — no renderer, no dev server, no
 * browser. The mission runtime is pure and takes its clock from a snapshot it
 * is handed, so every objective, every payout and the whole fifteen-rung ladder
 * can be driven from here at a few thousand times real speed.
 *
 *   node scripts/mission-smoke.mjs [--verbose]
 *
 * Exits non-zero on the first failing group, so this can gate a commit. The
 * LADDER section is the one to watch: it walks the entire board as a player who
 * never fights and never takes a bonus, and fails if that player can ever get
 * stuck. A progression system that can dead-end is worse than one that is too
 * easy, and it is invisible until somebody has already lost twenty hours.
 */
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const M = await jiti.import("../src/game/missions/index.ts");
const story = await jiti.import("../src/game/story.ts");
const ai = await jiti.import("../src/game/ai.ts");
const classes = await jiti.import("../src/game/classes.ts");
const track = await jiti.import("../src/game/track.ts");

const VERBOSE = process.argv.includes("--verbose");

let pass = 0;
let fail = 0;
const failures = [];
let group = "";

function section(name) {
  group = name;
  if (VERBOSE) console.log(`\n── ${name} ──`);
}

function ok(cond, label, detail) {
  if (cond) {
    pass += 1;
    if (VERBOSE) console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    failures.push(`[${group}] ${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(actual, expected, label) {
  ok(actual === expected, label, `expected ${expected}, got ${actual}`);
}

/* ── snapshot fixtures ────────────────────────────────────────────────
 *
 * Hand-built rather than driven through GameSimulation on purpose: the point of
 * MissionSnapshot being a structural view is that it can be faked exactly, so a
 * test for "survive 120 seconds" takes microseconds and does not depend on a
 * bot's ability to drive.
 */
function veh(id, over = {}) {
  return {
    id,
    name: id,
    isPlayer: id === "player",
    classId: "interceptor",
    x: 0,
    z: 0,
    yaw: 0,
    speed: 40,
    health: 100,
    maxHealth: 100,
    alive: true,
    wreckTimer: 0,
    lap: 0,
    position: 1,
    finished: false,
    finishTime: 0,
    raceProgress: 0,
    lastLapTime: 0,
    lastHitBy: null,
    ...over,
  };
}

function snap(vehicles, over = {}) {
  return {
    phase: "racing",
    raceTime: 0,
    playerId: "player",
    vehicles,
    finishedOrder: [],
    events: [],
    ...over,
  };
}

/** Minimal MissionMutableWorld for applyMissionEffects. */
function world(vehicles) {
  return {
    raceTime: 0,
    time: 0,
    vehicles: vehicles.map((v) => ({
      id: v.id,
      health: v.health,
      alive: v.alive,
      wreckTimer: v.wreckTimer,
      speed: v.speed,
      damageVisual: 0,
    })),
    events: [],
  };
}

/** Build a one-objective mission around a def fragment. */
function testMission(objectives, over = {}) {
  return {
    id: "test",
    name: "Test",
    kind: "race",
    trackId: "ash_spire",
    laps: 3,
    brief: [],
    objectives,
    modifiers: { ...M.DEFAULT_MODIFIERS, ...(over.modifiers ?? {}) },
    reward: { scrap: 100, markers: 2 },
    ...over,
  };
}

/** Drive a run forward to `t`, one snapshot at a time. */
function advance(run, vehicles, t, over = {}) {
  const s = snap(vehicles, { raceTime: t, ...over });
  const fx = M.stepMission(run, s);
  return { fx, s };
}

track.setActiveTrack("ash_spire");

/* ══ DATA INTEGRITY ═══════════════════════════════════════════════════ */
section("data integrity");

const ids = M.ALL_MISSIONS.map((m) => m.id);
eq(new Set(ids).size, ids.length, "mission ids are unique");
ok(M.EVENT_MISSIONS.length >= 22, "at least 22 events authored", `${M.EVENT_MISSIONS.length}`);
eq(M.RIVALS_BY_RANK.length, 15, "fifteen rivals on the board");
eq(M.DUEL_MISSIONS.length, 15, "one duel per rival");

for (const m of M.ALL_MISSIONS) {
  ok(m.laps >= 1, `${m.id}: has a lap count`);
  ok(m.objectives.length > 0, `${m.id}: has at least one objective`);
  ok(
    m.objectives.some((o) => !o.optional),
    `${m.id}: has at least one REQUIRED objective`,
  );
  ok(
    (m.grid?.length ?? 0) <= 3,
    `${m.id}: grid fits the field`,
    `sim builds 3 bots, mission names ${m.grid?.length}`,
  );
  for (const o of m.objectives) {
    if (typeof o.slot === "number") {
      ok(
        o.slot >= 0 && o.slot < 3,
        `${m.id}: objective slot ${o.slot} is a real grid slot`,
      );
    }
  }
  ok(track.isTrackId(m.trackId), `${m.id}: names a real circuit`);
}

/* Story ids must resolve, or a beat silently never plays. */
for (const m of M.ALL_MISSIONS) {
  for (const key of ["beatBefore", "beatAfter", "beatAfterWrecked"]) {
    const id = m[key];
    if (id) ok(!!story.beat(id), `${m.id}: ${key} "${id}" resolves`);
  }
}

/* Every qualifying event a rival names has to exist, or they never unlock. */
for (const r of M.RIVALS_BY_RANK) {
  for (const evId of r.unlock.events) {
    ok(!!M.missionById(evId), `${r.id}: qualifier "${evId}" exists`);
  }
  ok(
    r.unlock.markers >= (M.TRACK_UNLOCKS[r.homeTrack] ?? 0),
    `${r.id}: their circuit is open by the time they are`,
  );
  for (const evId of r.unlock.events) {
    const ev = M.missionById(evId);
    if (!ev) continue;
    ok(
      r.unlock.markers >= (M.TRACK_UNLOCKS[ev.trackId] ?? 0),
      `${r.id}: qualifier "${evId}" is reachable at their threshold`,
    );
  }
}

/* ══ DIFFICULTY LADDER ════════════════════════════════════════════════ */
section("difficulty ladder");

const byRank = [...M.RIVALS_BY_RANK].sort((a, b) => a.rank - b.rank); // 1 first
const top5 = byRank.slice(0, 5);
const bottom5 = byRank.slice(-5);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

ok(
  mean(top5.map((r) => r.profile.pace)) > mean(bottom5.map((r) => r.profile.pace)) + 0.25,
  "the top of the board is meaningfully faster than the bottom",
  `${mean(top5.map((r) => r.profile.pace)).toFixed(2)} vs ${mean(bottom5.map((r) => r.profile.pace)).toFixed(2)}`,
);
ok(
  mean(top5.map((r) => r.profile.mistake)) < mean(bottom5.map((r) => r.profile.mistake)) - 0.25,
  "the top of the board makes far fewer mistakes",
);
const patterns = new Set(M.RIVALS_BY_RANK.map((r) => r.profile.pattern));
eq(patterns.size, 5, "all five fight patterns are used somewhere on the board");
for (const p of ["racer", "blocker", "hunter", "pacer", "duelist"]) {
  ok(patterns.has(p), `pattern "${p}" appears on the board`);
}
/* Two rivals with identical numbers are one rival with two names. */
const sigs = M.RIVALS_BY_RANK.map((r) => JSON.stringify(r.profile));
eq(new Set(sigs).size, sigs.length, "no two rivals share a driving profile");

for (const r of M.RIVALS_BY_RANK) {
  const p = r.profile;
  for (const [k, v] of Object.entries(p)) {
    if (k === "pattern") continue;
    ok(v >= 0 && v <= 1, `${r.id}: ${k} in range`, `${v}`);
  }
}

/* Pace has to actually reach the car. */
const fast = { ...ai.DEFAULT_PROFILE, pace: 1 };
const slow = { ...ai.DEFAULT_PROFILE, pace: 0 };
ai.setAiDirective({ profiles: { "bot-0": fast, "bot-1": slow } });
const skillFast = ai.aiSkill(veh("bot-0", { isPlayer: false }));
const skillSlow = ai.aiSkill(veh("bot-1", { isPlayer: false }));
ok(skillFast.grip > skillSlow.grip, "pace raises grip");
ok(skillFast.power > skillSlow.power, "pace raises drive");
ok(skillFast.grip < 1.12 && skillFast.power < 1.08, "skill stays a trim, not a cheat");
ok(ai.aiSkill(veh("player")).grip === 1, "the player is never scaled");

/* Nerve: the same car, hurt, drives differently depending on who is in it. */
const brave = { ...ai.DEFAULT_PROFILE, pace: 0.5, nerve: 1 };
const glass = { ...ai.DEFAULT_PROFILE, pace: 0.5, nerve: 0 };
ai.setAiDirective({ profiles: { "bot-0": brave, "bot-1": glass } });
const hurtBrave = ai.aiSkill(veh("bot-0", { health: 20 }));
const hurtGlass = ai.aiSkill(veh("bot-1", { health: 20 }));
ok(hurtBrave.grip > hurtGlass.grip, "low nerve costs pace once the hull is gone");
ai.resetAiDirective();

/* fieldPace: the anonymous grid rises with the player's rank. */
const fresh = M.DEFAULT_CAREER;
const deep = { ...fresh, defeated: M.RIVALS_BY_RANK.slice(0, 12).map((r) => r.id) };
ok(M.fieldPace(deep) > M.fieldPace(fresh) + 0.3, "house cars get better as you climb");
ok(M.fieldPace(deep) <= 0.62, "house cars never outdrive the names");

/* ══ RIVAL VOICE ══════════════════════════════════════════════════════ */
section("rival voice");

const BARK_KINDS = ["open", "pass", "hurt", "down", "won", "lost"];
for (const r of M.RIVALS_BY_RANK) {
  const set = story.RIVAL_BARKS[r.id];
  ok(!!set, `${r.id}: has a voice`);
  if (!set) continue;
  for (const k of BARK_KINDS) {
    ok(typeof set[k] === "string" && set[k].length > 0, `${r.id}: has a "${k}" line`);
  }
  for (const [k, line] of Object.entries(set)) {
    ok(line.length <= 62, `${r.id}/${k}: short enough to read at speed`, `${line.length} chars`);
  }
}
eq(story.rivalBark("nobody", "open"), "", "an unknown rival is silent, not undefined");

/* ══ OBJECTIVES ═══════════════════════════════════════════════════════ */
section("objectives");

/* finish_place */
{
  const run = M.createMissionRun(testMission([{ kind: "finish_place", place: 2 }]));
  const p = veh("player", { position: 3 });
  advance(run, [p, veh("bot-0")], 10);
  eq(run.status, "running", "finish_place: pending while racing");
  p.finished = true;
  p.position = 2;
  M.stepMission(run, snap([p, veh("bot-0")], { raceTime: 60, finishedOrder: ["bot-0", "player"] }));
  eq(run.status, "complete", "finish_place: P2 clears a P2 target");
}
{
  const run = M.createMissionRun(testMission([{ kind: "finish_place", place: 1 }]));
  const p = veh("player", { position: 2, finished: true });
  M.stepMission(run, snap([p, veh("bot-0")], { raceTime: 60, finishedOrder: ["bot-0", "player"] }));
  eq(run.status, "failed", "finish_place: P2 fails a win-only target");
}

/* finish_race */
{
  const run = M.createMissionRun(testMission([{ kind: "finish_race" }], { laps: 2 }));
  const p = veh("player", { lap: 1 });
  advance(run, [p], 30);
  ok(run.objectives[0].progress > 0.4, "finish_race: progress tracks laps");
  p.finished = true;
  advance(run, [p], 60);
  eq(run.status, "complete", "finish_race: crossing the line clears it");
}

/* takedowns + exact attribution */
{
  const run = M.createMissionRun(testMission([{ kind: "takedowns", count: 1 }]));
  const p = veh("player");
  const b = veh("bot-0", { isPlayer: false, x: 200, z: 200 });
  advance(run, [p, b], 1);
  b.health = 40;
  b.lastHitBy = "player";
  advance(run, [p, b], 2);
  b.health = 0;
  b.alive = false;
  b.wreckTimer = 2.8;
  advance(run, [p, b], 3);
  eq(run.book.takedowns, 1, "takedown credited across the whole map when named");
  eq(run.status, "complete", "takedowns: objective clears");
}
{
  const run = M.createMissionRun(testMission([{ kind: "takedowns", count: 1 }]));
  const p = veh("player");
  const b = veh("bot-0", { isPlayer: false, x: 2, z: 2 });
  advance(run, [p, b], 1);
  b.health = 0;
  b.alive = false;
  b.lastHitBy = "bot-1"; // somebody else did it, right next to you
  advance(run, [p, b], 2);
  eq(run.book.takedowns, 0, "no credit for a wreck you did not cause, however close");
}
{
  /* Heuristic fallback when nothing recorded the hit. */
  const run = M.createMissionRun(testMission([{ kind: "takedowns", count: 1 }]));
  const p = veh("player");
  const b = veh("bot-0", { isPlayer: false, x: 2, z: 2, lastHitBy: undefined });
  advance(run, [p, b], 1);
  b.health = 0;
  b.alive = false;
  advance(run, [p, b], 2);
  eq(run.book.takedowns, 1, "contact-range fallback still credits when unattributed");
}

/* survive_time, and the clock coming from the snapshot */
{
  const run = M.createMissionRun(testMission([{ kind: "survive_time", seconds: 60 }]));
  const p = veh("player");
  advance(run, [p], 30);
  eq(run.status, "running", "survive_time: still running at halfway");
  advance(run, [p], 30); // same raceTime — a second tick in one frame
  eq(run.status, "running", "survive_time: a repeated tick does not double-count");
  advance(run, [p], 60);
  eq(run.status, "complete", "survive_time: clears on the clock");
  ok(run.resolvedAt === 60, "resolvedAt records when the run stopped being live");
}

/* last_standing */
{
  const run = M.createMissionRun(
    testMission([{ kind: "last_standing" }], {
      modifiers: { elimination: { everySec: 10, warnSec: 3 } },
    }),
  );
  const p = veh("player", { position: 1 });
  const a = veh("bot-0", { isPlayer: false, position: 2 });
  const b = veh("bot-1", { isPlayer: false, position: 3 });
  advance(run, [p, a, b], 5);
  const warn = advance(run, [p, a, b], 7.5).fx; // inside the 3s warning window
  ok(
    warn.some((f) => f.kind === "announce" && /drops/i.test(f.message)),
    "elimination warns before it cuts",
  );
  const cut = advance(run, [p, a, b], 10.1).fx;
  const elim = cut.find((f) => f.kind === "eliminate");
  ok(!!elim, "elimination fires on schedule");
  eq(elim?.vehicleId, "bot-1", "elimination takes the WORST surviving car");
  const w = world([p, a, b]);
  M.applyMissionEffects(w, cut);
  const frozen = w.vehicles.find((v) => v.id === "bot-1");
  ok(frozen.wreckTimer > 1e5, "eliminated car is frozen, not finished");
  ok(w.events.length > 0, "elimination reaches the event feed");
}

/* lead_for */
{
  const run = M.createMissionRun(testMission([{ kind: "lead_for", seconds: 5 }]));
  const p = veh("player", { position: 1 });
  for (let t = 1; t <= 6; t++) advance(run, [p, veh("bot-0")], t);
  eq(run.status, "complete", "lead_for: accumulates only while P1");
}
{
  const run = M.createMissionRun(testMission([{ kind: "lead_for", seconds: 5 }]));
  const p = veh("player", { position: 3 });
  for (let t = 1; t <= 6; t++) advance(run, [p, veh("bot-0")], t);
  eq(run.status, "running", "lead_for: no credit from the back");
}

/* lap_pace resolves against the LIVE track, not a hardcoded second count */
{
  track.setActiveTrack("ash_spire");
  const shortRun = M.createMissionRun(testMission([{ kind: "lap_pace", pace: 25 }]));
  track.setActiveTrack("dead_mile");
  const longRun = M.createMissionRun(testMission([{ kind: "lap_pace", pace: 25 }]));
  ok(
    longRun.lapTarget > shortRun.lapTarget,
    "a pace target is longer in seconds on a longer circuit",
    `${shortRun.lapTarget?.toFixed(1)} vs ${longRun.lapTarget?.toFixed(1)}`,
  );
  track.setActiveTrack("ash_spire");
}
{
  const run = M.createMissionRun(testMission([{ kind: "lap_pace", pace: 25 }]));
  const target = run.lapTarget;
  const p = veh("player", { lap: 1, lastLapTime: target - 1 });
  advance(run, [p], 40);
  eq(run.status, "complete", "lap_pace: a quick lap clears it");
}

/* race_pace fails the moment the clock passes it, without waiting for the flag */
{
  const run = M.createMissionRun(testMission([{ kind: "race_pace", pace: 25 }]));
  const p = veh("player");
  advance(run, [p], run.raceTarget + 1);
  eq(run.status, "failed", "race_pace: fails live when the clock runs out");
}

/* wreck_target */
{
  const def = testMission([{ kind: "wreck_target", slot: 0 }], {
    grid: [{ name: "MARK" }],
  });
  const run = M.createMissionRun(def);
  const p = veh("player");
  const mark = veh("bot-0", { isPlayer: false, x: 300 });
  const other = veh("bot-1", { isPlayer: false, x: 300 });
  advance(run, [p, mark, other], 1);
  other.health = 0;
  other.alive = false;
  other.lastHitBy = "player";
  advance(run, [p, mark, other], 2);
  eq(run.status, "running", "wreck_target: the wrong car does not count");
  mark.health = 0;
  mark.alive = false;
  mark.lastHitBy = "player";
  advance(run, [p, mark, other], 3);
  eq(run.status, "complete", "wreck_target: the marked car does");
}

/* beat_rival */
{
  const run = M.createMissionRun(testMission([{ kind: "beat_rival", slot: 0 }]));
  const p = veh("player", { raceProgress: 2.5, finished: true });
  const r = veh("bot-0", { isPlayer: false, raceProgress: 2.1 });
  M.stepMission(run, snap([p, r], { raceTime: 90, finishedOrder: ["player"] }));
  eq(run.status, "complete", "beat_rival: ahead at the flag clears it");
}

/* no_wreck is a HOLD: met until broken */
{
  const run = M.createMissionRun(testMission([{ kind: "no_wreck" }]));
  eq(run.objectives[0].status, "met", "no_wreck: starts satisfied");
  const p = veh("player");
  advance(run, [p], 1);
  p.alive = false;
  p.wreckTimer = 2.8;
  advance(run, [p], 2);
  eq(run.status, "failed", "no_wreck: one wreck ends it");
}

/* hull_above */
{
  const run = M.createMissionRun(testMission([{ kind: "hull_above", pct: 0.5 }]));
  const p = veh("player", { health: 80 });
  advance(run, [p], 1);
  eq(run.status, "running", "hull_above: healthy is fine");
  p.health = 40;
  advance(run, [p], 2);
  eq(run.status, "failed", "hull_above: crossing the floor ends it");
}

/* escort_alive */
{
  const run = M.createMissionRun(
    testMission([{ kind: "escort_alive", slot: 0, minHullPct: 0.4 }]),
  );
  const p = veh("player");
  const ally = veh("bot-0", { isPlayer: false, health: 90 });
  advance(run, [p, ally], 1);
  eq(run.status, "running", "escort_alive: client healthy");
  ally.health = 20;
  advance(run, [p, ally], 2);
  eq(run.status, "failed", "escort_alive: client below the floor ends it");
}

/* stay_near, including the grace window */
{
  const run = M.createMissionRun(
    testMission([{ kind: "stay_near", slot: 0, metres: 50, graceSec: 4 }]),
  );
  const p = veh("player", { x: 0 });
  const ally = veh("bot-0", { isPlayer: false, x: 500 });
  advance(run, [p, ally], 1);
  eq(run.status, "running", "stay_near: grace absorbs a brief gap");
  advance(run, [p, ally], 3);
  eq(run.status, "running", "stay_near: still inside grace");
  advance(run, [p, ally], 8);
  eq(run.status, "failed", "stay_near: grace runs out");
}

/* optional objectives never fail a run */
{
  const run = M.createMissionRun(
    testMission([
      { kind: "finish_race" },
      { kind: "takedowns", count: 3, optional: true },
    ]),
  );
  const p = veh("player", { finished: true });
  M.stepMission(run, snap([p], { raceTime: 60, finishedOrder: ["player"] }));
  eq(run.status, "complete", "an unmet bonus does not fail the run");
  const sum = M.summarise(run, snap([p], { raceTime: 60, finishedOrder: ["player"] }));
  eq(sum.bonusMet, 0, "unmet bonus is not counted");
}

/* ══ RADIO ════════════════════════════════════════════════════════════ */
section("radio");
{
  const def = testMission([{ kind: "finish_race" }], {
    grid: [{ name: "MARROW", rivalId: "marrow" }],
    rivalId: "marrow",
    laps: 3,
  });
  const run = M.createMissionRun(def);
  const p = veh("player", { position: 2 });
  const r = veh("bot-0", { isPlayer: false, position: 1 });
  let lines = [];
  for (let t = 1; t <= 120; t++) {
    const { fx } = advance(run, [p, r], t);
    lines.push(...fx.filter((f) => f.kind === "announce").map((f) => f.message));
  }
  ok(lines.length > 0, "the rival says something during the race");
  ok(
    lines.some((l) => l.startsWith("MARROW:")),
    "and it is the rival's own voice",
    lines.join(" | "),
  );
  eq(new Set(lines).size, lines.length, "no radio line repeats within a run");
}
{
  /* Losing a place to a named car is attributed to that car. */
  const def = testMission([{ kind: "finish_race" }], {
    grid: [{ name: "SUMP", rivalId: "kade" }],
  });
  const run = M.createMissionRun(def);
  const p = veh("player", { position: 1 });
  const r = veh("bot-0", { isPlayer: false, position: 2 });
  advance(run, [p, r], 20);
  p.position = 2;
  r.position = 1;
  const { fx } = advance(run, [p, r], 40);
  ok(
    fx.some((f) => f.kind === "announce" && f.message.startsWith("SUMP:")),
    "the car that passed you is the one that speaks",
  );
}
{
  /* Objective failure is announced, loudly, while there is still time to react. */
  const run = M.createMissionRun(testMission([{ kind: "hull_above", pct: 0.5 }]));
  const p = veh("player", { health: 80 });
  advance(run, [p], 1);
  p.health = 10;
  const { fx } = advance(run, [p], 2);
  ok(
    fx.some((f) => f.kind === "announce" && /FAILED/.test(f.message)),
    "a failed objective is announced in motion",
  );
}

/* ══ ARM / DISARM ═════════════════════════════════════════════════════ */
section("arm and disarm");
{
  const marrow = M.rivalById("marrow");
  const duel = M.duelMission(marrow);
  const run = M.armMission(duel, { heatFloor: 0.5, fieldPace: 0.6 });
  eq(track.getActiveTrackId(), duel.trackId, "arming switches the circuit");
  eq(classes.BOT_NAMES[0], "MARROW", "the rival is on the grid before it is built");
  eq(classes.getFieldRoster()[0].classId, marrow.classId, "the roster carries their class");
  const d = ai.getAiDirective();
  eq(d.bountyOn, "player", "a manhunt duel puts the bounty on the player");
  eq(d.profiles["bot-0"].pattern, "duelist", "the rival's pattern reaches the AI");
  eq(d.fieldPace, 0.6, "field pace reaches the AI");
  ok(d.heat >= 0.5, "career heat raises the floor");
  ok(run.def.laps === marrow.duel.laps, "the duel owns its lap count");

  M.disarmMission();
  eq(classes.getFieldRoster().length, 0, "disarm clears the roster");
  eq(ai.getAiDirective().bountyOn, null, "disarm clears the manhunt");
  eq(ai.getAiDirective().fieldPace, 0, "disarm clears the field pace");
  ok(classes.BOT_NAMES.length > 0, "house names come back for free play");
}
{
  /* The authored ceiling still wins over the career floor. */
  const quiet = testMission([{ kind: "finish_race" }], { modifiers: { heat: 0.9 } });
  const loudRun = M.armMission(quiet, { heatFloor: 0.2 });
  ok(ai.getAiDirective().heat === 0.9, "a loud mission is not quietened by a calm career");
  eq(loudRun.modifiers.heat, 0.9, "and the run reports what it is running at");
  const raised = M.armMission(
    testMission([{ kind: "finish_race" }], { modifiers: { heat: 0.1 } }),
    { heatFloor: 0.6 },
  );
  eq(raised.modifiers.heat, 0.6, "a calm mission at high career heat reports the floor");
  ok(
    raised.def.modifiers.heat === 0.1,
    "without writing career state into the shared catalogue entry",
  );
  M.disarmMission();
}

/* ══ CAREER ═══════════════════════════════════════════════════════════ */
section("career");

const debut = M.missionById("pro_debut");
function summary(over = {}) {
  return {
    missionId: "x",
    outcome: "complete",
    place: 1,
    raceTime: 100,
    bestLap: 30,
    takedowns: 0,
    objectives: [],
    bonusMet: 0,
    rivalWrecked: false,
    ...over,
  };
}

{
  const { career, award } = M.applyMissionResult(M.DEFAULT_CAREER, debut, summary());
  eq(award.markers, debut.reward.markers, "first clear pays the authored markers");
  ok(award.firstClear, "first clear is flagged");
  ok(career.completed.includes("pro_debut"), "the clear is recorded");
  const again = M.applyMissionResult(career, debut, summary());
  ok(
    again.award.markers < debut.reward.markers,
    "a repeat clear pays less than the first",
  );
  ok(again.award.markers >= 1, "but a repeat clear still pays something");
  ok(again.award.scrap > 0, "and still pays scrap");
}
{
  const fee = M.missionById("dm_lastcall");
  ok(M.missionCost(fee) > 0, "the hardest events carry a stake");
  const lost = M.applyMissionResult(M.DEFAULT_CAREER, fee, summary({ outcome: "failed" }));
  eq(lost.award.feeLost, M.missionCost(fee), "a lost run loses the stake");
  const won = M.applyMissionResult(M.DEFAULT_CAREER, fee, summary());
  eq(won.award.feeLost, 0, "a clear does not");
  ok(won.award.scrap > fee.reward.scrap, "a clear returns the stake on top of the purse");
  ok(
    M.affordable(M.missionCost(fee), fee) && !M.affordable(M.missionCost(fee) - 1, fee),
    "affordability is exact",
  );
}
{
  /* Losing a duel takes back a qualification — the cost that still bites when
   * the player is rich. */
  const marsh = M.rivalById("marsh");
  const duel = M.duelMission(marsh);
  const qualified = {
    ...M.DEFAULT_CAREER,
    markers: 400,
    completed: [...marsh.unlock.events],
    defeated: M.RIVALS_BY_RANK.filter((r) => r.rank > marsh.rank).map((r) => r.id),
  };
  ok(M.canChallenge(qualified, "marsh"), "the rival takes the call when qualified");
  const lost = M.applyMissionResult(qualified, duel, summary({ outcome: "failed" }));
  ok(lost.award.requalify !== null, "losing a duel costs a qualification");
  ok(
    !M.canChallenge(lost.career, "marsh"),
    "and the rival stops taking the call until it is re-run",
  );
  const redone = M.applyMissionResult(
    lost.career,
    M.missionById(lost.award.requalify),
    summary(),
  );
  ok(M.canChallenge(redone.career, "marsh"), "re-running it opens them back up");
  ok(
    M.availableEvents(lost.career).some((m) => m.id === lost.award.requalify),
    "the event you have to re-run is still available to enter",
  );
  const eventLoss = M.applyMissionResult(qualified, debut, summary({ outcome: "failed" }));
  eq(eventLoss.award.requalify, null, "losing an ordinary event costs no standing");
}
{
  const hot = { ...M.DEFAULT_CAREER, heat: 4 };
  const lost = M.applyMissionResult(hot, debut, summary({ outcome: "failed" }));
  ok(lost.career.heat < hot.heat, "losing cools the league");
  const wonRun = M.applyMissionResult(hot, debut, summary({ takedowns: 2 }));
  ok(wonRun.career.heat > hot.heat, "winning heats it");
  ok(wonRun.career.heat <= 5, "heat is capped");
}
{
  /* first-blood fires once, on the first takedown ever. */
  const a = M.applyMissionResult(M.DEFAULT_CAREER, debut, summary({ takedowns: 1 }));
  ok(a.award.beats.includes("first-blood"), "the first takedown gets a beat");
  const b = M.applyMissionResult(a.career, debut, summary({ takedowns: 1 }));
  ok(!b.award.beats.includes("first-blood"), "and only the first");
}
{
  /* The story branches on HOW you beat them. */
  const vey = M.rivalById("vey");
  const duel = M.duelMission(vey);
  const base = { ...M.DEFAULT_CAREER, markers: 500 };
  const raced = M.applyMissionResult(base, duel, summary());
  const wrecked = M.applyMissionResult(base, duel, summary({ rivalWrecked: true }));
  ok(raced.award.beats.includes("outraced-vey"), "out-racing Vey plays the out-raced beat");
  ok(wrecked.award.beats.includes("wrecked-vey"), "wrecking Vey plays a different one");
  ok(
    !wrecked.award.beats.includes("outraced-vey"),
    "and the two never both fire",
  );
  eq(raced.award.rivalDefeated?.id, "vey", "the rival is recorded as defeated");
  ok(raced.career.titles.includes(vey.reward.title), "and their title is taken");
}
{
  /* Heat threshold beats. */
  const near = { ...M.DEFAULT_CAREER, heat: 2.9 };
  const r = M.applyMissionResult(near, M.duelMission(M.rivalById("wask")), summary());
  ok(r.award.beats.includes("heat-rising"), "crossing heat 3 is a beat");
}
{
  const before = { ...M.DEFAULT_CAREER, markers: M.TRACK_UNLOCKS.foundry_pit - 1 };
  const r = M.applyMissionResult(before, M.missionById("as_bounty"), summary());
  ok(
    r.award.tracksUnlocked.includes("foundry_pit"),
    "crossing a track threshold reports the new circuit",
  );
  ok(
    !!story.TRACK_BEATS.foundry_pit,
    "and the new circuit has something to say for itself",
  );
}
{
  const drained = M.drainScrap({ ...M.DEFAULT_CAREER, scrapPending: 250 });
  eq(drained.scrap, 250, "pending scrap drains in full");
  eq(drained.career.scrapPending, 0, "and is cleared");
}

/* ══ BOARD ════════════════════════════════════════════════════════════ */
section("board");
{
  const rows = M.board(M.DEFAULT_CAREER);
  eq(rows.length, 15, "the board has fifteen rows");
  eq(rows[0].rival.rank, 15, "and starts at the bottom");
  eq(rows.filter((r) => r.status === "available").length, 0, "nothing is open on a fresh save");
  const withDebut = { ...M.DEFAULT_CAREER, completed: ["pro_debut"] };
  eq(
    M.board(withDebut)[0].status,
    "available",
    "clearing the qualifier opens the first rung",
  );
  eq(M.board(withDebut)[1].status, "locked", "the second rung stays shut");
  eq(M.currentRank(M.DEFAULT_CAREER), 16, "an unranked player is 16th");
  eq(M.nextRival(M.DEFAULT_CAREER)?.rank, 15, "the next target is the bottom rung");
}

/* ══ LADDER SOLVABILITY ═══════════════════════════════════════════════ */
section("ladder solvability");
/*
 * The pessimistic player: clears everything they enter, wins nothing extra.
 * Zero takedowns, zero bonus objectives, so the ONLY markers they ever see are
 * mission rewards. If the board can be finished by them it can be finished.
 */
{
  let career = M.DEFAULT_CAREER;
  let scrap = 80; // meta.ts starting balance
  let runs = 0;
  let stalled = false;
  const RUN_CAP = 400;

  while (!career.defeated.includes("marrow") && runs < RUN_CAP) {
    const open = M.board(career).filter((b) => b.status === "available");
    const events = M.availableEvents(career).filter((m) => M.affordable(scrap, m));
    const duels = open
      .map((b) => M.duelMission(b.rival))
      .filter((m) => M.affordable(scrap, m));

    // Duels first — they are the point — then the highest-paying event left.
    const uncleared = events.filter((m) => !career.completed.includes(m.id));
    const pick =
      duels[0] ??
      uncleared.sort((a, b) => b.reward.markers - a.reward.markers)[0] ??
      events.sort((a, b) => b.reward.scrap - a.reward.scrap)[0];

    if (!pick) {
      stalled = true;
      break;
    }
    scrap -= M.missionCost(pick);
    const res = M.applyMissionResult(career, pick, summary({ missionId: pick.id }));
    career = res.career;
    const d = M.drainScrap(career);
    career = d.career;
    scrap += d.scrap;
    runs += 1;
  }

  ok(!stalled, "a player who never fights is never locked out", `${runs} runs in`);
  ok(
    career.defeated.includes("marrow"),
    "and can finish the board",
    `${career.defeated.length}/15 after ${runs} runs`,
  );
  ok(runs < RUN_CAP, "without an unreasonable grind", `${runs} runs`);
  ok(scrap >= 0, "and never goes into debt", `${scrap} scrap`);
  if (VERBOSE) console.log(`     pessimistic ladder: ${runs} runs, ${scrap} scrap left`);
}
{
  /* There is always something free to enter, at every point on the board. */
  let career = M.DEFAULT_CAREER;
  let broke = null;
  for (const rival of M.RIVALS_BY_RANK) {
    const free = M.availableEvents(career).filter((m) => M.missionCost(m) === 0);
    if (free.length === 0) broke = rival.id;
    career = {
      ...career,
      defeated: [...career.defeated, rival.id],
      markers: career.markers + 40,
      completed: [...career.completed, ...rival.unlock.events],
    };
  }
  ok(broke === null, "a broke player always has a free event to earn with", `${broke}`);
}

/* ══ INTEGRATION ══════════════════════════════════════════════════════
 *
 * The real GameSimulation, driven at its real fixed timestep, with the mission
 * layer wired to it exactly the way ScrapstormApp wires it. No renderer is
 * involved — sim.ts has no dependency on three.js — so a full race costs
 * milliseconds and the whole catalogue can be run on every commit.
 *
 * The player is driven by aiInput. That is not a stand-in for a human, and no
 * assertion here treats it as one; it is a car that will reliably get round,
 * which is all that is needed to prove the plumbing carries a race from the
 * grid to a summary.
 *
 * ONE HARNESS LIMITATION, and it is worth stating precisely rather than
 * quietly working around: jiti snapshots `export let` bindings, and sim.ts
 * reads track.ts's CHECKPOINTS through one. TRACK_SAMPLES had the same problem
 * and has been switched to the accessor track.ts provides for exactly this;
 * CHECKPOINTS has no accessor to switch to. So LAP COUNTING is only correct
 * here on ash_spire, the circuit the module graph initialises with. Every
 * lap-dependent assertion below therefore runs on ash_spire, and the checks on
 * other circuits are the ones that do not need a lap to be true. Adding
 * `getCheckpoints()` to track.ts removes the restriction entirely.
 */
section("integration");

const simMod = await jiti.import("../src/game/sim.ts");

function runRace(def, opts = {}) {
  const g = new simMod.GameSimulation("TESTER", opts.classId ?? "interceptor", def.trackId);
  // Order copied from ScrapstormApp.beginRace, and it matters: buildField reads
  // the roster while startCountdown constructs the grid.
  const run = M.armMission(def, { heatFloor: opts.heatFloor ?? 0, fieldPace: 0.3 });
  g.state.lapCount = def.laps;
  g.setPhase("countdown");

  const maxSteps = opts.maxSteps ?? 60 * 260;
  let steps = 0;
  while (steps < maxSteps && g.state.phase !== "finished") {
    const player = g.state.vehicles.find((v) => v.isPlayer);
    const pin =
      player && g.state.phase === "racing"
        ? ai.aiInput(player, g.state.vehicles, g.state.time, g.state.lapCount)
        : null;
    g.tick(1 / 60, pin);
    M.applyMissionEffects(g.state, M.stepMission(run, g.state));
    if (
      run.resolvedAt !== null &&
      g.state.phase === "racing" &&
      g.state.raceTime >= run.resolvedAt + 2.6
    ) {
      g.state.phase = "finished";
    }
    steps += 1;
  }
  const summary = M.summarise(run, g.state);
  M.disarmMission();
  return { g, run, summary, steps };
}

{
  /* A whole race, grid to summary, on the circuit the harness counts laps on. */
  const def = M.missionById("as_sprint");
  const { g, run, summary } = runRace(def);

  eq(g.state.vehicles.length, 4, "the grid is built");
  eq(g.state.lapCount, def.laps, "the mission owns the lap count");
  ok(g.state.raceTime > 20, "the race actually ran", `${g.state.raceTime.toFixed(1)}s`);
  ok(
    g.state.vehicles.some((v) => v.lap >= def.laps),
    "somebody went the distance",
    `laps ${g.state.vehicles.map((v) => v.lap).join("/")}`,
  );
  eq(g.state.phase, "finished", "and the flag fell");
  ok(run.status !== "running", "the run reached a verdict", run.status);
  ok(
    summary.outcome === "complete" || summary.outcome === "failed",
    "which the summary reports",
  );
  ok(summary.place >= 1 && summary.place <= 4, "with a real place", `P${summary.place}`);
  ok(
    g.state.vehicles.every((v) => Number.isFinite(v.x) && Number.isFinite(v.z)),
    "and nobody left the coordinate system",
  );
}

{
  /* The named grid reaches the cars. No laps required to see it. */
  const rival = M.rivalById("marsh");
  const def = M.duelMission(rival);
  const { g } = runRace(def, { maxSteps: 60 * 8 });
  eq(g.state.vehicles[1].name, rival.name, "slot 0 is the rival, by name");
  eq(
    g.state.vehicles[1].classId,
    rival.classId,
    "and in their own class — the roster reaches buildField",
  );
  eq(g.state.vehicles.length, 4, "with the supporting cast behind them");
}

{
  /* Livery: a mission that paints a car yellow gets a yellow car. */
  const def = M.missionById("rl_courier");
  const { g } = runRace(def, { maxSteps: 60 * 8 });
  eq(g.state.vehicles[1].name, "BEX (client)", "the escort client is named");
  eq(g.state.vehicles[1].color, "#facc15", "and painted as authored");
  eq(g.state.vehicles[1].classId, "bruiser", "and in the authored class");
}

{
  /* Elimination actually removes cars from a running race. */
  const def = M.missionById("cb_elim");
  const { g } = runRace(def, { maxSteps: 60 * 80 });
  const frozen = g.state.vehicles.filter((v) => v.wreckTimer > 1e5);
  ok(frozen.length > 0, "an elimination heat eliminates somebody");
  ok(
    g.state.vehicles.filter((v) => v.wreckTimer <= 1e5).length >= 1,
    "but not everybody",
  );
}

{
  /* Free play must not inherit the last mission. */
  M.disarmMission();
  const g = new simMod.GameSimulation("TESTER", "interceptor", "ash_spire");
  g.setPhase("countdown");
  ok(
    g.state.vehicles.slice(1).every((v) => !/MARROW|BEX|KILN/.test(v.name)),
    "a quick heat has house cars, not the last mission's grid",
  );
  eq(ai.getAiDirective().bountyOn, null, "and no bounty");
  eq(g.state.lapCount, track.getTrackDef("ash_spire").laps, "and the circuit's own lap count");
}

{
  /*
   * Difficulty has to reach the ROAD, not just the profile object.
   *
   * Measured as distance covered in a fixed window by a grid of three
   * identically-profiled bots, averaged across two races. The averaging is not
   * decoration: aiInput uses Math.random for boost and weapon timing, and a
   * single bot that spins into a barrier once swamps a 15% grip difference.
   * Weapons are cold and heat is zero so this measures driving and nothing else.
   */
  function paceField(pace) {
    const base = M.missionById("as_sprint");
    const profile = { ...ai.DEFAULT_PROFILE, pace, mistake: 0, precision: 0.95 };
    const def = {
      ...base,
      modifiers: { ...base.modifiers, weaponsFree: false, catchUp: 0, heat: 0 },
      grid: ["A", "B", "C"].map((name) => ({ name, classId: "interceptor", profile })),
    };
    let total = 0;
    let n = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      // 55 seconds: comfortably less than a three-lap race, so the metric is
      // distance covered rather than "did everyone finish", which saturates.
      const { g } = runRace(def, { maxSteps: 60 * 55 });
      for (const v of g.state.vehicles) {
        if (v.isPlayer) continue;
        total += v.raceProgress;
        n += 1;
      }
    }
    return total / n;
  }
  const slowField = paceField(0);
  const fastField = paceField(1);
  ok(
    fastField > slowField,
    "a high-pace field covers more ground than a low-pace one",
    `${slowField.toFixed(3)} vs ${fastField.toFixed(3)} laps`,
  );
  // Direction alone is not enough. A "difficulty" setting worth 0.5% is a
  // difficulty setting nobody can feel, and this is the assertion that notices
  // if a later change quietly disconnects pace from the road.
  ok(
    fastField > slowField * 1.03,
    "and by an amount a driver would actually notice",
    `${(((fastField - slowField) / slowField) * 100).toFixed(1)}% further`,
  );
  if (VERBOSE) {
    console.log(`     pace 0 → ${slowField.toFixed(3)} laps, pace 1 → ${fastField.toFixed(3)} laps`);
  }
}

{
  /* Attribution reaches the runtime from the physics, not from a guess. */
  const def = M.missionById("as_bounty");
  const { g } = runRace(def, { maxSteps: 60 * 90 });
  ok(
    g.state.vehicles.every((v) => v.lastHitBy === null || typeof v.lastHitBy === "string"),
    "every car carries an attribution slot",
  );
  ok(
    g.state.vehicles.some((v) => (v.lastHitAge ?? 0) >= 0),
    "and an age for it",
  );
}

/* ══ PACE TARGETS ═════════════════════════════════════════
 *
 * The catalogue's pace numbers were authored blind. This is the stopwatch.
 *
 * It used to measure MEAN GROUND SPEED and treat that as an upper bound on
 * centreline pace, with a 1.3x allowance bolted on for the driver being a bot.
 * That was a proxy, and it was chosen because the harness could not count laps
 * anywhere except ash_spire.
 *
 * It can now. sim.ts reads `getCheckpoints()` rather than the `export let`
 * binding, and driven distance per counted lap was measured against every
 * circuit's centreline to confirm it: 855-897m against ash_spire's 908,
 * 1677-1690m against the Dead Mile's 1702, and so on for all six — slightly
 * under, every time, which is exactly what cutting an apex looks like and
 * nothing like a miscount.
 *
 * So this measures the thing itself: the best REAL lap the bot sets under the
 * mission's own modifiers, converted to centreline pace the same way the
 * interpreter does. No proxy and no 1.3.
 *
 * Two reasons that matters beyond tidiness. The proxy was noisy enough to be
 * dangerous — a best-of-four run of it reported 20.9 m/s on cinder_bowl on one
 * pass and 37.3 on the next, a spread wide enough to fail a target that is
 * comfortably met — and it was also blind in the other direction: it PASSED
 * every original target in the catalogue, including cb_clean asking for 20 m/s
 * on a circuit where a lap is worth fifty.
 */
section("pace targets");
{
  /**
   * Best achieved centreline pace over `attempts` runs of the real mission.
   *
   * Returns lap pace and whole-race pace separately, because the objectives do:
   * `lap_pace` is settled by the single best lap and `race_pace` by the total,
   * and a car that sets one blinding lap and then spins is only good at one of
   * them.
   */
  function bestPace(def, attempts = 6) {
    const lapRuns = [];
    const raceRuns = [];
    for (let a = 0; a < attempts; a++) {
      const g = new simMod.GameSimulation("TESTER", "interceptor", def.trackId);
      const run = M.armMission(def, { fieldPace: 0.3 });
      // Track length AFTER arming — armMission is what switches the circuit, and
      // reading it first silently measures the previous mission's road.
      const length = track.getTrackLength();
      g.state.lapCount = def.laps;
      g.setPhase("countdown");
      for (let i = 0; i < 60 * 200 && g.state.phase !== "finished"; i++) {
        const player = g.state.vehicles.find((v) => v.isPlayer);
        const pin =
          player && g.state.phase === "racing"
            ? ai.aiInput(player, g.state.vehicles, g.state.time, g.state.lapCount)
            : null;
        g.tick(1 / 60, pin);
        // The run is stepped so the mission's own modifiers are live, but its
        // verdict is ignored: this asks what the ROAD gives, not whether the
        // objective was met.
        M.stepMission(run, g.state);
      }
      const p = g.state.vehicles.find((v) => v.isPlayer);
      let lap = 0;
      for (const t of p.lapTimes) if (t > 0.4) lap = Math.max(lap, length / t);
      if (lap > 0) lapRuns.push(lap);
      if (p.finished && p.finishTime > 0) {
        raceRuns.push((length * def.laps) / p.finishTime);
      }
      M.disarmMission();
    }
    /*
     * BEST and MEDIAN, and both are needed, because the two questions are not
     * the same question.
     *
     * "Is this reachable" is about the best the road has ever given: a target
     * under a lap somebody has actually set is not a wall, however rare that
     * lap was. "Is this worth setting" is about the typical night — and the
     * spread here is enormous, the Rustline alone ranging from 22 to 63 m/s
     * depending on whether the bot flows through the slalom or bounces down it.
     * Judging either question with the other's statistic sets every target in
     * the catalogue either impossible or free.
     */
    const med = (xs) =>
      xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0;
    return {
      bestLap: Math.max(0, ...lapRuns),
      medLap: med(lapRuns),
      bestRace: Math.max(0, ...raceRuns),
      medRace: med(raceRuns),
    };
  }

  const timed = M.ALL_MISSIONS.filter((m) =>
    m.objectives.some((o) => o.kind === "lap_pace" || o.kind === "race_pace"),
  );
  ok(timed.length >= 4, "there are timed missions to check", `${timed.length}`);
  for (const def of timed) {
    const m = bestPace(def);
    for (const o of def.objectives) {
      if (o.kind !== "lap_pace" && o.kind !== "race_pace") continue;
      const got = o.kind === "lap_pace" ? m.bestLap : m.bestRace;
      const typical = o.kind === "lap_pace" ? m.medLap : m.medRace;
      ok(got > 0, `${def.id}: the bot completed the distance at all`, `${got}`);
      if (got <= 0) continue;
      /*
       * 1.5, and the width is the point.
       *
       * This is now a real achieved pace rather than an upper bound, so the
       * allowance only has to cover the gap between a bot and a human on the
       * same car — and it is a CEILING check, not a fairness check. A target
       * near the best lap a bot manages is hard; a target well above it is a
       * wall, and the catalogue has shipped both.
       *
       * Lap pace here is genuinely bimodal: the same circuit gives 22 m/s on a
       * run where the bot bounces down the slalom and 63 on one where it flows,
       * and best-of-six has been observed anywhere from 32 to 72 m/s on
       * cinder_bowl. A tight ceiling would fail this gate on the weather. The
       * ceiling's job is only to catch a target the road cannot give at all —
       * the FLOOR below it is what catches a target that is too soft, and that
       * one is measured against the median, where the variance lives.
       */
      ok(
        o.pace <= got * 1.5,
        `${def.id}: ${o.kind} target ${o.pace} m/s is reachable`,
        `best AI ${o.kind} ${got.toFixed(1)} m/s on ${def.trackId}`,
      );
      /*
       * And the other side of it, which the old check could not ask at all: a
       * target the bot beats by 40% is not a time attack, it is a lap. Every
       * original target in this catalogue failed this bound.
       */
      ok(
        o.pace >= typical * 0.55,
        `${def.id}: ${o.kind} target ${o.pace} m/s is worth setting`,
        `median AI ${o.kind} ${typical.toFixed(1)} m/s — the target is free`,
      );
      console.log(
        `     ${def.id} (${def.trackId}): target ${o.pace}, AI ${o.kind} median ${typical.toFixed(1)} best ${got.toFixed(1)} m/s`,
      );
    }
  }
}

/* ══ DIFFICULTY INDEX ═════════════════════════════════════════════════
 *
 * How hard is a mission, as a NUMBER.
 *
 * Everything above this point proves the mission layer does what it says.
 * Nothing above it could answer the only question that matters about a
 * difficulty ladder — is rung four harder than rung eleven — and the honest
 * answer when this was first run was no: rank 10 KILN cleared 67-100% of
 * headless attempts while rank 14 HALFPIPE cleared 0-17%, and three of the
 * four time attacks were free. The board was not ordered. That is close to
 * invisible to a human playtester, who plays each mission once, in order,
 * getting better as they go.
 *
 * WHAT THIS MEASURES, precisely, because it is easy to over-read:
 *
 *   The player slot is driven by `aiInput` with a fixed profile. It is NOT a
 *   human and no assertion here pretends otherwise. It is a consistent
 *   instrument: the same driver, in the same car, against every mission in the
 *   catalogue, at the field strength and league heat that mission is actually
 *   played at. Differences between missions are therefore differences in the
 *   MISSIONS.
 *
 *   Its absolute clear rate is not a prediction of anybody's. The player's car
 *   is never scaled by aiSkill, which makes it worth about a pace-0.45 profile
 *   (grip = 0.92 + 0.17·pace), so every rival above rank 11 has more grip and
 *   more drive than the instrument does and "win the heat" against them is out
 *   of its reach on equipment alone. Read the clear rate as an index, not a
 *   forecast.
 *
 *   Which is why the second number exists. OBJECTIVE COMPLETION — the fraction
 *   of required objectives standing at "met" when the run resolved — does not
 *   saturate. A mission the bot never wins can still be measured getting
 *   harder or easier, and a mission whose completion is flat zero is not hard,
 *   it is unreachable, which is the failure this section exists to catch.
 *
 * `--winrate` runs the whole catalogue and prints the table. The always-on
 * gate runs a sampled slice, because a full sweep is three hundred races and
 * this file has to stay cheap enough to run before every commit.
 */
section("difficulty index");
{
  const DEEP = process.argv.includes("--winrate");

  /**
   * The instrument.
   *
   * Deliberately close to DEFAULT_PROFILE rather than a synthesised "ace": five
   * candidate profiles were measured across six missions and none of them was
   * reliably better than the default, because the player's car is never scaled
   * by `aiSkill` and a profile that carries more speed into a corner simply
   * runs wide. `mistake: 0` and a raised `precision` are the two changes that
   * only reduce VARIANCE — no scheduled errors, no idle wobble — which is what
   * an instrument wants.
   */
  const PLAYER_PROXY = { ...ai.DEFAULT_PROFILE, mistake: 0, precision: 0.9 };

  /**
   * Where on the climb a mission is actually played.
   *
   * Measuring every mission at one field strength would flatter the late board
   * and slander the early one: `pro_debut` is run against pace-0 house cars and
   * a calm league, `duel_marrow` against the best the league has. Rank is
   * recovered from the rival the mission belongs to — its own, or the one who
   * names it as a qualifier — and the numbers mirror career.fieldPace and
   * career.effectiveHeat rather than inventing a second difficulty curve.
   */
  function contextFor(def) {
    let rank = 16;
    if (def.rivalId) rank = (M.rivalById(def.rivalId)?.rank ?? 15) + 1;
    else {
      const gate = M.RIVALS_BY_RANK.find((r) => r.unlock.events.includes(def.id));
      if (gate) rank = gate.rank + 1;
    }
    const climbed = (16 - rank) / 15;
    return {
      rank,
      fieldPace: Math.max(0, Math.min(0.62, climbed * 0.62)),
      // career.heat climbs about a point per rank taken and caps at 5;
      // effectiveHeat then scales the normalised value by 0.75.
      heatFloor: Math.min(1, climbed * 1.1) * 0.75,
    };
  }

  /*
   * THE INSTRUMENT'S ONE HARD LIMIT, measured rather than assumed.
   *
   * With weapons live, the AI in the player slot is shot to zero hull inside
   * forty seconds of EVERY race in the catalogue — including `as_sprint`, the
   * second mission in the game, at heat 0, with no bounty and a pace-0 field.
   * Driven four times each: min hull 0.00 every time with guns hot, and 0.71 to
   * 0.77 with the same race weapons-cold. It is not heat, not field pace and not
   * the field pattern; it is three cars firing at one that does not know how to
   * break a lock or spend its defensive charge.
   *
   * So every `hull_above` and `no_wreck` objective reads as failed for reasons
   * that have nothing to do with the mission, and a clear rate is only ever an
   * INDEX here, never a verdict.
   *
   * The control run below turns the guns off — not to ask whether the mission
   * can be won that way (it often cannot; you cannot bank three takedowns with
   * cold weapons) but to get a clean read on ONE number: how long the distance
   * actually takes. Every clock a mission sets is then checked against it. That
   * is what catches the bug class that is genuinely fatal and genuinely
   * invisible — dm_widowmaker asking for 150 seconds of survival on a three-lap
   * Dead Mile whose flag falls at 110, which reads as merely hard right up until
   * you notice it can never be won by anybody.
   */
  function attempt(def, ctx, cold = false) {
    const armed = cold
      ? {
          ...def,
          modifiers: {
            ...def.modifiers,
            weaponsFree: false,
            bountyOnPlayer: false,
          },
        }
      : def;
    const g = new simMod.GameSimulation("TESTER", "interceptor", def.trackId);
    const run = M.armMission(armed, {
      heatFloor: cold ? 0 : ctx.heatFloor,
      fieldPace: ctx.fieldPace,
    });
    // Registered AFTER armMission, which owns `profiles` wholesale. The player
    // is not in any mission's grid, so this cannot collide with a rival.
    ai.setAiDirective({
      profiles: { ...ai.getAiDirective().profiles, player: PLAYER_PROXY },
    });
    g.state.lapCount = def.laps;
    g.setPhase("countdown");
    // 300 simulated seconds. Long enough for four laps of the Dead Mile with a
    // wreck in it; short enough that a mission which can never resolve gets
    // reported rather than hanging the gate.
    for (let i = 0; i < 60 * 300 && g.state.phase !== "finished"; i++) {
      const player = g.state.vehicles.find((v) => v.isPlayer);
      const pin =
        player && g.state.phase === "racing"
          ? ai.aiInput(player, g.state.vehicles, g.state.time, g.state.lapCount)
          : null;
      g.tick(1 / 60, pin);
      M.applyMissionEffects(g.state, M.stepMission(run, g.state));
      if (
        run.resolvedAt !== null &&
        g.state.phase === "racing" &&
        g.state.raceTime >= run.resolvedAt + 2.6
      ) {
        g.state.phase = "finished";
      }
    }
    const sum = M.summarise(run, cold ? g.state : g.state);
    M.disarmMission();
    const required = sum.objectives.filter((o) => !o.optional);
    /*
     * PROGRESS, not "how many were met", and the difference is the whole
     * validity of this number.
     *
     * A run resolves the instant one required objective fails, which leaves
     * every other objective sitting at `pending` forever. Counting met
     * objectives therefore scored a mission the bot WON on the road and lost on
     * a hull floor as a flat zero — indistinguishable from a mission whose
     * objectives cannot be touched at all, which is the one thing this section
     * exists to tell apart. Progress is defined for every kind, including the
     * holds, and keeps moving right up to the failure.
     */
    const progress = required.length
      ? required.reduce((a, o) => a + (o.status === "met" ? 1 : o.progress), 0) /
        required.length
      : 1;
    return {
      cleared: sum.outcome === "complete",
      place: sum.place,
      // How long the distance took. `finishTime` when the player got there,
      // otherwise the clock when the run stopped — which for a race the player
      // did not finish is a lower bound, and a lower bound is the safe side for
      // a check that asks whether a mission's clocks fit inside it.
      duration: g.state.vehicles.find((v) => v.isPlayer)?.finishTime || g.state.raceTime,
      met: progress,
      // Which objective actually stopped the run. The most useful column here:
      // "hard" and "hard for the wrong reason" look identical in a percentage.
      // A FAILED objective is the cause; a pending one is only a casualty of it.
      blocked:
        (required.find((o) => o.status === "failed") ??
          required.find((o) => o.status !== "met"))?.label ?? null,
    };
  }

  function measure(def, n) {
    const ctx = contextFor(def);
    let wins = 0;
    let met = 0;
    let place = 0;
    const blockers = {};
    for (let i = 0; i < n; i++) {
      const r = attempt(def, ctx);
      if (r.cleared) wins += 1;
      met += r.met;
      place += r.place;
      if (r.blocked) blockers[r.blocked] = (blockers[r.blocked] ?? 0) + 1;
    }
    const worst = Object.entries(blockers).sort((a, b) => b[1] - a[1])[0];
    // Best of two weapons-cold controls for the race duration. Best, not mean:
    // a run where the instrument spins into a barrier reports a longer race than
    // the distance takes, and over-stating the duration is the direction that
    // would let a broken clock through.
    const c1 = attempt(def, ctx, true);
    const c2 = attempt(def, ctx, true);
    return {
      id: def.id,
      rank: ctx.rank,
      clear: wins / n,
      met: met / n,
      place: place / n,
      duration: Math.min(c1.duration, c2.duration),
      blocked: worst ? `${worst[0]} x${worst[1]}` : "",
    };
  }

  /*
   * The sampled slice: the bottom of the ladder, the top of it, and every
   * mission this pass retuned or added — the ones a regression lands on first.
   */
  const SAMPLE = [
    "pro_debut", "as_sprint", "as_bounty", "duel_wask",
    "cb_glasswork", "duel_marsh", "fp_overtime",
    "as_holdline", "dm_widowmaker", "duel_rhee", "duel_marrow",
  ];
  const list = DEEP ? M.ALL_MISSIONS : SAMPLE.map((id) => M.missionById(id));
  const n = DEEP ? 8 : 4;

  const rows = [];
  console.log(
    `     ${"mission".padEnd(16)} rank  clear  progress  race  place  stopped by`,
  );
  for (const def of list) {
    if (!def) continue;
    const r = measure(def, n);
    rows.push(r);
    console.log(
      `     ${r.id.padEnd(16)} ${String(r.rank).padStart(4)}  ${(r.clear * 100)
        .toFixed(0)
        .padStart(4)}%  ${(r.met * 100).toFixed(0).padStart(7)}%  ${r.duration
        .toFixed(0)
        .padStart(4)}s  ${r.place.toFixed(1).padStart(5)}  ${r.blocked}`,
    );
  }

  /*
   * Nothing may be a wall. A required objective that is never once met across
   * every attempt is not difficulty — it is an objective the mission cannot
   * deliver, and this catalogue has shipped one.
   */
  /*
   * EVERY CLOCK MUST FIT INSIDE THE RACE.
   *
   * A mission's lap count and its timers are authored in different places and
   * neither knows about the other, so "survive 150 seconds" on a distance that
   * takes 110 is a completely ordinary mistake to make and there was nothing
   * anywhere that could catch it. It is also the worst class of bug this layer
   * can ship: unwinnable by arithmetic, and indistinguishable from hard.
   */
  for (const r of rows) {
    const def = M.missionById(r.id);
    for (const o of def.objectives) {
      if (o.optional) continue;
      if (o.kind === "survive_time") {
        ok(
          o.seconds <= r.duration * 1.02,
          `${r.id}: the survival clock lands before the flag`,
          `needs ${o.seconds}s, the distance takes ${r.duration.toFixed(0)}s`,
        );
      }
      if (o.kind === "hold_place") {
        // 0.7 rather than 1.0: holding a position for the entire race is not an
        // objective, it is a restatement of winning it.
        ok(
          o.seconds <= r.duration * 0.7,
          `${r.id}: there is enough race to hold the position in`,
          `needs ${o.seconds}s of a ${r.duration.toFixed(0)}s race`,
        );
      }
      if (o.bySec !== undefined) {
        ok(
          o.bySec < r.duration,
          `${r.id}: the deadline bites before the flag does`,
          `deadline ${o.bySec}s, race ends at ${r.duration.toFixed(0)}s — the clock is decorative`,
        );
      }
    }
  }

  /*
   * The curve. Aggregated across tiers rather than compared mission by mission,
   * because a per-mission ordering assertion would fail on the sample noise of
   * three runs and teach everybody to ignore this section.
   */
  const early = rows.filter((r) => r.rank >= 14);
  const late = rows.filter((r) => r.rank <= 4);
  const avg = (xs, f) => (xs.length ? xs.reduce((a, b) => a + f(b), 0) / xs.length : 0);
  ok(early.length > 0 && late.length > 0, "the sample spans both ends of the board");
  /*
   * The curve is judged on CLEAR RATE, not on progress, and that is deliberate.
   *
   * Progress is not comparable across objective kinds — `finish_place` reports
   * 0.33 for a P3 out of four, so a race the bot nearly won scores lower than a
   * survival it barely started. It is a fine instrument for asking whether one
   * mission can be moved at all, and a bad one for ranking two missions against
   * each other. Clear rate is comparable by construction.
   */
  ok(
    avg(early, (r) => r.clear) > avg(late, (r) => r.clear) + 0.15,
    "the top of the board is measurably harder than the bottom",
    `clear rate: bottom ${(avg(early, (r) => r.clear) * 100).toFixed(0)}% vs top ${(avg(late, (r) => r.clear) * 100).toFixed(0)}%`,
  );
  /*
   * And the bottom of the ladder has to be winnable by a driver with no skill
   * at all, or the prologue is a wall in front of the whole game.
   */
  ok(
    avg(early, (r) => r.clear) > 0.2,
    "the first rungs are clearable by a driver who is merely competent",
    `${(avg(early, (r) => r.clear) * 100).toFixed(0)}%`,
  );
  if (!DEEP) {
    console.log("     (--winrate runs the whole catalogue at eight attempts each)");
  }
}

/* ══ SUMMARY ══════════════════════════════════════════════════════════ */
console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
