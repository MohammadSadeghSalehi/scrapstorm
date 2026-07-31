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

/**
 * Style for MESH-GENERATION references. Deliberately different from STYLE.
 *
 * The annotated concept sheets are for a human to model from; these are fed to
 * an image-to-3D model, and that inverts several conventions:
 *
 *  - NO CALLOUT LABELS. Text in the image is reconstructed as surface detail —
 *    the mesh comes back with the words baked into its albedo. This is the
 *    single most important difference and the reason the concept sheets cannot
 *    simply be reused for this.
 *  - ONE object, isolated. A sheet with six characters produces one fused
 *    blob; image-to-3D has no notion of "these are separate assets".
 *  - The object fills the frame and is never cropped. Anything outside the
 *    frame gets invented, and invented geometry is where these models go wrong.
 *  - Flat, even lighting with no cast shadow. Baked-in shading is
 *    reconstructed as albedo, so the mesh arrives pre-lit and then fights the
 *    game's own lighting for the rest of its life.
 *  - Plain white background rather than grey: maximum separation for the
 *    silhouette extraction these pipelines do first.
 */
const MESH_STYLE =
  "Single isolated object, centred, filling the frame, complete and uncropped. " +
  "Plain flat white background. Even diffuse studio lighting from all sides, " +
  "no cast shadow, no strong highlights, no rim light. Three-quarter view. " +
  "Sharp focus throughout, no depth of field, no motion blur. " +
  "ABSOLUTELY NO TEXT, no labels, no annotations, no watermarks, no arrows, " +
  "no measurement lines, no logos. Nothing but the object itself. " +
  "Post-apocalyptic desert combat racing style: weathered, rusted, improvised " +
  "armour, sun-bleached orange and bare steel palette. " +
  "Clean product-photography framing suitable for image-to-3D mesh generation.";

/**
 * One asset per entry — intentionally granular where the concept sheets were
 * composite. The roster of six became six; the projectile sheet became four.
 */
const SPECS_MESH = [
  // -- Vehicles --------------------------------------------------------
  { cat: "cars", slug: "interceptor-scout", prompt:
    "A lightweight fast combat racing car. Low, narrow, aerodynamic, partly " +
    "stripped to bare frame for weight. Twin slim roof-mounted emitter pods, " +
    "minimal armour plating, oversized rear wing, exposed turbocharger." },
  { cat: "cars", slug: "bruiser-ram", prompt:
    "A heavy armoured combat racing muscle car built to ram. Wide and tall, " +
    "massive reinforced spiked ram plate on the front, thick welded plate " +
    "armour over every panel, twin vertical exhaust stacks, short-barrel " +
    "cannon on the roof." },
  { cat: "cars", slug: "duelist-technical", prompt:
    "A mid-weight combat racing widebody hatchback. Side-mounted disc launcher " +
    "pods, moderate plate armour, spare wheels and fuel cans lashed to the " +
    "rear, roof rack." },
  { cat: "cars", slug: "boss-warlord", prompt:
    "An oversized intimidating armoured combat car with an asymmetric " +
    "silhouette. Heavy rotating turret, trophy plating welded across the " +
    "flanks, black and gold paint." },
  // -- Characters, split out of the roster sheet -------------------------
  { cat: "characters", slug: "antagonist-warlord", prompt:
    "Full body character, standing, arms at sides in a neutral stance. A " +
    "scarred arrogant champion driver in a patched racing suit of armour " +
    "plate and leather, trophy plating on the shoulders, driving goggles " +
    "pushed up on the forehead." },
  { cat: "characters", slug: "mechanic", prompt:
    "Full body character, standing, neutral stance, arms at sides. A wiry " +
    "scrapyard mechanic in oil-stained coveralls, welding goggles on the " +
    "forehead, tool harness across the chest, heavy boots." },
  { cat: "characters", slug: "rival-veteran", prompt:
    "Full body character, standing, neutral stance, arms at sides. An older " +
    "grizzled driver in an orange and rust patched racing suit with an " +
    "open-face helmet and goggles, sponsor patches, weathered gloves." },
  { cat: "characters", slug: "rival-heavy", prompt:
    "Full body character, standing, neutral stance, arms at sides. A broad " +
    "heavyset driver in a welded steel vest over grey coveralls, cage-style " +
    "bare-metal helmet, bare scarred arms." },
  { cat: "characters", slug: "rival-ace", prompt:
    "Full body character, standing, neutral stance, arms at sides. A lean " +
    "young driver in a clean fitted racing suit with a bold diagonal orange " +
    "stripe and a sleek modern aerodynamic full-face helmet, visibly the " +
    "best-equipped of the field." },
  { cat: "characters", slug: "rival-brute", prompt:
    "Full body character, standing, neutral stance, arms at sides. A towering " +
    "armoured driver in heavy riveted plate armour with a spiked industrial " +
    "helm, chainmail skirt, oversized boots." },
  { cat: "characters", slug: "rival-scavenger", prompt:
    "Full body character, standing, neutral stance, arms at sides. A driver in " +
    "a patchwork canvas and leather suit, rebreather half-helm with a hose to " +
    "a belt canister, ear defenders, orange neck scarf, utility pouches." },
  { cat: "characters", slug: "rival-rookie", prompt:
    "Full body character, standing, neutral stance, arms at sides. A small " +
    "slight young driver in black and orange with a chrome moto helmet and " +
    "light strapped plate armour over the torso." },
  // -- Weapons, split out of the projectile sheet -------------------------
  { cat: "weapons", slug: "missile-rack", prompt:
    "A car-mounted improvised four-tube missile rack, scratch-built from steel " +
    "pipe and scrap plate, with its mounting bracket attached." },
  { cat: "weapons", slug: "missile", prompt:
    "A single improvised rocket-propelled missile with fins, a shaped charge " +
    "nose cone and a welded steel body." },
  { cat: "weapons", slug: "saw-disc", prompt:
    "A single heavy circular saw blade projectile, serrated, worn steel with a " +
    "reinforced hub, edge nicked and scarred from use." },
  { cat: "weapons", slug: "cluster-mine", prompt:
    "A single improvised cluster mine: a squat cylindrical canister with " +
    "protruding trigger prongs, a carry handle and hazard-striped casing." },
  { cat: "weapons", slug: "cannon-turret", prompt:
    "A roof-mounted vehicle cannon turret with a short heavy barrel, ammo belt " +
    "feed, hand grips and a rotating base ring." },
  // -- Props -------------------------------------------------------------
  { cat: "props", slug: "fuel-barrel", prompt:
    "A single rusted 55-gallon steel fuel drum, dented, paint peeling, " +
    "standing upright." },
  { cat: "props", slug: "scrap-barricade", prompt:
    "A single freestanding road barricade improvised from welded scrap metal, " +
    "corrugated sheet and rebar, with hazard paint." },
];

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
const setIdx = process.argv.indexOf("--set");
/** "concept" = annotated sheets for a human; "mesh" = clean single assets. */
const SET = setIdx > -1 ? process.argv[setIdx + 1] : "concept";
const MESH = SET === "mesh";
const ACTIVE = MESH ? SPECS_MESH : SPECS;
const SUBDIR = MESH ? join(OUT, "mesh") : OUT;
const REL = MESH ? "refs/mesh" : "refs";

