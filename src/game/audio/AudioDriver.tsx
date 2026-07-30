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
import type { PlayerInput, VehicleClassId } from "../types";
import { FRAME } from "../world/framePriority";

export function AudioDriver({
  sim,
  lastInput,
}: {
  sim: GameSimulation;
  lastInput: MutableRefObject<PlayerInput | null>;
}) {
  const prevEvents = useRef(0);
  const prevBoost = useRef(0);
  const prevPhase = useRef(sim.state.phase);
  const prevCd = useRef(-1);
  const prevWreck = useRef(0);
  const prevImpact = useRef(0);
  const prevDrift = useRef(false);

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
      }
      if (st.phase === "racing") audioEngine.playMusic("race_intensity");
      if (st.phase === "finished") {
        audioEngine.playUi("finish");
        audioEngine.playMusic("victory");
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
      }
    } else {
      prevCd.current = -1;
    }

    // Final lap music swell
    if (st.phase === "racing" && player.lap >= RACE.laps - 1) {
      audioEngine.playMusic("final_lap");
    }

    if (player.boostTimer > 0.4 && prevBoost.current <= 0.4) {
      audioEngine.playSfx("boost");
      audioEngine.playSfx("whoosh");
    }
    prevBoost.current = player.boostTimer;

    if (drifting && !prevDrift.current && Math.abs(player.speed) > 18) {
      audioEngine.playSfx("drift");
    }
    prevDrift.current = drifting;

    if (player.impactFlash > 0.2 && prevImpact.current <= 0.12) {
      audioEngine.playImpact(0.7 + player.impactFlash * 2);
    }
    prevImpact.current = player.impactFlash;

    if (player.wreckTimer > 0.5 && prevWreck.current <= 0) {
      audioEngine.playSfx("wreck");
    }
    prevWreck.current = player.wreckTimer;

    if (st.events.length > prevEvents.current) {
      const n = st.events.length - prevEvents.current;
      const fresh = st.events.slice(0, n);
      for (const e of fresh) {
        audioEngine.feedEvent(e.message, e.kind);
      }
    }
    prevEvents.current = st.events.length;
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
