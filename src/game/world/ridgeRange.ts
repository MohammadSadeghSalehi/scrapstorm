/**
 * Continuous mountain ranges for the skyline.
 *
 * The skyline used to be 25 separate displaced cones planted on a ring. No
 * amount of per-cone displacement fixes that, because the thing that reads as
 * "primitive" is not the surface detail — it is the SILHOUETTE. A cone has one
 * summit, a convex outline and a base that meets the ground all the way round,
 * so 25 of them spaced evenly always read as 25 pyramids. A real range is one
 * continuous landform: ridgelines that run for kilometres, summits connected by
 * saddles, spurs that overlap and occlude each other, and a horizon that is
 * never twice the same shape.
 *
 * So this builds an annulus heightfield instead — a ring of terrain around the
 * circuit, displaced by ridged multifractal noise. Overlapping spurs come free
 * because it is genuine 3D geometry rather than a billboard, and the whole
 * range is ONE draw call instead of 25.
 *
 * Cost went DOWN: 25 cones at ~140 triangles was ~3.5k triangles in 25 draws;
 * a 192x20 band is ~7.7k triangles in one.
 */
import * as THREE from "three";
import { perlin2 } from "./terrainHeight";

export type RangeOpts = {
  seed: number;
  /** Inner radius — start it inside the sand plane so the base is buried. */
  innerR: number;
  outerR: number;
  /** Angular / radial resolution. */
  segsA: number;
  segsR: number;
  /** Height of the tallest summit, in metres above `baseY`. */
  peak: number;
  /** World y the range grows from. */
  baseY: number;
  /** Metres per noise unit — larger means broader landforms. */
  featureSize: number;
  /** Shadowed rock, sun-bleached rock, and the horizon haze to fade into. */
  rockLow: string;
  rockHigh: string;
  haze: string;
  /** Radii between which aerial perspective ramps from none to full. */
  hazeFrom: number;
  hazeTo: number;
  /** Haze strength at hazeTo, 0..1. */
  hazeMax: number;
  /**
   * How creased the ridges are. 1 = the raw multifractal, sharp enough to look
   * like crumpled paper; below 1 pulls mass back into the flanks so summits
   * are still summits but the faces between them are broad. ~0.55 reads as
   * weathered desert rock, which is what this range is.
   */
  sharpness?: number;
  /** Metres of world per texture tile, vertically. 0 disables the detail map. */
  tileM?: number;
};

/**
 * Ridged multifractal — the standard way to get mountains rather than hills.
 *
 * `1 - |noise|` folds the noise about zero, turning what would be smooth peaks
 * and troughs into sharp creases; squaring sharpens them further. Weighting
 * each octave by the previous one is what makes it *multi*fractal: detail is
 * suppressed in the valleys and piled onto the ridges, which is roughly what
 * erosion does to a real range. Plain fBm gives rolling dunes — correct for the
 * desert floor, wrong for a mountain.
 */
function ridgeField(x: number, z: number, seed: number): number {
  // Domain warp first: without it the ridges run in visibly straight lines
  // along the noise lattice axes.
  const wx = x + perlin2(x * 0.5 + seed * 3.1, z * 0.5) * 1.3;
  const wz = z + perlin2(x * 0.5, z * 0.5 + seed * 2.7) * 1.3;

  let sum = 0;
  let norm = 0;
  let amp = 1;
  let freq = 1;
  let prev = 1;
  for (let i = 0; i < 6; i++) {
    let n = 1 - Math.abs(perlin2(wx * freq + seed * 17.3, wz * freq - seed * 9.1));
    // n*n creases the fold; mixing back toward the unsquared value softens it.
    // At full strength every octave adds another hard crest and the range ends
    // up looking like crumpled paper rather than rock.
    n = (n * n * 0.72 + n * 0.28) * prev;
    // 1.5 concentrated nearly all the detail onto the crest lines. 1.15 lets
    // the flanks keep some, which is what gives a face instead of a blade.
    prev = Math.min(1, n * 1.15);
    sum += n * amp;
    norm += amp;
    // Faster falloff (was 0.48): the top octaves are the ones that read as
    // needle-sharp at this distance, and they are mostly aliasing anyway once
    // a quad spans 20m.
    amp *= 0.42;
    freq *= 2.07;
  }
  return sum / Math.max(1e-6, norm);
}

/**
 * One pass of a 5-tap blur over the height grid, wrapping in angle.
 *
 * The noise tuning above controls how creased the FIELD is; this controls how
 * creased the MESH is, and they are not the same thing — a summit that is one
 * quad wide is a spike however gentle the underlying function. Smoothing the
 * sampled grid is the only thing that reliably takes the points off, and it
 * cannot introduce new detail the way re-tuning octaves can.
 */
