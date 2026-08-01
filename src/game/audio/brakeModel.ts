/**
 * Brake voice.
 *
 * Braking previously had no sound of its own at all: the tyre bed added a flat
 * +0.07 to its scrub gain while the brake key was down and that was the whole
 * model. That is the wrong shape twice over — it is a boolean, so a feathered
 * brake and a panic stop are identical, and it is a *tyre* sound, so the pads
 * and the weight transfer (the two things the driver is actually listening for)
 * are missing.
 *
 * Four continuous layers plus two events, all driven by physics the sim already
 * produces:
 *
 *   pad squeal  — a friction-induced resonance of the pad/rotor assembly. This
 *                 is a fixed mechanical mode, so its frequency does NOT track
 *                 road speed; a squeal that sweeps with the car reads as a
 *                 siren. It drifts a little with pressure (pad stiffening) and
 *                 that is all.
 *   rotor/dive  — low band that follows *deceleration*, not pedal. This is the
 *                 weight-transfer layer: the mass moving forward onto the front
 *                 axle. It is what makes a hard stop feel heavy, and it is
 *                 keyed off the result of braking rather than the request, so
 *                 stamping the pedal at 5 km/h produces nothing.
 *   scrub       — longitudinal tyre scrub. Distinct from the cornering scrub in
 *                 tyreModel: that one tracks slip angle, this one tracks
 *                 how much the contact patch is being dragged along its axis.
 *   ABS judder  — an LFO summed into the level, engaged by `lock`. Real ABS
 *                 modulates brake pressure at ~10–16 Hz, and that stutter is
 *                 the single clearest signal a player has that they have asked
 *                 for more than the tyres can give.
 *
 * Events: a dive thump when the brakes are first loaded hard, and a release —
 * the caliper unloading and the pads backing off. The release matters more than
 * it sounds like it should: without it the bed simply stops, and stopping is
 * the one thing a physical object never does.
 *
 * Cost: the bed is a permanent graph whose params move, and it writes NOTHING
 * while the car is not braking (see `idle`) — which is most of the race. The two
 * events create three short-lived nodes each and are rate-limited.
 *
 * Why squeal is loudest slow: a naive `level = pressure × speed` puts maximum
 * squeal at 90 m/s, where in reality wind and tyre noise bury it, and takes it
 * to zero at a standstill, which is the exact moment everyone has actually
 * heard brakes squeal. The `speedWeight` curve below peaks low and rolls off.
 */

import { noiseOffset, sharedNoise } from "./noise";

export interface BrakeInput {
  /** 0..1 pedal demand. */
  pressure: number;
  /** 0..1 normalised deceleration actually being achieved. */
  decel: number;
  /** 0..1 road speed against the class maximum. */
  speed01: number;
  /** 0..1 how close the tyres are to locking; drives the ABS judder. */
  lock: number;
  /** `SurfaceInfo.roughness`. Pads do not sing on sand — the tyre ploughs. */
  roughness: number;
  dt: number;
}

/** Rotor mode, in Hz. Two partials an inharmonic ratio apart so it is metal. */
const SQUEAL_HZ = 1780;
const SQUEAL_PARTIAL = 2.63;

export class BrakeBed {
  private ctx: BaseAudioContext;
  private level: GainNode;
  private squealOsc: OscillatorNode;
  private squealBp: BiquadFilterNode;
  private squealPk: BiquadFilterNode;
  private gSqueal: GainNode;
  private rotorLp: BiquadFilterNode;
  private gRotor: GainNode;
  private scrubBp: BiquadFilterNode;
  private gScrub: GainNode;
  private absLfo: OscillatorNode;
  private absDepth: GainNode;

  /** Slewed in JS: attack fast (pads bite), release slower (heat and ring). */
  private amp = 0;
  /** True once the bed has been written all the way down; see ScrapeBed. */
  private idle = true;
  /** Peak pressure reached during the current application, for the release. */
  private held = 0;
  private lastDive = -1e9;
  private lastRelease = -1e9;

