/**
 * Lane-space wear on the track ribbon — polished wheel grooves, dusty kerbs.
 *
 * The ribbon already carries the coordinate we need: `roadSegments.pushQuad`
 * writes v = 0 at the left kerb and v = 1 at the right kerb, so "how far across
 * the tarmac am I" is a raw vertex attribute. Reading it costs one interpolated
 * float and zero texture fetches, which is why this is done in the shader
 * instead of authoring a wear mask — a mask would be another sampler bound on
 * the single largest surface in the frame.
 *
 * Why it matters visually: real asphalt is not one roughness. Tyres burnish two
 * narrow ruts to a near-wet polish while the crown between them and the strip
 * against the kerb stay coarse and dust-blown. That contrast is what makes a
 * road throw a bright specular streak that slides along the surface as the car
 * turns relative to the sun. A single roughness value cannot produce that at
 * *any* setting — it either shines everywhere or nowhere.
 *
 * Targets are absolute rather than multiplicative on purpose. The roughness
 * pack's own range is unknown at author time, so `mix(r, min(r, target))` gives
 * a predictable polished floor while leaving the map's variation intact on the
 * dry tarmac between the ruts.
 */
import type * as THREE from "three";

export type RoadWearOpts = {
  /** Wheel-groove centres in ribbon v space (0 = left kerb, 1 = right kerb). */
  grooves?: [number, number];
  /** Half-width of a groove in v space (≈0.1 ≈ one car track on a 26m road). */
  grooveHalf?: number;
  /** Roughness the burnished rut is pulled down to. Lower = wetter. */
  polishedRoughness?: number;
  /** Roughness the dust against the kerb is pushed up to. */
  dustyRoughness?: number;
  /** Albedo darkening inside the rut (rubber laid down). */
  rubberDarken?: number;
  /** Albedo lift at the kerb (wind-blown sand over the tarmac). */
  dustLighten?: number;
};

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

/**
 * Inject lane wear into an already-compiling MeshStandardMaterial.
 *
 * Chains onto any existing `onBeforeCompile` (the road also runs
 * `attachGpuDetail`), and re-emits the `<roughnessmap_fragment>` token so a
 * later injector can still find its own anchor.
 */
export function attachRoadWear(
  material: THREE.MeshStandardMaterial,
  opts: RoadWearOpts = {},
): void {
  const [g0, g1] = opts.grooves ?? [0.32, 0.68];
  const half = opts.grooveHalf ?? 0.11;
  const polished = opts.polishedRoughness ?? 0.26;
  const dusty = opts.dustyRoughness ?? 0.78;
  const rubber = opts.rubberDarken ?? 0.12;
  const dustLift = opts.dustLighten ?? 0.09;

  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <uv_pars_vertex>",
        /* glsl */ `
        #include <uv_pars_vertex>
        varying float vRoadLane;
        `,
      )
      .replace(
        "#include <uv_vertex>",
        /* glsl */ `
        #include <uv_vertex>
        // Raw attribute, not vMapUv — vMapUv has the tiling repeat baked in.
        vRoadLane = uv.y;
        `,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <uv_pars_fragment>",
        /* glsl */ `
        #include <uv_pars_fragment>
        varying float vRoadLane;
        `,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        /* glsl */ `
        #include <roughnessmap_fragment>
        {
          float lane = vRoadLane;
          float rutDist = min(abs(lane - ${f(g0)}), abs(lane - ${f(g1)}));
          // 1 in the burnished rut, 0 on dry tarmac.
          float rut = 1.0 - smoothstep(${f(half * 0.35)}, ${f(half)}, rutDist);
          // 0 on the crown, 1 hard against the kerb.
          float dust = smoothstep(0.33, 0.5, abs(lane - 0.5));
          roughnessFactor = mix(
            roughnessFactor,
            min(roughnessFactor, ${f(polished)}),
            rut
          );
          roughnessFactor = mix(
            roughnessFactor,
            max(roughnessFactor, ${f(dusty)}),
            dust
          );
          // diffuseColor already has map + vertex colour applied at this point,
          // so tinting here avoids a second injection site in <map_fragment>.
          diffuseColor.rgb *= 1.0 - ${f(rubber)} * rut + ${f(dustLift)} * dust;
        }
        `,
      );
  };

  const prevKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${prevKey()}|roadWear|${g0},${g1}`;
  material.needsUpdate = true;
}
