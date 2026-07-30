import { createInitialState } from "../src/game/sim.ts";
import { stepVehicle } from "../src/game/physics.ts";
import { TRACK_SAMPLES } from "../src/game/track.ts";
import { createEmptyInput } from "../src/game/input.ts";

const start = TRACK_SAMPLES[2];

function drive(opts) {
  const st = createInitialState("T", opts.classId || "interceptor");
  const v = st.vehicles[0];
  v.x = start.x;
  v.z = start.z;
  v.y = start.y + 0.55;
  v.yaw = start.yaw;
  v.speed = opts.startSpeed ?? 0;
  const input = createEmptyInput();
  input.throttle = opts.throttle ?? 1;
  input.boost = opts.boost ?? false;
  input.brake = opts.brake ?? false;
  input.steering = opts.steering ?? 0;
  const dt = 1 / 60;
  for (let i = 0; i < (opts.frames ?? 120); i++) {
    // pin to road centerline sample nearby so surface stays asphalt
    const s = TRACK_SAMPLES[2 + Math.floor(i / 10) % 20];
    if (opts.pin) {
      v.x = s.x;
      v.z = s.z;
      v.yaw = s.yaw;
    }
    stepVehicle(v, input, dt, { drifting: opts.drifting, particles: st.particles });
  }
  const avgC =
    v.tires.reduce((a, t) => a + t.compress, 0) / v.tires.length;
  const avgAbsLat =
    v.tires.reduce((a, t) => a + Math.abs(t.lat), 0) / v.tires.length;
  const avgAbsLong =
    v.tires.reduce((a, t) => a + Math.abs(t.long), 0) / v.tires.length;
  return {
    speed: +v.speed.toFixed(2),
    compress: +avgC.toFixed(3),
    lat: +avgAbsLat.toFixed(3),
    long: +avgAbsLong.toFixed(3),
    slip: +v.tireSlip.toFixed(3),
    load: +v.tireLoad.toFixed(3),
    steer: +v.steerAngle.toFixed(3),
    frontC: +v.tires[0].compress.toFixed(3),
    rearC: +v.tires[v.tires.length - 1].compress.toFixed(3),
    frontLong: +v.tires[0].long.toFixed(3),
    rearLong: +v.tires[v.tires.length - 1].long.toFixed(3),
    smoke: st.particles.filter((p) => p.kind === "smoke").length,
  };
}

const idle = drive({ throttle: 0, boost: false, frames: 60, pin: true, startSpeed: 0 });
const launch = drive({ throttle: 1, boost: true, frames: 90, pin: true, startSpeed: 0 });
const cruise = drive({ throttle: 1, boost: true, frames: 180, pin: true, startSpeed: 40 });
const brake = drive({
  throttle: 0,
  brake: true,
  boost: false,
  frames: 90,
  pin: true,
  startSpeed: 45,
});
const drift = drive({
  throttle: 0.6,
  brake: true,
  steering: 1,
  drifting: true,
  frames: 100,
  pin: true,
  startSpeed: 40,
});

console.log({ idle, launch, cruise, brake, drift });

// Idle has mild rest compression
if (idle.compress < 0.05 || idle.compress > 0.4) {
  console.error("bad idle compress", idle);
  process.exit(1);
}
// Launch: rear should load more long+ / more compress than pure idle
if (launch.rearLong <= 0.05) {
  console.error("launch should squash rear tread", launch);
  process.exit(1);
}
// Brake: front long negative-ish (brake), front compress >= rear often
if (brake.frontLong >= -0.05) {
  console.error("brake should squash front longitudinally negative", brake);
  process.exit(1);
}
if (brake.frontC + 0.02 < brake.rearC) {
  console.error("brake dive should load front", brake);
  process.exit(1);
}
// Drift: elevated slip + lateral deformation
if (drift.slip < 0.25) {
  console.error("drift slip too low", drift);
  process.exit(1);
}
if (drift.lat < 0.08) {
  console.error("drift should bulge sidewalls", drift);
  process.exit(1);
}
// Steer angle responds
if (Math.abs(drift.steer) < 0.15) {
  console.error("steer angle not responding", drift);
  process.exit(1);
}

console.log("TIRE DEFORM OK");
