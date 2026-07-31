/**
 * R3F-side continuous audio + event feeder from sim state.
 */
import { useRef, type MutableRefObject } from "react";
import { useFrame } from "@react-three/fiber";
import type { GameSimulation } from "../sim";
import { VEHICLE_CLASSES } from "../classes";
import { RACE } from "../balance";
import { isDrifting } from "../physics";
import { audioEngine } from "./AudioEngine";
import type { GameEvent, PlayerInput, VehicleClassId } from "../types";
import { FRAME } from "../world/framePriority";

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

  const musicBoot = useRef(false);
  useFrame(() => {
    if (!audioEngine.isUnlocked()) return;
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
    const player = st.vehicles.find((v) => v.isPlayer);
    if (!player) return;

    const def = VEHICLE_CLASSES[player.classId];
    const slip =
      player.tires?.reduce((a, t) => a + t.slip, 0) /
        Math.max(1, player.tires?.length ?? 1) || 0;
    const inp = lastInput.current;
    const drifting = inp
      ? isDrifting(player, inp)
      : player.driftMeter > 0.25;

    const sp = Math.abs(player.speed) / Math.max(1, def.maxSpeed);
    const gear = Math.min(5, Math.floor(sp * 5) + 1);
    const braking = !!(inp?.brake && !drifting && Math.abs(player.speed) > 10);
    audioEngine.updateContinuous({
      phase: st.phase,
      speed: Math.abs(player.speed),
      maxSpeed: def.maxSpeed,
      throttle: inp?.throttle ?? 0,
      drifting,
      slip: Math.min(1, slip),
      surface: player.surface,
      boost: player.boostTimer > 0,
      offroad: player.offroadAmount,
      gear,
      brake: braking,
    });

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
    if (st.events.length && st.events[0] !== lastEvent.current) {
      const seen = lastEvent.current;
      const cut = seen ? st.events.indexOf(seen) : -1;
      // No anchor (first frame, or audio unlocked mid-heat) — play only the
      // newest so we don't dump a backlog of one-shots at once.
      const fresh = cut >= 0 ? st.events.slice(0, cut) : st.events.slice(0, 1);
      // Oldest-first so a burst reads in the order it happened.
      for (let i = fresh.length - 1; i >= 0; i--) {
        audioEngine.feedEvent(fresh[i].message, fresh[i].kind);
      }
      lastEvent.current = st.events[0];
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
  if (next.firePrimary && !prev?.firePrimary) {
    if (classId === "bruiser") audioEngine.playSfx("cannon");
    else if (classId === "trickster") audioEngine.playSfx("disc");
    else audioEngine.playSfx("fire");
  }
  if (next.useDefense && !prev?.useDefense) audioEngine.playSfx("defense");
  if (next.useUltimate && !prev?.useUltimate) audioEngine.playSfx("ult");
  if (next.boost && !prev?.boost) audioEngine.playSfx("boost");
}
