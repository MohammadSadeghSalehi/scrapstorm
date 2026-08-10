#!/usr/bin/env node
/**
 * Interface art, via the Grok CLI.
 *
 *   node scripts/gen-ui.mjs                 # everything missing
 *   node scripts/gen-ui.mjs --only frames
 *   node scripts/gen-ui.mjs --force
 *
 * WHY THIS IS NOT gen-refs.mjs. Concept art is looked AT; interface art is
 * looked THROUGH. That inverts most of the prompt conventions:
 *
 *  - FLAT, not lit. A panel with its own light source fights the page and dates
 *    instantly. These want even illumination and no cast shadow.
 *  - NEGATIVE SPACE IS THE POINT. Every one of these has text over it, so the
 *    centre has to stay quiet. A gorgeous busy texture is a useless panel.
 *  - TILEABLE OR EDGE-SAFE. A frame gets stretched to fit content it has never
 *    seen; anything with a hard composition at a fixed size will tear.
 *  - NO TEXT, EVER. Generated lettering is misspelled, unlocalisable and
 *    permanently the wrong size. All real type is rendered by the app.
 *
 * Output is PNG with transparency where the shape needs it, into
 * public/assets/ui/. That directory is gitignored like the rest of
 * public/assets, so this script is the deliverable.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * HOW THE IMAGE IS RETRIEVED, AND WHY IT IS NOT BY SCRAPING STDOUT
 *
 * The Grok CLI's image tool writes to a per-session directory:
 *
 *     ~/.grok/sessions/<percent-encoded-cwd>/<session-id>/images/<n>.jpg
 *
 * It then *reports* that location in prose, and the wording is not stable. The
 * same prompt produced an absolute Windows path on one run and the markdown
 * link `[images/1.jpg](images/1.jpg)` on the next. The old regex — match a
 * drive-lettered path in stdout — worked until it silently didn't, and the
 * failure mode was "generation succeeded, 0 files landed", which is the worst
 * one available: minutes of model time burned per image, nothing to show.
 *
 * So we do not ask the CLI where it put the file. We *decide* where it will put
 * it, by passing `--session-id` (a UUID we generate) and `--cwd` (a scratch
 * directory). The session id is unique, so the image directory is found by a
 * one-level scan of ~/.grok/sessions for a child named <session-id> — no need
 * to reimplement the CLI's path-encoding scheme. stdout parsing survives only
 * as a first guess; the session scan is the thing that actually works.
 *
 * Two more consequences of driving an *agent* rather than an image endpoint:
 *
 *  - `--cwd` points at a scratch dir, never the repo. Asked to "save a PNG with
 *    a transparent background", the agent helpfully went and wrote a converted
 *    PNG into the repository root. Anything it decides to write now lands in a
 *    directory nobody is watching.
 *  - The prompt tells it to make exactly one generation call and stop. Left to
 *    itself it will chroma-key, re-generate, and re-convert for several extra
 *    minutes and arrive somewhere worse than we get below.
 *
 * FORMAT. The tool only ever emits JPEG, and UiArt.tsx loads `.png`. ffmpeg does
 * the conversion. For the assets that need a cutout we cannot ask for alpha —
 * the model has no alpha — so we ask for a flat magenta field and key it out,
 * sampling the actual corner pixel because the model renders "pure magenta" as
 * whatever it feels like (#d72c8f, in testing). Similarity is kept low: at 0.40
 * the key started eating gunmetal.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public/assets/ui");
const GROK = "C:\\Users\\sadeg\\.grok\\bin\\grok";
const SESSIONS = join(homedir(), ".grok", "sessions");
/** Somewhere for the agent to make a mess that is not the repository. */
const SCRATCH = join(tmpdir(), "scrapstorm-gen-ui");

const FORCE = process.argv.includes("--force");
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx > -1 ? process.argv[onlyIdx + 1] : null;

