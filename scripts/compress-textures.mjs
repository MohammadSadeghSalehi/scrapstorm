#!/usr/bin/env node
/**
 * Encode the standalone PBR texture packs to KTX2 / Basis Universal.
 *
 *   node scripts/compress-textures.mjs [--force] [--only asphalt,sand]
 *
 * The packs under public/assets/textures are JPEG. JPEG is only small on disk —
 * the GPU cannot sample it, so three decodes every map to RGBA8 and uploads it
 * uncompressed. A 1024x1024 map therefore costs 4MB of VRAM (5.3MB with the
 * mip chain) no matter how well the JPEG compressed. Twelve packs of 3-5 maps
 * each is why the texture library alone runs into the tens of megabytes, and
 * the refinery skyline pushed it further.
 *
 * KTX2 stores a GPU-native block-compressed format, so what is on disk is what
 * sits in VRAM, with no main-thread decode. Two profiles are used:
 *
 *   ETC1S  -> BC1/ETC1/ASTC at 4bpp   (colour, roughness, metal, AO)
 *   UASTC  -> BC7/ASTC at 8bpp        (normals only)
 *
 * Normals get UASTC because ETC1S picks two colour endpoints per 4x4 block and
 * interpolates: fine for albedo, but on a tangent-space normal map that
 * quantises the XY vectors and shows up as blocky faceted lighting. UASTC is
 * ~2x the size of ETC1S and still 4x smaller than RGBA8.
 *
 * The JPEGs are deliberately left in place. scripts/../textureLibrary.ts reads
 * the manifest this script writes and falls back to .jpg for anything not
 * listed, so the game runs identically before and after this script is run.
 *
 * Idempotent: a .ktx2 newer than its .jpg is skipped. Use --force to redo.
 *
 * Outputs (all gitignored, like the source art):
 *   public/assets/textures/<pack>/<map>.ktx2
 *   public/assets/textures/ktx2-manifest.json
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const TEX_DIR = join(ROOT, "public/assets/textures");
const MANIFEST = join(TEX_DIR, "ktx2-manifest.json");

/**
 * Pinned so the encode is reproducible. This package is just the upstream
 * Binomial basisu CLI with prebuilt win32/linux binaries — @gltf-transform's
 * own etc1s/uastc commands shell out to KTX-Software's `toktx`, which is not
 * installed here and has no npm distribution.
 */
const BASISU_PKG = "basis_universal@1.16.4-1";
const CACHE_DIR = join(ROOT, "node_modules/.cache/basisu");

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const onlyArg = args.indexOf("--only");
const ONLY =
  onlyArg >= 0 && args[onlyArg + 1]
    ? new Set(args[onlyArg + 1].split(","))
    : null;

/**
 * Encoder profiles keyed by map basename — the set textureLibrary.ts loads.
 *
 * `-y_flip` is on everything and is not optional: three's CompressedTexture
 * forces flipY = false (WebGL ignores UNPACK_FLIP_Y_WEBGL for compressed
 * uploads), while a JPEG through TextureLoader gets the default flipY = true.
 * Without flipping at encode time the KTX2 would sample upside down relative
 * to the JPEG it replaces — invisible on a stochastic albedo tile, but it
 * inverts the green channel's meaning on a normal map, so lighting would tilt
 * the wrong way vertically.
 *
 * `-linear` / `-normal_map` do two things: they switch the encoder off
 * perceptual (sRGB-weighted) error metrics and off sRGB-space mip filtering,
 * and they write KHR_DF_TRANSFER_LINEAR into the KTX2 data format descriptor.
 * That second part matters at runtime — three's KTX2Loader reads the transfer
 * function back out and assigns texture.colorSpace from it, which in turn
 * selects the sRGB or linear GL internal format at upload.
 */
const COMMON = ["-ktx2", "-mipmap", "-y_flip"];
const PROFILES = {
  // sRGB albedo.
  diff: { label: "ETC1S sRGB", args: [...COMMON, "-q", "200", "-comp_level", "2"] },
  // Tangent-space normals — UASTC, linear.
  nor: {
    label: "UASTC linear",
    args: [
      ...COMMON,
      "-normal_map",
      "-uastc",
      "-uastc_level",
      "2",
      // RDO trades a little quality for a lot of Zstd ratio on the container.
      "-uastc_rdo_l",
      "1.0",
    ],
  },
  // Single-channel data replicated to RGB. Linear, never sRGB.
  rough: { label: "ETC1S linear", args: [...COMMON, "-linear", "-q", "200", "-comp_level", "2"] },
};
PROFILES.metal = PROFILES.rough;
PROFILES.ao = PROFILES.rough;

