/**
 * Explosions.
 *
 * One "boom" sample is the single thing that most reliably marks a combat game
 * as cheap: it is bit-identical on every kill, it has no distance behaviour, and
 * it arrives at the same instant as the flash however far away it went off.
 *
 * A real detonation is a *sequence* of physically distinct events, and each one
 * behaves differently with distance:
 *
 *   1. shock front  — a few milliseconds of broadband crack. Almost all of its
 *                     energy is above 2 kHz, so it is the first thing air
 *                     absorption takes away: close up it is the loudest part of
 *                     the event, at 150 m it is gone entirely.
 *   2. sub thump    — the pressure wave. A pitch falling from ~90 Hz to ~30 Hz.
 *                     Barely attenuated by air, so it is what survives at range
 *                     and what makes a distant kill still register.
 *   3. body         — the fireball. Broadband noise whose spectral centroid
 *                     sweeps *down* as the ball expands and cools.
 *   4. debris       — discrete grains, not a smooth decay. Sheet metal landing
 *                     is a handful of separable events over ~600 ms.
 *   5. tail         — what the environment gives back. Length comes from the
 *                     reverb zone, so the same blast in the canyon rings for two
 *                     seconds and in the open dunes is over in half of one.
 *
 * Plus two things a sample can never do:
 *   - Delayed arrival. Sound travels 343 m/s; the panner pool culls at 240 m, so
 *     a kill at the far end of the pack is a real 0.4 s late. Scheduling that
 *     delay is most of why the world feels large.
 *   - Variation. Every scalar below is perturbed per event, so ten kills in a
 *     heat are ten different explosions rather than one played ten times.
 *
 * Cost: the pooled part of the graph (17 nodes per voice) is built once. An
 * event creates exactly two nodes — one oscillator and one buffer source, both
 * single-use by spec — and schedules ~40 AudioParam events. Nothing here is
 * touched per frame except `setEnvironment`, which writes two numbers.
 */

import { noiseOffset, sharedNoise } from "./noise";
import { PannedOut } from "./spatial";

export type BlastKind =
  | "vehicle"
  | "mine"
  | "barrel"
  | "shell"
  | "ordnance";

interface BlastSpec {
  /** Overall size multiplier before the caller's energy is applied. */
  scale: number;
  /** Sub thump start/end frequency in Hz and its fall time. */
  subHi: number;
  subLo: number;
  subFall: number;
  subLevel: number;
  /** Shock-front level and length. */
  crack: number;
  crackLen: number;
  /** Fireball body level and sweep length. */
  body: number;
  bodyLen: number;
  /** Debris grain count and spread in seconds. */
  debris: number;
  debrisSpread: number;
  /** Tail level; its *length* comes from the environment, not from here. */
  tail: number;
  /** Level of the delayed secondary detonation (0 disables it). */
  secondary: number;
  /** Metallic ring: peaking-filter gain in dB over the body path. */
  ring: number;
  ringHz: number;
}

/**
 * Kinds differ in balance, not in structure. A mine is nearly all shock front
 * and no fireball; a barrel is a pressure vessel failing, so it rings; a shell
 * landing is small and dry and must not compete with a kill.
 */
const SPECS: Record<BlastKind, BlastSpec> = {
  vehicle: {
    scale: 1,
    subHi: 92,
    subLo: 29,
    subFall: 0.5,
    subLevel: 0.9,
    crack: 0.72,
    crackLen: 0.022,
    body: 0.8,
    bodyLen: 0.34,
    debris: 7,
    debrisSpread: 0.72,
    tail: 0.5,
    secondary: 0.55,
    ring: 4,
    ringHz: 620,
  },
  mine: {
    scale: 0.82,
    subHi: 132,
    subLo: 41,
    subFall: 0.3,
    subLevel: 0.72,
    crack: 1.1,
    crackLen: 0.014,
    body: 0.62,
    bodyLen: 0.2,
    debris: 4,
    debrisSpread: 0.38,
    tail: 0.34,
    secondary: 0,
    ring: 2,
    ringHz: 900,
  },
  // A pressure vessel rupturing is mostly metal failing, then contents burning.
  barrel: {
    scale: 0.9,
    subHi: 78,
    subLo: 34,
    subFall: 0.42,
    subLevel: 0.6,
    crack: 0.8,
    crackLen: 0.03,
    body: 0.85,
    bodyLen: 0.4,
    debris: 6,
    debrisSpread: 0.62,
    tail: 0.44,
    secondary: 0.3,
    ring: 13,
    ringHz: 430,
  },
  shell: {
    scale: 0.5,
    subHi: 150,
    subLo: 55,
    subFall: 0.16,
    subLevel: 0.5,
    crack: 0.85,
    crackLen: 0.012,
    body: 0.45,
    bodyLen: 0.13,
    debris: 3,
    debrisSpread: 0.22,
    tail: 0.2,
    secondary: 0,
    ring: 3,
    ringHz: 1150,
  },
  // Ultimate / chain detonation: slower, deeper, with a real second stage.
  ordnance: {
    scale: 1.35,
    subHi: 74,
    subLo: 24,
    subFall: 0.78,
    subLevel: 1,
    crack: 0.6,
    crackLen: 0.03,
    body: 0.95,
    bodyLen: 0.52,
    debris: 9,
    debrisSpread: 1.05,
    tail: 0.7,
    secondary: 0.75,
    ring: 5,
    ringHz: 520,
  },
};

