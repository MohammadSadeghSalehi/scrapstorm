#!/usr/bin/env node
/**
 * Drive the real sim at the set pieces and print what actually happens.
 *
 *   node scripts/probe-setpieces.mjs            # carriers and tunnels
 *   node scripts/probe-setpieces.mjs --jumps    # the six jump zones too
 *   node scripts/probe-setpieces.mjs --profile  # the height fields, sampled
 *
 * WHY THIS EXISTS. The carrier is a RAMP, and a ramp is the one kind of set
 * piece whose correctness cannot be read off the source. Three separate things
 * have to agree before a car leaves it in one piece:
 *
 *   - `getGroundHeight` has to return the deck (the overlay is in track.ts, the
 *     curve is in world/carrier.ts, and the placement is resolved from track
 *     samples that only exist at runtime),
 *   - `integratePos` has to convert the deck's climb into vertical velocity and
 *     then let go of it at the lip,
 *   - the trailer flanks have to be transparent to a car standing on them, which
 *     is `yTop` in setpieceColliders and one guard in worldProps.
 *
 * Any one of those failing silently produces a car that drives THROUGH the
 * carrier, or gets stopped dead by the side of the truck it is on top of, or
 * dribbles off the end at 18 m/s of constant descent. All three read as
 * plausible code. So this measures instead: exit speed at the lip, launch angle
 * from the integrator's own vy, apex, hang time, distance, and where it lands.
 *
 * It drives GameSimulation.fixedStep, not a hand-rolled loop — the same clock,
 * the same collision pass, the same ground query the game uses. The AI cars are
 * removed first so the number is a property of the ramp and not of whoever
 * happened to be alongside.
 */
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const track = await jiti.import("../src/game/track.ts");
const carrier = await jiti.import("../src/game/world/carrier.ts");
const tunnels = await jiti.import("../src/game/world/tunnels.ts");
const simMod = await jiti.import("../src/game/sim.ts");
const physics = await jiti.import("../src/game/physics.ts");
const colliders = await jiti.import("../src/game/setpieceColliders.ts");
const { CHASE } = await jiti.import("../src/game/world/camera/speedCurve.ts");

const WANT_JUMPS = process.argv.includes("--jumps");
const WANT_PROFILE = process.argv.includes("--profile");
const DT = 1 / 60;
const G = physics.GRAVITY_MS2;

const INPUT = (o = {}) => ({
  throttle: 1,
  brake: false,
  boost: false,
  steering: 0,
  reverse: false,
  fire: false,
  defense: false,
  ultimate: false,
  ...o,
});

/**
 * A sim with exactly one car, placed where we want it and racing.
 *
 * `setPhase("racing")` rather than letting the countdown run: the countdown
 * pins speed to zero every step, and this probe is about a car that is already
 * moving. Everything downstream of that — physics, props, colliders — is the
 * shipping path.
 */
function soloSim(trackId, classId) {
  const sim = new simMod.GameSimulation("PROBE", classId, trackId);
  sim.setPhase("racing");
  const player = sim.state.vehicles.find((v) => v.isPlayer);
  sim.state.vehicles.length = 0;
  sim.state.vehicles.push(player);
  return { sim, player };
}

function place(v, x, z, fx, fz, speed) {
  v.x = x;
  v.z = z;
  // yaw is authored so that forward = (-sin yaw, -cos yaw).
  v.yaw = Math.atan2(-fx, -fz);
  v.y = track.getGroundHeight(x, z) + 0.55;
  v.vy = 0;
  v.airTime = 0;
  v.speed = speed;
  v.lateral = 0;
  v.health = v.maxHealth;
  v.alive = true;
  v.wreckTimer = 0;
  v.invuln = 999;
  for (const t of v.tires ?? []) {
    t.temp = 95;
    t.slip = 0;
    t.lat = 0;
    t.long = 0;
    t.spin = 0;
  }
  physics.resetDriftState?.();
  physics.resetSteerRamp?.();
}