/** Resolve a basisu executable, installing the pinned package on first run. */
function resolveBasisu() {
  // Respect a system install (KTX-Software / basisu on PATH) if there is one.
  try {
    execFileSync("basisu", ["-version"], { stdio: "ignore" });
    return "basisu";
  } catch {
    /* fall through to the pinned npm copy */
  }

  const binDir = join(CACHE_DIR, "node_modules/basis_universal/bin");
  const exe = join(binDir, process.platform === "win32" ? "basisu.exe" : "basisu");

  if (!existsSync(exe)) {
    console.log(`installing ${BASISU_PKG} into node_modules/.cache ...`);
    mkdirSync(CACHE_DIR, { recursive: true });
    // A stub manifest keeps npm from walking up and touching the real one.
    writeFileSync(
      join(CACHE_DIR, "package.json"),
      JSON.stringify({ name: "basisu-cache", private: true, version: "1.0.0" }),
    );
    execFileSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", BASISU_PKG, "--prefix", CACHE_DIR, "--no-audit", "--no-fund", "--no-save"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  }
  if (!existsSync(exe)) throw new Error(`no basisu binary at ${exe}`);
  // The tarball does not carry the exec bit on the POSIX binary.
  if (process.platform !== "win32") chmodSync(exe, 0o755);
  return exe;
}

/**
 * Minimal KTX2 header read, so the report states what was actually written
 * rather than what was requested. Layout per the KTX2 spec: 12-byte identifier,
 * then the u32 header fields; the data format descriptor's transfer function is
 * the 11th byte of the block that starts at dfdByteOffset (after its u32 size).
 */
const TRANSFER = { 1: "linear", 2: "sRGB" };
function ktxInfo(file) {
  const b = readFileSync(file);
  const dfdOffset = b.readUInt32LE(48);
  return {
    width: b.readUInt32LE(20),
    height: b.readUInt32LE(24),
    levels: b.readUInt32LE(40),
    // 1 = BasisLZ (ETC1S), 2 = Zstandard (UASTC).
    uastc: b.readUInt32LE(44) === 2,
    transfer: TRANSFER[b.readUInt8(dfdOffset + 4 + 10)] ?? "?",
  };
}

/** Bytes a mipped texture occupies in VRAM. The mip chain adds ~1/3. */
const withMips = (bytes) => Math.round((bytes * 4) / 3);
const vramRgba8 = (w, h) => withMips(w * h * 4);
const vramBlock = (w, h, uastc) => withMips(uastc ? w * h : (w * h) / 2);
const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;

if (!existsSync(TEX_DIR)) {
  console.error(`missing ${TEX_DIR} — run scripts/restore-assets.sh first`);
  process.exit(1);
}

let basisu;
try {
  basisu = resolveBasisu();
} catch (e) {
  // No encoder is a soft failure by design: the runtime falls back to JPEG, so
  // a machine without one can still build and run the game.
  console.error(`\nno KTX2 encoder available — ${e.message}`);
  console.error("textures will keep loading as JPEG. Nothing was changed.");
  process.exit(1);
}
console.log(`encoder: ${basisu}\n`);

const packs = readdirSync(TEX_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((n) => !ONLY || ONLY.has(n))
  .sort();

let jpgTotal = 0;
let ktxTotal = 0;
let vramBefore = 0;
let vramAfter = 0;
let encoded = 0;
let skipped = 0;
let failed = 0;

for (const pack of packs) {
  const dir = join(TEX_DIR, pack);
  const rows = [];

  for (const [map, profile] of Object.entries(PROFILES)) {
    const src = join(dir, `${map}.jpg`);
    if (!existsSync(src)) continue;
    const out = join(dir, `${map}.ktx2`);

    const fresh =
      !FORCE && existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs;
    if (!fresh) {
      try {
        execFileSync(basisu, [...profile.args, "-file", src, "-output_file", out], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        encoded++;
      } catch (e) {
        // One bad map must not abort the run — the rest still get encoded and
        // the manifest simply omits this one, so it stays on the JPEG path.
        console.error(`  ! ${pack}/${map}: ${String(e.message).split("\n")[0]}`);
        failed++;
        continue;
      }
    } else {
      skipped++;
    }

    const srcBytes = statSync(src).size;
    const outBytes = statSync(out).size;
    const info = ktxInfo(out);
    jpgTotal += srcBytes;
    ktxTotal += outBytes;
    vramBefore += vramRgba8(info.width, info.height);
    vramAfter += vramBlock(info.width, info.height, info.uastc);
    rows.push(
      `    ${map.padEnd(6)} ${String(Math.round(srcBytes / 1024)).padStart(5)}KB jpg ->` +
        ` ${String(Math.round(outBytes / 1024)).padStart(5)}KB ktx2` +
        `  ${info.transfer.padEnd(6)} ${info.uastc ? "UASTC" : "ETC1S"}` +
        `${fresh ? "  (cached)" : ""}`,
    );
  }

  if (rows.length) {
    console.log(`  ${pack}`);
    for (const r of rows) console.log(r);
  }
}

/**
 * The manifest is what makes the fallback free. Without it the runtime would
 * have to probe for each .ktx2 and eat a 404 per map before using the JPEG;
 * with it, one fetch tells the loader exactly which files exist.
 *
 * Built by scanning the tree rather than from what this run happened to encode:
 * a --only run would otherwise rewrite the manifest with just that pack and
 * silently drop every other already-encoded map back onto the JPEG path. The
 * scan also self-heals if a .ktx2 is deleted by hand.
 */
const present = [];
for (const pack of readdirSync(TEX_DIR, { withFileTypes: true })) {
  if (!pack.isDirectory()) continue;
  for (const f of readdirSync(join(TEX_DIR, pack.name))) {
    if (f.endsWith(".ktx2")) present.push(`${pack.name}/${f.slice(0, -5)}`);
  }
}
writeFileSync(
  MANIFEST,
  `${JSON.stringify(
    {
      encoder: BASISU_PKG,
      generated: new Date().toISOString(),
      files: present.sort(),
    },
    null,
    2,
  )}\n`,
);

console.log(
  `\n${encoded} encoded, ${skipped} cached, ${failed} failed` +
    ` — ${present.length} maps in manifest`,
);
console.log(`  disk   ${mb(jpgTotal)} jpg  ->  ${mb(ktxTotal)} ktx2`);
console.log(
  `  VRAM   ${mb(vramBefore)} rgba8 -> ${mb(vramAfter)} block` +
    `  (saves ${mb(vramBefore - vramAfter)}, ${(vramBefore / vramAfter).toFixed(1)}x)`,
);
if (failed) process.exitCode = 1;
