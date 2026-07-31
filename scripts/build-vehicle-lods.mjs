#!/usr/bin/env node
/**
 * Generate decimated LOD variants of the vehicle meshes.
 *
 *   node scripts/build-vehicle-lods.mjs
 *
 * The authored cars are ~100k triangles each. That is a reasonable hero
 * density, but a 4-car grid rendering all of them at full detail spends
 * ~400k tris/frame on vehicles — most of it on cars that are a few dozen
 * pixels tall. These variants are what the AI grid and distant traffic use.
 *
 *   lod1  ratio 0.25  (~26k tris) — AI cars, mid distance
 *   lod2  ratio 0.08  (~8k tris)  — far traffic
 *
 * Simplification preserves the bounding box, so the geometric facing rules in
 * GltfCar (align long axis to Z, flip so the taller half is at +Z) resolve
 * identically on every level — verified with inspect-mesh-orientation.mjs.
 *
 * Uses @gltf-transform/cli via npx so it stays out of package.json; the
 * outputs are gitignored along with the rest of public/assets/meshes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = "public/assets/meshes/custom";
const OUT_DIR = join(SRC_DIR, "lod");
const LEVELS = [
  { name: "lod1", ratio: 0.25, error: 0.008 },
  // Error, not ratio, is the binding constraint at this level — at --error
  // 0.02 the simplifier stopped around 23-29k, barely below lod1. Distant
  // traffic can afford far looser tolerance.
  { name: "lod2", ratio: 0.08, error: 0.09 },
];

function triCount(file) {
  const b = readFileSync(file);
  const jsonLen = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + jsonLen).toString("utf8"));
  let tris = 0;
  for (const m of j.meshes ?? [])
    for (const p of m.primitives ?? [])
      if (p.indices != null) tris += j.accessors[p.indices].count / 3;
  return Math.round(tris);
}

if (!existsSync(SRC_DIR)) {
  console.error(`missing ${SRC_DIR} — restore assets first`);
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

const sources = readdirSync(SRC_DIR).filter((f) => f.endsWith(".glb"));
if (!sources.length) {
  console.error(`no .glb in ${SRC_DIR}`);
  process.exit(1);
}

for (const file of sources) {
  const src = join(SRC_DIR, file);
  const base = file.replace(/\.glb$/i, "");
  console.log(`\n${file}  (${triCount(src)} tris)`);
  for (const lvl of LEVELS) {
    const out = join(OUT_DIR, `${base}.${lvl.name}.glb`);
    try {
      execFileSync(
        "npx",
        [
          "--yes",
          "@gltf-transform/cli@4",
          "simplify",
          src,
          out,
          "--ratio",
          String(lvl.ratio),
          "--error",
          String(lvl.error),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      console.log(`  ${lvl.name}: ${triCount(out)} tris`);
    } catch (e) {
      console.error(`  ${lvl.name} FAILED: ${e.message.split("\n")[0]}`);
      process.exitCode = 1;
    }
  }
}
