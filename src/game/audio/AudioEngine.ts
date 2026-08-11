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
  isRivalVoice,
  loadVoice,
  type MusicId,
  type VoiceId,
} from "./SampleBank";
import {
  EngineVoice,
  type EngineClassId,
  type EngineInput,
} from "./engineModel";
import { TyreBed, type TyreInput } from "./tyreModel";
import { BrakeBed, type BrakeInput } from "./brakeModel";
import { VoBudget, VO_TIER } from "./voBudget";
import { SpatialField } from "./spatial";
import {
  ReverbRack,
  zoneAcoustics,
  zoneForSurface,
  type ReverbZoneId,
} from "./reverb";
import { ExplosionRack, type BlastKind } from "./explosion";
import { DebrisRack, ScrapeBed, type ScrapeInput } from "./impactModel";
import { WeaponRack, type WeaponKind } from "./weaponModel";
import { CrowdBed, PaSend } from "./crowd";
import {
  MUSIC_STATE_TRACK,
  transitionFor,
  type MusicState,
} from "./music";
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

/**
 * Per-track trim so the bounces sit at comparable loudness.
 *
 * These are matched by ear against each other, NOT against the rest of the mix
 * — the music bus volume is what places the soundtrack as a whole. Getting that
 * backwards (trimming an individual track because it was quiet under the
 * engine) is how a soundtrack ends up with one track that is right and six that
 * are wrong in different directions.
 */
function musicTrackVolume(id: MusicId) {
  return id === "race_heat"
    ? 0.62
    : id === "race_intensity"
      ? 0.6
      : id === "final_lap"
        ? 0.64
        : id === "victory"
          ? 0.72
          : id === "defeat"
            ? 0.64
            : 0.56;
}

/**
 * What each recorded line is worth. THIS is the editorial decision the VO cut
 * is made of — the budget in voBudget.ts is only the machinery that enforces it.
 *
 * Every line is still here, still shipped, still triggered from the same place
 * in the driver. Promoting a line back up this table is all it takes to hear it
 * again; nothing has been deleted.
 *
 * The rule used to place a line: would the player notice its absence, or only
 * its presence? Green flag, final lap, a takedown they caused and the result of
 * the heat are the four things a race announcer exists for. A lap counter the
 * HUD already shows, a place change the HUD already shows, and a rival with an
 * opinion about being overtaken are all things the player can see. They stay
 * available for the quiet minutes and lose every contest against the rest.
 */
const VOICE_TIER: Record<VoiceId, number> = {
  // Cannot be missed.
  green: VO_TIER.CRITICAL,
  "final-lap": VO_TIER.CRITICAL,
  win: VO_TIER.CRITICAL,
  loss: VO_TIER.CRITICAL,
  wreck: VO_TIER.CRITICAL,
  // Something the player did, or the heat about to start.
  "grid-locked": VO_TIER.MAJOR,
  "wreck-rival": VO_TIER.MAJOR,
  // Race state the player might have missed.
  overtake: VO_TIER.NOTABLE,
  overtaken: VO_TIER.NOTABLE,
  // Routine and repeatable.
  "lap-1": VO_TIER.COLOUR,
  "lap-2": VO_TIER.COLOUR,
  "lap-3": VO_TIER.COLOUR,
  "hit-1": VO_TIER.COLOUR,
  "hit-2": VO_TIER.COLOUR,
  "boost-1": VO_TIER.COLOUR,
  "boost-2": VO_TIER.COLOUR,
  "near-miss": VO_TIER.COLOUR,
  // Pure colour. First out of the door the moment anything else is happening.
  "close-pack": VO_TIER.FLAVOUR,
  "rival-taunt-1": VO_TIER.FLAVOUR,
  "rival-taunt-2": VO_TIER.FLAVOUR,
  "rival-taunt-3": VO_TIER.FLAVOUR,
  "rival-hit-1": VO_TIER.FLAVOUR,
  "rival-hit-2": VO_TIER.FLAVOUR,
  "rival-wreck": VO_TIER.FLAVOUR,
  "rival-pass": VO_TIER.FLAVOUR,
};

/**
 * How far the music gets out of the way, by tier.
 *
 * The user asked for music forward, and a bed that dives 6 dB every time
 * anything is said is not forward — it is a bed with holes in it. Only a line
 * that had to be heard is allowed to move the music much; flavour barely
 * touches it, which is affordable precisely because flavour is now rare.
 */
const VOICE_DUCK = [0.14, 0.2, 0.3, 0.42, 0.55];

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
  "lap-3": "lap",
  "rival-taunt-1": "rival",
  "rival-taunt-2": "rival",
  "rival-taunt-3": "rival",
  "rival-hit-1": "rival",
  "rival-hit-2": "rival",
  "rival-pass": "rival",
  "rival-wreck": "rival",
};

