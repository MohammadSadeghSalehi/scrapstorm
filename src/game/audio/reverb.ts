/**
 * Procedural reverb zones.
 *
 * No IR files ship with the build, so the impulse responses are rendered at
 * runtime. A plain exponentially-decaying noise burst is the usual shortcut and
 * it does not read as a space — the two things that actually sell a room are
 * (a) discrete early reflections at plausible wall distances and (b) a diffusion
 * build-up before the tail, so the reverb does not start at full level. Both are
 * modelled here.
 *
 * Rendering runs once per zone, off the critical path (see ReverbRack), and
 * costs roughly sampleRate × seconds × 2 iterations — ~200k for the canyon.
 */

import type { SurfaceInfo } from "../types";

export type ReverbZoneId = "open" | "canyon" | "stadium" | "scrapyard";

interface ReverbSpec {
  /** Tail length to -60 dB. */
  seconds: number;
  /**
   * Bend on the decay curve. >1 collapses fast then lingers (dead, absorbent
   * surfaces); <1 holds level then falls away (hard parallel walls).
   */
  shape: number;
  /** Gap before the first energy returns — reads directly as room size. */
  preDelay: number;
  /** 0..1 high-frequency absorption, increasing over the tail (air + surfaces). */
  damping: number;
  /**
   * Discrete wall slaps as flat [seconds, gain, stereoSkewSeconds] triples.
   * The skew is what makes a canyon feel like two walls rather than one.
   */
  early: number[];
  /** Post-normalisation trim so the zones sit at comparable send levels. */
  trim: number;
}

const SPECS: Record<ReverbZoneId, ReverbSpec> = {
  // Open desert: there is nothing to reflect off except the ground. Almost all
  // of the "space" here is a short ground bounce and a lot of air absorption.
  open: {
    seconds: 0.62,
    shape: 1.5,
    preDelay: 0.009,
    damping: 0.82,
    early: [0.014, 0.35, 0.002],
    trim: 0.62,
  },
  // The cut between the ridges. Hard rock, close on both sides, so: long tail,
  // late first return, bright, and four unmistakable slaps that alternate ear.
  canyon: {
    seconds: 2.1,
    shape: 0.78,
    preDelay: 0.031,
    damping: 0.34,
    early: [
      0.036, 0.62, 0.004,
      0.061, 0.5, -0.006,
      0.108, 0.36, 0.009,
      0.177, 0.24, -0.011,
    ],
    trim: 1,
  },
  // Arena bowl: one big far return off the far side plus a broad diffuse tail.
  stadium: {
    seconds: 1.45,
    shape: 1.05,
    preDelay: 0.024,
    damping: 0.52,
    early: [0.028, 0.4, 0.003, 0.096, 0.45, -0.005],
    trim: 0.86,
  },
  // Scrapyard hazard: dense, close, metallic clutter. Short tail but a thick
  // cluster of early energy — the opposite balance to the canyon.
  scrapyard: {
    seconds: 0.85,
    shape: 1.15,
    preDelay: 0.011,
    damping: 0.45,
    early: [
      0.009, 0.5, 0.001,
      0.017, 0.42, -0.002,
      0.026, 0.36, 0.003,
      0.041, 0.28, -0.004,
      0.058, 0.2, 0.002,
    ],
    trim: 0.78,
  },
};

export function renderImpulseResponse(
  ctx: BaseAudioContext,
  id: ReverbZoneId,
): AudioBuffer {
  const spec = SPECS[id];
  const sr = ctx.sampleRate;
  const pre = Math.floor(spec.preDelay * sr);
  const n = Math.max(1, pre + Math.ceil(sr * spec.seconds));
  const buf = ctx.createBuffer(2, n, sr);
  // Diffusion ramp: without it the tail starts at full amplitude and the ear
  // hears a noise burst glued to the source instead of a room around it.
  const build = Math.max(1, Math.floor(sr * 0.013));
  const tapWidth = Math.max(2, Math.floor(sr * 0.004));

  for (let ch = 0; ch < 2; ch++) {
    // Channels are rendered from independent noise so the tail is decorrelated
    // and therefore wide. Copying one channel gives a dead-centre mono reverb.
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const x = (i - pre) / (n - pre);
      const env = Math.exp(-6.9 * Math.pow(x, spec.shape)) * (1 - x);
      const white = Math.random() * 2 - 1;
      // One-pole lowpass whose coefficient tightens over the tail: highs die
      // first, which is what distinguishes rock from open air.
      const a = Math.max(0.04, 1 - spec.damping * (0.2 + 0.8 * x));
      lp += a * (white - lp);
      const ramp = i - pre < build ? (i - pre) / build : 1;
      d[i] = lp * env * ramp;
    }

    for (let k = 0; k + 2 < spec.early.length; k += 3) {
      const skew = ch === 0 ? 0 : spec.early[k + 2]!;
      const at = pre + Math.floor((spec.early[k]! + skew) * sr);
      if (at < 0) continue;
      const g = spec.early[k + 1]!;
      // A tap written as a single sample is a click, not a wall. Smearing it
      // over ~4 ms of decaying noise gives it a surface.
      for (let j = 0; j < tapWidth && at + j < n; j++) {
        d[at + j] += (Math.random() * 2 - 1) * g * (1 - j / tapWidth);
      }
    }

    let peak = 1e-6;
    for (let i = 0; i < n; i++) {
      const v = d[i]! < 0 ? -d[i]! : d[i]!;
      if (v > peak) peak = v;
    }
    const k = spec.trim / peak;
    for (let i = 0; i < n; i++) d[i] = d[i]! * k;
  }
  return buf;
}

