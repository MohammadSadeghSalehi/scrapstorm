/**
 * Weapons: fire, impact, defensive activation and the ultimate riser.
 *
 * The bank has exactly two weapon samples (`weapon_laser`, `weapon_cannon`) for
 * three weapon types, so the trickster's discs were previously the laser played
 * at 0.72× — which is audibly the same sound, slowed. Worse, a sample is
 * identical every trigger, and the primary weapon fires every 220 ms: nothing
 * else in the mix is repeated that often, so nothing else exposes sameness that
 * badly.
 *
 * Each weapon is therefore synthesised from what it physically is:
 *
 *   bolt   — an electrical discharge. A fast *downward* chirp (the plasma
 *            channel cooling and its resonance dropping) plus a broadband crack.
 *            Chirping upward is the sci-fi cliché and reads as a toy.
 *   cannon — a mechanism. Breech thump, then muzzle blast, then a *late*
 *            metallic action clack ~45 ms behind. The delay between the blast
 *            and the mechanism is the entire reason it sounds like a machine.
 *   disc   — a spinning blade leaving a rail. Launch snap plus a whirr with
 *            vibrato at the rotation rate, pitch falling as it departs.
 *
 * `charge` (0..1) is the shot's charge multiplier from combat.ts: it opens the
 * filters and lengthens the tail, so a full-charge shot is not just louder, it
 * is a different shot.
 *
 * Pooled exactly like the explosion rack: the graph is permanent, an event
 * creates one oscillator and one buffer source, and nothing here runs per frame.
 */

import { noiseOffset, sharedNoise } from "./noise";
import { PannedOut } from "./spatial";

export type WeaponKind = "bolt" | "cannon" | "disc";

interface WeaponVoice {
  stage: PannedOut;
  /** Shapes the tone oscillator (chirp / breech / whirr). */
  toneBp: BiquadFilterNode;
  toneGain: GainNode;
  /** Shapes the noise layer (crack / muzzle blast / launch snap). */
  noiseBp: BiquadFilterNode;
  /** Metal colouration, shared by both layers' outputs. */
  ring: BiquadFilterNode;
  noiseGain: GainNode;
  /** Rotation vibrato for the disc; depth is 0 for every other kind. */
  lfo: OscillatorNode;
  lfoDepth: GainNode;
  busyUntil: number;
  osc: OscillatorNode | null;
  noise: AudioBufferSourceNode | null;
}

function rand(a: number, b: number) {
  return a + Math.random() * (b - a);
}

export class WeaponRack {
  private ctx: BaseAudioContext;
  private voices: WeaponVoice[] = [];
  private cursor = 0;

  constructor(ctx: BaseAudioContext, dest: AudioNode, poolSize = 8) {
    this.ctx = ctx;
    for (let i = 0; i < poolSize; i++) {
      // Weapons roll off faster than explosions: a rival's shot is a local
      // event, and hearing every bolt in the pack at equal weight turns the
      // whole heat into a wall of fire.
      const stage = new PannedOut(ctx, dest, 1.15);

      const ring = ctx.createBiquadFilter();
      ring.type = "peaking";
      ring.frequency.value = 1400;
      ring.Q.value = 6;
      ring.gain.value = 0;
      ring.connect(stage.input);

      const toneBp = ctx.createBiquadFilter();
      toneBp.type = "bandpass";
      toneBp.frequency.value = 900;
      toneBp.Q.value = 1;
      const toneGain = ctx.createGain();
      toneGain.gain.value = 0;
      toneBp.connect(toneGain);
      toneGain.connect(ring);

      const noiseBp = ctx.createBiquadFilter();
      noiseBp.type = "bandpass";
      noiseBp.frequency.value = 2000;
      noiseBp.Q.value = 0.8;
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = 0;
      noiseBp.connect(noiseGain);
      noiseGain.connect(ring);

      const lfo = ctx.createOscillator();
      lfo.type = "triangle";
      lfo.frequency.value = 34;
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 0;
      lfo.connect(lfoDepth);
      lfo.start();

      this.voices.push({
        stage,
        toneBp,
        toneGain,
        noiseBp,
        ring,
        noiseGain,
        lfo,
        lfoDepth,
        busyUntil: 0,
        osc: null,
        noise: null,
      });
    }
  }

  private claim(t: number): WeaponVoice {
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
    return best;
  }

