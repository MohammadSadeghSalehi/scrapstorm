/**
 * Concept-reference generator: drives the Grok CLI, files the results, writes an index.
 *
 * These images are FOR MESH AUTHORING, not for the game. That single fact sets
 * every prompt convention below: neutral grey backdrop so nothing has to be
 * keyed out, three-quarter view because it reads silhouette and proportion at
 * once, and callout labels because the person modelling from it needs to know
 * which bits are load-bearing to the design.
 *
 * Run from Git Bash (the Grok CLI is a Windows binary):
 *   node scripts/gen-refs.mjs                 # everything not already present
 *   node scripts/gen-refs.mjs --only cars     # one category
 *   node scripts/gen-refs.mjs --force         # regenerate even if present
 *
 * Generation is serial on purpose. Each call takes a minute or two and running
 * a dozen at once would saturate a machine that has already been frozen once by
 * a parallel batch job.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, copyFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "refs");
const GROK = "C:\\Users\\sadeg\\.grok\\bin\\grok";

/**
 * House style, appended to every prompt.
 *
 * Kept in one place because consistency across the set matters more than any
 * individual image: a reference pack whose lighting and framing drift is
 * useless for judging whether two vehicles belong in the same game.
 */
const STYLE =
  "Post-apocalyptic desert combat racing game concept art. Weathered, rusted, " +
  "improvised armour welded onto recognisable road vehicles. Sun-bleached " +
  "orange, steel and bare metal palette. Neutral grey studio backdrop, even " +
  "three-point lighting, no environment, no motion blur. Photoreal render " +
  "quality, sharp focus, high detail suitable for 3D modelling reference. " +
  "Add small white callout labels naming the key design features.";

const SPECS = [
  // ── Vehicles ───────────────────────────────────────────────────────────
  {
    cat: "cars",
    slug: "interceptor-scout",
    prompt:
      "Three-quarter front view of a lightweight fast interceptor: low, narrow, " +
      "aerodynamic, stripped to bare frame in places for weight. Twin roof-mounted " +
      "energy bolt emitters, minimal armour, oversized rear wing, exposed turbo. " +
      "Reads as the fastest and most fragile class at a glance.",
  },
  {
    cat: "cars",
    slug: "bruiser-ram",
    prompt:
      "Three-quarter front view of a heavy bruiser: a wide, tall, brutally " +
      "armoured muscle car built to ram. Massive reinforced spiked ram plate, " +
      "thick plate armour over every panel, dual exhaust stacks, short-barrel " +
      "cannon on the roof. Reads as the heaviest and slowest class at a glance.",
  },
  {
    cat: "cars",
    slug: "duelist-technical",
    prompt:
      "Three-quarter front view of a balanced mid-weight duelist: a widebody " +
      "hatchback converted for combat. Side-mounted disc launchers, moderate " +
      "armour, spare wheels and fuel cans lashed to the rear, roof rack. " +
      "Reads as the versatile all-rounder class.",
  },
  {
    cat: "cars",
    slug: "boss-warlord",
    prompt:
      "Three-quarter front view of a final-boss vehicle: an intimidating " +
      "oversized armoured car with an asymmetric silhouette, a heavy rotating " +
      "turret, trophy plating made from the wrecks of defeated rivals, and a " +
      "distinctive black and gold warlord paint scheme. Must read as the most " +
      "dangerous vehicle in the game at a single glance.",
  },
  // ── Characters ─────────────────────────────────────────────────────────
  {
    cat: "characters",
    slug: "antagonist-warlord",
    prompt:
      "Character reference sheet, full body plus head close-up, of the league's " +
      "reigning champion and antagonist: scarred, arrogant, wearing a patched " +
      "racing suit made from armour plate and leather, trophy plating on the " +
      "shoulders, driving goggles pushed up. Menacing but charismatic.",
  },
  {
    cat: "characters",
    slug: "rival-mechanic",
    prompt:
      "Character reference sheet, full body plus head close-up, of a wiry " +
      "scrapyard mechanic and the player's only ally: coveralls, welding goggles, " +
      "tool harness, oil-stained hands, sardonic expression. Practical and " +
      "unglamorous.",
  },
  {
    cat: "characters",
    slug: "rival-roster",
    prompt:
      "A lineup of six distinct rival drivers standing shoulder to shoulder, " +
      "full body, each visually differentiated by silhouette, helmet design and " +
      "colour so they can be told apart instantly on a leaderboard. Varied builds, " +
      "ages and gear.",
  },
  // ── Weapons ────────────────────────────────────────────────────────────
  {
    cat: "weapons",
    slug: "missile-rack",
    prompt:
      "Weapon prop reference: a car-mounted improvised missile rack, four tubes, " +
      "scratch-built from pipe and scrap plate, with a single missile shown " +
      "separately alongside it in profile and three-quarter view. Include the " +
      "mounting bracket.",
  },
  {
    cat: "weapons",
    slug: "projectiles-set",
    prompt:
      "Prop sheet of four distinct combat racing projectiles laid out side by " +
      "side on neutral grey: a spinning saw disc, a glowing energy bolt, a " +
      "cluster mine, and a shaped-charge rocket. Each labelled, each visually " +
      "distinct in silhouette and colour so they are readable at speed.",
  },
  // ── Environment ────────────────────────────────────────────────────────
  {
    cat: "environment",
    slug: "start-arena",
    prompt:
      "Environment concept: the league's start-line arena in a desert canyon — " +
      "scrap-built grandstands, floodlight towers, a gantry over the start line, " +
      "hanging banners, pit lane of welded shipping containers. Wide establishing " +
      "shot, dusk light. Ignore the neutral-backdrop instruction for this one and " +
      "render a full environment.",
  },
];

