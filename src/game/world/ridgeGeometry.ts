/**
 * Mountain/mesa silhouettes for the skyline.
 *
 * The ridges used to be `coneGeometry(1, 1, 4|5)` — literal 4- and 5-sided
 * flat-shaded cones, which read as crude pyramids and were the most obviously
 * non-AAA thing on screen. A real ridge has an irregular silhouette, gullies
 * down its flanks and lighter, sun-bleached rock toward the peak.
 *
 * These are built once, cached, and shared: a handful of variants gives the
 * skyline variety without a unique geometry per mesa. Cost is trivial — a
 * 14x5 cone is ~140 triangles, so a 26-mesa skyline is under 4k triangles.
 */
import * as THREE from "three";

/** Deterministic hash noise in [0,1). Stable per (x, y, seed). */
function hash2(x: number, y: number, seed: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

const cache = new Map<string, THREE.BufferGeometry>();

/**
 * A displaced cone with baked strata colours.
 *
 * Displacement is strongest at the base and tapers toward the apex, so flanks
 * get gullies while the peak stays a peak instead of collapsing into noise.
 */
export function ridgeGeometry(
  seed: number,
  radial: number,
  heightSegs: number,
  baseHex: string,
  peakHex: string,
): THREE.BufferGeometry {
  const key = `${seed}|${radial}|${heightSegs}|${baseHex}|${peakHex}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const geo = new THREE.ConeGeometry(1, 1, radial, heightSegs);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const base = new THREE.Color(baseHex);
  const peak = new THREE.Color(peakHex);
  const tmp = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // ConeGeometry spans y in [-0.5, 0.5]; t = 0 at the base, 1 at the apex.
    const t = Math.min(1, Math.max(0, y + 0.5));
    const ang = Math.atan2(z, x);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);

    // Two bands: broad lobes that shape the overall footprint, plus finer
    // vertical gullies that vary with height.
    const lobe = hash2(ca * 2.7, sa * 2.7, seed);
    const gully = hash2(ca * 8.3 + t * 5, sa * 8.3, seed + 11);
    const disp = (lobe - 0.5) * 0.42 + (gully - 0.5) * 0.18;
    // Taper the displacement toward the apex so the summit stays coherent.
    const widen = 1 + disp * (1 - t * 0.6);
    pos.setX(i, x * widen);
    pos.setZ(i, z * widen);
    // Break the perfect point into a short ridge line.
    if (t > 0.85) pos.setY(i, y + (lobe - 0.5) * 0.14);

    // Sun-bleached toward the top, shadowed rock at the base, with a little
    // per-face variation so strata do not band uniformly.
    const mix = Math.min(1, Math.max(0, t * 0.85 + (gully - 0.5) * 0.22));
    tmp.copy(base).lerp(peak, mix);
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }

  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  cache.set(key, geo);
  return geo;
}

export function disposeRidgeGeometries(): void {
  for (const g of cache.values()) g.dispose();
  cache.clear();
}
