#!/usr/bin/env node
/**
 * Roadside-signage reference pack, via the Grok CLI, plus a palette readout.
 *
 *   node scripts/gen-signage.mjs                # everything missing
 *   node scripts/gen-signage.mjs --force        # regenerate
 *   node scripts/gen-signage.mjs --palette      # just re-read the palettes
 *
 * ── what this is FOR, and what it is deliberately NOT for ──────────────
 *
 * The sign faces in the game are CANVAS-DRAWN (see world/scatter/signFaces.ts),
 * not loaded from any file this script writes. That is not an oversight, it is
 * the same three reasons StartGantry gives for drawing its atlas rather than
 * fetching one:
 *
 *  - generated lettering is a defect. It misspells, it cannot be localised, and
 *    it is permanently the wrong size for the plate it lands on. A sign whose
 *    whole job is to be READ cannot be a guess at letterforms;
 *  - `public/assets/` is gitignored, so a generated PNG is an asset no clone of
 *    this repo has; and
 *  - Vite caches the public directory listing at startup, so a newly added file
 *    404s until the dev server is restarted — which reads exactly like a broken
 *    material.
 *
 * So what Grok is used for here is ART DIRECTION and nothing else: what a
 * salvage-league roadside sign is MADE of, how it fails, what its chevrons and
 * arrows look like, and — the one machine-readable output — the palette those
 * plates actually sit in. `--palette` runs each reference through ffmpeg down to
 * an 8x8 raw RGB grid and prints it as hex. Those numbers were transcribed by
 * hand into `SIGN_PALETTE` in world/scatter/signFaces.ts, with this script named
 * as their source, so the game stays self-contained and the derivation stays
 * checkable.
 *
 * Retrieval works the way gen-refs.mjs and gen-ui.mjs work, for the reason
 * documented at length in both: the CLI reports its output path in PROSE and the
 * wording is not stable, so we decide the path instead by passing our own
 * `--session-id` and scanning one level of ~/.grok/sessions for it. `--cwd`
 * points somewhere that is not this repository, because an agent told to make an
 * image will sometimes decide to save a converted copy as well.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "refs", "signage");
const GROK = "C:\\Users\\sadeg\\.grok\\bin\\grok";
const SESSIONS = join(homedir(), ".grok", "sessions");
const SCRATCH = join(tmpdir(), "scrapstorm-gen-signage");

const FORCE = process.argv.includes("--force");
const PALETTE_ONLY = process.argv.includes("--palette");

/**
 * House style. Two things here are doing real work and are not decoration.
 *
 * "Photographed straight on, flat to the camera" — a sign reference shot at an
 * angle is useless for reading proportion, and proportion (how much of the plate
 * is legend, how thick the border is, where the fixings sit) is most of what
 * separates a sign from a rectangle.
 *
 * "Sun-bleached" rather than "rusted" for the FACE — the posts and frames rust,
 * the retroreflective sheeting chalks and fades. Asking for rust everywhere
 * produces a brown board, and a brown board is invisible against this desert.
 */
const STYLE =
  "Post-apocalyptic desert combat racing league. Improvised roadside signage " +
  "salvaged and re-made from scrap: bent steel plate, hand-cut edges, welded " +
  "brackets, mismatched bolts, a rusted galvanised post. The sign FACE is " +
  "sun-bleached bone-white and pale grey retroreflective sheeting, chalked and " +
  "faded, with legends in heavy amber and burnt orange over near-black " +
  "charcoal stencil. Bullet dents, road grit, dark vertical rain streaking " +
  "down the plate. Photographed straight on, flat to the camera, no " +
  "perspective, even overcast light, no cast shadow, sharp focus.";

const ONE_SHOT =
  " Make exactly ONE image-generation call and then stop. Do not write, edit " +
  "or convert any files, do not run any shell commands, and do not attempt " +
  "any post-processing or follow-up generations.";

/**
 * Lettering is allowed in these — and only these — because the whole point of
 * the sheet is to see how a legend sits on a plate.
 *
 * It will be misspelled. That is expected and is exactly why none of it reaches
 * the game: every word the player reads is drawn by `drawSignAtlas` from a
 * string in source. What the sheet is being asked for is the SHAPE of a legend,
 * not its content.
 */
const SPECS = [
  {
    slug: "warning-plates",
    prompt:
      "A reference sheet of six roadside WARNING sign plates for a desert " +
      "race circuit, laid out in two rows of three on a plain neutral grey " +
      "backdrop, each plate a wide landscape rectangle roughly twice as wide " +
      "as it is tall, mounted on a single short steel post. Left to right: a " +
      "board of three big amber chevrons pointing left; the same pointing " +
      "right; a curving black arrow warning of a left bend; a curving black " +
      "arrow warning of a right bend; a hairpin double-back arrow; a plate of " +
      "diagonal black and amber hazard stripes.",
  },
  {
    slug: "braking-boards",
    prompt:
      "A reference sheet of three roadside BRAKING MARKER boards for a race " +
      "circuit, side by side on a plain neutral grey backdrop. Each is a wide " +
      "landscape steel plate on a single post carrying one huge numeral and a " +
      "row of short slashes beneath it — three slashes, then two, then one. " +
      "The numerals are enormous, filling most of the plate height, dark " +
      "charcoal on bleached white sheeting with a heavy dark border.",
  },
  {
    slug: "route-markers",
    prompt:
      "A reference sheet of four salvage-league ROUTE MARKER plates on a " +
      "plain neutral grey backdrop: a downward chevron insignia cut with " +
      "short tally strokes, stencilled in worn amber paint onto dark steel, " +
      "with a single line of stencil capitals beneath it. Show the same mark " +
      "at four stages of decay, from freshly sprayed to almost gone.",
  },
  {
    slug: "verge-hoardings",
    prompt:
      "A reference sheet of three large roadside HOARDINGS on twin legs at " +
      "the edge of a desert race circuit, seen straight on against a plain " +
      "neutral grey backdrop. Each is a wide billboard panel roughly three " +
      "times as wide as it is tall, framed in angle iron with a dark bar " +
      "along the bottom edge: one a league banner in amber on charcoal, one a " +
      "scrap-trader advertisement, one half torn away to bare plywood and " +
      "flapping sheet.",
  },
  {
    slug: "plate-weathering",
    prompt:
      "Extreme close-up of ONE weathered steel sign plate face filling the " +
      "whole frame, flat to the camera. Chalked bleached white sheeting over " +
      "steel, dark vertical rain streaks, a rust bloom creeping in from two " +
      "bolt holes, fine sand-blast pitting, one deep dent, the ghost of an " +
      "older amber legend showing through a coat of paint. No new lettering.",
  },
];