const SPEED_OF_SOUND = 343;
/** Past this the arrival delay stops reading as distance and starts as a bug. */
const MAX_TRAVEL = 0.72;

/**
 * Soft-clip curve for the sub path.
 *
 * The sub thump lives at 30–90 Hz, which laptop speakers and phone speakers do
 * not reproduce at all. Saturating it generates harmonics an octave and two
 * octaves up that *do* reproduce, and the ear reconstructs the missing
 * fundamental from them. Without this the blast is enormous on headphones and
 * absent on a laptop, which is the more common way this game is played.
 */
// Return type is left to inference on purpose: annotating it `Float32Array`
// widens the backing buffer to ArrayBufferLike, and `WaveShaperNode.curve`
// refuses anything that could be a SharedArrayBuffer.
function makeDriveCurve() {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * 2.6) * 0.72;
  }
  return c;
}

let driveCurve: ReturnType<typeof makeDriveCurve> | null = null;

interface BlastVoice {
  /** Air-absorption lowpass, set per event from distance. */
  air: BiquadFilterNode;
  stage: PannedOut;
  subGain: GainNode;
  subDrive: WaveShaperNode;
  crackHp: BiquadFilterNode;
  crackGain: GainNode;
  bodyBp: BiquadFilterNode;
  bodyRing: BiquadFilterNode;
  bodyGain: GainNode;
  debrisBp: BiquadFilterNode;
  debrisGain: GainNode;
  tailLp: BiquadFilterNode;
  tailGain: GainNode;
  /** Context time this voice is expected to be inaudible again. */
  busyUntil: number;
  /** Nodes from the event in flight, disconnected on `onended`. */
  osc: OscillatorNode | null;
  noise: AudioBufferSourceNode | null;
}

function rand(a: number, b: number) {
  return a + Math.random() * (b - a);
}

export class ExplosionRack {
  private ctx: BaseAudioContext;
  private voices: BlastVoice[] = [];
  private cursor = 0;
  /** Reverb tail length of the zone the listener is standing in. */
  private envTail = 0.7;
  /** 0..1 how reflective the zone is; scales the tail layer's level. */
  private envReflect = 0.25;