  constructor(ctx: BaseAudioContext, dests: AudioNode[]) {
    this.ctx = ctx;
    const noise = sharedNoise(ctx);
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;

    this.level = ctx.createGain();
    this.level.gain.value = 0;
    for (const d of dests) this.level.connect(d);

    // --- pad squeal ---------------------------------------------------------
    // A sawtooth through a high-Q bandpass rather than a sine: the squeal is a
    // stick-slip oscillation, so it is rich in harmonics, and a pure tone reads
    // as a test signal every time.
    this.squealOsc = ctx.createOscillator();
    this.squealOsc.type = "sawtooth";
    this.squealOsc.frequency.value = SQUEAL_HZ;
    this.squealBp = ctx.createBiquadFilter();
    this.squealBp.type = "bandpass";
    this.squealBp.frequency.value = SQUEAL_HZ;
    this.squealBp.Q.value = 11;
    // Second, inharmonic partial. A rotor is a disc, not a string — its modes
    // are not integer multiples, and that is most of why brakes sound like
    // brakes rather than like a violin.
    this.squealPk = ctx.createBiquadFilter();
    this.squealPk.type = "peaking";
    this.squealPk.frequency.value = SQUEAL_HZ * SQUEAL_PARTIAL;
    this.squealPk.Q.value = 14;
    this.squealPk.gain.value = 0;
    this.gSqueal = ctx.createGain();
    this.gSqueal.gain.value = 0;
    this.squealOsc.connect(this.squealBp);
    this.squealBp.connect(this.squealPk);
    this.squealPk.connect(this.gSqueal);
    this.gSqueal.connect(this.level);

    // --- rotor / weight transfer -------------------------------------------
    this.rotorLp = ctx.createBiquadFilter();
    this.rotorLp.type = "lowpass";
    this.rotorLp.frequency.value = 210;
    this.rotorLp.Q.value = 1.4;
    this.gRotor = ctx.createGain();
    this.gRotor.gain.value = 0;
    src.connect(this.rotorLp);
    this.rotorLp.connect(this.gRotor);
    this.gRotor.connect(this.level);

    // --- longitudinal scrub -------------------------------------------------
    this.scrubBp = ctx.createBiquadFilter();
    this.scrubBp.type = "bandpass";
    this.scrubBp.frequency.value = 780;
    this.scrubBp.Q.value = 0.6;
    this.gScrub = ctx.createGain();
    this.gScrub.gain.value = 0;
    src.connect(this.scrubBp);
    this.scrubBp.connect(this.gScrub);
    this.gScrub.connect(this.level);

    // --- ABS judder ---------------------------------------------------------
    // Summed into `level.gain` exactly like the scrape bed's stick-slip, so the
    // whole brake voice pulses rather than one layer of it. Triangle, not
    // square: real modulation has a rise and fall, and a square edge at 13 Hz
    // puts a click in the bed on every cycle.
    this.absLfo = ctx.createOscillator();
    this.absLfo.type = "triangle";
    this.absLfo.frequency.value = 13;
    this.absDepth = ctx.createGain();
    this.absDepth.gain.value = 0;
    this.absLfo.connect(this.absDepth);
    this.absDepth.connect(this.level.gain);

    src.start();
    this.squealOsc.start();
    this.absLfo.start();
  }

