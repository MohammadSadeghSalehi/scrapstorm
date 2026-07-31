/**
 * Compile-time proof that the sim can be handed straight to the mission layer.
 *
 * The runtime reads a structural VIEW (MissionSnapshot) rather than SimState, so
 * that missions do not depend on the sim's shape and the sim does not have to
 * know missions exist. The cost of that decoupling is that nothing normally
 * checks the two still line up — the mismatch would only show up at the call
 * site, in a file this module does not own, as a wall of assignability errors
 * about a type nobody there has heard of.
 *
 * These assertions fail the build here instead, next to the fix. If one of them
 * goes red, a field was renamed or narrowed in types.ts: update the view, do not
 * loosen the assertion.
 *
 * Types only — this file emits nothing.
 */
import type { SimState } from "../types";
import type {
  MissionMutableWorld,
  MissionSnapshot,
  MissionVehicleView,
} from "./types";

type Assert<T extends true> = T;

/** `stepMission(run, sim.state)` must typecheck with no adapter. */
export type SnapshotIsSatisfiedBySimState = Assert<
  SimState extends MissionSnapshot ? true : false
>;

/** `applyMissionEffects(sim.state, fx)` must typecheck with no adapter. */
export type MutableWorldIsSatisfiedBySimState = Assert<
  SimState extends MissionMutableWorld ? true : false
>;

/** Every field the view reads must still exist on a vehicle. */
export type VehicleViewIsSatisfied = Assert<
  SimState["vehicles"][number] extends MissionVehicleView ? true : false
>;
