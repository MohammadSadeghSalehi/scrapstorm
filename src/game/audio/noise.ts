/**
 * Shared noise sources.
 *
 * Every layer that wants noise used to allocate and fill its own buffer, and
 * `noiseBurst` did it *per one-shot* — a wreck fired four bursts and therefore
 * built four fresh AudioBuffers on the frame the player could least afford it.
 * One cached buffer, read from a random offset, is indistinguishable and free.
 */

let cached: AudioBuffer | null = null;
let cachedRate = 0;

/** Pink-ish: white with a leaky integrator mixed back in. */
export function makeNoiseBuffer(
  ctx: BaseAudioContext,
  seconds: number,
): AudioBuffer {
  const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    d[i] = white * 0.55 + last * 0.45;
  }
  return buf;
}

/**
 * 3 s is long enough that a looping layer never reveals its period and that
 * random start offsets for one-shots do not obviously repeat.
 */
export function sharedNoise(ctx: BaseAudioContext): AudioBuffer {
  if (!cached || cachedRate !== ctx.sampleRate) {
    cached = makeNoiseBuffer(ctx, 3);
    cachedRate = ctx.sampleRate;
  }
  return cached;
}

/** Random read position that still leaves `need` seconds of buffer ahead. */
export function noiseOffset(buf: AudioBuffer, need: number) {
  const span = Math.max(0, buf.duration - need - 0.01);
  return Math.random() * span;
}
