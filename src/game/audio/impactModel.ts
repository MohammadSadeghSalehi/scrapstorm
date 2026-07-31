/**
 * Contact and destruction sounds: continuous metal-on-metal scrape, panel
 * crumple, glass, and the near-miss whoosh.
 *
 * The scrape is the important one and the one a sample cannot do. Grinding down
 * a barrier is a *state*, not an event: it has a duration the player controls,
 * its pitch tracks how fast the metal is sliding, and its level tracks how hard
 * the two surfaces are pressed together. Firing a 200 ms "scrape.mp3" every few
 * frames — which is what the previous pass did, at a 2 % chance per frame while
 * braking — gives an obviously retriggered stutter that no amount of mixing
 * fixes.
 *
 * What makes it read as metal rather than as sandpaper:
 *
 *   - Stick-slip. Sliding steel does not hiss smoothly; it grabs and releases at
 *     a rate proportional to sliding speed. That amplitude modulation is
 *     modelled with an LFO into the level gain, and it is the single cue that
 *     separates "metal" from "noise".
 *   - Body modes. Sheet panels ring at fixed frequencies regardless of how fast
 *     you are sliding. Three high-Q peaking filters give the scrape a pitch
 *     identity that does not move with the broadband band, which is what stops
 *     it sounding like a filter sweep.
 *   - Sparks, gated on energy squared. Light contact does not throw any.
 *
 * The scrape bed allocates nothing and creates no nodes after construction: it
 * is a permanent graph whose AudioParams move. The one-shots below share a
 * single pooled graph each and create only the buffer source the spec forces to
 * be single-use.
 */

import { noiseOffset, sharedNoise } from "./noise";

export interface ScrapeInput {
  /**
   * 0..1 how hard the surfaces are loaded together. Drives level and spark
   * density.
   */
  pressure: number;
  /** 0..1 sliding speed along the contact. Drives pitch and stick-slip rate. */
  slide: number;
  /**
   * 0..1 how metallic the other surface is. 1 = barrier or another car, 0 = a
   * rock wall, which grinds broadband and does not ring.
   */
  metal: number;
  dt: number;
}

export class ScrapeBed {
  private grindBp: BiquadFilterNode;
  private mode1: BiquadFilterNode;
  private mode2: BiquadFilterNode;
  private mode3: BiquadFilterNode;
  private gGrind: GainNode;
  private sparkHp: BiquadFilterNode;
  private gSpark: GainNode;
  /** Stick-slip modulator; its depth is what makes the contact sound uneven. */
  private slipLfo: OscillatorNode;
  private slipDepth: GainNode;
  private level: GainNode;

  /** Slewed in JS so a single-frame contact spike cannot click the bed on. */
  private amp = 0;
  /**
   * True once the bed has been fully written down to silence. The car is not
   * touching anything for the overwhelming majority of frames, and re-scheduling
   * three "go to zero" targets 120 times a second for the whole race is pure
   * waste on a main thread that is already spiking.
   */
  private idle = true;

  constructor(ctx: BaseAudioContext, dests: AudioNode[]) {
    const noise = sharedNoise(ctx);
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;

    this.level = ctx.createGain();
    this.level.gain.value = 0;
    for (const d of dests) this.level.connect(d);

    // Broadband grind. Centre tracks sliding speed: faster contact excites
    // higher modes of both surfaces.
    this.grindBp = ctx.createBiquadFilter();
    this.grindBp.type = "bandpass";
    this.grindBp.frequency.value = 900;
    this.grindBp.Q.value = 0.55;

    // Fixed body modes. These deliberately do NOT track the sliding speed —
    // a panel's resonant frequencies are a property of the panel, and letting
    // them follow the band turns the whole thing into one swept filter.
    const mode = (f: number, q: number) => {
      const b = ctx.createBiquadFilter();
      b.type = "peaking";
      b.frequency.value = f;
      b.Q.value = q;
      b.gain.value = 0;
      return b;
    };
    this.mode1 = mode(387, 11);
    this.mode2 = mode(946, 14);
    this.mode3 = mode(2130, 9);

    this.gGrind = ctx.createGain();
    this.gGrind.gain.value = 1;
    src.connect(this.grindBp);
    this.grindBp.connect(this.mode1);
    this.mode1.connect(this.mode2);
    this.mode2.connect(this.mode3);
    this.mode3.connect(this.gGrind);
    this.gGrind.connect(this.level);

    // Sparks: the bright fizz of material actually being removed. Gated hard on
    // pressure so a light graze is silent up here.
    this.sparkHp = ctx.createBiquadFilter();
    this.sparkHp.type = "highpass";
    this.sparkHp.frequency.value = 5200;
    this.gSpark = ctx.createGain();
    this.gSpark.gain.value = 0;
    src.connect(this.sparkHp);
    this.sparkHp.connect(this.gSpark);
    this.gSpark.connect(this.level);

    // Stick-slip. The LFO is summed into `level.gain`, so the bed's amplitude
    // is (steady level ± modulation). Depth is scaled by how metallic the
    // contact is, because loose rock does not stick and release.
    this.slipLfo = ctx.createOscillator();
    this.slipLfo.type = "sawtooth";
    this.slipLfo.frequency.value = 42;
    this.slipDepth = ctx.createGain();
    this.slipDepth.gain.value = 0;
    this.slipLfo.connect(this.slipDepth);
    this.slipDepth.connect(this.level.gain);

    src.start();
    this.slipLfo.start();
  }

