/**
 * Tyre / road contact bed.
 *
 * Driven by the same surface classification physics uses — `getSurfaceAt`
 * returns a continuous `roughness` (0.08 asphalt → 0.95 deep sand), so the
 * layers interpolate along it rather than switching on the discrete kind. That
 * matters at the tarmac edge, where the old two-way filter switch stepped
 * audibly on a boundary the car straddles for whole corners.
 *
 * Layers, because one filtered noise band cannot be both a tyre and a surface:
 *   roll   — contact band, centre frequency falls as the surface coarsens
 *   tread  — narrow resonance that tracks road speed; only on hard surfaces.
 *            This is the tyre whine, and it is the layer that reads as "tarmac"
 *   grain  — loose grit spray, sand and deep only
 *   rumble — low-frequency body shake from a coarse surface
 *   scrub  — the contact patch being dragged sideways
 *   squeal — stick-slip of rubber that still has grip to lose
 *   tear   — rubber actually being shed. Only at big angles under load.
 *
 * ── the drift voice ──────────────────────────────────────────────────────
 *
 * A slide is a STATE with a duration the player is steering with, so the scrub
 * and squeal layers are driven by a continuous slide envelope rather than by
 * the `drifting` boolean. That distinction is the whole difference between a
 * drift that sounds like a drift and one that sounds like a sample being
 * triggered:
 *
 *   - `slipAngle` (how far sideways the car is actually travelling) sets the
 *     squeal pitch and the scrub bandwidth. Stick-slip frequency rises with
 *     sliding velocity, so a bigger angle is a higher, harder squeal — the
 *     opposite of the brake pads, whose frequency is a fixed rotor mode.
 *   - `load` sets how much of it there is. A slide on an unloaded inside wheel
 *     is quiet; the same angle with weight on it is the loud one.
 *   - The envelope attacks in ~120 ms and releases over ~450 ms. The release is
 *     the important half: a slide ends when the tyres re-grip, and rubber that
 *     has just been sliding does not go silent, it winds down. Cutting the
 *     layer with the flag is what made the previous version announce every
 *     drift twice (once with a one-shot squeal sample, once by switching the
 *     bed on) and end it with a hole.
 *
 * The one-shot at the front is a genuine event — the break-away, the moment the
 * contact patch lets go — and it is generated here rather than played from
 * `drift_squeal.mp3` so it varies and so it starts at the same instant as the
 * bed it belongs to.
 */

import { noiseOffset, sharedNoise } from "./noise";

export interface TyreInput {
  active: boolean;
  /** 0..1 road speed against the class maximum. */
  speed01: number;
  /** 0..1 combined tyre slip. */
  slip: number;
  drifting: boolean;
  /**
   * 0..1 lateral slip angle — how far the car's velocity is from where it is
   * pointing. This is the drift signal; `drifting` is only the driver's intent.
   */
  slipAngle: number;
  /** 0..1 weight on the contact patches. Scales the whole slide voice. */
  load: number;
  /** 0..1 brake demand. Longitudinal scrub only; the pads live in BrakeBed. */
  brakePressure: number;
  boost: boolean;
  /** 0..1, from the sim's smoothed off-road amount. */
  offroad: number;
  /** `SurfaceInfo.roughness`, sampled at a low rate and slewed here. */
  roughness: number;
  dt: number;
}

export class TyreBed {
  private ctx: BaseAudioContext;
  private out: GainNode;
  private rollBp: BiquadFilterNode;
  private tread: BiquadFilterNode;
  private gRoll: GainNode;
  private gGrain: GainNode;
  private gRumble: GainNode;
  private scrubBp: BiquadFilterNode;
  private gScrub: GainNode;
  private gWind: GainNode;
  private squealOsc: OscillatorNode;
  private squealBp: BiquadFilterNode;
  /** Second, inharmonic partial; only opens at a real angle. See update(). */
  private squealPk: BiquadFilterNode;
  private gSqueal: GainNode;
  private tearBp: BiquadFilterNode;
  private gTear: GainNode;

