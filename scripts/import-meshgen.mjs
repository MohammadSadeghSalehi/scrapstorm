#!/usr/bin/env node
/**
 * Turn generated meshes in refs/mesh/ into game-ready assets.
 *
 *   node scripts/import-meshgen.mjs            # everything not already built
 *   node scripts/import-meshgen.mjs --force
 *   node scripts/import-meshgen.mjs --only weapons
 *
 * WHY THIS EXISTS. Image-to-3D output is authored for a turntable, not a game.
 * Every mesh arrives at roughly the same cost regardless of how big the object
 * is or how close you ever get to it: the 30cm rocket came in at 95,770
 * triangles with two 1024x1024 PNGs — 11.2 MB of VRAM for something that
 * renders about twenty pixels tall. The entire rest of the scene is 780k
 * triangles. Dropping these in unprocessed would roughly double the frame's
 * geometry to draw five projectiles.
 *
 * So budgets here are set by SCREEN SIZE, not by source complexity. A saw blade
 * you see for half a second at 15m gets 600 triangles and a 256px albedo; a car
 * you sit behind for three laps gets 40k and 1024. That difference is the whole
 * point of the file.
 *
 * Textures matter more than triangles here. 95k triangles is ~3.5 MB of buffer;
 * the two PNGs are 11.2 MB of GPU memory, and there are eight of these. Resize
 * happens BEFORE compression so the encoder works on the final resolution.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, basename } from "node:path";

const FORCE = process.argv.includes("--force");
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx > -1 ? process.argv[onlyIdx + 1] : null;

/**
 * Per-category budgets.
 *
 * `lods` are simplify ratios against the SOURCE triangle count. Ratio is a
 * request, not a guarantee — meshoptimizer stops early when the error bound
 * binds first, which is why an error is given too and why the manifest reports
 * what was actually achieved rather than what was asked for.
 *
 * THE FIRST PASS MISSED BUDGET BY ~10x AND LOOKED LIKE IT WORKED. Asking for
 * ratio 0.015 on the rocket returned 11,656 triangles instead of ~1,400, and
 * car lod2 returned 30,626 instead of ~3,000, because the errors below were set
 * for a hand-authored mesh (0.008-0.05). These are surface RECONSTRUCTIONS —
 * dense, noisy, and carrying no clean edge loops for the simplifier to follow,
 * so a tight error budget is spent almost immediately on surface noise and the
 * collapse stops long before the ratio is met.
 *
 * The errors are now set by viewing distance instead. A 30cm rocket seen at 15m
 * can absorb enormous relative error because its silhouette is a blob at that
 * size; a car you sit behind cannot. That is the same principle as the texture
 * budgets, applied to geometry.
 *
 * AND THAT STILL DOES NOT REACH THE SMALL BUDGETS, for a reason worth writing
 * down. At --ratio 0.001 --error 1 — completely unconstrained — the rocket
 * floors at 11,652 triangles, and --lock-border makes no difference. At that
 * floor it has 11,652 triangles against 15,754 vertices: FEWER triangles than
 * vertices, where a connected closed mesh has roughly twice as many. That is the
 * signature of a mesh made of thousands of disconnected shells, which is what
 * surface reconstruction produces. meshoptimizer preserves component count — it
 * will not merge or delete separate islands — so each shell holds a floor of a
 * few triangles and no flag can go below the sum.
 *
 * Fixing it properly needs remeshing (voxel remesh then retopologise), which is
 * a Blender/instant-meshes job, not a gltf-transform one. Until then the
 * ~11.6k floor is a property of the ASSET, and the budgets below record what was
 * asked for so the gap stays visible instead of being quietly rewritten to
 * match whatever came out.
 */
const CATEGORIES = {
  cars: {
    dest: "public/assets/meshes/custom",
    // Matches the existing hero cars: ~100k authored, lod1 ~26k, lod2 ~8k.
    lods: [
      { name: null, ratio: 0.35, error: 0.02 },
      { name: "lod1", ratio: 0.1, error: 0.12 },
      { name: "lod2", ratio: 0.03, error: 0.4 },
    ],
    texture: 1024,
  },
  weapons: {
    dest: "public/assets/meshes/weapons",
    /*
     * Split by how close the player ever gets, which is not the same as how
     * big the object is. A turret is bolted to your own roof and fills a
     * chunk of the chase camera; a rocket is a streak. Same category, two
     * budgets an order of magnitude apart.
     */
    perFile: {
      WastelandHeavyTurret: { lods: [{ name: null, ratio: 0.06, error: 0.25 }], texture: 512 },
      ImprovisedQuadLauncher: { lods: [{ name: null, ratio: 0.06, error: 0.25 }], texture: 512 },
      ScrapMetalRocket: { lods: [{ name: null, ratio: 0.015, error: 0.8 }], texture: 256 },
      RustyIndustrialSawBlade: { lods: [{ name: null, ratio: 0.012, error: 0.8 }], texture: 256 },
      ImprovisedSpikedMine: { lods: [{ name: null, ratio: 0.015, error: 0.8 }], texture: 256 },
    },
    lods: [{ name: null, ratio: 0.05, error: 0.5 }],
    texture: 256,
  },
};

const SRC_ROOT = "refs/mesh";
const TMP = ".meshgen-tmp";

function gltf(args) {
  return execFileSync(
    "npx",
    ["--yes", "@gltf-transform/cli@4", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 },
  );
}

