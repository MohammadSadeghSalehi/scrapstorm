/**
 * Announcer budget.
 *
 * The mixer has 25 recorded lines and the driver has roughly a dozen places
 * that want to fire one. Left to itself that produces a commentator who talks
 * over the entire race — which is what it did, and it is the reason this file
 * exists. The fix is deliberately NOT "delete lines": every line is still on
 * disk, still in `VoiceId`, still triggered from the same place. What changed is
 * that a trigger is now a *request* against a budget rather than a command.
 *
 * The model has four rules, in the order they are applied:
 *
 *   1. A rolling window. At most `maxPerWindow` non-critical lines in any
 *      `windowSeconds`. This is the headline number: turn it up and the
 *      announcer comes back.
 *   2. A rising priority floor. Every line already spoken inside the window
 *      raises the bar the next one has to clear by `floorPerRecent`. So the
 *      first thing that happens in a quiet minute is allowed to be small, and
 *      the fifth thing has to be the result of the race. This is what makes the
 *      budget feel like editing rather than like a mute button — the announcer
 *      still reacts, they just stop narrating.
 *   3. Race pressure. `setPressure` is fed the same heat number the music reads.
 *      When the fight is close everything is firing at once, so the floor is
 *      lifted further: the busier it gets, the more a line has to be worth.
 *      (The naive version does the opposite — more events, more lines — which is
 *      exactly when the player can least afford to be talked at.)
 *   4. Interruption is a privilege, not a ranking. A line below
 *      `interruptTier` NEVER cuts a line that is already sounding, even if it
 *      outranks it. The previous rule was a plain priority compare, so a
 *      takedown call could chop the final-lap call in half.
 *
 * Group cooldowns live here too, so the whole rate-limit policy is one file and
 * can be asserted headlessly (see scripts/probe-audio.mjs) rather than being
 * spread across the mixer.
 *
 * Nothing in here touches Web Audio, allocates per call, or knows what a
 * `VoiceId` is — it is a pure policy object taking a tier and a group name.
 */

/**
 * What a line is worth. The tier is the ONLY thing that decides whether a line
 * survives a busy race, so the assignment table (VOICE_TIER in AudioEngine) is
 * the real editorial decision and this is just its vocabulary.
 */
export const VO_TIER = {
  /** Colour with no information: rival chatter, "you're in a pack". */
  FLAVOUR: 0,
  /** Routine and repeatable: lap calls, taking a hit, lighting the boost. */
  COLOUR: 1,
  /** A change in the race that the player might have missed: places. */
  NOTABLE: 2,
  /** Something the player did: a takedown they caused, the grid locking in. */
  MAJOR: 3,
  /** Cannot be missed: green, final lap, your own wreck, the result. */
  CRITICAL: 4,
} as const;

export type VoTier = (typeof VO_TIER)[keyof typeof VO_TIER];

/**
 * The tuning constants. This is the dial the user asked for: raising
 * `maxPerWindow` to 12 and dropping `minGap` to 2 restores the previous,
 * continuously-talking mix without touching a single line, a trigger or a tier.
 *
 * The defaults are chosen so that a clean three-lap heat delivers roughly:
 * grid lock-in, green, one mid-race line if something real happened, the final
 * lap call, and the result. Five lines in about three minutes.
 */
export const VO_BUDGET = {
  /** Rolling window the budget is measured over. */
  windowSeconds: 60,
  /** Non-critical lines allowed inside that window. */
  maxPerWindow: 4,
  /** Floor between two lines of any tier below CRITICAL. */
  minGap: 6.5,
  /**
   * Floor between a CRITICAL line and whatever preceded it. Short on purpose:
   * "grid locked" into "green" is two seconds apart by design, and the whole
   * point of CRITICAL is that it is never the thing that gets dropped.
   */
  criticalMinGap: 1.1,
  /** How much each line already spoken in the window raises the bar. */
  floorPerRecent: 1,
  /**
   * How much a maximally busy race raises the bar, in tiers. 1.5 means a
   * flat-out pack fight silences everything below NOTABLE on its own.
   */
  pressureFloor: 1.5,
  /** Below this tier a line may never interrupt one that is already sounding. */
  interruptTier: VO_TIER.MAJOR as number,
} as const;

/**
 * Seconds before a group may speak again, on top of the window budget.
 *
 * These are much longer than they were. The cooldown is the defence against the
 * *same* line recurring — a taunt that fires every time contact is made stops
 * being characterisation within about fifteen seconds and turns into a
 * soundboard — while the budget above is the defence against the announcer
 * talking continuously in general. Both are needed: a 19 s rival cooldown does
 * nothing when six different groups each fire once inside it.
 */
