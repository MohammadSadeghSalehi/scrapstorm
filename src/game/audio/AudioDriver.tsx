/**
 * R3F-side continuous audio + event feeder from sim state.
 *
 * Runs at FRAME.LATE, i.e. after the chase camera has been posed, because the
 * Web Audio listener is the camera — updating it earlier would place every
 * panned source one frame behind the picture.
 *
 * This is per-frame main-thread work in a build that is already main-thread
 * bound, so everything here is written to allocate nothing: the sim scan is a
 * plain loop rather than find/reduce/slice, the continuous-mix payload and the
 * opponent buffer are module-level and reused, the per-vehicle edge trackers are
 * fixed-size typed arrays, and the cue drain takes a module-level callback
 * rather than a fresh closure.
 *
 * A note on why so much is *derived* here rather than emitted by the sim: this
 * file and src/game/audio/* are the only things the audio pass owns. Vehicle
 * detonations, sustained wall contact, near misses and panel deformation are all
 * reconstructed from state the sim already publishes (`wreckTimer`,
 * `impactFlash`, positions, `dent*`) instead of from dedicated cues. Where that
 * loses information it is called out at the site.
 */
import { useRef, type MutableRefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { GameSimulation } from "../sim";
import { VEHICLE_CLASSES } from "../classes";
import { isDrifting } from "../physics";
import { getSurfaceAt } from "../track";
import { isSimHeld } from "../world/raceGate";
import { audioEngine, type ContinuousInput } from "./AudioEngine";
import { drainAudioCues, type AudioCue } from "./cues";
import {
  OPPONENT_STRIDE,
  OPPONENT_VOICES,
  droneClassIndex,
} from "./spatial";
import { musicStateFor, trackFor, type MusicContext } from "./music";
import { getActiveMissionKind } from "../missions/runtime";
import { getWeatherId } from "../world/weather";
import { getTimeOfDayOverride } from "../world/environments";
import type { VoiceId } from "./SampleBank";
import type { GameEvent, PlayerInput, VehicleClassId } from "../types";
import { FRAME } from "../world/framePriority";

/** Reused every frame — see the file header. */
const CONT: ContinuousInput = {
  phase: "menu",
  speed: 0,
  maxSpeed: 1,
  throttle: 0,
  drifting: false,
  slip: 0,
  boost: false,
  offroad: 0,
  roughness: 0.08,
  gear: 1,
  brake: false,
  brakePressure: 0,
  decel: 0,
  lock: 0,
  slipAngle: 0,
  load: 0,
  dt: 1 / 60,
};

/**
 * Drift state the concurrent physics work may publish.
 *
 * Read defensively rather than added to `VehicleState`: types.ts is owned
 * elsewhere and the audio pass must not depend on that work having landed. When
 * one of these appears it is used; until then the fallbacks below reconstruct
 * the same quantities from `lateral`, `speed` and the tyre array, which is
 * strictly worse (see the report) but is never wrong about whether the car is
 * sideways.
 */
type DriftExtras = {
  /** Slip angle in RADIANS. Consumed directly; see the read site. */
  driftAngle?: number;
  /** 0..1 committed-slide amount, if physics ends up owning the envelope. */
  driftIntensity?: number;
};

/** Reused every frame — see the file header. */
const MUSIC_CTX: MusicContext = {
  phase: "menu",
  lap: 0,
  lapCount: 3,
  finished: false,
  won: false,
};

const OPP = new Float32Array(OPPONENT_VOICES * OPPONENT_STRIDE);
/** Squared distance of the vehicle currently held in each opponent slot. */
const OPP_DIST = new Float32Array(OPPONENT_VOICES);

/**
 * Per-vehicle edge trackers, indexed by position in `sim.state.vehicles`.
 * The field is player + 3 bots; 16 is far past any plausible grid and keeps this
 * a one-time allocation instead of a lazily-grown array.
 */
const MAX_TRACKED = 16;
const PREV_WRECK = new Float32Array(MAX_TRACKED);
const PREV_DIST2 = new Float32Array(MAX_TRACKED);
const NEARMISS_AT = new Float32Array(MAX_TRACKED);

/** Lap call rotation. See the lap block below for why this is not `lap % 2`. */
const LAP_LINES: VoiceId[] = ["lap-1", "lap-2", "lap-3"];
const RIVAL_HITS: VoiceId[] = ["rival-hit-1", "rival-hit-2"];
const RIVAL_TAUNTS: VoiceId[] = [
  "rival-taunt-1",
  "rival-taunt-2",
  "rival-taunt-3",
];

/** Metres. Inside this a rival passing at speed moves enough air to hear. */
const NEAR_MISS_RADIUS = 7;
const NEAR_MISS_R2 = NEAR_MISS_RADIUS * NEAR_MISS_RADIUS;

const onCue = (cue: AudioCue) => audioEngine.playCue(cue);

/**
 * The surface query walks the track centreline, so it is not free and the
 * answer barely changes between frames at 90 m/s. 12 Hz is well inside the
 * slew the tyre bed and the reverb crossfade already apply.
 */
const SURFACE_INTERVAL = 1 / 12;

export function AudioDriver({
  sim,
  lastInput,
}: {
  sim: GameSimulation;
  lastInput: MutableRefObject<PlayerInput | null>;
}) {
  // Newest event we've already fed. sim.ts caps `events` at 12 entries, so the
  // old length-based diff went permanently deaf once the log saturated —
  // identity of the head entry survives the trim.
  const lastEvent = useRef<GameEvent | null>(null);
  const prevBoost = useRef(0);
  const prevPhase = useRef(sim.state.phase);
  const prevCd = useRef(-1);
  const prevWreck = useRef(0);
  const prevImpact = useRef(0);
  const prevLap = useRef(0);
  const prevPos = useRef(0);
  const voFlip = useRef(0);
  const lapVo = useRef(0);
  const surfaceAt = useRef(0);
  const prevClass = useRef<VehicleClassId | null>(null);
  /** Windows and lights only break once or twice before there is nothing left. */
  const glassLeft = useRef(2);
  /** How long the player has been continuously pressed against something. */
  const contactHold = useRef(0);

  const camera = useThree((s) => s.camera);

  const musicBoot = useRef(false);
  useFrame((_, delta) => {
    if (!audioEngine.isUnlocked()) {
      // Still drain, or the ring fills with shots fired before the first click
      // and dumps them all at once the moment audio unlocks.
      drainAudioCues(onCue);
      return;
    }
    const st = sim.state;
    if (!musicBoot.current) {
      musicBoot.current = true;
      if (st.phase === "menu") audioEngine.setMusicState("menu");
      if (st.phase === "garage") audioEngine.setMusicState("garage");
    }

    // Listener first: cues drained below are positioned against it.
    const e = camera.matrixWorld.elements;
    audioEngine.updateListener(
      e[12]!,
      e[13]!,
      e[14]!,
      // Three's camera looks down local -Z; columns 1 and 2 of the world matrix
      // are the up and back axes.
      -e[8]!,
      -e[9]!,
      -e[10]!,
      e[4]!,
      e[5]!,
      e[6]!,
    );

    const vehicles = st.vehicles;
    let player = null;
    for (let i = 0; i < vehicles.length; i++) {
      if (vehicles[i]!.isPlayer) {
        player = vehicles[i]!;
        break;
      }
    }
    if (!player) {
      drainAudioCues(onCue);
      return;
    }

    if (player.classId !== prevClass.current) {
      prevClass.current = player.classId;
      // The three classes are different engines, not one engine at three
      // volumes — see ENGINE_PROFILES.
      audioEngine.setVehicleClass(player.classId);
    }

    const def = VEHICLE_CLASSES[player.classId];
    const tires = player.tires;
    // One pass over the wheels for all three tyre signals. `long` is the
    // longitudinal component and is what a locking wheel looks like; `slip` is
    // the combined magnitude, and `compress` is how much weight is on the patch.
    let slip = 0;
    let longSlip = 0;
    let load = 0;
    if (tires && tires.length) {
      for (let i = 0; i < tires.length; i++) {
        const tr = tires[i]!;
        slip += tr.slip;
        longSlip += tr.long < 0 ? -tr.long : tr.long;
        load += tr.compress;
      }
      const inv = 1 / tires.length;
      slip *= inv;
      longSlip *= inv;
      load *= inv;
    }
    const inp = lastInput.current;
    const drifting = inp ? isDrifting(player, inp) : player.driftMeter > 0.25;

    const sp = Math.abs(player.speed) / Math.max(1, def.maxSpeed);
    const gear = Math.min(5, Math.floor(sp * 5) + 1);
    const braking = !!(inp?.brake && !drifting && Math.abs(player.speed) > 10);

    // --- brake signals ------------------------------------------------------
    // Pedal is binary in the input, so the *pressure* the pads hear is inferred
    // from what braking is achieving. `uiAccel` is physics' own smoothed
    // longitudinal acceleration, so this is the actual deceleration rather than
    // a second integration of speed that could disagree with the car.
    //
    // Normalised against roughly what the car can produce: `accel × brakeMul`.
    // A fixed divisor would make the bruiser (accel 2.35) permanently quieter
    // under braking than the interceptor for no reason the player can see.
    const decel = braking
      ? Math.min(1, Math.max(0, -player.uiAccel) / (def.accel * 2.4))
      : 0;
    // Held pressure has a floor: standing on the pedal at low speed produces
    // almost no deceleration but the pads are still fully clamped, and that is
    // exactly the case where squeal is most obvious.
    const brakePressure = braking ? Math.max(0.4, decel) : 0;
    // Lock-up: longitudinal slip while the brakes are on. Squared-ish gate so
    // the ABS judder is reserved for genuinely over-braking rather than being
    // on any time a wheel moves relative to the road.
    const lock = braking ? Math.min(1, Math.max(0, longSlip - 0.25) * 2.4) : 0;

    // --- drift signals ------------------------------------------------------
    // Slip angle: how far the car's velocity vector is from where it points.
    // physics.ts publishes `lateral` in the vehicle frame, so this is exact and
    // needs no reconstruction from world velocity. Normalised against 30° —
    // a genuinely committed slide, not the maximum the model allows.
    // `driftIntensity` (0..1) wins if physics owns the envelope; `driftAngle` is
    // taken as RADIANS, which is the only reading of that name that cannot be
    // ambiguous — see the report for the exact contract asked for. Either way
    // the fallback below produces the same quantity from fields that exist now.
    const dx = player as typeof player & DriftExtras;
    const angleRad =
      dx.driftAngle ??
      Math.atan2(Math.abs(player.lateral), Math.max(4, Math.abs(player.speed)));
    const slipAngle = Math.min(1, (dx.driftIntensity ?? angleRad / 0.52));

    const racing =
      st.phase === "racing" || st.phase === "countdown" || st.phase === "paused";

    // Surface + reverb zone come from one throttled query. Physics already owns
    // this classification; re-deriving it here would be a second source of truth
    // that could disagree with what the car is actually driving on.
    if (racing && st.time - surfaceAt.current > SURFACE_INTERVAL) {
      surfaceAt.current = st.time;
      const info = getSurfaceAt(player.x, player.z, player.yaw);
      CONT.roughness = info.roughness;
      audioEngine.updateReverb(info);
    }

    CONT.phase = st.phase;
    CONT.speed = Math.abs(player.speed);
    CONT.maxSpeed = def.maxSpeed;
    CONT.throttle = inp?.throttle ?? 0;
    CONT.drifting = drifting;
    CONT.slip = Math.min(1, slip);
    CONT.boost = player.boostTimer > 0;
    CONT.offroad = player.offroadAmount;
    CONT.gear = gear;
    CONT.brake = braking;
    CONT.brakePressure = brakePressure;
    CONT.decel = decel;
    CONT.lock = lock;
    CONT.slipAngle = slipAngle;
    // Tyre compression sits around 0.16 static and ~0.9 fully loaded; rescaled
    // here so the audio layers see a 0..1 that means "weight on the patch"
    // rather than a suspension travel figure.
    CONT.load = Math.max(0, Math.min(1, (load - 0.12) * 1.6));
    CONT.dt = delta;
    audioEngine.updateContinuous(CONT);

    // --- sustained contact --------------------------------------------------
    // There is no "touching a wall" flag in the sim, but physics decays
    // `impactFlash` by exactly dt per second and tops it up on every contact
    // frame. So a value that failed to fall by the elapsed time is a contact
    // still happening, and that difference — not the raw value — is what
    // separates a grind from the tail of a single hit. Getting this wrong is why
    // the old code fired a 200 ms scrape sample at a 2 % chance per frame.
    const expected = Math.max(0, prevImpact.current - delta);
    const sustained = racing && player.impactFlash > expected + 0.004;
    contactHold.current = sustained
      ? Math.min(0.6, contactHold.current + delta)
      : Math.max(0, contactHold.current - delta * 2.5);
    if (racing && contactHold.current > 0.02) {
      // Ramping in over the first ~120 ms stops a single hard hit (which also
      // satisfies the test above for one frame) from clicking the bed on.
      const engage = Math.min(1, contactHold.current / 0.12);
      audioEngine.updateContact(
        Math.min(1, player.impactFlash * 2.4) * engage,
        sp,
        // Off the racing surface the car is grinding rock and dirt, which does
        // not ring; the metallic modes are faded out with it.
        Math.max(0.15, 1 - player.offroadAmount * 0.75),
        delta,
      );
    } else {
      audioEngine.updateContact(0, sp, 1, delta);
    }

    // --- nearest rivals, near misses, rival detonations ---------------------
    // One pass over the field feeds the drone selection, the near-miss test and
    // the pack-pressure number the music intensity reads. Splitting them would
    // mean three scans of the same array every frame.
    let count = 0;
    let nearest2 = Infinity;
    if (racing) {
      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i]!;
        if (v.isPlayer) continue;
        const dx = v.x - player.x;
        const dz = v.z - player.z;
        const d2 = dx * dx + dz * dz;
        const slot4 = i < MAX_TRACKED ? i : -1;

        // Rival detonation. `wreckTimer` is set to 2.8 the frame a car dies, so
        // a rise from zero is the kill. This is one frame later than combat.ts
        // knows and carries no blast energy — see the handover note; a real
        // `wreck-blast` cue would be strictly better.
        if (slot4 >= 0) {
          const pw = PREV_WRECK[slot4]!;
          if (v.wreckTimer > 0.5 && pw <= 0) {
            audioEngine.explode(v.x, v.y + 0.6, v.z, 1.3, "vehicle", false);
            audioEngine.crowdSurge(1.1);
            // The takedown call is now reserved for a takedown the PLAYER made.
            // `lastHitBy` is recorded on the victim and expires, so this is real
            // attribution rather than the old "any car died within 80 m" test —
            // which called a takedown every time two bots collided nearby, and
            // is exactly the kind of line the announcer had no business saying.
            if (v.lastHitBy === player.id) {
              audioEngine.playVoice("wreck-rival");
            }
          }
          PREV_WRECK[slot4] = v.wreckTimer;
        }

        if (!v.alive) {
          if (slot4 >= 0) PREV_DIST2[slot4] = d2;
          continue;
        }
        if (d2 < nearest2) nearest2 = d2;

        // Near miss: crossing *inward* through the radius. Testing the crossing
        // rather than the distance is what makes this fire once per pass instead
        // of every frame two cars spend side by side in a corner.
        if (slot4 >= 0) {
          const prev2 = PREV_DIST2[slot4]!;
          const closing = prev2 - d2;
          if (
            d2 < NEAR_MISS_R2 &&
            prev2 >= NEAR_MISS_R2 &&
            closing > 0.35 &&
            st.time - NEARMISS_AT[slot4]! > 1.4
          ) {
            NEARMISS_AT[slot4] = st.time;
            // Scaled by relative speed: two cars drifting together and two cars
            // passing at 60 m/s are not the same event.
            const violence = Math.min(1.6, 0.4 + Math.sqrt(closing) * 0.9);
            audioEngine.nearMiss(violence);
            // Only the genuinely frightening ones get a call. The mixer's 14 s
            // cooldown does the rest of the rate limiting.
            if (violence > 1.15) audioEngine.playVoice("near-miss");
          }
          PREV_DIST2[slot4] = d2;
        }

        if (d2 > 42000) continue; // ~205 m, past the panner's cull
        let slot = count < OPPONENT_VOICES ? count : -1;
        if (slot < 0) {
          let worst = 0;
          for (let k = 1; k < OPPONENT_VOICES; k++) {
            if (OPP_DIST[k]! > OPP_DIST[worst]!) worst = k;
          }
          if (d2 >= OPP_DIST[worst]!) continue;
          slot = worst;
        } else {
          count += 1;
        }
        OPP_DIST[slot] = d2;
        const b = slot * OPPONENT_STRIDE;
        OPP[b] = v.x;
        OPP[b + 1] = v.y + 0.5;
        OPP[b + 2] = v.z;
        const vsp = Math.min(
          1,
          Math.abs(v.speed) / Math.max(1, VEHICLE_CLASSES[v.classId].maxSpeed),
        );
        // AI input is not exposed here, so load is inferred: a rival at speed or
        // on boost is on the throttle.
        OPP[b + 3] = Math.min(1, 0.1 + ((vsp * 5) % 1) * 0.8 + vsp * 0.15);
        OPP[b + 4] = Math.min(1, vsp * 0.8 + (v.boostTimer > 0 ? 0.4 : 0));
        OPP[b + 5] = i;
        OPP[b + 6] = droneClassIndex(v.classId);
      }
      audioEngine.updateOpponents(OPP, count, delta);
    } else {
      audioEngine.silenceOpponents();
    }

    // --- ambience and musical intensity ------------------------------------
    // Pack pressure: how close the nearest live rival is, saturating at 40 m.
    const pressure = racing
      ? Math.max(0, 1 - Math.min(1, Math.sqrt(nearest2) / 40))
      : 0;
    const heat = racing
      ? Math.min(
          1,
          pressure * 0.55 +
            sp * 0.3 +
            (player.lap >= st.lapCount - 1 ? 0.25 : 0) +
            (player.boostTimer > 0 ? 0.15 : 0),
        )
      : st.phase === "finished"
        ? 0.85
        : 0;
    audioEngine.updateAmbience(racing || st.phase === "finished", heat, delta);
    // Musical intensity is deliberately NOT the crowd's heat.
    //
    // The crowd reacts to spectacle; the score should follow the *stakes*. Race
    // progress is the biggest term — a soundtrack that peaks whenever the player
    // happens to be near a car has no shape over three laps, and shape is the
    // whole reason to have an arrangement that opens up. Damage is in there
    // because a heat you are barely surviving is not a quiet one, and it is the
    // one input the crowd cannot see.
    const progress =
      st.lapCount > 0 ? Math.min(1, player.lap / Math.max(1, st.lapCount)) : 0;
    const hurt = 1 - Math.max(0, Math.min(1, player.health / Math.max(1, player.maxHealth)));
    const drama = Math.min(
      1,
      progress * 0.4 +
        pressure * 0.3 +
        sp * 0.15 +
        hurt * 0.2 +
        (player.position === 1 ? 0.1 : 0),
    );
    audioEngine.setMusicIntensity(
      st.phase === "racing"
        ? 0.3 + drama * 0.7
        : // The grid is a build-up, so it is deliberately NOT wide open. This
          // used to pass 1 for every non-racing phase, which meant the music
          // was at its most open on the countdown and then *closed down* the
          // instant the lights went out — the transition was backwards, and it
          // is the reason the green flag never felt like a release.
          st.phase === "countdown"
          ? 0.42
          : 1,
    );
    // Same number gates the announcer: the busier the race, the more a line has
    // to be worth. See voBudget.ts.
    audioEngine.setVoPressure(racing ? drama : 0);

    drainAudioCues(onCue);

    if (st.phase !== prevPhase.current) {
      /*
       * Gated on the race gate, not just the phase.
       *
       * The world now MOUNTS during "countdown" with the sim clock frozen, so
       * the phase edge fires while the loading screen is still up — the grid
       * confirm played a second or two before the player could see anything,
       * which reads as a sound with no cause.
       */
      if (st.phase === "countdown" && !isSimHeld()) {
        audioEngine.playUi("confirm");
        // Fresh heat: restock the breakables and clear every per-vehicle edge.
        // These trackers are module-level (one allocation, not per frame), so a
        // restart would otherwise inherit the previous heat's wreck states and
        // miss the first detonation of every car that died last time.
        glassLeft.current = 2;
        lapVo.current = 0;
        // The budget is a rolling window, so a restart moments after a finish
        // would otherwise start the new heat with the previous one's result
        // call still counted against it and the grid call silenced.
        audioEngine.resetVoBudget();
        for (let i = 0; i < MAX_TRACKED; i++) {
          PREV_WRECK[i] = 0;
          PREV_DIST2[i] = 1e9;
          NEARMISS_AT[i] = 0;
        }
      }
      if (st.phase === "finished") {
        audioEngine.playUi("finish");
        audioEngine.crowdSurge(1.6);
        // finishedOrder is authoritative once anyone crossed; `position` is the
        // fallback for a heat that ended without a finisher (retire/restart).
        const won = st.finishedOrder.length
          ? st.finishedOrder[0] === player.id
          : player.position === 1;
        audioEngine.playVoice(won ? "win" : "loss");
      }
      if (st.phase === "paused") audioEngine.playUi("pause");
      if (st.phase === "countdown") audioEngine.playVoice("grid-locked");
      prevPhase.current = st.phase;
    }

    // Music is a state machine now, evaluated every frame and idempotent. It was
    // previously a scatter of playMusic() calls that only behaved because
    // playMusic early-returns on a matching id.
    MUSIC_CTX.phase = st.phase;
    MUSIC_CTX.lap = player.lap;
    MUSIC_CTX.lapCount = st.lapCount;
    MUSIC_CTX.finished = player.finished;
    MUSIC_CTX.won = st.finishedOrder.length
      ? st.finishedOrder[0] === player.id
      : player.position === 1;
    /*
     * What the race is and what it looks like, so the five beds that were
     * shipped-but-unreachable can be chosen. Read from the live modules rather
     * than threaded through SimState: the mission runtime and the weather module
     * both already own this and both are queried the same way everywhere else.
     * `trackFor` falls back to the standard beds when none of them apply, so
     * free play is byte-identical to before.
     */
    MUSIC_CTX.missionKind = getActiveMissionKind();
    MUSIC_CTX.weather = getWeatherId();
    MUSIC_CTX.timeOfDay = getTimeOfDayOverride();
    const mstate = musicStateFor(MUSIC_CTX);
    audioEngine.setMusicState(mstate, trackFor(mstate, MUSIC_CTX));

    if (st.phase === "countdown") {
      const cd = Math.ceil(st.countdown);
      if (cd !== prevCd.current && st.countdown > 0) {
        prevCd.current = cd;
        audioEngine.playUi("countdown");
      }
      if (st.countdown <= 0 && prevCd.current !== 0) {
        prevCd.current = 0;
        audioEngine.playUi("go");
        audioEngine.playVoice("green");
        audioEngine.crowdSurge(1.3);
      }
    } else {
      prevCd.current = -1;
    }

    // Lap calls.
    //
    // The old rule was `lap % 2 === 1 ? "lap-1" : "lap-2"` with `final-lap`
    // taking over from `lap >= lapCount - 1`. In the default three-lap heat the
    // player's lap counter reads 1 then 2, and 2 already satisfies the final-lap
    // test — so "lap-2" was recorded, shipped and never once played. A rotation
    // over the available lines has no such arithmetic to get wrong at any lap
    // count, and adding a fourth line needs no code change.
    //
    // `finished` guards the last gate crossing, which increments lap one final
    // time and would otherwise announce a lap the player is never going to drive.
    if (st.phase === "racing" && player.lap > prevLap.current && !player.finished) {
      const entersFinal = player.lap >= st.lapCount - 1;
      if (entersFinal) {
        audioEngine.playVoice("final-lap");
        audioEngine.crowdSurge(1);
      } else {
        audioEngine.playVoice(LAP_LINES[lapVo.current % LAP_LINES.length]!);
        lapVo.current += 1;
      }
    }
    prevLap.current = player.lap;

    // Overtake / overtaken: position is 1-based, so a decrease is a place
    // gained. Skip the opening seconds where the grid is still sorting itself
    // out. Losing a place now has a call of its own — silence on the way down
    // and chatter on the way up reads as a game that is only watching for wins.
    if (st.phase === "racing" && st.raceTime > 4 && prevPos.current > 0 && !player.finished) {
      if (player.position < prevPos.current) {
        audioEngine.playVoice("overtake");
        audioEngine.crowdSurge(0.7);
      } else if (player.position > prevPos.current) {
        audioEngine.playVoice("overtaken");
        // The rival that just took the place has an opinion about it.
        voFlip.current += 1;
        if (voFlip.current % 3 === 0) {
          audioEngine.playVoice("rival-pass");
        }
      }
    }
    prevPos.current = player.position;

    // Pack pressure call, once the fight has actually been going a while.
    if (st.phase === "racing" && st.raceTime > 8 && pressure > 0.82) {
      audioEngine.playVoice("close-pack");
    }

    if (player.boostTimer > 0.4 && prevBoost.current <= 0.4) {
      audioEngine.playSfx("boost");
      audioEngine.playSfx("whoosh");
      voFlip.current += 1;
      audioEngine.playVoice(voFlip.current % 2 ? "boost-1" : "boost-2");
    }
    prevBoost.current = player.boostTimer;

    // No drift one-shot here any more. `drift_squeal.mp3` fired on the rising
    // edge of the flag, which put a fixed 400 ms recording at the front of a
    // slide whose own bed then faded in underneath it — two attacks, one event,
    // and the sample stayed the same length whether the slide lasted a corner
    // or a straight. TyreBed now owns both the break-away transient and the
    // sustain, driven by the slip angle rather than by the flag, so a slide the
    // player did not ask for (a hit, a kerb, sand) also sounds like one.

    if (player.impactFlash > 0.2 && prevImpact.current <= 0.12) {
      audioEngine.playImpact(0.7 + player.impactFlash * 2);
      // Only real hits get a call-out; the low threshold above also catches
      // wall scrapes.
      if (player.impactFlash > 0.45) {
        voFlip.current += 1;
        audioEngine.playVoice(voFlip.current % 2 ? "hit-1" : "hit-2");
        // Rival chatter is deliberately sparse — one in four heavy hits, on top
        // of a 19 s group cooldown in the mixer.
        if (voFlip.current % 4 === 0) {
          audioEngine.playVoice(RIVAL_HITS[voFlip.current % RIVAL_HITS.length]!);
        }
      }
      // Something big enough to deform the shell also takes out glass, but only
      // while there is glass left to take out.
      if (player.impactFlash > 0.62 && glassLeft.current > 0) {
        glassLeft.current -= 1;
        audioEngine.glass(0.9);
      }
    }
    prevImpact.current = player.impactFlash;

    if (player.wreckTimer > 0.5 && prevWreck.current <= 0) {
      audioEngine.playSfx("wreck");
      audioEngine.playVoice("wreck");
      audioEngine.playVoice("rival-wreck");
      audioEngine.crowdSurge(1.4);
      glassLeft.current = 0;
    }
    prevWreck.current = player.wreckTimer;

    // Idle rival taunt: a long way into a close fight, once in a while. The
    // mixer's 19 s `rival` cooldown is what actually rate-limits this.
    if (
      st.phase === "racing" &&
      st.raceTime > 12 &&
      pressure > 0.6 &&
      Math.random() < delta * 0.06
    ) {
      voFlip.current += 1;
      audioEngine.playVoice(
        RIVAL_TAUNTS[voFlip.current % RIVAL_TAUNTS.length]!,
      );
    }

    // events is unshifted (newest first) and trimmed to 12 — walk back to the
    // last entry we saw rather than diffing lengths.
    const events = st.events;
    if (events.length && events[0] !== lastEvent.current) {
      const seen = lastEvent.current;
      const cut = seen ? events.indexOf(seen) : -1;
      // No anchor (first frame, or audio unlocked mid-heat) — play only the
      // newest so we don't dump a backlog of one-shots at once.
      const fresh = cut >= 0 ? cut : 1;
      // Oldest-first so a burst reads in the order it happened.
      for (let i = fresh - 1; i >= 0; i--) {
        const ev = events[i];
        if (ev) audioEngine.feedEvent(ev.message, ev.kind);
      }
      lastEvent.current = events[0]!;
    }
  }, FRAME.LATE);

  return null;
}

export function audioOnInputEdge(
  prev: PlayerInput | null,
  next: PlayerInput,
  classId: VehicleClassId,
) {
  if (!audioEngine.isUnlocked()) return;
  // Nothing is played off the input edge any more.
  //
  // firePrimary / useDefense / useUltimate moved to combat.ts, which is the only
  // place that knows the action actually happened — off the input edge the
  // player heard a shot every time they pressed the button, cooldown or not.
  // Boost was the last survivor of that pattern and had exactly the same fault:
  // pressing it with an empty meter lit a nitro ignition that no car was
  // getting. The frame loop already fires it off the `boostTimer` edge, which
  // is the boost actually starting.
  void prev;
  void next;
  void classId;
}