  /** Slewed so a 12 Hz surface query does not step the whole bed. */
  private rough = 0.08;
  /** Continuous slide state — see the header. Never a boolean. */
  private slide = 0;
  /** True once the slide layers have been written to silence. */
  private slideIdle = true;
  /** Whether the tear layer is currently non-zero; see the gate in update(). */
  private tearOn = false;
  /** True once the whole bed has been written down for an inactive phase. */
  private offIdle = false;
  private lastBreakaway = -1e9;

  constructor(ctx: BaseAudioContext, dests: AudioNode[]) {
    this.ctx = ctx;
    const noise = sharedNoise(ctx);
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;

    const out = ctx.createGain();
    out.gain.value = 1;
    for (const d of dests) out.connect(d);
    this.out = out;

    const gain = (v: number) => {
      const g = ctx.createGain();
      g.gain.value = v;
      g.connect(out);
      return g;
    };

    this.rollBp = ctx.createBiquadFilter();
    this.rollBp.type = "bandpass";
    this.rollBp.frequency.value = 1200;
    this.rollBp.Q.value = 0.75;
    // Tread resonance sits in the roll path rather than in parallel: the whine
    // is a colouration of the contact noise, not a separate sound.
    this.tread = ctx.createBiquadFilter();
    this.tread.type = "peaking";
    this.tread.frequency.value = 400;
    this.tread.Q.value = 6;
    this.tread.gain.value = 0;
    this.gRoll = gain(0);
    src.connect(this.rollBp);
    this.rollBp.connect(this.tread);
    this.tread.connect(this.gRoll);

    const grainHp = ctx.createBiquadFilter();
    grainHp.type = "highpass";
    grainHp.frequency.value = 3200;
    this.gGrain = gain(0);
    src.connect(grainHp);
    grainHp.connect(this.gGrain);

    const rumbleLp = ctx.createBiquadFilter();
    rumbleLp.type = "lowpass";
    rumbleLp.frequency.value = 170;
    rumbleLp.Q.value = 1.1;
    this.gRumble = gain(0);
    src.connect(rumbleLp);
    rumbleLp.connect(this.gRumble);

    this.scrubBp = ctx.createBiquadFilter();
    this.scrubBp.type = "bandpass";
    this.scrubBp.frequency.value = 900;
    this.scrubBp.Q.value = 0.7;
    this.gScrub = gain(0);
    src.connect(this.scrubBp);
    this.scrubBp.connect(this.gScrub);

    const windHp = ctx.createBiquadFilter();
    windHp.type = "highpass";
    windHp.frequency.value = 1200;
    this.gWind = gain(0);
    src.connect(windHp);
    windHp.connect(this.gWind);

    this.squealOsc = ctx.createOscillator();
    this.squealOsc.type = "sawtooth";
    this.squealOsc.frequency.value = 880;
    this.squealBp = ctx.createBiquadFilter();
    this.squealBp.type = "bandpass";
    this.squealBp.frequency.value = 1400;
    this.squealBp.Q.value = 4;
    // A slide that is only ever one filtered sawtooth is a whistle. The second
    // partial at a non-integer ratio is what makes a big angle sound like more
    // rubber rather than like the same sound turned up.
    this.squealPk = ctx.createBiquadFilter();
    this.squealPk.type = "peaking";
    this.squealPk.frequency.value = 2600;
    this.squealPk.Q.value = 7;
    this.squealPk.gain.value = 0;
    this.gSqueal = gain(0);
    this.squealOsc.connect(this.squealBp);
    this.squealBp.connect(this.squealPk);
    this.squealPk.connect(this.gSqueal);

    // Rubber being torn off the carcass: broadband, low, and gated hard so it
    // only exists in a genuinely committed slide.
    this.tearBp = ctx.createBiquadFilter();
    this.tearBp.type = "bandpass";
    this.tearBp.frequency.value = 330;
    this.tearBp.Q.value = 0.5;
    this.gTear = gain(0);
    src.connect(this.tearBp);
    this.tearBp.connect(this.gTear);

    src.start();
    this.squealOsc.start();
  }

