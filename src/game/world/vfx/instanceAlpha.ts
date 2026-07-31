/**
 * Per-instance opacity for InstancedMesh.
 *
 * `InstancedMesh` gives you a per-instance colour and nothing else, which is a
 * real problem for normal-blended smoke: the only lever left is to multiply the
 * COLOUR by the fade, and a puff whose colour is driven to zero does not
 * disappear against bright sand — it turns into a dark ghost and then pops out.
 * That artefact is visible in the pre-existing particle view and is the single
 * biggest thing separating this smoke from something that reads as atmosphere.
 *
 * So: one instanced float attribute and a two-line shader injection.
 *
 * This is written to FAIL SAFE. If either anchor string ever stops matching
 * (a three upgrade rewrites the chunk names), `String.replace` is a no-op, the
 * shader still compiles — the varying is simply unused — and the layer falls
 * back to exactly the colour-multiplied fade it would have had anyway. That is
 * why the renderer ALSO folds the fade into the instance colour: the patched
 * path is an improvement on the unpatched one, never a dependency of it.
 *
 * `attribute`/`varying` are still the correct keywords: three compiles for
 * GLSL ES 3.00 but prepends `#define attribute in` / `#define varying out`
 * compatibility defines, which is why its own built-in shaders still declare
 * `attribute vec3 position`.
 */
import * as THREE from "three";

export const INSTANCE_ALPHA_ATTR = "aAlpha";

export function attachInstanceAlpha(mat: THREE.Material): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader =
      `attribute float ${INSTANCE_ALPHA_ATTR};\nvarying float vInstAlpha;\n` +
      shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>\n\tvInstAlpha = ${INSTANCE_ALPHA_ATTR};`,
    );
    shader.fragmentShader = "varying float vInstAlpha;\n" + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      "#include <map_fragment>\n\tdiffuseColor.a *= vInstAlpha;",
    );
  };
  // Without a distinct cache key the patched and unpatched variants of the same
  // material parameters would share one compiled program, and which one you got
  // would depend on mount order.
  mat.customProgramCacheKey = () => "vfx-instance-alpha-1";
  mat.needsUpdate = true;
}

/**
 * Add the instanced alpha attribute to a geometry destined for an InstancedMesh
 * of `count` instances. Values start at 1 so an unwritten slot is never
 * invisible for one frame.
 */
export function addInstanceAlphaAttribute(
  geo: THREE.BufferGeometry,
  count: number,
): THREE.InstancedBufferAttribute {
  const attr = new THREE.InstancedBufferAttribute(new Float32Array(count).fill(1), 1);
  attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute(INSTANCE_ALPHA_ATTR, attr);
  return attr;
}
