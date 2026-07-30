/**
 * MP3 sample bank (ElevenLabs-generated originals under /assets/audio).
 * Falls back silently if a sample is missing — procedural engine still runs.
 */
const SFX_BASE = "/assets/audio/sfx";
const MUSIC_BASE = "/assets/audio/music";

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

const buffers = new Map<string, AudioBuffer>();
let loading: Promise<void> | null = null;

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