  update(t: number, s: ScrapeInput) {
    const k = Math.min(1, Math.max(0.0001, s.dt) * 9);
    // Attack is fast, release is slow: contact starts abruptly and the panels
    // keep ringing for a moment after the car pulls away.
    const target = Math.max(0, Math.min(1, s.pressure));
    const rate = target > this.amp ? Math.min(1, s.dt * 26) : k * 0.55;
    this.amp += (target - this.amp) * rate;
    const a = this.amp;

    if (a < 0.002) {
      if (!this.idle) {
        this.idle = true;
        this.level.gain.setTargetAtTime(0, t, 0.08);
        this.slipDepth.gain.setTargetAtTime(0, t, 0.08);
        this.gSpark.gain.setTargetAtTime(0, t, 0.08);
      }
      return;
    }
    this.idle = false;

    const slide = Math.max(0, Math.min(1, s.slide));
    const metal = Math.max(0, Math.min(1, s.metal));

    this.grindBp.frequency.setTargetAtTime(420 + slide * 2600, t, 0.05);
    this.grindBp.Q.setTargetAtTime(0.45 + metal * 0.9, t, 0.08);

    // Modes only ring on a metallic contact; on rock they flatten out.
    this.mode1.gain.setTargetAtTime(metal * 13 * a, t, 0.07);
    this.mode2.gain.setTargetAtTime(metal * 10 * a, t, 0.07);
    this.mode3.gain.setTargetAtTime(metal * 7 * a, t, 0.07);

    // Stick-slip rate is proportional to sliding speed. Below ~20 Hz the ear
    // hears individual grabs (a judder); above ~90 Hz it fuses into a buzz, and
    // both are correct at their respective speeds.
    this.slipLfo.frequency.setTargetAtTime(16 + slide * 96, t, 0.06);
    this.slipDepth.gain.setTargetAtTime(a * 0.06 * (0.3 + metal * 0.7), t, 0.05);

    // Sparks scale with pressure squared: material removal is not linear in
    // load, and the quadratic is what stops a gentle lean on the wall fizzing.
    this.gSpark.gain.setTargetAtTime(
      a * a * slide * 0.09 * metal,
      t,
      0.05,
    );
    this.level.gain.setTargetAtTime(a * (0.05 + slide * 0.11), t, 0.03);
  }

  silence(t: number) {
    this.amp = 0;
    this.idle = true;
    this.level.gain.setTargetAtTime(0, t, 0.06);
    this.slipDepth.gain.setTargetAtTime(0, t, 0.06);
    this.gSpark.gain.setTargetAtTime(0, t, 0.06);
  }
}

/* ------------------------------------------------------------------------- */

interface DebrisVoice {
  bp: BiquadFilterNode;
  ring: BiquadFilterNode;
  gain: GainNode;
  busyUntil: number;
  src: AudioBufferSourceNode | null;
}

/**
 * Pooled one-shot destruction voices: panel crumple, glass, whoosh.
 *
 * Each of these is a *cluster* of short grains rather than a single decay,
 * scheduled as ramp pairs on one gain param. Building the cluster from ramps
 * instead of `setValueCurveAtTime` avoids both a Float32Array per event and the
 * NotSupportedError the spec throws when a curve overlaps other automation on
 * the same param — which it would, every time a voice got stolen mid-flight.
 */
export class DebrisRack {
  private ctx: BaseAudioContext;
  private voices: DebrisVoice[] = [];
  private cursor = 0;

  constructor(ctx: BaseAudioContext, dest: AudioNode, poolSize = 5) {
    this.ctx = ctx;
    for (let i = 0; i < poolSize; i++) {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1200;
      bp.Q.value = 0.8;
      const ring = ctx.createBiquadFilter();
      ring.type = "peaking";
      ring.frequency.value = 700;
      ring.Q.value = 8;
      ring.gain.value = 0;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      bp.connect(ring);
      ring.connect(gain);
      gain.connect(dest);
      this.voices.push({ bp, ring, gain, busyUntil: 0, src: null });
    }
  }

