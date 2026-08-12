export { ScatterField } from "./ScatterField";
export { RoadsideFurniture } from "./RoadsideFurniture";
export { RoadsideLighting } from "./RoadsideLighting";
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
  cactusGeometry,
  catenaryWireGeometry,
  coloredCylinder,
  driftGeometry,
  facetedRock,
  lampGlowGeometry,
  lampPostGeometry,
  orientedBox,
  paintVertices,
  railModuleGeometry,
  rockGeometry,
  scrubGeometry,
  signGeometry,
  LAMP_HEAD,
  LAMP_REACH,
  LAMP_WIRE_TIE,
  SIGN_PLATE_BASE_Y,
  SIGN_PLATE_HALF_X,
} from "./geometry";
export { buildScatterFields, footprintOf, type ScatterFields } from "./fields";
export { buildDriftRibbon } from "./driftRibbon";
export {
  BOARD_CAPSULE_R,
  BOARD_HALF_X,
  LAMP_CAPSULE_R,
  RAIL_CAPSULE_R,
  SIGN_CAPSULE_R,
  roadsideLayout,
  type BoardSite,
  type LampSite,
  type RailModule,
  type RoadsideLayout,
  type SignSite,
  type WireSpan,
} from "./roadsideLayout";
export {
  isBoardDown,
  isLampDown,
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
