import type { VehicleClassDef, VehicleClassId } from "./types";

/**
 * Three mechanically distinct classes for televised Ash Spire heats.
 * Tuned for a real 0→100 pull (~10–11s pure throttle) and long top-end crawl.
 * HUD speed = gameSpeed * 4 → 100 mph ≈ 25 u/s.
 *
 * Every class's primary has a LOADED form: let the weapon charge meter fill and
 * the next shot with a lock on it comes out as ordnance instead (combat.ts,
 * LOADED_AT). That is the one mechanic the labels below have to teach, because
 * it is the only weapon in the game the player has to choose to wait for.
 *
 * ── WHAT EACH CLASS IS FOR ───────────────────────────────────────────
 *
 * A class is a real choice only if it wins somewhere the others do not. The
 * three roles, and the axis each one pays on:
 *
 *   Interceptor — SPEED AND REACH. Highest Vmax and acceleration, the longest
 *     primary, the fastest cadence. Wins on open circuits and from behind, by
 *     chipping a leader down over a straight it can close. Pays with the
 *     thinnest hull, the least mass (it loses every ram it is in) and the worst
 *     surface off the asphalt.
 *
 *   Bruiser — MASS AND ATTRITION. Half again the Interceptor's hull, twice its
 *     mass, and by far the best off-road. Wins in traffic, on rough circuits,
 *     and any time a race is decided by contact. Pays in the corners: the
 *     lowest Vmax AND the lowest cornering grip, because a hauler understeers.
 *
 *   Trickster — ROTATION AND DENIAL. The highest turn rate by a wide margin and
 *     the lowest breakaway threshold, so it changes direction where the others
 *     have to brake; mines and a decoy to shape the road behind it. Middling at
 *     everything it does not own.
 *
 * ── WHY `grip` AND `slideBias` ARE SEPARATE NUMBERS ──────────────────
 *
 * They used to be one, and the Bruiser proved they cannot be. `grip` is how
 * fast the car gets round; `slideBias` is how hard it is to unstick (see
 * VehicleClassDef.slideBias, DRIFT in balance.ts). The Bruiser wants a LOW
 * first and a HIGH second, which a single scalar cannot express — and while it
 * was one scalar the Bruiser held the best cornering grip in the game on top of
 * the most mass, the most hull and the best off-road, and the measured win rate
 * said exactly that (scripts/balance-classes.mjs).
 *
 * The products below reproduce the breakaway thresholds the drift model was
 * originally authored against — |steer| x speedRatio of 0.38 / 0.56 / 0.60 for
 * trickster / interceptor / bruiser — so the feel of a slide is unchanged while
 * the cornering pace is free to be balanced.
 *
 * ── HOW THE NUMBERS BELOW WERE ARRIVED AT ────────────────────────────
 *
 * Measured, not asserted. scripts/balance-classes.mjs races the three classes
 * against each other in the real sim across three circuits and both ends of the
 * aiSkill pace ladder, with grid slot, seed and driver profile controlled.
 *
 * 432 races per class, three seed bases (a perfect three-way is 33.3% / 2.000):
 *
 *                    before              after
 *   interceptor    47.2% / 1.69      34.5% / 1.98
 *   bruiser        51.4% / 1.54      34.5% / 1.92
 *   trickster       1.4% / 2.76      31.0% / 2.10
 *
 * The same matrix with the field's weapons COLD is the other half of the sheet,
 * and it is the one that says these are three different cars rather than three
 * spellings of the same car:
 *
 *   trickster      56.5%   bruiser  2.8%   interceptor 40.7%
 *
 * The Bruiser cannot win a race. It wins a fight, and the fight is worth
 * exactly its pace deficit — which is what "competitive" is supposed to mean.
 * Per circuit the same effect shows up as character: the Bruiser takes the
 * Cinder Bowl (40-56%), the Interceptor takes the Rustline and Ash Spire.
 *
 * Change a number here and re-run it. Seed-to-seed spread at 144 races is about
 * +/-5 points, so anything smaller than that is not a result.
 */