/** Appended to every prompt. Consistency across the set beats any one image. */
const STYLE =
  "Game user-interface art for a post-apocalyptic desert combat racing game. " +
  "Weathered industrial materials: rusted steel, scratched gunmetal, sun-bleached " +
  "paint, oil stains, welded seams. Palette strictly amber and burnt orange " +
  "against near-black charcoal, with bare steel highlights. " +
  "FLAT even lighting, no cast shadows, no dramatic light source, no vignette. " +
  "Clean edges, no perspective, viewed straight on.";

/*
 * The no-text rule, and its three exceptions.
 *
 * Generated lettering is normally a defect: misspelled, unlocalisable, and
 * permanently the wrong size for whatever box it lands in. So every asset
 * forbids it — except the wordmark and the three stamps, which ARE lettering.
 * Blanket-appending the ban to those produced a stamp with no word on it, which
 * is a smudge.
 */
const NO_TEXT =
  " ABSOLUTELY NO TEXT, no letters, no numbers, no logos, no watermarks.";
const TEXT_OK = new Set([
  "wordmark",
  "stamp-beaten",
  "stamp-cleared",
  "stamp-lost",
]);

/**
 * The cutout instruction, swapped in for "Transparent background".
 *
 * The image model has no alpha channel, so a prompt asking for transparency
 * gets an opaque guess at one — usually near-black, which reads as a black box
 * the moment a stamp is overprinted on a card. Asking for a flat key colour and
 * removing it afterwards is the only route to a real cutout.
 *
 * Magenta, specifically: the house palette is amber, burnt orange, gunmetal and
 * charcoal, so nothing in the artwork is anywhere near the key. Green would
 * collide with the verdigris stamp.
 */
const CHROMA =
  " The subject sits alone on a completely flat, uniform, pure magenta " +
  "(#FF00FF) background that fills every pixel the subject does not. No " +
  "gradient, no texture and no shadow in the background — it must be one " +
  "single solid colour so it can be keyed out.";

/**
 * Discipline for the agent on the other end. Without it the run costs minutes
 * per image in self-directed post-processing and writes stray files.
 */
const ONE_SHOT =
  " Make exactly ONE image-generation call and then stop. Do not write, edit " +
  "or convert any files, do not run any shell commands, and do not attempt any " +
  "post-processing or follow-up generations.";

