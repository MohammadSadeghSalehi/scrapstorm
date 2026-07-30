import { VEHICLE_CLASSES } from "./classes";
import type { PlayerInput, SurfaceKind, TireState, VehicleClassId, VehicleState } from "./types";

/** Rest radius used for visual sink compensation (world units). */
export const TIRE_RADIUS: Record<VehicleClassId, number> = {
  interceptor: 0.32,
  bruiser: 0.34,
  trickster: 0.32,
};

/** Desert scrapyard ambient rubber temperature (°C). */
export const TIRE_AMBIENT_C = 38;

/** Temperature windows (°C) for grip curve + HUD. */
export const TIRE_TEMP = {
  cold: 50,
  warm: 68,
  optimalLo: 82,
  optimalHi: 108,
  hot: 125,
  critical: 145,
  max: 175,
} as const;

/** Class thermal / compound personality. */
const COMPOUND: Record<
  VehicleClassId,
  {
    /** thermal mass — higher = slower ΔT */
    mass: number;
    /** slip-heat gain */
    slipHeat: number;
    /** airflow cooling */
    cool: number;
    /** optimal grip peak bonus */
    peakGrip: number;
    /** how badly cold tires hurt */
    coldPenalty: number;
    /** how badly blistering hurts */
    overheatPenalty: number;
  }
> = {
  interceptor: {
    mass: 0.72,
    slipHeat: 1.25,
    cool: 1.2,
    peakGrip: 1.06,
    coldPenalty: 0.22,
    overheatPenalty: 0.28,
  },
  bruiser: {
    mass: 1.35,
    slipHeat: 0.85,
    cool: 0.75,
    peakGrip: 1.03,
    coldPenalty: 0.14,
    overheatPenalty: 0.2,
  },
  trickster: {
    mass: 0.9,
    slipHeat: 1.35, // drift compound cooks on slide
    cool: 1.05,
    peakGrip: 1.1,
    coldPenalty: 0.18,
    overheatPenalty: 0.32,
  },
};

export type TireTempBand = "cold" | "warm" | "optimal" | "hot" | "critical";

export function tireTempBand(tempC: number): TireTempBand {
  if (tempC < TIRE_TEMP.cold) return "cold";
  if (tempC < TIRE_TEMP.warm) return "warm";
  if (tempC <= TIRE_TEMP.optimalHi) return "optimal";
  if (tempC < TIRE_TEMP.critical) return "hot";
  return "critical";
}

export function wheelCount(classId: VehicleClassId): number {
  return classId === "bruiser" ? 6 : 4;
}

export function makeTires(classId: VehicleClassId): TireState[] {
  const n = wheelCount(classId);
  return Array.from({ length: n }, () => ({
    compress: 0.14,
    compressVel: 0,
    lat: 0,
    long: 0,
    slip: 0,
    spin: 0,
    temp: TIRE_AMBIENT_C + 4, // grid-warmed slightly
  }));
}

/**
 * Wheel layout in vehicle space (matches meshes.tsx):
 * 4-wheel:  RF LF RR LR  with +X right, +Z forward
 * 6-wheel:  RF LF … 
 */
function wheelMeta(classId: VehicleClassId, i: number): {
  side: number;
  axle: number;
  isFront: boolean;
  isRear: boolean;
} {
  if (classId === "bruiser") {
    const side = i % 2 === 0 ? 1 : -1;
    const row = Math.floor(i / 2);
    const axle = row / 2;
    return { side, axle, isFront: row === 0, isRear: row === 2 };
  }
  const side = i % 2 === 0 ? 1 : -1;
  const isFront = i < 2;
  const isRear = i >= 2;
  return { side, axle: isFront ? 0 : 1, isFront, isRear };
}

