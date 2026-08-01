export { ScatterField } from "./ScatterField";
export { RoadsideFurniture } from "./RoadsideFurniture";
export { VergeDrift } from "./VergeDrift";
export {
  APRON_M,
  curvatureThreshold,
  meanSpacing,
  mulberry32,
  scatterPoints,
  vergePoints,
  type ScatterPoint,
  type VergePoint,
} from "./placement";
export {
  boardGeometry,
  driftGeometry,
  railModuleGeometry,
  rockGeometry,
  scrubGeometry,
} from "./geometry";
export { buildScatterFields, footprintOf, type ScatterFields } from "./fields";
export { buildDriftRibbon } from "./driftRibbon";
export {
  BOARD_CAPSULE_R,
  BOARD_HALF_X,
  RAIL_CAPSULE_R,
  roadsideLayout,
  type BoardSite,
  type RailModule,
  type RoadsideLayout,
} from "./roadsideLayout";
export {
  isBoardDown,
  isRailDown,
  roadsideDamageVersion,
} from "./roadsideDamage";
export {
  packLayer,
  type InstanceDamage,
  type ScatterItem,
  type ScatterLayerData,
  type TierScale,
} from "./layerData";
export { reportDensity, triCount } from "./stats";