  constructor(
    ctx: BaseAudioContext,
    dest: AudioNode,
    reverbSend: AudioNode | null,
    poolSize = 4,
  ) {
    this.ctx = ctx;
    if (!driveCurve) driveCurve = makeDriveCurve();

    for (let i = 0; i < poolSize; i++) {
      // Rolloff is deliberately shallower than the one-shot pool's: a
      // detonation carries far further than a bolt, and hearing a kill happen
      // behind you is the whole reason the pack feels dangerous. Explosions
      // also get a deeper reverb send than the shared spatial bus gives.
      const stage = new PannedOut(
        ctx,
        dest,
        0.55,
        reverbSend ? { node: reverbSend, gain: 0.85 } : undefined,
      );
      const out = stage.input;

      const air = ctx.createBiquadFilter();
      air.type = "lowpass";
      air.frequency.value = 20000;
      air.Q.value = 0.4;
      air.connect(out);

      const subGain = ctx.createGain();
      subGain.gain.value = 0;
      const subDrive = ctx.createWaveShaper();
      subDrive.curve = driveCurve;
      subDrive.oversample = "2x";
      subGain.connect(subDrive);
      // The sub bypasses the air filter: low frequencies are not absorbed over
      // the distances in play, and rolling them off with the highs is the
      // classic mistake that makes every distant explosion sound like a cough.
      subDrive.connect(out);

      const crackHp = ctx.createBiquadFilter();
      crackHp.type = "highpass";
      crackHp.frequency.value = 1800;
      crackHp.Q.value = 0.6;
      const crackGain = ctx.createGain();
      crackGain.gain.value = 0;
      crackHp.connect(crackGain);
      crackGain.connect(air);

      const bodyBp = ctx.createBiquadFilter();
      bodyBp.type = "bandpass";
      bodyBp.frequency.value = 700;
      bodyBp.Q.value = 0.5;
      // Ring: a high-Q peaking stage inside the body path, not parallel to it.
      // A ruptured drum is the fireball *coloured* by a resonating shell.
      const bodyRing = ctx.createBiquadFilter();
      bodyRing.type = "peaking";
      bodyRing.frequency.value = 600;
      bodyRing.Q.value = 7;
      bodyRing.gain.value = 0;
      const bodyGain = ctx.createGain();
      bodyGain.gain.value = 0;
      bodyBp.connect(bodyRing);
      bodyRing.connect(bodyGain);
      bodyGain.connect(air);

      const debrisBp = ctx.createBiquadFilter();
      debrisBp.type = "bandpass";
      debrisBp.frequency.value = 2600;
      debrisBp.Q.value = 1.1;
      const debrisGain = ctx.createGain();
      debrisGain.gain.value = 0;
      debrisBp.connect(debrisGain);
      debrisGain.connect(air);

      const tailLp = ctx.createBiquadFilter();
      tailLp.type = "lowpass";
      tailLp.frequency.value = 1400;
      tailLp.Q.value = 0.7;
      const tailGain = ctx.createGain();
      tailGain.gain.value = 0;
      tailLp.connect(tailGain);
      tailGain.connect(air);

      this.voices.push({
        air,
        stage,
        subGain,
        subDrive,
        crackHp,
        crackGain,
        bodyBp,
        bodyRing,
        bodyGain,
        debrisBp,
        debrisGain,
        tailLp,
        tailGain,
        busyUntil: 0,
        osc: null,
        noise: null,
      });
    }
  }

  /**
   * Environment for the *tail* layer. Called when the reverb zone changes, not
   * per frame. The convolver renders the room; this renders the part of the
   * blast that is still burning and settling, which a convolution of a 300 ms
   * source cannot produce because there is nothing left to convolve.
   */
  setEnvironment(tailSeconds: number, reflectivity: number) {
    this.envTail = Math.max(0.25, Math.min(2.6, tailSeconds));
    this.envReflect = Math.max(0, Math.min(1, reflectivity));
  }

  private claim(t: number): BlastVoice {
    const n = this.voices.length;
    for (let i = 0; i < n; i++) {
      const v = this.voices[(this.cursor + i) % n]!;
      if (v.busyUntil <= t) {
        this.cursor = (this.cursor + i + 1) % n;
        return v;
      }
    }
    // All busy: steal the one closest to finishing, so the truncation lands on
    // the most decayed tail rather than on a blast that just started.
    let best = this.voices[0]!;
    for (let i = 1; i < n; i++) {
      if (this.voices[i]!.busyUntil < best.busyUntil) best = this.voices[i]!;
    }
    return best;
  }