/** Triangle count straight out of `inspect`, so it reports the real asset. */
function triangles(file) {
  try {
    const out = gltf(["inspect", file]);
    // Strip ANSI, then find the glPrimitives column of the mesh table.
    const plain = out.replace(/\[[0-9;]*m/g, "");
    let total = 0;
    for (const line of plain.split("\n")) {
      const m = line.match(/TRIANGLES\s*│\s*[\d,]+\s*│\s*([\d,]+)/);
      if (m) total += Number(m[1].replace(/,/g, ""));
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Which texture codec is actually available.
 *
 * gltf-transform's etc1s/uastc commands shell out to KTX-Software's `ktx`
 * binary, which is not installed here — the repo already hit this in
 * compress-textures.mjs and worked around it with basisu prebuilts, but that
 * path operates on standalone files and these textures are embedded in the GLB.
 *
 * Falling back to WebP rather than failing. The reason that is acceptable is
 * that the RESIZE has already done the heavy lifting: a 1024 to 256 downscale
 * is a 16x cut in pixels, and at 256 a texture is 0.26 MB of VRAM uncompressed,
 * so ETC1S would be saving fractions of a megabyte. On the 1024 car textures it
 * would still be worth roughly 25 MB across three cars — so this reports which
 * path it took instead of quietly choosing one.
 */
function hasKtx() {
  try {
    execFileSync("sh", ["-c", "command -v ktx"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const KTX = hasKtx();
console.log(
  KTX
    ? "texture codec: KTX2/ETC1S"
    : "texture codec: WebP (install KTX-Software and re-run --force for ETC1S)",
);

mkdirSync(TMP, { recursive: true });
const report = [];

for (const [cat, cfg] of Object.entries(CATEGORIES)) {
  if (ONLY && cat !== ONLY) continue;
  const srcDir = join(SRC_ROOT, cat);
  if (!existsSync(srcDir)) continue;
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".glb"));
  mkdirSync(cfg.dest, { recursive: true });

  for (const file of files) {
    const src = join(srcDir, file);
    const stem = basename(file, ".glb").replace(/^SM_MeshGen_/, "");
    const spec = cfg.perFile?.[stem] ?? cfg;
    const srcTris = triangles(src);
    const srcKb = statSync(src).size / 1024;

    for (const lod of spec.lods) {
      const outName = lod.name
        ? `${basename(file, ".glb")}.${lod.name}.glb`
        : file;
      const outDir = lod.name ? join(cfg.dest, "lod") : cfg.dest;
      mkdirSync(outDir, { recursive: true });
      const out = join(outDir, outName);
      if (existsSync(out) && !FORCE) {
        report.push({ file: outName, skipped: true });
        continue;
      }

      const a = join(TMP, `a-${outName}`);
      const b = join(TMP, `b-${outName}`);
      try {
        /*
         * weld first — though MEASURED, it does almost nothing on these: on the
         * rocket it merged 12 vertices out of 75,118, because image-to-3D output
         * arrives already indexed. Kept because it is nearly free and it is a
         * real prerequisite for hand-authored or OBJ-derived sources, but do not
         * expect it to unlock simplification here. It does not.
         */
        gltf(["weld", src, a]);
        gltf([
          "simplify", a, b,
          "--ratio", String(lod.ratio),
          "--error", String(lod.error),
        ]);
        // Resize before compressing so the encoder sees final pixels.
        gltf(["resize", b, a, "--width", String(spec.texture), "--height", String(spec.texture)]);
        /*
         * ETC1S when available, not UASTC: these are heavily downscaled already
         * and the subjects are rusty and mottled, which is exactly what ETC1S
         * handles without visible artefacts at a quarter of UASTC's size.
         * WebP otherwise — see hasKtx above for why that is an acceptable
         * fallback rather than a failure.
         */
        if (KTX) gltf(["etc1s", a, b, "--quality", "160"]);
        else gltf(["webp", a, b, "--quality", "85"]);
        gltf(["meshopt", b, out]);

        const outTris = triangles(out);
        const outKb = statSync(out).size / 1024;
        report.push({
          file: outName,
          cat,
          srcTris,
          outTris,
          triPct: srcTris ? Math.round((outTris / srcTris) * 1000) / 10 : null,
          srcKb: Math.round(srcKb),
          outKb: Math.round(outKb),
          sizePct: Math.round((outKb / srcKb) * 1000) / 10,
          texture: spec.texture,
          codec: KTX ? "etc1s" : "webp",
        });
        console.log(
          `  ${outName.padEnd(46)} ${String(srcTris).padStart(7)} -> ${String(outTris).padStart(6)} tris` +
            `   ${String(Math.round(srcKb)).padStart(6)} -> ${String(Math.round(outKb)).padStart(5)} KB`,
        );
      } catch (err) {
        console.error(`  ${outName} FAILED: ${String(err.message).slice(0, 200)}`);
        report.push({ file: outName, error: true });
      }
    }
  }
}

writeFileSync(
  join("public/assets/meshes", "meshgen-manifest.json"),
  JSON.stringify(report, null, 2),
);
const done = report.filter((r) => !r.error && !r.skipped);
const tris = done.reduce((n, r) => n + (r.outTris || 0), 0);
console.log(`\n${done.length} built, ${tris.toLocaleString()} triangles total.`);
