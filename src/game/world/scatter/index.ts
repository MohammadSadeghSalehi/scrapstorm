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
  packLayer,
  type ScatterItem,
  type ScatterLayerData,
  type TierScale,
} from "./layerData";
export { reportDensity, triCount } from "./stats";