  /**
   * `dist` is the distance to the listener. The caller passes it rather than
   * having this class recompute it, because SpatialField owns the listener pose
   * and two copies of it would eventually disagree.
   *
   * `self` renders dry (the player's own wreck); everything else is panned.
   */
  fire(
    t: number,
    x: number,
    y: number,
    z: number,
    energy: number,
    dist: number,
    kind: BlastKind,
    self = false,
  ) {
    const ctx = this.ctx;
    const spec = SPECS[kind];
    // Loudness scales with the cube root of yield, not linearly: doubling the
    // blast energy of a kill should read as "bigger", not as "twice as loud",
    // and a linear map made a chain detonation clip the limiter flat.
    const e = Math.pow(Math.max(0.15, Math.min(4, energy)), 1 / 3) * spec.scale;
    const travel = self ? 0 : Math.min(MAX_TRAVEL, dist / SPEED_OF_SOUND);
    const t0 = t + travel;

    const v = this.claim(t0);
    // Stop whatever this voice was doing *at t0*, not now. The ultimate
    // schedules its detonation 0.82 s ahead and a distant kill up to 0.72 s
    // ahead, so an immediate stop here would cut a blast that is still audible
    // in order to make room for one that has not started yet.
    this.release(v, t0);

    // Per-event variation. Without these ten kills in a heat are the same event
    // ten times, which is exactly what a single sample sounds like.
    const pitch = rand(0.86, 1.17);
    const timeScale = rand(0.88, 1.16);

    const subFall = spec.subFall * timeScale * (0.85 + e * 0.25);
    const bodyLen = spec.bodyLen * timeScale;
    const crackLen = spec.crackLen * rand(0.8, 1.3);
    // Tail length is the environment's, softened toward the blast's own size so
    // a tiny shell does not ring for two seconds just because it went off in the
    // canyon.
    const tailLen = Math.max(0.18, this.envTail * (0.45 + e * 0.4));
    const debrisSpread = spec.debrisSpread * timeScale;
    // Length of the *sound*, measured from t0. The travel delay is already in
    // t0, so adding it here too would hold the voice for up to another 0.7 s
    // after it went silent — with a four-deep pool that is a stolen voice.
    const total = Math.max(subFall, bodyLen, debrisSpread, tailLen) + 0.25;

    // --- distance shaping ---------------------------------------------------
    // Air absorption is roughly exponential in distance and strongly frequency
    // dependent. One lowpass on everything except the sub is a coarse but
    // convincing model, and it is what makes 200 m read as 200 m rather than as
    // "the same explosion, quieter".
    const air = 18500 * Math.exp(-dist / 62) + 620;
    v.air.frequency.setValueAtTime(Math.min(19000, air), t);
    // Highs are also *smeared* by distance, not just attenuated. Widening the
    // crack as it gets further away keeps a far kill from sounding like a click.
    const far = Math.min(1, dist / 190);
    v.crackHp.frequency.setValueAtTime(1800 - far * 1300, t);

    v.stage.place(t, x, y, z, self);

    // --- sub thump ----------------------------------------------------------
    const osc = ctx.createOscillator();
    osc.type = "sine";
    const f1 = spec.subHi * pitch;
    const f2 = spec.subLo * pitch;
    osc.frequency.setValueAtTime(f1, t0);
    osc.frequency.exponentialRampToValueAtTime(f2, t0 + subFall);
    osc.connect(v.subGain);
    const subPeak = spec.subLevel * e * 0.55;
    const sg = v.subGain.gain;
    sg.cancelScheduledValues(t);
    sg.setValueAtTime(0.0001, t0);
    // 6 ms attack, not instant: a zero-length attack on a 90 Hz sine is a DC
    // step, and the click it produces is exactly the "digital" artefact that
    // makes a synthesised explosion read as synthesised.
    sg.exponentialRampToValueAtTime(subPeak, t0 + 0.006);
    if (spec.secondary > 0) {
      // Secondary detonation: fuel or ordnance cooking off after the initial
      // rupture. It is what separates a vehicle kill from a grenade.
      const at = t0 + rand(0.07, 0.19) * timeScale;
      sg.exponentialRampToValueAtTime(subPeak * 0.24, at);
      sg.exponentialRampToValueAtTime(subPeak * spec.secondary, at + 0.02);
      sg.exponentialRampToValueAtTime(0.0001, t0 + subFall);
    } else {
      sg.exponentialRampToValueAtTime(0.0001, t0 + subFall);
    }
    osc.start(t0);
    osc.stop(t0 + subFall + 0.05);
    v.osc = osc;

    // --- one noise source drives crack, body, debris and tail ---------------
    // Four separate sources would be four allocations on the exact frame the
    // renderer is already busy with the explosion VFX. The layers are separated
    // by filters that share no passband, so the correlation is inaudible.
    const buf = sharedNoise(ctx);
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    noise.connect(v.crackHp);
    noise.connect(v.bodyBp);
    noise.connect(v.debrisBp);
    noise.connect(v.tailLp);
    noise.start(t0, noiseOffset(buf, 0));
    noise.stop(t0 + total + 0.05);
    v.noise = noise;

    // shock front
    const cg = v.crackGain.gain;
    cg.cancelScheduledValues(t);
    cg.setValueAtTime(0.0001, t0);
    // Highs die with distance far faster than the overall level does.
    const crackPeak = spec.crack * e * 0.5 * Math.exp(-dist / 85);
    cg.exponentialRampToValueAtTime(Math.max(0.0002, crackPeak), t0 + 0.0015);
    cg.exponentialRampToValueAtTime(0.0001, t0 + crackLen);

    // fireball body: centroid sweeps down as the ball expands and cools
    v.bodyBp.frequency.cancelScheduledValues(t);
    v.bodyBp.frequency.setValueAtTime(rand(760, 1150) * pitch, t0);
    v.bodyBp.frequency.exponentialRampToValueAtTime(
      rand(95, 150) * pitch,
      t0 + bodyLen,
    );
    v.bodyBp.Q.setValueAtTime(rand(0.4, 0.75), t0);
    v.bodyRing.frequency.setValueAtTime(spec.ringHz * pitch, t0);
    v.bodyRing.gain.setValueAtTime(spec.ring, t0);
    const bg = v.bodyGain.gain;
    bg.cancelScheduledValues(t);
    bg.setValueAtTime(0.0001, t0);
    bg.exponentialRampToValueAtTime(spec.body * e * 0.42, t0 + 0.012);
    bg.exponentialRampToValueAtTime(0.0001, t0 + bodyLen);

    // debris: discrete grains, not a smooth decay. Sheet metal coming down is a
    // countable number of separable impacts, and smoothing them into one decay
    // is what makes a synthesised explosion sound like a hiss with a thump.
    const grains = Math.max(2, Math.round(spec.debris * (0.6 + e * 0.5)));
    v.debrisBp.frequency.cancelScheduledValues(t);
    v.debrisBp.frequency.setValueAtTime(rand(2000, 3400), t0);
    v.debrisBp.frequency.exponentialRampToValueAtTime(
      rand(700, 1300),
      t0 + debrisSpread,
    );
    const dg = v.debrisGain.gain;
    dg.cancelScheduledValues(t);
    dg.setValueAtTime(0.0001, t0);
    let last = t0 + 0.02;
    for (let i = 0; i < grains; i++) {
      // Grains cluster early and thin out — the heavy pieces land first.
      const frac = Math.pow((i + rand(0.15, 0.9)) / grains, 1.55);
      const at = t0 + 0.02 + frac * debrisSpread;
      if (at <= last + 0.006) continue;
      const amp = spec.debris > 0 ? e * 0.16 * (1 - frac * 0.75) * rand(0.5, 1.3) : 0;
      dg.exponentialRampToValueAtTime(Math.max(0.0002, amp), at);
      dg.exponentialRampToValueAtTime(0.0001, at + rand(0.02, 0.07));
      last = at;
    }

    // environment tail: still burning, still settling
    v.tailLp.frequency.cancelScheduledValues(t);
    v.tailLp.frequency.setValueAtTime(rand(1100, 1900), t0);
    v.tailLp.frequency.exponentialRampToValueAtTime(280, t0 + tailLen);
    const tg = v.tailGain.gain;
    tg.cancelScheduledValues(t);
    tg.setValueAtTime(0.0001, t0);
    tg.exponentialRampToValueAtTime(
      Math.max(0.0002, spec.tail * e * 0.14 * (0.35 + this.envReflect)),
      t0 + 0.05,
    );
    tg.exponentialRampToValueAtTime(0.0001, t0 + tailLen);

    v.busyUntil = t0 + total;

    // Release the two per-event nodes as soon as the longer of them finishes.
    const owned = v;
    noise.onended = () => {
      if (owned.noise === noise) {
        try {
          noise.disconnect();
        } catch {
          /* already torn down */
        }
        owned.noise = null;
      }
      if (owned.osc === osc) {
        try {
          osc.disconnect();
        } catch {
          /* already torn down */
        }
        owned.osc = null;
      }
    };
  }

  /**
   * End an in-flight event at `at` so the voice is free for the next one.
   *
   * The nodes are deliberately NOT disconnected here — disconnecting is
   * immediate and would silence a blast that is still meant to sound until `at`.
   * They get a fresh `onended` that disconnects them once they have actually
   * finished; the handler installed by `fire` is discarded, which is safe
   * because the voice's references are cleared right here.
   */
  private release(v: BlastVoice, at: number) {
    const osc = v.osc;
    const noise = v.noise;
    v.osc = null;
    v.noise = null;
    if (osc) {
      osc.onended = () => {
        try {
          osc.disconnect();
        } catch {
          /* already torn down */
        }
      };
      try {
        osc.stop(at);
      } catch {
        /* already stopped */
      }
    }
    if (noise) {
      noise.onended = () => {
        try {
          noise.disconnect();
        } catch {
          /* already torn down */
        }
      };
      try {
        noise.stop(at);
      } catch {
        /* already stopped */
      }
    }
  }
}