export const VEHICLE_CLASSES: Record<VehicleClassId, VehicleClassDef> = {
  interceptor: {
    id: "interceptor",
    name: "Interceptor",
    tagline: "Chase · Disable · Vanish",
    color: "#5eead4",
    accent: "#99f6e4",
    maxSpeed: 82,
    accel: 3.0,
    turnRate: 3.4,
    // Best cornering grip on asphalt — it is the one that has to be able to use
    // its Vmax. slideBias 1.0 keeps the original 0.56 breakaway threshold.
    grip: 0.9,
    slideBias: 1.0,
    mass: 0.74,
    health: 100,
    primaryCooldown: 0.2,
    primaryDamage: 12,
    primarySpeed: 110,
    // Longest reach in the game. Being able to open fire before anyone else can
    // answer is what the thin hull is buying.
    primaryRange: 70,
    defenseCooldown: 4.4,
    ultimateCost: 1,
    // Worst off the asphalt, so a Bruiser can take a line it cannot follow.
    offroadPenalty: 1.3,
    description:
      "Wasteland custom — long-nose thruster skiff. Soft-locks prey and shreds with pulse bolts. Charged, the deck rails put two guided micro-missiles into whatever it is holding.",
    primaryLabel: "Pulse Bolts · charged: Micro-Missiles",
    defenseLabel: "Phase Slip",
    ultimateLabel: "Overdrive Lock + Salvo",
  },
  bruiser: {
    id: "bruiser",
    name: "Bruiser",
    tagline: "Ram · Crush · Hold the line",
    color: "#f97316",
    accent: "#fdba74",
    maxSpeed: 67,
    accel: 2.4,
    turnRate: 2.62,
    /*
     * The lowest cornering grip in the game, and the highest breakaway
     * threshold. That pair is the whole class: it will not rotate, but it will
     * not let go either, so it holds a line through contact that would put an
     * Interceptor in the scenery.
     *
     * 0.96 grip here was the single biggest balance error in the sheet — the
     * heaviest, toughest, most off-road-capable car also cornered hardest, and
     * paid only in a top speed the field rarely reaches.
     */
    grip: 0.82,
    slideBias: 1.18,
    mass: 1.55,
    health: 148,
    // Slow, heavy, and it hurts: one hit is worth two Interceptor bolts. But
    // 42 DPS against the Interceptor's 60 and half the reach — the Bruiser is
    // not the damage class, it is the class that is still there at the flag.
    // Dropping this from 34 at 0.48s is what took its win rate from 51% to 35%.
    primaryCooldown: 0.62,
    primaryDamage: 26,
    primarySpeed: 78,
    primaryRange: 36,
    defenseCooldown: 5.4,
    ultimateCost: 1,
    // Barely notices sand. The Bruiser's answer to being slower on the road is
    // that it does not have to stay on it.
    offroadPenalty: 0.34,
    description:
      "Desert combat hauler. Scrap cannon, roof rack, unstoppable charge. Owns the dunes. Charged, the cannon loads a guided rocket.",
    primaryLabel: "Scrap Rockets · charged: Guided",
    defenseLabel: "Frontal Plate",
    ultimateLabel: "Rocket Salvo",
  },
  trickster: {
    id: "trickster",
    name: "Trickster",
    tagline: "Drift · Trap · Fake the line",
    color: "#38bdf8",
    accent: "#7dd3fc",
    maxSpeed: 79,
    accel: 3.02,
    // Highest turn rate by a wide margin — this is the number the class is
    // built on. It changes direction where the other two have to brake.
    turnRate: 4.0,
    /*
     * 0.62 was not a drift class, it was a 25%-slower car: measured, the
     * Trickster covered 4.61 laps to the Interceptor's 6.13 in the same window
     * and won 1.4% of races. The identity lived entirely in `grip` and so cost
     * pace everywhere, including the two thirds of a lap that are straight.
     *
     * The slide now lives in slideBias, which reproduces the same 0.38
     * breakaway threshold the drift model was authored against, and grip is
     * free to sit where a light widebody belongs — between the Interceptor and
     * the Bruiser.
     */
    grip: 0.88,
    slideBias: 0.7,
    mass: 0.95,
    health: 132,
    primaryCooldown: 0.28,
    primaryDamage: 16,
    primarySpeed: 82,
    primaryRange: 54,
    defenseCooldown: 5.6,
    ultimateCost: 1,
    offroadPenalty: 0.62,
    description:
      "Widebody hatch built for slide. Best mini-turbos, ricochet discs, decoys, and a tail rack of mines. Charged, the launcher throws a three-disc fan.",
    primaryLabel: "Ricochet Discs · charged: Fan",
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
