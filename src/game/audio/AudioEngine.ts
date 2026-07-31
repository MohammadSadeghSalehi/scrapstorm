/**
 * Hybrid Web Audio mixer for Scrapstorm:
 * - ElevenLabs-generated MP3 bank (original SFX + music + announcer VO)
 * - Procedural engine / tyre / wind layers for continuous feel
 * - Positional one-shots and opponent drones through a pooled panner field
 *
 * Buses:
 *   destination ← limiter ← master ← music (→ duck) / sfx / ui / vo
 *   sfx ← sfxDry (non-positional) + spatial (panned) + reverb return
 *   reverb send ← spatial (post-pan, so the room hears where it came from)
 *                 + nearSend (engine, tyres, dry one-shots at a trim)
 *
 * UI deliberately bypasses the reverb: menu clicks are not in the world.
 */

import {
  preloadSamples,
  playSample,
  hasSample,
  loadVoice,
  type MusicId,
  type VoiceId,
} from "./SampleBank";
import { EngineVoice, type EngineInput } from "./engineModel";
import { TyreBed, type TyreInput } from "./tyreModel";
import { SpatialField } from "./spatial";
import { ReverbRack, zoneForSurface, type ReverbZoneId } from "./reverb";
import { noiseOffset, sharedNoise } from "./noise";
import type { AudioCue } from "./cues";
import type { SurfaceInfo } from "../types";

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

export interface ContinuousInput {
  phase: string;
  speed: number;
  maxSpeed: number;
  throttle: number;
  drifting: boolean;
  slip: number;
  boost: boolean;
  offroad: number;
  /** `SurfaceInfo.roughness` under the car; the tyre bed slews toward it. */
  roughness: number;
  gear?: number;
  brake?: boolean;
  dt: number;
}

/** Frozen "engine off" states, so the idle path allocates nothing either. */
const ENGINE_OFF: EngineInput = {
  active: false,
  speed01: 0,
  throttle: 0,
  brake: false,
  boost: false,
  drifting: false,
  gear: 1,
  gearFrac: 0,
  dt: 1 / 60,
};

const TYRE_OFF: TyreInput = {
  active: false,
  speed01: 0,
  slip: 0,
  drifting: false,
  brake: false,
  boost: false,
  offroad: 0,
  roughness: 0.08,
  dt: 1 / 60,
};

/**
 * Sim-emitted cue → sample key, procedural fallback and mix weight.
 * `gate` is the minimum spacing in ms between two cues of the same kind: a pack
 * of five AI cars all holding the trigger would otherwise stack the same shot
 * on top of itself and read as a single loud buzz.
 */
const CUE_SFX: Record<
  string,
  { key: string; vol: number; rate: number; gate: number; len: number }
