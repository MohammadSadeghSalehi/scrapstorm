/**
 * Hybrid Web Audio mixer for Scrapstorm:
 * - ElevenLabs-generated MP3 bank (original SFX + music + announcer VO)
 * - Procedural engine / scrub / wind layers for continuous feel
 *
 * Buses: destination ← limiter ← master ← music (→ duck) / sfx / ui / vo
 */

import {
  preloadSamples,
  playSample,
  hasSample,
  loadVoice,
  type MusicId,
  type VoiceId,
} from "./SampleBank";

export type AudioBus = "master" | "music" | "sfx" | "ui" | "vo";

type Ctx = AudioContext;

function ramp(g: GainNode, v: number, t: number, tau = 0.04) {
  g.gain.setTargetAtTime(Math.max(0, v), t, tau);
}

/**
 * Start a deterministic ramp from wherever the param currently sits.
 * Needed because the buses are otherwise driven by `setTargetAtTime`, and an
 * exponential approach left running under a crossfade makes the fade curve
 * unpredictable.
 */
function rampFrom(p: AudioParam, t: number, to: number, dur: number) {
  p.cancelScheduledValues(t);
  p.setValueAtTime(p.value, t);
  p.linearRampToValueAtTime(Math.max(0.0001, to), t + Math.max(0.01, dur));
}

function jitter(n = 0.08) {
  return 1 + (Math.random() * 2 - 1) * n;
}

/** Per-track trim so the beds sit at comparable loudness. */
function musicTrackVolume(id: MusicId) {
  return id === "race_heat" ? 0.55 : id === "victory" ? 0.7 : 0.5;
}

/**
 * Announcer barge-in ranking. A line only interrupts a line of *lower* rank;
 * anything equal or below is dropped rather than queued (see `playVoice`).
 */
const VOICE_PRIORITY: Record<VoiceId, number> = {
  "grid-locked": 3,
  green: 3,
  "final-lap": 3,
  win: 3,
  loss: 3,
  wreck: 2,
  overtake: 2,
  "lap-1": 2,
  "lap-2": 2,
  "hit-1": 1,
  "hit-2": 1,
  "boost-1": 1,
  "boost-2": 1,
};

/**
 * Chatter variants share a cooldown key, so "hit-1"/"hit-2" can't ping-pong
 * every time the player trades paint in a pack.
 */
const VOICE_GROUP: Partial<Record<VoiceId, string>> = {
  "hit-1": "hit",
  "hit-2": "hit",
  "boost-1": "boost",
  "boost-2": "boost",
  "lap-1": "lap",
  "lap-2": "lap",
};

/** Seconds before a group may speak again. */
const VOICE_COOLDOWN: Record<string, number> = {
  hit: 8,
  boost: 11,
  lap: 3,
  overtake: 10,
  wreck: 4,
};
const VOICE_COOLDOWN_DEFAULT = 1.5;

/** Assumed line length while the mp3 is still decoding. */
const VOICE_PROVISIONAL_LEN = 1.4;

/** Chatter that took longer than this to fetch is no longer worth playing. */
const VOICE_STALE_AFTER = 1.5;

class AudioEngine {
  private ctx: Ctx | null = null;
  private unlocked = false;
  private master: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private musicBus: GainNode | null = null;
  /** Sits after musicBus so ducking never fights the user's music volume. */
  private musicDuck: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private uiBus: GainNode | null = null;
  private voBus: GainNode | null = null;

  // Engine stack: fundamental + harmonic + sub + noise grit
  private engineOsc: OscillatorNode | null = null;
  private engineOsc2: OscillatorNode | null = null;
  private engineSub: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineGrit: GainNode | null = null;

  private scrubNoise: AudioBufferSourceNode | null = null;
  private scrubGain: GainNode | null = null;
  private scrubFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private squealGain: GainNode | null = null;
  private squealOsc: OscillatorNode | null = null;

  private musicNodes: { osc: OscillatorNode; gain: GainNode }[] = [];
  private musicPulse: OscillatorNode | null = null;
  private musicPulseGain: GainNode | null = null;

  private muted = false;
  private volumes = { master: 0.88, music: 0.3, sfx: 0.78, ui: 0.58, vo: 0.95 };

