import { createInitialState } from "../src/game/sim.ts";
import { stepVehicle } from "../src/game/physics.ts";
import { TRACK_SAMPLES, getSurfaceAt } from "../src/game/track.ts";
import { createEmptyInput } from "../src/game/input.ts";
import { VEHICLE_CLASSES } from "../src/game/classes.ts";

const start = TRACK_SAMPLES[2];
const rx = Math.cos(start.yaw);
const rz = -Math.sin(start.yaw);

function runPinned(offset, classId) {
  const st = createInitialState("T", classId);
  const v = st.vehicles[0];
  const px = start.x + rx * offset;
  const pz = start.z + rz * offset;
  v.x = px;
  v.z = pz;
  v.y = start.y + 0.55;
  v.yaw = start.yaw;
  v.speed = 0;
  v.lateral = 0;
  const input = createEmptyInput();
  input.throttle = 1;
  input.boost = true;
  input.steering = 0;
  const dt = 1 / 60;
  for (let i = 0; i < 200; i++) {
    // Pin position so we measure pure surface effect on speed, not path drift
    v.x = px;
    v.z = pz;
    v.yaw = start.yaw;
    v.lateral = 0;
    stepVehicle(v, input, dt, { particles: st.particles });
  }
  const surf = getSurfaceAt(px, pz, start.yaw);
  return {
    classId,
    offset: +offset.toFixed(1),
    speed: +v.speed.toFixed(2),
    surface: v.surface,
    off: +v.offroadAmount.toFixed(3),
    factor: +surf.factor.toFixed(3),
    kind: surf.kind,
    dust: st.particles.filter((p) => p.kind === "dust").length,
    max: VEHICLE_CLASSES[classId].maxSpeed,
  };
}

const results = [];
for (const c of ["interceptor", "bruiser", "trickster"]) {
  results.push(runPinned(0, c));
  results.push(runPinned(start.width * 0.5 + 3, c));
  results.push(runPinned(start.width * 0.5 + 18, c));
  results.push(runPinned(start.width * 0.5 + 40, c));
}
console.table(results);

for (const c of ["interceptor", "bruiser", "trickster"]) {
  const road = results.find((r) => r.classId === c && r.offset === 0);
  const sand = results.find((r) => r.classId === c && r.offset > 25);
  console.log(c, "road", road.speed, road.kind, "sand", sand.speed, sand.kind);
  if (sand.speed >= road.speed * 0.88) {
    console.error("FAIL", c, "sand not slower enough", road, sand);
    process.exit(1);
  }
  if (road.kind !== "asphalt") {
    console.error("FAIL expected asphalt", road);
    process.exit(1);
  }
  if (sand.off < 0.35) {
    console.error("FAIL sand off low", sand);
    process.exit(1);
  }
  if (sand.dust < 1) {
    console.error("FAIL no dust on sand", sand);
    process.exit(1);
  }
}

const iRoad = results.find((r) => r.classId === "interceptor" && r.offset === 0);
const iSand = results.find((r) => r.classId === "interceptor" && r.offset > 25);
const bRoad = results.find((r) => r.classId === "bruiser" && r.offset === 0);
const bSand = results.find((r) => r.classId === "bruiser" && r.offset > 25);
const iRatio = iSand.speed / iRoad.speed;
const bRatio = bSand.speed / bRoad.speed;
console.log("sand retention interceptor", iRatio.toFixed(2), "bruiser", bRatio.toFixed(2));
if (bRatio + 0.01 < iRatio) {
  console.error("FAIL bruiser should retain more speed offroad", iRatio, bRatio);
  process.exit(1);
}
console.log("PHYSICS UNIT OK");