> = {
  "fire-bolt": { key: "weapon_laser", vol: 0.62, rate: 1, gate: 55, len: 0.45 },
  "fire-cannon": { key: "weapon_cannon", vol: 0.8, rate: 1, gate: 80, len: 0.7 },
  "fire-disc": { key: "weapon_laser", vol: 0.5, rate: 0.72, gate: 70, len: 0.5 },
  "hit-bolt": { key: "impact_light", vol: 0.6, rate: 1.08, gate: 40, len: 0.4 },
  "hit-cannon": { key: "impact_metal", vol: 0.85, rate: 0.92, gate: 45, len: 0.7 },
  "hit-disc": { key: "impact_light", vol: 0.66, rate: 1.18, gate: 40, len: 0.4 },
  "shell-land": { key: "prop_smash", vol: 0.4, rate: 0.85, gate: 90, len: 0.4 },
  "mine-blast": { key: "wreck", vol: 0.7, rate: 1.1, gate: 60, len: 0.9 },
  "mine-drop": { key: "gear", vol: 0.35, rate: 0.7, gate: 120, len: 0.3 },
  defense: { key: "shield", vol: 0.6, rate: 1, gate: 110, len: 0.6 },
  ult: { key: "nitro_ignition", vol: 0.7, rate: 0.85, gate: 200, len: 0.9 },
};

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
  /** Non-positional SFX. Split out of sfxBus so it can feed the reverb send. */
  private sfxDry: GainNode | null = null;
  /** Pooled panner voices land here; also the reverb's main feed. */
  private spatialBus: GainNode | null = null;
  private nearSend: GainNode | null = null;

  private engine: EngineVoice | null = null;
  private tyres: TyreBed | null = null;
  /** Reused every frame — see updateContinuous. */
  private engineIn: EngineInput = { ...ENGINE_OFF };
  private tyreIn: TyreInput = { ...TYRE_OFF };
  private spatial: SpatialField | null = null;
  private reverb: ReverbRack | null = null;
  private reverbZone: ReverbZoneId | null = null;

  private musicNodes: { osc: OscillatorNode; gain: GainNode }[] = [];
  private musicPulse: OscillatorNode | null = null;
  private musicPulseGain: GainNode | null = null;

  private muted = false;
  private volumes = { master: 0.88, music: 0.3, sfx: 0.78, ui: 0.58, vo: 0.95 };

  private lastEventAt = 0;
  private lastEventMsg = "";
  private lastGear = 0;
  private lastImpactAt = 0;
  /** Per-kind gates for sim-emitted cues (see playCue). */
  private cueGate = new Map<string, number>();
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

      // Brick-wall-ish limiter on the way out. Engine + tyre + wind run
      // continuously, so a wreck stacking four one-shots on top used to clip
      // the destination hard. It now also catches the reverb return.
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

      // Reverb return lands on the SFX bus, so the sfx slider moves the room
      // with the sources rather than leaving a wet ghost behind.
      this.reverb = new ReverbRack(this.ctx, this.sfxBus);
      // Transients want the room; sustained beds do not. Convolving a
      // continuously sounding engine and tyre bed with a 2 s canyon tail at any
      // real send level turns the whole mix into a wash, because there is never
      // a gap for the tail to be heard in. One-shots are the opposite — a shot
      // in the cut should ring. Hence two send trims, not one.
      this.nearSend = this.ctx.createGain();
      this.nearSend.gain.value = 0.6;
      this.nearSend.connect(this.reverb.input);
      const bedSend = this.ctx.createGain();
      bedSend.gain.value = 0.2;
      bedSend.connect(this.reverb.input);

      this.sfxDry = this.ctx.createGain();
      this.sfxDry.gain.value = 1;
      this.sfxDry.connect(this.sfxBus);
      this.sfxDry.connect(this.nearSend);

      this.spatialBus = this.ctx.createGain();
      this.spatialBus.gain.value = 1;
      this.spatialBus.connect(this.sfxBus);
      // Post-pan, so the room hears which side the source was on.
      this.spatialBus.connect(this.reverb.input);
      this.spatial = new SpatialField(this.ctx, this.spatialBus);

      this.engine = new EngineVoice(this.ctx, [this.sfxBus, bedSend]);
      this.tyres = new TyreBed(this.ctx, [this.sfxBus, bedSend]);
      // Start dry-ish and let the first surface query pick the real zone.
      this.reverb.setZone("open", 0.1, this.now(), 0.05);
      this.reverbZone = "open";
      this.reverb.prewarm(["canyon", "stadium", "scrapyard"]);
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
    this.reverb?.duck(0.55, duration + 0.1, t);
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

  private oneshot(sfxKey: string, vol = 0.75, rate = 1, bus?: AudioNode) {
    if (!this.ctx || !this.sfxDry) return false;
    if (!hasSample(`sfx:${sfxKey}`)) return false;
    playSample(this.ctx, bus ?? this.sfxDry, `sfx:${sfxKey}`, {
      vol: vol * (0.9 + Math.random() * 0.2),
      rate: rate * (0.96 + Math.random() * 0.08),
    });
    return true;
  }

  resumeIfNeeded() {
    if (this.ctx?.state === "suspended") void this.ctx.resume();
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

  /**
   * Per-frame continuous mix. The caller owns and reuses `opts` — this runs on
   * the render thread every frame and must not be handed a fresh literal.
   */
  updateContinuous(opts: ContinuousInput) {
    if (!this.unlocked || !this.ctx || !this.engine || !this.tyres) return;
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

    const sp = Math.min(1, Math.abs(opts.speed) / Math.max(1, opts.maxSpeed));
    const dt = Math.max(1 / 480, Math.min(0.1, opts.dt));

    if (!racing) {
      this.engine.update(t, ENGINE_OFF);
      this.tyres.update(t, TYRE_OFF);
      return;
    }

    const gear = opts.gear ?? Math.min(5, Math.floor(sp * 5) + 1);
    if (gear !== this.lastGear && sp > 0.15 && opts.throttle > 0.3) {
      this.playSfx("gear");
    }
    this.lastGear = gear;

    const eng = this.engineIn;
    eng.active = true;
    eng.speed01 = sp;
    eng.throttle = opts.throttle;
    eng.brake = !!opts.brake;
    eng.boost = opts.boost;
    eng.drifting = opts.drifting;
    eng.gear = gear;
    eng.gearFrac = (sp * 5) % 1;
    eng.dt = dt;
    this.engine.update(t, eng);

    const ty = this.tyreIn;
    ty.active = true;
    ty.speed01 = sp;
    ty.slip = opts.slip;
    ty.drifting = opts.drifting;
    ty.brake = !!opts.brake;
    ty.boost = opts.boost;
    ty.offroad = opts.offroad;
    ty.roughness = opts.roughness;
    ty.dt = dt;
    this.tyres.update(t, ty);
  }

  /**
   * Camera pose → Web Audio listener. Must be called after the chase camera has
   * been posed for the frame, or every panned source lags a frame behind.
   */
  updateListener(
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
    if (!this.spatial || !this.unlocked) return;
    this.spatial.updateListener(this.now(), x, y, z, fx, fy, fz, ux, uy, uz);
  }

  /**
   * Opponent engine drones. `data` is a caller-owned flat buffer of
   * [x, y, z, rpm01, load, id] tuples sorted nearest-first; see OPPONENT_STRIDE.
   */
  updateOpponents(data: Float32Array, count: number, dt: number) {
    if (!this.spatial || !this.unlocked) return;
    this.spatial.updateOpponents(this.now(), dt, data, count);
  }

  silenceOpponents() {
    if (!this.spatial || !this.unlocked) return;
    this.spatial.silenceOpponents(this.now());
  }

  /**
   * Reverb zone from the surface query. Cheap enough to call at a low rate; the
   * rack ignores repeats, so only an actual zone change costs anything.
   */
  updateReverb(info: SurfaceInfo) {
    if (!this.reverb || !this.unlocked) return;
    const z = zoneForSurface(info);
    this.reverbZone = z.id;
    this.reverb.setZone(z.id, z.wet, this.now());
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
    // One cached buffer read from a random offset. This used to build and fill
    // a fresh AudioBuffer per burst, and a wreck fires four of them — several
    // hundred KB of allocation and a synchronous noise fill on the exact frame
    // the renderer is already busy with the crash.
    const buf = sharedNoise(this.ctx);
    src.buffer = buf;
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
    src.start(t, noiseOffset(buf, dur + 0.05));
    src.stop(t + dur + 0.03);
  }

  /** Layered impact: thump + metal + debris */
  private layeredHit(intensity = 1, bus?: GainNode) {
    const dest = bus ?? this.sfxDry;
    if (!dest) return;
    const k = Math.max(0.35, Math.min(1.6, intensity));
    this.noiseBurst(dest, 0.1 * k, 0.2 * k, 120, 4000);
    this.noiseBurst(dest, 0.18 * k, 0.12 * k, 600, 9000);
    this.blip(dest, 70 * k, 0.14 * k, "sawtooth", 0.11 * k, -30);
    this.blip(dest, 220 * jitter(), 0.06, "square", 0.05 * k, -120);
  }

  /**
   * Positional one-shot from the sim.
   *
   * Player-sourced cues stay on the dry path: the listener is the chase camera,
   * so panning the player's own weapon would place it several metres in front of
   * them and it would duck in and out as the camera swings.
   */
  playCue(cue: AudioCue) {
    if (!this.unlocked || !this.ctx) return;
    const spec = CUE_SFX[cue.kind];
    if (!spec) return;
    const vol = spec.vol * Math.max(0.25, Math.min(1.8, cue.intensity));
    if (cue.self) {
      // The player's own actions are never gated, and never take the gate
      // either — a rival firing in the same frame still deserves to be heard.
      if (!this.oneshot(spec.key, vol, spec.rate)) {
        this.layeredHit(cue.intensity);
      }
      return;
    }
    const now = performance.now();
    if (now < (this.cueGate.get(cue.kind) ?? 0)) return;
    this.cueGate.set(cue.kind, now + spec.gate);
    if (!this.spatial) return;
    const t = this.now();
    const input = this.spatial.acquire(
      t,
      cue.x,
      cue.y,
      cue.z,
      1,
      spec.len,
    );
    if (!input) return;
    if (!this.oneshot(spec.key, vol, spec.rate, input)) {
      // No sample for this key — the procedural fallback still gets panned,
      // which is the whole point: AI fire previously made no sound at all.
      this.layeredHit(cue.intensity * 0.8, input);
    }
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
    if (!this.uiBus || !this.sfxBus) return;
    // These stay on the raw SFX bus rather than the new dry-with-send stage:
    // a menu click is not in the world and must not pick up the canyon.
    const flat = this.sfxBus;
    if (kind === "click") {
      if (this.oneshot("ui_click", 0.55, 1, flat)) return;
      this.blip(this.uiBus, 680, 0.05, "triangle", 0.07);
    }
    if (kind === "confirm") {
      if (this.oneshot("ui_confirm", 0.6, 1, flat)) return;
      this.blip(this.uiBus, 440, 0.1, "triangle", 0.1, 240);
    }
    if (kind === "countdown") {
      if (this.oneshot("countdown", 0.65, 1, flat)) return;
      this.blip(this.uiBus, 520, 0.11, "square", 0.1);
    }
    if (kind === "go") {
      if (this.oneshot("go", 0.8, 1, flat)) return;
      this.blip(this.uiBus, 330, 0.22, "sawtooth", 0.13, 450);
    }
    if (kind === "finish") {
      this.playMusic("victory");
      this.oneshot("crowd_cheer", 0.55, 1, flat);
      if (this.oneshot("finish", 0.85, 1, flat)) return;
      this.blip(this.uiBus, 392, 0.28, "triangle", 0.12, 200);
    }
    if (kind === "pause") this.blip(this.uiBus, 280, 0.08, "sine", 0.08);
    if (kind === "lap") {
      if (this.oneshot("lap", 0.7, 1, flat)) return;
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
    const dry = this.sfxDry;
    if (!dry) return;
    if (kind === "fire") {
      if (this.oneshot("weapon_laser", 0.7)) return;
      this.noiseBurst(dry, 0.07, 0.14, 900, 10000);
      this.blip(dry, 980 * jitter(), 0.06, "square", 0.06, -420);
    }
    if (kind === "cannon") {
      if (this.oneshot("weapon_cannon", 0.85)) return;
      this.noiseBurst(dry, 0.2, 0.22, 80, 2500);
      this.blip(dry, 100, 0.22, "sawtooth", 0.14, -50);
    }
    if (kind === "disc") {
      this.blip(dry, 1500 * jitter(), 0.12, "square", 0.08, -1000);
      this.noiseBurst(dry, 0.08, 0.06, 2000);
    }
    if (kind === "hit") {
      if (this.oneshot("impact_metal", 0.85)) return;
      this.layeredHit(1);
    }
    if (kind === "prop") {
      if (this.oneshot("prop_smash", 0.8)) return;
      this.noiseBurst(dry, 0.1, 0.14, 200, 5000);
    }
    if (kind === "boost" || kind === "turbo" || kind === "whoosh") {
      if (this.oneshot("nitro_ignition", 0.75) || this.oneshot("boost", 0.8)) {
        this.oneshot("turbo_release", 0.45);
        this.oneshot("whoosh", 0.3);
        return;
      }
      this.blip(dry, 180, 0.28, "sawtooth", 0.11, 620);
      this.noiseBurst(dry, 0.22, 0.12, 500, 9000);
    }
    if (kind === "defense") {
      if (this.oneshot("shield", 0.75)) return;
      this.blip(dry, 620, 0.16, "sine", 0.1, 320);
    }
    if (kind === "ult") {
      this.noiseBurst(dry, 0.35, 0.2, 60, 3000);
      this.blip(dry, 150, 0.4, "sawtooth", 0.13, 280);
      this.blip(dry, 300, 0.25, "square", 0.06, 100);
    }
    if (kind === "mine") this.blip(dry, 170, 0.1, "square", 0.08);
    if (kind === "wreck") {
      if (this.oneshot("wreck", 0.9)) return;
      this.layeredHit(1.5);
      this.noiseBurst(dry, 0.45, 0.22, 50, 2000);
    }
    if (kind === "gear") {
      if (this.oneshot("gear", 0.45)) return;
      this.blip(dry, 180 * jitter(0.05), 0.04, "square", 0.04);
    }
    if (kind === "land") {
      this.noiseBurst(dry, 0.08, 0.1, 100, 2000);
      this.blip(dry, 90, 0.08, "triangle", 0.06, -20);
    }
    if (kind === "drift") {
      if (this.oneshot("drift_squeal", 0.65) || this.oneshot("slide_screech", 0.55)) return;
      this.noiseBurst(dry, 0.14, 0.12, 600, 5000);
      this.blip(dry, 900 * jitter(), 0.12, "sawtooth", 0.06, -200);
    }
    if (kind === "scrape") {
      if (this.oneshot("metal_scrape", 0.4) || this.oneshot("slide_screech", 0.35)) return;
      this.noiseBurst(dry, 0.1, 0.08, 400, 3500);
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
