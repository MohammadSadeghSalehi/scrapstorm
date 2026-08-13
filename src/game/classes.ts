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
 * ── READ THE SAMPLE SIZE BEFORE YOU READ THE TABLE ───────────────────
 *
 * Exactly one class wins each race, so under perfect balance the reported
 * max-minus-min win rate is the range of three multinomial proportions — a
 * strictly positive statistic whose floor is set by the sample. At 72 races,
 * which was this script's default, a FLAWLESS three-way reports a median of
 * 11.1 points and clears a "spread <= 6" bar only 19.5% of the time. Two
 * readings of 4.2 and 11.1 taken at that sample size were once recorded as a
 * balance regression caused by the terrain rework; they were two draws from the
 * same distribution and nothing had moved. The default is now 1152 races, where
 * the null median is 2.7 and p95 is 5.6, and the script prints that band next
 * to the result. Never quote a spread without it.
 *
 * ── the sheet, at 2304 races per configuration (two seed bases) ──────
 *
 * A perfect three-way is 33.3% / 2.000.
 *
 *                 first pass      after the terrain rework      now
 *   interceptor  47.2% / 1.69          32.4% / 2.01         34.8% / 1.98
 *   bruiser      51.4% / 1.54          31.4% / 2.00         33.0% / 1.99
 *   trickster     1.4% / 2.76          36.3% / 1.95         32.3% / 2.04
 *                spread 50.0           spread 4.9           spread 2.6
 *
 * The middle column is the terrain rework measured properly: six circuits with
 * six landforms left the classes at 4.9 points, already inside budget. The only
 * thing that moved between it and the right-hand column is the Trickster's two
 * straight-line numbers — see the note on its maxSpeed.
 *
 * The same matrix with the field's weapons COLD is the other half of the sheet,
 * and it is the one that says these are three different cars rather than three
 * spellings of the same car:
 *
 *   trickster      56.5%   bruiser  2.8%   interceptor 40.7%
 *
 * The Bruiser cannot win a race. It wins a fight, and the fight is worth
 * exactly its pace deficit — which is what "competitive" is supposed to mean.
 * Per circuit the same effect shows up as character, and the rework moved WHICH
 * circuit belongs to whom rather than flattening them: the Interceptor now owns
 * Ash Spire (40%) where the Bruiser is worst (23%), the Bruiser owns the
 * Rustline (40%), and the Cinder Bowl is the one nobody owns.
 *
 * Change a number here and re-run it at the default sample size. A 2% grip
 * change re-rolls every collision downstream of the first corner, so a result
 * inside the printed null band is not a result.
 *
 * ── THE TOP-SPEED SPREAD IS LOAD-BEARING. DO NOT CLOSE IT ────────────
 *
 * 82 / 78 / 67 looks unfair on paper and reads as unfair to a player watching a
 * Bruiser lose a straight, so it has been attempted. Measured, at 1152 races a
 * step, with the Bruiser's other numbers trimmed to pay for it each time:
 *
 *   maxSpeed 67, as authored                          33.0%   spread  2.6
 *   74 / accel 2.68, hull 200, damage 30              48.2%   spread 22.5
 *   72 / accel 2.58, offroadPenalty 0.34 -> 0.75      46.8%   spread 23.2
 *   69 / accel 2.48, offroadPenalty 0.45, hull 210    43.0%   spread 16.6
 *
 * Roughly five points of win rate per metre per second, and trimming hull,
 * damage and off-road impunity together did not buy back even the first two.
 *
 * The reason is in the `mean-speed` column rather than the win rate: at 67 the
 * Bruiser is ALREADY the fastest car on track over a race distance. Its Vmax is
 * not what limits it and never was — mass, hull, line-holding and (before this
 * was measured) near-total off-road impunity make it quicker between two points
 * than either rival, and the top-end deficit is the toll being charged for
 * that. Refunding the toll while leaving the goods is how the class ends up
 * winning half of everything.
 *
 * If the felt gap has to be addressed, it is a PRESENTATION problem — gearing,
 * engine note, camera FOV at speed, what the speedometer reads — not this
 * number. Changing it here has been tried three ways and costs the game its
 * balance every time.
 *
 * ── DURABILITY: HULL x1.22, DAMAGE x1.12 ─────────────────────────────
 *
 * 145/215/192 -> 177/262/234 and 16/34/21 -> 18/38/24. Cars were still being
 * cooked faster than a player can learn a circuit, so every fight is now about
 * 9% longer end to end.
 *
 * Both columns move, and by the SAME ratio within each column, which is the
 * only reason this is safe to do without a re-tune: balance here is a function
 * of the ratios between the classes, and scaling a column uniformly leaves
 * every one of them untouched. Raising hull ALONE is not neutral and has the
 * receipts to prove it — +45% hull on its own once took the Bruiser from 34.5%
 * to 13% and blew the spread to 23.6, because a longer fight is worth less than
 * a faster lap and the class that wins by fighting pays for the difference.
 * Damage rises alongside it at a slightly lower rate so the net is more
 * tolerance rather than a different game.
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
    /*
     * Raised from 100. The opening laps were cooking cars before the field had
     * spread out — four entrants trading paint in a bunched pack is the most
     * contact-dense part of any race, and a hull tuned for a settled midfield
     * cannot survive it. Ratios between the classes are preserved, so nothing
     * in the balance sweep moves; everything simply lasts longer.
     */
    health: 177,
    primaryCooldown: 0.2,
    /*
     * Damage rises WITH hull, but not as fast.
     *
     * A blanket hull raise is not neutral: it lengthens every fight, and a
     * longer fight is worth less than a faster lap. Measured, +45% hull alone
     * took the bruiser — the class that wins by fighting — from 34.5% to 13% on
     * Ash Spire and blew the three-way spread out to 23.6 points.
     *
     * Scaling damage by +30% against hull's +45% leaves net time-to-kill about
     * 12% longer, which is the durability that was asked for, without quietly
     * converting the game into a pure pace contest.
     */
    primaryDamage: 18,
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
    health: 262,
    // Slow, heavy, and it hurts: one hit is worth two Interceptor bolts. But
    // 42 DPS against the Interceptor's 60 and half the reach — the Bruiser is
    // not the damage class, it is the class that is still there at the flag.
    // Dropping this from 34 at 0.48s is what took its win rate from 51% to 35%.
    primaryCooldown: 0.62,
    primaryDamage: 38,
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
    /*
     * Below the Interceptor on BOTH straight-line numbers, which it was not.
     *
     * `accel` was 3.02 against the Interceptor's 3.00 and `maxSpeed` 79 against
     * 82 — so the class described above as "middling at everything it does not
     * own" was in fact the joint-quickest car off a corner and within 4% on top
     * end, on top of owning rotation outright. Measured against the new
     * terrain (2304 races, eight seed bases) that showed up as
     * 32.4 / 31.4 / 36.3, with the Trickster also holding the fastest mean best
     * lap in the game (14.9s against 15.3 and 16.7).
     *
     * The trim is straight-line only. Taking rotation instead would have closed
     * the same gap and deleted the class.
     */
    maxSpeed: 75,
    accel: 2.94,
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
    health: 234,
    primaryCooldown: 0.28,
    primaryDamage: 24,
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