/** See the note at the top: the reply is prose, the directory layout is not. */
function extractPath(stdout, sid) {
  const m = stdout.match(/([A-Za-z]:\\[^\s`"'()[\]]+\.(?:jpg|jpeg|png|webp))/);
  if (m && existsSync(m[1])) return m[1];
  let entries;
  try {
    entries = readdirSync(SESSIONS);
  } catch {
    return null;
  }
  for (const e of entries) {
    const dir = join(SESSIONS, e, sid, "images");
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir)
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      .map((f) => join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return files[0] ?? null;
  }
  return null;
}

/**
 * The palette of a reference, as an 8x8 grid of hex.
 *
 * ffmpeg rather than an image library: it is already a dependency of the video
 * import path, and box-scaling a JPEG to 8x8 is exactly the average-over-a-tile
 * operation you want — every cell is the mean colour of a sixty-fourth of the
 * frame, so the grid IS the palette, weighted by area.
 */
function palette(file) {
  let raw;
  try {
    raw = execFileSync(
      "ffmpeg",
      ["-v", "error", "-i", file, "-vf", "scale=8:8", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
      { maxBuffer: 1 << 20, encoding: "buffer" },
    );
  } catch (err) {
    return [`(ffmpeg failed: ${String(err.message).slice(0, 60)})`];
  }
  const rows = [];
  for (let y = 0; y < 8; y++) {
    const row = [];
    for (let x = 0; x < 8; x++) {
      const o = (y * 8 + x) * 3;
      row.push(
        "#" +
          [raw[o], raw[o + 1], raw[o + 2]]
            .map((v) => v.toString(16).padStart(2, "0"))
            .join(""),
      );
    }
    rows.push(row.join(" "));
  }
  return rows;
}

mkdirSync(OUT, { recursive: true });
const results = [];

for (const spec of SPECS) {
  const dest = join(OUT, `${spec.slug}.jpg`);
  if (PALETTE_ONLY) {
    results.push({ ...spec, file: existsSync(dest) ? dest : null });
    continue;
  }
  if (existsSync(dest) && !FORCE) {
    console.log(`· skip ${spec.slug} (exists)`);
    results.push({ ...spec, file: dest });
    continue;
  }

  const full = `Generate an image. ${spec.prompt}\n\n${STYLE}\n\n${ONE_SHOT}`;
  const sid = randomUUID();
  mkdirSync(SCRATCH, { recursive: true });
  process.stdout.write(`· ${spec.slug} … `);
  try {
    const out = execFileSync(
      GROK,
      ["--cwd", SCRATCH, "--session-id", sid, "-p", full],
      { cwd: SCRATCH, encoding: "utf8", timeout: 6 * 60 * 1000, maxBuffer: 8 << 20 },
    );
    const src = extractPath(out, sid);
    if (!src) {
      console.log("FAILED (no image found in the session directory)");
      results.push({ ...spec, file: null, error: "no image" });
      continue;
    }
    copyFileSync(src, dest);
    console.log("ok");
    results.push({ ...spec, file: dest });
  } catch (err) {
    console.log(`FAILED (${err.code ?? String(err.message).slice(0, 60)})`);
    results.push({ ...spec, file: null, error: String(err.message).slice(0, 120) });
  }
}

/* ── the index, and the palette readout ───────────────────────────────── */

const md = [
  "# Roadside signage reference",
  "",
  "Generated by `scripts/gen-signage.mjs` via the Grok CLI.",
  "",
  "**These are reference, not assets.** Every sign face in the game is drawn on a",
  "canvas by `src/game/world/scatter/signFaces.ts` — see the note at the top of",
  "the script for why generated lettering cannot ship. What came from here is the",
  "material language (bleached sheeting, amber legend, charcoal ground, rain",
  "streaking down the plate) and the palette printed below, which was transcribed",
  "into `SIGN_PALETTE`.",
  "",
  "Regenerate with `node scripts/gen-signage.mjs --force`, or re-read the",
  "palettes alone with `node scripts/gen-signage.mjs --palette`.",
  "",
];

console.log("\n── palettes (8x8 area-weighted, via ffmpeg) ───────────────");
for (const r of results) {
  md.push(`## ${r.slug}`, "");
  md.push(r.file ? `![${r.slug}](${r.slug}.jpg)` : `_generation failed: ${r.error}_`);
  md.push("", "> " + r.prompt, "");
  if (!r.file) continue;
  console.log(`\n  ${r.slug}`);
  const rows = palette(r.file);
  md.push("```");
  for (const row of rows) {
    console.log(`    ${row}`);
    md.push(row);
  }
  md.push("```", "");
}

writeFileSync(join(OUT, "README.md"), md.join("\n"));
const ok = results.filter((r) => r.file).length;
console.log(`\n${ok}/${results.length} reference(s) in refs/signage/.`);
