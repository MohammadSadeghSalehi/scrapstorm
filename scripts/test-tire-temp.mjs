import { createInitialState } from "../src/game/sim.ts";
import { stepVehicle } from "../src/game/physics.ts";
import { TRACK_SAMPLES } from "../src/game/track.ts";
import { createEmptyInput } from "../src/game/input.ts";
import { tempGripCurve, TIRE_TEMP, TIRE_AMBIENT_C } from "../src/game/tires.ts";

// Curve self-check
const gCold = tempGripCurve(40);
const gOpt = tempGripCurve(95);
const gCrit = tempGripCurve(155);
console.log("grip curve", { gCold, gOpt, gCrit });
if (!(gOpt > gCold && gOpt > gCrit)) {
  console.error("optimal should peak");
  process.exit(1);
}

const start = TRACK_SAMPLES[2];

function run(opts) {
  const st = createInitialState("T", opts.classId || "trickster");
  const v = st.vehicles[0];
  v.x = start.x;
  v.z = start.z;
  v.y = start.y + 0.55;
  v.yaw = start.yaw;
  v.speed = opts.startSpeed ?? 30;
  // chill tires if requested
  if (opts.coldStart) {
    for (const t of v.tires) t.temp = TIRE_AMBIENT_C;
    v.tireTemp = TIRE_AMBIENT_C;
  }
  const input = createEmptyInput();
  input.throttle = opts.throttle ?? 1;
  input.boost = opts.boost ?? false;
  input.brake = opts.brake ?? false;
  input.steering = opts.steering ?? 0;
  const dt = 1 / 60;
  for (let i = 0; i < (opts.frames ?? 300); i++) {
    const s = TRACK_SAMPLES[2 + (i % 40)];
    v.x = s.x;
    v.z = s.z;
    v.yaw = s.yaw;
    stepVehicle(v, input, dt, {
      drifting: opts.drifting,
      particles: st.particles,
    });
  }
  return {
    classId: v.classId,
    temp: +v.tireTemp.toFixed(1),
    band: v.tireTempBand,
    slip: +v.tireSlip.toFixed(2),
    frontT: +v.tires[0].temp.toFixed(1),
    rearT: +v.tires[v.tires.length - 1].temp.toFixed(1),
  };
}

const cruise = run({
  classId: "interceptor",
  throttle: 1,
  boost: false,
  frames: 240,
  startSpeed: 40,
  coldStart: true,
});
const driftCook = run({
  classId: "trickster",
  throttle: 0.7,
  brake: true,
  steering: 1,
  drifting: true,
  frames: 360,
  startSpeed: 42,
  coldStart: true,
});
const brakeFront = run({
  classId: "bruiser",
  throttle: 0,
  brake: true,
  frames: 200,
  startSpeed: 48,
  coldStart: true,
});
const idleCool = (() => {
  // heat then coast cool
  const st = createInitialState("T", "interceptor");
  const v = st.vehicles[0];
  for (const t of v.tires) t.temp = 130;
  v.tireTemp = 130;
  const input = createEmptyInput();
  input.throttle = 0.2;
  const dt = 1 / 60;
  for (let i = 0; i < 400; i++) {
    const s = TRACK_SAMPLES[2 + (i % 40)];
    v.x = s.x;
    v.z = s.z;
    v.yaw = s.yaw;
    v.speed = 35;
    stepVehicle(v, input, dt, { particles: st.particles });
  }
  return { temp: +v.tireTemp.toFixed(1), band: v.tireTempBand };
})();

console.log({ cruise, driftCook, brakeFront, idleCool });

if (cruise.temp <= TIRE_AMBIENT_C + 2) {
  console.error("cruise should warm tires", cruise);
  process.exit(1);
}
if (driftCook.temp < cruise.temp + 8) {
  console.error("drift should cook tires harder", { cruise, driftCook });
  process.exit(1);
}
if (brakeFront.frontT < brakeFront.rearT - 1) {
  console.error("brakes should heat fronts more", brakeFront);
  process.exit(1);
}
if (idleCool.temp >= 130) {
  console.error("should cool from 130", idleCool);
  process.exit(1);
}
// trickster heats faster than bruiser on similar scrub
const bruDrift = run({
  classId: "bruiser",
  throttle: 0.7,
  brake: true,
  steering: 1,
  drifting: true,
  frames: 360,
  startSpeed: 42,
  coldStart: true,
});
console.log("trickster vs bruiser drift heat", driftCook.temp, bruDrift.temp);
if (driftCook.temp < bruDrift.temp) {
  console.error("trickster compound should run hotter on drift");
  process.exit(1);
}

console.log("TIRE TEMP OK");