  update(t: number, s: BrakeInput) {
    // Fast path. The car is not braking on the large majority of frames, and
    // this is called from the render loop on a main thread that is already the
    // bottleneck — the idle case has to cost three comparisons, not a full
    // envelope pass followed by a bail-out.
    if (this.idle && this.held === 0 && s.pressure < 0.002 && this.amp < 0.002) {
      return;
    }
    const pressure = clamp01(s.pressure);
    const decel = clamp01(s.decel);
    const sp = clamp01(s.speed01);
    const lock = clamp01(s.lock);

    // Demand is the pedal *and* the result. Braking that is not slowing the car
    // (already stopped, or airborne) has no business making a sound.
    const demand = pressure * (0.35 + decel * 0.65);
    const rate = demand > this.amp ? Math.min(1, s.dt * 30) : Math.min(1, s.dt * 9);
    this.amp += (demand - this.amp) * rate;
    const a = this.amp;

    // Release event, taken on the way down and before the idle bail-out so a
    // brake that goes straight to zero still gets one.
    if (this.held > 0.3 && pressure < 0.08 && t - this.lastRelease > 0.5) {
      this.lastRelease = t;
      this.release(t, this.held);
      this.held = 0;
    }
    if (pressure > this.held) this.held = pressure;
    if (pressure < 0.08) this.held = 0;

    if (a < 0.002) {
      if (!this.idle) {
        this.idle = true;
        this.level.gain.setTargetAtTime(0, t, 0.07);
        this.gSqueal.gain.setTargetAtTime(0, t, 0.06);
        this.gRotor.gain.setTargetAtTime(0, t, 0.08);
        this.gScrub.gain.setTargetAtTime(0, t, 0.07);
        this.absDepth.gain.setTargetAtTime(0, t, 0.06);
      }
      return;
    }
    this.idle = false;

    // Dive thump: the first hard bite of an application, once per application.
    if (
      pressure > 0.55 &&
      sp > 0.18 &&
      t - this.lastDive > 0.9 &&
      this.amp < 0.55
    ) {
      this.lastDive = t;
      this.dive(t, Math.min(1, sp * 0.7 + decel * 0.6));
    }

    // Squeal weight: peaks at low-to-moderate speed, gone at a crawl (no
    // relative motion to excite the mode) and rolled off flat out. Masked on
    // loose surfaces, where the tyre ploughs before the pad ever gets to sing.
    const speedWeight = Math.min(1, sp * 6) * (1 - Math.min(0.72, sp * 0.85));
    const hard = Math.max(0, 1 - s.roughness * 1.5);
    const squeal = a * a * speedWeight * hard;
    // Frequency drifts *up* with pressure: more clamping force stiffens the
    // coupling. A few per cent, not an octave — this is a rotor, not a filter
    // sweep, and anything larger immediately sounds like an effect.
    this.squealOsc.frequency.setTargetAtTime(
      SQUEAL_HZ * (0.94 + a * 0.13),
      t,
      0.07,
    );
    this.squealBp.frequency.setTargetAtTime(
      SQUEAL_HZ * (0.94 + a * 0.13),
      t,
      0.07,
    );
    // The upper partial only comes in when the pads are really loaded, so a
    // gentle brake is a hum and a hard one is a scream.
    this.squealPk.gain.setTargetAtTime(squeal * 16, t, 0.08);
    this.gSqueal.gain.setTargetAtTime(squeal * 0.075, t, 0.05);

    // Rotor / dive band follows decel, and its cutoff opens with load so a hard
    // stop is not merely louder than a soft one.
    this.rotorLp.frequency.setTargetAtTime(160 + decel * 220, t, 0.08);
    this.gRotor.gain.setTargetAtTime(a * (0.03 + decel * 0.14), t, 0.06);

    // Longitudinal scrub: this is the tyre, so unlike the pads it *does* track
    // speed, and it survives on loose surfaces where the squeal does not.
    this.scrubBp.frequency.setTargetAtTime(
      560 + sp * 620 - s.roughness * 260,
      t,
      0.08,
    );
    this.gScrub.gain.setTargetAtTime(
      a * sp * (0.05 + lock * 0.11) + s.roughness * a * sp * 0.05,
      t,
      0.05,
    );

    // Judder rate rises slightly with speed (the wheel-speed sensors cycle
    // faster) and its depth is the whole point of the layer.
    this.absLfo.frequency.setTargetAtTime(10.5 + sp * 5.5, t, 0.1);
    this.absDepth.gain.setTargetAtTime(lock * lock * a * 0.09, t, 0.05);

    this.level.gain.setTargetAtTime(a * (0.5 + decel * 0.5), t, 0.03);
  }

  silence(t: number) {
    this.amp = 0;
    this.held = 0;
    if (this.idle) return;
    this.idle = true;
    this.level.gain.setTargetAtTime(0, t, 0.06);
    this.gSqueal.gain.setTargetAtTime(0, t, 0.05);
    this.gRotor.gain.setTargetAtTime(0, t, 0.06);
    this.gScrub.gain.setTargetAtTime(0, t, 0.06);
    this.absDepth.gain.setTargetAtTime(0, t, 0.05);
  }

  /** Suspension loading up: a short low thump, no attack transient. */
  private dive(t: number, force: number) {
    const ctx = this.ctx;
    const buf = sharedNoise(ctx);
    const dur = 0.16 + force * 0.1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(320, t);
    lp.frequency.exponentialRampToValueAtTime(95, t + dur);
    lp.Q.value = 1.6;
    const g = ctx.createGain();
    const peak = 0.05 + force * 0.07;
    // Rises rather than clicks: the mass takes ~40 ms to transfer, and a hard
    // attack here reads as an impact instead of as weight moving.
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.045);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp);
    lp.connect(g);
    g.connect(this.level);
    src.onended = () => {
      try {
        g.disconnect();
      } catch {
        /* already torn down */
      }
    };
    src.start(t, noiseOffset(buf, dur));
    src.stop(t + dur + 0.02);
  }

  /** Pads backing off: a short bright hiss that falls as the caliper unloads. */
  private release(t: number, force: number) {
    const ctx = this.ctx;
    const buf = sharedNoise(ctx);
    const dur = 0.1 + force * 0.09;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(2400 + force * 1200, t);
    bp.frequency.exponentialRampToValueAtTime(900, t + dur);
    bp.Q.value = 2.2;
    const g = ctx.createGain();
    const peak = 0.018 + force * 0.03;
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.level);
    src.onended = () => {
      try {
        g.disconnect();
      } catch {
        /* already torn down */
      }
    };
    src.start(t, noiseOffset(buf, dur));
    src.stop(t + dur + 0.02);
  }
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