/** sim.ts emits gate crossings as `Lap <n>`; see feedEvent. */
const LAP_MESSAGE = /^lap \d/i;

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
  /**
   * 0..1 brake demand. Distinct from `brake`, which the engine uses only to
   * know the driver has lifted; the pads care how hard.
   */
  brakePressure: number;
  /** 0..1 deceleration actually being achieved. The *result* of braking. */
  decel: number;
  /** 0..1 how close the tyres are to locking under braking. */
  lock: number;
  /** 0..1 lateral slip angle. The continuous drift signal — see TyreBed. */
  slipAngle: number;
  /** 0..1 weight on the contact patches. */
  load: number;
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
  slipAngle: 0,
  load: 0,
  brakePressure: 0,
  boost: false,
  offroad: 0,
  roughness: 0.08,
  dt: 1 / 60,
};

const BRAKE_OFF: BrakeInput = {
  pressure: 0,
  decel: 0,
  speed01: 0,
  lock: 0,
  roughness: 0.08,
  dt: 1 / 60,
};

/**
 * Minimum spacing in ms between two *rival* cues of the same kind. A pack of
 * five AI cars all holding the trigger would otherwise stack the same shot on
 * top of itself and read as one loud buzz. Player cues are never gated.
 */
const CUE_GATE: Record<string, number> = {
  "fire-bolt": 55,
  "fire-cannon": 80,
  "fire-disc": 70,
  "hit-bolt": 40,
  "hit-cannon": 45,
  "hit-disc": 40,
  "shell-land": 90,
  "mine-blast": 60,
  "mine-drop": 120,
  defense: 110,
  ult: 200,
  "ult-blast": 200,
  "wreck-blast": 90,
  "barrel-rupture": 90,
  "glass-break": 70,
};
const CUE_GATE_DEFAULT = 60;

/** Cue kind → weapon synth voice. */
const CUE_WEAPON: Record<string, WeaponKind> = {
  "fire-bolt": "bolt",
  "fire-cannon": "cannon",
  "fire-disc": "disc",
  "hit-bolt": "bolt",
  "hit-cannon": "cannon",
  "hit-disc": "disc",
};

/** Cue kind → blast profile. */
const CUE_BLAST: Record<string, BlastKind> = {
  "shell-land": "shell",
  "mine-blast": "mine",
  "wreck-blast": "vehicle",
  "barrel-rupture": "barrel",
  "ult-blast": "ordnance",
};

/**
 * Recorded layer under the *player's own* weapon only.
 *
 * The synth carries the event; the sample adds a bit of recorded grit that pure
 * synthesis does not have. It is restricted to the player because it plays on
 * the dry path (no spatial voice, no pool pressure) and because a rival's shot
 * does not need body — it needs to be locatable, which the synth already is.
 */
