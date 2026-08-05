#!/usr/bin/env node
/**
 * Copy the authored cutscenes out of refs/vids into public/assets/video.
 *
 *   node scripts/import-videos.mjs
 *   node scripts/import-videos.mjs --force
 *
 * The source files are named "First vid.mp4" … "nineth vid.mp4", which is the
 * order they were generated in and carries no meaning the game can read. This
 * maps them onto the nine cutscene slots, in the order they appear in
 * refs/VIDEO_BRIEF.md — the brief lists exactly nine before it moves on to the
 * per-circuit establishing shots, and nine is what was delivered.
 *
 * THAT MAPPING IS AN INFERENCE, not something the files state. It is a single
 * table on purpose: if a clip is in the wrong slot, fix the row and re-run,
 * rather than hunting through component code for a hardcoded filename.
 *
 * public/assets is gitignored, so this script is the deliverable and the .mp4s
 * are reproducible from refs/.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = "refs/vids";
const DEST = "public/assets/video";
const FORCE = process.argv.includes("--force");

/** source file → cutscene id, following refs/VIDEO_BRIEF.md order. */
const MAP = [
  { src: "First vid.mp4", id: "cold-open", note: "the wreck that starts the story" },
  { src: "Second vid.mp4", id: "title", note: "title reveal, holds under the card" },
  { src: "third vid.mp4", id: "menu-loop", note: "scrapyard, loops behind the main menu" },
  { src: "Fourth vid.mp4", id: "garage", note: "car orbit, loops behind the garage" },
  { src: "Fifth vid.mp4", id: "grid", note: "start line, plays before the countdown" },
  { src: "sixth vid.mp4", id: "rival", note: "blacklist card, before a duel" },
  { src: "seventh vid.mp4", id: "antagonist", note: "Marrow, before the rank-1 duel" },
  { src: "eighth vid.mp4", id: "victory", note: "over the results screen on a win" },
  { src: "nineth vid.mp4", id: "defeat", note: "over the results screen on a loss" },
];

if (!existsSync(SRC)) {
  console.error(`no ${SRC}/ — nothing to import`);
  process.exit(1);
}
mkdirSync(DEST, { recursive: true });

const present = new Set(readdirSync(SRC));
const manifest = [];
let copied = 0;

for (const m of MAP) {
  if (!present.has(m.src)) {
    console.log(`  ${m.id.padEnd(12)} MISSING  (${m.src})`);
    continue;
  }
  const out = join(DEST, `${m.id}.mp4`);
  const bytes = statSync(join(SRC, m.src)).size;
  if (existsSync(out) && !FORCE) {
    console.log(`  ${m.id.padEnd(12)} skip     (exists)`);
  } else {
    copyFileSync(join(SRC, m.src), out);
    copied++;
    console.log(
      `  ${m.id.padEnd(12)} ok       ${(bytes / 1048576).toFixed(1)} MB  <- ${m.src}`,
    );
  }
  manifest.push({ id: m.id, file: `${m.id}.mp4`, bytes, source: m.src, note: m.note });
}

const unmapped = [...present].filter(
  (f) => f.endsWith(".mp4") && !MAP.some((m) => m.src === f),
);
if (unmapped.length) {
  console.log(`\n  unmapped in ${SRC}: ${unmapped.join(", ")}`);
}

writeFileSync(join(DEST, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`\n${copied} copied, ${manifest.length} in manifest.`);
