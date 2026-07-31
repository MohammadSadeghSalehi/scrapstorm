#!/usr/bin/env node
/**
 * Generate announcer VO with ElevenLabs into public/assets/audio/vo/.
 *
 *   node scripts/gen-vo.mjs            # only missing lines
 *   node scripts/gen-vo.mjs --force    # re-render everything
 *   node scripts/gen-vo.mjs --list     # print the manifest, render nothing
 *
 * Reads ELEVENLABS_API_KEY from .env (gitignored). Output is gitignored with
 * the rest of public/assets, so this is re-runnable on a fresh checkout.
 *
 * Voice IDs are hardcoded public ones: the supplied key carries
 * text_to_speech permission but NOT voices_read, so /v1/voices 401s and the
 * catalogue cannot be listed at runtime.
 *
 * Skips lines that already exist so re-runs cost no quota — the key's
 * character allowance is finite and user_read is also denied, meaning we
 * cannot query remaining quota before spending it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "public/assets/audio/vo";
const FORCE = process.argv.includes("--force");
const LIST_ONLY = process.argv.includes("--list");

/** Crisp, authoritative — reads as a circuit announcer over a PA. */
const ANNOUNCER = "VR6AewLTigWG4xSOukaG"; // Arnold
const MODEL = "eleven_multilingual_v2";

/** id -> spoken line. ids match the EVENT_LINES / phase hooks in story.ts. */
const LINES = {
  "grid-locked": "Grid locked. Heat live.",
  "green": "Green. Push.",
  "lap-1": "Sector clean. Keep the rubber hot.",
  "lap-2": "Lap banked. Don't gift the pack a slipstream.",
  "final-lap": "Final lap. Everything you've got.",
  "hit-1": "Paint traded.",
  "hit-2": "They felt that.",
  "boost-1": "Turbo lit.",
  "boost-2": "Overdrive. Hold the wheel.",
  "overtake": "Position taken.",
  "win": "P1. The Spire chants your name.",
  "loss": "Survived the heat. Next time, higher.",
  "wreck": "Chassis complains. Keep going.",
};

function loadKey() {
  try {
    const env = readFileSync(".env", "utf8");
    const m = env.match(/^ELEVENLABS_API_KEY=(.+)$/m);
    return m?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

if (LIST_ONLY) {
  for (const [id, text] of Object.entries(LINES)) console.log(`${id}\t${text}`);
  process.exit(0);
}

const key = loadKey();
if (!key) {
  console.error("No ELEVENLABS_API_KEY in .env");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

let made = 0;
let skipped = 0;
let failed = 0;
let chars = 0;

for (const [id, text] of Object.entries(LINES)) {
  const dest = join(OUT, `${id}.mp3`);
  if (!FORCE && existsSync(dest)) {
    skipped++;
    continue;
  }
  process.stdout.write(`${id} ... `);
  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ANNOUNCER}`,
      {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: MODEL,
          // Slightly high stability + style for a consistent PA delivery
          // rather than the conversational default.
          voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.35 },
        }),
      },
    );
    if (!r.ok) {
      console.log(`FAILED (HTTP ${r.status}) ${(await r.text()).slice(0, 120)}`);
      failed++;
      continue;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    writeFileSync(dest, buf);
    chars += text.length;
    made++;
    console.log(`ok (${(buf.length / 1024).toFixed(0)}KB)`);
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
    failed++;
  }
}

// Manifest so the audio engine can load without hardcoding the list twice.
writeFileSync(
  join(OUT, "manifest.json"),
  JSON.stringify({ voice: ANNOUNCER, model: MODEL, lines: Object.keys(LINES) }, null, 2),
);

console.log(
  `\n${made} rendered, ${skipped} already present, ${failed} failed (~${chars} chars spent)`,
);
if (failed) process.exitCode = 1;
