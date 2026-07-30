/**
 * Back-compat facade over the multi-map procedural material system.
 * Prefer `createProcMaterial` / `getRecipeMaps` from `./procmat` for new code.
 */
import * as THREE from "three";
import { checkerMap, getRecipeMaps, hazardMap } from "./procmat";

export { checkerMap, hazardMap };
export {
  createProcMaterial,
  getRecipeMaps,
  bakeProcMaps,
  cloneMaps,
} from "./procmat";

/** @deprecated use getRecipeMaps('asphalt').map */
export function asphaltMap(): THREE.Texture {
  return getRecipeMaps("asphalt").map;
}
/** @deprecated */
export function dirtMap(): THREE.Texture {
  return getRecipeMaps("dirt").map;
}
/** @deprecated */
export function sandMap(): THREE.Texture {
  return getRecipeMaps("sand").map;
}
/** @deprecated */
export function metalMap(): THREE.Texture {
  return getRecipeMaps("metal").map;
}
/** @deprecated */
export function rustMap(): THREE.Texture {
  return getRecipeMaps("rust").map;
}
/** @deprecated */
export function asphaltRoughMap(): THREE.Texture {
  return getRecipeMaps("asphalt").roughnessMap;
}
/** @deprecated */
export function bumpMap(): THREE.Texture {
  return getRecipeMaps("asphalt").normalMap;
}

export function cloneRepeat(tex: THREE.Texture, rx: number, ry: number): THREE.Texture {
  const t = tex.clone();
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.needsUpdate = true;
  return t;
}