  private claim(t: number): DebrisVoice {
    const n = this.voices.length;
    for (let i = 0; i < n; i++) {
      const v = this.voices[(this.cursor + i) % n]!;
      if (v.busyUntil <= t) {
        this.cursor = (this.cursor + i + 1) % n;
        return v;
      }
    }
    let best = this.voices[0]!;
    for (let i = 1; i < n; i++) {
      if (this.voices[i]!.busyUntil < best.busyUntil) best = this.voices[i]!;
    }
    if (best.src) {
      try {
        best.src.stop();
        best.src.disconnect();
      } catch {
        /* already stopped */
      }
      best.src = null;
    }
    return best;
  }

  private run(v: DebrisVoice, t: number, dur: number) {
    const buf = sharedNoise(this.ctx);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(v.bp);
    src.start(t, noiseOffset(buf, 0));
    src.stop(t + dur + 0.03);
    v.src = src;
    v.busyUntil = t + dur;
    src.onended = () => {
      if (v.src !== src) return;
      try {
        src.disconnect();
      } catch {
        /* already torn down */
      }
      v.src = null;
    };
  }

  /**
   * Sheet steel folding. A handful of low-mid thuds with *descending* pitch —
   * the first fold is the stiffest, and each subsequent one meets metal that has
   * already yielded.
   */
  crumple(t: number, intensity: number) {
    const e = Math.max(0.2, Math.min(2, intensity));
    const v = this.claim(t);
    const folds = 2 + Math.round(Math.random() * 3 * e);
    const dur = 0.09 + folds * 0.045;
    v.bp.frequency.cancelScheduledValues(t);
    v.bp.frequency.setValueAtTime(340 + Math.random() * 260, t);
    v.bp.frequency.exponentialRampToValueAtTime(120 + Math.random() * 90, t + dur);
    v.bp.Q.setValueAtTime(0.9, t);
    v.ring.frequency.setValueAtTime(210 + Math.random() * 180, t);
    v.ring.gain.setValueAtTime(9, t);
    const g = v.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    let at = t;
    for (let i = 0; i < folds; i++) {
      at += 0.018 + Math.random() * 0.05;
      const amp = e * 0.3 * (1 - i / (folds + 1)) * (0.6 + Math.random() * 0.7);
      g.exponentialRampToValueAtTime(Math.max(0.0002, amp), at);
      g.exponentialRampToValueAtTime(0.0001, at + 0.03 + Math.random() * 0.045);
    }
    this.run(v, t, dur);
  }

  /**
   * Glass. Many very short high grains over a fast-thinning envelope; the
   * tinkle is the *count* of grains, so this uses more of them than anything
   * else here and keeps each one under 20 ms.
   */
  glass(t: number, intensity: number) {
    const e = Math.max(0.2, Math.min(2, intensity));
    const v = this.claim(t);
    const dur = 0.28 + e * 0.3;
    v.bp.frequency.cancelScheduledValues(t);
    v.bp.frequency.setValueAtTime(5200 + Math.random() * 2600, t);
    v.bp.frequency.exponentialRampToValueAtTime(2100, t + dur);
    v.bp.Q.setValueAtTime(2.6, t);
    v.ring.frequency.setValueAtTime(6400 + Math.random() * 2400, t);
    v.ring.gain.setValueAtTime(11, t);
    const g = v.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    const shards = 9 + Math.round(Math.random() * 7);
    let at = t;
    for (let i = 0; i < shards; i++) {
      // Grains thin out quadratically: the first burst is the pane going, the
      // rest is fragments landing.
      at += 0.008 + Math.pow(i / shards, 1.6) * 0.09 * (0.5 + Math.random());
      if (at > t + dur) break;
      const amp = e * 0.14 * (1 - i / shards) * (0.4 + Math.random());
      g.exponentialRampToValueAtTime(Math.max(0.0002, amp), at);
      g.exponentialRampToValueAtTime(0.0001, at + 0.012 + Math.random() * 0.02);
    }
    this.run(v, t, dur);
  }

  /**
   * Near-miss. A band of noise swept up and then down through the listener,
   * which is a pressure wave passing, not a "swoosh" sample. `closing` scales
   * how violent the sweep is so a 30 m/s pass and a 90 m/s pass differ.
   */
  whoosh(t: number, closing: number) {
    const e = Math.max(0.25, Math.min(1.6, closing));
    const v = this.claim(t);
    const dur = 0.34 / (0.6 + e * 0.6);
    v.bp.frequency.cancelScheduledValues(t);
    v.bp.frequency.setValueAtTime(240, t);
    v.bp.frequency.exponentialRampToValueAtTime(1500 + e * 1400, t + dur * 0.42);
    v.bp.frequency.exponentialRampToValueAtTime(300, t + dur);
    v.bp.Q.setValueAtTime(1.1, t);
    v.ring.gain.setValueAtTime(0, t);
    const g = v.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(e * 0.17, t + dur * 0.42);
    g.exponentialRampToValueAtTime(0.0001, t + dur);
    this.run(v, t, dur);
  }
}