  private lastEventAt = 0;
  private lastEventMsg = "";
  private lastGear = 0;
  private lastImpactAt = 0;
  /** Currently sounding music track + its own fader (for real crossfades). */
  private musicTrack: {
    src: AudioBufferSourceNode;
    gain: GainNode;
  } | null = null;
  private musicId: MusicId | null = null;
  private musicGain: GainNode | null = null;
  /** Track requested before the bank finished decoding; started on arrival. */
  private pendingMusic: { id: MusicId; fade: number } | null = null;
  private samplesReady = false;

  private duckDepth = 0;
  private duckReleaseAt = 0;

  private voNode: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private voPriority = 0;
  /** Wall-clock (ctx time) the announcer is expected to stop talking. */
  private voBusyUntil = 0;
  private voToken = 0;
  private voCooldowns = new Map<string, number>();

  isUnlocked() {
    return this.unlocked;
  }

  getMuted() {
    return this.muted;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master) {
      // Squared to match the curve setVolume/unlock use — unmuting used to
      // restore the raw slider value and jump the mix ~2 dB louder.
      const v = this.volumes.master;
      ramp(this.master, m ? 0 : v * v, this.now(), 0.02);
    }
  }

  private busNode(bus: AudioBus): GainNode | null {
    if (bus === "master") return this.master;
    if (bus === "music") return this.musicBus;
    if (bus === "sfx") return this.sfxBus;
    if (bus === "vo") return this.voBus;
    return this.uiBus;
  }

  setVolume(bus: AudioBus, v: number) {
    const x = Math.max(0, Math.min(1, v));
    this.volumes[bus] = x;
    const g = this.busNode(bus);
    if (g) ramp(g, bus === "master" && this.muted ? 0 : x * x, this.now());
  }

  private now() {
    return this.ctx?.currentTime ?? 0;
  }

  unlock() {
    if (typeof window === "undefined") return;
    if (!this.ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.ctx = new AC({ latencyHint: "interactive" });
      this.master = this.ctx.createGain();
      this.musicBus = this.ctx.createGain();
      this.musicDuck = this.ctx.createGain();
      this.sfxBus = this.ctx.createGain();
      this.uiBus = this.ctx.createGain();
      this.voBus = this.ctx.createGain();
      // Music routes through its own duck stage, so VO/impact ducking and the
      // music volume slider can move independently.
      this.musicBus.connect(this.musicDuck);
      this.musicDuck.connect(this.master);
      this.sfxBus.connect(this.master);
      this.uiBus.connect(this.master);
      this.voBus.connect(this.master);

      // Brick-wall-ish limiter on the way out. Engine + scrub + wind run
      // continuously, so a wreck stacking four one-shots on top used to clip
      // the destination hard.
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -3;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.25;
      this.master.connect(this.limiter);
      this.limiter.connect(this.ctx.destination);

      this.master.gain.value = this.volumes.master * this.volumes.master;
      this.musicBus.gain.value = this.volumes.music * this.volumes.music;
      this.musicDuck.gain.value = 1;
      this.sfxBus.gain.value = this.volumes.sfx * this.volumes.sfx;
      this.uiBus.gain.value = this.volumes.ui * this.volumes.ui;
      this.voBus.gain.value = this.volumes.vo * this.volumes.vo;
      this.buildEngine();
      this.buildScrub();
      this.buildMusicBed();
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 1;
      this.musicGain.connect(this.musicBus!);
      void preloadSamples(this.ctx).then(() => {
        this.samplesReady = true;
        // The menu bed is requested on the very first frame, long before the
        // bank decodes — replay the last request instead of dropping it.
        const p = this.pendingMusic;
        if (p) {
          this.pendingMusic = null;
          this.playMusic(p.id, p.fade);
        }
      });
    }
    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
    this.unlocked = true;
  }

  /** Crossfade looped music beds (menu / race / victory) */
  playMusic(id: MusicId, fade = 0.6) {
    if (!this.ctx || !this.unlocked || !this.musicGain) return;
    if (this.musicId === id && this.musicTrack) return;
    // Don't claim the id until we know we can actually play it, otherwise a
    // request made before the bank decoded would be remembered as "playing"
    // and never retried.
    if (!hasSample(`music:${id}`)) {
      this.pendingMusic = { id, fade };
      return;
    }
    this.pendingMusic = null;
    this.musicId = id;
    const ctx = this.ctx;
    const t = this.now();
    const f = Math.max(0.05, fade);

    // Genuine crossfade: the outgoing track rides its own fader down over the
    // same window the new one rides up. Previously the old source was just
    // stopped at t+fade at full level, which is an audible hard cut.
    this.fadeOutTrack(this.musicTrack, t, f);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.connect(this.musicGain);
    const src = playSample(ctx, gain, `music:${id}`, {
      vol: musicTrackVolume(id),
      loop: id !== "victory",
    });
    if (!src) {
      gain.disconnect();
      this.musicTrack = null;
      return;
    }
    gain.gain.linearRampToValueAtTime(1, t + f);
    const track = { src, gain };
    this.musicTrack = track;
    src.onended = () => {
      try { gain.disconnect(); } catch { /* already torn down */ }
      if (this.musicTrack === track) {
        this.musicTrack = null;
        this.musicId = null;
      }
    };
  }

  /** Ramp a track out and release its nodes once the source actually ends. */
  private fadeOutTrack(
    track: { src: AudioBufferSourceNode; gain: GainNode } | null,
    t: number,
    fade: number,
  ) {
    if (!track) return;
    rampFrom(track.gain.gain, t, 0.0001, fade);
    track.src.onended = () => {
      try { track.gain.disconnect(); } catch { /* already torn down */ }
    };
    try { track.src.stop(t + fade + 0.05); } catch { /* already stopped */ }
  }

  stopMusic(fade = 0.4) {
    const track = this.musicTrack;
    this.musicTrack = null;
    this.musicId = null;
    this.pendingMusic = null;
    if (!track || !this.ctx) return;
    this.fadeOutTrack(track, this.now(), Math.max(0.05, fade));
  }

  /**
   * Pull the music bed down under the announcer / heavy metal, then restore.
   * Overlapping ducks keep the deeper level and the later release so a hit
   * landing mid-line can't pop the music back up over the VO.
   */
  duckMusic(depth: number, hold: number, attack = 0.08, release = 0.5) {
    if (!this.ctx || !this.musicDuck) return;
    const t = this.now();
    const active = t < this.duckReleaseAt;
    const d = Math.max(0, Math.min(0.9, Math.max(depth, active ? this.duckDepth : 0)));
    const releaseAt = Math.max(
      t + attack + 0.02,
      t + Math.max(0, hold),
      active ? this.duckReleaseAt : 0,
    );
    if (active && d === this.duckDepth && releaseAt <= this.duckReleaseAt) return;
    this.duckDepth = d;
    this.duckReleaseAt = releaseAt;
    const p = this.musicDuck.gain;
    const level = Math.max(0.0001, 1 - d);
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(level, t + attack);
    p.setValueAtTime(level, releaseAt);
    p.linearRampToValueAtTime(1, releaseAt + release);
  }

  /**
   * Announcer line. Loads `/assets/audio/vo/<id>.mp3` on first use.
   *
   * Overlap policy is barge-in, never a queue: race VO is only worth hearing
   * while the moment is still on screen, so a higher-priority line cuts the
   * current one (with a short de-click fade) and a same/lower-priority line is
   * dropped outright rather than played seconds late.
   */
  playVoice(id: VoiceId) {
    if (!this.ctx || !this.unlocked || !this.voBus) return;
    const ctx = this.ctx;
    const t = this.now();
    const prio = VOICE_PRIORITY[id] ?? 1;
    const group = VOICE_GROUP[id] ?? id;
    if (t < (this.voCooldowns.get(group) ?? 0)) return;
    if (t < this.voBusyUntil && prio <= this.voPriority) return;
    this.voCooldowns.set(
      group,
      t + (VOICE_COOLDOWN[group] ?? VOICE_COOLDOWN_DEFAULT),
    );
    // Claim the channel synchronously — the decode below is async, and two
    // events in the same frame must not both think they won.
    this.voPriority = prio;
    this.voBusyUntil = t + VOICE_PROVISIONAL_LEN;
    const token = ++this.voToken;
    void loadVoice(ctx, id)
      .then((buf) => {
        if (token !== this.voToken) return;
        // Missing mp3, or the first fetch took so long the moment is gone —
        // release the channel rather than reacting to something the player has
        // already forgotten. Race-critical calls (green/final lap/result) are
        // still worth a late delivery.
        if (!buf || (prio < 3 && this.now() - t > VOICE_STALE_AFTER)) {
          this.voBusyUntil = 0;
          this.voPriority = 0;
          return;
        }
        this.startVoice(id, prio, buf.duration);
      })
      .catch(() => {
        if (token !== this.voToken) return;
        this.voBusyUntil = 0;
        this.voPriority = 0;
      });
  }

  private startVoice(id: VoiceId, prio: number, duration: number) {
    if (!this.ctx || !this.voBus) return;
    const ctx = this.ctx;
    const t = this.now();
    this.stopVoice();
    const gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(this.voBus);
    const src = playSample(ctx, gain, `vo:${id}`, { vol: 1 });
    if (!src) {
      gain.disconnect();
      this.voBusyUntil = 0;
      this.voPriority = 0;
      return;
    }
    const node = { src, gain };
    this.voNode = node;
    this.voPriority = prio;
    this.voBusyUntil = t + duration;
    src.onended = () => {
      try { gain.disconnect(); } catch { /* already torn down */ }
      if (this.voNode === node) {
        this.voNode = null;
        this.voPriority = 0;
      }
    };
    // Hold the music under the whole line plus a beat of tail.
    this.duckMusic(0.6, duration + 0.15);
  }

  /** Cut the current line with a 40 ms fade — long enough to avoid a click. */
  private stopVoice(fade = 0.04) {
    const node = this.voNode;
    this.voNode = null;
    if (!node || !this.ctx) return;
    const t = this.now();
    rampFrom(node.gain.gain, t, 0.0001, fade);
    node.src.onended = () => {
      try { node.gain.disconnect(); } catch { /* already torn down */ }
    };
    try { node.src.stop(t + fade + 0.02); } catch { /* already stopped */ }
  }

  private oneshot(sfxKey: string, vol = 0.75, rate = 1) {
    if (!this.ctx || !this.sfxBus) return false;
    if (!hasSample(`sfx:${sfxKey}`)) return false;
    playSample(this.ctx, this.sfxBus, `sfx:${sfxKey}`, {
      vol: vol * (0.9 + Math.random() * 0.2),
      rate: rate * (0.96 + Math.random() * 0.08),
    });
    return true;
  }

  resumeIfNeeded() {
    if (this.ctx?.state === "suspended") void this.ctx.resume();
  }

  private noiseBuffer(seconds = 1): AudioBuffer {
    const ctx = this.ctx!;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      // pink-ish noise
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      d[i] = white * 0.55 + last * 0.45;
    }
    return buf;
  }

  private buildEngine() {
    const ctx = this.ctx!;
    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = "sawtooth";
    this.engineOsc2 = ctx.createOscillator();
    this.engineOsc2.type = "square";
    this.engineSub = ctx.createOscillator();
    this.engineSub.type = "sine";

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = 400;
    this.engineFilter.Q.value = 0.9;

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineGrit = ctx.createGain();
    this.engineGrit.gain.value = 0.0;

    const mix = ctx.createGain();
    mix.gain.value = 0.55;
    const mix2 = ctx.createGain();
    mix2.gain.value = 0.18;
    const mixSub = ctx.createGain();
    mixSub.gain.value = 0.28;

    this.engineOsc.connect(mix);
    this.engineOsc2.connect(mix2);
    this.engineSub.connect(mixSub);
    mix.connect(this.engineFilter);
    mix2.connect(this.engineFilter);
    mixSub.connect(this.engineGain);
    this.engineFilter.connect(this.engineGain);

    // grit = filtered noise
    const gritSrc = ctx.createBufferSource();
    gritSrc.buffer = this.noiseBuffer(1.5);
    gritSrc.loop = true;
    const gritF = ctx.createBiquadFilter();
    gritF.type = "bandpass";
    gritF.frequency.value = 700;
    gritF.Q.value = 0.6;
    gritSrc.connect(gritF);
    gritF.connect(this.engineGrit);
    this.engineGrit.connect(this.engineGain);

    this.engineGain.connect(this.sfxBus!);
    this.engineOsc.start();
    this.engineOsc2.start();
    this.engineSub.start();
    gritSrc.start();
  }

  private buildScrub() {
    const ctx = this.ctx!;
    this.scrubNoise = ctx.createBufferSource();
    this.scrubNoise.buffer = this.noiseBuffer(2);
    this.scrubNoise.loop = true;
    this.scrubFilter = ctx.createBiquadFilter();
    this.scrubFilter.type = "bandpass";
    this.scrubFilter.frequency.value = 900;
    this.scrubFilter.Q.value = 0.7;
    this.scrubGain = ctx.createGain();
    this.scrubGain.gain.value = 0;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    const windFilt = ctx.createBiquadFilter();
    windFilt.type = "highpass";
    windFilt.frequency.value = 1200;
    this.scrubNoise.connect(this.scrubFilter);
    this.scrubFilter.connect(this.scrubGain);
    this.scrubGain.connect(this.sfxBus!);

    const windSrc = ctx.createBufferSource();
    windSrc.buffer = this.noiseBuffer(2);
    windSrc.loop = true;
    windSrc.connect(windFilt);
    windFilt.connect(this.windGain);
    this.windGain.connect(this.sfxBus!);
    this.scrubNoise.start();
    windSrc.start();

    // Tire squeal oscillator
    this.squealOsc = ctx.createOscillator();
    this.squealOsc.type = "sawtooth";
    this.squealOsc.frequency.value = 880;
    const sqF = ctx.createBiquadFilter();
    sqF.type = "bandpass";
    sqF.frequency.value = 1400;
    sqF.Q.value = 4;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealOsc.connect(sqF);
    sqF.connect(this.squealGain);
    this.squealGain.connect(this.sfxBus!);
    this.squealOsc.start();
  }

  private buildMusicBed() {
    const ctx = this.ctx!;
    // Industrial pulse bed — root, fifth, octave + filtered pulse
    const notes = [48, 72, 96, 144];
    for (const f of notes) {
      const osc = ctx.createOscillator();
      osc.type = f < 60 ? "sine" : "triangle";
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.03;
      const filt = ctx.createBiquadFilter();
      filt.type = "lowpass";
      filt.frequency.value = 320;
      osc.connect(filt);
      filt.connect(g);
      g.connect(this.musicBus!);
      osc.start();
      this.musicNodes.push({ osc, gain: g });
    }
    this.musicPulse = ctx.createOscillator();
    this.musicPulse.type = "square";
    this.musicPulse.frequency.value = 2.2;
    this.musicPulseGain = ctx.createGain();
    this.musicPulseGain.gain.value = 0;
    // LFO-ish: modulate a mid pad
    const pad = ctx.createOscillator();
    pad.type = "sawtooth";
    pad.frequency.value = 110;
    const padG = ctx.createGain();
    padG.gain.value = 0.02;
    const padF = ctx.createBiquadFilter();
    padF.type = "lowpass";
    padF.frequency.value = 400;
    pad.connect(padF);
    padF.connect(padG);
    padG.connect(this.musicBus!);
    pad.start();
    this.musicNodes.push({ osc: pad, gain: padG });
  }

  updateContinuous(opts: {
    phase: string;
    speed: number;
    maxSpeed: number;
    throttle: number;
    drifting: boolean;
    slip: number;
    surface: string;
    boost: boolean;
    offroad: number;
    gear?: number;
    brake?: boolean;
  }) {
    if (!this.unlocked || !this.ctx || !this.engineOsc) return;
    const t = this.now();
    const racing =
      opts.phase === "racing" ||
      opts.phase === "countdown" ||
      opts.phase === "paused";
    const musicOn =
      opts.phase === "menu" ||
      opts.phase === "garage" ||
      opts.phase === "finished" ||
      racing;

    const raceHeat = opts.phase === "racing" ? 1 : 0.65;
    for (let i = 0; i < this.musicNodes.length; i++) {
      const m = this.musicNodes[i];
      const base = i < 3 ? 0.04 : 0.025;
      ramp(
        m.gain,
        musicOn ? base * raceHeat * (opts.boost ? 1.15 : 1) : 0,
        t,
        0.25,
      );
    }

    if (!racing) {
      ramp(this.engineGain!, 0, t, 0.08);
      ramp(this.scrubGain!, 0, t, 0.08);
      ramp(this.windGain!, 0, t, 0.1);
      ramp(this.squealGain!, 0, t, 0.05);
      ramp(this.engineGrit!, 0, t, 0.05);
      return;
    }

    const sp = Math.min(1, Math.abs(opts.speed) / Math.max(1, opts.maxSpeed));
    const thr = opts.throttle;
    // Gear-ish steps for RPM feel
    const gear = opts.gear ?? Math.min(5, Math.floor(sp * 5) + 1);
    if (gear !== this.lastGear && sp > 0.15 && thr > 0.3) {
      this.playSfx("gear");
      this.lastGear = gear;
    }
    this.lastGear = gear;
    const gearFrac = (sp * 5) % 1;
    // Punchier arcade engine: wider RPM band, throttle-weighted load
    const load = Math.max(thr, opts.boost ? 1 : 0, opts.drifting ? 0.55 : 0);
    const brake = opts.brake ? 1 : 0;
    const rpm =
      48 +
      gear * 36 +
      gearFrac * 110 +
      load * 95 +
      (opts.boost ? 95 : 0) +
      sp * 55 -
      brake * 35;

    this.engineOsc.frequency.setTargetAtTime(Math.max(40, rpm), t, 0.035);
    this.engineOsc2!.frequency.setTargetAtTime(Math.max(80, rpm * 2.03), t, 0.04);
    this.engineSub!.frequency.setTargetAtTime(Math.max(30, rpm * 0.48), t, 0.045);
    this.engineFilter!.frequency.setTargetAtTime(
      280 + sp * 2800 + load * 700 + (opts.boost ? 550 : 0) - brake * 200,
      t,
      0.045,
    );
    const engVol =
      0.045 +
      sp * 0.16 +
      load * 0.12 +
      (opts.boost ? 0.1 : 0) +
      (opts.drifting ? 0.04 : 0);
    ramp(this.engineGain!, engVol, t, 0.035);
    ramp(
      this.engineGrit!,
      0.025 + sp * 0.07 + load * 0.05 + (opts.drifting ? 0.04 : 0),
      t,
      0.05,
    );

    const slip = Math.max(
      opts.slip,
      opts.drifting ? 0.72 : 0,
      opts.offroad * 0.45,
    );
    const scrubF =
      opts.surface === "sand" || opts.surface === "deep"
        ? 480
        : opts.surface === "apron"
          ? 720
          : 1150;
    this.scrubFilter!.frequency.setTargetAtTime(scrubF + slip * 450, t, 0.08);
    ramp(
      this.scrubGain!,
      slip * 0.16 + (opts.drifting ? 0.1 : 0) + opts.offroad * 0.05 + (opts.brake ? 0.08 : 0),
      t,
      0.04,
    );
    ramp(this.windGain!, sp * sp * 0.12 + (opts.boost ? 0.05 : 0) + (opts.drifting ? 0.02 : 0), t, 0.08);

    // Squeal on hard drift / slip
    const sq = opts.drifting || slip > 0.55 ? Math.min(1, slip * 1.2) : 0;
    if (this.squealOsc) {
      this.squealOsc.frequency.setTargetAtTime(720 + sq * 900 + sp * 200, t, 0.05);
    }
    ramp(this.squealGain!, sq * 0.085 + (opts.drifting ? 0.03 : 0), t, 0.04);
  }

  private blip(
    bus: GainNode,
    freq: number,
    dur: number,
    type: OscillatorType = "square",
    vol = 0.12,
    slide = 0,
  ) {
    if (!this.ctx || !this.unlocked) return;
    const t = this.now();
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    const f0 = freq * jitter(0.04);
    osc.frequency.setValueAtTime(f0, t);
    if (slide)
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(40, f0 + slide),
        t + dur,
      );
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol * jitter(0.1), t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(bus);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  private noiseBurst(
    bus: GainNode,
    dur: number,
    vol = 0.15,
    hp = 400,
    lp = 8000,
  ) {
    if (!this.ctx || !this.unlocked) return;
    const t = this.now();
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer(Math.max(0.05, dur + 0.05));
    const f = this.ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = hp;
    const f2 = this.ctx.createBiquadFilter();
    f2.type = "lowpass";
    f2.frequency.value = lp;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol * jitter(0.12), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(f2);
    f2.connect(g);
    g.connect(bus);
    src.start(t);
    src.stop(t + dur + 0.03);
  }

  /** Layered impact: thump + metal + debris */
  private layeredHit(intensity = 1) {
    if (!this.sfxBus) return;
    const k = Math.max(0.35, Math.min(1.6, intensity));
    this.noiseBurst(this.sfxBus, 0.1 * k, 0.2 * k, 120, 4000);
    this.noiseBurst(this.sfxBus, 0.18 * k, 0.12 * k, 600, 9000);
    this.blip(this.sfxBus, 70 * k, 0.14 * k, "sawtooth", 0.11 * k, -30);
    this.blip(this.sfxBus, 220 * jitter(), 0.06, "square", 0.05 * k, -120);
  }

  playUi(
    kind:
      | "click"
      | "confirm"
      | "countdown"
      | "go"
      | "finish"
      | "pause"
      | "lap",
  ) {
    if (!this.uiBus) return;
    if (kind === "click") {
      if (this.oneshot("ui_click", 0.55)) return;
      this.blip(this.uiBus, 680, 0.05, "triangle", 0.07);
    }
    if (kind === "confirm") {
      if (this.oneshot("ui_confirm", 0.6)) return;
      this.blip(this.uiBus, 440, 0.1, "triangle", 0.1, 240);
    }
    if (kind === "countdown") {
      if (this.oneshot("countdown", 0.65)) return;
      this.blip(this.uiBus, 520, 0.11, "square", 0.1);
    }
    if (kind === "go") {
      if (this.oneshot("go", 0.8)) return;
      this.blip(this.uiBus, 330, 0.22, "sawtooth", 0.13, 450);
    }
    if (kind === "finish") {
      this.playMusic("victory");
      this.oneshot("crowd_cheer", 0.55);
      if (this.oneshot("finish", 0.85)) return;
      this.blip(this.uiBus, 392, 0.28, "triangle", 0.12, 200);
    }
    if (kind === "pause") this.blip(this.uiBus, 280, 0.08, "sine", 0.08);
    if (kind === "lap") {
      if (this.oneshot("lap", 0.7)) return;
      this.blip(this.uiBus, 740, 0.1, "triangle", 0.09, 180);
    }
  }

  playSfx(
    kind:
      | "fire"
      | "cannon"
      | "disc"
      | "hit"
      | "boost"
      | "defense"
      | "ult"
      | "mine"
      | "wreck"
      | "turbo"
      | "gear"
      | "prop"
      | "land"
      | "whoosh"
      | "drift"
      | "scrape",
  ) {
    if (!this.sfxBus) return;
    if (kind === "fire") {
      if (this.oneshot("weapon_laser", 0.7)) return;
      this.noiseBurst(this.sfxBus, 0.07, 0.14, 900, 10000);
      this.blip(this.sfxBus, 980 * jitter(), 0.06, "square", 0.06, -420);
    }
    if (kind === "cannon") {
      if (this.oneshot("weapon_cannon", 0.85)) return;
      this.noiseBurst(this.sfxBus, 0.2, 0.22, 80, 2500);
      this.blip(this.sfxBus, 100, 0.22, "sawtooth", 0.14, -50);
    }
    if (kind === "disc") {
      this.blip(this.sfxBus, 1500 * jitter(), 0.12, "square", 0.08, -1000);
      this.noiseBurst(this.sfxBus, 0.08, 0.06, 2000);
    }
    if (kind === "hit") {
      if (this.oneshot("impact_metal", 0.85)) return;
      this.layeredHit(1);
    }
    if (kind === "prop") {
      if (this.oneshot("prop_smash", 0.8)) return;
      this.noiseBurst(this.sfxBus, 0.1, 0.14, 200, 5000);
    }
    if (kind === "boost" || kind === "turbo" || kind === "whoosh") {
      if (this.oneshot("nitro_ignition", 0.75) || this.oneshot("boost", 0.8)) {
        this.oneshot("turbo_release", 0.45);
        this.oneshot("whoosh", 0.3);
        return;
      }
      this.blip(this.sfxBus, 180, 0.28, "sawtooth", 0.11, 620);
      this.noiseBurst(this.sfxBus, 0.22, 0.12, 500, 9000);
    }
    if (kind === "defense") {
      if (this.oneshot("shield", 0.75)) return;
      this.blip(this.sfxBus, 620, 0.16, "sine", 0.1, 320);
    }
    if (kind === "ult") {
      this.noiseBurst(this.sfxBus, 0.35, 0.2, 60, 3000);
      this.blip(this.sfxBus, 150, 0.4, "sawtooth", 0.13, 280);
      this.blip(this.sfxBus, 300, 0.25, "square", 0.06, 100);
    }
    if (kind === "mine") this.blip(this.sfxBus, 170, 0.1, "square", 0.08);
    if (kind === "wreck") {
      if (this.oneshot("wreck", 0.9)) return;
      this.layeredHit(1.5);
      this.noiseBurst(this.sfxBus, 0.45, 0.22, 50, 2000);
    }
    if (kind === "gear") {
      if (this.oneshot("gear", 0.45)) return;
      this.blip(this.sfxBus, 180 * jitter(0.05), 0.04, "square", 0.04);
    }
    if (kind === "land") {
      this.noiseBurst(this.sfxBus, 0.08, 0.1, 100, 2000);
      this.blip(this.sfxBus, 90, 0.08, "triangle", 0.06, -20);
    }
    if (kind === "drift") {
      if (this.oneshot("drift_squeal", 0.65) || this.oneshot("slide_screech", 0.55)) return;
      this.noiseBurst(this.sfxBus, 0.14, 0.12, 600, 5000);
      this.blip(this.sfxBus, 900 * jitter(), 0.12, "sawtooth", 0.06, -200);
    }
    if (kind === "scrape") {
      if (this.oneshot("metal_scrape", 0.4) || this.oneshot("slide_screech", 0.35)) return;
      this.noiseBurst(this.sfxBus, 0.1, 0.08, 400, 3500);
    }
  }

  /** Collision impact with rate limit + intensity */
  playImpact(intensity = 1) {
    const now = performance.now();
    if (now - this.lastImpactAt < 45) return;
    this.lastImpactAt = now;
    // Heavy metal reads better with the bed pulled out from under it; light
    // scrapes are frequent enough that ducking them would pump the music.
    if (intensity >= 1.1) {
      this.duckMusic(Math.min(0.45, 0.2 + intensity * 0.16), 0.18, 0.03, 0.4);
    }
    if (intensity < 0.7 && this.oneshot("impact_light", 0.55 + intensity * 0.3)) return;
    if (this.oneshot("impact_metal", Math.min(1, 0.5 + intensity * 0.4))) return;
    this.layeredHit(intensity);
  }

  feedEvent(msg: string, kind?: string) {
    if (!this.unlocked) return;
    const t = performance.now();
    if (msg === this.lastEventMsg && t - this.lastEventAt < 70) return;
    this.lastEventMsg = msg;
    this.lastEventAt = t;
    const m = msg.toLowerCase();
    if (m.includes("wreck") || m.includes("eliminated")) this.playSfx("wreck");
    else if (m.includes("hit") || m.includes("ram") || m.includes("damage"))
      this.playImpact(1.1);
    else if (
      m.includes("boost") ||
      m.includes("turbo") ||
      m.includes("overdrive")
    )
      this.playSfx("turbo");
    else if (m.includes("mine")) this.playSfx("mine");
    else if (
      m.includes("shield") ||
      m.includes("phase") ||
      m.includes("plate") ||
      m.includes("decoy")
    )
      this.playSfx("defense");
    else if (m.includes("lap")) this.playUi("lap");
    else if (
      m.includes("finish") ||
      m.includes("victory") ||
      m.includes("p1")
    )
      this.playUi("finish");
    else if (kind === "fire") this.playSfx("fire");
  }
}

export const audioEngine = new AudioEngine();

export function installAudioUnlock() {
  if (typeof window === "undefined") return () => {};
  const unlock = () => {
    audioEngine.unlock();
    audioEngine.resumeIfNeeded();
  };
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });
  const onVis = () => {
    if (document.visibilityState === "visible") audioEngine.resumeIfNeeded();
  };
  document.addEventListener("visibilitychange", onVis);
  return () => document.removeEventListener("visibilitychange", onVis);
}