const SPECS = [
  /* ── surfaces ─────────────────────────────────────────────────── */
  {
    cat: "surface",
    slug: "plate",
    prompt:
      "A large flat sheet of scuffed dark steel, edge-lit from the top left, " +
      "with fine scratches and faint rust bloom. Extremely low contrast and " +
      "almost uniform — this sits BEHIND body text at half brightness and must " +
      "never compete with it. No focal point anywhere.",
  },
  {
    cat: "surface",
    slug: "plate-lit",
    prompt:
      "The same scuffed dark steel sheet, but with a warm sodium-orange wash " +
      "spilling along the top edge and fading out by a third of the way down. " +
      "Still low contrast through the middle and bottom, where text will sit.",
  },
  {
    cat: "surface",
    slug: "grain",
    prompt:
      "A seamless tileable overlay of fine dust, grit and faint diagonal " +
      "scratches, monochrome, MOSTLY TRANSPARENT — intended to be laid over " +
      "other art at low opacity. Seamless on all four edges, no focal point.",
  },
  {
    cat: "surface",
    slug: "board-wall",
    prompt:
      "A wall of corrugated steel sheeting behind chain-link fence, in flat " +
      "overcast ash light. Deliberately DARK and LOW CONTRAST — it sits at 35% " +
      "opacity behind dossier cards. Wide, evenly lit, no bright spots.",
  },
  /* ── marks ────────────────────────────────────────────────────── */
  {
    cat: "mark",
    slug: "wordmark",
    prompt:
      "The single word SCRAPSTORM sprayed through a stencil onto bare metal in " +
      "heavy condensed capitals, worn amber paint with overspray and chipping. " +
      "Transparent background. This is the ONE asset that may contain text, and " +
      "it must read exactly SCRAPSTORM with no other lettering.",
  },
  {
    cat: "mark",
    slug: "insignia-league",
    prompt:
      "A square league insignia: fifteen short tally strokes cut into a bold " +
      "downward chevron, stamped into bare steel with amber paint worn into the " +
      "recesses. Simple enough to read at 32 pixels. Transparent background.",
  },
  {
    cat: "mark",
    slug: "class-interceptor",
    prompt:
      "A stencilled vehicle badge: a low sharp forward-swept wedge silhouette " +
      "with two trailing speed lines, worn amber spray on steel. Reads at 30 " +
      "pixels tall. Transparent background.",
  },
  {
    cat: "mark",
    slug: "class-bruiser",
    prompt:
      "A stencilled vehicle badge: a tall blunt slab silhouette with a spiked " +
      "ram plate along the front, worn amber spray on steel. Reads at 30 pixels " +
      "tall. Transparent background.",
  },
  {
    cat: "mark",
    slug: "class-trickster",
    prompt:
      "A stencilled vehicle badge: a mid-height hatchback silhouette doubled " +
      "and offset to suggest a feint, worn amber spray on steel. Reads at 30 " +
      "pixels tall. Transparent background.",
  },
  /* ── stamps ───────────────────────────────────────────────────── */
  {
    cat: "stamp",
    slug: "stamp-beaten",
    prompt:
      "The word BEATEN as a rubber-stamp overprint in weathered verdigris " +
      "green ink, heavy ink bleed and broken edges, printed straight and level. " +
      "Transparent background. The interface applies its own tilt.",
  },
  {
    cat: "stamp",
    slug: "stamp-cleared",
    prompt:
      "The word CLEARED as a rubber-stamp overprint in worn amber ink, heavy " +
      "ink bleed and broken edges, printed straight and level. Transparent " +
      "background.",
  },
  {
    cat: "stamp",
    slug: "stamp-lost",
    prompt:
      "The word LOST as a rubber-stamp overprint in dark ember red ink, heavy " +
      "ink bleed and broken edges, printed straight and level. Transparent " +
      "background.",
  },
  {
    cat: "circuit",
    slug: "circuit-ash_spire",
    prompt:
      "A circuit map mark: a wide stadium oval with a jump bank, drawn as a single torched outline burned " +
      "into a small steel plate, amber heat discolouration along the cut. Bold " +
      "and simple enough to read at 22 pixels. No text, no numbers. " +
      "Transparent background.",
  },
  {
    cat: "circuit",
    slug: "circuit-cinder_bowl",
    prompt:
      "A circuit map mark: a tight kidney-shaped loop, drawn as a single torched outline burned " +
      "into a small steel plate, amber heat discolouration along the cut. Bold " +
      "and simple enough to read at 22 pixels. No text, no numbers. " +
      "Transparent background.",
  },
  {
    cat: "circuit",
    slug: "circuit-foundry_pit",
    prompt:
      "A circuit map mark: a short figure-of-eight of two bowls joined by narrow chokes, drawn as a single torched outline burned " +
      "into a small steel plate, amber heat discolouration along the cut. Bold " +
      "and simple enough to read at 22 pixels. No text, no numbers. " +
      "Transparent background.",
  },
  {
    cat: "circuit",
    slug: "circuit-rustline",
    prompt:
      "A circuit map mark: a narrow twisting loop with a hard chicane, drawn as a single torched outline burned " +
      "into a small steel plate, amber heat discolouration along the cut. Bold " +
      "and simple enough to read at 22 pixels. No text, no numbers. " +
      "Transparent background.",
  },
  {
    cat: "circuit",
    slug: "circuit-sable_run",
    prompt:
      "A circuit map mark: a long wide oval of sweeping curves, drawn as a single torched outline burned " +
      "into a small steel plate, amber heat discolouration along the cut. Bold " +
      "and simple enough to read at 22 pixels. No text, no numbers. " +
      "Transparent background.",
  },
  {
    cat: "circuit",
    slug: "circuit-dead_mile",
    prompt:
      "A circuit map mark: a long thin out-and-back loop with a far turn, drawn as a single torched outline burned " +
      "into a small steel plate, amber heat discolouration along the cut. Bold " +
      "and simple enough to read at 22 pixels. No text, no numbers. " +
      "Transparent background.",
  },
  {
    cat: "rival",
    slug: "rival-wask",
    prompt:
      "A portrait mugshot, 4:5 vertical, framed TIGHT on the face and " +
      "shoulders: a wiry nervous young driver, thin face, buzzed hair. A driver in a post-apocalyptic desert racing league — " +
      "dust on the skin, harsh single-source light from one side, deep shadow " +
      "on the other, plain dark background. Looking straight at the camera, " +
      "unsmiling. High contrast, photoreal. It will be displayed at 44 pixels " +
      "tall, so the face must fill the frame. No text.",
  },
  {
    cat: "rival",
    slug: "rival-nim",
    prompt:
      "A portrait mugshot, 4:5 vertical, framed TIGHT on the face and " +
      "shoulders: a compact wary woman with a scarred cheek and cropped dark hair. A driver in a post-apocalyptic desert racing league — " +
      "dust on the skin, harsh single-source light from one side, deep shadow " +
      "on the other, plain dark background. Looking straight at the camera, " +
      "unsmiling. High contrast, photoreal. It will be displayed at 44 pixels " +
      "tall, so the face must fill the frame. No text.",
  },
  {
    cat: "rival",
    slug: "rival-vance",
    prompt:
      "A portrait mugshot, 4:5 vertical, framed TIGHT on the face and " +
      "shoulders: a heavyset older man with a grey beard and a broken nose. A driver in a post-apocalyptic desert racing league — " +
      "dust on the skin, harsh single-source light from one side, deep shadow " +
      "on the other, plain dark background. Looking straight at the camera, " +
      "unsmiling. High contrast, photoreal. It will be displayed at 44 pixels " +
      "tall, so the face must fill the frame. No text.",
  },
  {
    cat: "rival",
    slug: "rival-sook",
    prompt:
      "A portrait mugshot, 4:5 vertical, framed TIGHT on the face and " +
      "shoulders: a lean sharp-eyed woman with tied-back hair and grease on her jaw. A driver in a post-apocalyptic desert racing league — " +
      "dust on the skin, harsh single-source light from one side, deep shadow " +
      "on the other, plain dark background. Looking straight at the camera, " +
      "unsmiling. High contrast, photoreal. It will be displayed at 44 pixels " +
      "tall, so the face must fill the frame. No text.",
  },
  {
    cat: "rival",
    slug: "rival-ait",
    prompt:
      "A portrait mugshot, 4:5 vertical, framed TIGHT on the face and " +
      "shoulders: a young man with a shaved head and a burn scar across one temple. A driver in a post-apocalyptic desert racing league — " +
      "dust on the skin, harsh single-source light from one side, deep shadow " +
      "on the other, plain dark background. Looking straight at the camera, " +
      "unsmiling. High contrast, photoreal. It will be displayed at 44 pixels " +
      "tall, so the face must fill the frame. No text.",
  },
  {
    cat: "rival",
    slug: "rival-marsh",
    prompt:
      "A portrait mugshot, 4:5 vertical, framed TIGHT on the face and " +
      "shoulders: a weathered older woman with deep lines and a hard flat stare. A driver in a post-apocalyptic desert racing league — " +
      "dust on the skin, harsh single-source light from one side, deep shadow " +
      "on the other, plain dark background. Looking straight at the camera, " +
      "unsmiling. High contrast, photoreal. It will be displayed at 44 pixels " +
      "tall, so the face must fill the frame. No text.",
  },
  {
    cat: "rival",
    slug: "rival-novo",
    prompt:
      "A portrait mugshot, 4:5 vertical, framed TIGHT on the face and " +
      "shoulders: a tall gaunt man with sunken eyes and long tied-back hair. A driver in a post-apocalyptic desert racing league — " +
      "dust on the skin, harsh single-source light from one side, deep shadow " +
      "on the other, plain dark background. Looking straight at the camera, " +
      "unsmiling. High contrast, photoreal. It will be displayed at 44 pixels " +
      "tall, so the face must fill the frame. No text.",
  },
  {
    cat: "rival",
    slug: "rival-reyes",
    prompt:
      "A portrait mugshot, 4:5 vertical, framed TIGHT on the face and " +
      "shoulders: a stocky confident woman with a wide jaw and a gold tooth. A driver in a post-apocalyptic desert racing league — " +
      "dust on the skin, harsh single-source light from one side, deep shadow " +
      "on the other, plain dark background. Looking straight at the camera, " +
      "unsmiling. High contrast, photoreal. It will be displayed at 44 pixels " +
      "tall, so the face must fill the frame. No text.",
  },
  {
    cat: "rival",
    slug: "rival-ogun",
    prompt:
      "A portrait mugshot, 4:5 vertical, framed TIGHT on the face and " +
      "shoulders: a broad calm man with tribal scarring on both cheeks. A driver in a post-apocalyptic desert racing league — " +
      "dust on the skin, harsh single-source light from one side, deep shadow " +
      "on the other, plain dark background. Looking straight at the camera, " +
      "unsmiling. High contrast, photoreal. It will be displayed at 44 pixels " +
      "tall, so the face must fill the frame. No text.",
  },
  {
    cat: "rival",
    slug: "rival-vey",
    prompt:
      "A portrait mugshot, 4:5 vertical, framed TIGHT on the face and " +
      "shoulders: an elegant cold woman with sharp cheekbones and a clean face. A driver in a post-apocalyptic desert racing league — " +
      "dust on the skin, harsh single-source light from one side, deep shadow " +
      "on the other, plain dark background. Looking straight at the camera, " +
      "unsmiling. High contrast, photoreal. It will be displayed at 44 pixels " +
      "tall, so the face must fill the frame. No text.",
  },
  {
    cat: "rival",
    slug: "rival-ptok",
    prompt:
      "A portrait mugshot, 4:5 vertical, framed TIGHT on the face and " +
      "shoulders: a squat brutal man with a flattened nose and cauliflower ears. A driver in a post-apocalyptic desert racing league — " +
      "dust on the skin, harsh single-source light from one side, deep shadow " +
      "on the other, plain dark background. Looking straight at the camera, " +
      "unsmiling. High contrast, photoreal. It will be displayed at 44 pixels " +
      "tall, so the face must fill the frame. No text.",
  },
  {
    cat: "rival",
    slug: "rival-ilo",
    prompt:
      "A portrait mugshot, 4:5 vertical, framed TIGHT on the face and " +
      "shoulders: a huge silent man with a heavy brow and a shaved skull. A driver in a post-apocalyptic desert racing league — " +
      "dust on the skin, harsh single-source light from one side, deep shadow " +
      "on the other, plain dark background. Looking straight at the camera, " +
      "unsmiling. High contrast, photoreal. It will be displayed at 44 pixels " +
      "tall, so the face must fill the frame. No text.",
  },
  {
    cat: "rival",
    slug: "rival-kade",
    prompt:
      "A portrait mugshot, 4:5 vertical, framed TIGHT on the face and " +
      "shoulders: a nervous handsome man who will not meet the camera. A driver in a post-apocalyptic desert racing league — " +
      "dust on the skin, harsh single-source light from one side, deep shadow " +
      "on the other, plain dark background. Looking straight at the camera, " +
      "unsmiling. High contrast, photoreal. It will be displayed at 44 pixels " +
      "tall, so the face must fill the frame. No text.",
  },
  {
    cat: "rival",
    slug: "rival-rhee",
    prompt:
      "A portrait mugshot, 4:5 vertical, framed TIGHT on the face and " +
      "shoulders: a severe older woman with iron-grey hair pulled tight. A driver in a post-apocalyptic desert racing league — " +
      "dust on the skin, harsh single-source light from one side, deep shadow " +
      "on the other, plain dark background. Looking straight at the camera, " +
      "unsmiling. High contrast, photoreal. It will be displayed at 44 pixels " +
      "tall, so the face must fill the frame. No text.",
  },
  {
    cat: "rival",
    slug: "rival-marrow",
    prompt:
      "A portrait mugshot, 4:5 vertical, framed TIGHT on the face and " +
      "shoulders: a scarred arrogant champion, goggles pushed up on his forehead, half-smiling. A driver in a post-apocalyptic desert racing league — " +
      "dust on the skin, harsh single-source light from one side, deep shadow " +
      "on the other, plain dark background. Looking straight at the camera, " +
      "unsmiling. High contrast, photoreal. It will be displayed at 44 pixels " +
      "tall, so the face must fill the frame. No text.",
  },
];