/* ── the deck, as the ground query reports it ─────────────────────────── */

function reportProfile(rig) {
  console.log(
    `    deck profile (getGroundHeight along the deck centre, road plane ${rig.y.toFixed(2)}m):`,
  );
  const row = [];
  for (let k = 0; k <= 10; k++) {
    const u = (rig.length * k) / 10;
    const x = rig.x + rig.fx * u;
    const z = rig.z + rig.fz * u;
    const h = track.getGroundHeight(x, z) - rig.y;
    row.push(`${u.toFixed(0)}m:${h.toFixed(2)}`);
  }
  console.log(`      ${row.join("  ")}`);

  // Grade between adjacent metres, and the exit grade the launch comes from.
  let worst = 0;
  let worstAt = 0;
  for (let u = 0; u < rig.length; u += 0.5) {
    const a = track.getGroundHeight(rig.x + rig.fx * u, rig.z + rig.fz * u);
    const b = track.getGroundHeight(
      rig.x + rig.fx * (u + 0.5),
      rig.z + rig.fz * (u + 0.5),
    );
    const g = (b - a) / 0.5;
    if (g > worst) {
      worst = g;
      worstAt = u;
    }
  }
  console.log(
    `      steepest grade ${(worst * 100).toFixed(1)}% at u=${worstAt.toFixed(1)}m` +
      `  (analytic exit 2H/L = ${((2 * rig.height) / rig.length * 100).toFixed(1)}%)`,
  );

  // And the sides: does the height field really fall away off the deck edge?
  const mid = rig.length * 0.75;
  const offs = [-6, -4.2, -3.4, 0, 3.4, 4.2, 6];
  const lat = offs.map((t) => {
    const x = rig.x + rig.fx * mid + rig.rx * t;
    const z = rig.z + rig.fz * mid + rig.rz * t;
    return `${t}m:${(track.getGroundHeight(x, z) - rig.y).toFixed(2)}`;
  });
  console.log(`      lateral cut at u=${mid.toFixed(0)}m  ${lat.join("  ")}`);
}

/* ── one run at the ramp ──────────────────────────────────────────────── */

function runRamp(trackId, rig, classId, entrySpeed) {
  const { sim, player: v } = soloSim(trackId, classId);
  // Start 30m back so the car arrives at the mouth under its own power and the
  // approach is part of what is measured.
  const back = 30;
  place(
    v,
    rig.x - rig.fx * back,
    rig.z - rig.fz * back,
    rig.fx,
    rig.fz,
    entrySpeed,
  );

  const lipX = rig.x + rig.fx * rig.length;
  const lipZ = rig.z + rig.fz * rig.length;

  let onDeck = false;
  let deckEntrySpeed = 0;
  let peakDeck = 0;
  let launch = null;
  let apex = -Infinity;
  let airTime = 0;
  let landed = null;
  let maxDeflect = 0;

  for (let step = 0; step < 60 * 12; step++) {
    const preSpeed = v.speed;
    sim.fixedStep(DT, INPUT());
    const along = (v.x - rig.x) * rig.fx + (v.z - rig.z) * rig.fz;
    const lateral = (v.x - rig.x) * rig.rx + (v.z - rig.z) * rig.rz;
    const deck = v.y - 0.55 - rig.y;

    // A deflection off a flank would show up as speed lost with no brake and no
    // offroad, which is the failure mode `yTop` exists to prevent.
    if (along > 1 && along < rig.length && Math.abs(lateral) < rig.halfW) {
      const lost = preSpeed - v.speed;
      if (lost > maxDeflect) maxDeflect = lost;
      if (!onDeck && deck > 0.15) {
        onDeck = true;
        deckEntrySpeed = v.speed;
      }
      if (deck > peakDeck) peakDeck = deck;
    }

    if (!launch && v.airTime > 0 && along > rig.length * 0.5) {
      launch = {
        speed: v.speed,
        vy: v.vy ?? 0,
        y: v.y,
        along,
        lateral,
        x: v.x,
        z: v.z,
      };
    }
    if (launch) {
      if (v.airTime > 0) {
        airTime += DT;
        if (v.y > apex) apex = v.y;
      } else if (!landed) {
        landed = {
          x: v.x,
          z: v.z,
          y: v.y,
          speed: v.speed,
          dist: Math.hypot(v.x - launch.x, v.z - launch.z),
          surf: track.getSurfaceAt(v.x, v.z).kind,
          onTrack: track.isOnTrack(v.x, v.z).on,
        };
        break;
      }
    }
    void lipX;
    void lipZ;
  }

  return {
    entrySpeed,
    onDeck,
    deckEntrySpeed,
    peakDeck,
    launch,
    apex,
    airTime,
    landed,
    maxDeflect,
  };
}