export function stepTires(
  v: VehicleState,
  input: PlayerInput,
  opts: {
    dt: number;
    drifting: boolean;
    surfaceKind: SurfaceKind;
    surfaceFactor: number;
    roughness: number;
    speedRatio: number;
    grounded: boolean;
    landed: boolean;
    steer: number;
  },
): void {
  const { dt, drifting, surfaceFactor, roughness, speedRatio, grounded, landed, steer } = opts;
  const def = VEHICLE_CLASSES[v.classId];
  const compound = COMPOUND[v.classId];
  if (!v.tires || v.tires.length === 0) {
    v.tires = makeTires(v.classId);
  }

  // Backfill temp for any hot-reloaded / old state
  for (const t of v.tires) {
    if (t.temp === undefined || Number.isNaN(t.temp)) t.temp = TIRE_AMBIENT_C + 4;
  }

  const steerTarget = grounded ? steer * (0.55 + speedRatio * 0.15) : steer * 0.2;
  v.steerAngle += (steerTarget - v.steerAngle) * Math.min(1, 12 * dt);

  let longDemand = 0;
  if (input.brake) longDemand = -0.85 - (input.boost ? 0.1 : 0);
  else if (input.boost) longDemand = 0.75 + (1 - speedRatio) * 0.35;
  else longDemand = input.throttle * 0.45 * (1.1 - speedRatio * 0.4);

  const latSlip = v.lateral / Math.max(6, Math.abs(v.speed) + 3);
  const latDemand = THREE_CLAMP(latSlip * 0.55 + steer * speedRatio * 0.35, -1.4, 1.4);

  const soft = surfaceFactor;
  const baseLoad = 0.14 + def.mass * 0.07;
  const speedLoad = speedRatio * 0.08;
  const brakeDive = input.brake ? 0.38 * speedRatio : 0;
  const accelSquat =
    !input.brake && (input.throttle > 0.2 || input.boost)
      ? (0.22 + (input.boost ? 0.18 : 0)) * (0.4 + (1 - speedRatio) * 0.6)
      : 0;
  const bump =
    grounded && roughness > 0.1
      ? roughness * speedRatio * (0.25 + soft * 0.35)
      : 0;
  const landSpike = landed ? 0.55 + speedRatio * 0.25 : 0;
  const airUnload = grounded ? 0 : -0.85;

  const slipMag = Math.min(
    1.5,
    Math.abs(latSlip) * (drifting ? 1.35 : 1) + Math.abs(longDemand) * (drifting ? 0.5 : 0.25),
  );

  // Surface ambient offset — asphalt radiates heat, deep sand is cooler grit
  const surfaceAmbient =
    opts.surfaceKind === "asphalt"
      ? TIRE_AMBIENT_C + 6
      : opts.surfaceKind === "apron"
        ? TIRE_AMBIENT_C + 2
        : opts.surfaceKind === "sand"
          ? TIRE_AMBIENT_C - 2
          : TIRE_AMBIENT_C - 6;

  let sumCompress = 0;
  let sumSlip = 0;
  let sumTemp = 0;

  for (let i = 0; i < v.tires.length; i++) {
    const t = v.tires[i];
    const meta = wheelMeta(v.classId, i);

    // ── Load / deformation ──────────────────────────────────────────
    let load = baseLoad + speedLoad + bump * (0.7 + pseudo(v, i) * 0.6);
    load += landSpike * (meta.isFront ? 0.55 : 0.35);
    load += airUnload;

    if (meta.isFront) load += brakeDive - accelSquat * 0.35;
    if (meta.isRear) load += accelSquat - brakeDive * 0.4;
    if (!meta.isFront && !meta.isRear) {
      load += accelSquat * 0.35 + brakeDive * 0.15;
    }

    const corner = speedRatio * Math.abs(steer) * 0.32 + Math.abs(latDemand) * 0.22;
    if (steer > 0.05) {
      load += meta.side * corner * 0.5;
    } else if (steer < -0.05) {
      load += -meta.side * corner * 0.5;
    }

    load *= 1 + soft * 0.55;
    // Hot rubber is softer → accepts more compression
    const tempSoft = THREE_CLAMP((t.temp - TIRE_TEMP.warm) / 80, 0, 1) * 0.12;
    load *= 1 + tempSoft;
    load = THREE_CLAMP(load, 0.02, 1.15);

    // ── Spring-damper suspension ────────────────────────────────────
    // Rest under static weight ~0.16; load maps to equilibrium travel.
    // F = k*(target - x) - c*v  integrated as 2nd-order on compress.
    if (t.compressVel === undefined || Number.isNaN(t.compressVel)) {
      t.compressVel = 0;
    }
    const rest = 0.12;
    const targetCompress = THREE_CLAMP(rest + load * 0.72, 0.02, 1.0);
    // Class spring rates — bruiser stiffer, trickster softer
    const springK =
      v.classId === "bruiser" ? 42 : v.classId === "trickster" ? 26 : 34;
    const damperC =
      v.classId === "bruiser" ? 7.5 : v.classId === "trickster" ? 4.2 : 5.6;
    // Harder damper on landing spike
    const c = damperC * (landed ? 1.8 : 1) * (grounded ? 1 : 0.35);
    const k = springK * (grounded ? 1 : 0.2);
    const err = targetCompress - t.compress;
    t.compressVel += (err * k - t.compressVel * c) * dt;
    // Clamp velocity so fixed-step stays stable
    t.compressVel = THREE_CLAMP(t.compressVel, -6, 6);
    t.compress += t.compressVel * dt;
    t.compress = THREE_CLAMP(t.compress, 0, 1);
    // Soft bump stop near full compression
    if (t.compress > 0.92 && t.compressVel > 0) {
      t.compressVel *= 0.35;
    }

    const latTarget = THREE_CLAMP(
      -latDemand * (meta.isFront ? 0.85 : 1.1) * (0.55 + t.compress * 0.6) * (1 + soft * 0.4),
      -1,
      1,
    );
    t.lat += (latTarget - t.lat) * Math.min(1, 10 * dt);

    const longBias = meta.isRear ? 1.15 : meta.isFront ? 0.75 : 1;
    const longTarget = THREE_CLAMP(longDemand * longBias * (0.5 + t.compress * 0.5), -1, 1);
    t.long += (longTarget - t.long) * Math.min(1, 11 * dt);

    t.slip +=
      (THREE_CLAMP(slipMag * (0.6 + Math.abs(t.lat) * 0.5 + Math.abs(t.long) * 0.35), 0, 1) -
        t.slip) *
      Math.min(1, 9 * dt);

    const radius = TIRE_RADIUS[v.classId];
    const freeSpin = v.speed / Math.max(0.2, radius);
    const slipSpin =
      longDemand > 0.4 && speedRatio < 0.35
        ? freeSpin * (1.4 + longDemand)
        : input.brake && Math.abs(v.speed) > 4
          ? freeSpin * (1 - Math.min(0.85, Math.abs(t.long) * 0.7))
          : freeSpin;
    const churn = 1 + surfaceFactor * 0.45 * (0.5 + Math.abs(longDemand));
    const spinTarget = slipSpin * churn * (grounded ? 1 : 0.15);
    t.spin += (spinTarget - t.spin) * Math.min(1, 8 * dt);

    // ── Temperature model (°C / s, then / thermal mass) ─────────────
    const speedAbs = Math.abs(v.speed);

    // Scrub work — dominant heat when sliding / drifting
    const workRate =
      t.slip *
      (0.5 + t.compress) *
      (6 + speedAbs * 0.55) *
      compound.slipHeat *
      (drifting ? 1.4 : 1) *
      (grounded ? 1 : 0.12);

    // Rolling resistance — slow warm-up while racing clean
    const rollRate = grounded
      ? t.compress * (1.8 + speedAbs * 0.09) * (0.85 + soft * 0.35)
      : 0;

    // Brake dump into fronts
    const brakeRate =
      input.brake && meta.isFront && grounded
        ? (8 + speedRatio * 22) * (0.85 + Math.abs(t.long) * 0.35)
        : 0;

    // Burnout / free-spin heat on driven axle
    const spinRate =
      meta.isRear && longDemand > 0.5 && speedRatio < 0.45 && grounded
        ? longDemand * 16 * compound.slipHeat
        : Math.abs(t.spin) > Math.abs(freeSpin) * 1.35
          ? 7 * compound.slipHeat
          : 0;

    // Offroad grit scrub
    const gritRate = soft > 0.2 && t.slip > 0.2 ? soft * t.slip * 10 : 0;

    const heatRate = workRate + rollRate + brakeRate + spinRate + gritRate;

    // Cooling: ambient + forced air (speed) + sand sink when not scrubbing
    const airflow = Math.pow(Math.max(0, speedAbs) * 0.035, 1.1); // ~0–3
    const coolK = (0.12 + airflow * 0.11) * compound.cool;
    const coolRate = (t.temp - surfaceAmbient) * coolK;
    const sandSink =
      soft > 0.25 && t.slip < 0.25 ? (t.temp - surfaceAmbient) * soft * 0.08 : 0;
    const soak = speedAbs < 2.5 ? (t.temp - surfaceAmbient) * 0.2 : 0;

    const dT = ((heatRate - coolRate - sandSink - soak) / compound.mass) * dt;
    t.temp = THREE_CLAMP(t.temp + dT, surfaceAmbient - 4, TIRE_TEMP.max);

    // Mild cross-axle bleed (left-right heat share)
    // applied after loop via second pass — skip for simplicity

    sumCompress += t.compress;
    sumSlip += t.slip;
    sumTemp += t.temp;
  }

  // Lateral heat bleed between paired wheels (keeps temps readable)
  for (let i = 0; i + 1 < v.tires.length; i += 2) {
    const a = v.tires[i];
    const b = v.tires[i + 1];
    const mid = (a.temp + b.temp) * 0.5;
    a.temp += (mid - a.temp) * Math.min(1, 0.8 * dt);
    b.temp += (mid - b.temp) * Math.min(1, 0.8 * dt);
  }

  const n = v.tires.length;
  v.tireLoad = sumCompress / n;
  v.tireSlip = sumSlip / n;
  v.tireTemp = sumTemp / n;
  v.tireTempBand = tireTempBand(v.tireTemp);
}

