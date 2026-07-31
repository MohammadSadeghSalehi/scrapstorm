import type { VehicleClassDef, VehicleClassId } from "./types";

/**
 * Three mechanically distinct classes for televised Ash Spire heats.
 * Tuned for a real 0→100 pull (~10–11s pure throttle) and long top-end crawl.
 * HUD speed = gameSpeed * 4 → 100 mph ≈ 25 u/s.
 */
export const VEHICLE_CLASSES: Record<VehicleClassId, VehicleClassDef> = {
  interceptor: {
    id: "interceptor",
    name: "Interceptor",
    tagline: "Chase · Disable · Vanish",
    color: "#5eead4",
    accent: "#99f6e4",
    maxSpeed: 80,
    accel: 2.95,
    turnRate: 3.45,
    grip: 0.88,
    mass: 0.78,
    health: 92,
    primaryCooldown: 0.22,
    primaryDamage: 12,
    primarySpeed: 110,
    primaryRange: 64,
    defenseCooldown: 4.8,
    ultimateCost: 1,
    offroadPenalty: 1.15,
    description:
      "Wasteland custom — long-nose thruster skiff. Soft-locks prey and shreds with pulse bolts.",
    primaryLabel: "Pulse Bolts",
    defenseLabel: "Phase Slip",
    ultimateLabel: "Overdrive Lock",
  },
  bruiser: {
    id: "bruiser",
    name: "Bruiser",
    tagline: "Ram · Crush · Hold the line",
    color: "#f97316",
    accent: "#fdba74",
    maxSpeed: 68,
    accel: 2.35,
    turnRate: 2.62,
    grip: 0.96,
    mass: 1.55,
    health: 168,
    primaryCooldown: 0.48,
    primaryDamage: 28,
    primarySpeed: 78,
    primaryRange: 34,
    defenseCooldown: 5.8,
    ultimateCost: 1,
    offroadPenalty: 0.4,
    description:
      "Desert combat hauler. Scrap cannon and unstoppable charge. Owns the dunes.",
    primaryLabel: "Scrap Cannon",
    defenseLabel: "Frontal Plate",
    ultimateLabel: "Iron Charge",
  },
  trickster: {
    id: "trickster",
    name: "Trickster",
    tagline: "Drift · Trap · Fake the line",
    color: "#38bdf8",
    accent: "#7dd3fc",
    maxSpeed: 74,
    accel: 2.7,
    turnRate: 3.85,
    grip: 0.62,
    mass: 0.88,
    health: 105,
    primaryCooldown: 0.32,
    primaryDamage: 14,
    primarySpeed: 74,
    primaryRange: 48,
    defenseCooldown: 6.6,
    ultimateCost: 1,
    offroadPenalty: 0.88,
    description:
      "Widebody hatch built for slide. Best mini-turbos, ricochet discs, decoys, mines.",
    primaryLabel: "Ricochet Discs",
    defenseLabel: "Holo Decoy",
    ultimateLabel: "False Road Mines",
  },
};

export const CLASS_ORDER: VehicleClassId[] = ["interceptor", "bruiser", "trickster"];

/** Anonymous pack fillers for a free-play heat. */
const HOUSE_NAMES = [
  "Rust Viper",
  "Ash Coil",
  "Null Spire",
  "Grind Petal",
  "Cinder Hook",
  "Volt Rake",
  "Sand Widow",
  "Chrome Jackal",
];

/**
 * The grid's names, read by sim.buildField as `BOT_NAMES[i % length]`.
 *
 * Deliberately a mutable array rather than a frozen constant: it is the seam
 * that lets a mission put NAMED rivals on the grid without sim.ts having to
 * know missions exist. setFieldRoster rewrites it in place — in place, because
 * reassigning the binding would not be seen through sim's `import { BOT_NAMES }`
 * under a CJS transpile, which is the same live-binding trap documented in
 * track.ts.
 *
 * Timing matters: buildField reads this when the grid is constructed, i.e.
 * inside startCountdown. Set the roster BEFORE calling setPhase("countdown") or
 * you will name the previous race.
 */
export const BOT_NAMES: string[] = [...HOUSE_NAMES];

/** One grid slot's identity. Slot i becomes vehicle `bot-${i}`. */
export interface FieldSlot {
  name: string;
  /**
   * Preferred class. NOT honoured yet — buildField still assigns classes by
   * rotating CLASS_ORDER (see report: two lines in sim.ts). Carried here so the
   * mission data is already correct when that lands.
   */
  classId?: VehicleClassId;
  /** Livery. Same story as classId — buildField currently uses the class colour. */
  color?: string;
  /** Blacklist rival this slot is playing, for takedown attribution. */
  rivalId?: string;
}

let fieldRoster: FieldSlot[] = [];

export function setFieldRoster(slots: FieldSlot[]): void {
  fieldRoster = slots.slice();
  const names = slots.length ? slots.map((s) => s.name) : HOUSE_NAMES;
  BOT_NAMES.splice(0, BOT_NAMES.length, ...names);
}

export function getFieldRoster(): readonly FieldSlot[] {
  return fieldRoster;
}

/** Free play must not inherit the last mission's grid. */
export function resetFieldRoster(): void {
  fieldRoster = [];
  BOT_NAMES.splice(0, BOT_NAMES.length, ...HOUSE_NAMES);
}

/** Grid slot index (0-based) for a vehicle id, or -1. Mirrors sim.buildField. */
export function slotOfVehicle(vehicleId: string): number {
  const m = /^bot-(\d+)$/.exec(vehicleId);
  return m ? Number(m[1]) : -1;
}