/* ── the existing jump zones, for comparison ──────────────────────────── */

function runJump(trackId, classId, entrySpeed) {
  track.setActiveTrack(trackId);
  const S = track.getTrackSamples();
  const jump = [];
  for (let i = 0; i < S.length; i++) if (S[i].zone === "jump") jump.push(i);
  if (!jump.length) return null;
  const startIdx = (jump[0] - 22 + S.length) % S.length;
  const sm = S[startIdx];
  const { sim, player: v } = soloSim(trackId, classId);
  place(v, sm.x, sm.z, -Math.sin(sm.yaw), -Math.cos(sm.yaw), entrySpeed);

  let air = 0;
  let apex = 0;
  let peakVy = 0;
  let ground0 = 0;
  for (let step = 0; step < 60 * 14; step++) {
    // Steer for the centreline so the car stays on the ramp rather than
    // wandering off it — the crest is only a crest on the road.
    const idx = track.nearestTrackIndex(v.x, v.z, v.yaw);
    const tgt = S[(idx + 6) % S.length];
    let dy = Math.atan2(-(tgt.x - v.x), -(tgt.z - v.z)) - v.yaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    sim.fixedStep(DT, INPUT({ steering: Math.max(-1, Math.min(1, dy * 2.4)) }));
    if (v.airTime > 0) {
      if (air === 0) ground0 = track.getGroundHeight(v.x, v.z);
      air += DT;
      apex = Math.max(apex, v.y - ground0 - 0.55);
      peakVy = Math.max(peakVy, v.vy ?? 0);
    } else if (air > 0) {
      break;
    }
  }
  return { air, apex, peakVy, entrySpeed };
}

/* ── report ───────────────────────────────────────────────────────────── */

const CARRIER_TRACKS = [];
for (const def of track.TRACK_CATALOG) {
  track.setActiveTrack(def.id);
  if (carrier.getCarriers().length) CARRIER_TRACKS.push(def.id);
}

console.log(`\ncarrier circuits: ${CARRIER_TRACKS.join(", ") || "none"}`);

let failures = 0;