/** The CLI reports where it wrote the file; that line is the only handle we get. */
function extractPath(stdout) {
  const m = stdout.match(/([A-Za-z]:\\[^\s`"']+\.(?:jpg|jpeg|png))/);
  return m ? m[1] : null;
}

const results = [];
const todo = ACTIVE.filter((s) => !ONLY || s.cat === ONLY);
console.log(`Generating ${todo.length} reference(s)…\n`);

for (const spec of todo) {
  const dir = join(SUBDIR, spec.cat);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${spec.slug}.jpg`);
  if (existsSync(dest) && !FORCE) {
    console.log(`· skip ${spec.cat}/${spec.slug} (exists)`);
    results.push({ ...spec, file: `${REL}/${spec.cat}/${spec.slug}.jpg` });
    continue;
  }

  const full =
    `Generate an image. ${spec.prompt}\n\n${MESH ? MESH_STYLE : STYLE}\n\n` +
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
    results.push({ ...spec, file: `${REL}/${spec.cat}/${spec.slug}.jpg` });
  } catch (err) {
    console.log(`FAILED (${err.code ?? err.message})`);
    results.push({ ...spec, file: null, error: String(err.message).slice(0, 120) });
  }
}

// The index is the actual deliverable — an image with no prompt beside it
// cannot be iterated on, only admired.
const md = [
  MESH
    ? "# Mesh-generation reference pack\n\nOne asset per image: no text, flat lighting, white background. Feed these straight to an image-to-3D model. Regenerate with `node scripts/gen-refs.mjs --set mesh --only <category> --force`."
    : "# Concept reference pack",
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
mkdirSync(SUBDIR, { recursive: true });
writeFileSync(join(SUBDIR, "README.md"), md.join("\n"));
writeFileSync(join(SUBDIR, "manifest.json"), JSON.stringify(results, null, 2));

const ok = results.filter((r) => r.file).length;
console.log(`\n${ok}/${results.length} written to ${REL}/.`);