const SELF_LAYER: Record<string, { key: string; vol: number; rate: number }> = {
  "fire-bolt": { key: "weapon_laser", vol: 0.28, rate: 1.1 },
  "fire-cannon": { key: "weapon_cannon", vol: 0.34, rate: 0.95 },
  "fire-disc": { key: "weapon_laser", vol: 0.22, rate: 0.7 },
  defense: { key: "shield", vol: 0.34, rate: 1 },
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
  private brakes: BrakeBed | null = null;
  /** Reused every frame — see updateContinuous. */
  private engineIn: EngineInput = { ...ENGINE_OFF };
  private tyreIn: TyreInput = { ...TYRE_OFF };
  private brakeIn: BrakeInput = { ...BRAKE_OFF };
  private scrapeIn: ScrapeInput = {
    pressure: 0,
    slide: 0,
    metal: 1,
    dt: 1 / 60,
  };
  private spatial: SpatialField | null = null;
  private reverb: ReverbRack | null = null;
  private reverbZone: ReverbZoneId | null = null;
  private explosions: ExplosionRack | null = null;
  private weapons: WeaponRack | null = null;
  private scrape: ScrapeBed | null = null;
  private debris: DebrisRack | null = null;
  private crowd: CrowdBed | null = null;
  private pa: PaSend | null = null;
  /** Radio colouration for rival chatter; announcer lines bypass it. */
  private voRadio: GainNode | null = null;
  /** Musical "presence" filter — see setMusicIntensity. */
  private musicTone: BiquadFilterNode | null = null;
  private pendingClass: EngineClassId | null = null;
  private musicState: MusicState = "silent";
  /** Last value written by setMusicIntensity; see the dedup there. */
  private musicIntensity = -1;

  private musicNodes: { osc: OscillatorNode; gain: GainNode }[] = [];
  private musicPulse: OscillatorNode | null = null;
  private musicPulseGain: GainNode | null = null;

  private muted = false;
  /*
   * Gains are applied SQUARED (see the assignments below) to give the volume
   * sliders a roughly perceptual taper. That makes the raw numbers here
   * misleading to read: music at 0.3 is not 30% of sfx at 0.78, it is
   * 0.09 against 0.61 — about 17dB down, which is why the soundtrack was
   * inaudible under an engine and a gravel bed rather than merely quiet.
   *
   * 0.6 → 0.36 fixed the "inaudible" part but landed the bed about 4.5 dB under
   * the sfx sum, and it is still multiplied by the track trim (~0.55) and the
   * intensity gain (0.78 at rest) before it reaches the bus. Measured against
   * the beds it competes with — engine ~0.28, tyres ~0.22 at speed — that put
   * the music at roughly half the level of the driving.
   *
   * 0.74 → 0.55 puts the soundtrack level with the sfx bed rather than under
   * it, which is what "music forward" means for a bed the player is supposed to
   * be driving to. It is affordable now because the things that used to pull it
   * down — a duck on every impact, a duck on every announcer line — have been
   * cut back to the events that earn one (VOICE_DUCK, and the impact gate in
   * playImpact). The limiter catches the rest.
   */
  private volumes = { master: 0.88, music: 0.74, sfx: 0.78, ui: 0.58, vo: 0.95 };

  private lastEventAt = 0;
  private lastEventMsg = "";
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
  /** Rate/priority policy for the announcer. See voBudget.ts. */
  private voBudget = new VoBudget();

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

      this.engine = new EngineVoice(
        this.ctx,
        [this.sfxBus, bedSend],
        this.pendingClass ?? "interceptor",
      );
      this.pendingClass = null;
      this.tyres = new TyreBed(this.ctx, [this.sfxBus, bedSend]);
      // Brakes take the bed send like the tyres: they are a continuous voice,
      // and a 2 s canyon tail on something that sounds for the whole length of
      // a braking zone is a wash rather than a room.
      this.brakes = new BrakeBed(this.ctx, [this.sfxBus, bedSend]);

      // Explosions bypass `spatialBus` and own their panners: the shared
      // one-shot pool is 12 voices with a 0.05 s minimum hold, and a detonation
      // occupies one for up to three seconds. Letting a kill starve every weapon
      // impact in the pack for that long is not a trade worth making.
      this.explosions = new ExplosionRack(
        this.ctx,
        this.sfxBus,
        this.reverb.input,
      );
      // Weapons land on the spatial bus rather than straight on sfx: that bus is
      // the one with the post-pan reverb tap, so a shot fired in the canyon
      // rings off the walls. They still own their own panners (PannedOut) — the
      // bus is only carrying them to the room.
      this.weapons = new WeaponRack(this.ctx, this.spatialBus);
      // Debris is the player's own bodywork, so it is never panned and takes the
      // dry path (which carries the closer `nearSend` reverb trim).
      this.debris = new DebrisRack(this.ctx, this.sfxDry);
      // The scrape is a bed, so it takes the bed send trim, not the one-shot
      // one — a two-second canyon tail on a continuous grind is a wash.
      this.scrape = new ScrapeBed(this.ctx, [this.sfxBus, bedSend]);
      this.crowd = new CrowdBed(this.ctx, [this.sfxBus, bedSend]);

      // Rival chatter goes through a radio stage on its way to the VO bus, so
      // it is distinguishable from the circuit announcer without needing the
      // player to recognise two voices.
      this.voRadio = this.buildRadio(this.voBus);
      this.pa = new PaSend(this.ctx, this.voBus);

      // Start dry-ish and let the first surface query pick the real zone.
      this.reverb.setZone("open", 0.1, this.now(), 0.05);
      this.reverbZone = "open";
      const a0 = zoneAcoustics("open");
      this.explosions.setEnvironment(a0.seconds, a0.reflect);
      this.reverb.prewarm(["canyon", "stadium", "scrapyard"]);
      this.buildMusicBed();
      // Tone control between the track fader and the music bus. Pulling the top
      // off the music when nothing is happening and opening it as the fight
      // starts is how a single stereo bounce gets dynamics it was not mixed
      // with; the alternative (stems) does not exist for these tracks.
      this.musicTone = this.ctx.createBiquadFilter();
      this.musicTone.type = "lowpass";
      this.musicTone.frequency.value = 20000;
      this.musicTone.Q.value = 0.5;
      this.musicTone.connect(this.musicBus!);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 1;
      this.musicGain.connect(this.musicTone);
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
    /*
     * Replay whatever was asked for while we were locked.
     *
     * The branch above handles the FIRST unlock, where the sample bank is still
     * decoding and its `.then` does the replay. This handles every other route
     * in: a context that already existed, a bank already decoded, an unlock
     * arriving from the visibility handler rather than a click. Without it the
     * menu bed would still be dropped on any path that did not happen to
     * construct the context on this call.
     */
    const pending = this.pendingMusic;
    if (pending && this.samplesReady) {
      this.pendingMusic = null;
      this.playMusic(pending.id, pending.fade);
    }
  }

  /** Crossfade looped music beds (menu / race / victory) */
  playMusic(id: MusicId, fade = 0.6) {
    if (this.musicId === id && this.musicTrack) return;
    /*
     * LOCKED IS A REASON TO REMEMBER, NOT A REASON TO DROP.
     *
     * This used to `return` outright when the engine had no context or had not
     * been unlocked, and that is why the menu was silent. Autoplay policy means
     * the engine is ALWAYS locked on the front screen — that is the one place
     * where no gesture has happened yet — so the anthem was requested exactly
     * once, discarded, and never asked for again, because a menu does not
     * change state while you look at it.
     *
     * The `pendingMusic` slot below already existed for the neighbouring case
     * (context up, sample bank still decoding). It just was not reached for the
     * case that actually mattered. Both now park the request, and `unlock`
     * replays it.
     */
    if (!this.ctx || !this.unlocked || !this.musicGain) {
      this.pendingMusic = { id, fade };
      return;
    }
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

  /**
   * Drive the music from race state rather than from scattered `playMusic`
   * calls. Idempotent, so the frame loop can call it every frame.
   *
   * `duckFirst` starts the outgoing track down *before* the new one arrives so
   * the two never sit on top of each other at full level, and the stinger covers
   * the seam. Both matter because these are finished stereo bounces at different
   * tempos: an unadorned crossfade between two unaligned drum kits is the single
   * most obvious way a soundtrack announces that it is a playlist.
   */
  /**
   * `pick` overrides which track the state plays — see `trackFor` in music.ts.
   *
   * The guard has to compare BOTH the state and the chosen track, not just the
   * state as it used to. Once a duel, a manhunt, the rain and the night can each
   * re-point the same three driving states at a different bed, "the state has
   * not changed" stopped being the same statement as "the music has not
   * changed", and comparing only the state would have left the standard race bed
   * playing through every one of them.
   */
  setMusicState(state: MusicState, pick?: MusicId | null) {
    const id = pick === undefined ? MUSIC_STATE_TRACK[state] : pick;
    if (state === this.musicState && id === this.musicId) return;
    this.musicState = state;
    const tr = transitionFor(state);
    if (!id) {
      this.stopMusic(tr.fade);
      return;
    }
    if (tr.stinger > 0) this.musicStinger(tr.stinger);
    if (tr.duckFirst > 0 && this.musicTrack) {
      rampFrom(this.musicTrack.gain.gain, this.now(), 0.0001, tr.duckFirst);
      // The incoming track is started after the outgoing has already left, so
      // the two never overlap. A timer is acceptable here because a music
      // transition is a once-per-scene event, not per-frame work.
      const target = state;
      setTimeout(() => {
        // Still the same scene AND still wanting the same bed. Without the
        // second half, a transition that started under one track could land
        // after the pick had already moved on.
        if (this.musicState !== target) return;
        this.playMusic(id, tr.fade);
      }, tr.duckFirst * 1000);
      return;
    }
    this.playMusic(id, tr.fade);
  }

  getMusicState() {
    return this.musicState;
  }

  /**
   * Transition hit. Deliberately synthesised rather than sampled: it has to sit
   * over an arbitrary seam at an arbitrary moment, and the one thing it must not
   * do is sound like the same hit every time the player restarts a heat.
   */
  private musicStinger(level: number) {
    if (!this.ctx || !this.sfxBus) return;
    const dry = this.sfxDry ?? this.sfxBus;
    this.blip(dry, 62 * jitter(0.06), 0.5, "sine", 0.22 * level, -22);
    this.noiseBurst(dry, 0.42, 0.11 * level, 240, 7000);
    this.noiseBurst(dry, 0.14, 0.09 * level, 1800, 12000);
  }

  /**
   * 0..1 how much fight is happening. Opens the music's top end and lifts its
   * level, so a single stereo bounce gets dynamics it was never mixed with.
   * Cheap enough for the frame loop: two param writes, no allocation.
   */
  setMusicIntensity(v: number) {
    if (!this.musicTone || !this.musicGain || !this.unlocked) return;
    const x = Math.max(0, Math.min(1, v));
    // The 0.9 s time constant means anything finer than a couple of percent is
    // inaudible, and the caller passes a value derived from pack distance that
    // jitters every frame. Rewriting the param 120 times a second for a change
    // the filter cannot follow is cost with no signal.
    if (Math.abs(x - this.musicIntensity) < 0.02) return;
    this.musicIntensity = x;
    const t = this.now();
    // The floor used to be 2.2 kHz, which is a *lot* of filter — enough that a
    // quiet moment sounded like the soundtrack was playing in the next room.
    // That was the right call when music sat 4.5 dB under everything and needed
    // to stay out of the way; with the bed forward it reads as a fault. 4.2 kHz
    // still darkens the track audibly without taking the arrangement away, and
    // the curve is cubic rather than square so the last third of the race opens
    // it decisively instead of gradually.
    this.musicTone.frequency.setTargetAtTime(4200 + x * x * x * 15800, t, 0.75);
    // Narrower range, higher floor: at this bus level a 22 % swing is a pump.
    this.musicGain.gain.setTargetAtTime(0.87 + x * 0.13, t, 0.75);
  }

  stopMusic(fade = 0.4) {
    const track = this.musicTrack;
    this.musicTrack = null;
    this.musicId = null;
    this.pendingMusic = null;
    // Keep the state machine honest: a direct stopMusic() must not leave
    // `musicState` claiming a track is playing, or re-entering that state would
    // be a no-op and the music would never come back.
    this.musicState = "silent";
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
   * 0..1 how much is happening. Raises the bar a line has to clear — see the
   * pressure rule in voBudget.ts. Called every frame; a plain field write.
   */
  setVoPressure(x: number) {
    this.voBudget.setPressure(x);
  }

  /** New heat: the previous race's budget and cooldowns do not carry over. */
  resetVoBudget() {
    this.voBudget.reset();
  }

  /**
   * Announcer line. Loads `/assets/audio/vo/<id>.mp3` on first use.
   *
   * This is a *request*, not a command: it is checked against the budget in
   * voBudget.ts and is usually refused. See VOICE_TIER above for which lines are
   * expected to survive that and why.
   *
   * Overlap policy is barge-in, never a queue: race VO is only worth hearing
   * while the moment is still on screen, so a line late enough to be irrelevant
   * is dropped rather than played seconds after the fact. What changed is that
   * outranking the current line is no longer sufficient to cut it — see the
   * interrupt rule in the budget.
   */
  playVoice(id: VoiceId) {
    if (!this.ctx || !this.unlocked || !this.voBus) return;
    const ctx = this.ctx;
    const t = this.now();
    const tier = VOICE_TIER[id] ?? VO_TIER.COLOUR;
    const group = VOICE_GROUP[id] ?? id;
    if (!this.voBudget.request(t, tier, group, this.voBusyUntil, this.voPriority))
      return;
    // Claim the channel synchronously — the decode below is async, and two
    // events in the same frame must not both think they won.
    this.voPriority = tier;
    this.voBusyUntil = t + VOICE_PROVISIONAL_LEN;
    const token = ++this.voToken;
    void loadVoice(ctx, id)
      .then((buf) => {
        if (token !== this.voToken) return;
        // Missing mp3, or the first fetch took so long the moment is gone —
        // release the channel AND give the budget slot back, otherwise a file
        // that does not exist quietly spends one of four lines a minute.
        if (
          !buf ||
          (tier < VO_TIER.CRITICAL && this.now() - t > VOICE_STALE_AFTER)
        ) {
          this.voBudget.refund(t, group);
          this.voBusyUntil = 0;
          this.voPriority = 0;
          return;
        }
        this.startVoice(id, tier, buf.duration);
      })
      .catch(() => {
        if (token !== this.voToken) return;
        this.voBudget.refund(t, group);
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
    // Rival lines go through the radio stage; the announcer stays dry and also
    // feeds the PA send, which only becomes audible inside the arena.
    const rival = isRivalVoice(id);
    gain.connect(rival ? (this.voRadio ?? this.voBus) : this.voBus);
    if (!rival && this.pa) gain.connect(this.pa.input);
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
    // Hold the music under the whole line plus a beat of tail — by tier, so the
    // bed only really moves for the lines that had to be heard. See VOICE_DUCK.
    const depth = VOICE_DUCK[Math.max(0, Math.min(4, prio))] ?? 0.42;
    this.duckMusic(depth, duration + 0.15);
    this.reverb?.duck(depth * 0.9, duration + 0.1, t);
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

  /**
   * Short-range radio for rival chatter. Narrower and grittier than the PA:
   * a cheap transceiver rolls off hard at both ends and clips, and that
   * band-limiting is what makes a line read as "another car" rather than as the
   * announcer having moved. Returns the node callers should render into.
   */
  private buildRadio(dest: AudioNode): GainNode {
    const ctx = this.ctx!;
    const input = ctx.createGain();
    input.gain.value = 1;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 480;
    hp.Q.value = 1.1;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2900;
    lp.Q.value = 1.1;
    const pres = ctx.createBiquadFilter();
    pres.type = "peaking";
    pres.frequency.value = 1900;
    pres.Q.value = 1.4;
    pres.gain.value = 7;
    const drive = ctx.createWaveShaper();
    const n = 512;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      // Harder than the PA's: a transceiver is compander-limited, not mixed.
      curve[i] = Math.tanh(x * 3.6) * 0.85;
    }
    drive.curve = curve;
    drive.oversample = "2x";
    // Compensates for the level the bandpass removes, so a taunt sits at the
    // same perceived loudness as an announcer line despite a third the bandwidth.
    const makeup = ctx.createGain();
    makeup.gain.value = 1.5;
    input.connect(hp);
    hp.connect(pres);
    pres.connect(lp);
    lp.connect(drive);
    drive.connect(makeup);
    makeup.connect(dest);
    return input;
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
    const brakes = this.brakes;
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

    // The oscillator bed is a *fallback*, not a layer. It exists so the game is
    // not silent before the mp3 bank decodes (or if it 404s), but sitting an
    // industrial drone under a major-key arena-rock track fights it — the drone
    // has no key and the track does. It is now muted whenever a real bounce is
    // sounding.
    const raceHeat = opts.phase === "racing" ? 1 : 0.65;
    const bedOn = musicOn && !this.musicTrack;
    for (let i = 0; i < this.musicNodes.length; i++) {
      const m = this.musicNodes[i];
      const base = i < 3 ? 0.04 : 0.025;
      ramp(
        m.gain,
        bedOn ? base * raceHeat * (opts.boost ? 1.15 : 1) : 0,
        t,
        0.25,
      );
    }

    const sp = Math.min(1, Math.abs(opts.speed) / Math.max(1, opts.maxSpeed));
    const dt = Math.max(1 / 480, Math.min(0.1, opts.dt));

    if (!racing) {
      this.engine.update(t, ENGINE_OFF);
      this.tyres.update(t, TYRE_OFF);
      brakes?.silence(t);
      return;
    }

    // The gear change no longer plays `gear.mp3`. A shift is an interruption of
    // combustion followed by an exhaust bark, both of which belong inside the
    // engine voice — see EngineVoice.upshift. Layering a generic sampled click
    // on top of it put the shift in a different acoustic space from the engine
    // it came out of, and cost a buffer source per shift.
    const gear = opts.gear ?? Math.min(5, Math.floor(sp * 5) + 1);

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
    ty.slipAngle = opts.slipAngle;
    ty.load = opts.load;
    ty.brakePressure = opts.brakePressure;
    ty.boost = opts.boost;
    ty.offroad = opts.offroad;
    ty.roughness = opts.roughness;
    ty.dt = dt;
    this.tyres.update(t, ty);

    if (brakes) {
      const br = this.brakeIn;
      br.pressure = opts.brakePressure;
      br.decel = opts.decel;
      br.speed01 = sp;
      br.lock = opts.lock;
      br.roughness = opts.roughness;
      br.dt = dt;
      brakes.update(t, br);
    }
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
   *
   * The zone also drives the explosion tail and the crowd: they are properties
   * of the same space, and deriving them here rather than from a second query
   * keeps them from disagreeing about which room the player is in.
   */
  updateReverb(info: SurfaceInfo) {
    if (!this.reverb || !this.unlocked) return;
    const z = zoneForSurface(info);
    if (z.id !== this.reverbZone) {
      const a = zoneAcoustics(z.id);
      this.explosions?.setEnvironment(a.seconds, a.reflect);
    }
    this.reverbZone = z.id;
    this.reverb.setZone(z.id, z.wet, this.now());
    // Crowd presence falls off once the car is well outside the racing surface:
    // the stands are beside the track, not out in the dunes.
    const inArena = info.sample.zone === "arena" ? 1 : 0;
    this.arenaPresence =
      inArena * Math.max(0, 1 - Math.max(0, info.dist - info.half) / 40);
    this.pa?.setAmount(this.now(), this.arenaPresence);
  }

  /** 0..1 how much stadium is around the listener; set by updateReverb. */
  private arenaPresence = 0;

  /**
   * Ambience tick. Split from `updateContinuous` because the crowd needs to keep
   * breathing while the engine bed is switched off (grid, results screen), and
   * folding it in would have tied the two lifetimes together.
   */
  updateAmbience(active: boolean, heat: number, dt: number) {
    if (!this.crowd || !this.unlocked) return;
    // `arenaPresence` only refreshes while the surface query is running (i.e.
    // during a heat), so without the explicit gate the last value would persist
    // and the stands would still be murmuring on the main menu.
    this.crowd.update(
      this.now(),
      active ? this.arenaPresence : 0,
      heat,
      dt,
    );
  }

  crowdSurge(amount = 1) {
    this.crowd?.surge(amount);
  }

  /**
   * Per-frame contact bed. `pressure` is how hard the car is loaded into
   * whatever it is touching, `slide` how fast the contact patch is moving, and
   * `metal` how metallic the other surface is.
   */
  updateContact(pressure: number, slide: number, metal: number, dt: number) {
    if (!this.scrape || !this.unlocked) return;
    const s = this.scrapeIn;
    s.pressure = pressure;
    s.slide = slide;
    s.metal = metal;
    s.dt = dt;
    this.scrape.update(this.now(), s);
  }

  /** Set the player's engine character. No-op if it is already that class. */
  setVehicleClass(id: EngineClassId) {
    if (!this.engine) {
      // Class is chosen in the garage, which the player can reach before the
      // first pointerdown unlocks audio — remember it for construction.
      this.pendingClass = id;
      return;
    }
    this.engine.setClass(this.now(), id);
  }

  /**
   * Positional detonation. `dist` is measured against the audio listener, which
   * is what the arrival delay and the air-absorption filter are computed from.
   */
  explode(
    x: number,
    y: number,
    z: number,
    energy: number,
    kind: BlastKind = "vehicle",
    self = false,
  ) {
    if (!this.explosions || !this.unlocked || !this.spatial) return;
    const dist = self ? 0 : this.spatial.distanceToListener(x, y, z);
    // Nothing beyond the panner cull is worth a voice; the pool is 4 deep and a
    // kill 300 m away would evict one the player can actually hear.
    if (dist > 260) return;
    this.explosions.fire(this.now(), x, y, z, energy, dist, kind, self);
    // Duck under the blast rather than letting the limiter do it — the limiter
    // would pull the *whole* mix, including the engine the player is steering by.
    //
    // The gate is high and the depth is modest on purpose. A combat racer has a
    // detonation every few seconds; ducking the bed for all of them is not
    // "getting out of the way", it is a soundtrack with a tremolo on it. Only a
    // blast inside ~40 m moves the music at all now.
    const near = 1 - Math.min(1, dist / 90);
    if (near > 0.55) {
      this.duckMusic(0.12 + near * 0.24, 0.2 + near * 0.28, 0.02, 0.5);
    }
  }

  /** Sheet-metal deformation; fired off crumple-zone deltas, not off impacts. */
  crumple(intensity: number) {
    this.debris?.crumple(this.now(), intensity);
  }

  glass(intensity: number) {
    this.debris?.glass(this.now(), intensity);
  }

  /** Rival passing close enough to move air. */
  nearMiss(closing: number) {
    this.debris?.whoosh(this.now(), closing);
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
   * Everything here is synthesised and placed by the weapon / explosion racks
   * rather than played from the bank. The bank has two weapon samples for three
   * weapon types and the primary fires every 220 ms — no sample survives that
   * repetition rate, and pitching one down 30 % to stand in for a third weapon
   * (which is what this used to do for discs) is audibly the same sound slowed.
   *
   * Player-sourced cues render dry: the listener is the chase camera, so panning
   * the player's own weapon would place it several metres in front of them and
   * swing it as the camera settles.
   */
  playCue(cue: AudioCue) {
    if (!this.unlocked || !this.ctx) return;
    if (!cue.self) {
      // The player's own actions are never gated, and never take the gate
      // either — a rival firing in the same frame still deserves to be heard.
      const now = performance.now();
      if (now < (this.cueGate.get(cue.kind) ?? 0)) return;
      this.cueGate.set(
        cue.kind,
        now + (CUE_GATE[cue.kind] ?? CUE_GATE_DEFAULT),
      );
    }
    const t = this.now();
    const intensity = Math.max(0.25, Math.min(2, cue.intensity));

    const weapon = CUE_WEAPON[cue.kind];
    if (weapon && this.weapons) {
      if (cue.kind.startsWith("hit-")) {
        this.weapons.impact(
          t,
          weapon,
          cue.x,
          cue.y,
          cue.z,
          intensity,
          cue.self,
        );
        // Taking a hit on your own hull deserves the music out of the way; a
        // rival trading paint across the pack does not. Shallow and short — the
        // hit itself is already the loudest thing in the frame.
        if (cue.self && intensity > 1.2) {
          this.duckMusic(0.16, 0.12, 0.02, 0.32);
        }
      } else {
        this.weapons.fire(t, weapon, cue.x, cue.y, cue.z, intensity, cue.self);
      }
      this.selfLayer(cue);
      return;
    }

    const blast = CUE_BLAST[cue.kind];
    if (blast) {
      this.explode(cue.x, cue.y, cue.z, intensity, blast, cue.self);
      // A ruptured drum throws its lining as well as its contents.
      if (cue.kind === "barrel-rupture") this.debris?.glass(t + 0.05, 0.7);
      return;
    }

    if (cue.kind === "defense" && this.weapons) {
      this.weapons.defense(t, cue.x, cue.y, cue.z, cue.self);
      this.selfLayer(cue);
      return;
    }

    if (cue.kind === "ult" && this.weapons) {
      // Riser first, detonation at the top of it. The riser deliberately does
      // not resolve on its own — the blast is its resolution.
      this.weapons.riser(t, cue.x, cue.y, cue.z, cue.self);
      this.explosions?.fire(
        t + 0.82,
        cue.x,
        cue.y,
        cue.z,
        intensity * 1.4,
        cue.self ? 0 : (this.spatial?.distanceToListener(cue.x, cue.y, cue.z) ?? 0),
        "ordnance",
        cue.self,
      );
      if (cue.self) this.duckMusic(0.5, 1.1, 0.35, 0.7);
      return;
    }

    if (cue.kind === "mine-drop") {
      // Mechanical, small, and deliberately unlike a weapon: the player needs to
      // hear that something was *placed*, not fired.
      this.weapons?.impact(t, "bolt", cue.x, cue.y, cue.z, 0.35, cue.self);
      return;
    }

    if (cue.kind === "glass-break") {
      this.debris?.glass(t, intensity);
    }
  }

  /** Optional recorded body under the player's own action. See SELF_LAYER. */
  private selfLayer(cue: AudioCue) {
    if (!cue.self) return;
    const l = SELF_LAYER[cue.kind];
    if (l) this.oneshot(l.key, l.vol, l.rate);
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
      // Music is NOT started here any more. setMusicState owns the results
      // transition (duck the race bed out, stinger over the seam, then bring
      // the result track in); calling playMusic from the UI layer got there
      // first and silently skipped all of it.
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
      // The player's own car going up: dry (the listener is the chase camera),
      // full-size blast, plus the hull folding. The `wreck` sample is layered
      // *under* it at a trim rather than used instead of it — on its own it is a
      // 900 ms recording with no low end and no distance behaviour, which is
      // what made every kill in the game sound the same.
      this.explode(0, 0, 0, 1.5, "vehicle", true);
      this.debris?.crumple(this.now() + 0.06, 1.6);
      this.oneshot("wreck", 0.32);
      this.duckMusic(0.55, 1.2, 0.02, 0.8);
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
    // Only genuinely heavy metal moves the bed. Trading paint through a pack is
    // a near-continuous stream of impacts at 1.1-ish, and ducking each one was
    // the single biggest reason the soundtrack never settled: the music was
    // being pumped by the same events that were already loud.
    if (intensity >= 1.5) {
      this.duckMusic(Math.min(0.3, 0.1 + intensity * 0.12), 0.14, 0.03, 0.38);
    }
    // Anything hard enough to dent gets the panel folding layered over the
    // recorded hit. The sample is the strike; the crumple is the structure
    // failing behind it, and it is the part that varies per event.
    if (intensity >= 0.95) this.debris?.crumple(this.now(), intensity * 0.7);
    if (intensity < 0.7 && this.oneshot("impact_light", 0.55 + intensity * 0.3)) return;
    if (this.oneshot("impact_metal", Math.min(1, 0.5 + intensity * 0.4))) return;
    this.layeredHit(intensity);
  }

  /**
   * HUD feed line → sound.
   *
   * This used to keyword-match the *prose* of the message and fire a sound for
   * whatever it found, which is why the mix felt like it was narrating itself.
   * Two things were wrong with it:
   *
   *  1. Everything it matched already has a real, physically-driven sound. The
   *     boost whoosh fires off `boostTimer`, the impact off `impactFlash`, the
   *     detonation off `wreckTimer`, the shield off a combat cue. So a feed line
   *     about an event the player had just heard played the event a second time,
   *     a frame or two late, out of sync with its own picture.
   *  2. It matched flavour text. missions/runtime.ts pushes rival radio and
   *     story lines through the same event log — "Turbo lit." fired a nitro
   *     ignition nobody had triggered, and any line containing the word "wreck"
   *     detonated a full vehicle explosion on the spot, ducking the music with
   *     it.
   *
   * The feed is TEXT. It gets the lap chime, because a lap crossing has no other
   * sound of its own and the chime is the confirmation that the gate counted —
   * and nothing else. Everything the sim actually did makes its own noise.
   */
  feedEvent(msg: string, kind?: string) {
    if (!this.unlocked) return;
    const t = performance.now();
    if (msg === this.lastEventMsg && t - this.lastEventAt < 70) return;
    this.lastEventMsg = msg;
    this.lastEventAt = t;
    // The kind alone is not enough: missions/runtime.ts pushes its story lines
    // with a `kind` chosen for their tone, and its last-lap radio line arrives
    // as kind "lap" too. sim.ts emits gate crossings as `Lap <n>`, so requiring
    // a digit is what separates the counter from a sentence about one.
    if (kind === "lap" && LAP_MESSAGE.test(msg)) this.playUi("lap");
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
