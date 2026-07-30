/**
 * Soft radial + noise-blob sprite textures for dust / smoke / haze / clouds.
 * Avoid hard circles — real VFX needs soft falloff + organic edges.
 */
import * as THREE from "three";

const cache = new Map<string, THREE.Texture>();

export function softCircleTexture(
  size = 64,
  inner = "rgba(255,255,255,0.95)",
  mid = "rgba(255,255,255,0.35)",
  outer = "rgba(255,255,255,0)",
): THREE.Texture {
  const key = `c|${size}|${inner}|${mid}|${outer}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const r = size * 0.5;
  const grd = g.createRadialGradient(r, r, 0, r, r, r);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.35, mid);
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}

/** Organic smoke/dust puff — multi-lobe soft blob with noise edge. */
export function softSmokeTexture(size = 128): THREE.Texture {
  const key = `smoke|${size}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, size, size);

  // Layered soft ellipses → cloudy silhouette
  const lobes = [
    { x: 0.5, y: 0.5, rx: 0.42, ry: 0.4, a: 0.55 },
    { x: 0.38, y: 0.48, rx: 0.28, ry: 0.26, a: 0.4 },
    { x: 0.62, y: 0.45, rx: 0.26, ry: 0.3, a: 0.38 },
    { x: 0.48, y: 0.38, rx: 0.3, ry: 0.24, a: 0.32 },
    { x: 0.52, y: 0.6, rx: 0.32, ry: 0.28, a: 0.3 },
  ];
  for (const L of lobes) {
    const grd = g.createRadialGradient(
      L.x * size,
      L.y * size,
      0,
      L.x * size,
      L.y * size,
      Math.max(L.rx, L.ry) * size,
    );
    grd.addColorStop(0, `rgba(255,255,255,${L.a})`);
    grd.addColorStop(0.45, `rgba(255,255,255,${L.a * 0.45})`);
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.beginPath();
    g.ellipse(L.x * size, L.y * size, L.rx * size, L.ry * size, 0, 0, Math.PI * 2);
    g.fill();
  }

  // Soft edge feather
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  const cx = size * 0.5;
  const cy = size * 0.5;
  const maxR = size * 0.48;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy) / maxR;
      // cheap hash noise
      const n = ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1 + 1) % 1;
      let a = d[i + 3]! / 255;
      a *= Math.max(0, 1 - r * r);
      a *= 0.85 + n * 0.2;
      if (r > 0.75) a *= Math.max(0, 1 - (r - 0.75) / 0.25);
      d[i + 3] = Math.min(255, a * 255);
    }
  }
  g.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}

/** Soft cloud bank for sky — wide horizontal gradient blob. */
export function softCloudTexture(size = 256): THREE.Texture {
  const key = `cloud|${size}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const c = document.createElement("canvas");
  c.width = size;
  c.height = Math.floor(size * 0.55);
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, c.width, c.height);

  const lobes = [
    { x: 0.5, y: 0.55, rx: 0.42, ry: 0.28, a: 0.5 },
    { x: 0.28, y: 0.5, rx: 0.28, ry: 0.22, a: 0.38 },
    { x: 0.72, y: 0.52, rx: 0.3, ry: 0.24, a: 0.36 },
    { x: 0.42, y: 0.42, rx: 0.22, ry: 0.18, a: 0.3 },
    { x: 0.6, y: 0.4, rx: 0.24, ry: 0.16, a: 0.28 },
    { x: 0.5, y: 0.68, rx: 0.36, ry: 0.2, a: 0.25 },
  ];
  for (const L of lobes) {
    const grd = g.createRadialGradient(
      L.x * c.width,
      L.y * c.height,
      0,
      L.x * c.width,
      L.y * c.height,
      Math.max(L.rx * c.width, L.ry * c.height),
    );
    grd.addColorStop(0, `rgba(255,255,255,${L.a})`);
    grd.addColorStop(0.5, `rgba(255,255,255,${L.a * 0.4})`);
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.beginPath();
    g.ellipse(
      L.x * c.width,
      L.y * c.height,
      L.rx * c.width,
      L.ry * c.height,
      0,
      0,
      Math.PI * 2,
    );
    g.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}
