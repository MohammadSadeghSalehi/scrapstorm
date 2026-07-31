/**
 * Arena crowd bed and stadium PA colouration.
 *
 * The track has an authored `arena` sector but nothing ever made it sound
 * inhabited — driving into a televised stadium sounded exactly like driving
 * through the dunes, only with a slightly wetter reverb. Two things fix that,
 * and neither is a crowd loop:
 *
 * 1. A synthesised crowd. A looped crowd sample is one of the most conspicuous
 *    loops in games, because a crowd has no rhythm for the seam to hide behind
 *    and the ear locks onto the repeat within two passes. Filtered noise with an
 *    irregular swell has no period at all.
 *
 *    What makes noise sound like people: the energy is not flat. A crowd is a
 *    few thousand voices, so it has the *formant* structure of a voice —
 *    a broad peak near 500 Hz and another near 1.6 kHz — and its level breathes
 *    on a several-second, non-periodic cycle. Two sine LFOs at incommensurate
 *    rates give a swell that never repeats without needing a random generator on
 *    the audio thread.
 *
 * 2. PA colouration on the announcer. In the arena the announcer is not in the
 *    player's head, they are on a horn array 80 m away: band-limited to roughly
 *    250 Hz – 4 kHz, slightly overdriven, and arriving late enough to smear. It
 *    is a send, not an insert, so outside the arena the line stays clean and dry
 *    where intelligibility matters more than place.
 */

import { sharedNoise } from "./noise";

export class CrowdBed {
  private low: BiquadFilterNode;
  private mid: BiquadFilterNode;
  private air: BiquadFilterNode;
  private level: GainNode;
  private swell: GainNode;

  /** Phase accumulators for the two swell LFOs; incommensurate on purpose. */
  private p1 = 0;
  private p2 = 1.7;
  /** Slewed presence, so entering the arena fades the crowd in. */
  private amp = 0;
  /** Extra level from a recent event, decayed in JS. */
  private surgeAmt = 0;
  /** See ScrapeBed.idle — most of the track is not the arena, and re-writing
   *  "go to zero" every frame for the whole race buys nothing. */
  private idle = true;

  constructor(ctx: BaseAudioContext, dests: AudioNode[]) {
    const noise = sharedNoise(ctx);
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;

    this.level = ctx.createGain();
    this.level.gain.value = 0;
    for (const d of dests) this.level.connect(d);

    // `swell` sits between the formant filters and `level` so the breathing and
    // the presence fade are independent — otherwise arriving in the arena
    // mid-swell would snap the crowd in at whatever the swell happened to be.
    this.swell = ctx.createGain();
    this.swell.gain.value = 1;
    this.swell.connect(this.level);

    const band = (f: number, q: number, g: number) => {
      const b = ctx.createBiquadFilter();
      b.type = "peaking";
      b.frequency.value = f;
      b.Q.value = q;
      b.gain.value = g;
      return b;
    };
    // Vocal formants: the two peaks that make a noise band read as many people
    // rather than as wind.
    this.low = band(510, 1.1, 9);
    this.mid = band(1620, 1.3, 7);
    // Everything above ~5 kHz in a crowd at 80 m has already been absorbed.
    this.air = ctx.createBiquadFilter();
    this.air.type = "lowpass";
    this.air.frequency.value = 4200;
    this.air.Q.value = 0.6;

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 210;

    src.connect(hp);
    hp.connect(this.low);
    this.low.connect(this.mid);
    this.mid.connect(this.air);
    this.air.connect(this.swell);
    src.start();
  }

  /**
   * `presence` is how much arena there is around the listener (0..1), `heat` is
   * how exciting the race currently is. Called per frame; writes two params and
   * allocates nothing.
   */
  update(t: number, presence: number, heat: number, dt: number) {
    const target = Math.max(0, Math.min(1, presence));
    const k = Math.min(1, Math.max(0.0001, dt) * 1.6);
    this.amp += (target - this.amp) * k;
    this.surgeAmt = Math.max(0, this.surgeAmt - dt * 0.55);

    if (this.amp < 0.004 && this.surgeAmt <= 0) {
      if (!this.idle) {
        this.idle = true;
        this.level.gain.setTargetAtTime(0, t, 0.4);
      }
      return;
    }
    this.idle = false;

    // Two incommensurate rates: the sum has a period of many minutes, which is
    // long enough that the ear never hears it come round.
    this.p1 += dt * 0.23;
    this.p2 += dt * 0.157;
    const breath =
      0.72 + Math.sin(this.p1) * 0.19 + Math.sin(this.p2 * 2.13) * 0.11;
    this.swell.gain.setTargetAtTime(breath, t, 0.25);

    // A crowd gets brighter as it gets louder — people shout rather than just
    // talking more. Moving the lowpass with excitement is cheaper and more
    // convincing than layering a second "cheer" band.
    const excite = Math.min(1, heat + this.surgeAmt);
    this.air.frequency.setTargetAtTime(3400 + excite * 3400, t, 0.5);
    this.mid.gain.setTargetAtTime(6 + excite * 6, t, 0.4);

    this.level.gain.setTargetAtTime(
      this.amp * (0.03 + heat * 0.035) + this.surgeAmt * 0.05 * this.amp,
      t,
      0.3,
    );
  }

  /** A moment worth reacting to. Decays in `update`, so it costs no nodes. */
  surge(amount = 1) {
    this.surgeAmt = Math.min(1.6, this.surgeAmt + amount);
  }

  silence(t: number) {
    this.amp = 0;
    this.surgeAmt = 0;
    this.idle = true;
    this.level.gain.setTargetAtTime(0, t, 0.3);
  }
}

/**
 * Horn-array colouration for the announcer, wired as a parallel send off the VO
 * bus. `amount` follows arena presence, so the same line is intimate on the open
 * track and public in the stadium without ever losing the dry signal.
 */
export class PaSend {
  readonly input: GainNode;
  private amount: GainNode;

  constructor(ctx: BaseAudioContext, dest: AudioNode) {
    this.input = ctx.createGain();
    this.input.gain.value = 1;

    // Horn arrays are band-limited by construction, not by choice: the driver
    // cannot move enough air below ~250 Hz and the horn beams above ~4 kHz.
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 250;
    hp.Q.value = 0.8;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3800;
    lp.Q.value = 0.9;
    // The midrange honk that makes a PA a PA.
    const honk = ctx.createBiquadFilter();
    honk.type = "peaking";
    honk.frequency.value = 1500;
    honk.Q.value = 1.6;
    honk.gain.value = 9;

    // Gentle asymmetric clip. Every stadium PA is run slightly into limiting,
    // and that grit is a stronger "public address" cue than the EQ is.
    const drive = ctx.createWaveShaper();
    const n = 512;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2) * 0.8;
    }
    drive.curve = curve;
    drive.oversample = "2x";

    // Flight time to the far stands and back. Short enough not to be heard as
    // an echo, long enough to smear the consonants the way distance does.
    const delay = ctx.createDelay(0.4);
    delay.delayTime.value = 0.085;

    this.amount = ctx.createGain();
    this.amount.gain.value = 0;

    this.input.connect(hp);
    hp.connect(honk);
    honk.connect(lp);
    lp.connect(drive);
    drive.connect(delay);
    delay.connect(this.amount);
    this.amount.connect(dest);
  }

  setAmount(t: number, v: number) {
    this.amount.gain.setTargetAtTime(Math.max(0, Math.min(1, v)) * 0.55, t, 0.6);
  }
}
