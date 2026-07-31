#!/usr/bin/env node
/**
 * Fetch the Poly Haven CC0 model set into public/assets/meshes/polyhaven/,
 * laid out exactly as PH_MODELS in src/game/world/polyHavenAssets.ts expects:
 *
 *   polyhaven/<slug>/<slug>_1k.gltf  + <slug>.bin + textures/*.jpg
 *
 * Complements scripts/restore-assets.sh (which unpacks the local tarballs) for
 * the `03-polyhaven` part that never shipped.
 *
 *   node scripts/fetch-polyhaven.mjs            # all missing slugs
 *   node scripts/fetch-polyhaven.mjs old_tyre   # specific slugs
 *
 * Assets are CC0 — https://polyhaven.com/license
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const SLUGS = [
  "barrel_03",
  "plastic_crate_01",
  "cardboard_box_01",
  "old_tyre",
  "rusted_wheel_rim_01",
  "metal_jerrycan",
  "concrete_road_barrier",
  "metal_trash_can",
  "fire_hydrant",
  "namaqualand_boulder_02",
  "modular_chainlink_fence",
  "modular_pipes",
  /*
   * Refinery skyline set — replaces the untextured box "towers/cranes/pipes"
   * in CullableScenery (see SCENERY_KITS there for how each is composed).
   *
   * Every slug below was verified against https://api.polyhaven.com/assets?t=models.
   * The obvious guesses all 404 — Poly Haven has no shipping_container,
   * water_tower, chimney, scaffolding, steel_frame, industrial_pipe,
   * electrical_box, concrete_barrier or rusty_barrel. Do not "fix" these names;
   * re-query the assets endpoint instead.
   *
   * Kept deliberately small: every extra slug is a permanent material + 1k
   * texture set resident in VRAM for background geometry nobody looks at.
   * Rejected after measuring: modular_electricity_poles and modular_pipes-style
   * kits (100+ loose parts, 200k tris), namaqualand_cliff_01 (94k tris for one
   * rock), old_military_compressor (79k), industrial_storage_cart (19k tris for
   * a prop that is 1 m wide at 34 m away).
   */
  "overhead_crane", // 90k tris, 3 separable parts -> kind: "crane" (tier LOD)
  "propane_tank", // 5.2k tris, upscaled to 8.5 m -> refinery vessel, "tower"
  "modular_industrial_pipes_01", // 8 pipe sections, 0.6-5.8k tris each -> "pipe"
  "Barrel_01", // 2.7k tris oil drum -> "pile" (also upgrades PH_MODELS.barrel)
  "worn_metal_rack", // 6.4k tris rusted shelving -> "pile"
];

const want = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const slugs = want.length ? want : SLUGS;
const ROOT = "public/assets/meshes/polyhaven";
const RES = "1k";

const kb = (n) => `${(n / 1024).toFixed(0)}KB`;

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

async function download(url, dest) {
  if (existsSync(dest)) return { skipped: true, bytes: 0 };
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  return { skipped: false, bytes: buf.length };
}

let total = 0;
let failures = 0;
for (const slug of slugs) {
  process.stdout.write(`${slug} ... `);
  try {
    const files = await getJson(`https://api.polyhaven.com/files/${slug}`);
    const entry = files?.gltf?.[RES]?.gltf;
    if (!entry?.url) throw new Error(`no ${RES} glTF variant`);

    const dir = join(ROOT, slug);
    let bytes = 0;
    const main = await download(entry.url, join(dir, `${slug}_${RES}.gltf`));
    bytes += main.bytes;
    // include keys are paths relative to the .gltf (textures/*.jpg, *.bin)
    for (const [rel, info] of Object.entries(entry.include ?? {})) {
      const got = await download(info.url, join(dir, rel));
      bytes += got.bytes;
    }
    total += bytes;
    console.log(bytes ? `ok (${kb(bytes)})` : "already present");
  } catch (e) {
    failures++;
    console.log(`FAILED: ${e.message}`);
  }
}
console.log(`\nDownloaded ${kb(total)} into ${ROOT}${failures ? `  (${failures} failed)` : ""}`);
if (failures) process.exitCode = 1;
