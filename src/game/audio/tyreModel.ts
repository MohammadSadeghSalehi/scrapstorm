/**
 * Tyre / road contact bed.
 *
 * Driven by the same surface classification physics uses — `getSurfaceAt`
 * returns a continuous `roughness` (0.08 asphalt → 0.95 deep sand), so the
 * layers interpolate along it rather than switching on the discrete kind. That
 * matters at the tarmac edge, where the old two-way filter switch stepped
 * audibly on a boundary the car straddles for whole corners.
 *
 * Four layers, because one filtered noise band cannot be both a tyre and a
 * surface:
 *   roll   — contact band, centre frequency falls as the surface coarsens
 *   tread  — narrow resonance that tracks road speed; only on hard surfaces.
 *            This is the tyre whine, and it is the layer that reads as "tarmac"
 *   grain  — loose grit spray, sand and deep only
 *   rumble — low-frequency body shake from a coarse surface
 * plus the pre-existing scrub (slip) and squeal layers.
 *
 * Squeal is now gated by roughness. Sand does not squeal — it hisses — and the
 * previous version screeched identically off-road, which was the single most
 * obviously wrong thing in the tyre mix.
 */

import { sharedNoise } from "./noise";

export interface TyreInput {
  active: boolean;
  /** 0..1 road speed against the class maximum. */
  speed01: number;
  /** 0..1 combined tyre slip. */
  slip: number;
  drifting: boolean;
  brake: boolean;
  boost: boolean;
  /** 0..1, from the sim's smoothed off-road amount. */
  offroad: number;
  /** `SurfaceInfo.roughness`, sampled at a low rate and slewed here. */
  roughness: number;
  dt: number;
}

export class TyreBed {
  private rollBp: BiquadFilterNode;
  private tread: BiquadFilterNode;
  private gRoll: GainNode;
  private gGrain: GainNode;
  private gRumble: GainNode;
  private scrubBp: BiquadFilterNode;
  private gScrub: GainNode;
  private gWind: GainNode;
  private squealOsc: OscillatorNode;
  private gSqueal: GainNode;

  /** Slewed so a 12 Hz surface query does not step the whole bed. */
  private rough = 0.08;

  constructor(ctx: BaseAudioContext, dests: AudioNode[]) {
    const noise = sharedNoise(ctx);
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;

    const out = ctx.createGain();
    out.gain.value = 1;
    for (const d of dests) out.connect(d);

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
    const sqBp = ctx.createBiquadFilter();
    sqBp.type = "bandpass";
    sqBp.frequency.value = 1400;
    sqBp.Q.value = 4;
    this.gSqueal = gain(0);
    this.squealOsc.connect(sqBp);
    sqBp.connect(this.gSqueal);

    src.start();
    this.squealOsc.start();
  }

  update(t: number, s: TyreInput) {
    if (!s.active) {
      this.gRoll.gain.setTargetAtTime(0, t, 0.08);
      this.gGrain.gain.setTargetAtTime(0, t, 0.08);
      this.gRumble.gain.setTargetAtTime(0, t, 0.08);
      this.gScrub.gain.setTargetAtTime(0, t, 0.08);
      this.gWind.gain.setTargetAtTime(0, t, 0.1);
      this.gSqueal.gain.setTargetAtTime(0, t, 0.05);
      return;
    }

    const k = Math.min(1, s.dt * 6);
    this.rough += (s.roughness - this.rough) * k;
    const r = this.rough;
    const sp = s.speed01;

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

    const slip = Math.max(s.slip, s.drifting ? 0.72 : 0, s.offroad * 0.45);
    this.scrubBp.frequency.setTargetAtTime(
      420 + (1 - r) * 780 + slip * 420,
      t,
      0.08,
    );
    this.gScrub.gain.setTargetAtTime(
      slip * 0.15 + (s.drifting ? 0.09 : 0) + (s.brake ? 0.07 : 0),
      t,
      0.04,
    );

    this.gWind.gain.setTargetAtTime(
      sp * sp * 0.12 + (s.boost ? 0.05 : 0) + (s.drifting ? 0.02 : 0),
      t,
      0.08,
    );

    // Rubber has to be able to grip to stick-slip. Off the tarmac the tyre is
    // ploughing, and the grain/scrub layers carry it instead.
    const squealMask = Math.max(0, 1 - r * 1.45);
    const sq = s.drifting || slip > 0.55 ? Math.min(1, slip * 1.2) : 0;
    this.squealOsc.frequency.setTargetAtTime(
      720 + sq * 900 + sp * 200,
      t,
      0.05,
    );
    this.gSqueal.gain.setTargetAtTime(
      squealMask * (sq * 0.085 + (s.drifting ? 0.03 : 0)),
      t,
      0.04,
    );
  }
}