/**
 * Pick a zone from the surface query physics already runs. Zone comes from the
 * track's authored sector, but width and off-track distance override it: out in
 * the dunes there is nothing to reflect off regardless of which sector you are
 * nominally beside.
 */
export function zoneForSurface(info: SurfaceInfo): {
  id: ReverbZoneId;
  wet: number;
} {
  if (info.dist > info.half + 26) return { id: "open", wet: 0.05 };
  const zone = info.sample.zone;
  if (zone === "jump" || zone === "narrow") {
    // Narrower cut = more confined = wetter. Track widths here run 20..26 m.
    const confine = Math.max(0, Math.min(1, (28 - info.half * 2) / 8));
    return { id: "canyon", wet: 0.3 + confine * 0.22 };
  }
  if (zone === "arena") return { id: "stadium", wet: 0.24 };
  if (zone === "hazard") return { id: "scrapyard", wet: 0.2 };
  return { id: "open", wet: 0.1 };
}

/**
 * Two convolvers with an equal-power crossfade between them.
 *
 * Swapping `ConvolverNode.buffer` in place truncates whatever tail is sounding,
 * which is an audible tear every time you enter the canyon. Two nodes let the
 * old space ring out under the new one. The idle convolver is then *disconnected*
 * — a connected ConvolverNode keeps running its partitioned FFT even on silence,
 * and steady-state cost should be one reverb, not two.
 */
export class ReverbRack {
  private ctx: BaseAudioContext;
  private send: GainNode;
  private wet: GainNode;
  /** Separate stage so ducking cannot collide with the zone ramp on `wet`. */
  private duckGain: GainNode;
  private conv: ConvolverNode[];
  private mix: GainNode[];
  private active = 0;
  private current: ReverbZoneId | null = null;
  private buffers = new Map<ReverbZoneId, AudioBuffer>();
  private idleToken = 0;
  private targetWet = 0.1;

  constructor(ctx: BaseAudioContext, dest: AudioNode) {
    this.ctx = ctx;
    this.send = ctx.createGain();
    this.send.gain.value = 1;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0;
    this.duckGain = ctx.createGain();
    this.duckGain.gain.value = 1;
    this.wet.connect(this.duckGain);
    this.duckGain.connect(dest);

    this.conv = [ctx.createConvolver(), ctx.createConvolver()];
    this.mix = [ctx.createGain(), ctx.createGain()];
    for (let i = 0; i < 2; i++) {
      // Normalisation is off because the specs are already peak-trimmed against
      // each other; leaving it on makes the short zones jump in level.
      this.conv[i]!.normalize = false;
      this.mix[i]!.gain.value = 0;
      this.conv[i]!.connect(this.mix[i]!);
      this.mix[i]!.connect(this.wet);
    }
  }

  /** Anything routed here is heard through the room as well as directly. */
  get input(): AudioNode {
    return this.send;
  }

  private irFor(id: ReverbZoneId) {
    let b = this.buffers.get(id);
    if (!b) {
      b = renderImpulseResponse(this.ctx, id);
      this.buffers.set(id, b);
    }
    return b;
  }

  /**
   * Warm the zones the heat will need. Rendering the canyon IR is ~5 ms of
   * straight-line float work; doing it lazily on the frame the player enters
   * the cut would be a visible hitch, so it is paid during idle time instead.
   */
  prewarm(ids: ReverbZoneId[]) {
    const run = () => {
      for (const id of ids) this.irFor(id);
    };
    const ric = (
      globalThis as unknown as {
        requestIdleCallback?: (cb: () => void) => number;
      }
    ).requestIdleCallback;
    if (ric) ric(run);
    else setTimeout(run, 0);
  }

  setZone(id: ReverbZoneId, wet: number, t: number, fade = 1.1) {
    this.targetWet = wet;
    if (id !== this.current) {
      this.current = id;
      const next = this.active ^ 1;
      const nc = this.conv[next]!;
      nc.buffer = this.irFor(id);
      nc.connect(this.mix[next]!);
      this.send.connect(nc);
      // Equal-power-ish crossfade via linear ramps on both legs. Linear is
      // acceptable here because the two tails are uncorrelated noise, so they
      // sum in power rather than amplitude.
      const a = this.mix[this.active]!.gain;
      const b = this.mix[next]!.gain;
      a.cancelScheduledValues(t);
      a.setValueAtTime(a.value, t);
      a.linearRampToValueAtTime(0.0001, t + fade);
      b.cancelScheduledValues(t);
      b.setValueAtTime(b.value, t);
      b.linearRampToValueAtTime(1, t + fade);

      const dying = this.active;
      this.active = next;
      const token = ++this.idleToken;
      // Release the outgoing convolver once it is inaudible. Guarded by a token
      // because a second zone change inside the fade window would otherwise
      // disconnect the node that just became active.
      setTimeout(
        () => {
          if (token !== this.idleToken) return;
          try {
            this.send.disconnect(this.conv[dying]!);
          } catch {
            /* already detached */
          }
        },
        (fade + 0.15) * 1000,
      );
    }
    this.wet.gain.setTargetAtTime(Math.max(0, wet), t, 0.4);
  }

  /**
   * Pull the room down under the announcer. A canyon tail sitting on top of a
   * VO line is the fastest way to make the line unintelligible, and the music
   * duck alone does not touch it because the reverb is fed from the SFX side.
   */
  duck(depth: number, hold: number, t: number) {
    const p = this.duckGain.gain;
    const low = Math.max(0.02, 1 - depth);
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(low, t + 0.07);
    p.setValueAtTime(low, t + Math.max(0.1, hold));
    p.linearRampToValueAtTime(1, t + Math.max(0.1, hold) + 0.4);
  }
}
