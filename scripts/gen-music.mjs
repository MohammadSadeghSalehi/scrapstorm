#!/usr/bin/env node
/**
 * Generate the original music beds with ElevenLabs Music into
 * public/assets/audio/music/.
 *
 *   node scripts/gen-music.mjs                 # only missing tracks
 *   node scripts/gen-music.mjs --force         # re-render everything
 *   node scripts/gen-music.mjs --list          # print prompts, render nothing
 *   node scripts/gen-music.mjs --only defeat   # one track
 *
 * Reads ELEVENLABS_API_KEY from .env (gitignored). Output is gitignored with the
 * rest of public/assets, so this is re-runnable on a fresh checkout — the script
 * plus the prompts below are the committed artefact, not the mp3s.
 *
 * ---------------------------------------------------------------------------
 * ON THE PROMPTS
 *
 * The brief for this soundtrack is late-1970s / early-1980s stadium rock: driving
 * 4/4, overdriven guitars, stacked wordless gang-vocal hooks, live drums, big
 * major-key choruses.
 *
 * Every prompt below therefore describes the SOUND — instrumentation, tempo,
 * key, arrangement, production era, mix character — and never an artist, a band,
 * a song or a lyric. That is not only the licensing-safe way to do it, it is the
 * way that actually works: a generator asked for a named act returns an
 * imitation of its most famous recording, which is both infringing and a worse
 * match for a game that needs a *bed*, not a single. What makes a race track
 * work is tempo, register and the absence of anything that pulls focus, and
 * those are exactly the things you can only get by asking for them directly.
 *
 * Practical constraints baked into every prompt:
 *   - "instrumental, no lead vocal, no lyrics" — a lead vocal competes with the
 *     announcer, and the announcer wins.
 *   - "seamless loop, no fade in, no fade out" — these are looped by
 *     AudioEngine.playMusic, and a fade is audible at the seam every lap.
 *   - a stated BPM — the mixer crossfades between unaligned tracks, and keeping
 *     the race beds within a few BPM of each other makes those seams survivable.
 *   - a stated register for the guitars — the engine synth occupies 60–400 Hz
 *     and the tyre bed 400 Hz–3 kHz; music that sits in the same place turns the
 *     whole mix to mud however it is balanced.
 * ---------------------------------------------------------------------------
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "public/assets/audio/music";
const FORCE = process.argv.includes("--force");
const LIST_ONLY = process.argv.includes("--list");
const onlyIdx = process.argv.indexOf("--only");
const ONLY =
  onlyIdx >= 0 && process.argv[onlyIdx + 1]
    ? new Set(process.argv[onlyIdx + 1].split(","))
    : null;

const ENDPOINT = "https://api.elevenlabs.io/v1/music";

/** id -> { ms, prompt }. ids match the MusicId union in SampleBank.ts. */
const TRACKS = {
  menu_anthem: {
    ms: 45000,
    prompt:
      "Original instrumental stadium rock anthem, 4/4 at 126 BPM in A major. " +
      "Two overdriven electric guitars playing wide open power chords with a " +
      "ringing suspended-fourth voicing, a punchy picked electric bass on " +
      "eighth notes, a live drum kit with a big room snare and crashing ride " +
      "cymbals. Stacked wordless gang-vocal 'whoa' chants as the hook — no " +
      "lyrics, no lead vocal. Late-1970s analogue tape production: warm tape " +
      "saturation, plate reverb on the snare, no modern brickwall loudness. " +
      "Confident and anthemic rather than aggressive. Seamless loop, no fade " +
      "in, no fade out.",
  },
  garage_vibe: {
    ms: 45000,
    prompt:
      "Original instrumental blues-rock groove, 4/4 at 92 BPM in E minor, " +
      "relaxed and swaggering. Single dirty electric guitar playing a loose " +
      "muted riff with occasional slide, warm fingered bass, dry live drums " +
      "with brushes on the hi-hat, faint Hammond organ pad underneath. " +
      "No vocals, no lyrics. Small-room 1970s production, close-miked and " +
      "dry, minimal reverb. Feels like a workshop at night. Seamless loop, " +
      "no fade in, no fade out.",
  },
  race_heat: {
    ms: 60000,
    prompt:
      "Original instrumental hard rock driving bed, 4/4 at 142 BPM in D major. " +
      "Twin overdriven electric guitars trading a chugging palm-muted riff " +
      "kept in the upper midrange around 800 Hz to 3 kHz, relentless " +
      "eighth-note electric bass, live drum kit with a driving open hi-hat " +
      "and a hard backbeat snare. No lead vocal, no lyrics, no solos. Steady " +
      "and propulsive with no big dynamic drops — this plays under gameplay " +
      "and must not pull focus. Late-1970s stadium rock production, natural " +
      "room ambience on the drums. Seamless loop, no fade in, no fade out.",
  },
  race_intensity: {
    ms: 60000,
    prompt:
      "Original instrumental high-energy arena rock, 4/4 at 148 BPM in D major, " +
      "the same key and feel as a 142 BPM hard rock bed but lifted. Layered " +
      "overdriven guitars with a soaring sustained upper-register lead line, " +
      "galloping bass, live drums with double-time hi-hat and frequent crash " +
      "accents, stacked wordless gang-vocal 'hey' shouts on the downbeats. " +
      "No lyrics, no lead vocal. Triumphant major-key lift. Big late-1970s " +
      "stadium production with plate reverb and analogue tape warmth. " +
      "Seamless loop, no fade in, no fade out.",
  },
  final_lap: {
    ms: 60000,
    prompt:
      "Original instrumental arena rock at maximum urgency, 4/4 at 152 BPM in " +
      "D major. Distorted twin guitars playing fast alternate-picked octaves " +
      "over a driving bass, live drums hammering a four-on-the-floor kick with " +
      "a ride cymbal bell pattern, tom fills every eight bars, stacked wordless " +
      "gang-vocal chants. No lyrics, no lead vocal. Relentless, climactic, no " +
      "breakdown and no quiet section. Late-1970s stadium rock production, " +
      "loud and wide. Seamless loop, no fade in, no fade out.",
  },
  victory: {
    ms: 20000,
    prompt:
      "Original instrumental stadium rock victory fanfare, 4/4 at 130 BPM in " +
      "A major, twenty seconds, played once. Opens on a huge sustained major " +
      "power chord with cymbal swell, then a triumphant descending guitar riff " +
      "answered by stacked wordless gang-vocal 'whoa' chants, live drums with " +
      "big tom fills, ending on a held major chord with a natural cymbal decay. " +
      "No lyrics, no lead vocal. Celebratory and unmistakably a win. " +
      "Late-1970s analogue production. Definite ending, no loop.",
  },
  defeat: {
    ms: 20000,
    prompt:
      "Original instrumental rock outro, 4/4 at 88 BPM in A minor, twenty " +
      "seconds, played once. A slow heavy guitar figure with wide bends over a " +
      "sparse bass and a dragging half-time drum beat, dying away into a single " +
      "sustained minor chord with feedback and long plate reverb. No lyrics, no " +
      "lead vocal. Deflated but dignified — a heat survived, not a tragedy. " +
      "Late-1970s analogue production, dry and close. Definite ending, no loop.",
  },
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
  for (const [id, t] of Object.entries(TRACKS)) {
    console.log(`\n## ${id} (${t.ms / 1000}s)\n${t.prompt}`);
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

for (const [id, track] of Object.entries(TRACKS)) {
  if (ONLY && !ONLY.has(id)) continue;
  const dest = join(OUT, `${id}.mp3`);
  if (!FORCE && existsSync(dest)) {
    skipped++;
    continue;
  }
  process.stdout.write(`${id} (${track.ms / 1000}s) ... `);
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: track.prompt,
        music_length_ms: track.ms,
      }),
    });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 200);
      console.log(`FAILED (HTTP ${r.status}) ${body}`);
      if (r.status === 401 || r.status === 403) {
        console.log(
          "  → the key lacks music generation permission; the existing beds " +
            "on disk stay in place and nothing is overwritten.",
        );
      }
      failed++;
      continue;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    writeFileSync(dest, buf);
    made++;
    console.log(`ok (${(buf.length / 1024).toFixed(0)}KB)`);
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
    failed++;
  }
}

writeFileSync(
  join(OUT, "manifest.json"),
  JSON.stringify(
    {
      endpoint: ENDPOINT,
      tracks: Object.fromEntries(
        Object.entries(TRACKS).map(([id, t]) => [
          id,
          { seconds: t.ms / 1000, prompt: t.prompt },
        ]),
      ),
    },
    null,
    2,
  ),
);

console.log(`\n${made} rendered, ${skipped} already present, ${failed} failed`);
if (failed) process.exitCode = 1;