/**
 * Grip multiplier from temperature band (classic cold→peak→blister curve)
 * plus load/slip terms.
 */
export function tireGripMul(v: VehicleState): number {
  if (!v.tires || v.tires.length === 0) return 1;
  const load = v.tireLoad ?? 0.2;
  const slip = v.tireSlip ?? 0;
  const temp = v.tireTemp ?? TIRE_AMBIENT_C;
  const compound = COMPOUND[v.classId];

  const loadTerm = 0.92 + THREE_CLAMP(load, 0, 0.8) * 0.12;
  const slipTerm = 1 - THREE_CLAMP(slip - 0.35, 0, 1) * 0.18;
  const tempTerm = tempGripCurve(temp, compound);

  return THREE_CLAMP(loadTerm * slipTerm * tempTerm, 0.62, 1.14);
}

/** Peak around optimal window; cold and blistering both lose grip. */
export function tempGripCurve(
  tempC: number,
  compound: (typeof COMPOUND)[VehicleClassId] = COMPOUND.interceptor,
): number {
  const { cold, warm, optimalLo, optimalHi, hot, critical } = TIRE_TEMP;

  if (tempC < cold) {
    // Very cold glassiness
    const t = THREE_CLAMP((tempC - (cold - 25)) / 25, 0, 1);
    return 1 - compound.coldPenalty * (1 - t * 0.55);
  }
  if (tempC < warm) {
    const t = (tempC - cold) / (warm - cold);
    return 1 - compound.coldPenalty * 0.45 * (1 - t);
  }
  if (tempC <= optimalHi) {
    // Climb to peak then flat
    if (tempC < optimalLo) {
      const t = (tempC - warm) / (optimalLo - warm);
      return 1 + (compound.peakGrip - 1) * t;
    }
    return compound.peakGrip;
  }
  if (tempC < hot) {
    const t = (tempC - optimalHi) / (hot - optimalHi);
    return compound.peakGrip - (compound.peakGrip - 1) * t * 0.7;
  }
  if (tempC < critical) {
    const t = (tempC - hot) / (critical - hot);
    return 1 - compound.overheatPenalty * 0.45 * t;
  }
  // Blistering
  const t = THREE_CLAMP((tempC - critical) / (TIRE_TEMP.max - critical), 0, 1);
  return 1 - compound.overheatPenalty * (0.45 + t * 0.55);
}

