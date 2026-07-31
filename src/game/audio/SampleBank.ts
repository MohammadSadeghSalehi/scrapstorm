/**
 * MP3 sample bank (ElevenLabs-generated originals under /assets/audio).
 * Falls back silently if a sample is missing — procedural engine still runs.
 */
const SFX_BASE = "/assets/audio/sfx";
const MUSIC_BASE = "/assets/audio/music";
const VO_BASE = "/assets/audio/vo";

export type SfxId =
  | "engine_idle"
  | "engine_rev"
  | "boost"
  | "drift_squeal"
  | "impact_metal"
  | "impact_light"
  | "weapon_laser"
  | "weapon_cannon"
  | "shield"
  | "wreck"
  | "countdown"
  | "go"
  | "lap"
  | "finish"
  | "ui_click"
  | "ui_confirm"
  | "prop_smash"
  | "sand_scrub"
  | "whoosh"
  | "gear"
  | "nitro_ignition"
  | "turbo_release"
  | "slide_screech"
  | "camera_swoosh"
  | "crowd_cheer"
  | "metal_scrape";

export type MusicId =
  | "menu_anthem"
  | "garage_vibe"
  | "race_heat"
  | "race_intensity"
  | "final_lap"
  | "victory";

/** Announcer lines (ElevenLabs), mirrors public/assets/audio/vo/manifest.json */
export type VoiceId =
  | "grid-locked"
  | "green"
  | "lap-1"
  | "lap-2"
  | "final-lap"
  | "hit-1"
  | "hit-2"
  | "boost-1"
  | "boost-2"
  | "overtake"
  | "win"
  | "loss"
  | "wreck";

const buffers = new Map<string, AudioBuffer>();
let loading: Promise<void> | null = null;
const voiceLoads = new Map<VoiceId, Promise<AudioBuffer | null>>();

async function fetchDecode(
  ctx: AudioContext,
  url: string,
): Promise<AudioBuffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return await ctx.decodeAudioData(ab.slice(0));
  } catch {
    return null;
  }
}

export function preloadSamples(ctx: AudioContext): Promise<void> {
  if (loading) return loading;
  const sfx: SfxId[] = [
    "engine_idle",
    "engine_rev",
    "boost",
    "drift_squeal",
    "impact_metal",
    "impact_light",
    "weapon_laser",
    "weapon_cannon",
    "shield",
    "wreck",
    "countdown",
    "go",
    "lap",
    "finish",
    "ui_click",
    "ui_confirm",
    "prop_smash",
    "sand_scrub",
    "whoosh",
    "gear",
    "nitro_ignition",
    "turbo_release",
    "slide_screech",
    "camera_swoosh",
    "crowd_cheer",
    "metal_scrape",
  ];
  const music: MusicId[] = [
    "menu_anthem",
    "garage_vibe",
    "race_heat",
    "race_intensity",
    "final_lap",
    "victory",
  ];
  loading = Promise.all([
    ...sfx.map(async (id) => {
      const b = await fetchDecode(ctx, `${SFX_BASE}/${id}.mp3`);
      if (b) buffers.set(`sfx:${id}`, b);
    }),
    ...music.map(async (id) => {
      const b = await fetchDecode(ctx, `${MUSIC_BASE}/${id}.mp3`);
      if (b) buffers.set(`music:${id}`, b);
    }),
  ]).then(() => undefined);
  return loading;
}

/**
 * Announcer lines load on first use rather than in `preloadSamples` — the VO
 * bank is ~450 KB and most of it is never heard in a given heat.
 * The promise (including a failed one) is memoised so a missing/404 mp3 costs
 * exactly one fetch and then resolves null forever instead of re-requesting on
 * every hit, boost and lap.
 */
export function loadVoice(
  ctx: AudioContext,
  id: VoiceId,
): Promise<AudioBuffer | null> {
  const cached = voiceLoads.get(id);
  if (cached) return cached;
  const p = fetchDecode(ctx, `${VO_BASE}/${id}.mp3`).then((buf) => {
    if (buf) buffers.set(`vo:${id}`, buf);
    return buf;
  });
  voiceLoads.set(id, p);
  return p;
}

export function playSample(
  ctx: AudioContext,
  bus: AudioNode,
  key: string,
  opts?: { vol?: number; rate?: number; loop?: boolean },
): AudioBufferSourceNode | null {
  const buf = buffers.get(key);
  if (!buf) return null;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = !!opts?.loop;
  src.playbackRate.value = opts?.rate ?? 1;
  const g = ctx.createGain();
  g.gain.value = opts?.vol ?? 0.8;
  src.connect(g);
  g.connect(bus);
  src.start();
  return src;
}

export function hasSample(key: string) {
  return buffers.has(key);
}
