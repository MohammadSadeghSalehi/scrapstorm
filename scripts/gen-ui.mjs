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
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public/assets/ui");
const GROK = "C:\\Users\\sadeg\\.grok\\bin\\grok";

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

const todo = SPECS.filter((s) => !ONLY || s.cat === ONLY);
console.log(`Generating ${todo.length} UI asset(s)…\n`);

const results = [];
let ok = 0;

for (const spec of todo) {
  const dir = join(OUT, spec.cat);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${spec.slug}.png`);
  if (existsSync(dest) && !FORCE) {
    console.log(`· ${spec.cat}/${spec.slug} … skip`);
    results.push({ ...spec, file: `ui/${spec.cat}/${spec.slug}.png` });
    continue;
  }

  const full =
    `Generate an image. ${spec.prompt}\n\n${STYLE}\n\n` +
    `Save it as a PNG with a transparent background where described.`;

  process.stdout.write(`· ${spec.cat}/${spec.slug} … `);
  try {
    const out = execFileSync(GROK, ["-p", full], {
      encoding: "utf8",
      timeout: 300000,
      maxBuffer: 1 << 26,
    });
    // The CLI writes the image somewhere and names it in its output; find it.
    const m = out.match(/([A-Za-z]:\\[^\s"']+\.(?:png|jpg|jpeg))/);
    if (m && existsSync(m[1])) {
      copyFileSync(m[1], dest);
      ok++;
      console.log("ok");
      results.push({ ...spec, file: `ui/${spec.cat}/${spec.slug}.png` });
    } else {
      console.log("no image path in output");
      results.push({ ...spec, error: true });
    }
  } catch (err) {
    console.log(`FAILED: ${String(err.message).slice(0, 120)}`);
    results.push({ ...spec, error: true });
  }
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(results, null, 2));
console.log(`\n${ok}/${todo.length} written to public/assets/ui/.`);