function relaxHeights(h: Float32Array, cols: number, rows: number, k: number) {
  const src = h.slice();
  for (let r = 0; r < rows; r++) {
    for (let a = 0; a < cols; a++) {
      // cols - 1 is the duplicated seam column, so wrap over that period to
      // keep the join smooth instead of pinching it.
      const period = cols - 1;
      const am = ((a - 1) % period + period) % period;
      const ap = (a + 1) % period;
      const rm = Math.max(0, r - 1);
      const rp = Math.min(rows - 1, r + 1);
      const avg =
        (src[r * cols + am]! +
          src[r * cols + ap]! +
          src[rm * cols + a]! +
          src[rp * cols + a]!) *
        0.25;
      const i = r * cols + a;
      h[i] = src[i]! + (avg - src[i]!) * k;
    }
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / Math.max(1e-6, b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * A ring of mountains centred on the origin of the returned geometry.
 *
 * Vertex colours carry rock stratification AND aerial perspective, because the
 * scene has no fog: without a distance fade the far range would be the same
 * saturated brown as the near one and the two would fuse into a single flat
 * band. Haze is what separates them into layers.
 */
export function buildRidgeRange(o: RangeOpts): THREE.BufferGeometry {
  const { segsA, segsR } = o;
  const cols = segsA + 1;
  const rows = segsR + 1;
  const count = cols * rows;

  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const hN = new Float32Array(count);

  const low = new THREE.Color(o.rockLow);
  const high = new THREE.Color(o.rockHigh);
  const haze = new THREE.Color(o.haze);
  const tmp = new THREE.Color();
  const sharp = o.sharpness ?? 0.55;

  // Pass 1: sample the field into a grid so it can be relaxed before it
  // becomes geometry.
  for (let r = 0; r < rows; r++) {
    const tr = r / segsR;
    const R = o.innerR + (o.outerR - o.innerR) * tr;
    for (let a = 0; a < cols; a++) {
      const ang = (a / segsA) * Math.PI * 2;
      const f = ridgeField(
        (Math.cos(ang) * R) / o.featureSize,
        (Math.sin(ang) * R) / o.featureSize,
        o.seed,
      );
      // Exponent > 1 pushes mass into the valleys and leaves isolated summits;
      // 1.7 was steep enough that the flanks fell away almost vertically.
      hN[r * cols + a] = Math.pow(f, 1 + sharp);
    }
  }
  // 0.55 rounded the summits so far they read as sand dunes rather than rock.
  relaxHeights(hN, cols, rows, 0.32);

  // Pass 2: place vertices from the relaxed field.
  for (let r = 0; r < rows; r++) {
    const tr = r / segsR;
    const R = o.innerR + (o.outerR - o.innerR) * tr;

    /*
     * Rise out of the desert rather than starting at full height.
     *
     * The first rows sit BELOW baseY so the range emerges from under the sand
     * plane — an annulus that began exactly at ground level would show a hard
     * rim where its inner edge met the desert, and any gap between the two
     * would show sky through the floor. Amplitude then keeps growing outward,
     * so the outermost ridge is always the tallest and there is no "edge of the
     * world" visible over the top of the range.
     */
    const emerge = smoothstep(0, 0.18, tr);
    const amp = emerge * (0.55 + 0.75 * tr);
    const sink = (1 - emerge) * 40;

    for (let a = 0; a < cols; a++) {
      // cols-1 == segsA, so a = 0 and a = segsA land on the same angle and the
      // seam closes exactly.
      const ang = (a / segsA) * Math.PI * 2;
      const x = Math.cos(ang) * R;
      const z = Math.sin(ang) * R;

      const i = r * cols + a;
      const n = hN[i]!;
      const h = n * o.peak * amp;

      pos[i * 3] = x;
      pos[i * 3 + 1] = o.baseY + h - sink;
      pos[i * 3 + 2] = z;

      /*
       * Cylindrical UVs, not planar.
       *
       * A top-down projection would smear the detail map down every slope, and
       * slopes are the only part of a ring you see from inside it. Wrapping
       * around the ring and climbing with height instead runs the texture up
       * the faces, which is also the direction real strata run. `tilesAround`
       * is forced to a whole number so the seam column lands exactly on a tile
       * boundary.
       */
      if (o.tileM) {
        const circ = 2 * Math.PI * ((o.innerR + o.outerR) * 0.5);
        const tilesAround = Math.max(1, Math.round(circ / o.tileM));
        uv[i * 2] = (a / segsA) * tilesAround;
        uv[i * 2 + 1] = pos[i * 3 + 1]! / o.tileM;
      }

      // Sun-bleached toward the summits, shadowed rock in the gullies.
      tmp.copy(low).lerp(high, smoothstep(0.08, 0.85, n));

      /*
       * STRATA — the single strongest "this is desert rock" cue.
       *
       * Sedimentary bands are a function of ABSOLUTE height, not of height
       * normalised per-peak, which is why they run dead level across a whole
       * range and continue across the gap between two summits as if the rock
       * were once one deposit. Normalising per peak (the obvious thing, since
       * `n` is already to hand) would tilt every band to follow its own summit
       * and instantly read as decoration painted on.
       *
       * The boundaries are warped by low-frequency noise so they are not
       * drawn with a ruler, and the band value is quantised HARD rather than
       * smoothed: real bedding planes are abrupt: it is the sharp edge between
       * layers that the eye reads as rock rather than as dirt.
       */
      const bandWarp = perlin2(x / 140, z / 140) * 3.2;
      const bandY = (o.baseY + h + bandWarp) / 7.5;
      const band = Math.floor(bandY);
      // Deterministic per-band tone so a band keeps its colour all the way
      // round the ring instead of shimmering between neighbours.
      const bandTone = ((Math.sin(band * 12.9898) * 43758.5453) % 1 + 1) % 1;
      const bandMix = 0.16 + bandTone * 0.2;
      tmp.lerp(bandTone > 0.5 ? high : low, bandMix * 0.5);

      /*
       * Large-scale mineral variation. Without it the whole range is one
       * colour and the tiled detail map has nothing to hide behind — the
       * repetition of a 46m tile becomes obvious precisely because everything
       * around it is uniform. This is much lower frequency than the tile, so
       * it breaks the grid without competing with the surface detail.
       */
      const mineral = perlin2(x / 520 + 11.3, z / 520 - 4.7);
      tmp.offsetHSL(mineral * 0.016, mineral * 0.05, mineral * 0.03);

      /*
       * Scree. Debris collects at the foot of a slope and it is paler and
       * flatter than the face above it, so the base of every ridge lightens.
       * Keyed on low normalised height, which is where the talus actually is.
       */
      const scree = 1 - smoothstep(0.02, 0.3, n);
      if (scree > 0) tmp.lerp(high, scree * 0.22);

      // Aerial perspective by distance, minus a little on the peaks — summits
      // stand above the densest air, which is what makes a range read as deep
      // rather than as a flat cut-out. LAST, so everything above it fades
      // together rather than each cue fighting the haze separately.
      const f2 = smoothstep(o.hazeFrom, o.hazeTo, R) * o.hazeMax;
      tmp.lerp(haze, Math.min(1, f2 * (1 - n * 0.3)));

      col[i * 3] = tmp.r;
      col[i * 3 + 1] = tmp.g;
      col[i * 3 + 2] = tmp.b;
    }
  }

  const idx: number[] = [];
  for (let r = 0; r < segsR; r++) {
    for (let a = 0; a < segsA; a++) {
      const i0 = r * cols + a;
      const i1 = i0 + 1;
      const i2 = i0 + cols;
      const i3 = i2 + 1;
      /*
       * (i0, i1, i2) is tangential-then-radial, which cross-products to +Y.
       * The reverse order gives -Y: computeVertexNormals then points the whole
       * range DOWNWARD, backface culling removes every slope you look down at,
       * and the only geometry left is whatever sits above eye level — lit from
       * underneath. It renders as a lump of rock floating in the sky, which is
       * exactly what it did.
       */
      idx.push(i0, i1, i2, i1, i3, i2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  if (o.tileM) geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  /*
   * Slope darkening, applied AFTER normals exist so it costs nothing extra.
   *
   * Height alone gives a range that reads as smooth clay: every face at a given
   * altitude is the same colour, so the eye gets no cue about form. In reality
   * the steep faces are bare rock — too sheer to hold sand or catch much sky
   * light — while the shallower shoulders are dust-covered and paler. Keying
   * off normal.y separates crag from shoulder and is what makes the silhouette
   * read as stone.
   *
   * Damped by the haze already in the colour, so the far range stays soft
   * rather than getting its contrast handed back at the horizon.
   */
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < count; i++) {
    const steep = 1 - Math.min(1, Math.max(0, nrm.getY(i)));
    const shade = 1 - smoothstep(0.12, 0.62, steep) * 0.3;
    col[i * 3] *= shade;
    col[i * 3 + 1] *= shade * 0.99;
    col[i * 3 + 2] *= shade * 0.96;
  }
  (geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;

  geo.computeBoundingSphere();
  return geo;
}