for (const id of CARRIER_TRACKS) {
  track.setActiveTrack(id);
  const rig = carrier.getCarriers()[0];
  console.log(`\n== ${id} ==`);
  console.log(
    `  deck  length ${rig.length}m  lip ${rig.height}m  halfW ${rig.halfW}m` +
      `  at (${rig.x.toFixed(1)}, ${rig.z.toFixed(1)})  road plane ${rig.y.toFixed(2)}m`,
  );
  const caps = carrier.carrierCapsules();
  console.log(
    `  ${caps.length} capsules (${caps.filter((c) => c.yTop < rig.y + rig.height).length} below the lip)`,
  );
  if (WANT_PROFILE) reportProfile(rig);

  for (const speed of [22, 32, 42]) {
    const r = runRamp(id, rig, "interceptor", speed);
    if (!r.onDeck) {
      console.log(`  FAIL  ${speed} m/s — the car never got onto the deck`);
      failures++;
      continue;
    }
    if (!r.launch) {
      console.log(
        `  FAIL  ${speed} m/s — reached ${r.peakDeck.toFixed(2)}m of deck but never left it`,
      );
      failures++;
      continue;
    }
    const ang = (Math.atan2(r.launch.vy, Math.max(0.1, r.launch.speed)) * 180) / Math.PI;
    const l = r.landed;
    console.log(
      `  ${String(speed).padStart(2)} m/s in  ->  deck ${r.peakDeck.toFixed(2)}m` +
        `  lip ${r.launch.speed.toFixed(1)} m/s  vy ${r.launch.vy.toFixed(2)} m/s` +
        `  angle ${ang.toFixed(1)}deg`,
    );
    console.log(
      `           air ${r.airTime.toFixed(2)}s  apex +${(r.apex - rig.y - 0.55).toFixed(2)}m` +
        `  flew ${l ? l.dist.toFixed(1) + "m" : "(still airborne)"}` +
        `  land ${l ? `${l.surf}${l.onTrack ? "" : " OFF-TRACK"} at ${l.speed.toFixed(1)} m/s` : "-"}` +
        `  worst step loss ${r.maxDeflect.toFixed(2)} m/s`,
    );
    // A deflection off the trailer's own flank costs several m/s in one step;
    // rolling resistance and tyre scrub cost hundredths.
    if (r.maxDeflect > 1.5) {
      console.log(
        `  FAIL  ${speed} m/s — lost ${r.maxDeflect.toFixed(2)} m/s in ONE step while on the deck.` +
          ` That is a flank deflection: check yTop and the worldProps guard.`,
      );
      failures++;
    }
    if (l && !l.onTrack) {
      console.log(
        `  note  ${speed} m/s lands off the tarmac — the run-out is not long enough for this speed`,
      );
    }
  }
}

if (WANT_JUMPS) {
  console.log(`\n== jump zones (g = ${G} m/s^2) ==`);
  for (const def of track.TRACK_CATALOG) {
    const r = runJump(def.id, "interceptor", 40);
    if (!r) {
      console.log(`  ${def.id.padEnd(12)} no jump zone`);
      continue;
    }
    console.log(
      `  ${def.id.padEnd(12)} entry ${r.entrySpeed} m/s -> air ${r.air.toFixed(2)}s` +
        `  apex +${r.apex.toFixed(2)}m  peak vy ${r.peakVy.toFixed(2)} m/s`,
    );
  }
}

/* ── tunnels ──────────────────────────────────────────────────────────── */

/**
 * The camera's own worst-case height above the road plane.
 *
 * Recomputed here from the shipped constants rather than copied, so that if the
 * chase rig is retuned this probe reports the new number and the ceiling test
 * either still passes or stops passing. The gantry does the same thing in
 * world/StartGantry.tsx — a clearance that is a literal is a clearance that goes
 * stale silently, which is exactly the bug this pass was asked to fix.
 */
const camMax = 0.55 + CHASE.heightBase + CHASE.heightGain;