export const VO_COOLDOWN: Record<string, number> = {
  hit: 26,
  boost: 40,
  lap: 30,
  overtake: 24,
  overtaken: 28,
  wreck: 6,
  "wreck-rival": 22,
  "close-pack": 75,
  "near-miss": 45,
  rival: 55,
};
export const VO_COOLDOWN_DEFAULT = 8;

/** Recent-line ring. Longer than maxPerWindow so a burst is still countable. */
const HISTORY = 12;

export class VoBudget {
  /** ctx-time of the last `HISTORY` accepted lines; -1e9 means empty. */
  private history = new Float32Array(HISTORY).fill(-1e9);
  private head = 0;
  private lastAt = -1e9;
  private cooldowns = new Map<string, number>();
  private pressure = 0;

  /**
   * 0..1 how much is going on. Same signal the music intensity reads, so the
   * two agree about when the race is busy. Plain field write — this is called
   * every frame and must not do work.
   */
  setPressure(x: number) {
    this.pressure = x < 0 ? 0 : x > 1 ? 1 : x;
  }

  /** New heat: forget the previous race's budget and cooldowns. */
  reset() {
    this.history.fill(-1e9);
    this.head = 0;
    this.lastAt = -1e9;
    this.cooldowns.clear();
  }

  /** Lines accepted inside the rolling window ending at `t`. */
  recentCount(t: number) {
    const cut = t - VO_BUDGET.windowSeconds;
    let n = 0;
    for (let i = 0; i < HISTORY; i++) {
      if (this.history[i]! >= cut) n += 1;
    }
    return n;
  }

  /** The minimum tier a line must reach right now to be worth saying. */
  floor(t: number) {
    const f =
      this.recentCount(t) * VO_BUDGET.floorPerRecent +
      this.pressure * VO_BUDGET.pressureFloor;
    return f > VO_TIER.CRITICAL ? VO_TIER.CRITICAL : f;
  }

  /**
   * Ask for the channel. Returns true and books the line, or false.
   *
   * `busyUntil` / `busyTier` describe the line currently sounding; pass
   * `busyUntil <= t` when nothing is.
   */
  request(
    t: number,
    tier: number,
    group: string,
    busyUntil: number,
    busyTier: number,
  ): boolean {
    const critical = tier >= VO_TIER.CRITICAL;

    // 1. Spacing. Two lines back to back read as one long line nobody parses.
    //    Checked first because it is two comparisons and rejects most requests:
    //    several triggers (pack pressure, rival taunts) fire on every frame they
    //    are true, so the cheap rejection has to come before the window scan.
    const gap = critical ? VO_BUDGET.criticalMinGap : VO_BUDGET.minGap;
    if (t - this.lastAt < gap) return false;

    // 2. Group cooldown — the defence against repetition rather than volume.
    if (t < (this.cooldowns.get(group) ?? -1e9)) return false;

    // 3. Window budget. Critical lines are exempt — the result of the race is
    //    not something to run out of allowance for.
    if (!critical && this.recentCount(t) >= VO_BUDGET.maxPerWindow) return false;

    // 4. Rising floor.
    if (!critical && tier < this.floor(t)) return false;

    // 5. Barge-in. Below `interruptTier` a line waits for silence or is lost;
    //    above it, it must still outrank what is speaking.
    if (t < busyUntil) {
      if (tier < VO_BUDGET.interruptTier) return false;
      if (tier <= busyTier) return false;
    }

    this.book(t, group);
    return true;
  }

  private book(t: number, group: string) {
    this.history[this.head] = t;
    this.head = (this.head + 1) % HISTORY;
    this.lastAt = t;
    this.cooldowns.set(
      group,
      t + (VO_COOLDOWN[group] ?? VO_COOLDOWN_DEFAULT),
    );
  }

  /**
   * Give back a booking that never became audio (missing mp3, or a fetch that
   * outlived the moment). Without this a 404 line would silently eat a slot out
   * of a budget of four, and the announcer would go quiet for a minute because
   * of a file that does not exist.
   */
  refund(t: number, group: string) {
    for (let i = 0; i < HISTORY; i++) {
      if (this.history[i] === t) {
        this.history[i] = -1e9;
        break;
      }
    }
    if (this.lastAt === t) this.lastAt = -1e9;
    this.cooldowns.delete(group);
  }
}
