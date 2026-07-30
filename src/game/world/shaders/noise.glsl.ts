/**
 * Shared GLSL for GPU surface detail + distance LoD bands.
 * Injected into MeshStandardMaterial via onBeforeCompile.
 *
 * LoD bands (uLod0 / uLod1 / uLod2 = near → far thresholds):
 *   band 3  dist < lod0     full: fBm + ridged + normal pert
 *   band 2  lod0..lod1      albedo + roughness, 2-oct fBm
 *   band 1  lod1..lod2      cheap 1-oct valueNoise albedo only
 *   band 0  dist >= lod2    skip all GPU noise (baked maps only)
 */

export const GPU_NOISE_GLSL = /* glsl */ `
float grok_hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float grok_valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = grok_hash21(i);
  float b = grok_hash21(i + vec2(1.0, 0.0));
  float c = grok_hash21(i + vec2(0.0, 1.0));
  float d = grok_hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Adaptive fBm: 1 / 2 / 3 octaves from octaves param
float grok_fbm(vec2 p, float octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  vec2 q = p;
  sum += amp * grok_valueNoise(q); norm += amp; amp *= 0.5; q *= 2.0;
  if (octaves > 1.5) {
    sum += amp * grok_valueNoise(q); norm += amp; amp *= 0.5; q *= 2.0;
  }
  if (octaves > 2.5) {
    sum += amp * grok_valueNoise(q); norm += amp;
  }
  return sum / max(norm, 1e-4);
}

float grok_ridged(vec2 p) {
  float n = grok_valueNoise(p);
  n = 1.0 - abs(n * 2.0 - 1.0);
  return n * n;
}

// Distance → continuous 0..1 fade (1 = near/full, 0 = far/off)
float grok_lodFade(float dist, float nearD, float farD) {
  return 1.0 - smoothstep(nearD, farD, dist);
}

// Discrete band 0..3 from distance + thresholds (lod0 < lod1 < lod2)
// 3=near full, 2=mid, 1=far cheap, 0=off
float grok_lodBand(float dist, float lod0, float lod1, float lod2) {
  if (dist < lod0) return 3.0;
  if (dist < lod1) return 2.0;
  if (dist < lod2) return 1.0;
  return 0.0;
}

// Soft band weight inside a band range (for crossfade at boundaries)
float grok_bandWeight(float dist, float start, float end) {
  return 1.0 - smoothstep(start, end, dist);
}
`;