/*
 * The wide circuit backdrops.
 *
 * These were missing: CareerMenus renders <ArtBackdrop name={`circuit-wide-
 * ${def.trackId}`} /> for all six tracks and SPECS only ever described the
 * small torched plates. Six near-identical entries generated from one template
 * rather than typed out, because the only thing that varies is the landscape.
 */
const CIRCUIT_SCENES = {
  ash_spire: "a wide flat pan of cracked ash under a rock spire",
  cinder_bowl: "a shallow burnt crater ringed with slag heaps",
  foundry_pit: "a dead industrial foundry yard of rusted gantries and pipework",
  rustline: "a corridor of wrecked railway stock and toppled pylons",
  sable_run: "an open black-sand plain running to a far dune horizon",
  dead_mile: "a dead-straight salt flat with a distant burnt-out settlement",
};
for (const [id, scene] of Object.entries(CIRCUIT_SCENES)) {
  SPECS.push({
    cat: "circuit",
    slug: `circuit-wide-${id}`,
    prompt:
      `A wide establishing landscape of ${scene}, seen from a high vantage, ` +
      "with a dirt racing circuit worn through it and scrap-built barriers " +
      "along its edges. This is a BACKDROP shown at 30% opacity behind a " +
      "column of text: keep it dark, hazy and low contrast, with no bright " +
      "sky, no sun, no lens flare and no strong focal point. Wide 16:9.",
  });
}

