/**
 * Positional audio: listener, pooled one-shot voices, opponent engine drones.
 *
 * `panningModel` is "equalpower" everywhere on purpose. HRTF costs a per-source
 * convolution on the audio thread, and what it buys — elevation and front/back
 * disambiguation — is either irrelevant here (everything is roughly in the
 * ground plane) or actively unreliable without head tracking. With a full grid
 * plus weapon fire the panner count is high enough that the choice is worth
 * about an order of magnitude in DSP cost for no perceptual gain.
 *
 * Nothing in this file allocates or builds nodes per frame: the one-shot voices
 * and the opponent drones are pooled at construction and only their AudioParams
 * move. The one exception is the AudioBufferSourceNode a one-shot needs, which
 * the spec makes single-use — that is per event, not per frame.
 */

import { sharedNoise } from "./noise";

/** Beyond this a source is skipped outright rather than given a voice. */
const CULL_DISTANCE = 240;

const IDLE_RPM = 850;
const MAX_RPM = 7400;
const FIRE_PER_RPM = 1 / 15;

/** Fields per opponent in the flat update buffer: x, y, z, rpm01, load, id. */
export const OPPONENT_STRIDE = 6;
export const OPPONENT_VOICES = 3;

function configurePanner(p: PannerNode) {
  p.panningModel = "equalpower";
  p.distanceModel = "inverse";
  // refDistance is roughly a car length: inside it a source stays at full level
  // instead of blowing up as the distance approaches zero.
  p.refDistance = 7;
  p.maxDistance = CULL_DISTANCE + 20;
  p.rolloffFactor = 1.05;
}

/**
 * Safari before 14.1 exposes only the deprecated setter methods, and reading
 * `positionX` there is undefined rather than an AudioParam.
 */
function pannerPos(
  p: PannerNode,
  x: number,
  y: number,
  z: number,
  t: number,
  tau: number,
) {
  const px = p.positionX as AudioParam | undefined;
  if (!px) {
    p.setPosition(x, y, z);
    return;
  }
  if (tau <= 0) {
    px.setValueAtTime(x, t);
    p.positionY.setValueAtTime(y, t);
    p.positionZ.setValueAtTime(z, t);
    return;
  }
  px.setTargetAtTime(x, t, tau);
  p.positionY.setTargetAtTime(y, t, tau);
  p.positionZ.setTargetAtTime(z, t, tau);
}

interface OneShotVoice {
  input: GainNode;
  panner: PannerNode;
  /** Context time this voice is expected to be silent again. */
  busyUntil: number;
}

interface DroneVoice {
  osc: OscillatorNode;
  band: BiquadFilterNode;
  level: GainNode;
  panner: PannerNode;
  /** Vehicle index currently rendered by this voice, -1 when idle. */
  id: number;
  prevDist: number;
}

export class SpatialField {
  private ctx: BaseAudioContext;
  private voices: OneShotVoice[] = [];
  private drones: DroneVoice[] = [];
  private cursor = 0;

  private lx = 0;
  private ly = 0;
  private lz = 0;
  private listenerReady = false;

