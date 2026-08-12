/**
 * Headless scan for vertical discontinuities in the track's height profile.
 *
 * Loads the real TypeScript through jiti rather than reimplementing the curve,
 * because a check that re-derives the thing it is checking proves nothing. No
 * renderer, no dev server — a step in the road is a property of the sample
 * array and needs neither.
 *
 *   node scripts/check-track-profile.mjs [--max-grade 0.30]
 *
 * Exits non-zero if any adjacent sample pair exceeds the grade limit, so this
 * can gate a commit.
 */
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const track = await jiti.import("../src/game/track.ts");
/*
 * g comes from the integrator, not from a literal here.
 *
 * The launch figure below is `sqrt(g R)`, and for as long as `integratePos`
 * descended at a fixed 18 m/s with no upward phase it was a claim about a road
 * that the physics never honoured — every crest in the catalogue produced at
 * most 0.09m of air at 40 m/s, measured. The integrator is ballistic now, so
 * this number is a prediction the sim can be held to; importing the constant is
 * what stops the two drifting apart again.
 */
const { GRAVITY_MS2 } = await jiti.import("../src/game/physics.ts");

const arg = process.argv.indexOf("--max-grade");
/** rise/run. 0.30 is a 17-degree slope — steeper than any real road ramp. */
const MAX_GRADE = arg > -1 ? Number(process.argv[arg + 1]) : 0.3;

let failed = false;

/*
 * Ids come from the catalogue, not from a list written down here.
 *
 * This was a hardcoded pair, which meant that adding a circuit silently added
 * an UNCHECKED circuit — the one situation this script exists to prevent. A
 * `--track <id>` filter narrows it when you are iterating on one layout.
 */
const only = process.argv.indexOf("--track");
const ALL_IDS = (track.TRACK_CATALOG ?? []).map((d) => d.id);
const IDS =
  only > -1 ? [process.argv[only + 1]] : ALL_IDS.length ? ALL_IDS : ["ash_spire"];

for (const id of IDS) {
  track.setActiveTrack(id);
  /*
   * getTrackSamples(), NOT track.TRACK_SAMPLES.
   *
   * `export let` is a live binding under real ESM, but jiti transpiles to CJS
   * and snapshots the namespace property at module init. Reading TRACK_SAMPLES
   * here returned ash_spire's array for BOTH tracks while getActiveTrackId()
   * correctly reported cinder_bowl — identical sample count, identical worst
   * step, identical index. It looked exactly like a passing test.
   */
  const S = track.getTrackSamples();
  if (track.getActiveTrackId() !== id) {
    throw new Error(`setActiveTrack(${id}) did not take effect`);
  }

  const steps = [];
  for (let i = 0; i < S.length; i++) {
    const a = S[i];
    const b = S[(i + 1) % S.length];
    const rise = b.y - a.y;
    const run = Math.hypot(b.x - a.x, b.z - a.z);
    steps.push({
      i,
      next: (i + 1) % S.length,
      rise,
      run,
      grade: Math.abs(rise) / Math.max(1e-6, run),
      zone: a.zone,
      nextZone: b.zone,
    });
  }

  steps.sort((p, q) => q.grade - p.grade);
  const worst = steps[0];
  const bad = steps.filter((s) => s.grade > MAX_GRADE);

  const yMin = Math.min(...S.map((s) => s.y));
  const yMax = Math.max(...S.map((s) => s.y));
  const jump = S.filter((s) => s.zone === "jump");
  const jumpLift = jump.length
    ? Math.max(...jump.map((s) => s.y)) - Math.min(...jump.map((s) => s.y))
    : 0;

  console.log(`\n== ${id} ==`);
  console.log(`  samples        ${S.length}`);
  console.log(`  y range        ${yMin.toFixed(3)} .. ${yMax.toFixed(3)}`);
  console.log(
    `  jump samples   ${jump.length} (lift range ${jumpLift.toFixed(3)}m)`,
  );
  console.log(
    `  worst step     ${worst.rise.toFixed(3)}m over ${worst.run.toFixed(2)}m` +
      ` = ${(worst.grade * 100).toFixed(1)}% at ${worst.i}->${worst.next}` +
      ` (${worst.zone}->${worst.nextZone})`,
  );
  for (const s of steps.slice(1, 4)) {
    console.log(
      `  next worst     ${s.rise.toFixed(3)}m / ${s.run.toFixed(2)}m` +
        ` = ${(s.grade * 100).toFixed(1)}% at ${s.i}->${s.next}`,
    );
  }

  /*
   * Does the crest still launch a car?
   *
   * A ramp that is smooth is not automatically a ramp that jumps. Following a
   * crest of radius R at speed v needs centripetal acceleration v^2/R; once
   * that exceeds g the wheels leave the ground. Flattening the profile raises
   * the speed at which that happens, and past a point the jump zone becomes a
   * hump you drive over. Curvature is taken from the sampled y, so it measures
   * the road as actually built rather than the formula that generated it.
   */
  let tightest = Infinity;
  for (let i = 0; i < S.length; i++) {
    const a = S[(i - 1 + S.length) % S.length];
    const b = S[i];
    const c = S[(i + 1) % S.length];
    if (b.zone !== "jump") continue;
    const d1 = Math.hypot(b.x - a.x, b.z - a.z);
    const d2 = Math.hypot(c.x - b.x, c.z - b.z);
    if (d1 < 1e-3 || d2 < 1e-3) continue;
    // Second difference of y with respect to arc length.
    const yPP = 2 * ((c.y - b.y) / d2 - (b.y - a.y) / d1) / (d1 + d2);
    if (yPP >= -1e-9) continue; // only convex (crest) curvature launches
    const R = 1 / -yPP;
    if (R < tightest) tightest = R;
  }
  const launchMs = Number.isFinite(tightest)
    ? Math.sqrt(GRAVITY_MS2 * tightest)
    : Infinity;
  console.log(
    `  crest radius   ${Number.isFinite(tightest) ? tightest.toFixed(0) + "m" : "none"}` +
      `  -> launches above ${Number.isFinite(launchMs) ? launchMs.toFixed(1) + " m/s (" + (launchMs * 2.237).toFixed(0) + " mph)" : "never"}`,
  );

  if (bad.length) {
    failed = true;
    console.log(
      `  FAIL           ${bad.length} pair(s) exceed ${(MAX_GRADE * 100).toFixed(0)}%`,
    );
  } else {
    console.log(`  ok             no pair exceeds ${(MAX_GRADE * 100).toFixed(0)}%`);
  }
}

track.setActiveTrack("ash_spire");
console.log("");
process.exit(failed ? 1 : 0);
