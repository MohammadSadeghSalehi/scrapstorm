/**
 * Per-circuit built structure — public API.
 *
 * The environments (../environments) decide what a circuit looks LIKE. This
 * decides what it IS: what has been built beside the road, how close, and how
 * much of the sky it takes. Foundry Pit is walled in and Sable Run is not, and
 * that is a property of the layout rather than of the light on it.
 */
export { Setpieces } from "./Setpieces";
export {
  buildSetpieceLayers,
  getActiveSetpieces,
  type BuiltSetpieces,
  type SetpieceLayer,
} from "./build";
export { SETPIECES, DEFAULT_SETPIECES } from "./presets";
export {
  auditActiveSetpieces,
  measureActiveSetpieces,
  type SetpieceAudit,
} from "./audit";
export { SETPIECE_GEOMETRY, boundsOf } from "./geometry";
export {
  corridorAnchors,
  fieldAnchors,
  worstClearance,
  type Anchor,
} from "./placement";
export * from "./types";