  constructor(ctx: BaseAudioContext, dest: AudioNode, poolSize = 12) {
    this.ctx = ctx;
    for (let i = 0; i < poolSize; i++) {
      const input = ctx.createGain();
      input.gain.value = 1;
      const panner = ctx.createPanner();
      configurePanner(panner);
      input.connect(panner);
      panner.connect(dest);
      this.voices.push({ input, panner, busyUntil: 0 });
    }

    const noise = sharedNoise(ctx);
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noise;
    noiseSrc.loop = true;
    for (let i = 0; i < OPPONENT_VOICES; i++) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = 90;
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = 500;
      band.Q.value = 0.7;
      const oscTrim = ctx.createGain();
      oscTrim.gain.value = 0.7;
      const noiseTrim = ctx.createGain();
      noiseTrim.gain.value = 0.35;
      const level = ctx.createGain();
      level.gain.value = 0;
      const panner = ctx.createPanner();
      configurePanner(panner);
      // Opponents are heard further out than a one-shot: an engine approaching
      // from behind is information the player acts on.
      panner.rolloffFactor = 0.85;
      osc.connect(oscTrim);
      oscTrim.connect(level);
      noiseSrc.connect(band);
      band.connect(noiseTrim);
      noiseTrim.connect(level);
      level.connect(panner);
      panner.connect(dest);
      osc.start();
      this.drones.push({ osc, band, level, panner, id: -1, prevDist: 0 });
    }
    noiseSrc.start();
  }

  /**
   * Listener pose from the render camera. Position is smoothed, but a chase
   * camera also *teleports* (respawn, phase change, track reset) and gliding the
   * listener across half the map produces a several-second smear — large jumps
   * are snapped instead.
   */
  updateListener(
    t: number,
    x: number,
    y: number,
    z: number,
    fx: number,
    fy: number,
    fz: number,
    ux: number,
    uy: number,
    uz: number,
  ) {
    const l = (this.ctx as AudioContext).listener;
    const dx = x - this.lx;
    const dy = y - this.ly;
    const dz = z - this.lz;
    const snap =
      !this.listenerReady || dx * dx + dy * dy + dz * dz > 625; // 25 m
    this.lx = x;
    this.ly = y;
    this.lz = z;
    this.listenerReady = true;

    const px = l.positionX as AudioParam | undefined;
    if (!px) {
      l.setPosition(x, y, z);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
      return;
    }
    if (snap) {
      px.setValueAtTime(x, t);
      l.positionY.setValueAtTime(y, t);
      l.positionZ.setValueAtTime(z, t);
    } else {
      // 25 ms is short enough to track the camera and long enough to kill the
      // zipper noise from writing a stepped position every frame.
      px.setTargetAtTime(x, t, 0.025);
      l.positionY.setTargetAtTime(y, t, 0.025);
      l.positionZ.setTargetAtTime(z, t, 0.025);
    }
    l.forwardX.setTargetAtTime(fx, t, 0.03);
    l.forwardY.setTargetAtTime(fy, t, 0.03);
    l.forwardZ.setTargetAtTime(fz, t, 0.03);
    l.upX.setTargetAtTime(ux, t, 0.03);
    l.upY.setTargetAtTime(uy, t, 0.03);
    l.upZ.setTargetAtTime(uz, t, 0.03);
  }

  distanceToListener(x: number, y: number, z: number) {
    const dx = x - this.lx;
    const dy = y - this.ly;
    const dz = z - this.lz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Claim a voice and park it at a world position. Returns the node the caller
   * should render into, or null if the source is too far away to matter.
   *
   * A one-shot does not move, so the panner position is set, not ramped.
   */
  acquire(
    t: number,
    x: number,
    y: number,
    z: number,
    gain: number,
    expectedLength: number,
  ): GainNode | null {
    if (this.distanceToListener(x, y, z) > CULL_DISTANCE) return null;
    let pick: OneShotVoice | null = null;
    const n = this.voices.length;
    for (let i = 0; i < n; i++) {
      const v = this.voices[(this.cursor + i) % n]!;
      if (v.busyUntil <= t) {
        pick = v;
        this.cursor = (this.cursor + i + 1) % n;
        break;
      }
    }
    if (!pick) {
      // Everything is busy: steal whichever voice is closest to finishing, so
      // the truncation lands on the most decayed tail in the pool.
      let best = this.voices[0]!;
      for (let i = 1; i < n; i++) {
        if (this.voices[i]!.busyUntil < best.busyUntil) best = this.voices[i]!;
      }
      pick = best;
    }
    pick.busyUntil = t + Math.max(0.05, expectedLength);
    pick.input.gain.setValueAtTime(Math.max(0.0001, gain), t);
    pannerPos(pick.panner, x, y, z, t, 0);
    return pick.input;
  }

  /**
   * `data` is a flat [x, y, z, rpm01, load, id] × count buffer owned by the
   * caller — the nearest few rivals, in whatever slot order the caller's
   * selection produced. Reusing one array keeps this path allocation-free.
   * `id` is what identifies a reassignment; slot index alone would not, because
   * the same slot legitimately keeps the same car across frames.
   */
  updateOpponents(t: number, dt: number, data: Float32Array, count: number) {
    for (let i = 0; i < this.drones.length; i++) {
      const d = this.drones[i]!;
      if (i >= count) {
        if (d.id !== -1) {
          d.id = -1;
          d.level.gain.setTargetAtTime(0, t, 0.12);
        }
        continue;
      }
      const b = i * OPPONENT_STRIDE;
      const x = data[b]!;
      const y = data[b + 1]!;
      const z = data[b + 2]!;
      const rpm01 = data[b + 3]!;
      const load = data[b + 4]!;
      const id = data[b + 5]!;

      const dist = this.distanceToListener(x, y, z);
      const fresh = id !== d.id;
      if (fresh) {
        // Reassignment is a hard cut in space. Snap the panner and re-open the
        // level from silence rather than sliding a running drone across the map.
        d.id = id;
        d.prevDist = dist;
        pannerPos(d.panner, x, y, z, t, 0);
        d.level.gain.cancelScheduledValues(t);
        d.level.gain.setValueAtTime(0.0001, t);
      } else {
        pannerPos(d.panner, x, y, z, t, 0.03);
      }

      // Web Audio dropped doppler with `setVelocity`, but the pass-by is most of
      // what sells a rival going past, so it is applied to the source pitch.
      const closing = dt > 1e-4 ? (d.prevDist - dist) / dt : 0;
      d.prevDist = dist;
      const doppler = Math.max(0.88, Math.min(1.12, 1 + closing * 0.0016));

      const rpm = IDLE_RPM + (MAX_RPM - IDLE_RPM) * rpm01;
      d.osc.frequency.setTargetAtTime(rpm * FIRE_PER_RPM * doppler, t, 0.06);
      d.band.frequency.setTargetAtTime(280 + rpm01 * 1500, t, 0.08);
      d.level.gain.setTargetAtTime(0.1 + load * 0.16 + rpm01 * 0.06, t, 0.08);
    }
  }

  /** Silence the pack — heat over, or the player went back to the menu. */
  silenceOpponents(t: number) {
    for (const d of this.drones) {
      d.id = -1;
      d.level.gain.setTargetAtTime(0, t, 0.1);
    }
  }
}
