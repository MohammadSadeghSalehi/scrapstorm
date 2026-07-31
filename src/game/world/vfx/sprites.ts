/**
 * Canvas-authored sprite sheets for the VFX pools.
 *
 * Deliberately NOT one atlas with per-instance UV offsets. An atlas would fold
 * fire/spark/arc into a single additive draw call, but it needs an
 * `onBeforeCompile` patch injecting an instanced attribute into `vMapUv`, and a
 * shader patch that silently mismatches this three build renders *nothing* —
 * with no way to eyeball it on this machine (software GL has frozen it before).
 * Six extra draw calls is a price worth paying for an effect system that cannot
 * fail closed. See the draw-call budget note in particles.ts.
 *
 * Everything is built lazily on first use and cached forever: these are small
 * (64-128px), and building them at module load would run during SSR where
 * `document` does not exist.
 */
import * as THREE from "three";

const cache = new Map<string, THREE.Texture>();

function ctx2d(w: number, h: number): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c.getContext("2d");
}

function finish(key: string, g: CanvasRenderingContext2D | null): THREE.Texture {
  if (!g) {
    // SSR / headless: hand back an empty texture rather than throwing. Nothing
    // renders in that environment anyway.
    const t = new THREE.Texture();
    cache.set(key, t);
    return t;
  }
  const tex = new THREE.CanvasTexture(g.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}

/** Deterministic value noise so a rebuild produces the same sprite. */
function vnoise(x: number, y: number, seed: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Fireball core — turbulent, not a radial gradient.
 *
 * A plain radial gradient scaled up is the single most recognisable "engine
 * default" tell: it reads as a glowing ball, never as combustion. The lobes
 * plus the noise mask give the blob internal structure, so a fireball that is
 * rotating and growing shows moving detail instead of just getting bigger.
 */
export function fireTexture(size = 128): THREE.Texture {
  const key = `fire|${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const g = ctx2d(size, size);
  if (!g) return finish(key, null);

  g.clearRect(0, 0, size, size);
  const c = size * 0.5;

  // Hot core → yellow → orange, then a soft dark-orange halo.
  const core = g.createRadialGradient(c, c, 0, c, c, c);
  core.addColorStop(0, "rgba(255,250,232,0.95)");
  core.addColorStop(0.18, "rgba(255,226,150,0.85)");
  core.addColorStop(0.42, "rgba(252,150,52,0.55)");
  core.addColorStop(0.72, "rgba(196,66,16,0.22)");
  core.addColorStop(1, "rgba(90,22,6,0)");
  g.fillStyle = core;
  g.fillRect(0, 0, size, size);

  // Combustion lobes — brighter pockets where the fuel is still burning.
  const lobes = [
    [0.38, 0.42, 0.22],
    [0.62, 0.38, 0.18],
    [0.55, 0.62, 0.2],
    [0.42, 0.6, 0.15],
    [0.5, 0.34, 0.13],
  ] as const;
  g.globalCompositeOperation = "lighter";
  for (const [lx, ly, lr] of lobes) {
    const grd = g.createRadialGradient(
      lx * size,
      ly * size,
      0,
      lx * size,
      ly * size,
      lr * size,
    );
    grd.addColorStop(0, "rgba(255,236,180,0.34)");
    grd.addColorStop(0.5, "rgba(255,158,60,0.16)");
    grd.addColorStop(1, "rgba(255,120,30,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
  }
  g.globalCompositeOperation = "source-over";

  // Break the silhouette so the edge is ragged rather than a perfect circle.
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = (x - c) / c;
      const dy = (y - c) / c;
      const r = Math.sqrt(dx * dx + dy * dy);
      const n = vnoise(x * 0.14, y * 0.14, 3) * 0.55 + vnoise(x * 0.4, y * 0.4, 11) * 0.45;
      let a = d[i + 3]! / 255;
      a *= 0.6 + n * 0.7;
      if (r > 0.62) a *= Math.max(0, 1 - (r - 0.62) / 0.38);
      d[i + 3] = Math.max(0, Math.min(255, a * 255));
    }
  }
  g.putImageData(img, 0, 0);
  return finish(key, g);
}

/**
 * Spark / ember — a hot point with a very tight falloff.
 *
 * Kept small and NOT pure white at full alpha: an earlier pass had a white core
 * at alpha 1 under additive blending with `toneMapped:false`, which put every
 * spark past the bloom threshold and wrapped a damaged car in a white halo.
 */
export function emberTexture(size = 64): THREE.Texture {
  const key = `ember|${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const g = ctx2d(size, size);
  if (!g) return finish(key, null);
  const c = size * 0.5;
  const grd = g.createRadialGradient(c, c, 0, c, c, c);
  grd.addColorStop(0, "rgba(255,244,214,0.92)");
  grd.addColorStop(0.16, "rgba(255,206,128,0.62)");
  grd.addColorStop(0.44, "rgba(255,138,50,0.2)");
  grd.addColorStop(1, "rgba(180,60,12,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return finish(key, g);
}

/**
 * Electrical arc — a jagged horizontal bolt.
 *
 * Horizontal because the ARC layer stretches its quad along the particle's
 * chosen axis; a radially symmetric sprite stretched into a line just looks
 * like a smeared dot, which is what "electrical damage" looked like before.
 */
export function arcTexture(w = 128, h = 32): THREE.Texture {
  const key = `arc|${w}x${h}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const g = ctx2d(w, h);
  if (!g) return finish(key, null);
  g.clearRect(0, 0, w, h);

  const mid = h * 0.5;
  const pts: [number, number][] = [];
  const segs = 11;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // Amplitude tapers at both ends so the bolt terminates in a point rather
    // than being cut off mid-zag by the quad edge.
    const taper = Math.sin(t * Math.PI);
    const jag = (vnoise(i * 3.1, 0, 7) - 0.5) * h * 0.7 * taper;
    pts.push([t * w, mid + jag]);
  }

  // Wide soft glow, then the hot filament on top.
  const passes = [
    { width: h * 0.42, style: "rgba(120,180,255,0.16)" },
    { width: h * 0.2, style: "rgba(180,220,255,0.42)" },
    { width: h * 0.075, style: "rgba(248,252,255,0.95)" },
  ];
  g.lineCap = "round";
  g.lineJoin = "round";
  for (const p of passes) {
    g.strokeStyle = p.style;
    g.lineWidth = p.width;
    g.beginPath();
    g.moveTo(pts[0]![0], pts[0]![1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]![0], pts[i]![1]);
    g.stroke();
  }

  // A couple of forks — an arc that never branches reads as a drawn line.
  g.strokeStyle = "rgba(200,230,255,0.5)";
  g.lineWidth = h * 0.05;
  for (const i of [3, 7]) {
    const [px, py] = pts[i]!;
    g.beginPath();
    g.moveTo(px, py);
    g.lineTo(px + w * 0.06, py + (vnoise(i, 1, 13) - 0.5) * h * 0.9);
    g.stroke();
  }
  return finish(key, g);
}

/**
 * Fluid droplet — dark body, bright rim.
 *
 * Oil is nearly black in albedo but very glossy, so the only thing that makes a
 * droplet visible against dark tarmac is its specular rim. Baking the rim into
 * the sprite gets that read without needing a lit material for the layer.
 */
export function dropletTexture(size = 64): THREE.Texture {
  const key = `drop|${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const g = ctx2d(size, size);
  if (!g) return finish(key, null);
  const c = size * 0.5;
  const body = g.createRadialGradient(c, c, 0, c, c, c * 0.9);
  body.addColorStop(0, "rgba(255,255,255,0.9)");
  body.addColorStop(0.6, "rgba(255,255,255,0.75)");
  body.addColorStop(0.92, "rgba(255,255,255,0.25)");
  body.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = body;
  g.beginPath();
  g.ellipse(c, c, c * 0.62, c * 0.86, 0, 0, Math.PI * 2);
  g.fill();
  // Rim highlight (kept white; the layer tints it per particle).
  g.globalCompositeOperation = "lighter";
  const rim = g.createRadialGradient(c * 0.78, c * 0.62, 0, c * 0.78, c * 0.62, c * 0.3);
  rim.addColorStop(0, "rgba(255,255,255,0.55)");
  rim.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = rim;
  g.fillRect(0, 0, size, size);
  g.globalCompositeOperation = "source-over";
  return finish(key, g);
}

/**
 * Heat shimmer — smooth low-contrast noise with a soft vignette.
 *
 * This is an approximation and should be read as one: real shimmer is a
 * screen-space refraction and would have to live in the post chain, which this
 * agent does not own. What this gets you is the *motion* cue — a faint,
 * fast-scrolling, rotating haze sitting over hot geometry — at the cost of one
 * near-transparent quad. It is gated to the high tier for that reason.
 */
export function shimmerTexture(size = 64): THREE.Texture {
  const key = `shimmer|${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const g = ctx2d(size, size);
  if (!g) return finish(key, null);
  const img = g.createImageData(size, size);
  const d = img.data;
  const c = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const n =
        vnoise(x * 0.09, y * 0.09, 1) * 0.55 +
        vnoise(x * 0.21, y * 0.21, 5) * 0.3 +
        vnoise(x * 0.5, y * 0.5, 9) * 0.15;
      const dx = (x - c) / c;
      const dy = (y - c) / c;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      const fall = 1 - r * r;
      const v = 200 + n * 55;
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
      d[i + 3] = Math.max(0, Math.min(255, (n - 0.35) * 2.2 * 255 * fall));
    }
  }
  g.putImageData(img, 0, 0);
  return finish(key, g);
}

/**
 * Ground decal splat — one irregular alpha blob used for every decal kind.
 *
 * One texture, not four, because each extra decal texture is another draw call
 * for the persistent-decal instanced mesh. Scorch, gouge, oil and impact are
 * separated by tint, aspect ratio and opacity instead, which is enough at the
 * distances a decal is ever read from in a racer.
 */
export function splatTexture(size = 128): THREE.Texture {
  const key = `splat|${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const g = ctx2d(size, size);
  if (!g) return finish(key, null);
  g.clearRect(0, 0, size, size);
  const c = size * 0.5;

  const lobes = [
    [0.5, 0.5, 0.4, 0.62],
    [0.36, 0.44, 0.26, 0.42],
    [0.63, 0.4, 0.24, 0.4],
    [0.58, 0.62, 0.27, 0.38],
    [0.4, 0.63, 0.22, 0.34],
    [0.5, 0.32, 0.19, 0.3],
  ] as const;
  for (const [lx, ly, lr, la] of lobes) {
    const grd = g.createRadialGradient(
      lx * size,
      ly * size,
      0,
      lx * size,
      ly * size,
      lr * size,
    );
    grd.addColorStop(0, `rgba(255,255,255,${la})`);
    grd.addColorStop(0.55, `rgba(255,255,255,${la * 0.5})`);
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
  }

  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = (x - c) / c;
      const dy = (y - c) / c;
      const r = Math.sqrt(dx * dx + dy * dy);
      const n =
        vnoise(x * 0.12, y * 0.12, 17) * 0.6 + vnoise(x * 0.33, y * 0.33, 23) * 0.4;
      let a = d[i + 3]! / 255;
      // Speckle the edge — a decal with a clean elliptical border reads as a
      // sticker no matter how good the interior is.
      a *= 0.45 + n * 1.05;
      if (r > 0.55) a *= Math.max(0, 1 - (r - 0.55) / 0.45);
      d[i] = 255;
      d[i + 1] = 255;
      d[i + 2] = 255;
      d[i + 3] = Math.max(0, Math.min(255, a * 255));
    }
  }
  g.putImageData(img, 0, 0);
  return finish(key, g);
}

/** Soft annulus for the blast shockwave — hot inner edge, feathered outside. */
export function shockRingTexture(size = 128): THREE.Texture {
  const key = `shock|${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const g = ctx2d(size, size);
  if (!g) return finish(key, null);
  const c = size * 0.5;
  const grd = g.createRadialGradient(c, c, 0, c, c, c);
  grd.addColorStop(0, "rgba(255,255,255,0)");
  grd.addColorStop(0.72, "rgba(255,222,170,0.05)");
  grd.addColorStop(0.88, "rgba(255,238,208,0.55)");
  grd.addColorStop(0.955, "rgba(255,255,248,0.85)");
  grd.addColorStop(1, "rgba(255,240,214,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return finish(key, g);
}

export function disposeVfxSprites(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
