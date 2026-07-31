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
 * opponent buffer are module-level and reused, and the cue drain takes a
 * module-level callback rather than a fresh closure.
 */
import { useRef, type MutableRefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { GameSimulation } from "../sim";
import { VEHICLE_CLASSES } from "../classes";
import { RACE } from "../balance";
import { isDrifting } from "../physics";
import { getSurfaceAt } from "../track";
import { audioEngine, type ContinuousInput } from "./AudioEngine";
import { drainAudioCues, type AudioCue } from "./cues";
import { OPPONENT_STRIDE, OPPONENT_VOICES } from "./spatial";
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
  dt: 1 / 60,
};

const OPP = new Float32Array(OPPONENT_VOICES * OPPONENT_STRIDE);
/** Squared distance of the vehicle currently held in each opponent slot. */
const OPP_DIST = new Float32Array(OPPONENT_VOICES);

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
  const prevDrift = useRef(false);
  const prevLap = useRef(0);
  const prevPos = useRef(0);
  const voFlip = useRef(0);
  const surfaceAt = useRef(0);

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
      if (st.phase === "menu") {
        audioEngine.playMusic("menu_anthem");
      }
      if (st.phase === "garage") {
        audioEngine.playMusic("garage_vibe");
      }
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

    const def = VEHICLE_CLASSES[player.classId];
    const tires = player.tires;
    let slip = 0;
    if (tires && tires.length) {
      for (let i = 0; i < tires.length; i++) slip += tires[i]!.slip;
      slip /= tires.length;
    }
    const inp = lastInput.current;
    const drifting = inp ? isDrifting(player, inp) : player.driftMeter > 0.25;

    const sp = Math.abs(player.speed) / Math.max(1, def.maxSpeed);
    const gear = Math.min(5, Math.floor(sp * 5) + 1);
    const braking = !!(inp?.brake && !drifting && Math.abs(player.speed) > 10);

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
    CONT.dt = delta;
    audioEngine.updateContinuous(CONT);

    // Nearest few rivals get a panned engine drone. Selection is an insertion
    // into a fixed 3-slot table rather than a sort, so no array is built.
    if (racing) {
      let count = 0;
      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i]!;
        if (v.isPlayer || !v.alive) continue;
        const dx = v.x - player.x;
        const dz = v.z - player.z;
        const d2 = dx * dx + dz * dz;
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
      }
      audioEngine.updateOpponents(OPP, count, delta);
    } else {
      audioEngine.silenceOpponents();
    }

    drainAudioCues(onCue);

    // One-shot layers for brake lockup / drift entry
    if (braking && Math.abs(player.speed) > 25) {
      // continuous scrub covers it; occasional sample
      if (Math.random() < 0.02) audioEngine.playSfx("scrape");
    }

    if (st.phase !== prevPhase.current) {
      if (st.phase === "countdown") {
        audioEngine.playUi("confirm");
        audioEngine.playMusic("race_heat");
        audioEngine.playVoice("grid-locked");
      }
      if (st.phase === "racing") audioEngine.playMusic("race_intensity");
      if (st.phase === "finished") {
        audioEngine.playUi("finish");
        audioEngine.playMusic("victory");
        // finishedOrder is authoritative once anyone crossed; `position` is the
        // fallback for a heat that ended without a finisher (retire/restart).
        const won = st.finishedOrder.length
          ? st.finishedOrder[0] === player.id
          : player.position === 1;
        audioEngine.playVoice(won ? "win" : "loss");
      }
      if (st.phase === "paused") audioEngine.playUi("pause");
      if (st.phase === "menu") {
        audioEngine.playMusic("menu_anthem");
      }
      if (st.phase === "garage") {
        audioEngine.playMusic("garage_vibe");
      }
      prevPhase.current = st.phase;
    }

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
      }
    } else {
      prevCd.current = -1;
    }

    // Final lap music swell
    if (st.phase === "racing" && player.lap >= RACE.laps - 1) {
      audioEngine.playMusic("final_lap");
    }

    // Lap calls. `finished` guards the last gate crossing, which increments
    // lap one final time and would otherwise announce a lap the player is
    // never going to drive.
    if (st.phase === "racing" && player.lap > prevLap.current && !player.finished) {
      const entersFinal = player.lap >= st.lapCount - 1;
      audioEngine.playVoice(
        entersFinal ? "final-lap" : player.lap % 2 === 1 ? "lap-1" : "lap-2",
      );
    }
    prevLap.current = player.lap;

    // Overtake: position is 1-based, so a decrease is a place gained. Skip the
    // opening seconds where the grid is still sorting itself out.
    if (
      st.phase === "racing" &&
      st.raceTime > 4 &&
      prevPos.current > 0 &&
      player.position < prevPos.current &&
      !player.finished
    ) {
      audioEngine.playVoice("overtake");
    }
    prevPos.current = player.position;

    if (player.boostTimer > 0.4 && prevBoost.current <= 0.4) {
      audioEngine.playSfx("boost");
      audioEngine.playSfx("whoosh");
      voFlip.current += 1;
      audioEngine.playVoice(voFlip.current % 2 ? "boost-1" : "boost-2");
    }
    prevBoost.current = player.boostTimer;

    if (drifting && !prevDrift.current && Math.abs(player.speed) > 18) {
      audioEngine.playSfx("drift");
    }
    prevDrift.current = drifting;

    if (player.impactFlash > 0.2 && prevImpact.current <= 0.12) {
      audioEngine.playImpact(0.7 + player.impactFlash * 2);
      // Only real hits get a call-out; the low threshold above also catches
      // wall scrapes.
      if (player.impactFlash > 0.45) {
        voFlip.current += 1;
        audioEngine.playVoice(voFlip.current % 2 ? "hit-1" : "hit-2");
      }
    }
    prevImpact.current = player.impactFlash;

    if (player.wreckTimer > 0.5 && prevWreck.current <= 0) {
      audioEngine.playSfx("wreck");
      audioEngine.playVoice("wreck");
    }
    prevWreck.current = player.wreckTimer;

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
  // firePrimary / useDefense / useUltimate are deliberately *not* handled here
  // any more. They now come out of combat.ts, which is the only place that
  // knows the action actually happened — off the input edge the player heard a
  // shot every time they pressed the button, cooldown or not.
  void classId;
  if (next.boost && !prev?.boost) audioEngine.playSfx("boost");
}
