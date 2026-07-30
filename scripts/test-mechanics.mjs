import { createInitialState } from "../src/game/sim.ts";
import { stepVehicle, isDrifting } from "../src/game/physics.ts";
import { TRACK_SAMPLES } from "../src/game/track.ts";
import { createEmptyInput } from "../src/game/input.ts";
import { HANDLING } from "../src/game/balance.ts";
import { catchUpFactor } from "../src/game/ai.ts";

const start = TRACK_SAMPLES[2];

function pin(v, i = 0) {
  const s = TRACK_SAMPLES[(2 + i) % TRACK_SAMPLES.length];
  v.x = s.x;
  v.z = s.z;
  v.yaw = s.yaw;
}

// 1) Brake while fast should not reverse
{
  const st = createInitialState("T", "interceptor");
  const v = st.vehicles[0];
  pin(v);
  v.speed = 40;
  const input = createEmptyInput();
  input.throttle = 0;
  input.brake = true;
  input.steering = 0;
  for (let i = 0; i < 90; i++) {
    pin(v, i);
    stepVehicle(v, input, 1 / 60, { drifting: false });
  }
  console.log("brake no reverse", v.speed.toFixed(2));
  if (v.speed < -0.5) {
    console.error("FAIL reverse while braking from speed");
    process.exit(1);
  }
}

// 2) Drift charges meter; release grants boostTimer (handbrake keeps speed)
{
  const st = createInitialState("T", "trickster");
  const v = st.vehicles[0];
  pin(v);
  v.speed = 35;
  const input = createEmptyInput();
  input.throttle = 0.85;
  input.brake = true;
  input.steering = 1;
  for (let i = 0; i < 80; i++) {
    pin(v, i);
    stepVehicle(v, input, 1 / 60, { drifting: true });
  }
  console.log(
    "drift meter",
    v.driftMeter.toFixed(2),
    "speed",
    v.speed.toFixed(1),
    "lat",
    v.lateral.toFixed(2),
  );
  if (v.driftMeter < HANDLING.driftBoostThreshold) {
    console.error("FAIL drift meter low", v.driftMeter);
    process.exit(1);
  }
  if (v.speed < 12) {
    console.error("FAIL drift killed speed", v.speed);
    process.exit(1);
  }
  if (Math.abs(v.lateral) > Math.abs(v.speed) * 0.7 + 6) {
    console.error("FAIL lateral runaway", v.lateral, v.speed);
    process.exit(1);
  }
  // release
  input.brake = false;
  input.steering = 0;
  const before = v.boostTimer;
  stepVehicle(v, input, 1 / 60, { drifting: false });
  console.log("turbo on release", { boost: v.boostTimer.toFixed(2), meter: v.driftMeter });
  if (v.boostTimer <= before || v.boostTimer < 0.3) {
    console.error("FAIL no mini turbo");
    process.exit(1);
  }
}

// 3) Launch acceleration feels snappy
{
  const st = createInitialState("T", "interceptor");
  const v = st.vehicles[0];
  pin(v);
  v.speed = 0;
  const input = createEmptyInput();
  input.throttle = 1;
  input.boost = true;
  for (let i = 0; i < 60; i++) {
    pin(v, i);
    stepVehicle(v, input, 1 / 60);
  }
  console.log("1s launch speed", v.speed.toFixed(1));
  if (v.speed < 28) {
    console.error("FAIL slow launch");
    process.exit(1);
  }
}

// 4) Pure brake (no steer) is not a drift
{
  const st = createInitialState("T", "interceptor");
  const v = st.vehicles[0];
  pin(v);
  v.speed = 30;
  const input = createEmptyInput();
  input.throttle = 0;
  input.brake = true;
  input.steering = 0;
  if (isDrifting(v, input)) {
    console.error("FAIL pure brake counted as drift");
    process.exit(1);
  }
  console.log("pure brake not drift OK");
}

// 5) Catch-up only for trailing AI
{
  const st = createInitialState("T", "interceptor");
  const player = st.vehicles[0];
  const bot = st.vehicles[1];
  player.raceProgress = 2.5;
  bot.raceProgress = 1.5;
  bot.isPlayer = false;
  const cu = catchUpFactor(bot, st.vehicles);
  const cuP = catchUpFactor(player, st.vehicles);
  console.log("catchUp bot", cu.toFixed(3), "player", cuP.toFixed(3));
  if (cu <= 0) {
    console.error("FAIL no catch-up for trailing bot");
    process.exit(1);
  }
  if (cuP !== 0) {
    console.error("FAIL player got catch-up");
    process.exit(1);
  }
}

console.log("MECHANICS OK");