  /**
   * End an in-flight event at `at`. Same reasoning as ExplosionRack.release: the
   * nodes are stopped on the timeline, not disconnected on the spot, so a voice
   * being reclaimed keeps sounding right up to the moment the new event starts
   * instead of dropping out the instant it is chosen.
   */
  private release(v: WeaponVoice, at: number) {
    const osc = v.osc;
    const noise = v.noise;
    v.osc = null;
    v.noise = null;
    if (osc) {
      osc.onended = () => {
        try {
          v.lfoDepth.disconnect(osc.detune);
        } catch {
          /* never connected */
        }
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

  /** Start both per-event sources and arrange their teardown. */
  private arm(
    v: WeaponVoice,
    t: number,
    dur: number,
    oscType: OscillatorType,
    vibratoHz: number,
    vibratoCents: number,
  ) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = oscType;
    osc.connect(v.toneBp);
    if (vibratoCents > 0) {
      v.lfo.frequency.setValueAtTime(vibratoHz, t);
      v.lfoDepth.gain.setValueAtTime(vibratoCents, t);
      v.lfoDepth.connect(osc.detune);
    } else {
      v.lfoDepth.gain.setValueAtTime(0, t);
    }
    osc.start(t);
    osc.stop(t + dur + 0.03);
    v.osc = osc;

    const buf = sharedNoise(ctx);
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    noise.connect(v.noiseBp);
    noise.start(t, noiseOffset(buf, 0));
    noise.stop(t + dur + 0.03);
    v.noise = noise;

    v.busyUntil = t + dur;
    noise.onended = () => {
      if (v.noise !== noise) return;
      try {
        v.lfoDepth.disconnect(osc.detune);
      } catch {
        /* never connected */
      }
      try {
        noise.disconnect();
        osc.disconnect();
      } catch {
        /* already torn down */
      }
      v.noise = null;
      v.osc = null;
    };
  }

  fire(
    t: number,
    kind: WeaponKind,
    x: number,
    y: number,
    z: number,
    charge: number,
    self: boolean,
  ) {
    const v = this.claim(t);
    this.release(v, t);
    v.stage.place(t, x, y, z, self);
    const c = Math.max(0.4, Math.min(1.5, charge));
    const tg = v.toneGain.gain;
    const ng = v.noiseGain.gain;
    tg.cancelScheduledValues(t);
    ng.cancelScheduledValues(t);
    tg.setValueAtTime(0.0001, t);
    ng.setValueAtTime(0.0001, t);
    v.toneBp.frequency.cancelScheduledValues(t);
    v.noiseBp.frequency.cancelScheduledValues(t);

    if (kind === "bolt") {
      const dur = 0.14 + c * 0.07;
      const f0 = rand(2300, 3100) * c;
      // Downward: the discharge channel cools and its resonance falls with it.
      v.toneBp.frequency.setValueAtTime(f0, t);
      v.toneBp.frequency.exponentialRampToValueAtTime(320, t + dur * 0.8);
      v.toneBp.Q.setValueAtTime(4.5, t);
      v.ring.frequency.setValueAtTime(rand(1500, 2200), t);
      v.ring.gain.setValueAtTime(7, t);
      tg.exponentialRampToValueAtTime(0.2 * c, t + 0.004);
      tg.exponentialRampToValueAtTime(0.0001, t + dur);
      v.noiseBp.frequency.setValueAtTime(rand(3800, 5600), t);
      v.noiseBp.frequency.exponentialRampToValueAtTime(1400, t + dur * 0.5);
      v.noiseBp.Q.setValueAtTime(1.2, t);
      ng.exponentialRampToValueAtTime(0.13 * c, t + 0.002);
      ng.exponentialRampToValueAtTime(0.0001, t + dur * 0.55);
      this.arm(v, t, dur, "sawtooth", 0, 0);
      // The oscillator frequency itself also falls, an octave under the filter,
      // so the chirp has a pitch and not just a moving formant.
      const o = v.osc!;
      o.frequency.setValueAtTime(f0 * 0.5, t);
      o.frequency.exponentialRampToValueAtTime(180, t + dur * 0.8);
      return;
    }

    if (kind === "cannon") {
      const dur = 0.4 + c * 0.14;
      // Breech: a real pressure event, low and short.
      v.toneBp.frequency.setValueAtTime(260, t);
      v.toneBp.frequency.exponentialRampToValueAtTime(70, t + 0.14);
      v.toneBp.Q.setValueAtTime(0.9, t);
      v.ring.frequency.setValueAtTime(rand(380, 520), t);
      v.ring.gain.setValueAtTime(6, t);
      tg.exponentialRampToValueAtTime(0.42 * c, t + 0.005);
      tg.exponentialRampToValueAtTime(0.0001, t + 0.2);
      // Muzzle blast, then the action. The ~45 ms gap between them is what makes
      // this a machine rather than a bang: a single envelope reads as a firework.
      v.noiseBp.frequency.setValueAtTime(rand(1500, 2100), t);
      v.noiseBp.frequency.exponentialRampToValueAtTime(240, t + 0.22);
      v.noiseBp.Q.setValueAtTime(0.55, t);
      ng.exponentialRampToValueAtTime(0.26 * c, t + 0.004);
      ng.exponentialRampToValueAtTime(0.02, t + 0.16);
      const clack = t + rand(0.038, 0.062);
      ng.exponentialRampToValueAtTime(0.09 * c, clack);
      ng.exponentialRampToValueAtTime(0.0001, t + dur);
      this.arm(v, t, dur, "triangle", 0, 0);
      const o = v.osc!;
      o.frequency.setValueAtTime(rand(120, 165), t);
      o.frequency.exponentialRampToValueAtTime(38, t + 0.18);
      return;
    }

    // disc
    const dur = 0.42;
    const spin = rand(26, 42);
    v.toneBp.frequency.setValueAtTime(rand(900, 1300), t);
    v.toneBp.frequency.exponentialRampToValueAtTime(340, t + dur);
    v.toneBp.Q.setValueAtTime(3.2, t);
    v.ring.frequency.setValueAtTime(rand(2400, 3200), t);
    v.ring.gain.setValueAtTime(9, t);
    tg.exponentialRampToValueAtTime(0.17 * c, t + 0.02);
    tg.exponentialRampToValueAtTime(0.0001, t + dur);
    // Launch snap: the rail releasing, short and bright, before the whirr.
    v.noiseBp.frequency.setValueAtTime(rand(4200, 5400), t);
    v.noiseBp.frequency.exponentialRampToValueAtTime(2000, t + 0.06);
    v.noiseBp.Q.setValueAtTime(1.6, t);
    ng.exponentialRampToValueAtTime(0.15 * c, t + 0.003);
    ng.exponentialRampToValueAtTime(0.0001, t + 0.09);
    // Vibrato at the rotation rate: a blade presents its edge to the listener
    // once per revolution, and that periodic level change is what makes it read
    // as spinning rather than as a filtered tone.
    this.arm(v, t, dur, "sawtooth", spin, 55);
    const o = v.osc!;
    o.frequency.setValueAtTime(rand(430, 560), t);
    o.frequency.exponentialRampToValueAtTime(190, t + dur);
  }

  /**
   * Projectile landing. Distinct from `fire` because what is being struck is
   * armour: the ring is prominent and the noise band is much lower.
   */
  impact(
    t: number,
    kind: WeaponKind,
    x: number,
    y: number,
    z: number,
    energy: number,
    self: boolean,
  ) {
    const v = this.claim(t);
    this.release(v, t);
    v.stage.place(t, x, y, z, self);
    const e = Math.max(0.35, Math.min(1.8, energy));
    const heavy = kind === "cannon";
    const dur = heavy ? 0.34 : 0.17;
    const tg = v.toneGain.gain;
    const ng = v.noiseGain.gain;
    tg.cancelScheduledValues(t);
    ng.cancelScheduledValues(t);
    tg.setValueAtTime(0.0001, t);
    ng.setValueAtTime(0.0001, t);
    v.toneBp.frequency.cancelScheduledValues(t);
    v.noiseBp.frequency.cancelScheduledValues(t);

    // Struck panels ring at a frequency set by the panel, not by the projectile,
    // so this is randomised per event rather than derived from the weapon.
    const panel = rand(310, 780) * (heavy ? 0.6 : 1);
    v.ring.frequency.setValueAtTime(panel, t);
    v.ring.gain.setValueAtTime(heavy ? 12 : 8, t);
    v.toneBp.frequency.setValueAtTime(panel * rand(1.4, 2.2), t);
    v.toneBp.frequency.exponentialRampToValueAtTime(panel * 0.5, t + dur);
    v.toneBp.Q.setValueAtTime(2.4, t);
    tg.exponentialRampToValueAtTime((heavy ? 0.3 : 0.16) * e, t + 0.004);
    tg.exponentialRampToValueAtTime(0.0001, t + dur);

    v.noiseBp.frequency.setValueAtTime(heavy ? rand(900, 1400) : rand(2600, 4000), t);
    v.noiseBp.frequency.exponentialRampToValueAtTime(heavy ? 190 : 900, t + dur * 0.7);
    v.noiseBp.Q.setValueAtTime(0.9, t);
    ng.exponentialRampToValueAtTime((heavy ? 0.22 : 0.13) * e, t + 0.002);
    ng.exponentialRampToValueAtTime(0.0001, t + dur * 0.8);

    this.arm(v, t, dur, heavy ? "triangle" : "square", 0, 0);
    const o = v.osc!;
    o.frequency.setValueAtTime(panel * rand(0.9, 1.1), t);
    o.frequency.exponentialRampToValueAtTime(panel * 0.45, t + dur);
  }

  /**
   * Defensive activation: a shell closing around the car. Rising, not falling —
   * this is the one cue in the set that should chirp upward, because it is the
   * only one that represents something being *built*.
   */
  defense(t: number, x: number, y: number, z: number, self: boolean) {
    const v = this.claim(t);
    this.release(v, t);
    v.stage.place(t, x, y, z, self);
    const dur = 0.42;
    const tg = v.toneGain.gain;
    const ng = v.noiseGain.gain;
    tg.cancelScheduledValues(t);
    ng.cancelScheduledValues(t);
    tg.setValueAtTime(0.0001, t);
    ng.setValueAtTime(0.0001, t);
    v.toneBp.frequency.cancelScheduledValues(t);
    v.noiseBp.frequency.cancelScheduledValues(t);
    v.toneBp.frequency.setValueAtTime(240, t);
    v.toneBp.frequency.exponentialRampToValueAtTime(1900, t + dur * 0.75);
    v.toneBp.Q.setValueAtTime(5, t);
    v.ring.frequency.setValueAtTime(1150, t);
    v.ring.gain.setValueAtTime(8, t);
    tg.exponentialRampToValueAtTime(0.15, t + dur * 0.6);
    tg.exponentialRampToValueAtTime(0.0001, t + dur);
    v.noiseBp.frequency.setValueAtTime(600, t);
    v.noiseBp.frequency.exponentialRampToValueAtTime(4200, t + dur * 0.7);
    v.noiseBp.Q.setValueAtTime(1.4, t);
    ng.exponentialRampToValueAtTime(0.07, t + dur * 0.5);
    ng.exponentialRampToValueAtTime(0.0001, t + dur);
    this.arm(v, t, dur, "triangle", 9, 30);
    const o = v.osc!;
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(620, t + dur * 0.75);
  }

  /**
   * Ultimate riser. Long, rising, and deliberately *unresolved* at the end — the
   * detonation the caller fires immediately afterwards is the resolution, and a
   * riser that completes on its own steals the impact from it.
   */
  riser(t: number, x: number, y: number, z: number, self: boolean, dur = 0.85) {
    const v = this.claim(t);
    this.release(v, t);
    v.stage.place(t, x, y, z, self);
    const tg = v.toneGain.gain;
    const ng = v.noiseGain.gain;
    tg.cancelScheduledValues(t);
    ng.cancelScheduledValues(t);
    tg.setValueAtTime(0.0001, t);
    ng.setValueAtTime(0.0001, t);
    v.toneBp.frequency.cancelScheduledValues(t);
    v.noiseBp.frequency.cancelScheduledValues(t);
    v.toneBp.frequency.setValueAtTime(180, t);
    v.toneBp.frequency.exponentialRampToValueAtTime(2600, t + dur);
    v.toneBp.Q.setValueAtTime(6, t);
    v.ring.gain.setValueAtTime(0, t);
    tg.exponentialRampToValueAtTime(0.22, t + dur);
    v.noiseBp.frequency.setValueAtTime(400, t);
    v.noiseBp.frequency.exponentialRampToValueAtTime(6000, t + dur);
    v.noiseBp.Q.setValueAtTime(0.9, t);
    ng.exponentialRampToValueAtTime(0.12, t + dur);
    this.arm(v, t, dur + 0.02, "sawtooth", 6, 40);
    const o = v.osc!;
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(420, t + dur);
  }
}