console.log(`\n== tunnels ==  (chase rig tops out ${camMax.toFixed(2)}m above the road)`);
for (const def of track.TRACK_CATALOG) {
  track.setActiveTrack(def.id);
  const bores = tunnels.getTunnels();
  if (!bores.length) continue;
  for (const t of bores) {
    const S = track.getTrackSamples();
    console.log(`  ${def.id} / ${t.id}`);
    console.log(
      `    ${t.length.toFixed(1)}m long, ${t.pts.length} stations,` +
        ` clear height ${t.clearance}m, bore half-width ${t.pts[0].hw.toFixed(1)}m` +
        ` (road half ${(t.pts[0].hw - (t.pts[0].hw - S[0].width * 0)).toFixed(1) && ""}` +
        `${(t.pts.reduce((m, p) => Math.min(m, p.hw), 99)).toFixed(1)}..${t.pts
          .reduce((m, p) => Math.max(m, p.hw), 0)
          .toFixed(1)}m)`,
    );

    // Does the ROAD stay inside its own bore? The bore is swept from the
    // samples so it does by construction — but the collider capsules are laid
    // at hw + WALL_R and the car is 1.4m of projected half-extent, so the
    // question that matters is how much room is actually left.
    let tightest = Infinity;
    for (const p of t.pts) {
      const surf = track.getSurfaceAt(p.x, p.z);
      tightest = Math.min(tightest, p.hw - surf.half);
    }
    console.log(
      `    narrowest gap between tarmac edge and wall face: ${tightest.toFixed(2)}m` +
        `  (a car's projected half-extent is ~1.4m)`,
    );

    // Cover profile: 0 outside, 1 in the middle.
    const mid = t.pts[Math.floor(t.pts.length / 2)];
    const first = t.pts[0];
    const cov = [];
    for (const f of [-0.15, 0, 0.15, 0.35, 0.5, 0.75, 1, 1.15]) {
      let x;
      let z;
      if (f <= 0 || f >= 1) {
        // Step off the ends along the entry/exit heading.
        const a = f <= 0 ? t.pts[0] : t.pts[t.pts.length - 1];
        const b = f <= 0 ? t.pts[1] : t.pts[t.pts.length - 2];
        const ux = (a.x - b.x) / Math.max(0.01, Math.hypot(a.x - b.x, a.z - b.z));
        const uz = (a.z - b.z) / Math.max(0.01, Math.hypot(a.x - b.x, a.z - b.z));
        const off = Math.abs(f <= 0 ? f : f - 1) * t.length;
        x = a.x + ux * off;
        z = a.z + uz * off;
      } else {
        const d = f * t.length;
        let i = 0;
        while (i < t.pts.length - 2 && t.pts[i + 1].d < d) i++;
        const a = t.pts[i];
        const b = t.pts[i + 1];
        const u = (d - a.d) / Math.max(1e-3, b.d - a.d);
        x = a.x + (b.x - a.x) * u;
        z = a.z + (b.z - a.z) * u;
      }
      cov.push(`${(f * 100).toFixed(0)}%:${tunnels.tunnelCover(x, z).toFixed(2)}`);
    }
    console.log(`    cover along the bore  ${cov.join("  ")}`);

    const ceilIn = tunnels.tunnelCeiling(mid.x, mid.z) - t.baseY;
    console.log(
      `    ceiling inside ${ceilIn.toFixed(2)}m above the road` +
        `  -> the rig ducks ${(camMax - ceilIn).toFixed(2)}m`,
    );
    if (ceilIn >= camMax) {
      console.log(`    note  the rig already fits; the duck is inert here`);
    }
    if (ceilIn > t.clearance - 0.5) {
      console.log(`  FAIL  ceiling ${ceilIn.toFixed(2)}m leaves under 0.5m under a ${t.clearance}m slab`);
      failures++;
    }
    // And the approach: 20m before the portal the ceiling must not yet bite.
    const bx = first.x - (t.pts[1].x - first.x) * (20 / 3.1);
    const bz = first.z - (t.pts[1].z - first.z) * (20 / 3.1);
    const ceilPre = tunnels.tunnelCeiling(bx, bz);
    console.log(
      `    ceiling 20m before the portal: ${Number.isFinite(ceilPre) ? (ceilPre - t.baseY).toFixed(1) + "m" : "unbounded"}`,
    );

    /*
     * Drive it. Steering for the centreline, which is what the AI does — if
     * that line touches a wall the bore is too narrow and the circuit has an
     * invisible chicane in it.
     */
    const { sim, player: v } = soloSim(def.id, "bruiser");

    /*
     * Clear the harness's own phantoms before measuring anything.
     *
     * `worldProps.spawnWorldProps` reads the `export let` bindings TRACK_SAMPLES
     * / EDGE_MARKERS / SCENERY rather than the accessors. Live bindings under
     * real ESM — the browser is correct — but jiti snapshots them at module
     * init, which is always ash_spire, so under this script every circuit but
     * ash_spire gets ash_spire's props. The first version of this probe reported
     * the Rustline bore as impassable because a 2.08m Ash Spire tower was
     * standing on Rustline's racing line at (103, 12), 400m from home.
     *
     * Reported and removed rather than worked around silently: the removal is
     * what makes the tunnel number mean anything, and the count is what stops
     * the underlying defect being forgotten. See the note at the top of
     * worldProps.ts for why it is not simply fixed.
     */
    let phantoms = 0;
    for (const p of sim.state.props) {
      if (p.dead || p.dynamic || p.breakable) continue;
      const surf = track.getSurfaceAt(p.x, p.z);
      if (surf.dist - p.radius > surf.half + 1) continue;
      p.dead = true;
      phantoms += 1;
    }
    if (phantoms) {
      console.log(
        `    NOTE  removed ${phantoms} static blocker(s) standing on the tarmac —` +
          ` the jiti export-let snapshot in worldProps, not this circuit's world`,
      );
    }

    const entry = t.pts[0];
    const back = 40;
    const ux = (t.pts[1].x - entry.x) / 3.1;
    const uz = (t.pts[1].z - entry.z) / 3.1;
    place(v, entry.x - ux * back, entry.z - uz * back, ux, uz, 38);
    let worstLoss = 0;
    let peakCover = 0;
    let through = false;
    for (let step = 0; step < 60 * 15; step++) {
      const pre = v.speed;
      const idx = track.nearestTrackIndex(v.x, v.z, v.yaw);
      const S2 = track.getTrackSamples();
      const tgt = S2[(idx + 5) % S2.length];
      let dy = Math.atan2(-(tgt.x - v.x), -(tgt.z - v.z)) - v.yaw;
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      sim.fixedStep(DT, INPUT({ steering: Math.max(-1, Math.min(1, dy * 2.6)) }));
      const c = tunnels.tunnelCover(v.x, v.z);
      if (c > peakCover) peakCover = c;
      if (c > 0.02) worstLoss = Math.max(worstLoss, pre - v.speed);
      if (peakCover > 0.5 && c < 0.01) {
        through = true;
        break;
      }
    }
    console.log(
      `    drove it at 38 m/s (bruiser, widest car): peak cover ${peakCover.toFixed(2)},` +
        ` worst single-step loss inside ${worstLoss.toFixed(2)} m/s,` +
        ` ${through ? "came out the far end" : "DID NOT EXIT"}`,
    );
    if (!through || peakCover < 0.9 || worstLoss > 1.5) {
      console.log(
        `  FAIL  ${def.id} bore: ${!through ? "the car did not get through" : peakCover < 0.9 ? "cover never reached full darkness on the racing line" : "the car hit a wall driving the centreline"}`,
      );
      failures++;
    }
    console.log(`    ${tunnels.tunnelCapsules().length} wall capsules`);
  }
}

console.log("");
for (const def of track.TRACK_CATALOG) {
  track.setActiveTrack(def.id);
  colliders.rebuildSetpieceColliders();
  const bd = colliders.setpieceColliderBreakdown();
  const mine = ["tunnelWall", "carrier"].filter((k) => bd[k]);
  console.log(
    `  ${def.id.padEnd(12)} ${String(colliders.setpieceColliderCount()).padStart(4)} static colliders` +
      (mine.length ? `  (+${mine.map((k) => `${bd[k]} ${k}`).join(", ")})` : ""),
  );
}

track.setActiveTrack("ash_spire");
console.log("");
process.exit(failures ? 1 : 0);
