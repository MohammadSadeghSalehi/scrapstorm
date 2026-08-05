/**
 * Grid geometry probe — measures the actual starting grid on every circuit.
 *
 * The grid is authored in SAMPLE indices (sim.ts GRID_*), not metres, so the
 * only way to know what it looks like on a 22m road versus a 32m one is to
 * build it and measure. Everything is measured in the TRACK's own frame — arc
 * length along the centreline, signed offset across it — rather than by
 * straight-line distance, because two cars in different rows are separated in
 * both axes at once and a hypotenuse tells you nothing about either.
 *
 * Reports, per circuit:
 *   lane gap  — lateral separation of the two cars sharing a row
 *   row gap   — arc-length separation of the front and rear rows
 *   edge      — clearance from each car's outer flank to the road edge
 *   order     — grid slot i starts ahead of slot i+1 (pole is at the FRONT)
 *
 * Run:  node scripts/balance-grid.mjs   — non-zero exit if any circuit fails.
 */
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const track = await jiti.import("../src/game/track.ts");
const simMod = await jiti.import("../src/game/sim.ts");
const phys = await jiti.import("../src/game/physics.ts");

/** Widest body in the game — the Bruiser at 1.22. Clearance is judged on it. */
const CAR_HALF_W = Math.max(
  ...Object.values(phys.VEHICLE_HITBOX).map((h) => h.halfW),
);
/** Minimum air between two cars abreast before a launch is a collision. */
const MIN_LANE_AIR = 1.2;
/** Minimum air from the outer flank to the road edge. */
const MIN_EDGE_AIR = 0.8;

const ids = track.TRACK_CATALOG.map((d) => d.id);
let bad = 0;

console.log(
  "circuit         spacing  width  lane-gap  air  row-gap   edge(min)  order",
);
for (const id of ids) {
  const g = new simMod.GameSimulation("TESTER", "interceptor", id);
  g.setPhase("countdown");
  const S = track.getTrackSamples();

  let span = 0;
  for (let i = 1; i < S.length; i++) {
    span += Math.hypot(S[i].x - S[i - 1].x, S[i].z - S[i - 1].z);
  }
  const spacing = span / (S.length - 1);

  /** Project a car onto the centreline: {s, lat, width} at its nearest sample. */
  function frame(v) {
    let best = Infinity;
    let bi = 0;
    for (let i = 0; i < Math.min(60, S.length); i++) {
      const d = (S[i].x - v.x) ** 2 + (S[i].z - v.z) ** 2;
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    const s = S[bi];
    // Right vector, matching sim.makeVehicle's lane offset convention.
    const rx = Math.cos(s.yaw);
    const rz = -Math.sin(s.yaw);
    const lat = (v.x - s.x) * rx + (v.z - s.z) * rz;
    const along = s.s + ((v.x - s.x) * Math.sin(s.yaw) + (v.z - s.z) * Math.cos(s.yaw));
    return { s: along, lat, width: s.width };
  }

  const f = g.state.vehicles.map(frame);

  // Rows are pairs by slot: 0/1 front, 2/3 rear.
  const laneGap = (Math.abs(f[0].lat - f[1].lat) + Math.abs(f[2].lat - f[3].lat)) / 2;
  const laneAir = laneGap - 2 * CAR_HALF_W;
  const rowGap = (f[0].s + f[1].s) / 2 - (f[2].s + f[3].s) / 2;
  const edges = f.map((c) => c.width * 0.5 - Math.abs(c.lat) - CAR_HALF_W);
  const minEdge = Math.min(...edges);

  // Pole must start ahead. Cars sharing a row are equal, so only compare rows.
  const ordered = rowGap > 0;
  const okLane = laneAir >= MIN_LANE_AIR;
  const okRow = rowGap >= 5;
  const okEdge = minEdge >= MIN_EDGE_AIR;
  const good = ordered && okLane && okRow && okEdge;
  if (!good) bad += 1;

  console.log(
    [
      id.padEnd(14),
      spacing.toFixed(2).padStart(7),
      f[0].width.toFixed(1).padStart(6),
      laneGap.toFixed(2).padStart(9),
      laneAir.toFixed(2).padStart(5),
      rowGap.toFixed(2).padStart(8),
      minEdge.toFixed(2).padStart(10),
      "  " + (good ? "ok" : "FAIL"),
    ].join(" "),
  );
}

console.log(bad === 0 ? "\nall circuits ok" : `\n${bad} circuit(s) FAILED`);
process.exit(bad === 0 ? 0 : 1);
