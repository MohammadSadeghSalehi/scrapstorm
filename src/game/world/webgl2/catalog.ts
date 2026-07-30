/**
 * Curated free / open asset sources for Scrapstorm (meshes + textures + HDRI).
 * Vendored packs live under /public/assets (see SOURCES.md).
 */
export const FREE_ASSET_CATALOG = {
  textures: [
    {
      name: "Poly Haven",
      license: "CC0",
      url: "https://polyhaven.com/textures",
      notes:
        "Vendored: asphalt_02, metal_plate, dirt_floor, sand_01, rusty_metal, concrete_floor_painted, gravelly_sand, corrugated_iron.",
    },
    {
      name: "ambientCG",
      license: "CC0",
      url: "https://ambientcg.com",
      notes: "Vendored: Rock020 → textures/rock.",
    },
  ],
  meshes: [
    {
      name: "Khronos glTF Sample Models",
      license: "open",
      url: "https://github.com/KhronosGroup/glTF-Sample-Models",
      notes: "Box, BoxAnimated, DamagedHelmet — scrapyard debris.",
    },
    {
      name: "Kenney / Quaternius / Poly Haven Models",
      license: "CC0",
      url: "https://polyhaven.com/models",
      notes: "Catalog for future packs (API rate-limits in sandbox).",
    },
  ],
  hdris: [
    {
      name: "Poly Haven HDRIs",
      license: "CC0",
      url: "https://polyhaven.com/hdris",
      notes: "industrial_sunset_puresky 1k/2k + kloppenheim_02_1k.",
    },
  ],
  shaders: [
    {
      name: "In-house GPU detail LoD",
      license: "project",
      notes: "Multi-band fBm noise on PBR materials; quality-gated.",
    },
    {
      name: "postprocessing / r3f-postprocessing",
      license: "MIT",
      notes: "Bloom, vignette, chromatic aberration, film grain.",
    },
  ],
  vendored: {
    root: "/assets",
    textures: [
      "asphalt",
      "dirt",
      "sand",
      "metal",
      "rust",
      "rock",
      "concrete",
      "gravel",
      "paint",
    ] as const,
    meshes: ["box", "crate", "prop", "lantern"] as const,
    hdri: ["industrial_sunset_1k.hdr", "industrial_sunset_2k.hdr", "kloppenheim_02_1k.hdr"] as const,
  },
} as const;