const todo = SPECS.filter((s) => !ONLY || s.cat === ONLY);

/* ── retrieval ──────────────────────────────────────────────────────────── */

/**
 * The images directory for a session id.
 *
 * ~/.grok/sessions is keyed by percent-encoded working directory, and the
 * encoding is the CLI's business, not ours — so scan one level for the child
 * named after our (unique) session id rather than trying to reproduce it.
 */
function sessionImages(sid) {
  let entries;
  try {
    entries = readdirSync(SESSIONS);
  } catch {
    return null;
  }
  for (const e of entries) {
    const dir = join(SESSIONS, e, sid, "images");
    if (existsSync(dir)) return dir;
  }
  return null;
}

/** The newest image in a directory. The CLI numbers them 1.jpg, 2.jpg, … */
function newestImage(dir) {
  const files = readdirSync(dir)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] ?? null;
}

/**
 * Where the image for this run landed, or null.
 *
 * stdout first only because it costs nothing when the model happens to print a
 * usable absolute path; the session directory is the load-bearing route.
 */
function locate(stdout, sid) {
  const m = stdout.match(/([A-Za-z]:\\[^\s`"'()\[\]]+\.(?:png|jpe?g|webp))/);
  if (m && existsSync(m[1])) return m[1];
  const dir = sessionImages(sid);
  return dir ? newestImage(dir) : null;
}

/* ── conversion ─────────────────────────────────────────────────────────── */

function has(cmd) {
  try {
    execFileSync(cmd, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const FFMPEG = has("ffmpeg");

/** The top-left pixel, as ffmpeg hex. The model's idea of #FF00FF drifts. */
function cornerHex(src) {
  const raw = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", src, "-vf", "crop=8:8:0:0,scale=1:1", "-frames:v", "1",
     "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { maxBuffer: 1 << 16 },
  );
  return raw.subarray(0, 3).toString("hex");
}

/**
 * JPEG in, PNG out — with the key colour removed when the asset needs a cutout.
 *
 * 0.30 similarity is deliberately timid. At 0.40 the key began taking bites out
 * of gunmetal, and a badge with holes in it is worse than a badge on a square.
 */
function toPng(src, dest, keyed) {
  const args = ["-y", "-loglevel", "error", "-i", src];
  if (keyed) args.push("-vf", `format=rgba,colorkey=0x${cornerHex(src)}:0.30:0.05`);
  args.push("-frames:v", "1", dest);
  execFileSync("ffmpeg", args, { stdio: "ignore" });
}

/* ── run ────────────────────────────────────────────────────────────────── */

if (!FFMPEG) {
  console.error(
    "ffmpeg is not on PATH.\n" +
      "The Grok image tool only emits JPEG and the interface loads PNG, so a\n" +
      "conversion step is not optional. Install ffmpeg (winget install\n" +
      "Gyan.FFmpeg) and re-run. Nothing has been generated.",
  );
  process.exit(1);
}

mkdirSync(SCRATCH, { recursive: true });
mkdirSync(OUT, { recursive: true });
console.log(`Generating ${todo.length} UI asset(s)…\n`);

const results = [];
let ok = 0;
let n = 0;

for (const spec of todo) {
  n++;
  const tag = `[${String(n).padStart(2)}/${todo.length}] ${spec.slug}`;
  // UiArt.tsx resolves `/assets/ui/<name>.png` FLAT — there is no category
  // segment in the URL. The per-category copy is kept as a filing convenience.
  const dest = join(OUT, `${spec.slug}.png`);
  const filed = join(OUT, spec.cat, `${spec.slug}.png`);
  mkdirSync(join(OUT, spec.cat), { recursive: true });

  if (existsSync(dest) && !FORCE) {
    console.log(`${tag} … skip`);
    results.push({ ...spec, file: `ui/${spec.slug}.png` });
    continue;
  }

  // A prompt that says "Transparent background" gets the chroma instruction
  // instead; that phrase is also how a spec declares it needs a cutout.
  const keyed = /transparent background/i.test(spec.prompt);
  const body = spec.prompt.replace(/\s*Transparent background\.\s*/gi, " ").trim();
  const full =
    `Generate an image. ${body}\n\n${STYLE}` +
    (TEXT_OK.has(spec.slug) ? "" : NO_TEXT) +
    (keyed ? CHROMA : "") +
    ONE_SHOT;

  const sid = randomUUID();
  process.stdout.write(`${tag} … `);
  const started = Date.now();
  try {
    const out = execFileSync(
      GROK,
      ["--cwd", SCRATCH, "--session-id", sid, "-p", full],
      { cwd: SCRATCH, encoding: "utf8", timeout: 300000, maxBuffer: 1 << 26 },
    );
    const src = locate(out, sid);
    if (!src) {
      console.log("FAILED (no image produced)");
      results.push({ ...spec, error: "no image produced" });
      continue;
    }
    toPng(src, dest, keyed);
    copyFileSync(dest, filed);
    ok++;
    console.log(`ok (${((Date.now() - started) / 1000).toFixed(0)}s${keyed ? ", keyed" : ""})`);
    results.push({ ...spec, file: `ui/${spec.slug}.png`, keyed });
  } catch (err) {
    console.log(`FAILED: ${String(err.message).slice(0, 120)}`);
    results.push({ ...spec, error: String(err.message).slice(0, 200) });
  }
}

// Leave nothing behind in the temp dir; the session images stay where the CLI
// put them, which is the one place a failed run can still be recovered from.
try {
  rmSync(SCRATCH, { recursive: true, force: true });
} catch {
  /* not important enough to fail the run over */
}

writeFileSync(join(OUT, "manifest.json"), JSON.stringify(results, null, 2));
console.log(`\n${ok}/${todo.length} written to public/assets/ui/.`);
if (ok < todo.length) console.log("Re-run to retry the misses; existing files are skipped.");