/** Extra drag when tires are scrubbing / spinning. Hot tires smear more. */
export function tireScrubDrag(v: VehicleState): number {
  const slip = v.tireSlip ?? 0;
  const temp = v.tireTemp ?? TIRE_AMBIENT_C;
  const hotSmear = THREE_CLAMP((temp - TIRE_TEMP.hot) / 40, 0, 1) * 0.25;
  return slip * slip * (0.55 + hotSmear);
}

/** 0..1 normalized temp for bars / materials (ambient→max). */
export function tireTempNorm(tempC: number): number {
  return THREE_CLAMP((tempC - TIRE_AMBIENT_C) / (TIRE_TEMP.max - TIRE_AMBIENT_C), 0, 1);
}

/** RGB-ish heat color for tire rubber (dark → brown → red-orange). */
export function tireTempColor(tempC: number): { r: number; g: number; b: number; emissive: number } {
  const n = tireTempNorm(tempC);
  const band = tireTempBand(tempC);
  // base rubber
  let r = 0.08;
  let g = 0.07;
  let b = 0.06;
  let em = 0;
  if (band === "warm" || band === "optimal") {
    r = 0.1 + n * 0.12;
    g = 0.07 + n * 0.02;
    b = 0.05;
    em = n * 0.08;
  } else if (band === "hot") {
    r = 0.22 + n * 0.25;
    g = 0.06 + n * 0.04;
    b = 0.04;
    em = 0.15 + n * 0.25;
  } else if (band === "critical") {
    r = 0.45 + n * 0.35;
    g = 0.08 + n * 0.1;
    b = 0.03;
    em = 0.35 + n * 0.45;
  }
  return { r, g, b, emissive: em };
}

function THREE_CLAMP(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

function pseudo(v: VehicleState, i: number) {
  return (Math.sin(v.x * 1.7 + v.z * 1.3 + i * 2.1 + v.speed * 0.05) + 1) * 0.5;
}
