/**
 * Public surface of the mission/career layer.
 *
 * The intended wiring, end to end:
 *
 *   const career = loadCareer();
 *   const def    = missionById(id)!;
 *   const run    = armMission(def, { heatFloor: heatNormalised(career) * 0.75 });
 *   sim.state.lapCount = def.laps;      // missions own lap count, not RACE.laps
 *   sim.setPhase("countdown");
 *
 *   // every frame, from the shell's existing HUD tick:
 *   applyMissionEffects(sim.state, stepMission(run, sim.state));
 *
 *   // when sim.state.phase === "finished":
 *   const summary = summarise(run, sim.state);
 *   const { career: next, award } = applyMissionResult(career, def, summary);
 *   saveCareer(next);                   // then pay award.scrap into meta.ts
 *   disarmMission();
 *
 * `stepMission` takes sim.state directly — SimState satisfies MissionSnapshot
 * structurally, so nothing has to be adapted, copied or kept in sync.
 */
export * from "./types";
export {
  armMission,
  applyMissionEffects,
  createMissionRun,
  disarmMission,
  missionVerdict,
  stepMission,
  summarise,
  type MissionRun,
  type MissionVerdict,
} from "./runtime";
export { EVENT_MISSIONS, MISSIONS_BY_ID } from "./catalog";
export { RIVALS, RIVALS_BY_RANK, DUEL_MISSIONS, duelMission, rivalById } from "./rivals";
export {
  ALL_MISSIONS,
  DEFAULT_CAREER,
  TRACK_UNLOCKS,
  affordable,
  applyMissionResult,
  availableEvents,
  board,
  canChallenge,
  currentRank,
  drainScrap,
  effectiveHeat,
  eventAvailable,
  fieldPace,
  heatNormalised,
  loadCareer,
  markBeatSeen,
  missionById,
  missionCost,
  nextRival,
  pendingIntroBeat,
  resetCareer,
  saveCareer,
  trackUnlocked,
  unlockedTracks,
  type BoardEntry,
  type CareerAward,
  type CareerState,
  type RivalStatus,
} from "./career";