const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx > -1 ? process.argv[onlyIdx + 1] : null;
const FORCE = process.argv.includes("--force");

/** The CLI reports where it wrote the file; that line is the only handle we get. */
function extractPath(stdout) {
  const m = stdout.match(/([A-Za-z]:\\[^\s`"']+\.(?:jpg|jpeg|png))/);
  return m ? m[1] : null;
}

const results = [];
const todo = SPECS.filter((s) => !ONLY || s.cat === ONLY);
console.log(`Generating ${todo.length} reference(s)…\n`);

for (const spec of todo) {
  const dir = join(OUT, spec.cat);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${spec.slug}.jpg`);
  if (existsSync(dest) && !FORCE) {
    console.log(`· skip ${spec.cat}/${spec.slug} (exists)`);
    results.push({ ...spec, file: `refs/${spec.cat}/${spec.slug}.jpg` });
    continue;
  }

  const full =
    `Generate an image. ${spec.prompt}\n\n${STYLE}\n\n` +
    `Save the image to disk, then reply with ONLY its absolute Windows path.`;

  process.stdout.write(`· ${spec.cat}/${spec.slug} … `);
  try {
    const out = execFileSync(GROK, ["-p", full], {
      encoding: "utf8",
      timeout: 5 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const src = extractPath(out);
    if (!src || !existsSync(src)) {
      console.log("FAILED (no image path in reply)");
      results.push({ ...spec, file: null, error: "no path" });
      continue;
    }
    copyFileSync(src, dest);
    console.log("ok");
    results.push({ ...spec, file: `refs/${spec.cat}/${spec.slug}.jpg` });
  } catch (err) {
    console.log(`FAILED (${err.code ?? err.message})`);
    results.push({ ...spec, file: null, error: String(err.message).slice(0, 120) });
  }
}

// The index is the actual deliverable — an image with no prompt beside it
// cannot be iterated on, only admired.
const md = [
  "# Concept reference pack",
  "",
  "Generated by `scripts/gen-refs.mjs` via the Grok CLI. Regenerate one with",
  "`node scripts/gen-refs.mjs --only <category> --force`.",
  "",
  "Every prompt below is appended with the shared house style defined in the",
  "script, so the set stays visually consistent.",
  "",
];
for (const cat of [...new Set(todo.map((s) => s.cat))]) {
  md.push(`## ${cat}`, "");
  for (const r of results.filter((x) => x.cat === cat)) {
    md.push(`### ${r.slug}`, "");
    md.push(r.file ? `![${r.slug}](${r.file})` : `_generation failed: ${r.error}_`);
    md.push("", "> " + r.prompt, "");
  }
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "README.md"), md.join("\n"));
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(results, null, 2));

const ok = results.filter((r) => r.file).length;
console.log(`\n${ok}/${results.length} written to refs/. Index: refs/README.md`);