  /** 0..1 slide envelope, for anything that wants to follow the drift. */
  getSlide() {
    return this.slide;
  }

  update(t: number, s: TyreInput) {
    if (!s.active) {
      this.slide = 0;
      // Menus and results screens sit in this branch for minutes at a time.
      // Writing seven "go to zero" targets on every one of those frames is
      // free-looking and is not; the flag makes the shutdown happen once.
      if (this.offIdle) return;
      this.offIdle = true;
      this.slideIdle = true;
      this.tearOn = false;
      this.gRoll.gain.setTargetAtTime(0, t, 0.08);
      this.gGrain.gain.setTargetAtTime(0, t, 0.08);
      this.gRumble.gain.setTargetAtTime(0, t, 0.08);
      this.gScrub.gain.setTargetAtTime(0, t, 0.08);
      this.gWind.gain.setTargetAtTime(0, t, 0.1);
      this.gSqueal.gain.setTargetAtTime(0, t, 0.05);
      this.gTear.gain.setTargetAtTime(0, t, 0.08);
      return;
    }
    this.offIdle = false;

    const k = Math.min(1, s.dt * 6);
    this.rough += (s.roughness - this.rough) * k;
    const r = this.rough;
    const sp = s.speed01;
    const load = Math.max(0, Math.min(1, s.load));

    // Contact band: coarse surfaces move the energy down and widen it.
    // Level rises with roughness but is deliberately kept under the engine —
    // measured flat out in deep sand the three surface layers sum to ~0.22
    // against an engine bed of ~0.28, so ploughing is loud without masking it.
    this.rollBp.frequency.setTargetAtTime(1400 - r * 1150, t, 0.09);
    this.gRoll.gain.setTargetAtTime(sp * (0.026 + r * 0.105), t, 0.05);

    // Tread whine tracks road speed, and only exists where there is a hard
    // surface for the blocks to slap against.
    const hard = Math.max(0, 1 - r * 1.15);
    this.tread.frequency.setTargetAtTime(130 + sp * 880, t, 0.06);
    this.tread.gain.setTargetAtTime(hard * 11 * Math.min(1, sp * 2.2), t, 0.09);

    this.gGrain.gain.setTargetAtTime(
      sp * Math.max(0, r - 0.3) * 0.1 + s.offroad * 0.015,
      t,
      0.07,
    );
    this.gRumble.gain.setTargetAtTime(sp * r * 0.075, t, 0.07);

    this.gWind.gain.setTargetAtTime(
      sp * sp * 0.12 + (s.boost ? 0.05 : 0) + this.slide * 0.025,
      t,
      0.08,
    );

    // --- slide envelope ----------------------------------------------------
    // Intent (`drifting`) contributes a floor, but the angle the car is really
    // travelling at is what the layers follow. A handbrake held with the car
    // still pointing where it is going should not scream.
    const angle = Math.max(0, Math.min(1, s.slipAngle));
    const target = Math.min(
      1,
      Math.max(
        angle,
        s.drifting ? 0.28 + angle * 0.72 : 0,
        s.slip * 0.75,
        s.offroad * 0.4,
      ) * Math.min(1, sp * 3.2),
    );
    // Asymmetric: rubber lets go quickly and settles slowly.
    this.slide +=
      (target - this.slide) *
      Math.min(1, s.dt * (target > this.slide ? 9 : 2.4));
    const slide = this.slide;

    // Break-away. Fired on the way UP through the threshold, so it marks the
    // moment grip is lost rather than the fact of being sideways.
    if (
      slide > 0.34 &&
      target > slide + 0.02 &&
      sp > 0.2 &&
      t - this.lastBreakaway > 0.85
    ) {
      this.lastBreakaway = t;
      this.breakaway(t, Math.min(1, slide + sp * 0.4), hard);
    }

    const brake = Math.max(0, Math.min(1, s.brakePressure));
    if (slide < 0.004 && brake < 0.02) {
      // Nothing sliding and nothing braking: write the slide layers down once
      // and then stop touching them. This is the majority of every lap, and
      // re-scheduling four "go to zero" targets 120 times a second for it is
      // pure main-thread cost on a build that is already spiking.
      if (!this.slideIdle) {
        this.slideIdle = true;
        this.gScrub.gain.setTargetAtTime(0, t, 0.06);
        this.gSqueal.gain.setTargetAtTime(0, t, 0.06);
        this.squealPk.gain.setTargetAtTime(0, t, 0.07);
        this.gTear.gain.setTargetAtTime(0, t, 0.09);
      }
      return;
    }
    this.slideIdle = false;

    // Scrub: broadens and rises with the angle. The brake term is longitudinal
    // drag on the patch and is deliberately smaller — the pads carry that event.
    this.scrubBp.frequency.setTargetAtTime(
      420 + (1 - r) * 780 + slide * 520,
      t,
      0.06,
    );
    this.scrubBp.Q.setTargetAtTime(0.7 - slide * 0.28, t, 0.09);
    this.gScrub.gain.setTargetAtTime(
      slide * (0.06 + load * 0.13) + brake * 0.035,
      t,
      0.04,
    );

    // Squeal. Rubber has to be able to grip to stick-slip: off the tarmac the
    // tyre is ploughing and the grain/tear layers carry the slide instead.
    const squealMask = Math.max(0, 1 - r * 1.45);
    // Frequency rises with sliding velocity — angle AND speed, not either
    // alone. A slow sideways crawl and a fourth-gear slide are the same angle
    // and are not remotely the same sound.
    const slideVel = slide * (0.35 + sp * 0.85);
    this.squealOsc.frequency.setTargetAtTime(680 + slideVel * 1150, t, 0.05);
    this.squealBp.frequency.setTargetAtTime(
      1150 + slideVel * 1500,
      t,
      0.05,
    );
    // The partial is gated on angle squared, so it is absent in a light
    // four-wheel drift and dominant in a committed one.
    this.squealPk.gain.setTargetAtTime(
      squealMask * slide * slide * load * 13,
      t,
      0.07,
    );
    this.gSqueal.gain.setTargetAtTime(
      squealMask * slide * (0.035 + load * 0.075),
      t,
      0.04,
    );

    // Tear only exists once the slide is committed and there is weight on it.
    // Gated rather than written every frame: it is silent for all of a lap that
    // is not a drift, and two param writes a frame for a layer at zero is the
    // kind of cost that only shows up in aggregate.
    const tear = Math.max(0, slide - 0.42) * load;
    const tearing = tear > 0;
    if (tearing || this.tearOn) {
      this.tearOn = tearing;
      this.tearBp.frequency.setTargetAtTime(260 + slide * 260, t, 0.08);
      this.gTear.gain.setTargetAtTime(tear * 0.11 * (0.4 + hard * 0.6), t, 0.06);
    }
  }

  /**
   * The instant the contact patch lets go: a short upward chirp with a noise
   * body. Three nodes, at most one every 850 ms, and only when the slide is
   * genuinely starting — see the rising-edge test in update().
   */
  private breakaway(t: number, force: number, hard: number) {
    const ctx = this.ctx;
    const buf = sharedNoise(ctx);
    const dur = 0.1 + force * 0.11;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    // Rising, not falling: grip is being lost, so the stick-slip rate is on its
    // way up. A falling chirp here reads as the slide ending.
    bp.frequency.setValueAtTime(760 + Math.random() * 180, t);
    bp.frequency.exponentialRampToValueAtTime(1750 + force * 900, t + dur);
    bp.Q.value = 5.5;
    const g = ctx.createGain();
    const peak = (0.02 + force * 0.05) * (0.35 + hard * 0.65);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.out);
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
