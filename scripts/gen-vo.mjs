#!/usr/bin/env node
/**
 * Generate announcer + rival VO with ElevenLabs into public/assets/audio/vo/.
 *
 *   node scripts/gen-vo.mjs            # only missing lines
 *   node scripts/gen-vo.mjs --force    # re-render everything
 *   node scripts/gen-vo.mjs --list     # print the manifest, render nothing
 *   node scripts/gen-vo.mjs --only rival-taunt-1,lap-3
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
 *
 * All text below is original. Nothing here quotes, paraphrases or imitates any
 * existing work.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "public/assets/audio/vo";
const FORCE = process.argv.includes("--force");
const LIST_ONLY = process.argv.includes("--list");
const onlyIdx = process.argv.indexOf("--only");
const ONLY =
  onlyIdx >= 0 && process.argv[onlyIdx + 1]
    ? new Set(process.argv[onlyIdx + 1].split(","))
    : null;

/**
 * Two casts.
 *
 * `announcer` is the circuit PA — crisp, authoritative, and mixed dry (plus a
 * horn-array send inside the arena). `rival` is another driver on the radio and
 * is mixed through a band-limited transceiver stage in AudioEngine, so it wants
 * a rougher, closer read that survives being squeezed into 480 Hz – 2.9 kHz.
 */
const VOICES = {
  announcer: "VR6AewLTigWG4xSOukaG", // Arnold
  rival: "TxGEqnHWrfWFTfGW9XjX", // Josh
};

const MODEL = "eleven_multilingual_v2";

/**
 * Per-cast delivery. The announcer is deliberately more stable and more
 * stylised than the ElevenLabs conversational default; the rival is looser,
 * because a taunt read at PA consistency sounds like a second announcer.
 */
const SETTINGS = {
  announcer: { stability: 0.55, similarity_boost: 0.75, style: 0.35 },
  rival: { stability: 0.38, similarity_boost: 0.8, style: 0.55 },
};

/**
 * id -> { text, cast }. ids match the VoiceId union in
 * src/game/audio/SampleBank.ts and the hooks in AudioDriver.tsx.
 *
 * `lap-3` closes a real gap: the driver rotates through the lap pool rather
 * than picking by lap parity, and the old parity rule meant `lap-2` was
 * rendered, shipped and never once played in a three-lap heat.
 */
const LINES = {
  "grid-locked": { text: "Grid locked. Heat live.", cast: "announcer" },
  green: { text: "Green. Push.", cast: "announcer" },
  "lap-1": { text: "Sector clean. Keep the rubber hot.", cast: "announcer" },
  "lap-2": {
    text: "Lap banked. Don't gift the pack a slipstream.",
    cast: "announcer",
  },
  "lap-3": {
    text: "Another one down. The Spire's still watching.",
    cast: "announcer",
  },
  "final-lap": { text: "Final lap. Everything you've got.", cast: "announcer" },
  "hit-1": { text: "Paint traded.", cast: "announcer" },
  "hit-2": { text: "They felt that.", cast: "announcer" },
  "boost-1": { text: "Turbo lit.", cast: "announcer" },
  "boost-2": { text: "Overdrive. Hold the wheel.", cast: "announcer" },
  overtake: { text: "Position taken.", cast: "announcer" },
  overtaken: { text: "You've been shuffled back. Answer it.", cast: "announcer" },
  "close-pack": {
    text: "They're all over you. Hold your line.",
    cast: "announcer",
  },
  "near-miss": { text: "Nothing in it. Nothing at all.", cast: "announcer" },
  "wreck-rival": { text: "One down. Scrap for the crews.", cast: "announcer" },
  win: { text: "P1. The Spire chants your name.", cast: "announcer" },
  loss: { text: "Survived the heat. Next time, higher.", cast: "announcer" },
  wreck: { text: "Chassis complains. Keep going.", cast: "announcer" },
  "rival-taunt-1": {
    text: "You drive like the Spire owes you something.",
    cast: "rival",
  },
  "rival-taunt-2": {
    text: "Stay back there. It suits you.",
    cast: "rival",
  },
  "rival-taunt-3": {
    text: "That chassis isn't finishing this heat.",
    cast: "rival",
  },
  "rival-hit-1": { text: "Felt that one, did you?", cast: "rival" },
  "rival-hit-2": { text: "Plenty more where that came from.", cast: "rival" },
  "rival-wreck": { text: "Scrap. Told you.", cast: "rival" },
  "rival-pass": { text: "Out of my line.", cast: "rival" },
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
  for (const [id, l] of Object.entries(LINES)) {
    console.log(`${id}\t[${l.cast}]\t${l.text}`);
  }
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

for (const [id, line] of Object.entries(LINES)) {
  if (ONLY && !ONLY.has(id)) continue;
  const dest = join(OUT, `${id}.mp3`);
  if (!FORCE && existsSync(dest)) {
    skipped++;
    continue;
  }
  const voice = VOICES[line.cast];
  process.stdout.write(`${id} [${line.cast}] ... `);
  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}`,
      {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: line.text,
          model_id: MODEL,
          voice_settings: SETTINGS[line.cast],
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
    chars += line.text.length;
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
  JSON.stringify(
    {
      voices: VOICES,
      model: MODEL,
      lines: Object.fromEntries(
        Object.entries(LINES).map(([id, l]) => [id, l.cast]),
      ),
    },
    null,
    2,
  ),
);

console.log(
  `\n${made} rendered, ${skipped} already present, ${failed} failed (~${chars} chars spent)`,
);
if (failed) process.exitCode = 1;
